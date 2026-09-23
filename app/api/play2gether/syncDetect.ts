import {
  decodeMonoPcm,
  DECODE_SAMPLE_RATE,
  type Play2GetherSyncOffset,
} from "./utils";
import {
  beatMs as msPerBeat,
  SYNC_BEATS_PER_BAR,
  SYNC_BPM,
  syncBeatMs,
  SYNC_TOTAL_BEATS,
  SYNC_FIRST_PLAYED_BEAT,
  SYNC_FIRST_ANALYSED_BEAT,
} from "../../lib/p2gSync";

/**
 * Measure where a musician places a beat, from a sync-round take.
 *
 * ── The arithmetic the answer rests on ───────────────────────────────────────
 *
 * Sample 0 of the take is wall-clock `localClapAt + captureDelayMs` (the client
 * prewarms the recorder and start-gates it at the clap; `captureDelayMs` is the
 * residual it measured). Metronome beat `k` is at wall-clock
 * `localClapAt + k·beatMs` — the metronome is phase-locked to the same clap,
 * with k=0 ON it. So in TAKE time:
 *
 *     expected_k = k·beatMs − captureDelayMs
 *     d_k        = detected_k − expected_k        (positive = played late)
 *
 * `d_k` is the whole quantity: output latency + input latency + this person's
 * own placement. And it drops straight into the mixer, because the mix shifts a
 * take by `netDelay = captureDelayMs − manual` (see mix/route.ts), so a hit at
 * take-time `expected_k + d_k` lands at mix time:
 *
 *     (captureDelayMs − manual) + (k·beatMs − captureDelayMs + d_k)
 *   =  k·beatMs + d_k − manual
 *
 * which equals `k·beatMs` exactly when `manual = d_k`. The median of `d_k` IS
 * the fine-tune slider value. No conversion, no sign flip — if you change one
 * side of this, change the other.
 *
 * ── Why the lag is searched globally, and why the tempo is fixed ────────────
 *
 * The obvious implementation — for each beat, take the nearest onset — is the
 * one that fails, and it fails the way every content-based alignment on music
 * fails: a beat is periodic, so a player 300 ms late at 120 BPM (beat = 500 ms)
 * is closer to the NEXT beat's slot than to their own, and gets scored as
 * 200 ms early. So the lag is estimated ONCE for the whole take by voting (how
 * many beats does this lag explain?), and only then are individual beats matched
 * against it.
 *
 * Voting alone does NOT fix it, which is worth being blunt about because it
 * looks like it should. A lag and that lag ± one beat explain the SAME onsets
 * equally well; the only thing separating them is the take's start and end
 * boundaries, which is a one-vote margin and evaporates the moment a player
 * fluffs their first hit. Measured on a synthetic take: a 450 ms player at
 * 120 BPM came back as −49 ms with 12 of 12 beats matched and zero scatter.
 *
 * What actually fixes it is arithmetic, not detection: run the round at a tempo
 * whose beat is LONGER than the entire range of lags worth searching, so no
 * alias of a valid lag is itself a valid lag.
 *
 *     beat(SYNC_BPM = 80) = 750 ms  >  LAG_MAX_MS − LAG_MIN_MS = 600 ms
 *
 * `assertUnambiguous` below is the guard on that inequality — it can only fire
 * if someone edits these constants apart, and it refuses rather than reports.
 */

/** Envelope frame hop. 4 ms is well under the mixer's 5 ms finest control, so
 *  frame quantisation is not the limiting error — the player is. */
const HOP_MS = 4;
/** Envelope window. Short enough that a hit's attack lands in one or two
 *  frames rather than being smeared across the decay of the previous one. */
const WIN_MS = 8;

/** Minimum normalised flux for a rise to count as an onset at all. */
const FLUX_FLOOR = 0.10;

/**
 * A candidate must also stand above the take's own noise, not merely above a
 * fraction of the loudest thing in it — otherwise a take with nothing in it but
 * room noise yields sixteen "onsets" and a confident offset. (Measured: a
 * silent take reported 182 ms, 12 of 12 beats matched.) The floor is taken from
 * the MEDIAN frame of the whole take, which in a sync round is silence between
 * hits, so it is a real noise measurement.
 *
 * Worth contrasting with doc 10's finding that the calibration detector's
 * noise-relative thresholds are inert, because its noise window is measured
 * during the start-up lead-in when the mic has not begun delivering and reads
 * exactly zero. This window is the take itself, so the relative term here does
 * the work it is supposed to.
 */
const NOISE_MULT = 6;
/** Absolute backstop, ~−42 dBFS, for a take whose "noise" is digital silence and
 *  whose relative floor would therefore collapse to zero. Deliberately well
 *  below any usable hit: the noise-relative term above is what does the
 *  rejecting, and setting this high enough to matter starts dropping the quiet
 *  hits of a player who is simply far from their mic. */
const ABS_PEAK_FLOOR = 0.008;
/** Two onsets closer than this are one hit (attack + a body transient behind
 *  it); the stronger survives. Well under the shortest beat in range. */
const MIN_ONSET_GAP_MS = 60;

/** Fraction of a hit's local peak that defines "the note started here". */
const ONSET_RISE_FRACTION = 0.25;
/** How far past a flux peak to look for that hit's own amplitude peak. */
const LOCAL_PEAK_WINDOW_MS = 30;

/**
 * Fallback lag search window, used when the device reports no round trip of its
 * own. See `searchWindow()` for the one that slides.
 *
 * The floor is barely negative: total offset is output latency + input latency
 * + feel, the first two are strictly positive and together are tens of ms even
 * on a wired laptop (doc 10's control run: 90 ms of digital path), so only feel
 * can push it down and only by so much.
 *
 * The WIDTH of whichever window is used is what sets SYNC_BPM. Widening it
 * needs the tempo lowered to match, or the measurement starts aliasing again;
 * `assertUnambiguous` enforces exactly that and is handed the real width.
 */
const LAG_MIN_MS = -80;
const LAG_MAX_MS = 520;
const LAG_STEP_MS = 5;

/**
 * How far either side of its own device's reported round trip a player can sit.
 *
 * FEEL_BACK is generous because the compensation is real and large: someone who
 * feels 300 ms of monitor latency pushes ahead against it, which is the whole
 * reason this measures the sum rather than subtracting the device term.
 *
 * Their sum is the searched width, and the width is what has to stay under a
 * beat: 250 + 400 = 650 < 750 = beat(SYNC_BPM). Raising either without lowering
 * SYNC_BPM makes `assertUnambiguous` refuse every round — loudly, which is the
 * intended failure.
 */
const FEEL_BACK_MS = 250;
const FEEL_FWD_MS = 400;

/**
 * The largest lag worth entertaining at all, for the out-of-window cross-check
 * below. Not a measurement range — nothing is ever reported from out here; it
 * only has to be wide enough to contain the answer a mis-centred window missed.
 */
const PHYSICAL_MAX_MS = 2000;

/**
 * How much better an out-of-window explanation has to be before the window is
 * declared misplaced. The margin the true lag holds over its own alias is
 * exactly one beat's worth of energy out of sixteen (~6 %), because the alias
 * loses the beat that falls off the start of the take — so this sits well under
 * that and well over scoring noise.
 */
const ALIAS_MARGIN = 0.02;

/** A beat votes for a lag when an onset sits this close to it. Tight — this is
 *  the vote, and a loose vote lets two lags tie. */
const VOTE_TOL_MS = 35;
/** Once the lag is chosen, a beat's own onset is accepted this far from it.
 *  Looser than the vote so a genuinely scattered player still yields the
 *  deviations that prove they are scattered. */
const ACCEPT_TOL_MS = 60;

/** Below this many matched beats there is no median worth reporting. */
const MIN_HITS = 6;

/**
 * A scatter below this is not a person.
 *
 * No human places twelve beats on a click with a median absolute deviation of
 * one or two milliseconds — a good drummer manages five, and the best hand
 * clapping measured in testing was twelve. A near-zero scatter therefore means
 * the thing being measured is machine-generated, and in this system there is
 * exactly one machine-generated periodic signal in earshot: the metronome,
 * coming back through the microphone of somebody monitoring on speakers.
 *
 * The energy-weighted vote was supposed to handle that by letting the loud
 * instrument outvote the faint bleed, and it does when the bleed IS faint. It
 * does not on a laptop, where the built-in mic sits centimetres from the
 * built-in speaker and the click returns as loud as the player. Field run,
 * 2026-09-01: headphones gave +101 ms ±14, the same person on speakers gave
 * **+177 ms ±0** — the acoustic round trip of their own machine, measured
 * perfectly, and not the quantity anyone wanted.
 *
 * So this is the backstop, and it is a refusal rather than a correction,
 * because a player on speakers is not measurable in principle: whatever the
 * detector does about the bleed, they are hearing the click from the room, and
 * the latency structure the round exists to capture is not the one they have.
 */
const SPREAD_FLOOR_MS = 3;

/**
 * Where to look for this player's lag.
 *
 * The window is always NARROWER THAN A BEAT. That inequality is what stops a
 * late player being read as an early one on the next beat, and enforcing it is
 * `assertUnambiguous`'s whole job. What changed on 2026-09-02 is not the width
 * but the CENTRE.
 *
 * It used to be pinned at -80…520 for everyone, on the reasoning that "past
 * half a second of monitor latency they are not playing with anyone". The
 * 2026-09-01 home session disproved that: a participant's own browser reported
 * its output path stepping 280 → 520 → ~1000 ms over one hour, in three flat
 * plateaus, with nothing in the app aware it had moved. From the moment it
 * passed 520 their real lag sat outside the only window this could see — and
 * that fails in two different ways, both of which were live that night. Below
 * ~670 ms nothing matches and the round refuses, which is honest. Between
 * ~670 and ~1270 ms the alias `L − beat` lands back INSIDE the window, matches
 * fifteen of sixteen beats, carries the player's own scatter, sits nowhere near
 * an edge, and is returned as a confident measurement a whole beat out. No
 * quality indicator this detector has can see it: not `spreadMs`, not
 * `SPREAD_FLOOR_MS`, not `atSearchEdge`, not the hit count.
 *
 * So the window slides to the device's own estimate of its round trip. That
 * estimate is NOT trusted as a value — doc 11 removed it as a mixing number for
 * good reason, it ranged 61–412 ms on the same people within one session. It is
 * only ever asked which of several candidate answers 750 ms apart is the
 * plausible one. For that job a ±200 ms estimate is far more precision than is
 * needed, which is why a number too noisy to mix with is still good enough to
 * disambiguate with.
 *
 * With no usable estimate the window falls back to where it has always been.
 */
function searchWindow(
  deviceLatencyMs?: number,
  jitterMs = 0,
): { lo: number; hi: number; centredOn: number | null } {
  // A randomised round needs no window at all. The window is narrow for exactly
  // one reason — a lag and that lag ± one beat explain a PERIODIC grid equally
  // well — and an irregular grid is not periodic, so the whole constraint
  // lapses. Sixteen jittered positions are a signature; a wrong lag would have
  // to match all of them by chance.
  //
  // This is the payoff of randomising, and it is larger than the anticipation
  // argument that motivated it: the round stops depending on the device's own
  // reported latency to break a tie, which is a number that Chrome sometimes
  // invents (a flat 10 ms fallback) and Safari does not implement at all.
  if (jitterMs > 0) return { lo: LAG_MIN_MS, hi: PHYSICAL_MAX_MS, centredOn: null };
  if (!(deviceLatencyMs > 0)) return { lo: LAG_MIN_MS, hi: LAG_MAX_MS, centredOn: null };
  const device = Math.round(deviceLatencyMs);
  const lo = Math.max(LAG_MIN_MS, device - FEEL_BACK_MS);
  return { lo, hi: lo + FEEL_BACK_MS + FEEL_FWD_MS, centredOn: device };
}

export type SyncDetectInput = {
  /** Tempo the round was played at. Always `SYNC_BPM` in practice; a parameter
   *  so the detector can be exercised against other tempos in a harness, where
   *  the ambiguity guard below is exactly what you want to see fire. */
  bpm?: number;
  /** The take's own `captureDelayMs`, in ms. Folded into `expected_k` above. */
  captureDelayMs: number;
  /** Seed for the randomised click, and its amplitude in ms. Both come from the
   *  round's shared state and ride the upload, because the detector has to
   *  expect the beats where they were actually PLAYED, not on the ideal grid.
   *  0 for either means a plain, un-randomised round. */
  seed?: number;
  jitterMs?: number;
  /** What this take's device reported for its own audio round trip — the
   *  upload's `clapOffset` (`outputLatency + baseLatency + mic latency`).
   *  Used ONLY to centre the search window, never as a value. Absent or 0
   *  falls back to the fixed window. See `searchWindow()`. */
  deviceLatencyMs?: number;
};

/**
 * Flat rather than a discriminated union on purpose: this project compiles with
 * `strict: false`, so `{ok: true} | {ok: false}` narrows nowhere and every
 * caller would be casting. `result` is set iff `ok`, `reason` iff not.
 */
export type SyncDetectResult = {
  ok: boolean;
  result?: Omit<Play2GetherSyncOffset, "name" | "measuredAt" | "file">;
  reason?: string;
};

export async function detectSyncOffset(
  filePath: string,
  { bpm = SYNC_BPM, captureDelayMs, deviceLatencyMs, seed = 0, jitterMs = 0 }: SyncDetectInput,
): Promise<SyncDetectResult> {
  if (!(bpm > 0)) return { ok: false, reason: "no tempo set for the round" };

  const beat = msPerBeat(bpm);
  const { lo: lagMin, hi: lagMax, centredOn } = searchWindow(deviceLatencyMs, jitterMs);
  // Only meaningful for a plain grid: a jittered one is aperiodic, so a lag and
  // that lag ± one beat no longer explain the onsets equally well and the whole
  // aliasing argument stops applying. Still checked when jitter is off.
  if (!(jitterMs > 0)) {
    const ambiguous = assertUnambiguous(beat, lagMax - lagMin);
    if (ambiguous) return { ok: false, reason: ambiguous };
  }

  const samples = await decodeMonoPcm(filePath);
  if (!samples) return { ok: false, reason: "take could not be decoded" };

  const onsets = findOnsets(samples);
  if (onsets.length === 0) {
    return { ok: false, reason: "no onsets found — was anything played into the mic?" };
  }

  // Expected beat positions in take time. The VOTE runs over every beat,
  // including the warm-up bar: those hits are badly placed but they are still
  // hits, and more votes make the lag estimate steadier. Only the MEDIAN
  // excludes them — that is where a settling player would do damage.
  // Where the beats were actually played, which on a randomised round is not the
  // ideal grid. `syncBeatMs` is the single definition of that, shared with the
  // metronome that scheduled them — two copies of this would misreport every
  // offset by the difference between two random sequences, silently.
  //
  // Starting at SYNC_FIRST_PLAYED_BEAT rather than 0 is the count-in: those
  // first clicks sound, and nobody is meant to play on them. Looking for onsets
  // there would be looking for the metronome's own bleed and nothing else, and
  // on speakers it would find it.
  const expectedAll: number[] = [];
  for (let k = SYNC_FIRST_PLAYED_BEAT; k < SYNC_TOTAL_BEATS; k++) {
    expectedAll.push(syncBeatMs(k, bpm, seed, jitterMs) - captureDelayMs);
  }
  const expectedAnalysed = expectedAll.slice(SYNC_FIRST_ANALYSED_BEAT - SYNC_FIRST_PLAYED_BEAT);

  // ── Vote for the lag ───────────────────────────────────────────────────────
  // Score is the ENERGY a lag explains, not the number of beats it explains.
  //
  // Counting events looks equivalent and is not. A participant monitoring on
  // speakers gets the metronome bled back into their own mic, and that bleed is
  // machine-perfect: sixteen clicks exactly one output-latency after the grid,
  // with zero human scatter. Against a count, it beats the actual player.
  // (Measured: a take with click bleed 20 dB below the instrument reported
  // 41 ms — the player's output latency alone — instead of their real 220 ms,
  // with zero scatter and every beat matched.) Weighing by loudness puts the
  // instrument back in charge, because the instrument is the loud thing.
  //
  // Ties break on total absolute residual, then on the smaller |lag|, so a
  // genuine 0 never loses to an equally-scoring outlier.
  const scoreLag = (lag: number) => {
    let hits = 0;
    let energy = 0;
    let residual = 0;
    for (const expected of expectedAll) {
      const o = nearestOnset(onsets, expected + lag);
      if (o == null) continue;
      const dev = Math.abs(o.ms - (expected + lag));
      if (dev > VOTE_TOL_MS) continue;
      hits++;
      energy += o.strength;
      residual += dev;
    }
    return { lag, hits, energy, residual };
  };

  const bestOver = (lo: number, hi: number) => {
    let top = { lag: 0, hits: -1, energy: -1, residual: Infinity };
    for (let lag = lo; lag <= hi; lag += LAG_STEP_MS) {
      const c = scoreLag(lag);
      const better =
        c.energy > top.energy + 1e-9 ||
        (Math.abs(c.energy - top.energy) < 1e-9 && c.residual < top.residual - 1e-9) ||
        (Math.abs(c.energy - top.energy) < 1e-9 &&
          Math.abs(c.residual - top.residual) < 1e-9 &&
          Math.abs(c.lag) < Math.abs(top.lag));
      if (better) top = c;
    }
    return top;
  };

  const best = bestOver(lagMin, lagMax);

  // Cross-check the window against the whole physically possible range.
  //
  // Sliding the window onto the device's own figure only works while that
  // figure is roughly honest, and one common case is not: `outputLatency` is
  // not implemented everywhere, and where it is missing `referenceOutputLatencyMs`
  // contributes only `baseLatency`. A browser with a 900 ms output path can
  // therefore report 25 ms — not absent, which would fall back safely, but
  // confidently small, which centres the window in the wrong place and aliases
  // exactly as before.
  //
  // The audio can catch that even though it cannot resolve the ambiguity on its
  // own: the true lag matches every beat, its alias always drops the one that
  // falls off the take's start, so the true lag scores strictly higher wherever
  // it lies. If the best explanation ANYWHERE beats the best one inside the
  // window, the window is in the wrong place and the honest answer is to say so
  // — not to return the best of a set of wrong answers.
  // The floor drops by the count-in. A player who ignores it and starts on the
  // very first click — the old protocol, and the habit of anyone who has run
  // this round before — lands a whole count-in EARLY, at `lag − 3000 ms`, which
  // no positive-only search can see. Without this they get "only N of 12 beats
  // had a hit", which is true and tells them nothing.
  const globalBest = bestOver(LAG_MIN_MS - SYNC_FIRST_PLAYED_BEAT * beat, PHYSICAL_MAX_MS);
  if (
    globalBest.lag !== best.lag &&
    globalBest.energy > best.energy * (1 + ALIAS_MARGIN) &&
    globalBest.hits > best.hits
  ) {
    // Is the winner outside simply the in-window answer plus whole beats?
    //
    // This case is not the one the cross-check was written for, and it is the
    // one the field actually produces. The check assumes the player started on
    // the clap, and reasons that a true lag matches every beat while its alias
    // always drops the one that falls off the start — so the true lag scores
    // higher wherever it lies. A player who comes in LATE breaks that
    // assumption: their own hits are shifted, so the alias legitimately scores
    // higher, and the refusal fires on somebody whose only mistake was missing
    // the first bar.
    //
    // Measured, 2026-09-03: "about 1570 ms" reported against a −80…570 window,
    // and 1570 − 2 × 750 = 70 ms. Two beats late, and otherwise 70 ms behind.
    //
    // It is still refused, because the two readings genuinely are the same
    // audio and choosing between them would be guessing. What changes is that
    // the message stops blaming Bluetooth for something Bluetooth did not do
    // and names the thing the player can actually check.
    // Is the winner outside simply the in-window answer plus whole beats? And
    // if so, which way — because the two directions are NOT equally ambiguous.
    //
    // LATE is ambiguous, permanently. "Came in a bar late" and "has a bar's
    // worth of monitoring delay" are the same recording, and the whole aliasing
    // argument says nothing can separate them. So the message offers BOTH, with
    // the action for each; asserting the entry error would be the same
    // over-claim in the other direction as the old text asserting Bluetooth.
    //
    // EARLY is not ambiguous: nothing gives a player NEGATIVE monitoring delay,
    // so a performance sitting whole beats before the grid can only be someone
    // who started before the count-in ended. That one can be stated plainly.
    //
    // The number of beats is deliberately not quoted for a late entry. It is
    // frequently not determined: a player who enters late runs off the end of
    // the take, so the alias one beat nearer matches just as many hits (fixture
    // T, entered 2 beats late, scores identically at 1 and at 2). The count is
    // decoration; the instruction does not depend on it.
    const beatsOut = Math.round((globalBest.lag - best.lag) / beat);
    const aliasResidual = Math.abs(globalBest.lag - (best.lag + beatsOut * beat));
    const wrongEntry = beatsOut !== 0 && aliasResidual <= VOTE_TOL_MS;
    const barsEarly = Math.round(Math.abs(beatsOut) / SYNC_BEATS_PER_BAR);
    return {
      ok: false,
      reason: wrongEntry
        ? (beatsOut > 0
            ? `everything you played lines up with the click, but a whole number of beats later ` +
              `than expected — about ${Math.round(globalBest.lag)} ms. Two different things look ` +
              `exactly like that and this take cannot tell them apart: either your monitoring ` +
              `delay really is that large (Bluetooth audio does this — switch to wired), or you ` +
              `came in late (count the ${SYNC_FIRST_PLAYED_BEAT} clicks in, then play from the ` +
              `next one). Fix whichever applies and run it again`
            : `you started before the count-in finished — everything you played sits ` +
              `${barsEarly > 0 ? `${barsEarly} bar${barsEarly > 1 ? "s" : ""}` : "a beat"} ` +
              `earlier than expected. Let the first ${SYNC_FIRST_PLAYED_BEAT} clicks go by ` +
              `without playing, then come in on the next one`)
        : `the notes fit a delay of about ${Math.round(globalBest.lag)} ms, which is outside ` +
          `the ${lagMin}…${lagMax} ms this round searched` +
          (centredOn === null
            ? ` (this device reported no monitoring delay of its own to search around)`
            : ` (centred on the ${centredOn} ms this device reports, which looks wrong)`) +
          `. Reporting a number here would mean guessing which beat you were on — ` +
          `switch off Bluetooth audio, use wired headphones, and run it again`,
    };
  }

  // ── Match the analysed beats against the winning lag ───────────────────────
  const deviations: number[] = [];
  for (const expected of expectedAnalysed) {
    const o = nearestOnset(onsets, expected + best.lag);
    if (o == null) continue;
    if (Math.abs(o.ms - (expected + best.lag)) > ACCEPT_TOL_MS) continue;
    deviations.push(o.ms - expected);
  }

  if (deviations.length < MIN_HITS) {
    // Two very different failures land here and they need different advice.
    // If the take is full of onsets but none of them line up with the click,
    // the player did their job and the offset is simply outside what this can
    // see — telling them to "play on every click" would be both wrong and
    // insulting. That case is a Bluetooth monitor path, and the fix is the
    // headphones, not the performance.
    const playedPlenty = onsets.length >= MIN_HITS;
    return {
      ok: false,
      reason: playedPlenty
        ? `${onsets.length} notes were played but none of them line up with the click ` +
          `within the ${lagMin}…${lagMax} ms this round searched` +
          (centredOn === null
            ? `, and this device reported no monitoring delay of its own to search around. ` +
              `The delay is probably larger than ${lagMax} ms: switch off Bluetooth audio ` +
              `and use wired headphones, then run the sync round again`
            : `, which was centred on the ${centredOn} ms round trip this device reports. ` +
              `Either that figure is wrong, or the notes were not on the click. Switch off ` +
              `Bluetooth audio, use wired headphones, and run the sync round again`)
        : `only ${deviations.length} of ${expectedAnalysed.length} beats had a hit on them — ` +
          `count the ${SYNC_FIRST_PLAYED_BEAT} clicks in, then play ONE NOTE on every click ` +
          `after that. A note, not a clap: a clap is unsteady and sounds too much like the ` +
          `click itself`,
    };
  }

  const offsetMs = median(deviations);
  const spreadMs = median(deviations.map((d) => Math.abs(d - offsetMs)));

  if (spreadMs < SPREAD_FLOOR_MS) {
    return {
      ok: false,
      reason:
        `the beats came back impossibly steady (±${Math.round(spreadMs)} ms across ` +
        `${deviations.length} beats), which means the microphone is picking up the ` +
        `metronome itself rather than you — put headphones on and run it again`,
    };
  }

  // A lag pinned against the edge of the range means the true value may be
  // outside it — the same refusal `EDGE_GUARD_MS` makes in the calibration
  // detector, for the same reason: a value that had nowhere further to go is
  // not a measurement, it is the boundary.
  const atSearchEdge =
    best.lag <= lagMin + LAG_STEP_MS || best.lag >= lagMax - LAG_STEP_MS;

  return {
    ok: true,
    result: {
      offsetMs: Math.round(offsetMs),
      spreadMs: Math.round(spreadMs),
      hits: deviations.length,
      expected: expectedAnalysed.length,
      bpm,
      deviationsMs: deviations.map((d) => Math.round(d)),
      ...(atSearchEdge ? { atSearchEdge: true } : {}),
    },
  };
}

/**
 * Refuse a tempo whose beat is short enough for the lag search to wrap onto the
 * neighbouring beat. At `SYNC_BPM` this never fires; it exists so that editing
 * SYNC_BPM up, or the lag range wider, fails loudly here instead of quietly
 * returning answers a whole beat out. Empty string = unambiguous.
 */
function assertUnambiguous(beat: number, widthMs: number): string {
  if (beat > widthMs) return "";
  return (
    `a beat of ${Math.round(beat)} ms is shorter than the ${widthMs} ms window of ` +
    `offsets being searched, so a late player cannot be told apart from an early one ` +
    `on the next beat — run the sync round at a slower tempo, or narrow ` +
    `FEEL_BACK_MS / FEEL_FWD_MS`
  );
}

/**
 * Onset times in ms, from a half-wave-rectified amplitude flux.
 *
 * Deliberately amplitude-domain rather than spectral: what a sync round asks
 * for is the sharpest attack the instrument has, played into silence with only
 * a click for company, and against that a spectral flux buys nothing a rise in
 * level doesn't already give.
 *
 * Each candidate is a local maximum of the flux, refined to the sample where
 * the note actually starts rising — the flux peaks somewhere on the attack, not
 * at its foot, and the difference is tens of milliseconds on a slow attack.
 */
function findOnsets(samples: Float32Array): Onset[] {
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * DECODE_SAMPLE_RATE));
  const win = Math.max(hop, Math.round((WIN_MS / 1000) * DECODE_SAMPLE_RATE));
  const frames = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  if (frames < 3) return [];

  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const start = i * hop;
    let mx = 0;
    for (let j = start; j < start + win; j++) { const a = Math.abs(samples[j]); if (a > mx) mx = a; }
    env[i] = mx;
  }

  // Noise floor from the median frame — in a sync round most of the take is the
  // gap between hits, so the median IS the noise. See NOISE_MULT.
  const noiseFloor = median(Array.from(env));
  const peakFloor = Math.max(ABS_PEAK_FLOOR, NOISE_MULT * noiseFloor);

  const flux = new Float32Array(frames);
  let fluxMax = 1e-9;
  for (let i = 1; i < frames; i++) {
    const d = env[i] - env[i - 1];
    flux[i] = d > 0 ? d : 0;
    if (flux[i] > fluxMax) fluxMax = flux[i];
  }

  // Local maxima above the floor, strongest-first, then thinned so two peaks on
  // the same attack collapse to one.
  const peaks: { frame: number; strength: number }[] = [];
  for (let i = 1; i < frames - 1; i++) {
    const f = flux[i] / fluxMax;
    if (f < FLUX_FLOOR) continue;
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    peaks.push({ frame: i, strength: f });
  }
  peaks.sort((a, b) => b.strength - a.strength);

  const gapFrames = Math.round(MIN_ONSET_GAP_MS / HOP_MS);
  const kept: number[] = [];
  for (const p of peaks) {
    if (kept.some((k) => Math.abs(k - p.frame) < gapFrames)) continue;
    kept.push(p.frame);
  }

  const localPeakSamples = Math.round((LOCAL_PEAK_WINDOW_MS / 1000) * DECODE_SAMPLE_RATE);
  const onsets: Onset[] = [];
  for (const frame of kept) {
    // This hit's own amplitude peak, then walk back to where it started rising.
    const from = frame * hop;
    const to = Math.min(samples.length, from + localPeakSamples);
    let localPeak = 0;
    for (let j = from; j < to; j++) { const a = Math.abs(samples[j]); if (a > localPeak) localPeak = a; }
    if (localPeak < peakFloor) continue;
    const threshold = localPeak * ONSET_RISE_FRACTION;
    const searchFrom = Math.max(0, from - hop);
    let onsetSample = from;
    for (let j = searchFrom; j < to; j++) {
      if (Math.abs(samples[j]) >= threshold) { onsetSample = j; break; }
    }
    // `strength` is the hit's loudness, and it is what the vote weighs by —
    // see the vote in detectSyncOffset for why counting events is not enough.
    onsets.push({ ms: (onsetSample / DECODE_SAMPLE_RATE) * 1000, strength: localPeak });
  }

  onsets.sort((a, b) => a.ms - b.ms);
  return onsets;
}

/** A detected attack: when it starts, and how loud the note behind it is. */
type Onset = { ms: number; strength: number };

/** Onset closest to `t` in ms, or null when there are none. */
function nearestOnset(onsets: Onset[], t: number): Onset | null {
  if (onsets.length === 0) return null;
  // Binary search for the insertion point, then compare the two neighbours.
  let lo = 0, hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].ms < t) lo = mid + 1; else hi = mid;
  }
  const before = lo > 0 ? onsets[lo - 1] : null;
  const after = lo < onsets.length ? onsets[lo] : null;
  if (before == null) return after;
  if (after == null) return before;
  return t - before.ms <= after.ms - t ? before : after;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
