#!/usr/bin/env python3
"""EXPERIMENT (not used by the product): two ways to get downbeats out of a
single-instrument take, after CPJKU/beat_this#13 (octave correction, ensembles).

Both use what a generic BPM estimator does not have: the REFERENCE, whose grid
is reliable (full mix) and whose bar length is therefore known.

  peaks   today's method: take downbeats = peaks of the model's downbeat logit
          above 0; lag = best match of take downbeats to reference downbeats.
  guided  (A) peaks of the take's downbeat logit with a LOWER threshold, kept
          only when spaced like the reference's bars — recovers weak downbeats
          a solo instrument gives the model, without accepting noise.
  act     (B) no peak picking: cross-correlate the take's downbeat activation
          with the reference's over every lag in ±1.2 s.

All three are then refined on attacks within ±0.15 s (the pulse grid's score).

usage: python3 scripts/p2g_downbeat_exp2.py <workdir> [<testAudio dir>]
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np

repo = Path(__file__).resolve().parents[1]
work = Path(sys.argv[1]); work.mkdir(parents=True, exist_ok=True)
T = Path(sys.argv[2]) if len(sys.argv) > 2 else repo.parent / "testAudio"
sys.path.insert(0, str(repo / "scripts"))
import p2g_beat_grid as bg  # noqa: E402

SR, FPS = bg.SR, bg.FPS
SESS = bg._session()
WIDE = 1.2


def model(x):
    """Beats, downbeats (seconds, snapped like the product) and the raw logits."""
    b_logit, d_logit = bg._predict(SESS, bg.logmel(x))
    beats, downs = bg.beat_grid(x)          # snapped exactly as the product does
    return beats, downs, b_logit, d_logit


def match_score(dt, dr, lags, tol=0.07):
    s = np.zeros(len(lags))
    if len(dt) == 0 or len(dr) < 2:
        return s
    for i, L in enumerate(lags):
        x = dt - L
        j = np.clip(np.searchsorted(dr, x), 1, len(dr) - 1)
        d = np.minimum(np.abs(x - dr[j - 1]), np.abs(x - dr[j]))
        s[i] = np.mean(np.exp(-0.5 * (d / (tol / 2)) ** 2))
    return s


def guided_peaks(d_logit, bar, thr=-2.5):
    """Local maxima above `thr`, greedily kept strongest-first with at least
    0.6 bar between them (the reference's bar)."""
    lg = d_logit
    idx = [i for i in range(1, len(lg) - 1) if lg[i] >= lg[i - 1] and lg[i] >= lg[i + 1] and lg[i] > thr]
    keep, gap = [], int(0.6 * bar * FPS)
    for i in sorted(idx, key=lambda i: -lg[i]):
        if all(abs(i - k) >= gap for k in keep):
            keep.append(i)
    return np.sort(np.array(keep, float)) / FPS


def act_corr(d_take, d_ref, lags):
    """Correlation of downbeat probabilities, take shifted by each lag."""
    p_t = 1 / (1 + np.exp(-d_take)); p_r = 1 / (1 + np.exp(-d_ref))
    p_t = p_t - p_t.mean(); p_r = p_r - p_r.mean()
    out = np.zeros(len(lags))
    for i, L in enumerate(lags):
        k = int(round(L * FPS))
        if k >= 0:
            a, b = p_t[k:], p_r[:len(p_t) - k]
        else:
            a, b = p_t[:k], p_r[-k:len(p_t)]
        n = min(len(a), len(b))
        out[i] = float(a[:n] @ b[:n]) / (np.linalg.norm(a[:n]) * np.linalg.norm(b[:n]) + 1e-9)
    return out


def refine(rb, on, w, coarse):
    l2, s2 = bg.score_lags(rb, on, w, coarse - 0.15, coarse + 0.15)
    return bg.candidates(l2, s2)[0][0]


def analyse(ref, take, rgrid=None):
    rb, rd, _, rdl = rgrid or model(ref)
    tb, td, _, tdl = model(take)
    on, w = bg.onsets(take)
    bar = float(np.median(np.diff(rd))) if len(rd) > 1 else 2.0
    out = {"bpm_ref": round(60 / np.median(np.diff(rb)), 1),
           "bpm_take": round(60 / np.median(np.diff(tb)), 1) if len(tb) > 1 else None,
           "downs": (len(rd), len(td))}
    # today's pulse grid, blind
    l, s = bg.score_lags(rb, on, w, -0.4, 0.4); c = bg.candidates(l, s)
    out["grid"] = (c[0][0], c[1][1] if len(c) > 1 else 0.0)
    L = np.arange(-WIDE, WIDE + 1e-9, 0.005)
    gd = guided_peaks(tdl, bar)
    out["downs_guided"] = len(gd)
    for name, sc, step in (("peaks", match_score(td, rd, L), L),
                           ("guided", match_score(gd, rd, L), L)):
        c = bg.candidates(step, sc, n=2, apart=0.25)
        out[name] = (refine(rb, on, w, c[0][0]), c[1][1] if len(c) > 1 else 0.0)
    La = np.arange(-WIDE, WIDE + 1e-9, 1 / FPS)
    sc = act_corr(tdl, rdl, La)
    sc = np.maximum(sc, 0)
    c = bg.candidates(La, sc, n=2, apart=0.25)
    out["act"] = (refine(rb, on, w, c[0][0]), c[1][1] if len(c) > 1 else 0.0)
    return out


def ffcut(src, dst, start, dur, tempo):
    af = f"atempo={tempo}" if tempo != 1 else "anull"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(dur), "-i", str(src),
                    "-af", af, "-ac", "1", "-ar", str(SR), str(dst)], check=True)


def delay(x, ms):
    n = int(round(ms * SR / 1000))
    return np.concatenate([np.zeros(n, np.float32), x])[:len(x)]


rows = []


def report(case, truth, r):
    def cell(k):
        lag, alias = r[k]
        e = "" if truth is None else f"{lag * 1000 - truth:+5.0f}"
        return f"{k} {lag * 1000:+6.0f}{(' (' + e + ')') if e else ''} a{alias:.2f}"
    print(f"{case:<30} bpm {r['bpm_ref']}/{r['bpm_take']} downs {r['downs']}→{r['downs_guided']} | "
          + " | ".join(cell(k) for k in ("grid", "peaks", "guided", "act")), flush=True)
    rows.append({"case": case, "truth": truth, **{k: r[k] for k in ("grid", "peaks", "guided", "act")}})


# 1. jazz keys/guitar, exact truth (+ the instrument's feel), tempo ×1 and ×1.5
for tempo in (1.0, 1.5):
    for rs, ts, tag in (("KeyStem.wav", "GtStem.wav", "gt/keys"), ("GtStem.wav", "KeyStem.wav", "keys/gt")):
        rp, tp = work / f"{tag.replace('/', '_')}_{tempo}_ref.wav", work / f"{tag.replace('/', '_')}_{tempo}_stem.wav"
        if not rp.exists():
            ffcut(T / rs, rp, 120.064, 60 * tempo, tempo); ffcut(T / ts, tp, 120.064, 60 * tempo, tempo)
        ref, stem = bg.load(str(rp)), bg.load(str(tp))
        rg = model(ref)
        for lag in (0, 130, 287):
            report(f"jazz {tag} x{tempo} lag{lag}", lag, analyse(ref, delay(stem, lag), rg))

# 2. keys121 session: proxy truth = the bleed's lag (the round trip on the take)
K = T / "p2g_keys121"
ref = bg.load(str(K / "reference.mp3")); rg = model(ref)
for t, proxy in (("rec_mzorrilla.ogg", 128.6), ("rec_mzorrilla_2.ogg", 132.6), ("rec_mzorrilla_3.ogg", 128.0)):
    report(f"keys121 {t[4:-4]} (bleed)", proxy, analyse(ref, bg.load(str(K / t)), rg))

# 3. martain take 2 (three methods agreed on ≈ −33)
M = T / "martain"
report("martain take 2 (≈-33)", -33, analyse(bg.load(str(M / "reference.wav")), bg.load(str(M / "rec_martainnskene_2.wav"))))

# 4. July session, 183 BPM — no truth
ref = bg.load(str(T / "reference.wav")); rg = model(ref)
for t in ("rec_jruiz.wav", "rec_mzorrilla.wav", "rec_I_igo_Tamayo_Uria.wav"):
    report(f"july {t[4:-4]}", None, analyse(ref, bg.load(str(T / t)), rg))

json.dump(rows, open(work / "results2.json", "w"), indent=1)
