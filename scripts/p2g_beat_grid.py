#!/usr/bin/env python3
"""
Pulse grid of a P2G reference, and where a take's attacks sit on it.

Read `docs/llm/15-beat-grid.md` first. In one paragraph: Beat This! (JKU,
ISMIR 2024, MIT; the small checkpoint exported to ONNX) finds the beats of the
REFERENCE — once per reference, cached next to it. For a take, the script finds
its attacks (spectral flux, numpy only) and tries every shift in a window: the
shift that lands the most attack strength within ~15 ms of a beat is the
suggested lag. Instruments that sound nothing alike still play on the same
pulse, which is the whole reason this works across instruments where an
envelope or a DTW path does not.

  grid  REF --cache C.json                        -> beats of the reference
  align REF TAKE --cache C.json [--expect MS] [--capture-delay MS]
                                                  -> suggested lag for the take

Prints ONE JSON object on stdout. Needs numpy + onnxruntime and ffmpeg on PATH.
Runs single-threaded at low priority: it shares the box with a live room.
"""
import argparse, json, os, subprocess, sys, time

# Before numpy loads: its BLAS otherwise starts one busy thread per core for the
# mel matmul (measured: 35 s of CPU for 10 s of wall clock on one core's work).
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "beat_this_small0.onnx")
SR, NFFT, HOP, FPS, BORDER = 22050, 1024, 441, 50, 6
# 10-s chunks. Attention memory is quadratic in the chunk: 1500 frames (the
# training length) peaks at ~1 GB, 500 at ~280 MB, with the same beats.
CHUNK = 500
ONSET_HOP = 64            # 2.9 ms onset resolution
SIGMA = 0.015             # how close to a beat an attack must land to count
# The flux below rises as soon as an attack enters its 46 ms window, so its
# peak sits ~20 ms BEFORE the attack (measured on clicks: -19.8 ms, spread
# 3 ms). Every flux time is shifted by this. It has to be the same shift on
# both sides — the reference's beats are snapped to its flux, the take's
# attacks come from its flux — and when it was not, the snap missed the peak
# and left a -15 ms bias on every answer (the 2026-10-08 "keys feel").
FLUX_LEAD = 0.020
SNAP = 0.035              # how far a model beat (20 ms grid) may move to its attack
CACHE_VERSION = 2   # 2: FLUX_LEAD — grids cached before it are biased


# ── Audio ─────────────────────────────────────────────────────────────────────
def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    # Mean of the channels, as Beat This! was trained (ffmpeg's own -ac 1 is
    # -3 dB per channel, which moves every log-mel bin).
    return x[: len(x) // 2 * 2].reshape(-1, 2).mean(axis=1)


def _hz_to_mel(f):
    f = np.asarray(f, float)
    lin, minlog = f / (200.0 / 3), 1000.0 / (200.0 / 3)
    return np.where(f >= 1000.0, minlog + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), lin)


def _mel_to_hz(m):
    m = np.asarray(m, float)
    minlog = 1000.0 / (200.0 / 3)
    return np.where(m >= minlog, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - minlog)), m * (200.0 / 3))


def mel_filterbank(n_freqs=NFFT // 2 + 1, f_min=30.0, f_max=11000.0, n_mels=128):
    """torchaudio's melscale_fbanks(norm=None, mel_scale="slaney"), the model's
    training frontend. Checked equal to it within 1.3e-5."""
    all_f = np.linspace(0, SR // 2, n_freqs)
    f_pts = _mel_to_hz(np.linspace(_hz_to_mel(f_min), _hz_to_mel(f_max), n_mels + 2))
    f_diff = f_pts[1:] - f_pts[:-1]
    slopes = f_pts[None, :] - all_f[:, None]
    down = -slopes[:, :-2] / f_diff[:-1]
    up = slopes[:, 2:] / f_diff[1:]
    return np.maximum(0, np.minimum(down, up)).astype(np.float32)


FB = mel_filterbank()


# ── Beat This! on the reference ───────────────────────────────────────────────
def logmel(x):
    x = np.pad(x, NFFT // 2, mode="reflect")
    win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NFFT) / NFFT)).astype(np.float32)
    frames = swv(x, NFFT)[::HOP]
    out = []
    for i in range(0, len(frames), 2048):
        # torchaudio's normalized="frame_length" comes out as / sqrt(n_fft) here.
        mag = np.abs(np.fft.rfft(frames[i:i + 2048] * win, axis=1)) / np.sqrt(NFFT)
        out.append(np.log1p(1000 * (mag.astype(np.float32) @ FB)))
    return np.concatenate(out)


def _session():
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.enable_cpu_mem_arena = False   # otherwise the peak stays allocated
    so.enable_mem_pattern = False
    return ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])


def _predict(sess, spect):
    """Frame logits for the whole piece, chunked with Beat This!'s own overlap
    rule (keep_first, 6-frame borders discarded)."""
    n = len(spect)
    starts = np.arange(-BORDER, n - BORDER, CHUNK - 2 * BORDER)
    if n > CHUNK - 2 * BORDER:
        starts[-1] = n - (CHUNK - BORDER)
    beat = np.full(n, -1000.0, np.float32)
    down = beat.copy()
    for st in reversed(starts):
        c = spect[max(st, 0):min(st + CHUNK, n)]
        c = np.pad(c, ((max(0, -st), max(0, min(BORDER, st + CHUNK - n))), (0, 0)))
        b, d = sess.run(None, {"spect": c[None].astype(np.float32)})
        b, d = b[0][BORDER:-BORDER], d[0][BORDER:-BORDER]
        lo = st + BORDER
        hi = min(lo + len(b), n)
        beat[lo:hi] = b[:hi - lo]
        down[lo:hi] = d[:hi - lo]
    return beat, down


def _peaks(logit):
    mx = swv(np.pad(logit, 3, constant_values=-np.inf), 7).max(axis=1)
    idx = np.nonzero((logit == mx) & (logit > 0))[0]
    groups = []
    for i in idx:
        if groups and i - groups[-1][-1] <= 1:
            groups[-1].append(i)
        else:
            groups.append([i])
    return np.array([np.mean(g) for g in groups]) / FPS


def flux(x):
    """Onset strength at ONSET_HOP resolution, normalised to [0, 1]."""
    win = np.hanning(NFFT).astype(np.float32)
    frames = swv(np.pad(x, NFFT // 2), NFFT)[::ONSET_HOP]
    out = []
    for i in range(0, len(frames), 4096):
        m = np.abs(np.fft.rfft(frames[i:i + 4096] * win, axis=1)).astype(np.float32) @ FB
        out.append(np.log1p(100 * m))
    lm = np.concatenate(out)
    f = np.concatenate([[0], np.maximum(0, np.diff(lm, axis=0)).sum(1)])
    return f / (f.max() + 1e-9)


def beat_grid(x):
    beats, downs = _predict(_session(), logmel(x))
    beats, downs = _peaks(beats), _peaks(downs)
    if len(beats) == 0:
        return beats, downs
    downs = np.unique([beats[np.argmin(np.abs(beats - t))] for t in downs])
    # The model works on a 20 ms grid; snap each beat to the reference's own
    # attack within ±SNAP so the grid is as sharp as the takes measured on it.
    f = flux(x)
    t = np.arange(len(f)) * ONSET_HOP / SR + FLUX_LEAD
    snapped = []
    for b in beats:
        m = np.abs(t - b) <= SNAP
        snapped.append(float(t[m][np.argmax(f[m])]) if m.any() and f[m].max() > 0 else float(b))
    snapped = np.array(snapped)
    downs = np.array([snapped[np.argmin(np.abs(beats - d))] for d in downs])
    return snapped, downs


# ── The take ──────────────────────────────────────────────────────────────────
def onsets(x):
    """Attack times and strengths, ignoring anything more than 25 dB under the
    take's loud passages — a take that is silent for a verse otherwise fills
    the silence with noise 'attacks' that land everywhere."""
    f = flux(x)
    k = int(0.03 * SR / ONSET_HOP)
    mx = swv(np.pad(f, k), 2 * k + 1).max(1)
    idx = np.nonzero((f == mx) & (f > np.median(f) + 0.5 * np.std(f)))[0]
    t = idx * ONSET_HOP / SR + FLUX_LEAD
    hop = int(0.02 * SR)
    n = len(x) // hop
    rms_db = 20 * np.log10(np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)
    loud = np.percentile(rms_db, 90) - 25
    keep = rms_db[np.minimum(n - 1, (t / 0.02).astype(int))] > loud
    return t[keep], f[idx][keep]


def score_lags(beats, on, w, lo, hi):
    lags = np.arange(lo, hi + 1e-9, 0.001)
    score = np.empty(len(lags))
    for i, L in enumerate(lags):
        s = on - L
        j = np.clip(np.searchsorted(beats, s), 1, len(beats) - 1)
        d = np.minimum(np.abs(s - beats[j - 1]), np.abs(s - beats[j]))
        score[i] = (w * np.exp(-0.5 * (d / SIGMA) ** 2)).sum()
    return lags, score


def candidates(lags, score, n=3, apart=0.06):
    """Best local maxima, each at least `apart` from the ones above it."""
    peaks = [i for i in range(len(score))
             if (i == 0 or score[i] >= score[i - 1]) and (i == len(score) - 1 or score[i] >= score[i + 1])]
    out = []
    for i in sorted(peaks, key=lambda i: -score[i]):
        if all(abs(lags[i] - lags[j]) > apart for j in out):
            out.append(i)
        if len(out) == n:
            break
    top = score[out[0]] if out else 1.0
    return [(float(lags[i]), float(score[i] / (top + 1e-12))) for i in out]


# ── Cache ─────────────────────────────────────────────────────────────────────
def _source_stamp(path):
    st = os.stat(path)
    return {"file": os.path.basename(path), "size": st.st_size, "mtimeMs": int(st.st_mtime * 1000)}


def grid_for(ref_path, cache_path):
    """The reference's grid, from the cache when it still describes this file."""
    stamp = _source_stamp(ref_path)
    try:
        with open(cache_path) as fh:
            c = json.load(fh)
        if c.get("version") == CACHE_VERSION and c.get("source") == stamp:
            return c, True
    except (OSError, ValueError):
        pass
    t0 = time.process_time()
    x = load(ref_path)
    beats, downs = beat_grid(x)
    ibi = np.diff(beats)
    c = {
        "version": CACHE_VERSION,
        "source": stamp,
        "durationSec": round(len(x) / SR, 3),
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(d), 4) for d in downs],
        "bpm": round(60 / float(np.median(ibi)), 1) if len(ibi) else None,
        # Share of beat-to-beat gaps within 15 % of the median: a free intro or
        # rubato shows up here before it shows up as a wrong answer.
        "regularPct": round(100 * float(np.mean(np.abs(ibi / np.median(ibi) - 1) <= 0.15))) if len(ibi) else 0,
        "cpuSec": round(time.process_time() - t0, 1),
    }
    tmp = cache_path + ".part"
    with open(tmp, "w") as fh:
        json.dump(c, fh)
    os.replace(tmp, cache_path)
    return c, False


# ── CLI ───────────────────────────────────────────────────────────────────────
MIN_BEATS = 8
MIN_ONSETS = 12
# Below this the best shift clearly beats every other one. Calibrated on the
# 2026-10-08 material: correct answers on real stems scored the runner-up at
# 0.55-0.92; the 181 BPM session where pulse and off-beat were
# indistinguishable scored it at 0.93-1.00.
CLEAR_BELOW = 0.9


def cmd_align(a):
    grid, cached = grid_for(a.reference, a.cache)
    beats = np.array(grid["beats"])
    if len(beats) < MIN_BEATS:
        return {"ok": False, "reason": "the reference has no steady pulse to measure against"}
    x = load(a.take)
    on, w = onsets(x)
    if len(on) < MIN_ONSETS:
        return {"ok": False, "reason": "this take has too few clear attacks to place on the pulse"}

    period = float(np.median(np.diff(beats)))
    # With a measurement to centre on, search only half a beat either side of
    # it: the lag and the lag one beat over cannot both fit, so the answer is
    # unique. Blind, ±400 ms — which on fast music holds more than one beat,
    # and the alias check below is what says so. The centre may be negative (a
    # DTW figure for a take that leads), so "given" is the test, not "> 0".
    centred = a.expect is not None
    if centred:
        half = min(0.4, 0.45 * period)
        lo, hi = a.expect / 1000 - half, a.expect / 1000 + half
    else:
        lo, hi = -0.4, 0.4
    lags, score = score_lags(beats, on, w, lo, hi)
    cands = candidates(lags, score)
    lag = cands[0][0]
    alias = cands[1][1] if len(cands) > 1 else 0.0
    cd = a.capture_delay
    return {
        "ok": True,
        # Same convention as the DTW: the slider value that places the take is
        # lag + captureDelayMs (see docs/llm/12-dtw-alignment.md, "arithmetic").
        "lagMs": round(lag * 1000, 1),
        "offsetMs": round(lag * 1000 + cd, 1),
        "aliasRatio": round(alias, 2),
        "clear": alias < CLEAR_BELOW,
        "candidates": [{"offsetMs": round(l * 1000 + cd, 1), "score": round(s, 2)} for l, s in cands],
        "centred": centred,
        "windowMs": [round(lo * 1000), round(hi * 1000)],
        "atWindowEdge": bool(abs(lag - lo) < 0.002 or abs(lag - hi) < 0.002),
        "bpm": grid["bpm"],
        "regularPct": grid["regularPct"],
        "onsets": int(len(on)),
        "gridCached": cached,
    }


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("grid")
    g.add_argument("reference")
    g.add_argument("--cache", required=True)
    al = sub.add_parser("align")
    al.add_argument("reference")
    al.add_argument("take")
    al.add_argument("--cache", required=True)
    al.add_argument("--expect", type=float, default=None,
                    help="ms on the lag axis; centres the search, never used as a value. Omit for a blind search")
    al.add_argument("--capture-delay", type=float, default=0.0)
    a = ap.parse_args()

    try:
        os.nice(10)   # a live room on the same box wins every contest for CPU
    except OSError:
        pass
    if not os.path.exists(MODEL):
        print(json.dumps({"ok": False, "reason":
            "the pulse model is not on this server — run scripts/fetch-models.sh and rebuild the image"}))
        return
    try:
        if a.cmd == "grid":
            c, cached = grid_for(a.reference, a.cache)
            out = {"ok": True, "cached": cached, **{k: c[k] for k in ("beats", "downbeats", "bpm", "regularPct", "durationSec")}}
        else:
            out = cmd_align(a)
    except subprocess.CalledProcessError as e:
        out = {"ok": False, "reason": f"ffmpeg could not decode the audio: {e.stderr.decode(errors='replace')[:200]}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
