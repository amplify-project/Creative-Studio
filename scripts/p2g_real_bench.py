#!/usr/bin/env python3
"""
Real-material benchmark for the take aligners — the thing doc 12 says is missing.

`p2g_dtw_fixtures.py` builds synthetic instruments whose answer is known. This
builds the same kind of case from REAL singers whose answer is also known:
Dagstuhl ChoirSet (Rosenzweig et al., TISMIR 2020, CC-BY 4.0) recorded each
singer of a vocal quartet on their own close microphones, simultaneously. So:

    take       = one singer, on their larynx mic (LRX: contact, almost no bleed
                 and no acoustic delay — the "on headphones" case)
    reference  = the other three singers summed, also LRX
    truth      = the lag we add to the take. The recording was simultaneous, so
                 before the shift the two are in sync to well under a frame.

That is leave-one-out, the same shape as the jazz-stem check in doc 15, on the
material P2G is built for (choral) and on the case doc 12 calls its worst
(voice: legato, soft attacks, vibrato).

A second variant adds the REFERENCE back into the take at a different lag and
−12 dB — fixture K on real voices: the player is late by `truth`, the bleed by
the device round trip only.

    # once: fetch the quartet LRX tracks (see --help for the expected layout)
    python3 scripts/p2g_real_bench.py build ../datasets/dcs/DagstuhlChoirSet /tmp/p2gbench
    python3 scripts/p2g_real_bench.py score /tmp/p2gbench            # all methods
    python3 scripts/p2g_real_bench.py score /tmp/p2gbench --only beat

Scoring follows `p2g_dtw_fixtures.py`: ✓ within 25 ms, ~ within 60, ✗ worse.
Results are also written to <outdir>/results.json for later analysis.
"""

import argparse, json, os, re, subprocess, sys, wave
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

SR = 22050                 # the dataset's own rate; both aligners resample anyway
TRUTH_MS = 130.0           # the player's lag — the field pair's number (doc 12)
CALIB_ERR_MS = 25.0        # a calibration figure is never exact; centre off by this
# Where the bleed lands relative to the player. NOT a fixed 60 ms: a player in
# time with what they hear lands at the device round trip, which is exactly
# where the bleed lands; what separates them is the player's feel. The first
# version of this bench put the bleed 70 ms from the player and so validated a
# rule ("refuse answers near the bleed") that refused right answers on the
# first real session (2026-10-13 keys, headphone leak at 128–133 ms, player at
# ~125). Per case, one of these, cycling: bleed lag = truth − feel.
BLEED_FEEL_MS = (-25.0, -10.0, 10.0, 25.0)
BLEED_DB = -12.0           # reference bleed relative to the take's RMS
EXCERPT_SEC = 40.0         # a typical P2G round
EXCERPT_STARTS = (20.0, 80.0)    # quartet takes are ~145 s

SCRIPTS = Path(__file__).resolve().parent


# ── Build ────────────────────────────────────────────────────────────────────

def read_wav(path):
    # The dataset's WAVs are float32 (format 3), which the wave module refuses.
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def write_wav(path, y):
    peak = float(np.max(np.abs(y))) or 1.0
    y = np.clip(y / max(peak, 1.0) * 0.98 if peak > 1 else y, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())


def shift(y, ms):
    n = int(round(ms * SR / 1000))
    return np.concatenate([np.zeros(n, np.float32), y])[:len(y)] if n > 0 else y


def rms(y):
    return float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) + 1e-12


def build(dcs: Path, out: Path):
    audio = dcs / "audio_wav_22050_mono"
    groups = defaultdict(dict)                         # song_take -> part -> path
    for p in sorted(audio.glob("DCS_*_Quartet*_Take*_*_LRX.wav")):
        m = re.match(r"DCS_(\w+_Quartet[AB]_Take\d+)_([SATB]\d)_LRX\.wav", p.name)
        if m:
            groups[m[1]][m[2]] = p
    out.mkdir(parents=True, exist_ok=True)
    cases = []
    for song, parts in sorted(groups.items()):
        if len(parts) < 4:
            print(f"skip {song}: {len(parts)} parts on disk", file=sys.stderr)
            continue
        sig = {k: read_wav(v) for k, v in parts.items()}
        n = min(len(v) for v in sig.values())
        sig = {k: v[:n] for k, v in sig.items()}
        spans = [("full", 0, n)] + [
            (f"x{int(s)}", int(s * SR), int((s + EXCERPT_SEC) * SR))
            for s in EXCERPT_STARTS if (s + EXCERPT_SEC) * SR <= n]
        for part in sorted(sig):
            ref_full = sum(v for k, v in sig.items() if k != part)
            for span, a, b in spans:
                ref = ref_full[a:b]
                ref_name = f"{song}_{part}_{span}_ref.wav"
                write_wav(out / ref_name, ref)
                voice = shift(sig[part][a:b], TRUTH_MS)
                bleed_lag = TRUTH_MS - BLEED_FEEL_MS[len(cases) // 2 % len(BLEED_FEEL_MS)]
                for variant in ("clean", "bleed"):
                    take = voice
                    if variant == "bleed":
                        g = rms(voice) / rms(ref) * 10 ** (BLEED_DB / 20)
                        take = voice + g * shift(ref, bleed_lag)
                    name = f"{song}_{part}_{span}_{variant}"
                    write_wav(out / f"{name}.wav", take)
                    cases.append({"name": name, "song": song, "part": part, "span": span,
                                  "variant": variant, "reference": ref_name,
                                  "take": f"{name}.wav", "truthMs": TRUTH_MS,
                                  "expectMs": TRUTH_MS + CALIB_ERR_MS,
                                  "bleedLagMs": bleed_lag if variant == "bleed" else None,
                                  "secs": round((b - a) / SR, 1)})
        print(f"{song}: {len(sig)} parts, {len(spans)} spans", flush=True)
    (out / "manifest.json").write_text(json.dumps({"cases": cases}, indent=1))
    print(f"{len(cases)} cases in {out}")


# ── Score ────────────────────────────────────────────────────────────────────

# (label, family, argv builder). Centred = the calibration figure is known
# (off by CALIB_ERR_MS); blind = it is not. Same two settings as the fixtures.
def methods(out: Path):
    # The single-run aligner as it was before 2026-10-13, so these columns keep
    # meaning what they meant; "product" is the aligner's own default pipeline.
    dtw = [sys.executable, str(SCRIPTS / "p2g_dtw_align.py"), "--no-echo", "--no-debleed"]
    prod = [sys.executable, str(SCRIPTS / "p2g_dtw_align.py")]
    beat = [sys.executable, str(SCRIPTS / "p2g_beat_grid.py"), "align"]
    cache = lambda c: ["--cache", str(out / (c["reference"] + ".beats.json"))]
    return [
        ("melflux blind",   "dtw",  lambda c: dtw + [c["R"], c["T"], "--feature", "melflux", "--expect", "0", "--band", "0.5"]),
        ("melflux centred", "dtw",  lambda c: dtw + [c["R"], c["T"], "--feature", "melflux", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("chroma centred",  "dtw",  lambda c: dtw + [c["R"], c["T"], "--feature", "chroma", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("beat blind",      "beat", lambda c: beat + [c["R"], c["T"]] + cache(c)),
        ("beat centred",    "beat", lambda c: beat + [c["R"], c["T"], "--expect", str(c["expectMs"])] + cache(c)),
        # The same, on the take after p2g_bleed.py has removed the reference
        # from it (or on the original, when it found none to remove).
        ("melflux c. -bleed", "dtw",  lambda c: dtw + [c["R"], c["TC"], "--feature", "melflux", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("chroma c. -bleed",  "dtw",  lambda c: dtw + [c["R"], c["TC"], "--feature", "chroma", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("melflux b. -bleed", "dtw",  lambda c: dtw + [c["R"], c["TC"], "--feature", "melflux", "--expect", "0", "--band", "0.5"]),
        ("melflux product",   "dtw",  lambda c: prod + [c["R"], c["T"], "--feature", "melflux", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("chroma product",    "dtw",  lambda c: prod + [c["R"], c["T"], "--feature", "chroma", "--expect", str(c["expectMs"]), "--band", "0.25"]),
        ("beat blind -bleed", "beat", lambda c: beat + [c["R"], c["TC"]] + cache(c)),
    ]


def run(argv):
    p = subprocess.run(argv, capture_output=True, text=True)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "reason": (p.stderr or "no output")[-200:]}


def flag(err):
    return "✓" if abs(err) <= 25 else "~" if abs(err) <= 60 else "✗"


def score(out: Path, only: str | None, jobs: int):
    cases = json.loads((out / "manifest.json").read_text())["cases"]
    for c in cases:
        c["R"], c["T"] = str(out / c["reference"]), str(out / c["take"])
        c["TC"] = c["T"]
    ms = [m for m in methods(out) if not only or only in m[0]]

    # Beat grids are cached per reference; compute each once, serially per
    # reference, before the per-take fan-out races on the same cache file.
    if any(f == "beat" for _, f, _ in ms):
        refs = sorted({c["R"] for c in cases})
        grid = lambda r: run([sys.executable, str(SCRIPTS / "p2g_beat_grid.py"), "grid", r,
                              "--cache", r + ".beats.json"])
        with ThreadPoolExecutor(jobs) as ex:
            list(ex.map(grid, refs))

    # Bleed pre-pass: detect, time and remove the reference from every take.
    # Its own score is whether it finds the bleed where it is (variant
    # "bleed", at the case's bleedLagMs) and stays quiet where there is none.
    if any("-bleed" in m[0] for m in ms) or only == "bleed":
        def debleed(c):
            clean = c["T"][:-4] + ".debleed.wav"
            r = run([sys.executable, str(SCRIPTS / "p2g_bleed.py"), c["R"], c["T"], "--out", clean])
            c["bleed"] = r
            c["TC"] = clean if r.get("ok") and r.get("present") else c["T"]
        with ThreadPoolExecutor(jobs) as ex:
            list(ex.map(debleed, cases))
        print("\nBleed detection (p2g_bleed.py)")
        for variant in ("clean", "bleed"):
            sel = [c for c in cases if c["variant"] == variant]
            det = [c for c in sel if c["bleed"].get("present")]
            right = [c for c in det if c.get("bleedLagMs") is not None
                     and abs(c["bleed"]["lagMs"] - c["bleedLagMs"]) <= 1.0]
            psr = sorted(c["bleed"].get("psr", 0) for c in sel)
            red = [c["bleed"].get("reductionDb", 0) for c in det]
            print(f"  {variant:<6} {len(det):>3}/{len(sel)} flagged present, {len(right)} at "
                  f"its bleed lag ±1 ms · PSR min/median/max "
                  f"{psr[0]:.1f}/{psr[len(psr)//2]:.1f}/{psr[-1]:.1f}"
                  + (f" · mean reduction {np.mean(red):.1f} dB" if red else ""))
            wrong = [c for c in det if c not in right]
            for c in wrong[:5]:
                print(f"         {c['name']}: lag {c['bleed']['lagMs']} psr {c['bleed']['psr']}")
        ms = [m for m in ms if only != "bleed"]
        if not ms:
            return

    jobs_list = [(c, label, fam, build_argv) for c in cases for label, fam, build_argv in ms]
    with ThreadPoolExecutor(jobs) as ex:
        res = list(ex.map(lambda j: run(j[3](j[0])), jobs_list))

    results = defaultdict(dict)
    for (c, label, fam, _), r in zip(jobs_list, res):
        results[c["name"]][label] = r
    (out / "results.json").write_text(json.dumps(results, indent=1))

    labels = [m[0] for m in ms]
    if not labels:
        return
    print(f"\n{'group':<22}" + "".join(f"{l:>22}" for l in labels))
    print("─" * (22 + 22 * len(labels)))
    for variant in ("clean", "bleed"):
        for span_kind in ("full", "x"):
            sel = [c for c in cases if c["variant"] == variant and c["span"].startswith(span_kind)]
            if not sel:
                continue
            row = f"{variant + ' / ' + ('full' if span_kind == 'full' else f'{EXCERPT_SEC:.0f}s'):<22}"
            for l in labels:
                g = f_ = b = rf = 0
                for c in sel:
                    r = results[c["name"]][l]
                    if not r.get("ok"):
                        rf += 1; continue
                    fl = flag(r["lagMs"] - c["truthMs"])
                    g += fl == "✓"; f_ += fl == "~"; b += fl == "✗"
                row += f"{f'{g}✓ {f_}~ {b}✗ {rf}R':>22}"
            print(row)

    print("\n✓ ≤25 ms  ~ ≤60 ms  ✗ worse  R refused.  "
          f"truth {TRUTH_MS:+.0f} ms; centred = expect off by {CALIB_ERR_MS:+.0f}; "
          f"bleed = reference at truth − feel {BLEED_FEEL_MS} ms, {BLEED_DB:.0f} dB")

    # Does a wrong answer look confident? Per family, with its own indicator.
    print("\nDoes a wrong answer look confident?")
    for l, fam, _ in ms:
        ok = [(c, results[c["name"]][l]) for c in cases if results[c["name"]][l].get("ok")]
        if fam == "dtw" and "product" in l:
            # The product's own indicator: verdict == "measured".
            conf = [abs(r["lagMs"] - c["truthMs"]) for c, r in ok if r.get("verdict") == "measured"]
            wrong = [r.get("verdict") for c, r in ok if abs(r["lagMs"] - c["truthMs"]) > 60]
            print(f"  {l:<16} worst error when 'measured': {max(conf, default=0):6.1f} ms "
                  f"({len(conf)} measured) · verdicts of >60 ms wrong: "
                  f"{dict((v, wrong.count(v)) for v in set(wrong))}")
        elif fam == "dtw":
            conf = [abs(r["lagMs"] - c["truthMs"]) for c, r in ok if r["madMs"] <= 40]
            wrong = [r["madMs"] for c, r in ok if abs(r["lagMs"] - c["truthMs"]) > 60]
            print(f"  {l:<16} worst error with MAD≤40: {max(conf, default=0):6.1f} ms "
                  f"({len(conf)} confident) · lowest MAD among >60 ms wrong: "
                  f"{min(wrong, default=float('nan')):5.1f} ({len(wrong)} wrong)")
        else:
            conf = [abs(r["lagMs"] - c["truthMs"]) for c, r in ok if r.get("clear")]
            wrong = [r["aliasRatio"] for c, r in ok if abs(r["lagMs"] - c["truthMs"]) > 60]
            print(f"  {l:<16} worst error when 'clear': {max(conf, default=0):6.1f} ms "
                  f"({len(conf)} clear) · lowest aliasRatio among >60 ms wrong: "
                  f"{min(wrong, default=float('nan')):4.2f} ({len(wrong)} wrong)")


ECHO_SHIFT_MS = 50.0       # centre the band this far either side of the truth
ECHO_MAX = 0.5             # |echo| above this: the answer follows the centre (see p2g_dtw_align.py)


def echo(out: Path, jobs: int):
    """Does the centred DTW MEASURE, or hand back the centre it was given?

    Found on the jazz keys/guitar pair (2026-10-13): moving --expect from −75 to
    +75 around the truth moved the answer 64 → 203 ms — it was echoing the
    calibration figure, and the MAD (±58–93) only half-said so. Scoring with the
    centre always +25 off the truth hides that: an echo lands 25 ms out, which
    is a ✓.

    So each case is run twice, centred at truth − S and truth + S:
        echo = (lag₊ − lag₋) / 2S        0 = measures, 1 = returns the centre
    and the answer is scored on BOTH sides. The same two runs are a check the
    product can make on a real take, where the truth is unknown: centre at
    calibration ± S, and refuse when the answer moves with it.
    """
    cases = json.loads((out / "manifest.json").read_text())["cases"]
    dtw = [sys.executable, str(SCRIPTS / "p2g_dtw_align.py"), "--no-echo", "--no-debleed"]
    S = ECHO_SHIFT_MS
    runs = []
    for c in cases:
        take = out / c["take"]
        deb = out / (c["take"][:-4] + ".debleed.wav")
        if c["variant"] == "bleed" and deb.exists():
            take = deb                 # measure the cleaned take; raw bleed is known-bad
        for feat in ("melflux", "chroma"):
            for side in (-1, 1):
                runs.append((c, feat, side, dtw + [str(out / c["reference"]), str(take), "--feature", feat,
                                                   "--expect", str(c["truthMs"] + side * S), "--band", "0.25"]))
    with ThreadPoolExecutor(jobs) as ex:
        res = list(ex.map(lambda r: run(r[3]), runs))
    by = defaultdict(dict)
    for (c, feat, side, _), r in zip(runs, res):
        by[(c["name"], feat)][side] = r
    (out / "echo.json").write_text(json.dumps({f"{k[0]}|{k[1]}": v for k, v in by.items()}, indent=1))

    print(f"\nEcho test — centred at truth ±{S:.0f} ms, band ±0.25 s"
          f"{' (bleed cases after p2g_bleed.py)' if any(c['variant'] == 'bleed' for c in cases) else ''}")
    for feat in ("melflux", "chroma"):
        rows = []
        for c in cases:
            a, b = by[(c["name"], feat)].get(-1, {}), by[(c["name"], feat)].get(1, {})
            if not (a.get("ok") and b.get("ok")):
                continue
            e = (b["lagMs"] - a["lagMs"]) / (2 * S)
            mid = (a["lagMs"] + b["lagMs"]) / 2
            errs = [a["lagMs"] - c["truthMs"], b["lagMs"] - c["truthMs"]]
            rows.append((c, e, mid - c["truthMs"], errs, max(a["madMs"], b["madMs"])))
        if not rows:
            continue
        ech = np.array([r[1] for r in rows])
        sides = [x for r in rows for x in r[3]]
        good = sum(abs(x) <= 25 for x in sides); fair = sum(25 < abs(x) <= 60 for x in sides)
        print(f"\n  {feat}: {len(rows)} cases · scored both sides: {good}✓ {fair}~ {len(sides) - good - fair}✗ "
              f"of {len(sides)} · echo median {np.median(ech):.2f}, "
              f"share >{ECHO_MAX}: {np.mean(np.abs(ech) > ECHO_MAX):.0%}")
        for grp in ("clean", "bleed"):
            sub = [r for r in rows if r[0]["variant"] == grp]
            if sub:
                e = np.array([r[1] for r in sub])
                print(f"     {grp:<6} echo median {np.median(e):.2f} · p90 {np.percentile(np.abs(e), 90):.2f}")
        # Two gates for "show this number as trustworthy": the MAD the UI uses
        # today, and the echo. What each lets through, and how wrong that is.
        for name, keep in (("MAD ≤ 40 (today)", lambda r: r[4] <= 40),
                           (f"|echo| ≤ {ECHO_MAX}", lambda r: abs(r[1]) <= ECHO_MAX),
                           ("both", lambda r: r[4] <= 40 and abs(r[1]) <= ECHO_MAX)):
            acc = [r for r in rows if keep(r)]
            worst = max((abs(x) for r in acc for x in r[3]), default=0.0)
            within = np.mean([abs(r[2]) <= 25 for r in acc]) if acc else float("nan")
            print(f"     gate {name:<18} passes {len(acc):>3}/{len(rows)} · worst error passed "
                  f"{worst:6.1f} ms · midpoint within 25 ms: {within:.0%}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="DagstuhlChoirSet dir (holding audio_wav_22050_mono/) -> outdir")
    b.add_argument("dcs", type=Path)
    b.add_argument("outdir", type=Path)
    s = sub.add_parser("score")
    s.add_argument("outdir", type=Path)
    s.add_argument("--only", help="substring of the method label, e.g. 'beat', 'melflux', '-bleed'; 'bleed' alone = detection only")
    s.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    e = sub.add_parser("echo", help="does the centred DTW measure, or return its centre?")
    e.add_argument("outdir", type=Path)
    e.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args()
    if a.cmd == "build":
        build(a.dcs, a.outdir)
    elif a.cmd == "echo":
        echo(a.outdir, a.jobs)
    else:
        score(a.outdir, a.only, a.jobs)


if __name__ == "__main__":
    main()
