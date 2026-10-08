"""scripts/p2g_beat_grid.py — the parts that decide the number.

The estimator is tested on synthetic attacks (no model needed). The model
itself is exercised end to end only when the ONNX file has been fetched,
because it is not in the repository (scripts/fetch-models.sh)."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("p2g_beat_grid", ROOT / "scripts" / "p2g_beat_grid.py")
bg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bg)


def test_mel_filterbank_shape_and_coverage():
    fb = bg.mel_filterbank()
    assert fb.shape == (513, 128)
    assert (fb >= 0).all()
    # every mel band picks up some energy, and nothing below f_min contributes
    assert (fb.sum(0) > 0).all()
    assert fb[: int(30 / (bg.SR / 2) * 512)].sum() == 0


def test_estimate_recovers_a_shift_on_the_beat():
    beats = np.arange(0.5, 60, 0.5)                  # 120 BPM
    lag = 0.131
    on = beats[::1] + lag
    w = np.ones_like(on)
    lags, score = bg.score_lags(beats, on, w, -0.2, 0.2)   # centred window: unique
    (best, _), *_ = bg.candidates(lags, score)
    assert abs(best - lag) < 0.002


def test_offbeat_playing_is_reported_as_ambiguous():
    # Attacks on every eighth note: the pulse and the off-beat fit equally.
    beats = np.arange(0.5, 60, 0.5)
    on = np.sort(np.concatenate([beats, beats + 0.25])) + 0.1
    lags, score = bg.score_lags(beats, on, np.ones_like(on), -0.4, 0.4)
    cands = bg.candidates(lags, score)
    assert cands[1][1] >= bg.CLEAR_BELOW


@pytest.mark.skipif(not Path(bg.MODEL).exists(), reason="model not fetched (scripts/fetch-models.sh)")
@pytest.mark.skipif(subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0, reason="no ffmpeg")
def test_click_track_end_to_end(tmp_path):
    import wave
    sr = 48000
    n = sr * 30
    clicks = np.zeros(n, np.float32)
    t = np.arange(int(0.03 * sr)) / sr
    tick = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t * 150)).astype(np.float32)
    for b in np.arange(0.5, 29.5, 0.5):              # 120 BPM
        i = int(b * sr); clicks[i:i + len(tick)] += tick

    def write(p, x):
        with wave.open(str(p), "wb") as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(sr)
            f.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())

    ref, take = tmp_path / "ref.wav", tmp_path / "take.wav"
    write(ref, clicks)
    shift = int(0.12 * sr)
    write(take, np.concatenate([np.zeros(shift, np.float32), clicks[:-shift]]))
    out = subprocess.run([sys.executable, str(ROOT / "scripts" / "p2g_beat_grid.py"), "align", str(ref), str(take),
                          "--cache", str(tmp_path / "ref.beats.json"), "--expect", "100"],
                         capture_output=True, text=True, check=True).stdout
    r = json.loads(out)
    assert r["ok"], r
    assert abs(r["bpm"] - 120) < 3
    assert abs(r["offsetMs"] - 120) < 10
