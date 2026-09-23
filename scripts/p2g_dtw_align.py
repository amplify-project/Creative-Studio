#!/usr/bin/env python3
"""
Measure how late a Play2Gether take sits against the reference it was recorded
over, by aligning the two with dynamic time warping.

Read `docs/llm/12-dtw-alignment.md` before changing the band, the feature or the
statistic. All three have already been wrong once in testing, and two of them
were wrong in ways that looked right.

WHAT THIS MEASURES, AND WHY IT IS NOT A FOURTH COPY OF THE OTHER TWO

A calibration round measures the device before anyone plays. A sync round
measures the player against a click. This measures THE TAKE ITSELF, against the
audio it was actually performed over — the only one of the three that observes
the thing being corrected rather than a proxy for it.

Its output is two numbers and a curve:

  lagMs   how much later a musical event appears in the take than in the
          reference. Positive = the take is late, which is the normal case.
  madMs   the median absolute deviation of the warping path around that lag.
          The honest statement of whether one number describes the take at all.
  drift   the lag window by window. Nothing else in the system can see this: a
          player who starts 130 ms late and ends 90 ms late has no single
          correct offset and the host needs to know before touching a slider.

USAGE
    p2g_dtw_align.py REFERENCE TAKE [--expect MS] [--feature melflux|chroma]
                     [--band SEC] [--window SEC] [--capture-delay MS]

Writes one JSON object to stdout. numpy and ffmpeg only — deliberately no
librosa: its `onset_strength` is reproduced here to the millisecond by
`_mel_flux` (measured, 2026-09-03, on the first field pair), and the one feature
it does provide that this cannot, `chroma_cqt`, was the only one that failed on
that material.
"""

import argparse, json, subprocess, sys
import numpy as np

SR = 22050          # plenty for onsets and chroma; a quarter of the samples of 48k
NFFT = 1024         # 46 ms window — onsets want short windows, they are transients
HOP = 128           # 5.8 ms per frame — this is the resolution floor of the answer

# Chroma needs a LONGER window than onsets do, and using one window for both was
# a real defect rather than a simplification. At NFFT=1024 the bins are 21.5 Hz
# apart while a semitone at the bottom of the useful range is about 4 Hz, so
# every low note landed in the same bin and the pitch classes were mush. The
# fixtures caught it: STFT chroma scored 1 of 13 with a shared window, including
# cases it exists to handle. 4096 gives 5.4 Hz bins.
NFFT_CHROMA = 4096
# Below this a semitone is narrower than a bin even at 4096, and above it the
# harmonics of everything pile up. Roughly A2..C7.
CHROMA_LO_HZ, CHROMA_HI_HZ = 110.0, 2100.0

# ── Decoding ─────────────────────────────────────────────────────────────────

def decode(path: str) -> np.ndarray:
    """Mono float32 at SR, via ffmpeg — which already decodes every container
    this project produces (Opus takes, WAV references, WebM uploads)."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg could not decode {path}: "
                           f"{proc.stderr.decode('utf-8', 'replace')[:200]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def _stft_mag(y: np.ndarray, nfft: int = NFFT, chunk_frames: int = 4096):
    """Magnitude STFT, yielded in chunks.

    Chunked because the whole point is to survive a five-minute take: a single
    `frames * window` array for 300 s at this hop is 211 MB before the FFT even
    runs, and the measured peak RSS of the unchunked version was 1.1 GB. The DTW
    below is the cheap half.
    """
    win = np.hanning(nfft).astype(np.float32)
    n = 1 + max(0, (len(y) - nfft)) // HOP
    for start in range(0, n, chunk_frames):
        stop = min(n, start + chunk_frames)
        idx = np.arange(start, stop) * HOP
        frames = np.stack([y[i:i + nfft] for i in idx]) if stop > start else np.zeros((0, nfft), np.float32)
        yield np.abs(np.fft.rfft(frames * win, axis=1)).astype(np.float32)


def _mel_filterbank(n_mels: int = 128) -> np.ndarray:
    """Triangular mel filters. This is the entire difference between a good
    answer and a mediocre one: on the first field pair, linear-frequency flux
    gave +116 ms with a 23 ms MAD and this gave +128 with 12 — because linear
    bins pile resolution into the top octaves, where two different instruments
    have least in common."""
    f = np.fft.rfftfreq(NFFT, 1 / SR)
    to_mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)
    to_hz = lambda ml: 700.0 * (10.0 ** (ml / 2595.0) - 1.0)
    pts = to_hz(np.linspace(to_mel(0), to_mel(SR / 2), n_mels + 2))
    fb = np.zeros((n_mels, len(f)), np.float32)
    for i in range(n_mels):
        lo, ctr, hi = pts[i], pts[i + 1], pts[i + 2]
        fb[i] = np.clip(np.minimum((f - lo) / (ctr - lo + 1e-9),
                                   (hi - f) / (hi - ctr + 1e-9)), 0, None)
    return fb


def mel_flux(y: np.ndarray) -> np.ndarray:
    """Half-wave-rectified spectral flux over a mel filterbank — onsets.

    Reproduces `librosa.onset.onset_strength` on the material tested. Best when
    the take and the reference share RHYTHM: percussion, plucked strings,
    anything with an attack.
    """
    fb = _mel_filterbank().T
    out, tail = [], None
    for mag in _stft_mag(y):
        S = 10.0 * np.log10(np.maximum((mag ** 2) @ fb, 1e-10))
        if tail is not None:
            S = np.vstack([tail, S])
        d = np.maximum(np.diff(S, axis=0), 0).mean(axis=1)
        out.append(d.astype(np.float32))
        tail = S[-1:]
    if not out:
        return np.zeros(1, np.float32)
    v = np.concatenate([np.zeros(1, np.float32)] + out)
    return v


def chroma(y: np.ndarray) -> np.ndarray:
    """Pitch-class energy, L2-normalised per frame.

    Invariant to timbre by construction, which is the standard answer to
    "different instruments" — and it comes straight off the STFT, so it needs no
    constant-Q transform. Best when take and reference share HARMONY: voice,
    keys, bass, anything pitched. Useless for unpitched percussion, where
    melflux is the one to use.
    """
    f = np.fft.rfftfreq(NFFT_CHROMA, 1 / SR)
    f[0] = 1e-9
    pc = np.round(12.0 * np.log2(f / 440.0)).astype(int) % 12
    keep = (f > CHROMA_LO_HZ) & (f < CHROMA_HI_HZ)
    masks = [keep & (pc == k) for k in range(12)]
    out = []
    for mag in _stft_mag(y, nfft=NFFT_CHROMA):
        # Log magnitude, not power: power lets the single loudest partial decide
        # the pitch class of the whole frame, which is a timbre measurement
        # wearing a chroma costume.
        S = np.log1p(1000.0 * mag)
        C = np.stack([S[:, m].sum(axis=1) for m in masks], axis=1)
        C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
        out.append(C.astype(np.float32))
    return np.concatenate(out) if out else np.zeros((1, 12), np.float32)


# ── The alignment itself ─────────────────────────────────────────────────────

def banded_dtw(X: np.ndarray, Y: np.ndarray, half_width: int, centre: int):
    """DTW restricted to `centre - half_width <= j - i <= centre + half_width`.

    Only the band is allocated, so the cost is O(n * width) rather than
    O(n * m). That is not an optimisation, it is what makes a five-minute take
    possible at all: librosa's implementation allocates the full matrix even
    when a band is requested — 1.34 GB at a 23 ms hop, 21 GB at this one
    (measured, 2026-09-03).

    The band being NARROW is also the only defence against the failure this
    method shares with every other alignment on music: a periodic passage lets
    the path slide by a whole beat or bar at no cost, and it comes back
    confident. If a lag and that lag ± one beat both fit inside the band, the
    answer is not unique. Same argument as SYNC_BPM in doc 11, arrived at from
    the other side — and demonstrated accidentally on 2026-09-03 by running this
    over a file tiled from a 6 s loop: MAD 813 ms, drift wandering +-1.4 s.
    Hence `--expect`: centre the band on the calibration figure and it can be
    kept tight enough that no alias fits.
    """
    n, m = len(X), len(Y)
    w = half_width
    width = 2 * w + 1
    offs = np.arange(-w, w + 1) + centre
    INF = np.float32(1e18)

    # BOTH ENDS ARE FREE, and that is a correctness fix rather than a
    # refinement. Classic DTW must end at (n-1, m-1), so it can only run when
    # the two files differ in length by less than the band — and a take is
    # routinely LONGER than the reference, because `recordingDuration` rounds
    # the song up and the capture runs a tail past it. A 31 s take against a
    # 30 s reference exceeded a 0.25 s band and the whole analysis refused,
    # blaming the band. Free ends also delete the artefact the trimming in
    # `summarise` exists to work around: the forced (0,0) corner used to pin the
    # first path offsets at exactly 0.0 and drag an untrimmed mean by 11 ms.
    #
    # Only the reference rows that have SOME valid take frame are walked, so a
    # take that stopped early aligns the part of the reference it covers instead
    # of failing.
    n = min(n, max(1, m - (centre - w)))

    multi = X.ndim > 1
    # Choices, one per cell, packed into a byte: bit0 = came from the left
    # (i, j-1); bit1 = came from above (i-1, j) rather than the diagonal.
    ptr = np.zeros((n, width), np.uint8)

    def row_cost(i):
        j = i + offs
        ok = (j >= 0) & (j < m)
        jc = np.clip(j, 0, m - 1)
        if multi:
            # cosine distance: both sides are L2-normalised, so this is 1 - dot
            c = 1.0 - (X[i] * Y[jc]).sum(axis=1)
        else:
            c = np.abs(X[i] - Y[jc])
        return np.where(ok, c, INF).astype(np.float32)

    # Free start: row 0 costs only what it costs, at every offset in the band.
    prev = row_cost(0)

    for i in range(1, n):
        cost = row_cost(i)
        up = np.concatenate([prev[1:], [INF]])          # (i-1, j)  -> slot k+1
        from_up = up < prev
        base = np.where(from_up, up, prev) + cost       # best of diag / up

        # Left moves, (i, j-1), are a within-row chain. Solved exactly and
        # vectorised rather than with a Python loop over the band:
        #   cur[k] = C[k] + min_{l<=k} (base[l] - C[l]),  C = cumsum(cost)
        # which is a prefix minimum. The Python version of this loop was the
        # whole runtime; this is the difference between 6 s and minutes.
        finite = np.isfinite(base) & (base < INF / 2)
        C = np.cumsum(np.where(np.isfinite(cost) & (cost < INF / 2), cost, 0.0))
        cand = np.where(finite, base - C, np.inf)
        cur = C + np.minimum.accumulate(cand)
        cur = np.where(np.isfinite(cur), cur, INF).astype(np.float32)

        from_left = cur < base - 1e-6
        ptr[i] = from_left.astype(np.uint8) | (from_up.astype(np.uint8) << 1)
        prev = cur

    # Free end: finish wherever the accumulated cost is lowest.
    if not np.isfinite(prev).any() or prev.min() >= INF / 2:
        raise RuntimeError("no alignment exists inside the search band — "
                           "is this take from the same session as the reference?")
    k = int(np.argmin(prev))

    lag_frames = np.full(n, np.nan, np.float32)
    i = n - 1
    while i > 0:
        lag_frames[i] = offs[k]
        p = ptr[i, k]
        if p & 1:                       # left: same row, one slot down
            k = max(k - 1, 0)
        elif p & 2:                     # up
            i -= 1; k = min(k + 1, width - 1)
        else:                           # diagonal
            i -= 1
    lag_frames[0] = offs[k]
    return lag_frames


def summarise(lag_frames, frame_ms, capture_delay_ms, window_sec, trim=0.10):
    """Reduce the path to a number, and say how much to believe it.

    TRIMMED, and that is not cosmetic. DTW is forced to match the first frame to
    the first and the last to the last, so both ends of the path carry an offset
    that was imposed rather than measured — on the first field pair the leading
    path offsets were literally 0.0, which dragged an untrimmed MEAN from -135
    to -124. The median of the trimmed core is what agreed with the take aligned
    by hand.
    """
    lag_ms = lag_frames * frame_ms
    k = int(len(lag_ms) * trim)
    core = lag_ms[k:-k] if k and len(lag_ms) - 2 * k > 8 else lag_ms
    med = float(np.median(core))
    mad = float(np.median(np.abs(core - med)))

    per_window = int(round(window_sec * 1000.0 / frame_ms))
    drift = []
    for start in range(0, len(lag_ms), max(1, per_window)):
        seg = lag_ms[start:start + per_window]
        if len(seg) < max(4, per_window // 4):
            continue
        drift.append({"tSec": round(start * frame_ms / 1000.0, 2),
                      "lagMs": round(float(np.median(seg)), 1)})

    return {
        # What the mixer slider wants. The mix places a take at
        # `netDelay = captureDelayMs - manual` after the reference's t=0, and an
        # event at reference time T sits at t = T + lag in the take, so
        # `manual = lag + captureDelayMs` places it. Derived once, here, so the
        # UI never has to.
        "offsetMs": round(med + capture_delay_ms, 1),
        "lagMs": round(med, 1),
        "madMs": round(mad, 1),
        "drift": drift,
        "driftRangeMs": (round(max(d["lagMs"] for d in drift) - min(d["lagMs"] for d in drift), 1)
                         if len(drift) > 1 else 0.0),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reference")
    ap.add_argument("take")
    ap.add_argument("--feature", choices=["melflux", "chroma"], default="melflux")
    ap.add_argument("--expect", type=float, default=0.0,
                    help="ms the take is expected to be late (the calibration figure). "
                         "Centres the band; it is not used as a value.")
    ap.add_argument("--band", type=float, default=0.5,
                    help="half-width of the search, in seconds, around --expect")
    ap.add_argument("--window", type=float, default=10.0, help="drift window, seconds")
    ap.add_argument("--capture-delay", type=float, default=0.0)
    args = ap.parse_args()

    frame_ms = HOP / SR * 1000.0
    try:
        ref, take = decode(args.reference), decode(args.take)
        feat = mel_flux if args.feature == "melflux" else chroma
        X, Y = feat(ref), feat(take)
        if X.ndim == 1:
            X = (X - X.mean()) / (X.std() + 1e-9)
            Y = (Y - Y.mean()) / (Y.std() + 1e-9)
        if len(X) < 16 or len(Y) < 16:
            raise RuntimeError("one of the files is too short to align")

        # Nothing was played. Without this the aligner returns whatever the band
        # happened to favour, which on a silent fixture was a confident +203 ms
        # — the same failure doc 10 records for a silent calibration ("a silent
        # take used to return a confident 182 ms"). Measured on the FEATURE, not
        # on peak amplitude: a take of nothing but hum has plenty of amplitude
        # and no structure to align.
        for name, sig in (("reference", ref), ("take", take)):
            rms = float(np.sqrt(np.mean(sig.astype(np.float64) ** 2))) if len(sig) else 0.0
            if rms < 1e-4:
                raise RuntimeError(f"the {name} is silent — nothing to align")

        centre = int(round(args.expect / frame_ms))
        half = int(round(args.band * 1000.0 / frame_ms))
        lag_frames = banded_dtw(X.astype(np.float32), Y.astype(np.float32), half, centre)
        out = summarise(lag_frames, frame_ms, args.capture_delay, args.window)
        out.update(ok=True, feature=args.feature, frameMs=round(frame_ms, 2),
                   refSec=round(len(ref) / SR, 2), takeSec=round(len(take) / SR, 2),
                   bandMs=round(args.band * 1000.0, 0), expectMs=args.expect)
        # A lag pinned against the edge of the band is a boundary, not a
        # measurement — the same rule as `atSearchEdge` in the sync detector.
        edge = abs(out["lagMs"] - args.expect) > args.band * 1000.0 * 0.9
        out["atBandEdge"] = bool(edge)
        json.dump(out, sys.stdout)
    except Exception as e:
        json.dump({"ok": False, "reason": str(e)[:300]}, sys.stdout)
        sys.stdout.flush()
        sys.exit(0)


if __name__ == "__main__":
    main()
