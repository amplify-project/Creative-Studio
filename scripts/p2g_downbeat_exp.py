#!/usr/bin/env python3
"""EXPERIMENT (not used by the product): resolve beat aliasing with downbeats
from Beat This! run on the TAKE too. Results and reasoning: docs/llm/15-beat-grid.md,
"Downbeats on the take".

usage: python3 scripts/p2g_downbeat_exp.py <workdir> [<testAudio dir>]
Builds jazz keys/guitar cases (both directions, lags 0/130/287 ms, tempo x1 and
x1.5) from testAudio and compares:
  grid      today's pulse grid (take attacks on reference beats), blind ±400 ms
  downbeat  take downbeats (model) matched to reference downbeats, wide search,
            then refined by today's attack score within ±0.15 s
"""
import json, os, subprocess, sys
from pathlib import Path
import numpy as np

repo = Path(__file__).resolve().parents[1]
work = Path(sys.argv[1]); work.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(repo / "scripts"))
import p2g_beat_grid as bg  # noqa: E402

T = Path(sys.argv[2]) if len(sys.argv) > 2 else repo.parent / "testAudio"   # KeyStem.wav, GtStem.wav
SR = bg.SR
OFF = 120.064


def ff(src, dst, start, dur, tempo):
    af = f"atempo={tempo}" if tempo != 1 else "anull"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(dur), "-i", str(src),
                    "-af", af, "-ac", "1", "-ar", str(SR), str(dst)], check=True)


def delay(x, ms):
    n = int(round(ms * SR / 1000))
    return np.concatenate([np.zeros(n, np.float32), x])[:len(x)]


def db_score(dt, dr, lags, tol=0.07):
    s = np.zeros(len(lags))
    if len(dt) == 0 or len(dr) == 0:
        return s
    for i, L in enumerate(lags):
        x = dt - L
        j = np.clip(np.searchsorted(dr, x), 1, len(dr) - 1)
        d = np.minimum(np.abs(x - dr[j - 1]), np.abs(x - dr[j]))
        s[i] = np.mean(np.exp(-0.5 * (d / (tol / 2)) ** 2))
    return s


cases = []
for tempo in (1.0, 1.5):
    for ref_src, take_src, tag in ((T / "KeyStem.wav", T / "GtStem.wav", "gt_over_keys"),
                                   (T / "GtStem.wav", T / "KeyStem.wav", "keys_over_gt")):
        dur = 60 * tempo
        rp, tp = work / f"{tag}_t{tempo}_ref.wav", work / f"{tag}_t{tempo}_stem.wav"
        if not rp.exists():
            ff(ref_src, rp, OFF, dur, tempo)
            ff(take_src, tp, OFF, dur, tempo)
        cases.append((tag, tempo, rp, tp))

rows = []
for tag, tempo, rp, tp in cases:
    ref = bg.load(str(rp))
    rb, rd = bg.beat_grid(ref)
    stem = bg.load(str(tp))
    for lag in (0, 130, 287):
        take = delay(stem, lag)
        tb, td = bg.beat_grid(take)
        on, w = bg.onsets(take)
        # today: blind ±400 ms
        lags, sc = bg.score_lags(rb, on, w, -0.4, 0.4)
        grid = bg.candidates(lags, sc)
        # downbeats: wide search (±1.2 s), then refine on attacks within ±0.15 s
        L = np.arange(-1.2, 1.2001, 0.005)
        ds = db_score(td, rd, L)
        k = int(np.argmax(ds))
        cands = bg.candidates(L, ds, n=2, apart=0.25)
        coarse = cands[0][0]
        l2, s2 = bg.score_lags(rb, on, w, coarse - 0.15, coarse + 0.15)
        fine = bg.candidates(l2, s2)[0][0]
        rows.append(dict(case=f"{tag} x{tempo} lag{lag}", truth=lag,
                         bpm_ref=round(60 / np.median(np.diff(rb)), 1), bpm_take=round(60 / np.median(np.diff(tb)), 1),
                         n_down=(len(rd), len(td)),
                         grid=round(grid[0][0] * 1000), grid_alias=round(grid[1][1], 2) if len(grid) > 1 else None,
                         db_coarse=round(coarse * 1000), db_alias=round(cands[1][1], 2) if len(cands) > 1 else None,
                         db_fine=round(fine * 1000)))
        r = rows[-1]
        print(f"{r['case']:<26} bpm ref/take {r['bpm_ref']:>5}/{r['bpm_take']:<5} downs {r['n_down']}  "
              f"grid {r['grid'] - lag:+5} (alias {r['grid_alias']})  "
              f"downbeat coarse {r['db_coarse'] - lag:+5} (alias {r['db_alias']}) fine {r['db_fine'] - lag:+5}", flush=True)
json.dump(rows, open(work / "results.json", "w"), indent=1)
