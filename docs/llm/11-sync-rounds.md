# Sync rounds — measuring where a musician puts a beat

`app/lib/p2gSync.ts`, `app/api/play2gether/syncDetect.ts`, the `kind=sync`
branch of `app/api/play2gether/record/route.ts`, and `SyncRoundCard` in
`components/Play2GetherHostPanel.tsx`.

Read this before changing `SYNC_BPM`, the lag search range, or the vote — the
first two are load-bearing on each other and the third is not the obvious thing.

## What this fixes

The 2026-08-31 field session, the first with a real band. Eleven players, and
the mix would not line up **even by hand**. Two separate reasons, from the
`p2g_take` beacons of that night:

- **The offsets were all over the place.** Among the players who had
  calibrated, `clapOffsetMs` ranged 70 → 237 ms. Three of eleven had
  `calibrated=false`, so their offset was the browser's own estimate, and it
  was both large and unstable round to round (384 → 412, 61 → 63). At 120 BPM a
  semiquaver is 125 ms.
- **There was nothing to align to.** With a singer you can see the syllable in
  the waveform. With a bass, a pad, a saxophone, you cannot, and the host is
  guessing at which bump is the downbeat.

The first instinct was to infer the alignment from the audio — cross-correlate
each take against the reference. That was **rejected on field experience**, and
correctly: correlating musical content across different instruments is
unreliable, the correlation peak is broad, music is periodic, and a musician
plays with expressive timing, so the peak's maximum is the average of a
distribution rather than "the sync point".

So the fix is not to infer the alignment point. It is to **create one**, which
is what a clapperboard is for and why film has never used content matching.

## The quantity being measured

This is the part that matters, and it is not the same quantity acoustic
calibration measures.

`Play2GetherCalibration.tsx` measures a **device round trip** — see
[10-calibration-detection.md](10-calibration-detection.md). What the mixer
actually needs is where a person's notes end up relative to the beat, which is:

```
device round trip  +  how that human places themselves against what they hear
```

The second term is not an error to be removed. A drummer who feels 200 ms of
monitor latency **pushes ahead** to compensate; subtract their full measured
latency and you have moved them to the wrong place with great precision. This is
the same conclusion the click rig reached in
`p2g-calibration-latency-parity` ("the +80 was the singer"), arrived at from the
other direction.

A sync round measures the sum, per person, through the audio path they will
actually record on.

## The round

**One bar of count-in, then four bars of quarter notes on a click.** Click only
— no reference.

Everyone at once: participants are remote, so each mic hears only its own
player, and there is no crosstalk to serialise around. The measurement itself is
~13 s; with the upload stagger the host waits ~30 s for the whole band.

**Why quarter notes and not one hit.** A single hit measures a *reaction*, and
gives one sample: no median to be robust with, and no scatter to say whether the
number means anything. Four bars lets the player settle into the click, so what
is measured is their steady-state placement, which is what they will do when the
song is playing. The first bar is discarded (`SYNC_WARMUP_BARS`) — that is the
player finding the click, not playing to it.

**What they play.** The sharpest attack the instrument has: muted string, rim or
closed hat, hard tongued staccato, pizzicato, "ta ta ta ta". A pad patch does not
measure; clap instead. A clap costs about 1 ms per 34 cm of extra distance to the
mic, which is nothing — but prefer the instrument, because a drummer's placement
on their kit is not their placement when clapping.

**Headphones, not speakers.** See the vote, below.

## The arithmetic

Sample 0 of the take is wall-clock `localClapAt + captureDelayMs`. Metronome
beat `k` is at `localClapAt + k·beatMs` (the metronome is phase-locked to the
same clap, k=0 on it). So in take time:

```
expected_k = k·beatMs − captureDelayMs
d_k        = detected_k − expected_k          positive = played late
```

And `median(d_k)` drops straight into the mixer's fine-tune slider with no
conversion, because the mix shifts a take by `netDelay = captureDelayMs − manual`
(`mix/route.ts`):

```
(captureDelayMs − manual) + (k·beatMs − captureDelayMs + d_k)  =  k·beatMs + d_k − manual
```

which is `k·beatMs` exactly when `manual = d_k`. **If you change one side of
this, change the other.**

## The two traps, both of which were live

Both were found by `scripts/p2g_sync_fixtures.py`, which generates synthetic
takes with a known lag. Every adversarial case in it is a failure the detector
actually had.

### 1. Beat aliasing — and why voting does not fix it

Matching each beat to its nearest onset fails the way all content alignment on
music fails: a player 300 ms late at 120 BPM (beat 500 ms) is nearer the *next*
beat's slot, and scores as 200 ms early.

Estimating one lag for the whole take by voting looks like it fixes this. **It
does not.** A lag and that lag ± one beat explain the same onsets equally well;
only the take's start and end boundaries separate them, which is a one-vote
margin that evaporates the moment a player fluffs their first hit. Measured: a
450 ms player at 120 BPM came back as **−49 ms, 12 of 12 beats matched, zero
scatter** — confident, repeatable, and a whole beat wrong.

What fixes it is arithmetic, not detection. The round runs at a fixed tempo
whose beat is **longer than the entire range of lags worth searching**, so no
alias of a valid lag is itself a valid lag:

```
beat(SYNC_BPM = 80) = 750 ms   >   LAG_MAX_MS − LAG_MIN_MS = 600 ms
```

`assertUnambiguous()` guards that inequality and refuses rather than reports. It
cannot fire at `SYNC_BPM`; it exists so that raising the tempo, or widening the
lag range, fails loudly instead of quietly returning answers a beat out.

**This is why the sync tempo is NOT the song's tempo.** The cost is real but
small: placement does drift with tempo, but that drift is entirely in the *feel*
term, and feel is the small term — the dominant part is the device round trip
(70–320 ms across the band on 2026-08-31), which does not care about tempo.

#### The window had to learn to slide (2026-09-02)

The inequality above guarantees that **no alias of an in-window lag is itself
in-window**. It does not guarantee — and this was read as if it did — that no
lag *outside* the window aliases *into* it. Those are different statements, and
the second one is false:

```
−80 ≤ L − 750 ≤ 520     →     670 ms ≤ L ≤ 1270 ms
```

Anyone whose real lag lands in that band is reported as `L − 750`. And the
report is immaculate: it matches fifteen of the sixteen beats (the alias loses
only the one that falls off the start of the take), it carries the player's own
scatter so `spreadMs` looks human, it sits nowhere near a boundary so
`atSearchEdge` stays quiet, and it clears `MIN_HITS` and `SPREAD_FLOOR_MS`
comfortably. **No quality indicator this detector has can see it.** Fixture
`Q_alias_lag950_NEEDS_DEVICE` is that case: a true 950 ms came back as
`+202 ±4`.

The old ceiling made this reachable in ordinary use. It was set at 520 on the
reasoning that "past half a second of monitor latency they are not playing with
anyone" — a judgement about musicianship standing in for a measurement limit.
The 2026-09-01 home session, one host and one participant, disproved it: that
participant's own browser reported its output path stepping **280 → 520 → ~1000
ms** across one hour, in three flat plateaus, with nothing in the app aware it
had moved. Every round after the second step was unmeasurable in principle, and
the ones in the aliasing band came back as confident numbers a beat out.

So the window keeps its width — the inequality is untouched — and moves its
**centre** to the device's own reported round trip (`clapOffset` on the upload:
`outputLatency + baseLatency + mic latency`), spanning `FEEL_BACK_MS` behind it
to `FEEL_FWD_MS` ahead. With no usable figure it falls back to `−80…520`, where
it has always been.

**This is not doc 11's rehabilitated `clapOffset`, and the distinction is the
whole argument.** That number is far too unstable to mix with — it ranged 61–412
ms on the same people in one session, which is precisely why the seeding
fallback was removed. It is never used as a value here. It is only ever asked
which of several candidate answers *750 ms apart* is the plausible one, and for
that a ±200 ms estimate is more precision than the job needs. A number too noisy
to mix with can still be good enough to disambiguate with.

**And it is cross-checked, because a device can under-report.** `outputLatency`
is not implemented everywhere, and where it is missing `referenceOutputLatencyMs`
contributes only `baseLatency` — so a browser with a 900 ms output path can
report 25 ms. Not *absent*, which falls back safely, but confidently small,
which centres the window in the wrong place and aliases exactly as before. So
the detector also scores the whole physically possible range, and if the best
explanation anywhere beats the best one inside the window by `ALIAS_MARGIN`, the
window is in the wrong place and it refuses, naming the delay it actually found.
The audio cannot *resolve* the ambiguity alone — the true lag beats its alias by
one beat's energy in sixteen, ~6 %, which is real but far too thin to trust as a
verdict — but it can reliably *detect* that the window is misplaced.

### 2. Click bleed beats the player, if you count events

A participant monitoring on speakers gets the metronome bled back into their own
mic, and that bleed is machine-perfect: sixteen clicks exactly one output-latency
after the grid, with zero human scatter. Against a vote that **counts beats**, it
wins. Measured: a take with click bleed 20 dB below the instrument reported
**41 ms** — the player's output latency alone — instead of their real 220 ms,
with zero scatter and every beat matched. That is the doc-10 failure mode again:
a systematic contaminant that all trials agree on.

The vote therefore weighs **energy**, not events: the instrument is the loud
thing, so it takes the vote back. Do not change this to a count.

**And that is not enough, which the first field run proved.** Energy weighting
works when the bleed is faint. It does not on a laptop, where the built-in mic
sits centimetres from the built-in speaker and the click returns as loud as the
player. Same person, 2026-09-01: on headphones **+101 ms ±14**, on speakers
**+177 ms ±0** — a flawless measurement of their machine's acoustic round trip,
and not the quantity anyone wanted.

So there is a backstop, and it works on a property no human has:
`SPREAD_FLOOR_MS`. A scatter below 3 ms across a dozen beats is not a person —
a good drummer manages five, the steadiest hand clapping measured was twelve.
Near-zero scatter means something machine-generated was measured, and there is
exactly one machine-generated periodic signal in earshot.

It refuses rather than correcting, because a player on speakers is not
measurable **in principle**: whatever is done about the bleed, they are hearing
the click from the room, and the latency structure the round exists to capture
is not the one they have.

### 3. The click itself was 60 ms late (2026-09-02)

Every number this round produced before 2026-09-02 was ~60 ms too large, for
everyone, and nothing in the detector could have known.

The metronome scheduled its ticks as `ctx.currentTime + 0.06 + (tickMs − now)`.
The `0.06` was commented "small lead so the first tick isn't dropped", but it
was added to *every* tick rather than the first, so the whole click grid sounded
60 ms after the instants it was supposed to mark. `scheduleReference` and the
capture start gate carry no such lead, so the click was the only displaced thing
in the round.

That matters here more than anywhere else in the feature, because a sync round
is **click-only** — the reference is deliberately silenced, so the click is the
only timing signal the player has. The detector compares against the ideal grid
(`expected_k = k·beat − captureDelayMs`), the player plays against what they
hear, and the difference went into `d_k` as a constant:

```
d_k = 60 ms  +  output latency  +  feel
```

Being constant, it did not disturb the band's coherence *with each other* — it
pulled the whole band 60 ms ahead of the reference, which reads as "everything
sits slightly early" and gets dialled out by hand without ever being diagnosed.
The 2026-09-01 session reported exactly that: *"la mayoría adelantadas, algunas
bien, unas pocas retrasadas"* — the majority being the lead, the few late ones
being the aliasing and the refusals above.

The four consecutive rounds quoted earlier in this doc were therefore really
`+58 +70 +41 +27`. The learning effect they demonstrate is unaffected; the
absolute values were not.

Dropping a tick already in the past is what the `continue` in that loop is for,
and for one tick that is the correct answer: you cannot sound an instant that
has gone. **Do not re-add a lead to save it.**

### 4. The click and the reference were on different audio contexts (2026-09-02)

A sync round's entire job is to carry a number from one monitoring path to
another: it measures a player against the **click** and the mixer applies the
result to a take the player monitored on the **reference**. That transfer is only
valid if the two reach the ears at the same delay. They did not, and nothing in
the system could see it.

The reference played on the ref player's long-lived `AudioContext`; the
metronome created a `new AudioContext()` per round and closed it after. Nothing
makes two contexts agree on their output latency.

Measured, with the player removed from the loop entirely — both rounds
monitored on speakers so the mic records what the ears would have heard, then
`scripts/p2g_monitor_latency.py` over the two takes:

```
click       +99.8 ms   (scatter ±0.4 — it is a machine, so this is exact)
reference  +124.4 ms   (correlation peak 65 ms wide; a 6 s reference is thin)
------------------
bias        +24.6 ms
```

Both paths share the same speaker→air→mic delay, so it cancels in the
subtraction and what is left is the difference between the two audio paths.

The fix is a single shared monitoring context (`getMonitorCtx`) that the
reference and the click both play on. Note the shape of it: the quantity is not
corrected, it is **abolished** — there is no longer a pair of latencies that
could disagree. Anything that measures and compensates instead would be one more
number to keep true.

Consequences worth not undoing: the context is never closed while the tab lives
(a new context is a new latency, which would silently invalidate every sync
offset measured before it), the metronome cancels its own scheduled oscillators
on cleanup rather than closing the context, and `destroyRefPlayer` disconnects
its nodes by hand because the context no longer takes them with it.

### Open: a predictable click may be measuring the wrong thing (2026-09-02)

> **Settled in the field, 2026-09-03, in favour of everything this section
> says.** The sync round no longer seeds the mixer; the calibration round does.
> Read on — the argument below is the reason, and it was written a day before
> the measurement that confirmed it.

Raised by the host, from the practical end: *"the sync round should be more
random, otherwise they can play the rhythm from memory"*. The doc's own field
data already said so and was read the other way up.

Four consecutive runs by one person are quoted above as evidence that people
settle: `+118 ±30 → +130 ±24 → +101 ±14 → +87 ±12`. Look at where they converge.
**Downwards, away from the physical path.** What improves with practice is not
the measurement but the player's ability to ANTICIPATE the click — and
anticipating is precisely cancelling your own monitoring latency. The better
they get at the task, the smaller the number and the less it describes anything.
Measured the same day: the click physically lands at +99.8 ms on that machine
and the round reported 82, i.e. the player sitting 16 ms ahead of a click they
were predicting rather than hearing.

**Randomising the click does not fix it**, and the reason is already in this
doc. An unpredictable click cannot be anticipated, so what gets measured is
REACTION TIME — 150–250 ms of a third quantity, with a variance far worse than
what it replaces. That is the same argument that chose four bars over a single
hit ("a single hit measures a *reaction*").

So neither is right, because the round is measuring two quantities at once:

- **the device path** — physical, exact, and measurable with no human at all
  (±0.4 ms scatter when the click is recorded back);
- **the player's placement on the actual song** — +37 and +92 ms on two takes of
  one piece, moving 55 ms between them. Not constant, does not transfer from a
  click, and no round can capture it.

The round measures neither well: the player cancels the first by anticipating,
and the second is not a property a once-per-session measurement can hold.

**Which is why acoustic calibration "gave more real numbers", as the host put
it.** It measured the device path alone, with no human in the loop. This doc
removed it for not including the human term; the evidence now says that term
does not transfer and is not constant, so including it added noise rather than
information.

**What would settle a redesign.** If the browser's own reported latency agrees
with where the click physically lands, the device half can be read for free on
every take — and it would then track the drift a once-per-session round cannot
(65 → 87 ms on a laptop in one afternoon; 280 → ~1000 ms on a phone in one
hour). The evidence so far is suggestive, not conclusive: the click measured
+99.8 ms and `base + out` on that machine ranged 76.6–98.6 across the session,
so the measurement sits at the top of the range but was never captured at the
same instant. `monBaseMs` / `monOutMs` / `micLatMs` now ride the `p2g_take`
beacon, and the metronome logs the same figures at every round, precisely so the
comparison can be made at the same instant instead of across an afternoon.

**And the comparison was pre-empted by the answer being already known.** The
browser's figure cannot be trusted anywhere, never mind on one machine:
`outputLatency` is a flat 10 ms fallback in Chrome whenever it does not know the
hardware, it is still unimplemented in WebKit (so absent on every iPhone and
iPad), and its Chrome value is documented as bouncing with no change to the
setup — which is what the 65 → 82 → 87 → 80 ms seen in one afternoon actually
was. Reading the device path off the browser is therefore not a design that can
be built, and the redesign is dropped.

`monBaseMs` / `monOutMs` / `micLatMs` stay in the beacon for the opposite
purpose: not to trust the number but to know **whose** number cannot be trusted.
A device reporting a flat 10, or 0, identifies itself.

It also retroactively justifies how `searchWindow` uses `clapOffset`: never as a
value, only to choose between candidates 750 ms apart, tolerant of ±200 ms of
error, with a cross-check that refuses when the audio disagrees. That is exactly
the amount of trust the number survives.

## The randomised click (opt-in, 2026-09-02)

The other half of the host's observation — that a steady click can be played
from memory — is answered by making it irregular. `syncJitterMs` in
`p2gSync.ts` moves each beat by up to `SYNC_JITTER_MS` from a seed that rides
the shared state, so the metronome that schedules the grid and the detector that
expects it derive the same sequence and cannot disagree. A fresh seed per round:
a repeated pattern would itself be learned.

**Stated cost.** This trades bias for variance and there is no guarantee it is a
good trade. A player who ignores the jitter and keeps their internal pulse gives
the same median with more scatter; one who chases every click drifts toward
reaction time, the 150–250 ms quantity `SYNC_BARS` exists to avoid. Where real
players sit between those is not knowable from here — which is why it is **off
by default** and why the host card says to watch `spreadMs` and turn it off if
the scatter grows without the offset moving.

**The unplanned payoff, which is bigger than the motivation.** A jittered grid is
aperiodic, so a lag and that lag ± one beat no longer explain the same onsets.
The entire aliasing problem — the tempo constraint, the narrow window, the
device-latency tiebreak, the out-of-window cross-check — exists only because a
periodic grid is ambiguous. With jitter on, `searchWindow` opens to the full
physical range and `assertUnambiguous` is skipped, and fixture
`S_jitter_lag950_NO_ALIAS` measures a 950 ms lag correctly **with no device
figure at all**. That removes the dependency on the one number this doc has just
finished establishing cannot be trusted.

**Tried in the field the same day, and withdrawn within the hour.** Two people,
claps and hand clicks, nothing measured. The cause was not the trade-off argued
above — it was an arithmetic error in the parameters:

```
SYNC_JITTER_MS = 45   >   VOTE_TOL_MS = 35
```

The jitter was set LARGER than the distance a hit is allowed to miss its beat
by. Musicians do not chase an irregular click; they hold their own pulse, which
is the skill they actually have. So their hits landed up to 45 ms from where the
detector looked, the ones past 35 did not vote at all, and the rest carried
~26 ms of scatter that was not theirs.

**So the idea is untested, not disproved.** The host control is gone and every
round now starts with amplitude 0; the seeded-grid machinery stays because it
costs nothing at 0 (`syncBeatMs` degenerates to `k * beatMs`). Anyone reviving it
must move `VOTE_TOL_MS` and `ACCEPT_TOL_MS` with the jitter, and should start
well under the tolerance — 10–15 ms — to find out whether that is even enough to
disturb anticipation before reaching for more. The question it was built to
answer is still open and still real.

What is lost with it is the aliasing payoff: the window narrows again and the
device-latency tiebreak goes back to carrying that weight.

## Acoustic calibration is back, optional (2026-09-02)

`CalibrationButton` / `CalibrationFlow` are wired into both panels again. What
changed since they were removed is not the argument that removed them — a sync
round still measures the player and calibration still does not — but that
calibration is now **the only latency figure that does not come from the
browser**. It measures the device acoustically, with no musician in the loop and
therefore nothing to anticipate.

What it is good for:

- a device reference number when the browser's is a fallback or absent;
- centring `searchWindow`, which is how a player past the default range gets
  measured at all on a plain round.

**What it still does not do is seed the mixer.** That fallback is what mixed
three of eleven players against a browser guess on 2026-08-31. Measured by a
sync round, or nothing.

> **Superseded 2026-09-03 — it seeds the mixer now, and this one does.** The
> sentence above conflated two different things under "calibration": the
> browser's `clapOffset` *estimate*, which is what broke 2026-08-31 and is still
> excluded, and an *acoustic measurement*, which is not. On 2026-09-03 the two
> measurements disagreed by 50 ms on the same take (calibration 135, sync round
> 85 ±5) and aligning by hand said 135. Precedence is now calibration → sync
> round → nothing, and calibration is a host-run round rather than a button
> nobody presses. See ["It seeds the mixer now"](10-calibration-detection.md)
> and the closing section of this doc.

Its own limitation is unchanged and worth restating: it measures through the
**speakers**, and the player performs on **headphones**. Those are different
output devices with different latencies, so its number describes a path the take
was not recorded through.

> **Removed 2026-09-03.** Holding an earcup against the mic sends the click out
> of the *headphones* instead, so the measurement is of the path the take is
> monitored on. That is now the round's standing instruction, and speakers are
> the fallback. See [10-calibration-detection.md](10-calibration-detection.md).

## Refusals, and why they are refusals

Every one of these returns `ok: false` with a sentence for the player, surfaced
in their own panel (not just the host's) because in every case they are the only
one who can act on it. A refused re-run also **deletes** the previous number, so
a stale measurement can never stand in for a failed one.

| Symptom | What it means |
|---|---|
| `no onsets found` | Nothing above the noise floor. A silent take used to return a confident 182 ms. |
| `N notes were played but none line up` | The player did their job; the delay is past `LAG_MAX_MS`. This is a Bluetooth monitor path — the message says so, rather than telling them to play on the click, which they did. |
| `only N of 12 beats had a hit` | Genuinely missed beats, or an attack too soft to find. |
| `a beat of N ms is shorter than…` | The tempo guard above, now checked against the width actually searched. |
| `the notes fit a delay of about N ms, which is outside…` | The out-of-window cross-check. The audio has a clearly better explanation than anything the window allows, so the window is misplaced — usually a device under-reporting its own output latency. Refuses rather than picking the best of a set of wrong answers. |
| `the beats came back impossibly steady` | `SPREAD_FLOOR_MS`. The metronome was measured, not the player — they are on speakers. |
| `atSearchEdge` (a warning, not a refusal) | The winning lag sat against the range boundary, so the real value may be outside it. Same discipline as `EDGE_GUARD_MS` in the calibration detector: a value with nowhere further to go is the boundary, not a measurement. |

The noise floor is taken from the **median frame of the take** — which in a sync
round is the silence between hits, so it is a real measurement. Worth contrasting
with doc 10's finding that the calibration detector's noise-relative thresholds
are inert because its noise window falls in the start-up lead-in, before the mic
delivers, and reads exactly zero.

## What it does NOT measure

Be honest with the band about this. A sync round measures placement **against a
click at 80 BPM**. Placement against the actual song changes — further back in a
ballad, further forward in something fast — and that is tens of milliseconds of
musical judgement, not measurement.

**And that gap was measured on 2026-09-02, and it is bigger than "tens of
milliseconds".** Same person, same machine, same session, with the audio path
measured independently (see trap 4, and subtracting the ~123 ms this machine's
reference path costs):

```
against the click   −16 ms      (they sit slightly AHEAD of a metronome)
take 1 on the song  +37 ms
take 2 on the song  +92 ms
```

So the click-to-song difference was 53 and 108 ms, and it moved 55 ms between
two takes of the same song. That is not a defect and no measurement can remove
it: a sync round measures once, and this quantity is not constant even for one
player on one piece.

It takes the band from ~350 ms of spread to something far better, and the
remainder is the host's ear and the mixer's slider — which is not a finishing
touch but part of the method. Do not promise a residual in the tens of
milliseconds; on this evidence it is the size of each player's own consistency.

**And it measures someone learning the task, if you only run it once.** Four
consecutive rounds by the same person on 2026-09-01, in order:

```
+118 ms ±30      +130 ms ±24      +101 ms ±14      +87 ms ±12
```

The scatter halves and the offset falls ~35 ms with it. That is not drift in the
device — the device term cannot move — it is a person learning to anticipate the
click, which is what everyone does as they lock into one. **Run the round twice
and keep the second.** The host card says so.

## Acoustic calibration is out of the flow (2026-09-01)

The sync round replaced it. Both were reachable for a while and that was the
wrong answer: two numbers measuring almost the same thing, sometimes disagreeing,
leaving the host to adjudicate mid-session between a device round trip and a
measurement of the actual player — and the answer was always the player, because
the sync round measures the same path PLUS the human term, through the audio path
the take is recorded on.

So the calibration button is gone from both panels, and the mixer's per-take
readout shows the sync measurement instead of "Calibrated / Not calibrated".

**And the fallback went with it.** Seeding no longer drops back to `clapOffset`
when a player has no sync round. That fallback is exactly what broke
2026-08-31: three of eleven never calibrated, so they were mixed against a
browser estimate that ranged 61–412 ms and moved between rounds. A confident
wrong correction is worse than none, because none is *visible* — an unmeasured
take sits where it was captured, obviously late, and with the mixer zoom it can
now be fixed by hand. Measured, or nothing.

`clapOffset` is still recorded on every take, and `runAcousticTrial` still
exists. Nothing reads them.

**Open: delete the calibration code.** `Play2GetherCalibration.tsx`,
`calibratedLatencyMs` and its localStorage key, the `clapOffset` / `calibrated`
query params on the record route, and the `p2g_calib` beacon. It was left in the
tree on purpose — doing that deletion three days before the 2026-09-04 field
session is precisely what doc 10 says not to do. The one thing worth keeping in
mind while deleting: the device number in isolation is what splits a sync offset
into "slow audio path" and "this player drags", which need different responses,
so it is worth preserving as a debugging tool even once it is out of the product.

**The scatter is half the output.** A player whose `spreadMs` is 40 ms has no
single correct offset, and no amount of nudging will place their take. The host
needs that in bar 2 of the rehearsal, not in the mix — which is why the host card
colours on scatter, never on the offset.

## Running two in a row

A sync round has no mix step, and `status` stays `"active"` once a round ends —
so `derivePhase` returns `"uploading"` indefinitely. For a take round the mix is
what moves the session on; for a sync round nothing does. Gating the Run button
on `phase === "uploading"` therefore left it disabled forever, and the host could
only run a second round after doing something unrelated. Gate it on **this
client's own upload still being in flight** (`syncRoundInFlight`), not on phase.

The session is deliberately NOT bounced back to `"preparing"` when a sync round
finishes, tempting as it looks: the participant's own verdict screen renders on
`phase === "uploading"`, so flipping the status would yank their result out from
under them while they are reading the one message only they can act on.

## Where the number lives

`session.json` → `syncOffsets[participantId]`, keyed by the **person**, not the
take. It therefore:

- seeds the mixer slider for every take that person records for the rest of the
  session (`Play2GetherHostPanel`'s poll prefers it over `clapOffset`),
- survives takes being deleted and re-recorded,
- **survives `promote-mix`**, which clears `participants` but deliberately not
  this. Re-measuring the band on every layer would defeat the point.

Sync takes never enter `meta.participants`, so they cannot be swept into a mix.
The audio is kept (~1 MB, and the host may want to hear why a result looks odd).

## Where the number is actually applied — and where it is not

Only one place: **the initial value of that take's "Fine-tune sync" slider**,
from which it rides into ffmpeg as part of `participantOffsets` (`mix/route.ts`
turns it into `netDelay = captureDelayMs − manual`).

**And since 2026-09-03 it only gets that slot when the person has no calibration
round.** The precedence in the host panel's poll is calibration → sync round →
nothing; both are shown in the take's drawer and either can be clicked. Nothing
else about the arithmetic changed — a calibration figure drops into `manual` in
exactly the same units, which is why the swap is a one-line change in the
seeding and not a change to the mixer.

It changes nothing at record time. The musician hears the same reference at the
same instant and capture starts at the same clap whether or not they have ever
run a sync round. It is a mixing number, and it is discovered after the fact.

The seeding is keyed on **`uploadedAt` + the measurement's `measuredAt`**, and
both halves matter. Keyed on `uploadedAt` alone — as it was first written — a
take that had already landed kept whatever it was seeded with, so running a sync
round to fix an alignment problem did nothing to the takes in the mixer, which is
exactly backwards for the control that exists to fix them. Now a fresh
measurement re-seeds takes that are already there.

What it will not overwrite is a take the host has adjusted by hand
(`touchedOffsetsRef`, set by the slider, the drag and the arrow keys). An
automatic number is a starting point; somebody who has already looked at the
waveform outranks it.

## Running the fixtures

```
python3 scripts/p2g_sync_fixtures.py /tmp/syncwavs
npx tsc app/api/play2gether/syncDetect.ts app/api/play2gether/utils.ts \
    app/lib/p2gSync.ts --outDir /tmp/syncbuild --module nodenext \
    --target es2022 --moduleResolution nodenext --skipLibCheck --rootDir .
# then call detectSyncOffset() over /tmp/syncwavs/manifest.json
```

Requires numpy. Seventeen cases. Each should be scored **twice** — once with no
`deviceLatencyMs` and once with the manifest's `device` field — because the two
columns are the test: everything that fit the old window must come back
identical in both (the sliding window is a no-op for them), while K and Q must
refuse without a device figure and measure correctly with one. M, N and O refuse
in both. Clean takes land within 1 ms; a
slow attack reads ~7 ms late, which is correct — a slow attack genuinely starts
later than a stick click.

## The sync round stops seeding the mixer (2026-09-03)

One measurement in the field settled the question this doc had been circling
since it was written. Same person, same take, same session:

```
calibration round   135 ms
sync round           85 ms ±5
aligned by hand     135 ms          ← the answer
```

The host's summary: *"el del sistema es el bueno"*. The calibration round now
seeds the mixer's fine-tune slider; a sync round seeds it only for people
calibration could not measure.

**This doc predicted the 50 ms and read it upside down.** Everything needed was
already in "Open: a predictable click may be measuring the wrong thing":

- A sync round measures the device **plus** the player. A player settled into a
  metronome *anticipates* it, and anticipating is cancelling — by hand, badly —
  part of the very latency being measured. The four consecutive rounds quoted
  earlier (118 → 130 → 101 → 87 ms) converge **downwards, away from the physical
  path**. That is the effect, in this doc's own data, labelled as people
  settling.
- The player term does not transfer anyway. Measured here: click-to-song
  differences of 53 and 108 ms on two takes of one piece. A quantity that moves
  55 ms between two takes cannot be measured once and subtracted from both.

What is left after removing it is the device round trip, which *is* constant over
a session — and acoustic calibration measures exactly that, acoustically, with
no musician in the loop and therefore nothing to anticipate.

**The 2026-08-31 objection does not apply, and it is worth being precise about
why.** What broke that session was seeding from `clapOffset`, which is the
*browser's estimate* for anyone who had not calibrated — 61–412 ms on the same
people, moving between rounds. That is still excluded and always will be. An
acoustic measurement is a different object that happened to be stored in the
same field. "Measured, or nothing" survives intact; what changed is which
measurement.

**And the reason it can be trusted for a whole band is that it is now a round.**
As a self-serve button it was something each musician had to remember and get
right alone, and three of eleven never pressed it. The host now presses once and
everyone is measured together — see
[10-calibration-detection.md](10-calibration-detection.md) for the round itself,
the six-second "earcup against the mic" lead-in — which is also what makes the
number describe the headphone path rather than the speakers — and why every
remote participant's audio is muted while it runs.

### What a sync round is still for

It is not deprecated, and deleting it would lose three things nothing else
provides:

- **A measurement for anyone calibration could not reach** — no speakers, a mic
  that cannot hear the click, a device whose headphone path is nothing like its
  speaker path. Precedence is calibration → sync round → nothing.
- **`spreadMs`.** A player who scatters ±40 ms around a click has no single
  correct offset and no amount of nudging will place their take. Calibration
  measures a device and can never say this. The host needs it in bar 2 of the
  rehearsal.
- **The difference between the two numbers**, which is that person's own
  relationship to a beat — 50 ms of anticipation in the case above. Both are
  shown side by side in the take's drawer for exactly that reason.

The "open" question above therefore stays open in the only part that still
matters: whether an irregular click would measure a player's placement honestly.
Nothing here answers that, and the mixer no longer waits on the answer.

## Withdrawn, then demoted to a fallback — both on 2026-09-03

Two decisions in one afternoon, and the second one is the standing state.

**Withdrawn**, on the host's verdict after a day of field use: *"el sync round
falla mucho… nunca funcionó del todo bien"*. `SyncRoundCard` came out of the
panel and nothing seeded from `syncOffsets`.

**Back within the hour, in a smaller role**, on the host's own follow-up:
*"tocando una nota va bastante mejor, igual estaría bien dejarlo como opcional
si no funciona la calibración automática"*. One thing about the round had
changed and one thing had not — see "What you play" below — so it returns as
**the fallback for people acoustic calibration could not reach**, seeded below
calibration and never over it.

That the code was still in the tree to bring back is not luck. It is the same
decision taken about acoustic calibration on 2026-09-01, which is the only
reason *that* could come back on 2026-09-03 when its evidence turned. Two
features have now been saved by it in three days. Delete measurement code
reluctantly.

### The two failures, and why neither is a bug

**It reads low, systematically.** Three measurements now, all the same
direction:

```
2026-09-02   round 82        click physically at 99.8 ms
2026-09-03   round 85 ±5     calibration 135, hand-aligned 135
2026-09-03   round ~60       calibration ~130
```

This is the anticipation argument in "a predictable click may be measuring the
wrong thing", confirmed. A player settled into a metronome predicts it, and
predicting is cancelling by hand part of the latency being measured. The doc's
own four-rounds-in-a-row (118 → 130 → 101 → 87) converge downwards, away from
the physical path, and were read as people settling.

**It refuses, and the refusal is correct.** A real one from the field:

```
the notes fit a delay of about 1570 ms, which is outside the −80…570 ms
this round searched
```

The arithmetic closes exactly:

```
1570 − 2 × beat(80 BPM)  =  1570 − 1500  =  70 ms
```

The player **entered two beats late** and was otherwise ~70 ms behind — and with
a periodic click those two readings are the same audio. The detector found the
alias, saw it explained the take better than anything in the window, and refused
rather than reporting a number a beat out. That is the guard doing precisely its
job, and the advice it then gives ("switch off Bluetooth") is aimed at the wrong
cause because it cannot know the right one.

There is no fix for this inside the design. Coming in a bar late is ordinary
musicianship — the round has no count-in, and it asks people to start on the
clap. Distinguishing "started two beats late" from "has 1570 ms of latency"
requires an aperiodic grid, which is the jitter idea, which failed for unrelated
reasons and remains untested.

**And claps, the recommended fallback, are the worst case.** From the field:
*"según qué nota del piano va mejor, con palmadas va mal"*. "The round asks for
the sharpest attack the instrument has" implies a clap is a safe default; it is
not, for two reasons already recorded in this doc and not connected until now. A
hand clap is the least steady thing a person can produce — the steadiest measured
here was ±12 ms against a good drummer's ±5 — and it is broadband, exactly like
the click, so on a laptop it competes with the metronome's own bleed for the
energy vote. The 2026-09-02 jitter trial that "measured nothing" was also two
people clapping.

### What you play — and the sentence in this doc that was wrong

*"Según qué nota del piano va mejor, con palmadas va mal."*

This doc said: *"The sharpest attack the instrument has… A pad patch does not
measure; clap instead."* Read as guidance, that makes a clap the safe default.
It is the worst option available, and both halves of why were already written
down here and never put together:

- **A hand clap is the least steady thing a person can produce.** This doc's own
  figure: the steadiest hand clapping measured was ±12 ms, against a good
  drummer's ±5. The scatter is the output, so that is a doubling of the noise
  before anything else goes wrong.
- **A clap is broadband, exactly like the click.** The vote weighs energy so
  that the instrument beats the metronome's bleed — but that argument assumes
  the instrument sounds different from the click. On a laptop, a clap and a
  click are the same kind of event, and the bleed stops being the quiet
  contaminant `SPREAD_FLOOR_MS` was built to catch.

A note on a pitched instrument is steadier *and* spectrally unlike the click.
The 2026-09-02 jitter trial that "measured nothing" was also two people
clapping — which is worth re-reading now, because it may have been the claps
rather than the jitter arithmetic, and that makes the irregular click even less
disproved than it was already recorded as being.

**Both panels now ask for a note**, and mention a clap only as the last resort
for an instrument with no attack.

### Late entry: the message stopped blaming Bluetooth

The refusal above is still a refusal — the two readings genuinely are the same
audio and choosing between them would be guessing. What changed is that
`syncDetect` now checks whether the out-of-window winner is the in-window answer
plus a whole number of beats, and when it is, says so:

> the notes fit a delay of about 1570 ms — which is exactly 2 beats more than the
> 70 ms that fits inside the −80…570 ms searched. Those two are the same audio, so
> this is either a genuinely huge monitoring delay or — far more likely — you came
> in 2 beats late. Play the FIRST click too, not just the ones after it.

The old message told them to switch off Bluetooth, which was aimed at a cause
the detector had no reason to believe in. Both panels also now say "start on the
very first click" during the count-in.

**And then the count-in was built** — see the section below.

### What it is for now, and what it is not

- **It seeds only where there is no calibration.** Reading 50–70 ms low is a
  bounded, one-directional error against a take that would otherwise sit at its
  full monitoring delay: most of the way to right beats nowhere near it. What it
  must never do is overrule a calibration figure.
- **`spreadMs` is still the only answer to "can this person hold a beat".**
  DTW's `madMs` is the nearest thing and is not the same quantity — it mixes the
  player's looseness with the feature's own ambiguity, and it belongs to a take
  rather than to a person.
- **The gap between the two numbers is the player's anticipation**, and the take
  drawer prints it when both exist. It is not an error in either.


## The count-in (2026-09-03)

`SYNC_COUNTIN_BARS` in `p2gSync.ts`. One bar of clicks that sound and that
nobody plays on, then the four measured bars. The round goes from 12.8 s to
15.8 s.

### What it fixes, and what it does not

It does not remove the ambiguity. Nothing can, on a periodic grid: "came in a
bar late" and "has a bar's worth of monitoring delay" are the same recording,
byte for byte, and that is the same statement as the whole aliasing argument
above.

What it removes is the ambiguity being **the default**. Before it, the click
started and the player had to be on the very first one — musically abnormal, so
people did the correct musical thing, listened for the pulse, and entered late.
The measurement then refused, and the round earned its reputation. Now entering
after the count-in is what is asked for, so the instinct that used to break the
round is the instinct that satisfies it. Coming in wrong becomes an occasional
slip instead of what everybody does.

The cue is the ordinary one and needs no new sound: the metronome already
accents every fourth tick, so the player hears **ACCENT · tick · tick · tick ·
ACCENT ←** and comes in on the second accent.

### The arithmetic, on both sides at once

This is the change that most easily goes silently wrong, which is why the two
sides share `p2gSync.ts` and why `SYNC_FIRST_PLAYED_BEAT` carries the warning it
does. Beat 0 is still the clap. The count-in occupies beats 0…3; the player is
expected from beat 4; the median starts at beat 8 (the entry bar is voted on but
not averaged, which is what `SYNC_WARMUP_BARS` has always meant).

```
beat      0    1    2    3  ┃  4    5    6    7  ┃  8 … 19
click     ●    ●    ●    ●  ┃  ●    ●    ●    ●  ┃  ● … ●
player    ·    ·    ·    ·  ┃  ↑    ↑    ↑    ↑  ┃  ↑ … ↑
vote                        ┃  ✓    ✓    ✓    ✓  ┃  ✓ … ✓
median                      ┃                    ┃  ✓ … ✓
```

`expectedAll` therefore starts at `SYNC_FIRST_PLAYED_BEAT`, not at 0. Looking
for onsets during the count-in would be looking for the metronome's own bleed
and nothing else — and on speakers it would find it.

### The refusal now names the direction, and only asserts what it can

The cross-check's floor drops by one count-in, so a player who ignores the
count-in and starts on the clap — the OLD protocol, and the habit of anyone who
has run this round before — is found at `lag − 3000 ms` rather than falling off
the bottom of the search and coming back as "only N of 12 beats had a hit".

The two directions are not equally knowable, and the messages differ because of
it:

- **Early is certain.** Nothing gives a player negative monitoring delay, so a
  performance sitting whole beats *before* the grid can only be someone who
  started too soon. Stated plainly.
- **Late is permanently ambiguous**, and the message offers both readings with
  the action for each: either the monitoring delay really is that large (switch
  off Bluetooth) or they came in late (count the clicks in). Asserting the entry
  error would be the same over-claim as the old text asserting Bluetooth, in the
  other direction.

**The number of beats is deliberately not quoted for a late entry.** It is
frequently not determined: a late player runs off the end of the take, so the
alias one beat nearer matches just as many hits. Fixture `T`, built as two beats
late, scores identically at one beat and at two. The count is decoration and the
instruction does not depend on it.

### Fixtures

`p2g_sync_fixtures.py` gained `entry_offset`, which shifts the whole performance
by a number of beats without changing anything else — every note still exactly
on a click, just the wrong one. Twenty-one cases now:

```
T_entered_2_beats_LATE   refuses, names both readings, in both columns
U_entered_a_bar_EARLY    refuses, states the entry error plainly
```

Everything that passed before passes identically, which is the point of running
them: the count-in moved every index in the file and no measurement moved with
it.

## Off the flow by default, behind a link (2026-09-04)

The band session moved to **2026-09-14**, and the ten extra days went on
narrowing what the host has to do live rather than on widening it.

`SyncRoundCard` no longer renders in Launch unless the host asks for it. The
control is a footnote at the bottom of the step — *show the sync round* — and
the answer is remembered per browser in `localStorage` under
`p2g.showSyncRound`. Nothing else changed: `startSyncRound`, `syncDetect.ts`,
`p2gSync.ts`, the count-in, the fixtures and the participant's round screens are
all exactly where they were, and a round started with the card visible behaves
as this document describes.

**Why hidden rather than deleted, for the second time.** The same reason as the
morning of 2026-09-03, and it was right then: this is the only measurement in
the system that observes *the player*, and `spreadMs` is the only answer
anywhere to "can this person hold a beat". What it is not is something to
explain to eleven musicians on a satellite link with the clock running — it
costs the whole room thirteen seconds, it reads 50–70 ms low by construction,
and its worst failure (coming in on the wrong click) is one an unrehearsed band
will actually produce, after which it correctly refuses and the host is
debugging a measurement instead of recording music.

**What runs the session instead:** the calibration round seeds the mixer, the
fine-tune slider finishes the job, and `/api/play2gether/align` is there
per-take when a number looks wrong. That is the same order of trust doc 11
already argued for; this change only stops offering the bottom of it first.

**Before reviving it in the flow**, the two conditions from the 2026-09-03
section still stand (an aperiodic grid that can tell a late entry from monitor
latency, and something that measures anticipation rather than absorbing it into
the answer). Neither is met.
