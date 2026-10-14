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
                     [--no-echo] [--no-debleed]

By default it removes reference bleed first (p2g_bleed.py), runs the DTW twice
with the band centred ±50 ms around --expect, reports the midpoint, and returns
a `verdict`: measured | follows-centre | band-edge. See ECHO_SHIFT_MS. When it
finds bleed, the bleed's lag (the round trip, measured on this take) becomes the
centre instead of --expect; `centreFrom` says which was used.

Writes one JSON object to stdout. numpy and ffmpeg only — deliberately no
librosa: its `onset_strength` is reproduced here to the millisecond by
`_mel_flux` (measured, 2026-09-03, on the first field pair), and the one feature
it does provide that this cannot, `chroma_cqt`, was the only one that failed on
that material.
"""

import argparse, json, subprocess, sys
from pathlib import Path
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


# Where bleed was removed, what is left of it sits ~15–20 dB under what was
# removed. Both features are scale-free — melflux works on a log spectrum and
# chroma normalises every frame — so in the player's rests that residue reads
# as music exactly as loud as the player's own: on a synthetic take whose
# cleaned audio matched the player to 37 dB, melflux still answered 17 ms for a
# player at 130 (2026-10-13). So the removed bleed is used as a MASK: anything
# in the cleaned take below (removed bleed − BLEED_MASK_DB), bin by bin and
# frame by frame, is treated as residue — floored for melflux, zeroed for
# chroma. Where the player is louder than that, nothing changes.
BLEED_MASK_DB = 15.0
# A floor relative to the file's maximum (librosa's top_db) — ONLY once bleed
# has been removed. Everywhere it cost the synthetic fixtures 7/3/2 → 5/6/1
# centred and 4/4/4 → 0/1/11 blind (the jump out of true silence is part of what
# the onset feature measures); after debleeding it is what keeps the residue
# down: choir with bleed, 104 → 127 of 148 within 25 ms (2026-10-13).
TOP_DB_AFTER_BLEED = 80.0


def mel_flux(y: np.ndarray, mask: np.ndarray | None = None, top_db: float | None = None) -> np.ndarray:
    """Half-wave-rectified spectral flux over a mel filterbank — onsets.

    Reproduces `librosa.onset.onset_strength` on the material tested. Best when
    the take and the reference share RHYTHM: percussion, plucked strings,
    anything with an attack. `mask`: the bleed that was removed from `y`, if any
    (see BLEED_MASK_DB).
    """
    fb = _mel_filterbank().T
    chunks, keeps = [], []
    masks = _stft_mag(mask) if mask is not None else None
    for mag in _stft_mag(y):
        S = 10.0 * np.log10(np.maximum((mag ** 2) @ fb, 1e-10))
        K = np.ones_like(S, dtype=bool)
        if masks is not None:
            M = next(masks, None)
            if M is not None and len(M) == len(S):
                # NOT a floor shaped like the bleed: that floor has the bleed's
                # onsets in it, and the first version of this put them straight
                # back into the feature (5 dB mask: 49 ms for a player at 130).
                # Masked bins simply contribute no flux.
                K = S >= 10.0 * np.log10(np.maximum((M ** 2) @ fb, 1e-10)) - BLEED_MASK_DB
        chunks.append(S)
        keeps.append(K)
    if not chunks:
        return np.zeros(1, np.float32)
    top = max(float(c.max()) for c in chunks) if top_db is not None else None
    out, tail = [], None
    for S, K in zip(chunks, keeps):
        if top is not None:
            S = np.maximum(S, top - top_db)
        if tail is not None:
            S = np.vstack([tail, S])
        d = np.maximum(np.diff(S, axis=0), 0)
        d = np.where(K[-len(d):], d, 0.0).mean(axis=1)
        out.append(d.astype(np.float32))
        tail = S[-1:]
    v = np.concatenate([np.zeros(1, np.float32)] + out)
    return v


def chroma(y: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    """Pitch-class energy, L2-normalised per frame.

    Invariant to timbre by construction, which is the standard answer to
    "different instruments" — and it comes straight off the STFT, so it needs no
    constant-Q transform. Best when take and reference share HARMONY: voice,
    keys, bass, anything pitched. Useless for unpitched percussion, where
    melflux is the one to use. `mask`: the bleed removed from `y`, if any — a
    frame whose remaining energy is under it by BLEED_MASK_DB is residue, and
    becomes a zero vector, which costs the same against every lag.
    """
    f = np.fft.rfftfreq(NFFT_CHROMA, 1 / SR)
    f[0] = 1e-9
    pc = np.round(12.0 * np.log2(f / 440.0)).astype(int) % 12
    keep = (f > CHROMA_LO_HZ) & (f < CHROMA_HI_HZ)
    masks = [keep & (pc == k) for k in range(12)]
    bleed = _stft_mag(mask, nfft=NFFT_CHROMA) if mask is not None else None
    out = []
    for mag in _stft_mag(y, nfft=NFFT_CHROMA):
        # Log magnitude, not power: power lets the single loudest partial decide
        # the pitch class of the whole frame, which is a timbre measurement
        # wearing a chroma costume.
        S = np.log1p(1000.0 * mag)
        C = np.stack([S[:, m].sum(axis=1) for m in masks], axis=1)
        C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
        if bleed is not None:
            B = next(bleed, None)
            if B is not None and len(B) == len(mag):
                e_take = (mag[:, keep] ** 2).sum(axis=1)
                e_bleed = (B[:, keep] ** 2).sum(axis=1)
                C[e_take < e_bleed * 10 ** (-BLEED_MASK_DB / 10)] = 0.0
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


# ── The echo test, and the two ways a confident number is wrong ───────────────
#
# Measured on real material on 2026-10-13 (`scripts/p2g_real_bench.py`: 13
# Dagstuhl ChoirSet quartets leave-one-out, 296 cases; a jazz keys/guitar pair):
#
# 1. THE ANSWER CAN BE THE CENTRE IT WAS GIVEN. On the jazz pair, moving
#    --expect from truth−75 to truth+75 moved the answer 64 → 203 ms: the DTW
#    was returning the calibration figure, not measuring the take. On choir,
#    melflux follows the centre by ~23 % (chroma ~0 %). So the band is centred
#    twice, at expect − S and expect + S, and
#        echo = (lag₊ − lag₋) / 2S          0 = measures, 1 = returns the centre
#    Above ECHO_MAX the result is "not measured". Below it, the MIDPOINT of the
#    two runs is the answer — it cancels the partial pull: choir, clean, melflux
#    midpoint within 25 ms of truth in 90 % of cases and never off by > 60.
#
# 2. THE BLEED IS WHERE THE PLAYER IS — so it is removed, not used to refuse.
#    The reference leaking into the mic (on headphones too: −28…−32 dB on the
#    2026-10-13 keys session) is the reference itself, machine-perfect, and
#    every feature locks onto it. p2g_bleed.py finds it by GCC-PHAT to a tenth
#    of a millisecond and subtracts it first. A first version also REFUSED any
#    answer within 20 ms of the bleed's lag, set on a benchmark that put the
#    bleed 70 ms away from the player. That was wrong: a player in time with
#    what they hear lands in the take at the device round trip — which is
#    exactly where the bleed lands. On the real keys session the rule refused
#    three right answers. The bleed's lag is instead the best CENTRE there is:
#    the round trip measured on this very take, which a calibration round can
#    only estimate beforehand (it jumped 10 ms mid-take on that session).
#
# The MAD is still reported but no longer decides anything: on real voices a
# CORRECT answer has a median MAD of 64 ms, so the old 40-ms threshold called
# every choir result soft (1 of 296 passed it).
ECHO_SHIFT_MS = 50.0
ECHO_MAX = 0.5
# 0.5, not 0.3: on choir a RIGHT melflux answer follows the centre by 0.12–0.46
# (p10–p90) and the midpoint cancels it; on the jazz pair, where the DTW was not
# measuring, echo was 0.99–1.45. 0.5 passes 272/296 choir cases (0.3: 223) at
# the same accuracy and still refuses all 12 jazz ones.
BLEED_CENTRE_BAND_SEC = 0.25    # the band around a bleed-derived centre


def _bleed(ref: np.ndarray, take: np.ndarray):
    """Find the reference in the take and remove it.
    Returns (take, removed bleed | None, info | None).
    Never fatal: an analyser that cannot look for bleed still aligns."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import p2g_bleed as pb
        assert pb.SR == SR
        r, t = ref.astype(np.float64), take.astype(np.float64)
        lags, cc = pb.gcc_phat(r, t, *pb.SEARCH_MS)
        lag, psr = pb.peak(lags, cc)
        uniq = pb.uniqueness(lags, cc)
        L = int(pb.BLOCK_SEC * SR)
        blocks = [pb.peak(*pb.gcc_phat(r[s:s + L], t[s:s + L], *pb.SEARCH_MS))[0]
                  for s in range(0, len(t) - L + 1, L)]
        agree = (sum(abs(b - lag) <= pb.AGREE_MS for b in blocks) / len(blocks)) if blocks else 1.0
        if not (psr >= pb.PSR_MIN and uniq >= pb.UNIQ_MIN and agree >= pb.AGREE_MIN):
            return take, None, None
        clean, est = pb.fit_and_subtract(r, t, lag)
        return clean.astype(np.float32), est.astype(np.float32), {
            "lagMs": round(lag, 2), "psr": round(psr, 1),
            "levelDb": round(pb.db(est) - pb.db(t), 1),
        }
    except Exception as e:                      # noqa: BLE001 — see docstring
        print(f"bleed check skipped: {e}", file=sys.stderr)
        return take, None, None


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
    ap.add_argument("--no-echo", action="store_true",
                    help="one run centred on --expect (the pre-2026-10-13 behaviour)")
    ap.add_argument("--no-debleed", action="store_true",
                    help="do not look for the reference in the take")
    ap.add_argument("--bleed-mask-db", type=float, default=None,
                    help="tuning only: override BLEED_MASK_DB")
    args = ap.parse_args()

    frame_ms = HOP / SR * 1000.0
    try:
        ref, take = decode(args.reference), decode(args.take)

        # Nothing was played. Without this the aligner returns whatever the band
        # happened to favour, which on a silent fixture was a confident +203 ms
        # — the same failure doc 10 records for a silent calibration ("a silent
        # take used to return a confident 182 ms"). Measured on the AUDIO, not
        # on the feature: a take of nothing but hum has plenty of amplitude and
        # no structure to align, which is the feature's problem, not this one.
        for name, sig in (("reference", ref), ("take", take)):
            rms = float(np.sqrt(np.mean(sig.astype(np.float64) ** 2))) if len(sig) else 0.0
            if rms < 1e-4:
                raise RuntimeError(f"the {name} is silent — nothing to align")

        bleed, removed = None, None
        if not args.no_debleed:
            take, removed, bleed = _bleed(ref, take)
        if args.bleed_mask_db is not None:
            global BLEED_MASK_DB
            BLEED_MASK_DB = args.bleed_mask_db

        if args.feature == "melflux":
            floor = TOP_DB_AFTER_BLEED if removed is not None else None
            X, Y = mel_flux(ref, top_db=floor), mel_flux(take, mask=removed, top_db=floor)
        else:
            X, Y = chroma(ref), chroma(take, mask=removed)
        if X.ndim == 1:
            X = (X - X.mean()) / (X.std() + 1e-9)
            Y = (Y - Y.mean()) / (Y.std() + 1e-9)
        if len(X) < 16 or len(Y) < 16:
            raise RuntimeError("one of the files is too short to align")
        X, Y = X.astype(np.float32), Y.astype(np.float32)

        # Where to centre: the bleed's lag when there is one (measured on this
        # take, to a tenth of a ms), else the calibration/sync figure, else 0.
        centre_ms, band = args.expect, args.band
        centre_from = "expect" if args.expect > 0 else "none"
        if bleed:
            centre_ms, band, centre_from = bleed["lagMs"], min(args.band, BLEED_CENTRE_BAND_SEC), "bleed"
        half = int(round(band * 1000.0 / frame_ms))

        def one(expect_ms):
            centre = int(round(expect_ms / frame_ms))
            s = summarise(banded_dtw(X, Y, half, centre), frame_ms, args.capture_delay, args.window)
            # A lag pinned against the edge of the band is a boundary, not a
            # measurement — the same rule as `atSearchEdge` in the sync detector.
            s["atBandEdge"] = bool(abs(s["lagMs"] - expect_ms) > band * 1000.0 * 0.9)
            return s

        if args.no_echo:
            out = one(centre_ms)
            echo = None
        else:
            lo, hi = one(centre_ms - ECHO_SHIFT_MS), one(centre_ms + ECHO_SHIFT_MS)
            echo = (hi["lagMs"] - lo["lagMs"]) / (2 * ECHO_SHIFT_MS)
            lag = (lo["lagMs"] + hi["lagMs"]) / 2
            drift = lo["drift"]
            if len(lo["drift"]) == len(hi["drift"]):
                drift = [{"tSec": a["tSec"], "lagMs": round((a["lagMs"] + b["lagMs"]) / 2, 1)}
                         for a, b in zip(lo["drift"], hi["drift"])]
            out = {
                "lagMs": round(lag, 1),
                "offsetMs": round(lag + args.capture_delay, 1),
                "madMs": round(max(lo["madMs"], hi["madMs"]), 1),
                "drift": drift,
                "driftRangeMs": (round(max(d["lagMs"] for d in drift) - min(d["lagMs"] for d in drift), 1)
                                 if len(drift) > 1 else 0.0),
                "atBandEdge": lo["atBandEdge"] or hi["atBandEdge"],
                "echo": round(echo, 2),
                "echoLagsMs": [lo["lagMs"], hi["lagMs"]],
            }

        # The verdict, worst first. "measured" is the only one the UI offers as
        # a number to trust; the others still show it, with the reason.
        if echo is not None and abs(echo) > ECHO_MAX:
            verdict = "follows-centre"
        elif out["atBandEdge"]:
            verdict = "band-edge"
        else:
            verdict = "measured"

        out.update(ok=True, feature=args.feature, frameMs=round(frame_ms, 2),
                   refSec=round(len(ref) / SR, 2), takeSec=round(len(take) / SR, 2),
                   bandMs=round(band * 1000.0, 0), expectMs=args.expect,
                   centreMs=round(centre_ms, 1), centreFrom=centre_from,
                   bleed=bleed, verdict=verdict)
        json.dump(out, sys.stdout)
    except Exception as e:
        json.dump({"ok": False, "reason": str(e)[:300]}, sys.stdout)
        sys.stdout.flush()
        sys.exit(0)


if __name__ == "__main__":
    main()
