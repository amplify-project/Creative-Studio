# Latency calibration — how the measurement works, and what is still wrong with it

`components/Play2GetherCalibration.tsx`. Read this before changing anything in
`runAcousticTrial`; several of its choices look arbitrary and are not, and the
one genuine improvement left is bigger than it looks.

## The measurement is differential, and that is the whole design

Two sounds are emitted per trial, and only the **gap between them** is used:

| | route | purpose |
|---|---|---|
| **marker** | `markerGain.connect(workletNode)` — **straight into the capture graph, never through the speakers** | a fiducial that lands in the recording at exactly its scheduled time |
| **click** | `clickGain.connect(ctx.destination)` — out of the speakers, back in through the mic | the thing whose round trip is being measured |

```
latencyMs = ms(clickIdx - markerIdx) - SCHEDULED_GAP_MS
```

Because the marker is injected digitally it cannot be moved by output latency,
so it is a fixed reference inside the capture timeline. **Do not "fix" this by
routing the marker through the speakers** — the whole point is that the
measurement does not care when the AudioContext started.

A consequence worth stating, because it has misled at least one investigation:
the `<audio>` playback fallback's unmeasured start delay does **not** corrupt
calibration. It affects the round, not this number.

## The window budget

Everything is scheduled from `startAt = ctx.currentTime + START_AT_LEAD_MS/1000`,
so the buffer must hold the lead-in as well as the trip:

```
t=0     capture gate opens ({cmd:"start"} to the worklet)
t≈50    startAt                         START_AT_LEAD_MS
t≈150   marker lands                    startAt + MARKER_OFFSET_MS
t≈350   click emitted                   startAt + CLICK_OFFSET_MS
t≈350+RT click arrives at the mic
t=1430  end of buffer                   RECORD_MS
```

`RECORD_MS` used to be a flat `900` commented as "long enough for up to ~600 ms
BT latency". It was not — the lead-in ate 50 of them, leaving ~550, and the
comment kept promising 600. It is now **derived** from the same constants that
schedule the clicks, so the two cannot drift apart again:

```
RECORD_MS = START_AT_LEAD_MS + CLICK_OFFSET_MS + MAX_MEASURABLE_RT_MS + TAIL_MS
          =        50        +       300       +        1000          +   80
```

**Empirically confirmed 2026-08-26**: a control run on a wired laptop reported
`markerMs = 150.2`, matching the model to 0.2 ms.

A click peak within `EDGE_GUARD_MS` (40) of the end of the capture is now
**refused** rather than reported. A click that lands outside the window still
leaves `peakIn` matching the loudest thing inside it, and that produces a
confident, repeatable, wrong number — the exact failure this measurement exists
to prevent.

## Reading a calibration run

Every run emits one `p2g_calib` beacon on the connection-log pipeline, **on
failure as well as success** (a failed calibration previously left no
server-side trace at all, so "it wouldn't calibrate" was indistinguishable from
"never tried"). Per-trial values go as arrays because the failure modes show up
as one bad trial among good ones.

A healthy control run, wired, for comparison:

```
markerMs 150.2 · clickMs 469.3 · gapMs 319.1 · latencyMs 119
outputLatency 67 ms · trackLatency 23 ms · baseLatency 11.6 ms
clickPeak 0.0784 · markerPeak 0.5343 · noiseFloor 0 · capturedMs 1430
sampleRate 44100 · trackSampleRate 44100 · aec/ns/agc all false
```

The arithmetic closes: 67 ms out + 23 ms in = 90 ms of digital path, measured
119, leaving ~29 ms for air and the ADC. That is what a believable run looks
like.

What each field decides:

- **`markerMs`** should be ≈150. Anything else means the timeline model above is
  wrong and nothing downstream should be trusted.
- **`trackSampleRate` / `trackDeviceId`** against the same person's `p2g_take`
  `sampleRate`. Calibration opens its **own** `getUserMedia` with AEC/NS/AGC
  off, which is the request most likely to make macOS or a Bluetooth stack
  re-pick a profile or device. If they differ, the number is correct for a path
  the round never used. This code has already been bitten by that class of bug
  once on the buffer-size axis — see the `latency` constraint comment.
- **`proc`** — whether the three "off" requests were honoured. AEC left on means
  the click is being cancelled by design, and the trial cannot succeed.
- **`clickPeakMs` vs `capturedMs`**, together with a large spread — the buffer
  edge.

## What the five trials do and do not protect against

`TRIALS = 5`, `MIN_SUCCESSFUL_TRIALS = 3`. `summariseTrials` drops the highest
AND lowest and averages the middle three; `SPREAD_LIMIT_MS = 50` on the kept
trials raises the amber "unstable" warning.

- **Random contamination** — a cough, a chair, a door — lands in one trial and
  is trimmed away. This is well covered; do not add machinery for it.
- **Systematic contamination** — a steady hum, or the click consistently
  arriving too weak — hits all five, so they *agree with each other*, the spread
  stays small, and the trimmed mean returns a wrong number with a green tick.
  **This is not covered**, and it is the shape of the open field case below.

## Open: a participant whose calibration reads low

Field session 2026-08-26. A Bluetooth participant on macOS recorded at 16 kHz
(HFP) and calibrated to 321 ms, while the host had to dial in more than 500.
Three readings still fit, and nothing logged at the time separated them:

1. **Calibration was right; the deficit is the singer.** A 300 ms Bluetooth
   monitor makes a person lag, and no calibration can measure that. Same
   conclusion the click rig reached once before.
2. **Calibration measured a different audio path than the round recorded.** See
   `trackDeviceId` above.
3. **The click landed outside the old 900 ms window.** Weakest of the three: the
   reported value repeated across trials tightly enough to pass the spread
   check, and noise does not repeat.

## Deferred improvements

**Matched filtering — the real one.** `makeClick()` generates 5 ms of white
noise with an exponential envelope, and the code therefore knows exactly what
waveform it sent. Detection then throws that away:

```ts
const clickRegion = peakIn(clickSearchStart, writeIdx);   // "loudest sample"
```

Cross-correlating the capture against the click that was actually sent would
find it well below the room noise floor — and white noise is the *ideal* signal
for that, because its autocorrelation is a sharp spike. The current design
already generates the perfect signal and then discards the advantage. This
would address all three weak-click hypotheses at once.

Not done because it is a rewrite of the detection path, not a constant, and
because there is still no data from the affected machine. Do not attempt it in
the week before a field session.

**The noise floor is measured from digital silence.** `noiseEnd = toIdx(50)` is
*exactly* the `startAt` lead-in, during which the mic has not started
delivering — the control run above reported `noiseFloor` of exactly 0, not a
small number. Every noise-relative threshold therefore collapses to its absolute
floor:

| threshold | designed | effective |
|---|---|---|
| marker | `max(0.15, 8 × noise)` | 0.15 |
| click | `max(0.015, 6 × noise)` | 0.015 |
| onset | `max(0.25 × peak, 3 × noise)` | 25 % of peak |

The relative term is what the code's own comment calls the thing that makes it
"immune to the false early trigger", and it is inert. The fix is to move the
window to 50–150 ms — real room audio, after the mic wakes up and before the
marker — which already exists in every capture. Small, but deferred until the
field logs say a weak click is actually the problem; matched filtering would
subsume it anyway.

**Raising the click level is not available.** `clickGain` is already 1.0, full
scale. What comes back (`clickPeak`) is a function of the user's speaker volume
and mic gain, which is why the error copy asks for more volume rather than
turning something up in software.

## The calibration round (2026-09-03)

`startCalibRound` in `app/hooks/usePlay2GetherSession.ts`, `CalibRoundCard` in
the host panel, `CalibRoundPanel` in `Play2GetherCalibration.tsx`, and
`app/api/play2gether/calib/route.ts`.

The measurement above is unchanged — same five trials, same trimmed mean, same
spread check, same `p2g_calib` beacon. What changed is **who starts it**.

As a per-person button it was something every musician had to remember,
understand, and get right alone. On 2026-08-31 three of eleven simply never
pressed it. As a round the host presses once, the whole band is measured in
about fifteen seconds, and the host can see at a glance who came back with a
number and who did not — which is the same argument that made a sync round a
round rather than a button, applied to the thing it replaced.

**One definition of the measurement, two ways to start it.** The trial loop
moved out of `CalibrationFlow` into `runCalibrationRun`, which both the button
and the round call. Two copies would have been two ways to trim the trials, to
count a failure, and to decide what "unstable" means — and the round's whole
claim is that its number is the number the button has always produced.

### Everyone at once, and the one thing that makes it unsafe

Participants are remote, so each mic hears only its own room. There is exactly
one path by which one player's click reaches another player's microphone, and it
is not the air: **LiveKit**. Music mode publishes with echo cancellation off
(`AUDIO_MODE_PRESETS`), so every click is broadcast to the room and comes back
out of everyone else's speakers, into the mic that is at that moment hunting for
its own click. Eleven players is ten extra clicks per trial, arriving at
whatever delay the network felt like.

That is a **systematic** contaminant — the failure mode the five trials above do
NOT protect against. It would hit every trial, they would agree with each other,
the spread check would pass, and the host would be handed a confident wrong
number with a green tick.

`silenceRemoteAudio` mutes every remote participant's playback for the duration
and restores it afterwards. Playback only: the mic is never touched, because
publishing is serialized behind `runAudioOp` in MediaControls for reasons that
cost a field session to learn, and a measurement has no business reaching into
it. The round also clears `playRehearsal` / `playResult`, since ten seconds of
the reference playing into everyone's mic is ten seconds of something louder
than the click to measure by mistake.

### The lead-in is the feature, not padding

`CALIB_ROUND_LEAD_MS` = 6 s, shown as a countdown on every participant's own
screen with one instruction: **hold one earcup against your microphone**.

The mic has to hear the click or there is nothing to measure, and that failure
is not loud: see `p2g-calibration-zero-means-click-unheard` — the old detector
latched onto room noise and reported a confident number near zero. The whole
round is over in ten seconds, so there is no reacting to it once it has begun.

**"Earcup against the mic", not "headphones off", and the order is the point.**
Both make the click audible to the mic, and they measure different things:

| | click goes out of | measures |
|---|---|---|
| earcup held to the mic | the **headphones** — their buffer, their Bluetooth | the output path the take is actually monitored on |
| headphones off | the **speakers** | a path the take was never recorded through |

The second is the one standing objection to calibration as a mixing number, and
the first simply removes it. It is very probably what the 2026-09-03
measurement did, and why its 135 ms matched the take instead of describing a
different route. Speakers remain the fallback for someone who cannot get the
earcup to the mic — a phone held at arm's length, a headset with a boom that
puts the capsule the wrong way round — and their number should then be read as
describing their speakers.

Two consequences worth keeping straight:

- The air gap shrinks to a centimetre or two, i.e. ~0.06 ms. It was never
  significant (~1 ms per 34 cm) and now it is nothing.
- Nobody has to take anything off, which was the practical objection to
  calibration in the first place and the reason it kept not being done.

`calibRoundAt` is a shared-state field of its own, deliberately **not** a third
`roundKind`. A calibration round records nothing, uploads nothing and produces
no take, so it must not touch `clapAt` or `status` — everything those two drive
(prewarm, start gate, reference schedule, upload stagger, the phase machine)
would arm itself for a round that is never going to happen. The session stays
exactly where it was and a ten-second measurement runs on top of it.

Two guards on the trigger, both load-bearing:

- **A join window** (`CALIB_ROUND_JOIN_WINDOW_MS`, 4 s). `calibRoundAt` sits in
  shared state indefinitely, so without it every late joiner and every panel
  remount would start clicking to itself, possibly in the middle of a take.
- **Not during `countdown` or `recording`.** Gated on the derived *phase*, not
  on `status === "active"`, which looks like the same test and is not: a sync
  round leaves the status at `"active"` for as long as the session lives (doc
  11, "Running two in a row"), so a status test would refuse every calibration
  round run after a sync round — which is exactly the order a host runs them in.

### It seeds the mixer now, and the sync round fills the gaps

This reverses doc 11's ordering, on field evidence from 2026-09-03. Same person,
same take:

```
calibration round   135 ms
sync round           85 ms ±5
aligned by hand     135 ms          ← the answer
```

Doc 11 predicted that 50 ms gap and read it the other way up. It is in that doc
already, under "a predictable click may be measuring the wrong thing": a sync
round measures the device **plus** where the player sits against the click, and
a player settled into a metronome *anticipates* it — which is cancelling, by
hand, part of the very latency being measured. Their four-rounds-in-a-row
convergence (118 → 130 → 101 → 87 ms) is that effect, not people getting better
at being measured. And the human term does not transfer: the same doc measured
click-to-song differences of 53 and 108 ms on two takes of one piece, so it is
not a constant that can be subtracted from anything.

The device term *is* constant over a session, and this measures it alone,
acoustically, with nobody playing.

So the precedence in the host panel's poll is: **calibration, then sync round,
then nothing.** The take's own `clapOffset` — the browser's guess — remains
excluded, for the reason doc 11 gives.

The per-take drawer shows **both** numbers when both exist, with either
clickable. The difference between them is not noise: it is how far ahead of a
click that person plays, and it is not visible anywhere else.

### The limitation that used to be listed here, and what happened to it

Every previous version of this doc carried a caveat: calibration measures
through the **speakers** while the take is performed on **headphones**, so the
number describes a path the take was not recorded through. Doc 11 quotes it as
the reason calibration could not be a mixing number.

**The earcup instruction removes it**, and that is why the instruction is worth
this much text. The click leaves through whichever output the browser is using;
holding the earcup to the mic means that output is the headphones, Bluetooth
latency and all. The measurement is then of exactly the path being asked about.

What survives of the caveat is a reading rule rather than a defect: **a number
is only about the output device the click actually left through.** Someone who
takes their headphones off is measuring their speakers, and if they then perform
on a Bluetooth headset their number is wrong by however much those two paths
differ — which on Bluetooth is 100–300 ms, not a rounding error. That is not
detectable from the number, so it is a thing to say out loud when starting the
round, and a reason to prefer the sync round or the slider for anyone who had to
do it the other way.

And the deferred improvements above are still deferred, still in the same order,
and matched filtering still subsumes the noise-floor fix. Running the
measurement on eleven devices at once does not make any of them detect better.

## A failed round no longer deletes a good number (2026-09-04)

`POST /api/play2gether/calib` with `failed: true` used to delete that person's
`calibOffsets` entry, on the argument that a stale measurement standing in for a
failed one is how somebody gets mixed against a figure that no longer describes
their device.

That argument was made about a **per-person button**, where a failure means "the
device could not be measured". It does not survive the move to a **round**,
where the whole band is measured at once and a single trial fails for reasons
that have nothing to do with the device — somebody talks over the click, a chair
moves, a mic is muted at the wrong moment. Deleting a good number from ten
minutes earlier left that person with nothing, and the mixer then falls back to
the browser's own estimate, which was measured at **61–412 ms on the same people
in one session** on 2026-08-31.

So a failure now keeps the previous measurement and says so in the failure it
reports (`… — keeping their earlier 135 ms`). The host still gets both facts,
and the calibration card's per-person clear is the way to throw a number away
when the device has genuinely changed.

The stale-number risk is real but smaller than what it replaced: a device's
round trip does not change while the session runs unless the person changes
their audio path, and if they do, they are told to re-run.

