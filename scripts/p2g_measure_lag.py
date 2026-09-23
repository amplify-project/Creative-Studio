#!/usr/bin/env python3
"""Measure per-take timing lag against the reference for a play2gether session.

Objective confirmation of the "participants always run ahead" symptom, without
eyeballing waveforms. For each take it computes the cross-correlation lag vs the
reference track and prints it in ms.

    lag < 0  → take is AHEAD of the reference (participant leads)  ← the symptom
    lag > 0  → take is BEHIND the reference

Usage:
    python3 scripts/p2g_measure_lag.py <sessionId>
    python3 scripts/p2g_measure_lag.py /tmp/play2gether/<sessionId>

Needs: ffmpeg on PATH, numpy + scipy.

Notes on interpretation:
  * If the participant SANG, lag mixes human timing + system offset.
  * For a pure-system measurement, run a round where the reference is a click
    track and the "participant" does NOT sing — let the reference bleed into the
    mic (acoustic loopback) or tap exactly on the beat. Then lag isolates the
    playback/capture path. A consistently negative lag there = system fault
    (the async capture-start delay, see usePlay2GetherSession.ts:434).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve

STORAGE_BASE = Path("/tmp/play2gether")
SR = 16000  # analysis sample rate; mono


def decode(path: Path) -> np.ndarray:
    """Decode any audio file to mono float32 @ SR via ffmpeg."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed on {path}: {proc.stderr.decode()[-500:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def envelope(x: np.ndarray) -> np.ndarray:
    """Rectified, smoothed amplitude envelope — robust to timbre/pitch diffs
    so we correlate on *rhythm/onsets*, not exact waveform."""
    e = np.abs(x)
    win = int(SR * 0.02)  # 20 ms
    if win > 1:
        e = fftconvolve(e, np.ones(win) / win, mode="same")
    e = e - e.mean()
    n = np.linalg.norm(e)
    return e / n if n > 0 else e


def best_lag_ms(ref: np.ndarray, take: np.ndarray) -> tuple[float, float]:
    """Return (lag_ms, peak_corr). Positive lag = take is delayed vs ref."""
    r, t = envelope(ref), envelope(take)
    corr = fftconvolve(t, r[::-1], mode="full")
    center = len(r) - 1
    k = int(np.argmax(corr))
    lag_samples = k - center  # >0: take shifted right (later) vs ref
    return lag_samples / SR * 1000.0, float(corr[k])


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    arg = sys.argv[1]
    sdir = Path(arg) if "/" in arg else STORAGE_BASE / arg
    meta = json.loads((sdir / "session.json").read_text())

    ref_file = meta.get("referenceFile")
    if not ref_file:
        print("No referenceFile in session — cannot measure lag.")
        sys.exit(1)
    ref = decode(sdir / ref_file)
    print(f"session {meta['sessionId']}  ref={ref_file} ({len(ref)/SR:.1f}s)\n")

    print(f"{'take':<28}{'storedOffset':>13}{'measuredLag':>13}{'peak':>8}")
    print("-" * 62)
    lags = []
    for key, p in meta["participants"].items():
        take = decode(sdir / p["file"])
        lag_ms, peak = best_lag_ms(ref, take)
        lags.append(lag_ms)
        cal = " (cal)" if p.get("calibrated") else ""
        arrow = "AHEAD" if lag_ms < 0 else "behind"
        print(f"{key:<28}{p.get('clapOffset', 0):>10}ms{cal:<3}"
              f"{lag_ms:>10.0f}ms {peak:>7.2f}   {arrow}")

    if lags:
        arr = np.array(lags)
        print("-" * 62)
        print(f"mean={arr.mean():+.0f}ms  median={np.median(arr):+.0f}ms  "
              f"n={len(arr)}  ({(arr < 0).sum()} ahead / {(arr >= 0).sum()} behind)")
        print("\nConsistently negative mean/median = participants systematically "
              "lead the reference → system offset, not human anticipation.")


if __name__ == "__main__":
    main()
