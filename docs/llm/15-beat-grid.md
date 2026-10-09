# Pulse grid — placing a take on the reference's beats

`scripts/p2g_beat_grid.py`, `app/api/play2gether/beatgrid/route.ts`, and
`usePulseGrid` / `drawPulseGrid` / `PulseResult` in
`components/Play2GetherHostPanel.tsx`. Model: Beat This! small, in
`scripts/models/` (not in git — `scripts/fetch-models.sh`).

## The problem it answers

The mixer draws each take's envelope over the reference's. That works when the
take and the reference are the same kind of sound. A keyboard over a drum
backing, a fiddle over a guitar: the envelopes do not look alike even when the
playing is perfectly together, so the host has nothing to line up by eye.

What different instruments DO share is the pulse. So:

1. **Beats of the reference** — a neural beat tracker (Beat This!, JKU Linz,
   ISMIR 2024, MIT) finds them once per reference. Drawn as yellow lines on
   every strip (stronger on downbeats). This is the visual aid on its own.
2. **Attacks of the take** — spectral flux, numpy only, no model.
3. **The shift** — every shift in a window is scored by how much attack
   strength lands within ~15 ms of a beat. The best one is the suggested slider
   value (`lag + captureDelayMs`, the same convention as the DTW, doc 12).

Only the reference goes through the model: it is the ruler every take is
measured against, a single part often has no clear pulse of its own (a held
chord), and it makes the per-take cost negligible.

## What it measured, 2026-10-08

| Material | Result |
|---|---|
| Synthetic clicks, +120 ms | +120 (the unit test) |
| Jazz trio DAW stems, 5 min, leave-one-out (reference = the other two), 0/131/287 ms, **blind ±400 ms** | 9/9 right. Error constant per instrument: +17 guitar, −15 keys, −16 drums — where each player sits on the beat, not noise |
| **In the app**: DrStem reference, KeyStem sent as a test track (+120, PR #9 test mode), 50-s round with 17 s of silence | **+117**. The DTW on the same take: −75 ±168 |
| July session, 30-s takes, reference at 181 BPM, dense playing | **Ambiguous** (runner-up 0.93–1.00) — and says so |

Compare doc 12: the DTW wanders on long cross-instrument takes and over
silence. The two methods fail differently, which is why the row shows both and
marks when they agree within 35 ms.

## How it fails, and how that is shown

**Pulse vs off-beat on fast, dense material.** At 181 BPM with eighth-note
playing, shifting by half a beat lands about as many attacks on the grid. The
score curve has several near-equal peaks. `aliasRatio` is runner-up ÷ best;
`clear` is `aliasRatio < 0.9` (calibrated on the material above: right answers
0.53–0.92, the 181 BPM session 0.93–1.00). Unclear → amber, flagged
"ambiguous", and the runner-up shifts are offered as one-click alternatives —
one of them is right and the ear decides which.

**Centring removes most of it.** With a calibration or sync figure, the search
is ±0.45 beat around it (never used as a value — the discipline of docs 11/12),
so the lag and the lag one beat over cannot both fit. Blind it searches ±400 ms,
which at fast tempos holds more than one beat.

**Without a calibration, the take's own DTW is the centre** (`centredOn:
"dtw"`; only a DTW of the same take file with MAD ≤ 80 ms). The DTW finds the
beat, the pulse places the take on it. The client therefore runs `align` BEFORE
`beatgrid`, not in parallel. Measured 2026-10-09 on the martain reference (12 s,
swung, the tracker's grid at "223 BPM" with only 42 % regular gaps), take 2
shifted by a known 0/50/120/200 ms: blind, +120 and +200 wrapped a beat out to
−386/−390; centred on the DTW (−35/17/87/162), the pulse gave −31/20/90/167
against −31/19/89/169 wanted, all `clear` (runner-up 0.64–0.69). Being near the
DTW is then expected, not a second opinion, so the row says "refines DTW"
instead of "agrees with DTW": a DTW a beat out drags the pulse with it.
`--expect` is "given or not", not "> 0" — a DTW figure can be negative.

**No pulse** (free intro, rubato, a 6-s phrase): fewer than 8 beats → refused.
`regularPct` (share of beat gaps within 15 % of the median) is shown in the
status line; under 60 % says "irregular tempo, trust it less".

**Feel.** It aligns attacks to beats, so it also absorbs where a player sits on
the beat (the ±15 ms above). Calibration removes only the technical delay. At
this size it is inaudible; it is why the result is a suggestion.

## Runtime and cost

- Production image is `node:24.12-alpine`; pip has no musl onnxruntime, so the
  Dockerfile adds Alpine's `py3-onnxruntime` (+130 MB). Same subprocess pattern
  as the DTW (`python3` off PATH, one JSON line on stdout).
- Reference: 26 s of one core per 5 min on that image (11 s on a glibc
  laptop). Once per reference file, cached as `<referenceFile>.beats.json`
  (keyed on size + mtime + `CACHE_VERSION`). GET answers `computing` until it
  exists; one run per file process-wide (`inFlight`).
- Per take: ~0.3 s.
- Memory: ~370 MB peak. Attention is quadratic in the chunk — 1500 frames
  (training length) is ~1 GB for the same beats, hence `CHUNK = 500`.
- `os.nice(10)` and single-threaded BLAS: it shares the box with a live room.

## Traps (each cost real time)

1. **ONNX export:** the legacy exporter gave wrong logits silently. Use
   `dynamo=True`; `scripts/export-beat-this-onnx.py` checks parity.
2. **BLAS threads:** numpy started one busy thread per core — 35 s of CPU for
   10 s of wall. The thread env vars are set before `import numpy`.
3. **Front end must match training:** channel *mean* (ffmpeg's `-ac 1` is
   −3 dB per channel), magnitude / sqrt(n_fft), slaney mel without norm,
   log1p(1000·x). The mel bank is computed in numpy (checked to 1.3e-5).
4. **Flux timing (`FLUX_LEAD`).** The flux peaks ~20 ms before an attack.
   Reference beats are snapped to the reference's flux and take attacks come
   from the take's flux; when the shift was not applied to both, the snap
   missed the peak and every answer carried −15 ms. The click test guards it.

## Validating changes

Use the test track mode (`?p2gtest`, PR #9): send a stem as a take with a known
latency over a reference cut from the same session, and the mixer badge shows
the right answer next to this one. Keep the jazz leave-one-out numbers above as
the regression: 9/9, constant per-instrument error.
