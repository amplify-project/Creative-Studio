#!/usr/bin/env python3
"""Synthetic sync-round takes, for exercising `app/api/play2gether/syncDetect.ts`.

Each case is a WAV of a player hitting quarter notes against the sync round's
click, with a KNOWN lag — so the detector can be scored rather than eyeballed.
The adversarial cases are the point; every one of them is a failure the detector
actually had at some stage of being written:

  E  a lag near half a beat        — used to come back a full beat out (−49 for 450)
  F  metronome bleeding into the mic on speakers
                                   — used to win the vote and report the player's
                                     output latency alone (41 for 220)
  K  a lag past the search ceiling — used to be reported as "play on every click"
  M  a take with nothing in it     — used to return a confident 182 ms
  N  a tempo too fast to be unambiguous

Usage:
    python3 scripts/p2g_sync_fixtures.py <outdir>
    npx tsc app/api/play2gether/syncDetect.ts app/api/play2gether/utils.ts \
        app/lib/p2gSync.ts --outDir <build> --module nodenext --target es2022 \
        --moduleResolution nodenext --skipLibCheck --rootDir .
    # then call detectSyncOffset() over <outdir>/manifest.json

Requires numpy. Writes 48 kHz mono 16-bit WAVs, the format a take arrives in.
"""
import numpy as np, wave, sys, os, json
SR = 48000
# Must track app/lib/p2gSync.ts. TOTAL_BEATS counts the CLICKS, count-in
# included; the player is expected to enter on FIRST_PLAYED_BEAT and nothing at
# all should be on the beats before it.
TOTAL_BEATS, FIRST_PLAYED_BEAT, TAIL_MS = 20, 4, 800

def hit_percussive(n, sr=SR):
    t = np.arange(n)/sr
    return (np.random.RandomState(0).randn(n) * np.exp(-t*90)).astype(np.float32)

def hit_slow(n, sr=SR):
    """Bass-like: slow attack (~25 ms), long decay."""
    t = np.arange(n)/sr
    env = (1-np.exp(-t/0.025)) * np.exp(-t/0.25)
    return (np.sin(2*np.pi*110*t) * env).astype(np.float32)

# Every case gets human jitter by default. A synthetic take with zero scatter is
# not a player, it is a machine — and the detector now refuses those on purpose
# (see SPREAD_FLOOR_MS), so a fixture without jitter tests nothing but the guard.
# 12 ms is the steadiest hand clapping measured in the field, i.e. a good case.
M32 = 0xFFFFFFFF


def sync_jitter_ms(grid_seed, beat, amp):
    """Byte-for-byte the same sequence as `syncJitterMs` in app/lib/p2gSync.ts.

    Reimplemented rather than imported because the fixtures are the only thing
    that can catch the two drifting apart — and if they ever do, every offset is
    silently wrong by the difference between two random sequences, which is the
    single worst failure this feature can have.
    """
    if not amp or not grid_seed:
        return 0.0
    h = (int(grid_seed) ^ (((beat + 1) * 0x9E3779B1) & M32)) & M32
    h ^= (h << 13) & M32
    h ^= h >> 17
    h ^= (h << 5) & M32
    h &= M32
    return ((h / M32) * 2 - 1) * amp


def build(path, bpm, lag_ms, jitter_ms=12.0, kind="perc", click_bleed_ms=None,
          click_level=0.05, level=0.6, seed=1, drop=(), grid_seed=0, grid_jitter=0.0,
          entry_offset=0):
    rs = np.random.RandomState(seed)
    beat = 60000.0/bpm
    dur_ms = TOTAL_BEATS*beat + TAIL_MS
    n = int(SR*dur_ms/1000)
    x = rs.randn(n).astype(np.float32) * 0.0015          # room noise, ~-56 dB
    hitlen = int(SR*0.30)
    h = hit_percussive(hitlen) if kind == "perc" else hit_slow(hitlen)
    h = h/np.max(np.abs(h))*level
    truth = []
    # `entry_offset` shifts the WHOLE performance by a number of beats without
    # changing anything else, which is how a player who misreads the count-in
    # sounds: every note is still exactly on a click, just the wrong one. That
    # is the case the count-in was built to remove and the one the detector has
    # to name rather than merely refuse.
    for k in range(FIRST_PLAYED_BEAT + entry_offset, TOTAL_BEATS + entry_offset):
        if k in drop: continue
        j = rs.randn()*jitter_ms if jitter_ms else 0.0
        # The player plays ON the click, wherever the click actually is.
        t_ms = k*beat + sync_jitter_ms(grid_seed, k, grid_jitter) + lag_ms + j
        s = int(SR*t_ms/1000)
        if s < 0 or s+hitlen > n: continue
        x[s:s+hitlen] += h
        truth.append(t_ms)
    if click_bleed_ms is not None:
        # On every click the metronome sounds, count-in included. Those first
        # four are the only thing in the take with no player on top of them, so
        # a detector that looked there would measure the metronome and nothing
        # else — which is exactly why `expectedAll` starts at FIRST_PLAYED_BEAT.
        for k in range(TOTAL_BEATS):
            cs = int(SR*(k*beat + click_bleed_ms)/1000)
            cl = int(SR*0.045)
            if cs >= 0 and cs+cl <= n:
                tt = np.arange(cl)/SR
                click = np.sign(np.sin(2*np.pi*1000*tt))*np.exp(-tt*70)*click_level
                x[cs:cs+cl] += click.astype(np.float32)
    x = np.clip(x, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x*32767).astype("<i2").tobytes())
    return truth

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
B = 80  # SYNC_BPM
cases = [
    ("A_clean_lag120",          dict(bpm=B, lag_ms=120)),
    ("B_lag300",                dict(bpm=B, lag_ms=300)),
    ("C_jittery_lag150",        dict(bpm=B, lag_ms=150, jitter_ms=28)),
    ("D_slowattack_lag100",     dict(bpm=B, lag_ms=100, kind="slow")),
    ("E_lag450_was_aliasing",   dict(bpm=B, lag_ms=450)),
    ("F_clickbleed_lag220",     dict(bpm=B, lag_ms=220, click_bleed_ms=40, click_level=0.06)),
    ("G_early_lagm40",          dict(bpm=B, lag_ms=-40)),
    ("H_quiet_lag160",          dict(bpm=B, lag_ms=160, level=0.06)),
    ("I_bt_lag330",             dict(bpm=B, lag_ms=330)),
    ("J_missed_beats_lag140",   dict(bpm=B, lag_ms=140, drop=[2,5,9,13])),
    ("K_beyond_ceiling_lag600", dict(bpm=B, lag_ms=600)),
    ("L_very_loose_lag200",     dict(bpm=B, lag_ms=200, jitter_ms=60, seed=7)),
    ("M_silence",               dict(bpm=B, lag_ms=120, level=0.0)),
    ("N_fast_bpm140_ALIASRISK", dict(bpm=140, lag_ms=300)),
    # O/P are the speaker-monitoring pair. O is the real field case: a laptop's
    # built-in mic sits centimetres from its own speaker, so the click comes
    # back as loud as the player and lands at the full acoustic round trip.
    # Energy weighting cannot save this one — only the ±0 scatter can.
    ("O_loudbleed_REFUSE",      dict(bpm=B, lag_ms=110, jitter_ms=20,
                                     click_bleed_ms=177, click_level=0.5, seed=3)),
    ("P_faintbleed_lag110",     dict(bpm=B, lag_ms=110, jitter_ms=20,
                                     click_bleed_ms=40, click_level=0.05, seed=3)),
    # Q is the 2026-09-01 field failure, and the reason the search window learned
    # to slide. A lag of 950 ms is past any fixed ceiling, but its alias
    # 950 − 750 = 200 lands INSIDE the old -80…520 window, matches fifteen of
    # sixteen beats, and carries the player's real scatter — so it came back as a
    # confident "200 ms" with nothing to mark it as wrong. Scored with no device
    # figure it must still fail (there is no information to fix it with); scored
    # with one it must come back at ~950.
    ("Q_alias_lag950_NEEDS_DEVICE", dict(bpm=B, lag_ms=950)),
    # R/S are the randomised click. R is the ordinary case; S is the one that
    # matters — a lag in the band where a PLAIN grid aliases (670–1270 ms), which
    # an irregular grid should resolve on its own, with no device figure to lean
    # on, because a jittered pattern and that pattern shifted by a beat no longer
    # explain the same onsets.
    ("R_jitter_lag120",         dict(bpm=B, lag_ms=120, grid_seed=0x5EED1234, grid_jitter=45.0)),
    ("S_jitter_lag950_NO_ALIAS", dict(bpm=B, lag_ms=950, grid_seed=0x5EED1234, grid_jitter=45.0)),

    # The count-in cases (2026-09-03). Both are a player who is playing
    # perfectly, on the click, at a normal latency — and on the wrong click.
    # Before the count-in existed the first of these WAS the default behaviour:
    # the round asked people to play from the very first tick, so anyone who
    # listened for the pulse first landed here. Both must refuse and both must
    # say which way they went, because "your notes are one bar late" is
    # something a player can act on and "outside the range searched" is not.
    ("T_entered_2_beats_LATE",  dict(bpm=B, lag_ms=120, entry_offset=2)),
    ("U_entered_a_bar_EARLY",   dict(bpm=B, lag_ms=120, entry_offset=-4)),
]
manifest = []
for name, kw in cases:
    p = os.path.join(out, name + ".wav")
    build(p, **kw)
    # `device` is what that player's browser would report for its own round trip:
    # the true lag less a plausible feel term. Deliberately NOT the true lag —
    # the window has to survive the estimate being wrong, which it always is.
    manifest.append({"name": name, "path": p, "bpm": kw["bpm"], "trueLag": kw["lag_ms"],
                     "jitter": kw.get("jitter_ms", 0),
                     "gridSeed": kw.get("grid_seed", 0),
                     "gridJitter": kw.get("grid_jitter", 0.0),
                     "device": max(0, kw["lag_ms"] - 50)})
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
print(f"{len(manifest)} cases written")
