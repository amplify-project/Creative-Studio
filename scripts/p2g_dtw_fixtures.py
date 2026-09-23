#!/usr/bin/env python3
"""
Synthetic fixtures for `p2g_dtw_align.py` — takes with a KNOWN lag, played on a
different instrument from the reference.

The sibling of `p2g_sync_fixtures.py`, and built for the same reason: the only
way to know whether an alignment measurement is right is to build material whose
answer you already know. Every adversarial case here is a failure this method
can actually have, and three of them are failures it DOES have.

    python3 scripts/p2g_dtw_fixtures.py /tmp/dtwfix           # generate
    python3 scripts/p2g_dtw_fixtures.py /tmp/dtwfix --score   # generate + score

The reference is always a backing track — pad chords, kick, hat, bass. A take is
always ONE other instrument playing along to it, which is what a P2G mic
actually records. They share musical structure and share almost no spectrum,
which is the whole question doc 12 leaves open.

Scored twice per case, blind and centred, because those are the two ways the
product calls it: blind is a host with no calibration figure (band +-0.5 s,
`--expect 0`), centred is one with (band +-0.25 s around the true device
number). The two columns ARE the test — see the aliasing cases.
"""

import argparse, json, subprocess, sys, wave
from pathlib import Path
import numpy as np

SR = 48000
BPM = 100.0
BEAT = 60.0 / BPM              # 0.6 s
BAR = 4 * BEAT                 # 2.4 s
BARS = 8
DUR = BARS * BAR               # 19.2 s

# I-vi-IV-V in C, one bar each, repeating every four bars. Chosen so the
# harmony changes every bar: a progression that repeated every BAR would make
# the reference periodic at 2.4 s and every alias would be inside any sane
# band, which is the failure case below rather than the normal one.
PROG = [(60, 64, 67), (57, 60, 64), (53, 57, 60), (55, 59, 62)]


def hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _env(n, attack_ms, decay_ms, sustain=0.0):
    a = max(1, int(attack_ms * SR / 1000))
    d = max(1, int(decay_ms * SR / 1000))
    e = np.zeros(n, np.float32)
    a = min(a, n)
    e[:a] = np.linspace(0, 1, a)
    rest = n - a
    if rest > 0:
        tail = np.exp(-np.arange(rest) / d).astype(np.float32)
        e[a:] = sustain + (1 - sustain) * tail
    return e


def tone(y, t, midi, dur, amp, attack_ms, decay_ms, harmonics=3, vibrato=0.0):
    i = int(t * SR)
    n = min(int(dur * SR), len(y) - i)
    if n <= 0:
        return
    tt = np.arange(n) / SR
    f = hz(midi)
    if vibrato:
        f = f * (1.0 + vibrato * np.sin(2 * np.pi * 5.0 * tt))
    sig = np.zeros(n, np.float32)
    for h in range(1, harmonics + 1):
        sig += (1.0 / h) * np.sin(2 * np.pi * f * h * tt).astype(np.float32)
    y[i:i + n] += amp * sig * _env(n, attack_ms, decay_ms)


def noise_hit(y, t, dur, amp, lowpass=None, highpass=None, decay_ms=40):
    i = int(t * SR)
    n = min(int(dur * SR), len(y) - i)
    if n <= 0:
        return
    rng = np.random.default_rng(int(t * 1000) & 0xFFFF)
    s = rng.standard_normal(n).astype(np.float32)
    # one-pole filters, enough to tell a kick from a hat
    if lowpass:
        a = np.exp(-2 * np.pi * lowpass / SR)
        out = np.zeros(n, np.float32); acc = 0.0
        for k in range(n):
            acc = a * acc + (1 - a) * s[k]; out[k] = acc
        s = out
    if highpass:
        a = np.exp(-2 * np.pi * highpass / SR)
        out = np.zeros(n, np.float32); acc = 0.0; prev = 0.0
        for k in range(n):
            acc = a * (acc + s[k] - prev); prev = s[k]; out[k] = acc
        s = out
    y[i:i + n] += amp * s * _env(n, 1, decay_ms)


# ── The backing track every take is recorded over ────────────────────────────

def make_reference():
    y = np.zeros(int(DUR * SR) + SR, np.float32)
    for b in range(BARS):
        t0 = b * BAR
        chord = PROG[b % len(PROG)]
        for m in chord:                              # pad
            tone(y, t0, m, BAR, 0.10, 120, 900, harmonics=4)
        tone(y, t0, chord[0] - 24, BAR * 0.9, 0.22, 5, 250, harmonics=2)   # bass
        for beat in range(4):
            t = t0 + beat * BEAT
            if beat in (0, 2):
                noise_hit(y, t, 0.18, 0.35, lowpass=110, decay_ms=25)      # kick
            noise_hit(y, t + BEAT / 2, 0.05, 0.06, highpass=6000, decay_ms=8)  # hat
    return y[:int(DUR * SR)]


# ── The instruments a participant might be playing ───────────────────────────

def melody_notes(jitter_ms=0.0, seed=0):
    """Eighth notes from the chord tones — the skeleton every pitched take uses."""
    rng = np.random.default_rng(seed)
    out = []
    for b in range(BARS):
        chord = PROG[b % len(PROG)]
        for e in range(8):
            t = b * BAR + e * (BEAT / 2)
            m = chord[e % 3] + (12 if e % 4 == 3 else 0)
            j = rng.normal(0, jitter_ms / 1000.0) if jitter_ms else 0.0
            out.append((t + j, m))
    return out


def take_pluck(jitter_ms=0.0):
    """Sharp attack, short decay — a muted string. Shares rhythm AND harmony."""
    y = np.zeros(int(DUR * SR) + SR, np.float32)
    for t, m in melody_notes(jitter_ms, seed=1):
        tone(y, max(0.0, t), m + 12, BEAT / 2 * 0.9, 0.5, 2, 120, harmonics=5)
    return y[:int(DUR * SR)]


def take_pad():
    """Slow attack, legato, no transients at all. Shares HARMONY only — the case
    that should break an onset-based feature and not a chroma one."""
    y = np.zeros(int(DUR * SR) + SR, np.float32)
    for b in range(BARS):
        chord = PROG[b % len(PROG)]
        for m in chord:
            tone(y, b * BAR, m + 12, BAR * 1.05, 0.30, 700, 3000,
                 harmonics=6, vibrato=0.004)
    return y[:int(DUR * SR)]


def take_perc():
    """Unpitched noise bursts on a syncopated pattern. Shares RHYTHM only — the
    mirror case, which should break chroma and not onsets."""
    y = np.zeros(int(DUR * SR) + SR, np.float32)
    for b in range(BARS):
        for e in (0, 1.5, 2, 3.5):
            noise_hit(y, b * BAR + e * BEAT, 0.10, 0.55, highpass=1800, decay_ms=25)
    return y[:int(DUR * SR)]


def take_voice(jitter_ms=0.0):
    """Legato, pitched, soft attacks, vibrato. The hardest realistic case: some
    harmony, weak onsets."""
    y = np.zeros(int(DUR * SR) + SR, np.float32)
    for t, m in melody_notes(jitter_ms, seed=3):
        tone(y, max(0.0, t), m, BEAT / 2 * 1.4, 0.42, 90, 700,
             harmonics=7, vibrato=0.010)
    return y[:int(DUR * SR)]


# ── Turning an instrument into a take with a known lag ───────────────────────

def delay(y, lag_ms):
    """Shift the whole performance LATER by `lag_ms`, which is what a monitoring
    delay does to a take: the player hears the reference late and plays late."""
    n = int(round(lag_ms / 1000.0 * SR))
    if n <= 0:
        return y[-n:] if n < 0 else y
    return np.concatenate([np.zeros(n, np.float32), y])


def drift(y, start_ms, end_ms):
    """A player whose lag moves across the take — resampled position by
    position. This is the thing no round can measure and the drift curve exists
    for."""
    n = len(y)
    lag = np.linspace(start_ms, end_ms, n) / 1000.0 * SR
    src = np.clip(np.arange(n) - lag, 0, n - 1)
    return np.interp(src, np.arange(n), y).astype(np.float32)


def write_wav(path, y):
    y = np.clip(y / max(1e-9, np.abs(y).max()) * 0.85, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())


# ── The cases ────────────────────────────────────────────────────────────────

def build(outdir: Path):
    outdir.mkdir(parents=True, exist_ok=True)
    ref = make_reference()
    write_wav(outdir / "reference.wav", ref)

    cases = []

    def add(name, audio, truth_ms, note, expect_ms=None, feature=None):
        write_wav(outdir / f"{name}.wav", audio)
        cases.append({"name": name, "take": f"{name}.wav", "truthMs": truth_ms,
                      "note": note, "expectMs": truth_ms if expect_ms is None else expect_ms,
                      "feature": feature})

    # A — the control. Same instrument, so nothing about timbre is being asked.
    add("A_same_instrument_130", delay(ref.copy(), 130), 130,
        "control: the reference against itself, delayed")

    # B..E — one instrument against the backing, the actual question.
    add("B_pluck_130", delay(take_pluck(), 130), 130, "sharp attacks, shares rhythm + harmony")
    add("C_pad_130", delay(take_pad(), 130), 130, "NO transients, harmony only")
    add("D_perc_130", delay(take_perc(), 130), 130, "unpitched, rhythm only")
    add("E_voice_130", delay(take_voice(), 130), 130, "legato, soft attacks, vibrato")

    # F — the size of lag that made the 2026-08-31 session unmixable.
    add("F_pluck_bluetooth_380", delay(take_pluck(), 380), 380,
        "a Bluetooth monitor path, outside the blind band")

    # G — expressive timing. The case cross-correlation is supposed to lose.
    add("G_pluck_expressive_130", delay(take_pluck(jitter_ms=35), 130), 130,
        "+-35 ms of human timing on every note")
    add("H_voice_expressive_130", delay(take_voice(jitter_ms=45), 130), 130,
        "+-45 ms, legato: expressive AND weak onsets")

    # I — drift. There is no single right answer; the drift curve is the answer.
    add("I_pluck_drift_160_to_80", drift(take_pluck(), 160, 80), 120,
        "lag ramps 160 -> 80 ms; truth is the midpoint, watch driftRangeMs")

    # J — the take is longer than the reference, which is the normal case and
    # used to make the whole analysis refuse.
    j = delay(take_pluck(), 130)
    add("J_pluck_take_4s_longer", np.concatenate([j, np.zeros(4 * SR, np.float32)]), 130,
        "take runs 4 s past the reference")

    # K — reference bleeding into the mic, i.e. a player on speakers. The bleed
    # sits at their OUTPUT latency with no human term, and it is machine-perfect,
    # so it competes with the player. Doc 11's click-bleed trap, transposed.
    bleed = delay(take_pluck(), 130) [:len(ref)] * 1.0
    bleed = bleed + delay(ref.copy(), 60)[:len(bleed)] * 0.5
    add("K_pluck_130_with_reference_bleed", bleed, 130,
        "player at 130 ms, reference bleeding back at 60 ms, -6 dB")

    # L — silence. Must not return a confident number.
    add("L_silence", np.zeros(int(DUR * SR), np.float32), 130,
        "nothing was played; any confident answer is a bug")

    # M — periodic material, the aliasing case. One bar, repeated: every alias
    # 2.4 s apart is equally good, and a beat alias 0.6 s apart nearly so.
    onebar = take_pluck()[:int(BAR * SR)]
    looped = np.tile(onebar, BARS)
    add("M_looped_one_bar_130", delay(looped, 130), 130,
        "the same bar 8 times: aliases at every 0.6 s")

    (outdir / "manifest.json").write_text(json.dumps(
        {"sr": SR, "bpm": BPM, "durSec": DUR, "reference": "reference.wav",
         "cases": cases}, indent=2))
    return cases


# ── Scoring ──────────────────────────────────────────────────────────────────

def xcorr_lag(ref_path, take_path, band_ms=600):
    """Plain envelope cross-correlation, as a control.

    Doc 12 says out loud that the one pair tested did not show DTW beating this.
    Running it on every fixture is how that stops being a caveat and becomes a
    finding, in whichever direction the numbers go.
    """
    def env(p):
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "1",
                              "-ar", "22050", "-f", "f32le", "-"],
                             capture_output=True).stdout
        y = np.frombuffer(raw, np.float32)
        hop, nfft = 128, 1024
        n = 1 + (len(y) - nfft) // hop
        idx = np.arange(n) * hop
        fr = np.stack([y[i:i + nfft] for i in idx]) * np.hanning(nfft)
        S = np.log1p(1000 * np.abs(np.fft.rfft(fr, axis=1)))
        e = np.maximum(np.diff(S, axis=0), 0).sum(1)
        e = np.concatenate([[0.0], e])
        return (e - e.mean()) / (e.std() + 1e-9), hop / 22050 * 1000
    a, fm = env(ref_path)
    b, _ = env(take_path)
    c = np.correlate(a, b, mode="full")
    lags = np.arange(-len(b) + 1, len(a))
    keep = np.abs(lags * fm) <= band_ms
    c, lags = c[keep], lags[keep]
    i = int(np.argmax(c))
    return -lags[i] * fm      # sign: positive = take is late


def score(outdir: Path):
    man = json.loads((outdir / "manifest.json").read_text())
    ref = outdir / man["reference"]
    aligner = Path(__file__).with_name("p2g_dtw_align.py")

    def run(take, feature, expect, band):
        out = subprocess.run(
            [sys.executable, str(aligner), str(ref), str(take),
             "--feature", feature, "--expect", str(expect), "--band", str(band)],
            capture_output=True, text=True).stdout
        try:
            return json.loads(out)
        except Exception:
            return {"ok": False, "reason": "no output"}

    cols = [("melflux", 0, 0.5, "melflux blind"),
            ("chroma", 0, 0.5, "chroma blind"),
            ("melflux", None, 0.25, "melflux centred")]
    tally = {c[3]: [0, 0, 0, 0] for c in cols}          # good, fair, bad, refused
    tally["xcorr"] = [0, 0, 0, 0]
    # The property that decides whether this is safe to put in front of a host:
    # a wrong answer must not look confident. Tracked, not eyeballed.
    worst_confident = ("", 0.0, 0.0)                     # case, |err|, mad
    quietest_wrong = ("", 1e9, 0.0)

    print(f"{'case':<34} {'truth':>6} │ {'melflux blind':>19} {'chroma blind':>19} │ "
          f"{'melflux centred':>17} │ {'xcorr':>9}")
    print("─" * 128)
    for c in man["cases"]:
        take = outdir / c["take"]
        truth = c["truthMs"]
        cells = []
        for i, (feat, expect, band, label) in enumerate(cols):
            r = run(take, feat, c["expectMs"] if expect is None else expect, band)
            w = 19 if i < 2 else 17
            if not r.get("ok"):
                tally[label][3] += 1
                cells.append("REFUSED".rjust(w))
                continue
            err = r["lagMs"] - truth
            mad = r["madMs"]
            flag = "✓" if abs(err) <= 25 else ("~" if abs(err) <= 60 else "✗")
            tally[label][0 if flag == "✓" else 1 if flag == "~" else 2] += 1
            if label == "melflux centred":
                if mad <= 40 and abs(err) > worst_confident[1]:
                    worst_confident = (c["name"], abs(err), mad)
                if abs(err) > 60 and mad < quietest_wrong[1]:
                    quietest_wrong = (c["name"], mad, abs(err))
            cells.append(f"{flag} {r['lagMs']:>+7.1f} ±{mad:>5.1f}".rjust(w))
        try:
            xc = xcorr_lag(ref, take)
            xerr = abs(xc - truth)
            xflag = "✓" if xerr <= 25 else ("~" if xerr <= 60 else "✗")
            tally["xcorr"][0 if xflag == "✓" else 1 if xflag == "~" else 2] += 1
            xcell = f"{xflag}{xc:>+8.1f}"
        except Exception:
            xcell = "     err"
        print(f"{c['name']:<34} {truth:>+6.0f} │ {cells[0]} {cells[1]} │ {cells[2]} │ {xcell}")

    print("\n✓ within 25 ms of truth   ~ within 60 ms   ✗ worse")
    print("blind = no calibration figure (band ±0.5 s); centred = band ±0.25 s on the true device lag\n")
    for label, (g, f, b, r) in tally.items():
        print(f"  {label:<16} {g:>2} good  {f:>2} fair  {b:>2} bad  {r:>2} refused")

    print("\nDoes a wrong answer ever look confident? (melflux centred, the product's own setting)")
    print(f"  worst error among results with MAD <= 40 ms : {worst_confident[1]:.1f} ms "
          f"({worst_confident[0]}, MAD {worst_confident[2]:.1f})")
    if quietest_wrong[0]:
        print(f"  lowest MAD among results wrong by > 60 ms  : {quietest_wrong[1]:.1f} ms "
              f"({quietest_wrong[0]}, error {quietest_wrong[2]:.1f} ms)")
    else:
        print("  lowest MAD among results wrong by > 60 ms  : none — every bad answer was flagged")
    print("\nIf the first number ever climbs past the second, the UI's soft/hard threshold")
    print("stops separating good answers from bad ones and has to move.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--score", action="store_true")
    args = ap.parse_args()
    cases = build(args.outdir)
    print(f"wrote {len(cases)} cases + reference to {args.outdir}\n")
    if args.score:
        score(args.outdir)


if __name__ == "__main__":
    main()
