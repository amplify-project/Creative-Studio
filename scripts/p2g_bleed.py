#!/usr/bin/env python3
"""
Reference bleed in a take: find it, time it, and take it out.  PROTOTYPE.

Docs 11 and 12 treat the reference leaking into the mic as a trap — it is
machine-perfect, so any aligner that counts events measures IT instead of the
player (fixture K). But the bleed is not just any interference: it is the very
file we played, so it can be found exactly, and that turns the trap into two
things worth having:

1. **The device round trip, measured inside every take.** GCC-PHAT whitens the
   cross-spectrum, so a copy of the same waveform gives a needle-sharp peak at
   its delay, while a different instrument playing along (shared harmony,
   shared rhythm, different waveform) gives a broad, low one. That is the
   calibration number, for free, on the take itself — whenever there is bleed.
2. **A take with the bleed removed**, for the DTW and the pulse grid to measure
   the player in. The transfer function (speaker → room → mic) is fitted by
   least squares and then WINDOWED in time to a few tens of ms around the
   bleed's delay before it is subtracted. Without the window it would also fit
   whatever of the player correlates with the reference — which, in music, is
   a lot — and subtract the performance.

    python3 scripts/p2g_bleed.py reference.wav take.ogg                 # measure
    python3 scripts/p2g_bleed.py reference.wav take.ogg --out clean.wav # + remove

One JSON line on stdout, like the other analysers. Lags use the same
convention as `p2g_dtw_align.py`: an event at reference time T is at T + lag in
the take file.

Known limits of the prototype:
- The filter also removes whatever of the player correlates with the
  reference inside its 6-ms support: a fixed floor (~24 dB down on a real
  take), worse when the player sits within a few ms of the bleed.
- One transfer function per block (BLOCK_SEC): a mic or player moving fast,
  or a gain change by the browser's AGC, is followed only block by block.
- With no bleed (headphones) it should say `present: false` and do nothing;
  the threshold for that is a first guess (PSR_MIN) to be set on real takes.
"""

import argparse, json, subprocess, sys, wave
import numpy as np

SR = 22050
SEARCH_MS = (-300.0, 700.0)   # bleed lag search, in take-file coordinates
BAND_HZ = (150.0, 6000.0)     # PHAT weighting only where both signals have energy
# Measured 2026-10-13 on a real take (rec_jruiz) with bleed injected at 60 ms,
# scored against the original: the filter also absorbs the slice of the player
# that correlates with the reference inside its support, which shows up as a
# FLOOR on the result independent of the bleed level. Fewer taps and longer
# blocks lower it — (pre, post, block) → floor:  (2, 25, 8 s) 17.7 dB,
# (1, 10, 16 s) 23.2, (1, 5, 16 s) 24.2, (0.5, 2, 16 s) 25.1. At 24 dB a bleed
# 24 dB down is left as it was and a 0 dB bleed gains 24 dB. Caveat: that bleed
# was a pure digital delay; a real speaker in a room has a reverberant tail
# longer than 5 ms, which this support leaves in place. Check on a real
# speaker take before trusting the floor.
BLOCK_SEC = 16.0              # per-block lag (stability) and per-block filter
# Real takes with no bleed (July session, five players on headphones): PSR 3.8–7.
# Real take with bleed injected 24 dB down: 14.7; 12 dB down: 50; 0 dB: 148.
# (Synthetic fixtures are NOT a guide here — additive tones are phase-locked to
# the reference and score 15–25 with no bleed at all.)
PSR_MIN = 10.0                # peak-to-sidelobe ratio that counts as "bleed present"
# Set on p2g_real_bench (2026-10-13): 154 takes with bleed (choir + jazz) and
# 154 without. PSR alone flagged 31 clean takes — dataset crosstalk at the
# singer's own lag, and a comb of hum peaks at 0. With bleed: uniq 5.9–74,
# agree 0.88–1.0. Without: uniq median 1.19, agree median 0. The three gates
# together: 154/154 detected, 3/154 false (two unexplained peaks at 0 ms in
# x80 excerpts, one crosstalk).
UNIQ_MIN = 2.0                # main peak / tallest other peak
AGREE_MIN = 0.6               # share of blocks that see the same lag (±AGREE_MS)
AGREE_MS = 1.0
WIN_PRE_MS, WIN_POST_MS = 1.0, 5.0    # filter support around the bleed lag
REG = 1e-3                    # ridge on the normal equations, relative to the zero-lag energy


def decode(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                        "-f", "f32le", "-"], capture_output=True)
    if p.returncode or not p.stdout:
        raise RuntimeError(f"ffmpeg could not decode {path}: {p.stderr.decode(errors='replace')[:200]}")
    return np.frombuffer(p.stdout, np.float32).astype(np.float64)


def gcc_phat(ref, take, lo_ms, hi_ms):
    """Correlation over lags [lo, hi] ms, PHAT-weighted. Returns (lags_ms, curve)."""
    n = 1 << int(np.ceil(np.log2(len(ref) + len(take))))
    R, T = np.fft.rfft(ref, n), np.fft.rfft(take, n)
    X = T * np.conj(R)
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f >= BAND_HZ[0]) & (f <= BAND_HZ[1])
    W = np.zeros_like(f)
    W[band] = 1.0
    cc = np.fft.irfft(X / (np.abs(X) + 1e-12) * W, n)
    lo, hi = int(np.floor(lo_ms * SR / 1000)), int(np.ceil(hi_ms * SR / 1000))
    idx = np.arange(lo, hi + 1)
    return idx * 1000.0 / SR, cc[idx % n]


def peak(lags_ms, cc):
    """Sub-sample peak (parabolic) and its peak-to-sidelobe ratio."""
    k = int(np.argmax(cc))
    off = 0.0
    if 0 < k < len(cc) - 1:
        a, b, c = cc[k - 1], cc[k], cc[k + 1]
        den = a - 2 * b + c
        off = 0.5 * (a - c) / den if den else 0.0
    step = lags_ms[1] - lags_ms[0]
    excl = int(round(5.0 / step))                       # ±5 ms around the peak
    side = np.concatenate([cc[:max(0, k - excl)], cc[k + excl + 1:]])
    psr = (cc[k] - side.mean()) / (side.std() + 1e-12) if len(side) > 10 else 0.0
    return float(lags_ms[k] + off * step), float(psr)


def uniqueness(lags_ms, cc):
    """Main peak over the tallest peak outside ±5 ms of it. A copy of the
    reference gives one needle (ratio ≫ 1); a stationary tone such as mains hum
    gives a comb of equal teeth every period (ratio ≈ 1), and the argmax among
    the teeth is a coin toss — the "bleed at 0 ms" in clean choir takes."""
    k = int(np.argmax(cc))
    step = lags_ms[1] - lags_ms[0]
    excl = int(round(5.0 / step))
    side = np.concatenate([cc[:max(0, k - excl)], cc[k + excl + 1:]])
    return float(cc[k] / (side.max() + 1e-12)) if len(side) else 0.0


def _fftconv(x, h, n_out):
    n = 1 << int(np.ceil(np.log2(len(x) + len(h))))
    return np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(h, n), n)[:n_out]


def fit_and_subtract(ref, take, lag_ms):
    """Block-wise least-squares FIR of speaker→room→mic, subtracted.

    The FIR only has taps at lags d-pre .. d+post, and it is solved in the TIME
    domain (Wiener-Hopf normal equations, a span×span Toeplitz system). The
    first version estimated H = T·R*/|R|² in frequency and windowed it in time
    afterwards: wherever the reference is quiet in a band, that division blows
    the player's own contribution up, and the noise lands inside the window as
    well as outside — on fixture K it made the take WORSE (13.9 → 7.9 dB). Least
    squares over just the window's taps cannot do that: the player only biases
    it through what correlates with the reference AT those lags.

    Blocks overlap by half with a Hann crossfade, so a filter that changes from
    block to block does not click."""
    L = int(BLOCK_SEC * SR)
    hop = L // 2
    pre, post = int(WIN_PRE_MS * SR / 1000), int(WIN_POST_MS * SR / 1000)
    span = pre + post + 1
    s0 = int(round(lag_ms * SR / 1000)) - pre          # the first tap's lag
    # rd[n] = ref[n - s0]: tap k of the FIR then sits at lag s0 + k
    rd = np.zeros(len(take))
    if s0 >= 0:
        m = min(len(ref), len(take) - s0)
        if m > 0:
            rd[s0:s0 + m] = ref[:m]
    else:
        m = min(len(ref) + s0, len(take))
        if m > 0:
            rd[:m] = ref[-s0:-s0 + m]
    rdp = np.concatenate([np.zeros(span - 1), rd])      # history before t=0
    win = np.hanning(L)
    est = np.zeros(len(take))
    norm = np.zeros(len(take))
    starts = list(range(0, max(1, len(take) - L + 1), hop))
    if starts[-1] + L < len(take):
        starts.append(max(0, len(take) - L))
    for s in starts:
        t = take[s:s + L]
        x = rdp[s:s + len(t) + span - 1]               # x[j + span-1] == rd[s + j]
        n = 1 << int(np.ceil(np.log2(len(x) + span)))
        X = np.fft.rfft(x, n)
        # autocorrelation of x for lags 0..span-1, cross-correlation t·x
        ac = np.fft.irfft(np.abs(X) ** 2, n)[:span]
        # p[k] = sum_j t[j] * rd[s + j - k] = sum_j t[j] * x[j + span-1 - k]
        tp = np.zeros(n); tp[span - 1:span - 1 + len(t)] = t
        cc = np.fft.irfft(np.fft.rfft(tp, n) * np.conj(X), n)
        p = cc[:span]
        idx = np.abs(np.subtract.outer(np.arange(span), np.arange(span)))
        A = ac[idx]
        A[np.diag_indices(span)] += REG * ac[0] + 1e-12
        h = np.linalg.solve(A, p)
        y = _fftconv(x, h, len(x))[span - 1:span - 1 + len(t)]
        est[s:s + len(t)] += y * win[:len(t)]
        norm[s:s + len(t)] += win[:len(t)]
    est /= np.maximum(norm, 1e-3)
    return take - est, est


def db(x):
    return float(10 * np.log10(np.mean(x ** 2) + 1e-20))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reference")
    ap.add_argument("take")
    ap.add_argument("--out", help="write the take with the bleed removed (wav, 22.05 kHz)")
    a = ap.parse_args()
    try:
        ref, take = decode(a.reference), decode(a.take)
        lags, cc = gcc_phat(ref, take, *SEARCH_MS)
        lag, psr = peak(lags, cc)
        uniq = uniqueness(lags, cc)

        # The same measurement per block: a real bleed is the same delay all
        # the way through (it is hardware); a coincidence is not.
        blocks = []
        L = int(BLOCK_SEC * SR)
        for s in range(0, len(take) - L + 1, L):
            bl, bp = peak(*gcc_phat(ref[s:s + L], take[s:s + L], *SEARCH_MS))
            blocks.append({"tSec": round(s / SR, 1), "lagMs": round(bl, 2), "psr": round(bp, 1)})
        good = [b["lagMs"] for b in blocks if b["psr"] >= PSR_MIN]
        agree = (sum(abs(b["lagMs"] - lag) <= AGREE_MS for b in blocks) / len(blocks)) if blocks else 1.0
        # Hardware is the same delay all the way through. A peak that only some
        # blocks see, or that is one tooth of a comb, is not bleed.
        present = psr >= PSR_MIN and uniq >= UNIQ_MIN and agree >= AGREE_MIN
        out = {"ok": True, "present": bool(present), "lagMs": round(lag, 2), "psr": round(psr, 1),
               "uniq": round(uniq, 2), "blockAgree": round(agree, 2),
               "blocks": blocks,
               "blockSpreadMs": round(float(np.ptp(good)), 2) if len(good) > 1 else None}

        if present:
            clean, est = fit_and_subtract(ref, take, lag)
            out.update(bleedDb=round(db(est) - db(take), 1),
                       reductionDb=round(db(take) - db(clean), 2))
            if a.out:
                y = clean / max(1.0, float(np.max(np.abs(clean))))
                with wave.open(a.out, "wb") as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
                    w.writeframes((y * 32767).astype(np.int16).tobytes())
                out["out"] = a.out
        elif a.out:
            out["out"] = None   # nothing to remove; the caller keeps the original
        json.dump(out, sys.stdout)
    except Exception as e:
        json.dump({"ok": False, "reason": str(e)[:300]}, sys.stdout)


if __name__ == "__main__":
    main()
