/**
 * Shape of a **sync round** — the short click-only take that measures where a
 * musician actually places a beat.
 *
 * Shared by the client (which sizes the recording and tells the player what to
 * do) and the server detector (which knows where every beat should have
 * landed). Two copies of these numbers would silently misreport every offset by
 * whatever they disagreed on, which is the whole reason this file exists rather
 * than a constant on each side.
 *
 * ── Why a sync round exists ──────────────────────────────────────────────────
 *
 * Acoustic calibration (`Play2GetherCalibration.tsx`) measures the DEVICE round
 * trip. That is not the quantity the mixer needs. What the mixer needs is where
 * this person's notes end up relative to the beat, which is the device round
 * trip PLUS how that human places themselves against what they hear — and the
 * second term is not an error to be removed. A drummer who feels 200 ms of
 * monitor latency pushes ahead to compensate; subtract their full measured
 * latency and you have moved them to the wrong place with great precision.
 *
 * A sync round measures the sum, in the real audio path, for the real person.
 *
 * ── Why quarter notes and not one hit ────────────────────────────────────────
 *
 * A single hit measures a REACTION, and gives one sample: no median to be
 * robust with, and no spread to say whether the number means anything. Four
 * bars of quarter notes lets the player settle into the click, so what is
 * measured is their steady-state placement — which is what they will actually
 * do when the song is playing — and yields a per-beat scatter. That scatter is
 * as valuable as the offset: a player whose MAD is 40 ms has no single correct
 * offset, and the host needs to know that in bar 2 of the rehearsal rather than
 * in the mix.
 */

/** Beats per bar. The metronome accents every 4th tick (`scheduleMetronomeClick`
 *  with `accent`), and the analysis discards whole bars, so these must agree. */
export const SYNC_BEATS_PER_BAR = 4;

/**
 * Bars of COUNT-IN: clicks that sound, and during which nobody is expected to
 * play. Added 2026-09-03, and it is the fix for the round's worst failure.
 *
 * Before it, the click started and the player had to be on the very first one.
 * That is musically abnormal — you listen, find the pulse, and come in — so
 * people did the correct musical thing and entered a beat or two late. And
 * against a PERIODIC click, "entered two beats late" and "has 1500 ms more
 * latency" are the same recording, byte for byte. The detector cannot separate
 * them, so it refused. Measured in the field: a round reported "about 1570 ms",
 * and 1570 − 2 × 750 = 70 ms.
 *
 * The count-in does not make that ambiguity go away; nothing can, on a periodic
 * grid. What it does is stop the ambiguity being the DEFAULT: entering after
 * the count-in is now what the player is asked for, so the instinct that used
 * to break the measurement is the instinct that satisfies it.
 *
 * One bar, which is the universal "1, 2, 3, 4". The metronome accents every
 * fourth tick already, so the cue is a familiar one: the player enters on the
 * SECOND accent. Two bars would be safer for someone hesitant and costs another
 * three seconds — change this constant, and nothing else, to find out.
 */
export const SYNC_COUNTIN_BARS = 1;

/** Bars the player actually plays. Four is the smallest number that leaves a
 *  usable sample after discarding the settling bar below. */
export const SYNC_BARS = 4;

/** Bars discarded from the front of the ANALYSIS — of the played bars, not of
 *  the count-in. The count-in is where the player finds the click; this is
 *  their entry, which is a cued reaction rather than steady-state placement.
 *  They are still voted on, because a badly placed hit is still a hit and more
 *  votes make the lag estimate steadier; only the median excludes them. */
export const SYNC_WARMUP_BARS = 1;

/** Extra recording after the last beat so a late hit isn't clipped by the end
 *  of the take. Generous on purpose: a Bluetooth player can land ~500 ms late
 *  and a truncated final hit reads as a miss, not as a late one. */
export const SYNC_TAIL_MS = 800;

/** Clicks the metronome sounds, count-in included. Beat 0 is on the clap. */
export const SYNC_TOTAL_BEATS = (SYNC_COUNTIN_BARS + SYNC_BARS) * SYNC_BEATS_PER_BAR;

/**
 * First beat the player is expected to hit — the click they come in on.
 *
 * This is the single most important index in the round, because it is the one
 * both sides have to agree on: the client tells the player to enter here and
 * the detector looks for onsets from here. If one moved without the other,
 * every offset would come back wrong by a whole number of beats, silently and
 * with a perfectly healthy-looking scatter. That is the failure this file
 * exists to make impossible.
 */
export const SYNC_FIRST_PLAYED_BEAT = SYNC_COUNTIN_BARS * SYNC_BEATS_PER_BAR;
/** First beat included in the MEDIAN (the vote starts at the played beat). */
export const SYNC_FIRST_ANALYSED_BEAT =
  SYNC_FIRST_PLAYED_BEAT + SYNC_WARMUP_BARS * SYNC_BEATS_PER_BAR;
export const SYNC_ANALYSED_BEATS = SYNC_TOTAL_BEATS - SYNC_FIRST_ANALYSED_BEAT;

/** Milliseconds per beat at `bpm`. */
export function beatMs(bpm: number): number {
  return 60000 / bpm;
}

/** How long a sync round records, in seconds. A sync round is a fixed number of
 *  BARS, not of seconds — what it measures is a placement against a beat. The
 *  count-in is recorded like everything else: capture starts at the clap, and
 *  the beat positions the detector looks for are absolute from there. */
export function syncRoundDurationSec(): number {
  return (SYNC_TOTAL_BEATS * beatMs(SYNC_BPM) + SYNC_TAIL_MS) / 1000;
}

/** Seconds of count-in before the player comes in. Drives the "listen…" half of
 *  the participant's recording screen, so the instruction on screen changes at
 *  the instant the instruction changes in the music. */
export function syncCountInSec(): number {
  return (SYNC_FIRST_PLAYED_BEAT * beatMs(SYNC_BPM)) / 1000;
}

/**
 * The tempo a sync round runs at — **fixed, and deliberately not the song's**.
 *
 * This is the single most important constant in the feature, and the reason is
 * worth stating because "measure at the tempo they'll play at" is the obvious
 * choice and it is wrong.
 *
 * The detector infers one lag for the whole take. A beat is periodic, so a
 * player who is late by more than about half a beat is indistinguishable from
 * one who is early on the NEXT beat — the measurement aliases, and it aliases
 * silently, returning a confident wrong answer a full beat out. (Measured: a
 * 450 ms player at 120 BPM reads as −49 ms, 12 of 12 beats matched, zero
 * scatter.) The only way to make the answer unique is for one beat to be longer
 * than the whole range of latencies a player can plausibly have:
 *
 *     beat(80 BPM) = 750 ms  >  LAG range (−80 … +520 ms) = 600 ms
 *
 * so no alias of a valid lag can itself be a valid lag. See `syncDetect.ts`.
 *
 * What this costs: a player's placement does drift with tempo, so an offset
 * measured at 80 BPM is not exactly their offset at 140. But that drift lives
 * entirely in the *feel* term, and feel is the small term — the dominant part
 * is device round trip (70–320 ms across the band in the field logs of
 * 2026-08-31), which does not care what tempo anyone is playing at. Trading a
 * few ms of feel for immunity to a full-beat error is not a close call.
 *
 * Quarter notes at 80 BPM are also simply comfortable to play steadily, which
 * is what the round is asking for.
 */
export const SYNC_BPM = 80;

/** Quality bands for the per-beat scatter (`spreadMs`), used by the host UI to
 *  colour a result and by the docs to say what "good" means. */
export const SYNC_SPREAD_GOOD_MS = 15;
export const SYNC_SPREAD_FAIR_MS = 30;

/**
 * ── Randomised click (opt-in) ────────────────────────────────────────────────
 *
 * Raised from the field, 2026-09-02: *"the sync round should be more random,
 * otherwise they can play the rhythm from memory"*. The doc's own data agrees.
 * Four consecutive runs by one person went `+118 → +130 → +101 → +87`, quoted as
 * players settling; they converge DOWNWARDS, away from the physical path,
 * because what improves with practice is the ability to ANTICIPATE the click,
 * and anticipating is cancelling your own monitoring latency. The same day, the
 * click physically landed at +99.8 ms on that machine and the round said 82.
 *
 * A steady click therefore measures how well someone predicts a metronome. An
 * unpredictable one forces them to track it instead.
 *
 * **The known cost, stated up front.** This trades bias for variance, and there
 * is no guarantee it is a good trade. To the extent a player ignores the jitter
 * and keeps their own internal pulse, the median is unchanged and only the
 * scatter grows; to the extent they chase every click, the round drifts toward
 * measuring reaction time, which is the 150–250 ms quantity `SYNC_BARS` exists
 * to avoid. Real players sit somewhere between, and where exactly is not
 * something that can be reasoned out from here. Watch `spreadMs`: if it grows
 * without the offset moving toward the physical path, the jitter is buying
 * nothing and should go back to 0.
 *
 * Off by default for that reason.
 *
 * **A second effect, and this one is free.** A jittered grid is APERIODIC, so a
 * lag and that lag ± one beat no longer explain the onsets equally well. That is
 * the structural cure for the aliasing that `syncDetect.ts` otherwise buys with
 * a tempo constraint and a device-latency tiebreak — the "break the periodicity"
 * fix described in doc 11 and previously rejected for changing what the player
 * is asked to do. It arrives here as a side effect.
 */

/**
 * Peak deviation applied to each click, in ms, when a round is randomised.
 *
 * **UNREACHABLE as of 2026-09-02, on purpose.** The host control is gone and
 * every round is started with 0. The mechanism is left in place because the
 * seeded grid costs nothing when the amplitude is 0 (`syncBeatMs` degenerates to
 * `k * beatMs`) and because it was never actually disproved — but read the
 * failure before switching it back on:
 *
 *     SYNC_JITTER_MS = 45   >   VOTE_TOL_MS = 35   (syncDetect.ts)
 *
 * The jitter was set LARGER than the tolerance a hit is allowed to miss its
 * beat by. Musicians do not chase an irregular click — they hold their own
 * pulse, which is the skill they have — so their hits landed up to 45 ms from
 * where the detector looked and the ones past 35 did not count at all, while
 * the rest gained ~26 ms of scatter that was not theirs. Tried in the field
 * with two people, claps and hand clicks: nothing measured.
 *
 * That is an arithmetic error in the parameters, NOT evidence about the idea.
 * Anyone reviving this has to move `VOTE_TOL_MS` and `ACCEPT_TOL_MS` with the
 * jitter, and should probably start at an amplitude well under the tolerance
 * (10–15 ms) to see whether it disturbs anticipation at all before reaching for
 * anything larger. The question the jitter was meant to answer — that a steady
 * click gets anticipated, and anticipating cancels the latency being measured —
 * is still open and still real.
 */
export const SYNC_JITTER_MS = 45;

/**
 * Deterministic per-beat deviation from the ideal grid, in ms.
 *
 * Derived from a seed rather than uploaded, so the client that PLAYS the click
 * and the server that MEASURES against it cannot disagree — the same reason
 * every other constant in this file is here rather than duplicated. A mismatch
 * would not fail, it would silently report every offset wrong by the difference
 * between two random sequences.
 */
export function syncJitterMs(seed: number, beat: number, amplitudeMs: number): number {
  if (!(amplitudeMs > 0) || !Number.isFinite(seed)) return 0;
  // xorshift32 over (seed, beat). Not cryptographic and does not need to be:
  // it only has to be unpredictable to a musician and identical on both sides.
  let h = (Math.trunc(seed) ^ Math.imul(beat + 1, 0x9e3779b1)) >>> 0;
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17;
  h ^= h << 5;  h >>>= 0;
  return ((h / 0xffffffff) * 2 - 1) * amplitudeMs;
}

/**
 * Where beat `k` actually falls, in ms after the clap. The ONE definition of the
 * grid: the metronome schedules from it and the detector expects from it.
 *
 * `seed = 0` or `amplitudeMs = 0` gives the plain grid, so the un-randomised
 * round is the same code path with the jitter switched off rather than a second
 * one to keep in step.
 */
export function syncBeatMs(k: number, bpm: number, seed: number, amplitudeMs: number): number {
  return k * beatMs(bpm) + syncJitterMs(seed, k, amplitudeMs);
}
