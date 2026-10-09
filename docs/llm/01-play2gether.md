# Play2Gether — current technical reference

Synchronized choral recording. Host coordinates all participants to record
their voice locally over a shared reference track; server mixes after
upload. Aligned via a single broadcast timestamp (no NTP server, no
clock-drift handling needed within rounds).

> This doc reflects the current state including AudioWorklet capture,
> latency calibration, lyrics overlay, multi-takes, and the recent
> duration / countdown UX changes. The older [docs/play2gether.md](../play2gether.md) is
> Spanish and predates several of these features.

## User-visible flow

```
1. Open Session                       (single button, no config required)
2. Upload reference (audio file or live-capture from mic)
   Optional: upload .lrc lyrics
3. Optional rehearsal — play reference for everyone; participants tap ready
3b. Calibration round — 6 s warning ("hold one earcup against your mic"), then
    every device plays 5 clicks and finds them with its own mic. Measures each
    device's round trip through the headphones they play on; SEEDS THE MIXER.
    See docs/llm/10-calibration-detection.md.
3c. Optional sync round — click only, 1 bar count-in + 4 bars, one NOTE per
    click (not a clap), headphones on, everyone at once. The FALLBACK: seeds the
    mixer only for people 3b could not measure, since it reads 50-70 ms low. Its
    scatter is the only answer to "can this person hold a beat".
    See docs/llm/11-sync-rounds.md.
4. Launch:
   - Pick target: Everyone | Me | <participant>
   - Tweak countdown / duration if needed (per-round controls)
   - Start countdown → clap fires → recording → upload
5. Mixer: per-track gain, sync offset, delete bad takes
   Per take, on demand: "align against the reference" (DTW) — the only
   measurement taken on the take itself, and the only one that shows drift.
   Informational; never seeds by itself. See docs/llm/12-dtw-alignment.md.
6. Mix with ffmpeg → host can broadcast result to everyone or download
7. Share with participants (allowDownload) — they get a Download button
8. Re-record or re-mix iteratively
9. Close session
```

Single-target round: when host picks one participant, only that client
arms a capture; everyone else sees a passive "Alice is recording…" overlay.

Multi-take: same identity recording again → server keys subsequent uploads
as `identity_2`, `identity_3`, ... with filename suffix
`rec_Alice_2.wav`. Host can delete individual takes; gain=0 in mixer
makes ffmpeg skip the track entirely.

## File map (current code)

| File | Role |
|---|---|
| [app/hooks/usePlay2GetherSession.ts](../../app/hooks/usePlay2GetherSession.ts) | Central hook. ~870 lines. Shared state, phase derivation, NTP-lite offset, AudioWorklet capture, WAV encoding, upload, host methods, audio playback. |
| [components/Play2GetherHostPanel.tsx](../../components/Play2GetherHostPanel.tsx) | Host panel. Steps Open Session / Reference / Rehearsal / Launch / Mixer / Reset. Help drawer. Calibration entry. On /host it is rendered `embedded` as the **Play** tab of the docked side column (no drag, help replaces the body); the draggable react-rnd card is the non-embedded fallback, currently unused. |
| [components/Play2GetherClientPanel.tsx](../../components/Play2GetherClientPanel.tsx) | Participant panel: countdown / recording / uploading / mixing / done + passive observer view. Lives as the **Play** tab of the participant's docked side panel (`ParticipantControlPanel docked`), next to the chat: a column right of the stage (a band below it on phones), the stage resized rather than covered. Reports `{active, urgent, attention}` up via `onStatus`; the column opens on this tab when a session starts and jumps to it for countdown/take/calibration round. It owns the `capture` hook instance — never unmount it mid-session, hide it. The lyrics banner is mounted by `MainStageParticipant` inside the stage, not by this panel. |
| [components/Play2GetherCalibration.tsx](../../components/Play2GetherCalibration.tsx) | Shared `CalibrationFlow` + `CalibrationButton` + `runAcousticTrial` (acoustic-loopback latency measurement). Used by both host and client panels. |
| [components/LyricsOverlay.tsx](../../components/LyricsOverlay.tsx) | LRC parser + bottom-banner UI (`Play2GetherLyricsBanner` is the entry component that calls the hook). |
| [public/play2gether-capture-worklet.js](../../public/play2gether-capture-worklet.js) | AudioWorkletProcessor: accumulates 4800-sample batches, writes exactly 128 samples per `process()` (zero-pad on empty input). On `stop` ships the partial batch, then a `done` message with gap counters (see *The end of a take*). |
| [app/api/play2gether/session/route.ts](../../app/api/play2gether/session/route.ts) | POST create session, GET fetch metadata. |
| [app/api/play2gether/reference/route.ts](../../app/api/play2gether/reference/route.ts) | POST audio upload. Runs `probeDuration` and stores `referenceDuration`. Accepts optional `durationSec` form field as fallback for WebM. |
| [app/api/play2gether/lyrics/route.ts](../../app/api/play2gether/lyrics/route.ts) | POST .lrc upload (max 200 KB), DELETE. |
| [app/api/play2gether/record/route.ts](../../app/api/play2gether/record/route.ts) | POST upload a take — **streaming**: metadata in query params, raw WAV body piped to a UUID temp file, then atomically renamed under `withSessionLock`. Computes take key (`identity` / `identity_2` / …). DELETE removes a take. |
| [app/api/play2gether/ready/route.ts](../../app/api/play2gether/ready/route.ts) | Mark / unmark participant ready during rehearsal. |
| [app/api/play2gether/report/route.ts](../../app/api/play2gether/report/route.ts) | POST a recording/upload failure (`{sessionId, participantId, participantName, reason, clapAt}`) → `session.failures[participantId]` so the host sees who dropped out. DELETE clears one. Cleared automatically on a later successful take (record route). |
| [app/api/play2gether/mix/route.ts](../../app/api/play2gether/mix/route.ts) | ffmpeg `amix` with per-track gain + offsetAdjust. Skips gain=0 inputs (no silent tail). Output: `mix.webm` (Opus). |
| [app/lib/p2gSync.ts](../../app/lib/p2gSync.ts) | Shape of a **sync round** — bars, warm-up, tail, and the fixed `SYNC_BPM`. Shared by the client (which sizes the round) and the detector (which knows where every beat should be). See doc 11. |
| [app/api/play2gether/syncDetect.ts](../../app/api/play2gether/syncDetect.ts) | Onset detection + lag vote for a sync take. Returns a median offset, a per-beat scatter, and refusals. See doc 11. |
| `computeEnvelopes` in [utils.ts](../../app/api/play2gether/utils.ts) | Both waveform envelopes from one decode: the 900-bucket JSON overview and the ~5 ms/bucket binary the mixer zoom reads. |
| [scripts/p2g_sync_fixtures.py](../../scripts/p2g_sync_fixtures.py) | Synthetic sync takes with known lags, including every adversarial case the detector has failed. |
| [app/api/play2gether/file/[...path]/route.ts](../../app/api/play2gether/file/%5B...path%5D/route.ts) | Streams files with Range support. |
| [app/api/play2gether/time/route.ts](../../app/api/play2gether/time/route.ts) | `{ now: Date.now() }` — used by the NTP-lite client measurement. |
| [app/api/play2gether/promote-mix/route.ts](../../app/api/play2gether/promote-mix/route.ts) | POST: promote the mix (or any participant take) to be the new reference. Body: `{ sessionId, sourceFile? }`. `sourceFile` must be in the allowlist (`resultFile` or any `participants[x].file`). Copies to `reference_vN{ext}`, probes duration, clears `participants`, sets `status: "preparing"`. |
| [app/api/play2gether/utils.ts](../../app/api/play2gether/utils.ts) | Shared types (`Play2GetherSession`, `Play2GetherParticipant`), `readSession`/`writeSession`, `ensureSessionDir`, `withSessionLock` (per-session mutex for read-modify-write of `session.json`), `probeDuration` (ffprobe wrapper). |

## Shared state slice (`p2g`)

LiveKit shared state, key `play2gether`. Only `teacher` role can write.

```ts
type P2GSharedState = {
  sessionId: string | null;
  referenceUrl: string | null;
  referenceDuration: number | null;     // auto-detected via ffprobe on upload; updated on promote-mix
  countdownSecs: number;                 // 1–30, default 5
  recordingDuration: number;             // auto-synced to reference, host can override
  clapAt: number | null;                  // server-time epoch ms
  resultUrl: string | null;               // cache-busted with ?t=...
  status: "idle" | "preparing" | "rehearsal" | "active" | "mixing" | "done";
  playRehearsal: boolean;                 // host broadcasts reference during rehearsal
  playResult: boolean;                    // host broadcasts mix to clients
  referenceGain: number;                  // 0–2
  targetParticipantId: string | null;    // null = everyone; identity = solo round
  allowDownload: boolean;                 // exposes Download button to participants
  lyricsUrl: string | null;               // optional LRC URL (cache-busted)
  metronomeBpm: number;                   // 0 = off; phase-locked click
  roundKind: "take" | "sync";             // "sync" = a measurement round (doc 11)
  cancelledClapAt?: number | null;        // clapAt of a round the host abandoned
};
```

Phases (`P2GPhase`) are **derived locally** from
`status + clapAt + recordingDuration + offset + now` — not stored:

- `idle` — no session, default render returns null in panels.
- `preparing` — session open, no clapAt yet.
- `rehearsal` — explicit, host triggered.
- `countdown` — `status="active"` and `now < localClapAt`.
- `recording` — `localClapAt ≤ now < localClapAt + duration`.
- `uploading` — `now ≥ localClapAt + duration` and `status` still `active`.
- `mixing` — explicit, host triggered via `triggerMix`.
- `done` — explicit, set after mix completes.

### Cancelling a round mid-flight

`host.cancelRound()` clears `clapAt` and sets `status: "preparing"`. That is the
whole mechanism, and the reason it can be that small is the line above: **the
phase is derived, not stored, and every teardown hangs off the phase** — the
recorder graph tears down whenever the phase is not countdown/recording, the
metronome effect is guarded on `status === "active" && clapAt` and its cleanup
stops the oscillators already scheduled, `stopReference()` runs whenever the
phase is not countdown/recording/uploading, and the upload only fires in phase
`uploading`, which requires a `clapAt`. No clapAt, no upload — the take is
dropped rather than sent and then deleted.

Host-only comes free: only `teacher` can write the slice, so this is not merely
a button the participant panel declines to render.

Two things were added on top, and both are about consequences rather than
stopping:

- **`cancelledClapAt`** exists so people are told why. Without it a cancel is
  indistinguishable from a crash — you were recording, and a frame later you are
  back at "get ready". Keyed by clapAt, not a boolean, so round N+1 setting a new
  clapAt retires the stale value with nothing to reset.
- **The confirm is required, not decorative.** The take is destroyed on every
  client with no undo, and the button sits beside a progress bar for minutes at
  a time. `Play2GetherHostPanel` arms first (`cancelArmed`) and disarms whenever
  no round is running.

**One race remains and it is narrow rather than absent.** A client whose clock
had already passed the end may have started its upload before the patch reached
it, and bytes in flight cannot be recalled — that take lands, and the host
re-runs the round. The staggered upload queue shrinks the window a lot (most
clients are still waiting their turn, and the staggered `run()` re-reads
`cancelledClapAt` through a ref before sending), but it does not close it.
Closing it properly means the record route rejecting a cancelled `clapAt`, which
puts a new failure mode in the path of EVERY upload — deliberately not done.

## Synchronisation technique

### Server-anchored clock (NTP-lite)

Measured **once per tab**, and **pinned for the duration of a round**:

1. 5 round-trips to `/api/play2gether/time`.
2. NTP's four timestamps — `t1` client send, `recv`/`send` from the server
   straddling its own handler, `t4` client receive:
   `offset = ((recv − t1) + (send − t4)) / 2`, `rtt = (t4 − t1) − (send − recv)`.
3. Drop the high-RTT half, take the median of the lowest-RTT half.

**Why the server sends two stamps.** The midpoint estimate assumes a symmetric
round trip, and `getServerSession` sits on the inbound half only, so its cost —
and worse, its variance — lands in the offset as error. A server sending only
`now` degenerates to the old single-stamp form.

How big that error is was then measured, and it is **small**: `send − recv` came
back at **3 ms** against an 83 ms round trip in production. This section
previously claimed the handler accounted for essentially all of a 47 ms
`rttMin`, reasoning from a localhost measurement; that claim was never measured
and the 3 ms contradicts it. The change is still right — an asymmetric term in
the inbound half has no business in the offset — but it buys milliseconds, not
tens of them. The probe error that IS worth attention is the first sample of the
five: cold, and measured at rtt 163 vs 49 steady-state, because of connection
and TLS setup, which two timestamps cannot remove.

**Why once per tab.** The hook is mounted more than once per client (panel +
LyricsBanner), and it used to hold `offset` in `useState`, so each instance ran
its own probes and kept its own answer. That difference does *not* cancel: the
reference is claimed by whichever instance reaches `scheduleReference` first and
the recorder by whichever reaches `P2G_ARMED_LOCKS` first — different locks, so
they can be different instances, and the take is then mixed against a reference
that started at a different instant from the one its `captureDelayMs` was
measured against. 2026-09-01 logged two `p2g_clock` rows a second apart from one
participant, on a link whose `offsetSpreadMs` reached 46 ms.

**Why pinned per round, and why NOT re-measured at the countdown.** Freshness is
not the property that matters. A stale offset cancels exactly as well as a fresh
one, because every instant in a round derives from the same `localClapAt` —
including `captureDelayMs`, which is measured against it. What breaks the
cancellation is the number *moving* between one consumer reading it and another.
Re-measuring during the countdown schedules exactly that move, in the one window
where three effects are reading it and rescheduling, while the recorder graph is
being prewarmed and the RTT is at its least trustworthy. The round therefore
snapshots the offset at its `clapAt` and lives with it. The snapshot is not
taken before the measurement resolves — pinning an unmeasured 0 would be worse
than not pinning.

Clock **drift** is harmless for the same reason. The 2026-09-01 host machine
drifted a clean 80 ppm (384 → 106 ms over an hour, linear across six probes,
while the participant held 262–269 ms against the same server — so it was the
host's clock, not the server's) and none of it reached the mix. A clock **step**
is a different animal — a laptop suspending, an NTP correction landing — and the
answer to that is a background re-measure *between* rounds, never inside one.

Anywhere we read `p2g.clapAt`, we convert to local time via
`localClapAt = clapAt - offset`. Functions affected: `derivePhase`,
`countdown` display, `recordingProgress`, the capture start gate, the
reference schedule, `startCountdown`.

Tolerated server-side clock skew: unlimited within JS Number precision **for
the sync itself**. That claim used to be made about the whole feature, and it
was wrong — see below.

> **Every comparison against `clapAt` must subtract `offset` first.**
> `clapAt` is server time. Anything that compares it to `Date.now()` without
> converting is wrong by the full clock skew, silently.
>
> This bit us in August 2026 with the production server ~19 s behind: the
> prewarm effect's staleness guard (`clapAt - Date.now() < -5000`) saw a clap
> 13.5 s "in the past" on every client, declined to arm the recorder, and
> returned before its first log line. Every round produced zero chunks, and
> `doUpload` reported "No audio was recorded (mic track missing)" — blaming a
> microphone that was working. Host and participant alike, surviving refreshes,
> on every branch.
>
> The reason it hid for so long: the old guard tolerated skew up to
> `countdownSecs + CLAP_BUFFER_MS + 5 s` ≈ **10.8 s** at the defaults. The
> "chrony drifts up to 10 s without issue" note in
> [`04-gotchas-and-patterns.md`](04-gotchas-and-patterns.md) was not evidence
> of robustness — it was a report from just inside the cliff edge.
>
> `derivePhase`, the start gate and the metronome always converted correctly.
> The two that did not were both in the prewarm effect, and both carried a
> comment explaining why the offset supposedly wasn't needed.

### setTimeout drives capture, not the phase ticker

Host computes:
```
clapAt = (Date.now() + offset) + countdownSecs*1000 + CLAP_BUFFER_MS
       ^                                              ^
       local→server                                   800 ms safety buffer
```

and patches it. Every client schedules a single
`setTimeout(armRecorder, localClapAt − Date.now())`. The callback creates
the AudioContext, starts the worklet, plays the audible clap, and injects
the synthetic clap into the worklet input — all in one synchronous burst.

The 250 ms phase ticker (`setInterval`) drives only UI text (countdown
number, progress bar). Capture timing is sample-accurate to the audio thread.

Two locks prevent double-arming:
- `isRecordingScheduledRef` (synchronous): set true the instant the effect
  schedules a timer; reset on cleanup or when phase leaves
  countdown/recording.
- `recorderRef`: set true when the timer's async callback finishes
  constructing the worklet. Once set, both the arming effect and the
  scheduling effect early-return.

### AudioWorklet → WAV capture pipeline

Why not MediaRecorder? Two reasons:
- Opus encoder has ~5–20 ms lookahead.
- `recorder.start()` has ~50–100 ms startup delay before frames flow.

Capture path:
```
mic MediaStreamTrack
  → MediaStreamSource (in fresh AudioContext)
  → AudioWorkletNode "p2g-capture"
  → GainNode (gain=0, silent sink)
  → AudioContext.destination
                 ▼
       worklet pushes Float32Array via port.onmessage
  → chunksRef.current.push(chunk)
                 ▼
       encodeWAV(chunks, captureSampleRateRef.current)
  → POST /api/play2gether/record with WAV blob
  → server transcodes to Opus + precomputes peaks (see below)
```

### The end of a take: flush, then `done` (2026-10-08, PR #8)

The worklet only posts full 4800-sample batches (100 ms at 48 kHz). `stop` used
to close the gate and nothing more, and the teardown nulled `port.onmessage`
in the same tick — so the partial batch, 0–100 ms, never left the worklet, and
a batch already in flight was dropped too. That was the "takes lose ~109 ms of
tail" item from the August calibration round.

Now `stop` posts the partial batch and then `{type:"done", …counters}`. Port
messages are ordered, so once `done` arrives every sample is in `chunksRef`.
The teardown builds `captureDoneRef` (a promise resolved by `done`, or by a
500 ms timeout) and closes the context only after it; `doUpload` awaits the
same promise before reading the chunks — the two run on the same phase change,
and reading first is exactly the old bug. A worklet that never started still
answers (`{type:"done", started:false}`) so nothing waits out the timeout.

> **Rule — never null `onmessage` or close the recorder context before
> `done`.** Field check after the fix: `capturedMs` equals `ctxElapsedMs`
> (6267 = 6267); before it the same host lost 11 and 53 ms.

The `done` message also carries what the worklet saw — see `p2g_take` below.
Counted there rather than on the empty-input branch on purpose: with a
`MediaStreamSource` connected, `inputs[0]` is almost never empty. When the mic
or the track's FIFO runs dry the browser feeds the graph *zeros*, so a gap is a
run of exact-zero samples (≥ 64, ~1.3 ms — a live mic in music mode never sits
at exact 0.0 that long). Pure telemetry: the take itself is not altered.

### The mixer's two envelopes, and why zooming needed a second one

`peaksFile` (`<take>.peaks.json`) is a fixed **900 buckets whatever the take's
length**. That is fine as an overview and hopeless as an alignment tool:

| take length | ms per bucket |
|---|---|
| 31 s | 34 ms |
| 4 min | 267 ms |

The misalignments being corrected are 20–200 ms, so on a real song **one bucket
is bigger than the error**, and no amount of zooming recovers detail that was
never sampled. The screen was the other half of the same problem: at the panel's
420 px, a 31 s take drew at 82 ms/px and a four-minute song at 632 ms/px, against
a fine-tune slider whose step is 5 ms. The waveform was decorative — the error
being corrected was a fraction of a pixel.

So ingest also writes `peaksBinFile` (`<take>.peaks.bin`): a float64 LE duration
header, then **one unsigned byte per ~5 ms bucket** (`PEAK_DETAIL_PER_SEC`,
capped at `PEAK_DETAIL_MAX`). One byte instead of a JSON float is what makes the
finer version affordable — a four-minute take is 47 KB at 5 ms/bucket, against
6 KB at 267 ms.

Both come from **one** `computeEnvelopes()` decode. Two functions would mean two
ffmpeg runs per upload, and eleven singers finish a round at the same instant.

The client prefers the binary, falls back to the JSON, and falls back again to
decoding the audio — so takes recorded before either sidecar existed still draw,
exactly as they always did.

### The mixer's time axis is shared, and three things about it are load-bearing

`TimeView` (`{startSec, spanSec}`) lives once per mixer, not once per strip.
Comparing two takes drawn at different scales is worse than not zooming at all.

- **Wheel is a native listener with `passive: false`.** React attaches wheel
  handlers to the root passively, so `preventDefault` inside an `onWheel` prop is
  silently ignored and a zoom gesture scrolls the panel away under the cursor at
  the same time.
- **Dragging a take emits a DELTA (`onOffsetNudge`), not an absolute value.**
  Several pointermove events fire before React re-renders; each would start from
  the same captured `offsetMs` and stomp the last, so a fast drag would move
  almost nothing.
- **Columns are a per-pixel MAX over the buckets they span**, not a point
  sample. At 900 buckets point-sampling was merely lossy; with a 5 ms envelope
  zoomed out to fit, one pixel spans hundreds of buckets and a point sample
  draws a sparse mess that changes shape as you pan. Verified: a lone 5 ms spike
  at 120 s of a 240 s take still lands at pixel 190 of 380.

Plain drag nudges, shift-drag pans. That way round because nudging is the only
action there that changes the mix, and a host doing eleven takes under time
pressure should not be holding a modifier for it.

The playhead is shared too, and drawn on **its own overlay canvas**. Redrawing
the envelope every animation frame would mean recomputing per-pixel maxima over a
48,000-bucket envelope, for every strip, sixty times a second; the overlay only
clears a rectangle and draws a line. A strip reports its position converted to
MIX time (`captureDelayMs` pad minus the Sync offset), so the line tracks the
waveform drawn under it rather than the file it came from — and playing the
master mix, which already lives on the mix timeline, draws the line straight
through every strip at once. That is the point: what the host is judging is
whether a take sits right against the reference, and a line on one strip cannot
show that.

The view follows the playhead only when it leaves the window, never
continuously. Zoomed to 200 ms the line is off screen a frame after play starts,
so some following is needed; scrolling continuously would slide the waveform
under a stationary line, which is much harder to read alignment from.

Clicking a take focuses it and arms the arrow keys: `←`/`→` move it one slider
step (5 ms), shift ten. There is deliberately **no finer step than 5 ms** — the
slider snaps to 5 (an off-step value makes its thumb jump on the next drag), the
zoom envelope resolves 5, and a player's own beat-to-beat scatter is 12–30 ms, so
a 1 ms control would sit below the noise floor of everything it acts on. Both
controls share one mapping: right is later on screen and therefore a *smaller*
Sync offset, because the mix pulls a take forward by that number.

### Takes are stored as Opus, not as the WAV that was uploaded

The client still *uploads* WAV — an AudioWorklet has no muxer, and the capture
path is sample-exact and not worth risking. The record route transcodes it to
Ogg/Opus 96 kbps mono on ingest and keeps only that.

Takes are the one thing in a session whose size scales with the number of
singers: 16-bit 48 kHz mono is 768 kbps, so a 10-singer 3-minute round was
~173 MB on disk, and layered rounds stack. At 96 kbps it is ~15–22 MB.

Why Opus specifically, on a feature whose budget is <20 ms of skew: ffmpeg
honours the Ogg/Opus pre-skip, so a take decodes back to the sample positions
it was captured at. Verified rather than assumed — a synthetic take with a
click at exactly t=1.000 s, pushed through the real encode/decode commands,
came back with an identical frame count, the onset on the same sample, and a
cross-correlation peak at lag 0. **MP3 and AAC are not interchangeable here**:
their encoder delay is container metadata that decoders (browsers especially)
trim inconsistently, which would shift takes by ~20 ms.

If ffmpeg is missing or the transcode fails the WAV is kept and the take still
works — a take in the wrong format beats a lost take.

> **Rule — a promoted take must be decoded back to WAV.** `promote-mix` turns a
> take into the next round's *reference*, and the reference is decoded in the
> browser with `decodeAudioData` on the sync-critical path. Safari cannot do
> that with Opus and falls back to `el.play()`, which costs ~100 ms of
> unmeasured start delay (see "Reference playback" below). There is one
> reference per round, so unlike the takes its size doesn't scale — correctness
> wins. Promoting the *mix* still copies `mix.webm` as-is; that path already
> carried Opus-in-WebM and changing it is a separate decision.

### Waveform envelopes are precomputed at ingest

Each take gets a sidecar `<take>.peaks.json` (900 normalised floats + duration,
~6 KB), computed by streaming the decoded audio out of ffmpeg at 8 kHz mono and
reducing it to bucket maxima.

The mixer used to build that envelope in the browser: fetch the whole take, run
`decodeAudioData`, walk the samples. Per take. Opening the mixer on a 10-singer
round therefore pulled ~170 MB into the host's browser and decoded all of it,
before the host had pressed play on anything.

`useWaveform(url, peaksUrl, enabled)` prefers the sidecar and **falls back to
the old decode path** when `peaksFile` is absent, so takes recorded before this
still draw. The peaks ride the normal `/api/play2gether/file/…` route (same auth,
same path guard); that route serves `*.peaks.json` and refuses any other `.json`,
so `session.json` isn't reachable through it.

### THREE production bugs in this path — each is a rule

1. **Always write 128 samples per `process()` call**, zero-pad when input
   is momentarily empty. Otherwise the captured sample count under-counts
   wall-clock time → WAV ends up shorter than its labeled duration →
   progressive drift (singer compressed → late in the mix).
2. **Stash `captureSampleRateRef = recCtx.sampleRate` in its own ref**.
   The cleanup useEffect closes the AudioContext before `doUpload` reads
   it; without the ref the WAV gets tagged 48 kHz even when capture ran
   at 44.1 kHz → 8.8% drift.
3. **Connect the worklet to `destination` via a muted GainNode**. Forces
   Web Audio to pull samples through. Without it the audio thread can
   skip `process()` calls under load → gaps that accumulate as drift.

### Per-round upload idempotency

The upload `useEffect`'s deps (`[phase, sessionId, clapAt, room, isLocalTarget]`)
can change late in the uploading phase, re-firing the effect. Without a
guard, `doUpload` would be called twice on the same `chunksRef` — server
stores both POSTs because the take-numbering logic gives the second one
an `_2` suffix. User sees two identical takes.

Fix: `uploadedClapAtRef: useRef<number | null>(null)`. Set to current
`clapAt` when `doUpload` fires; the effect early-returns if the ref
already matches. Reset on every new `clapAt` (alongside `setUploadDone(false)`).

### Cross-instance upload locks

Because `Play2GetherLyricsBanner` calls `usePlay2GetherSession` itself, the
host page mounts **two** hook instances when both the panel and the banner
are rendered. The ref-based idempotency above only dedupes WITHIN one
instance — each instance still has its own `uploadedClapAtRef`, so both
can fire `doUpload` for the same `clapAt`. Server saw two takes per
participant: `rec_Alice.wav` and `rec_Alice_2.wav` per round.

Fix: module-level `Set<string>` locks shared across all hook instances in
the process:

```ts
const P2G_ARMED_LOCKS = new Set<string>();
const P2G_UPLOADED_LOCKS = new Set<string>();
const p2gLockKey = (sessionId: string, clapAt: number) => `${sessionId}:${clapAt}`;
```

The arming effect checks/sets `P2G_ARMED_LOCKS` before scheduling the
recorder; the upload effect checks/sets `P2G_UPLOADED_LOCKS` before
calling `doUpload`. Both cleared when `clapAt` changes (start of next
round). Module-level intentionally — survives React's strict-mode double
mount; resets only on full page reload.

> **Primary fix (later): the banner no longer captures.**
> `Play2GetherLyricsBanner` now calls `usePlay2GetherSession({ capture:
> false })`, which short-circuits the prewarm / start-gate / upload /
> metronome effects. Only the panel instance records and uploads. This fixes
> a nastier symptom than duplicate takes: because the module-level upload
> lock lets only ONE instance run `doUpload`, and `uploading`/`uploadDone`
> are *per-instance* React state, when the **banner** won the race the
> **panel** (which renders the participant UI) never set `uploadDone` and got
> stuck showing the "Uploading…" spinner forever — never the "Recording
> uploaded / waiting for the host" confirmation. The `capture` flag makes the
> panel the sole owner; the module-level locks stay as belt-and-suspenders
> (strict-mode double mount, defensive). Gating the metronome the same way
> also stops the banner from double-triggering the clicks.

### Streaming upload (bypass `req.formData()`)

The original `POST /api/play2gether/record` handler used
`await req.formData()`, which buffers the **entire** multipart body in
JS heap before returning. Four concurrent 1-minute takes (~5.7 MB WAV
each) put ~50–70 MB of transient pressure on the Next.js process; the
event loop stalled servicing the parses, every client got stuck on
"Uploading…", and Node's GC pauses cascaded into 504s.

Current architecture:

```
client                            server
------                            ------
fetch(`/record?sessionId=…        Readable.fromWeb(req.body)
       &participantId=…              │
       &participantName=…            ▼
       &clapOffset=…`,            pipeline → createWriteStream(_tmp_<uuid>.wav)
  { method: "POST",                  │   (outside the lock, parallel)
    headers: { "Content-Type":       ▼
      "audio/wav" },              withSessionLock:
    body: blob,                     readSession → compute takeKey
    signal: ctrl.signal })         rename(_tmp, rec_<safeName>.wav)
                                   writeSession
```

- Memory per upload: O(stream chunk_size) ~64 KB instead of O(file_size).
  Four concurrent uploads → ~256 KB transient instead of tens of MB.
- Metadata travels in URL query params (no multipart parsing).
- Body is the raw WAV bytes; client sets `Content-Type: audio/wav`.
- The stream pipeline runs OUTSIDE `withSessionLock` so different
  participants' uploads write in parallel; only the `rename` and
  `session.json` update are serialised.
- `MAX_UPLOAD_BYTES = 60 MiB` server-side defense in depth; nginx still
  has the front-line 50 MB `client_max_body_size`.
- Pre-checks `readSession` before streaming → fast 404 for stale sessions
  instead of wasting a multi-MB upload.
- Logs `[p2g/record <reqId>]` breadcrumbs at START / streaming / streamed
  / lock acquired / renamed / session.json updated / DONE so concurrent
  uploads are traceable side-by-side.

Client side has a 120 s `AbortController` timeout wrapping the fetch
(`UPLOAD_TIMEOUT_MS`). On abort, the recording stays in `chunksRef` so
the user could conceivably retry — currently surfaces as a thrown error
in the upload effect.

### Two error kinds + host-visible failures

`uploadError` is paired with `uploadErrorKind: "capture" | "upload" | null`:

- **`capture`** — nothing was recorded (mic never published in time, or the
  AudioWorklet failed to load, or `chunksRef` is empty). Re-uploading can't
  help — the round must be re-run — so the panels hide the "Retry upload"
  button for this kind.
- **`upload`** — a take exists in `chunksRef` but the network/server upload
  failed. The bytes are still in memory, so the retry button re-sends them.

Every failure (either kind) also fires `reportP2GFailure(...)` →
`POST /api/play2gether/report`, writing `session.failures[participantId]`
keyed with the round's `clapAt`. The host panel's 3 s poll surfaces these
(filtered to the current `clapAt`) so a dropped participant shows as
"Alice — <reason>" instead of an invisible missing take. A later successful
upload for that participant clears the entry (record route). Before this,
capture/upload failures were visible only on the failing client — the host
just waited for a take that never came.

`reference` upload still uses `req.formData()` — file is uploaded once
per session by the host so memory pressure is bounded; streaming refactor
is on the table if larger references become common.

### Reference playback is scheduled on the audio clock, not `play()`ed

**Rule — never go back to `el.play()` for the take.** During a round the
reference is played from a decoded `AudioBuffer` started with
`source.start(when)` against `ctx.currentTime`. The `<audio>` element
survives only for rehearsal (looped, host-driven, nothing is being recorded
against it) and as the fallback when `decodeAudioData` can't handle the
container — Safari with Opus-in-WebM being the case that matters.

Why: `el.play()` is asynchronous and starts the media pipeline when it gets
round to it — tens to ~100 ms, unmeasured and device-dependent. Everything the
singer hears is shifted by that, so their take lands that much late against a
reference the mix pins at `t=0`, and **no calibration can find it**: the
acoustic calibration measures a click through a plain `AudioContext`, a path
the element isn't part of. Field measurement (session
`fd450a73`, 2026-07-21, cross-correlation of both takes against the reference):
takes ~240 ms late while calibration reported 119/127 ms, `captureDelayMs` 0–1 ms.
The host was dialling the ~100 ms difference in by hand every round.

With a scheduled buffer the only output-side term left is `ctx.outputLatency`,
which the browser reports and the calibration already measures.

The player is a **module-level singleton** (`refPlayer`), not per-instance
state, for two reasons:

- The hook is mounted more than once (panel + `LyricsBanner`) and each instance
  used to build its own element and schedule its own `play()` — the reference
  was played **twice**, a few ms apart: an audible comb filter and two
  different "reference started" instants.
- There is no fixed instance to hand the job to. `HostContent` mounts the host
  panel conditionally (only while it's open) and the banner unconditionally, so
  which instance exists depends on UI state. Electing the first caller to
  schedule a given `clapAt` is the only rule that survives that.

Consequences to keep in mind when touching this:

- **Playback position comes from `getReferenceTime()`**, not from an element's
  `currentTime` — during a take no element is moving. Lyrics and the
  participant visualiser read it.
- **`countdown` must not stop the reference.** The buffer source is already
  armed by then; a `stopReference()` in that phase cancels a round that never
  sounded. (The old element path tolerated a `pause()` there because its
  `play()` was still sitting in a `setTimeout`.)
- A late joiner starts mid-buffer (`start(when, offsetIntoBuffer)`) instead of
  from the top, so their reference is at the same point in the song as
  everyone else's.

### Takes must be recorded in music mode

**Rule — a P2G round in speech mode produces a broken take.** The recorder
captures the **published** LiveKit mic track, so it inherits the publish
constraints, and the speech preset in
[components/audioSelector.tsx](../../components/audioSelector.tsx) sets
`noiseSuppression`, `echoCancellation`, `voiceIsolation` and `dtx` all on. Two
separate damages, both measured on session `ad0b7101` (2026-07-21):

- **45 % of the take came back as exact digital zeros** — 154 and 189 runs, the
  longest 466 ms. Voice isolation deleting every quiet passage of a sung
  performance. (The runs did *not* start on 128-sample boundaries, which is how
  we knew it wasn't the capture worklet's zero-padding but the stream itself.)
- **The processing delay put takes ~100 ms behind the reference**, on top of the
  calibrated latency, and **no calibration can see it**: `runAcousticTrial`
  opens its own `getUserMedia` with all processing off, because AEC would cancel
  the very click it measures. So the calibration describes a raw input path
  while the take goes through the APM. This was the residual the host had been
  dialling into the sync slider by hand every round, and it is why it survived
  the reference-playback fix above — the missing term was on the capture side,
  not the playback side. Confirmed in the field: in music mode the offset lands.

The host panel warns when a session is open and the room isn't in music mode,
with a one-click switch. **Deliberately a warning and not an automatic switch**:
music mode turns echo cancellation off for the whole room, which feeds back
badly if anyone is listening on speakers rather than headphones. That is the
host's call.

> Debugging lesson from this one: every cross-correlation estimate we made was
> ambiguous (all the references used had onsets ~88 ms apart, so estimates split
> into ~120 ms and ~240 ms families and two takes of the *same* performance once
> disagreed by 140 ms). What actually cracked it was looking at **what was in the
> recording** — counting exact-zero runs — rather than where it sat in time.

## Playback-latency compensation

Each take's `clapOffset` (stored in `session.json` per participant) is one
of:

1. **Calibrated latency** — if the user ran `CalibrationFlow`, the
   acoustic-loopback measurement is persisted in
   `localStorage["play2gether:calibratedLatencyMs"]`. Hardware-bound
   (cans + mic don't change between sessions on the same device), so it
   survives reload / session close. Cleared explicitly via the "clear"
   button.
2. **Auto-detected** — the reference player's `baseLatency + outputLatency`
   plus `MediaStreamTrack.latency`. Note the output half is read off the
   **playback** context, not the recorder's: the singer follows the reference,
   so the delay that matters is the one on the path the reference takes to
   their ears. OK for wired hardware; under-reports on Bluetooth by 100–300 ms.

**The mix server-side still does NOT apply `clapOffset`.** It applies the take's
measured `captureDelayMs` (see "Robust sync" above) plus the host's fine-tune
offset, combined into one bidirectional front shift.

**The host UI seeds that fine-tune offset with `clapOffset` on upload**, so the
compensated mix is the default and the host only touches the slider to correct
it. The old "Apply" button in the fine-tune drawer is gone — seeding made it a
no-op. Mechanics, in `Play2GetherHostPanel.tsx`:

- Seeding happens in the session poll, guarded by `seededOffsetsRef` (a map of
  `participantId → uploadedAt`). Without the guard the 3 s poll would stomp the
  host's manual nudge on every tick; keying on `uploadedAt` still lets a
  **re-recorded** take re-seed, since that upload carries its own measurement.
- The value is quantised via `clampToSlider()` to the slider's ±500 ms / 5 ms
  step. An off-step thumb jumps on the host's first drag.
- The ref is cleared on delete / `promoteMix`, so those takes seed again.

The value is seeded **whether or not it was calibrated**. The uncalibrated case
(browser auto-detection, which under-reports Bluetooth by 100–300 ms) is not
silently dropped but **flagged**: the drawer shows an amber "Not calibrated"
warning telling the host to check the take against the reference contour.
Clicking that chip restores the measured value after a manual nudge.

> Why this is safe now: the earlier field evidence *against* auto-applying was
> gathered while `clapOffset` described the wrong path (it read output latency
> off the recorder's context, not the reference player's). Once reference
> playback became deterministic and the number described the path the reference
> actually takes to the singer's ears, applying it lands the take.

Inter-client skew:
- Offset measurement noise: 5–30 ms typical, up to 100 ms on bad uplinks.
- `setTimeout` jitter: 1–10 ms.
- Audio hardware clock drift (mic ADC vs context): 1–3 ms per 30 s — fundamental, browser can't fix it.
- Total: **< 20 ms with calibration, < 50 ms without**.

## Metronome

Two schedulers, one shared tempo (`p2g.metronomeBpm`, 0 = off), one shared
click sound (`scheduleMetronomeClick`, exported from the hook so both sound
identical).

- **During a round** (`usePlay2GetherSession.ts`): phase-locked to the clap.
  Tick `k=0` lands ON `clapAt` — which is also the reference's `t=0` — negative
  `k` are the count-in during the countdown, positive `k` run through the take.
  Every tick is scheduled up front, which it can do because the round has a
  known `recordingDuration`.
- **While capturing the reference from the mic** (`Play2GetherHostPanel.tsx`):
  free-running from the moment recording starts, on a rolling scheduler
  (top up 1 s of ticks every 250 ms) because a base capture runs until the host
  presses Stop and has no known length.

> **Rule — the base metronome does NOT define a grid.** It is a tempo guide for
> whoever plays the base, nothing more. Making the base's `t=0` land on a
> downbeat would need the capture to *start* on one, and the reference is
> recorded with `MediaRecorder`, which starts tens of ms after `start()`
> returns — the very reason the takes use the worklet instead. At 120 BPM an
> 80 ms error is 16 % of a beat, plainly audible against the round metronome,
> so the click in later rounds is not guaranteed to agree with the music in the
> base. If that ever needs to hold, the fix is to capture the reference through
> the take path (prewarm + start-gate + `captureDelayMs`), not to add a
> count-in to `MediaRecorder`.

Bleed is worse here than in a round: a click captured into the base is
permanent — it plays under every subsequent round and lands in every mix. The
panel warns as soon as a BPM is set, and the BPM field is disabled mid-capture
so the tempo can't shift under the performer.

## Acoustic-loopback calibration (`runAcousticTrial`)

Used to override the auto-detected latency for unusual hardware (BT, USB
mics with unreported buffering, etc.). Implementation in
[components/Play2GetherCalibration.tsx](../../components/Play2GetherCalibration.tsx):

1. Open a fresh `getUserMedia` with `echoCancellation: false`,
   `noiseSuppression: false`, `autoGainControl: false` — AEC would
   suppress the very signal we're measuring.
2. Create a fresh AudioContext + AudioWorkletNode.
3. Schedule a synthetic click via `AudioBufferSourceNode.start(at)`
   routed both DIRECTLY into the worklet input (sync marker) AND through
   `destination` (audible click).
4. After ~900 ms, post `{cmd:"flush"}` so the worklet ships its partial
   buffer — it otherwise only posts every 4800 samples (~100 ms), and that
   lost tail is exactly where a high-latency BT click lands.
5. Scan the captured buffer for the marker peak (pre-click region) and the
   acoustic-click peak (after marker + 200 ms ± safety), then walk back from
   each peak to its onset (first sample above `max(0.25 × peak,
   3 × noiseFloor)`).
6. `latency = (clickIdx - markerIdx) - scheduledGap` in samples → ms.
   Below `MIN_PLAUSIBLE_LATENCY_MS` (8 ms) it throws instead of returning.
7. Repeat `TRIALS` (5) times → `summariseTrials()`: sort, drop the highest and
   lowest, average the rest. A failing trial no longer aborts the run; the run
   only gives up below `MIN_SUCCESSFUL_TRIALS` (3).

Every trial logs a `[p2g-calib]` line (marker/click positions, both peaks,
noise floor, captured length, `baseLatency`/`outputLatency`) and leaves the raw
capture in `window.__p2gCalibLast.buf` for offline inspection.

User-side UX: 4-stage state machine (`auto-intro` → `auto-running` →
`auto-result` | `auto-error`). The earlier "manual tap" mode (3 visual +
3 audio trials, human reaction subtraction) was REMOVED — auto-acoustic
is the only path now.

`CalibrationButton` takes a **`warn`** prop. Uncalibrated it normally renders as
a neutral suggestion; with `warn` it turns amber ("Not calibrated yet — your
take may land out of sync"). It is set wherever a take is imminent and the
singer can still act: the participant overlay in `preparing` **and** `rehearsal`
(the host can launch the countdown from either, and after the clap it is too
late), and the host panel once `sessionCreated`, since the host records too.
Deliberately NOT shown during `countdown` — no time left to calibrate, so it
would be pure anxiety. This is the *upstream* half of the mixer's "Not
calibrated" warning: without it the problem only surfaces once the take exists.

> **Rule — calibration must open the worklet start gate.** The capture
> worklet is start-gated (discards input until it receives `{cmd:"start"}`
> — see "start-gate" below). The main recorder flips this gate at the clap;
> calibration has no clap, so `runAcousticTrial` must post `{cmd:"start"}`
> itself right after wiring the graph, before the marker/click fire.
> Forgetting it (regression when the gate was introduced) means the worklet
> captures nothing, the buffer stays all-zero, and the marker scan fails
> with "Internal sync marker lost" — the click is audible but nothing is
> measured.

> **Rule — onset detection is relative to the peak, never an absolute
> threshold.** The click search window opens 10 ms *before* the click's
> scheduled arrival. The original detector took the first sample over a fixed
> threshold (0.02) from there, so whenever the mic could not actually hear the
> click it latched onto room noise at the window edge — the measurement became
> "where my own search window starts", i.e. a *negative* latency that
> `Math.max(0, …)` laundered into a plausible-looking **0 ms**. Since
> `2c6131b` that number auto-seeds every take's slider, so it mis-aligns a
> whole session silently.
>
> The usual physical cause is **headphones**: plugging the jack switches the
> sink's active port and cuts the internal speakers, so nothing reaches the
> mic. Calibrating on speakers and singing on *wired* headphones is fine (same
> sink, same output latency); on **Bluetooth it is not** — the BT output
> latency is the thing being measured, and the speaker result under-reports it
> by 100–300 ms. With a jack headset the right move is to hold an earcup
> against the mic capsule: it measures the exact output *and* input path the
> take will use.

> **Rule — report the spread, don't hide it behind a single number.** Field
> reports of 110 ms on one run and 250 ms on the next, same device, and of
> trials like `232 · 272 · 76` inside one run. A plain median returns 232 from
> that with a confident green tick, and it is then applied to every take.
>
> `summariseTrials()` returns `spread` (max − min of the KEPT trials) alongside
> the value, and above `SPREAD_LIMIT_MS` (50) the result screen turns amber,
> says the measurement isn't stable, makes "Measure again" the primary action
> and demotes saving to a quiet "save anyway" link. Not a hard block: some
> hardware genuinely is that jittery, and a rough number the singer knows is
> rough still beats the browser's estimate.
>
> The two causes to check, in order: the mic isn't really hearing the click
> (low `clickPeak` in `[p2g-calib]` on the odd trials), or the audio path is
> being reconfigured between runs — each trial opens its own `getUserMedia` +
> `AudioContext`, PulseAudio suspends idle devices, and output latency depends
> on what the sink is already doing. Hence the advice to calibrate under
> recording conditions (room joined, music mode), not in a silent tab.

## Lyrics overlay

Optional `.lrc` uploaded alongside the reference. Format:
`[mm:ss.xx]Line of lyrics`. Multiple timestamps per line are supported;
metadata-style tags `[ti:…]`, `[ar:…]` are ignored (any timestamp that
starts with a non-digit after `[`).

Parser: `parseLRC(text)` in
[components/LyricsOverlay.tsx](../../components/LyricsOverlay.tsx). Returns
`{ time, text }[]` sorted by time. Binary-search-friendly.

Banner UI: bottom-of-screen, 3 lines (prev / current / next), current
line big white with drop-shadow, fades in/out via CSS opacity transition.
Shown only during `rehearsal | countdown | recording` phases. Self-gated
by `Play2GetherLyricsBanner` (calls the hook itself).

> Note: calling `Play2GetherLyricsBanner` alongside the host or client
> panel spawns a **second hook instance**. Each instance has its own
> `uploadedClapAtRef`, so the in-instance idempotency check alone is not
> enough — duplicate uploads were observed (`rec_Alice.wav` +
> `rec_Alice_2.wav` per round). The fix is the module-level
> `P2G_ARMED_LOCKS` / `P2G_UPLOADED_LOCKS` keyed by `(sessionId, clapAt)`
> — see "Cross-instance upload locks" above. The banner instance now also
> passes `{ capture: false }` so it doesn't run the recorder/upload/metronome
> at all (it only reads phase + reference position for lyric timing), which is
> the real fix — the locks are belt-and-suspenders now. The redundant second
> `<audio>` element is gone too: reference playback is a module-level singleton
> shared by every instance (see "Reference playback is scheduled on the audio
> clock"), which is what stopped the reference being played twice per client.
> The **result** audio (the host's `playResult` broadcast) had the same bug and
> is now shared too — one element, so play/pause from both instances is
> idempotent. Worth knowing why it was easy to miss: the banner returning
> `null` from render does NOT unmount it, so its hook kept running and its copy
> of the mix played even in sessions with no lyrics at all.

## Mix pipeline (ffmpeg)

[app/api/play2gether/mix/route.ts](../../app/api/play2gether/mix/route.ts).

Per input the route builds:
```
-ss {clapOffset + hostSliderAdjust ms, clamped >= 0}  → trim silent prologue
-i {file}                                              → input
-filter:a "volume={gain}"                              → per-track gain
```

Then `amix` mixes everything together with the reference. Tracks with
gain=0 are skipped entirely from the command — the original
implementation kept them at zero volume but ffmpeg's `amix` still padded
the duration with them, leaving a silent tail.

Output: `mix.webm` (Opus, small for download). The result URL is
cache-busted with `?t=${Date.now()}` so re-mix doesn't serve stale.

## Uploads are staggered

Every client stops recording at the same instant (same `clapAt`, same
`recordingDuration`), so a 10-singer round used to fire ten ~17 MB uploads
simultaneously. Four concurrent uploads were already enough to stall the server
once — that is what the streaming rewrite in the record route was for — and
each arrival now also spawns transcode + peaks work.

`uploadStagger()` in `usePlay2GetherSession.ts` gives each client a delay before
it sends. Key properties:

- **The slot is derived, not random.** Every client sorts the same roster of
  identities and takes its own index, so the schedule is collision-free with no
  coordination and no extra round-trip. Random jitter still collides — ten
  clients drawing from one range land together often.
- **The tail is bounded** (`UPLOAD_STAGGER_MAX_MS`, 12 s): the gap compresses
  as the room grows rather than the queue growing without limit. The wait is
  the one window where a take exists ONLY in memory — close the tab and it is
  gone, with no retry — so the wait is capped even though that means more
  overlap in a big room (~4 concurrent at 10 clients, ~8 at 20).
- **A single-target round has no delay** — there is only one uploader.
- Roster disagreement (someone joining as the round ends) can give two clients
  the same slot. That degrades to two simultaneous uploads, i.e. the old
  behaviour, so it fails soft.

On a shared link this costs nothing: the same bytes cross the same pipe either
way, they just arrive in order instead of ten TCP streams fighting and timing
out together. It only costs wall-clock time when there was spare bandwidth —
i.e. when there was no problem to begin with.

Honest limit: if the link is genuinely saturated the uploads still overlap
(they start apart, stretch, and catch up). What holds regardless is that they
*finish* apart, and since the transcode runs on completion, the server-side
work spreads out with them.

The participant panel shows "Waiting to upload — your turn is N of M" plus
"keep this tab open", because a screen that looks idle invites closing it.

There is deliberately **no server-side concurrency limiter**. It was considered
and rejected: staggering already bounds how much arrives at once, and a
semaphore whose permits leak turns a recoverable stampede into uploads that
hang forever.

## Mixer at choral scale (8–10 takes)

A real round is 8–10 singers and re-recordings stack on top of that. What
breaks first is not ffmpeg — one process, N inputs, linear — it is the host's
panel: a full channel strip (name, fader, waveform, fine-tune drawer, open by
default) is ~200–230 px, so ten of them are ~2200 px inside a 600 px panel,
with the Mix button several screens below the first take.

- **Density.** Above `COMPACT_LIST_THRESHOLD` (5) takes the list collapses to
  one line each — name, level, mute — with a single strip expanded at a
  time (`expandedTakeId`). Below the threshold nothing changes, so small
  sessions keep the layout they had. `densityPref` lets the host force either.
- **Collapsed rows cost nothing.** `showDetail` gates the waveform, and nothing
  is fetched for a row until its preview is played — otherwise the browser
  starts pulling ten takes the moment the mixer opens, for previews that may
  never be played.
- **Two transports, two questions** (`useMixPreview`, one engine): the sticky
  bar's Preview plays the BALANCE — every audible take over the reference, where
  the mix puts them — and each strip's play button plays THAT ROW ALONE. Only
  one runs at a time (`activePreviewStop`). See below.
- **Sticky action bar** pins "Mix recordings" (plus a compact play-for-everyone
  once a result exists) to the bottom of the scroll container. Those two are
  what a host repeats while working the faders; the full master card
  (download / share / use-as-layer) stays in flow underneath.

Expansion and gains are cleared when takes are deleted or promoted.

### One Preview replaced ten play buttons, and solo (2026-09-04)

Two removals in one afternoon, in this order, and the second only made sense
once the first had happened.

**Solo went first.** It rendered a server-side mix containing one track and
nothing else — two ffmpeg passes and a round trip to answer *"what does this
take sound like"* — and it answered with the **reference removed**, which is the
one thing you need to hear a take against. Its other uses had been overtaken:
the waveform overlay shows alignment, the level readout shows level.

**Then the per-strip play buttons went**, on the host's observation that a
mixer with a play button per row is not intuitive: ten buttons, each playing
something nobody is building. What a host wants to hear is the balance.

So there is exactly one transport, in the sticky bar next to Mix. It plays
**every audible take over the reference**, each at `captureDelayMs − manual` —
the same shift ffmpeg applies — through gain nodes carrying the live fader
values, so moving a fader while it plays does what a mixer should do. Isolating
a take by muting everything else turned out to be a worse answer than a button:
each strip kept a play control, but one that plays only that row, at its own
mix-time position. So the two questions a host asks have one control each —
"how does this balance sound" and "what did this person actually record" — and
starting either stops the other, because one AudioContext stacked on itself is a
balance the mix will never produce. A muted row still plays there: mute means
"not in the mix", not "unlistenable".

**Decoded buffers, not `<audio>` elements.** Media elements started in the same
tick drift by tens of milliseconds, by a different amount each time. This exists
to judge a 20 ms misalignment, so element scheduling would invent the flam the
host is listening for. Buffers on one AudioContext clock are sample-accurate.

**Decoded at `PREVIEW_SAMPLE_RATE` (24 kHz), not the file's rate.**
`decodeAudioData` resamples to its context's rate and memory is linear in it:
eleven five-minute takes at 48 kHz float is over half a gigabyte of tab, which
is the tab dying on the one session this has to survive. Halving the rate
changes nothing about timing — scheduling accuracy does not depend on sample
rate — and this is a monitoring path, not a mastering one. Past
`PREVIEW_BUDGET_BYTES` (250 MB, estimated from the timeline before anything is
fetched) the button refuses and says to mix instead, which is the right tool for
a round that size anyway.

Only the reference buffer is cached between plays; take buffers are released on
stop. Every URL carries its `?t=` version, so a re-recorded take or a replaced
reference is a different cache key and can never come back stale.

`allowBoost` went with solo. It existed so a solo render was not lifted to the
same output level as a full mix — with no solo render, nothing needs it.

## Take length is a chain, not a setting

`MAX_RECORDING_DURATION_SEC` (360 s) in `usePlay2GetherSession.ts` is the
single source of truth, imported by the host panel so the input bound can't
drift from the clamp. But the ceiling it names is only real if four limits
agree, because a take travels as **uncompressed mono 48 kHz 16-bit = 96 KB per
second** (the Opus transcode is server-side, on ingest — it does not shrink
what crosses the link):

| Limit | Where | Value | Fails as |
|---|---|---|---|
| Duration clamp | `setRecordingDuration` + panel input | 360 s | can't be set |
| nginx body size | `nginx.conf.template` | 50M | **413 at the edge — never reaches the app logs** |
| Route hard cap | `MAX_UPLOAD_BYTES`, record route | 60 MB | 413 from the app (defence in depth) |
| Client upload timeout | `uploadTimeoutMs()` | scales, capped 540 s | abort mid-transfer |
| nginx inactivity timeouts | `nginx.conf.template` | 300 s | 504 (see below) |

360 s × 96 KB/s = **33 MiB per singer**, comfortably under the 50M edge limit —
which puts the true ceiling at 546 s (9:06), not 360. The clamp is the
conservative one on purpose.

> ### `server/nginx/nginx.conf` is GENERATED — do not edit it
>
> The nginx container's entrypoint runs
> `gomplate -f /etc/nginx/templates/nginx.conf.template -o /etc/nginx/nginx.conf`
> on **every start**. The real configuration is
> `server/nginx/templates/nginx.conf.template`. `nginx.conf` is tracked in git
> and mounted read-write, so it looks editable, reads as authoritative, and is
> silently overwritten at the next boot — and the copy in the repo is stale
> enough to name a different host (`portable.` vs `creativestudio.`) and a
> different body limit (20M vs 50M) than the template it supposedly came from.
> Read the template. Change the template.

nginx's three 300 s timeouts are **inactivity** timeouts, not budgets for the
whole request: a slow but steady upload never trips them however long it runs,
which is why a 528 s transfer is fine. What they do bound is *silence* — and
the one that can go silent is the record route, which replies only after
ffmpeg, peaks and the session lock. If that stretches past 300 s, nginx returns
a 504 and no client-side timeout can pre-empt it.

The upload timeout used to be a flat 120 s, which is a bug once duration is a
host-set parameter: 120 s fits a 30 s take on almost any link and aborts a
5-minute take on a rural one that would have finished. It now scales at an
assumed floor of 64 KiB/s (512 kbps), capped at 540 s. An abort is recoverable
— the take is still in `chunksRef` and the retry re-sends it — but it burns the
window and reads to the player as lost work.

> The client's ceiling is sized from the work, not from nginx: 33 MiB at the
> assumed floor rate is ≈528 s, so 540 s covers the full range without
> aborting an upload still making progress. It is deliberately NOT tuned
> against nginx's 300 s, because those are inactivity timeouts and measure a
> different thing (see the box above).

### Two things long takes expose that short ones cannot

- **Client memory.** Capture holds `Float32Array` chunks (4 bytes/sample) AND
  `encodeWAV` builds the 2-byte-per-sample blob before the old buffers are
  released: ~69 MB + ~33 MB ≈ **100 MB peak** at 360 s. Fine on a laptop;
  a plausible tab kill on an iPad. Streaming the encode would fix it and has
  not been done.
- **Drift is proportional to length.** Alignment is set once, at the clap.
  A soundcard whose real rate is off by 100 ppm — ordinary for cheap USB
  interfaces — walks ~30 ms away from the reference over 5 minutes, and
  nothing re-syncs mid-take. A 30-second test cannot show this: it is 3 ms
  there. `shortfallMs` on `p2g_take` catches truncation, but inter-client
  drift is a mixing question and is currently unmeasured.

## Field telemetry (what a round reports about itself)

Added for the September 2026 remote-band session, where the link quality is
the unknown and a post-mortem "it felt slow" is not an answer. Four events per
participant per round, emitted through the **existing** `/api/connection-log`
beacon pipeline (`app/lib/p2gTelemetry.ts`).

**Why that pipeline and not an endpoint of its own**: the connection-log route
already treats `event` as a free-form string and drops unknown fields into the
`extra` Json column, so these are pure *data* to it — no schema migration, no
edit to shared infrastructure, and no line of connection-log code that knows
what "play2gether" means. They also land in `/admin/connections` next to the
`reconnecting` / `quality` rows they have to be read against: a 90 s upload and
a reconnect thirty seconds earlier are one story, not two.

| Event | When | Key fields |
|---|---|---|
| `p2g_clock` | once per hook mount, when an identity exists | `offsetMs`, `offsetSpreadMs`, `rttMin/Med/Max`, `validSamples` |
| `p2g_reference` | reference fetch+decode settles | `bytes`, `fetchMs`, `decodeMs`, `fallback`, `ok` |
| `p2g_take` | capture ended, BEFORE the bytes leave | `bytes`, `sampleRate` (recorder context), `trackSampleRate` (mic), `capturedMs`, `expectedMs`, `shortfallMs`, `ctxElapsedMs`/`wallElapsedMs`/`ctxLagMs`, `captureDelayMs`, `clapOffsetMs`, `calibrated`, `slot`/`total`, `staggerDelayMs`; gaps from the worklet: `gapStats` (false = the worklet never reported), `gapCount`, `gapMs`, `gapLongestMs`, `gaps` (`"12.34s+45ms …"`, first 12), `emptyQuanta`, `shortQuanta`, `writtenMs`; Chrome only: `trackDroppedFrames`, `trackDroppedMs`, `trackTotalFrames` (`MediaStreamTrack.stats` between clap and stop); test takes: `testTrack`, `simulatedLatencyMs` |
| `p2g_upload` | transfer settled (either way) | `ok`, `bytes`, `waitMs`, `uploadMs`, `recvMs`, `serverMs`, `kbps`, `kbpsSource`, `error` |

All carry `netInfo()` (`netType`, `downlinkMbps`, `netRttMs`) and the round's
`clapAt`, which is what joins the four together and separates round from round.

### The three readings that matter

- **`kbps` on `p2g_upload`** is this client's real uplink for a take-sized
  body. Takes upload as WAV (768 kbps mono), so `expectedMs × 768 / kbps` is
  how long the next round will take on that link. This is the number that
  decides whether a simultaneous round is viable at a given take length, or
  whether the round has to be run one player at a time.

  > **It is computed from `recvMs`, not from the client's wall-clock.** The
  > record route responds only after transcode + peaks + lock +
  > `session.json`, so `uploadMs` is transfer *and* server work combined —
  > using it as a bandwidth figure understates a good link on a busy server,
  > which is the wrong way to be wrong when the answer changes the workflow.
  > The route returns its own receive time; `kbpsSource` says which was used
  > (`"server"` normally, `"wall"` against an older server or an unparseable
  > body). `uploadMs − serverMs` is what the client waited beyond the server's
  > own work — queueing, and the response trip.
- **`offsetSpreadMs` on `p2g_clock`** is how much the clock probes disagreed.
  The adopted offset shifts every take by `clapAt - offset`, so a large spread
  means this singer's alignment is a guess. Path asymmetry (satellite, rural
  4G) biases it in a way the median can't remove — the acoustic calibration
  won't catch it either, because that measures the *device*, not the clock.
- **`shortfallMs` far from ±200 ms** is a broken take, and the clock fields
  say which kind. `ctxLagMs` large (recorder context behind the wall clock) =
  the audio thread missed render callbacks and each one cut audio out, so the
  take drifts early after every gap. Field session 2026-09-28: one player's
  context ran at **96 kHz** and lost 13–26 % of every take; the recorder
  context is now pinned to 48 kHz. A take whose `bytes` equal the same
  player's previous take is the **stale-buffer** bug fixed the same day: a
  round whose recorder never armed (no mic published) uploaded the previous
  round's samples. `capturedMs` then matches the previous round's length, not
  this one's.
- **`ctxElapsedMs − capturedMs`** is the tail check, and it should be 0. Do
  not use `shortfallMs` for it: the stop fires on the phase change, a little
  AFTER `expectedMs`, so shortfall is negative by a varying couple of hundred
  ms and hides a 50 ms loss.
- **`gapCount > 0`**: many long runs that line up with rests = a device with a
  hard noise gate, not dropouts; a few runs in the middle of playing = real
  gaps (open the take in the mixer at the second `gaps` names). Lost render
  callbacks leave no zeros — the take just comes out short — which is
  `ctxLagMs`'s job, not this.
- **`trackSampleRate` 44100 with `sampleRate` 48000** is normal: the mic runs at
  the OS rate and the browser resamples into the 48 kHz recorder.
  `trackTotalFrames` counts at the mic's rate.
- **A `p2g_take` with no matching `p2g_upload`** is a take that died in memory.
  The stagger wait is the one window where a take exists nowhere else and has
  no retry, so its absence had to be made visible. `retryUpload()` re-enters
  `doUpload()`, so a retry emits a fresh pair — two `p2g_take` rows sharing a
  `clapAt` is one attempt that failed and one that was retried.

### Cost

Four beacons of a few hundred bytes, all at round boundaries: one at mount, one
when the reference lands, two after recording has already stopped. **Nothing in
the audio path, nothing polling, nothing during countdown or capture.** Against
a ~17 MB take that is ~0.005 % of the bytes. Every emit is wrapped so a
measurement can never fail a round.

### Reading it back

Filter `/admin/connections` by event name — the filter is a free-text input
with suggestions, not a closed list, so any event kind added later is reachable
without editing the viewer. Or tail live:

```
docker logs -f <next-container> | grep -E "p2g_(upload|take|clock|reference)"
```

The server side needs nothing added: `[p2g/record <reqId>]` already logs START,
streamed MB, transcode ratio, peaks, lock and DONE with cumulative ms. The
client half is what was missing — everything that happened before the bytes
arrived.

## Test track mode (`?p2gtest`, PR #9)

Testing the mixer, the DTW or the pulse grid used to need musicians and never
had a known answer. With `?p2gtest` added to a **participant's** URL (it
already has `?sessionId=…`, so `&p2gtest`), the client panel shows an amber
"Test mode — send a track instead of your mic" box in the preparing and
rehearsal phases: an audio file, a simulated output latency (ms, default 120),
and whether to report that latency as the player's calibration.

During a take round the capture instance does not arm the mic at all. The
prewarm effect builds the take on the spot — the file, decoded to mono 48 kHz,
preceded by `latency` ms of silence and cut or padded to the round's length
(`buildTestTake`, `app/lib/p2gTestTrack.ts`) — and the rest of the round is the
normal path: staggered upload, record route, Opus, peaks. Sync rounds still use
the mic.

**Why a delay is the whole simulation:** a real player hears the reference
`L` ms late and plays in time with what they hear, so everything lands `L` ms
late in their take. The file shifted by `L` is that player minus the human, so
**the correct Sync value is exactly `L`**. The record route stores it as
`simulatedLatencyMs` and the mixer shows "test · sync L ms" on the take.

> **Only true when the file is aligned with the reference at source** — stems
> of one session (e.g. `DrStem` as reference, `KeyStem` as the test track). A
> real take from an earlier session already carries its own unknown delay, so
> the answer becomes "that delay + L" and nothing can be checked against it.
> First real use (2026-10-08): KeyStem +120 over DrStem — the server's Opus
> take matched the original +120.00 ms; pulse grid +117, DTW −75 ±168.

Caveats: a participant with a stored server-side calibration may still seed
the mixer from it — test with uncalibrated participants. Several "players" =
several tabs, each with its own file and latency.

## Browser caching gotcha

All Play2Gether files are served with `Cache-Control: private, max-age=3600`.
Without cache-busters, the browser serves the old file after re-record /
re-mix / re-upload. Three cache-busters wired:

- `mix.webm` — `triggerMix` patches `resultUrl` with `?t=${Date.now()}`.
- `rec_*.ogg` and its `rec_*.peaks.json` — host mixer renders both with
  `?t=${participant.uploadedAt}`, which is updated server-side on every upload.
  The peaks URL is also the waveform cache key, so a re-record redraws.
- `lyrics.lrc` — `uploadLyrics` patches `lyricsUrl` with `?t=${Date.now()}`.

## Duration auto-detection (recent)

Reference upload now drives `recordingDuration`:

1. Server runs `probeDuration(filePath)`:
   - First try: `ffprobe -show_entries format=duration` (works for
     mp3/wav/m4a/flac/most containers with format-level duration).
   - Fallback: `ffprobe -show_entries stream=duration -select_streams a:0`
     (recovers many WebM/Opus files that carry duration in the stream).
2. If both return null and the client provided a `durationSec` form field
   (wall-clock from `performance.now()` deltas during MediaRecorder
   capture), use that.
3. The resolved duration is stored as `meta.referenceDuration` and also
   syncs `meta.recordingDuration = Math.ceil(referenceDuration)`.

Client side: `uploadReference(file, mimeType?, durationSec?)` reads the
response and patches both `referenceUrl` + `referenceDuration` +
`recordingDuration` into shared state.

UI: the Step 4 `NumberField` for Duration shows the auto-detected value
and lets the host override per-round (e.g. for chorus-only takes). The
tooltip reads `Auto-detected from reference (X.Xs). Override to record a section.`.

## Feature #3 — Layered recording (promote mix / take to new reference)

After a mix (or after inspecting individual takes), the host can promote any audio file to be the new reference. This enables "recording in layers": choir records over reference → mix → mix becomes new reference → soloists record over the mix → mix again.

### Server: `POST /api/play2gether/promote-mix`

Body: `{ sessionId: string, sourceFile?: string }`

- `sourceFile` defaults to `meta.resultFile` (the last mix).
- Allowlist check: `sourceFile` must equal `meta.resultFile` OR one of `meta.participants[x].file`. Prevents path traversal.
- Extension is preserved from the source filename so `.wav`, `.mp3`, `.webm` all work.
- New filename: `reference_v{N}{ext}` where N = `(meta.referenceVersion ?? 1) + 1`. `referenceVersion` is stored on `Play2GetherSession`.
- Probes the new file's duration via `probeDuration`.
- Clears `meta.participants = {}`, sets `meta.resultFile = null`, `meta.status = "preparing"`.

### Client: `host.promoteMix(sourceFile?: string)` in `usePlay2GetherSession.ts`

- Calls `POST /api/play2gether/promote-mix`.
- On success: patches shared state — `referenceUrl` (with `?t=` cache-bust), `status: "preparing"`, `resultUrl: null`, `clapAt: null`, `playResult: false`, `playRehearsal: false`, and updates `referenceDuration` / `recordingDuration` from the server response.
- Callers reset local UI state (`serverSession`, `participantGains`, `participantOffsets`).

### Host panel: `Play2GetherHostPanel.tsx`

- **Per-participant**: teal `Layers` icon button in the mixer row calls `host.promoteMix(file)`.
- **Post-mix**: "Use mix as new reference" button (teal, `Layers` icon) after the download/share row calls `host.promoteMix()` (no argument → promotes the mix).

## Host-refresh playback reset

Shared state persists across the host's page reload (it's anchored to the
LiveKit room, not the host tab). If the previous mount left
`playRehearsal: true` or `playResult: true`, the reloaded host would
auto-broadcast the reference / mix audio the moment the hook remounted
— surprising both host and participants.

Fix: `playbackResetForSessionRef` in `usePlay2GetherSession`. On the
host's first mount per `sessionId`, the hook sends a single
`sendChange([…])` patching `playRehearsal: false` and `playResult: false`
back to safe defaults. Subsequent mounts within the same session
(without a new sessionId) skip the reset — the host's explicit clicks to
start playback during the session still propagate normally.

The ref is keyed by `sessionId`; a new session starts the reset cycle
over.

## Conventions specific to this feature

- Host panel UI is **always English**, even though commit messages are in
  Spanish.
- Status flow on the server (`Play2GetherSession.status`): `preparing` →
  `recording` → `uploading` → `mixing` → `done` | `error`. Note this is
  the SERVER-side status, distinct from the shared-state `status` which
  also has `active` and `idle` and `rehearsal`.
- Cache for the reference is OK to keep — same URL same content. But
  when the host re-records the reference live, the URL stays the same
  while the file content changes → must cache-bust similarly (not
  currently done; consider versioning `referenceUrl` if this becomes a
  problem).

## Levels: measured at ingest, matched on demand (2026-09-04)

Every take is measured when it arrives — `measureLevel` in
`app/api/play2gether/utils.ts`, inside the decode `computeEnvelopes` already
does, so it costs one extra pass and no extra ffmpeg. Two numbers land on the
take: `levelDb` (gated RMS in dBFS) and `peakDb` (sample peak). The envelopes
next to them are **normalised**, so they cannot answer "how loud is this take"
— that is why the level rides along instead of being derived from them later.

The gate is the point. An ungated RMS measures *how much of the take is
silence*, so a player who comes in halfway reads several dB quieter than the
same player throughout, and a fader set from that number makes them twice as
loud as everyone else. Blocks more than 20 dB under the take's own loudest, or
under −55 dBFS, are dropped before averaging.

**This is not LUFS and must not be labelled as such.** It runs on the 8 kHz mono
decode every other analysis here uses: no K-weighting, no high band. What it is
is the mean power of the take's own loud blocks — what a host matches by ear
when they listen to two takes and even them up. For proposing a starting fader,
agreeing with the ear to a couple of dB is the whole requirement, and a real
loudness meter costs a second ffmpeg pass per take on a round where eleven land
at once.

### Why the mixer needed it, with the session that proved it

The 2026-09-04 two-machine session, `26fe039b-…`, both takes recorded by the
same person on two PCs against the same 13 s reference:

| | gated RMS | peak | noise floor |
|---|---|---|---|
| take A | **−20.1 dBFS** | −4.8 | −46.7 |
| take B | **−41.9 dBFS** | −25.8 | −70.2 |
| reference | −35.0 | −11.2 | −69.6 |

A 21.7 dB spread between two takes of the same material. Fitting each source
back out of the rendered mix (least squares, aligned) says what that produced:

```
take A    90.0 % of the mix energy
reference  6.4 %
take B     3.0 %
```

The host's report was *"it lines up quite well but it doesn't sound right"*, and
it was not an alignment problem at all — the second take is inaudible and the
backing is 15 dB under the first. Nothing in the panel said so: the waveform
envelopes are normalised, so on screen both takes look like takes.

### What "Match levels" does, and what it deliberately does not

One fader per take, anchored on the **median** of the measured levels. Not the
quietest (that would drag the loud take 21.7 dB down into the same hole) and not
the loudest (that asks for a 12x boost the fader does not have — its range stops
at 2). On this session the median proposes `0.29` and `2.00` and lands the pair
about 5 dB apart instead of 22.

Boost is bounded twice: by the fader's maximum, and by the take's measured peak,
which is never pushed past −3 dBFS. `amix` runs `normalize=0`, so takes are
summed with nothing dividing them down and a boost spends real headroom.

A take that cannot reach the target is named in the note, because at that point
it is a **recording** problem: 22 dB below the rest means an input gain that was
never going to work, and the fix is before the next round, not in the mixer.

It moves faders and nothing else — no compression, no per-take dynamics, and the
reference is left alone. And it is a button, never automatic: levels are a
musical decision (a backing part is *meant* to sit under a lead), so this
proposes the starting point a host would set by ear. Same rule the three
alignment measurements follow.

## The master gain, and why the faders still mean what they meant

`amix` runs with `normalize=0`, so until 2026-09-04 the **absolute** value of the
per-track faders also set the loudness of the render. That made one control do
two jobs: a host who pulled a dominant take down so a quiet one could be heard
made the whole mix quieter, and could not fix that without undoing the balance
they had just set. Measured on the two-machine session: matching two takes
21.7 dB apart cost 9 dB of output level (−24.5 → −33.4 dBFS) with 14 dB of
headroom sitting unused.

The render now measures its own peak and scales the finished mix to sit at
`MASTER_TARGET_PEAK_DB`. **It cannot change the balance**: every track is
multiplied by the same number, so every ratio between them survives exactly.
Measured on the same session, component shares of the mix before and after the
master:

```
matched, no master     ref 37.4 %   A 45.8 %   B 16.5 %
matched, with master   ref 37.4 %   A 46.1 %   B 16.3 %
```

That is measurement noise, not a change. **This is the whole reason it is a
plain `volume` and not `loudnorm`, `dynaudnorm` or a limiter** — those act
differently depending on what is playing, which does change the balance and does
change the music.

It also closes a silent failure: with `normalize=0` and faders that go to 2, a
busy round could sum past full scale and clip with nothing reporting it. The
gain is as free to be negative as positive, so the same step that lifts a quiet
mix pulls a hot one back. The host sees the applied gain under the master
player, in amber when it is negative.

### Two passes, and why not one

The graph renders to an uncompressed intermediate with an `astats` tap spliced
on the end (it passes audio through untouched, so the peak costs nothing on top
of a mix that already decodes every take), then a second, cheap ffmpeg encodes
that file to Opus with the gain. Measuring in a separate full pass would have
decoded every take twice — roughly 30 s of extra wall clock on an eleven-take
five-minute round with the band waiting. The intermediate is `pcm_f32le` because
a sum that goes past full scale has to stay measurable, and s16 would clamp it
to exactly 0 dBFS and hide the clipping this exists to catch. It is deleted in a
`finally`: at ~140 MB for five minutes it is not something to leave behind.

### Why the target is −2 dBFS

The peak is measured on the uncompressed render, but what ships is Opus, and a
lossy codec does not reproduce sample values exactly. Measured: a render that
landed at −1.08 dBFS at its native 48 kHz peaked at **+1.95 dBFS** when the same
delivered file was resampled to 16 kHz mono — resampling reconstructs between
the samples and the reconstruction overshoots. Any playback chain that resamples
sees that, and a 16-bit output stage clips it. At −2 the delivered file measures
−1.95 dBFS at native rate and stays under the ceiling through a resample.
