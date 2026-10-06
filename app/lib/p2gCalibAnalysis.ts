/**
 * The measurement half of Play2Gether's acoustic calibration: given what the
 * microphone captured, find the internal sync marker and the acoustic click and
 * turn the gap between them into a round-trip latency.
 *
 * Pure on purpose — no AudioContext, no DOM. `runAcousticTrial`
 * (components/Play2GetherCalibration.tsx) owns the audio graph and hands the
 * captured buffer here. Kept apart so the part that decides the number can be
 * tested against synthetic captures: this is where a bug produces a confident,
 * plausible, WRONG latency that is then applied to every take.
 *
 * How a trial is laid out in time (all relative to the capture gate opening):
 *
 *   START_AT_LEAD_MS ─ MARKER_OFFSET_MS ─ marker (digital, straight into the
 *   capture) ─ SCHEDULED_GAP_MS ─ click scheduled on the speakers ─ round trip
 *   ─ click arrives back through the mic.
 *
 * latency = (click onset − marker onset) − SCHEDULED_GAP_MS
 */

// ── The measurement window ───────────────────────────────────────────────────
//
// This used to be a flat `RECORD_MS = 900` commented as "long enough for up to
// ~600 ms BT latency". It was not: the lead-in ate 50 of those, leaving ~550,
// and the comment went on claiming 600. Deriving the window from the same
// constants that schedule the clicks is the only way the budget and the
// schedule cannot drift apart again.
export const START_AT_LEAD_MS = 50;
export const MARKER_OFFSET_MS = 100;
export const CLICK_OFFSET_MS = 300; // 200 ms after marker
export const SCHEDULED_GAP_MS = CLICK_OFFSET_MS - MARKER_OFFSET_MS;
/** Longest round trip this is willing to measure. Not 600: A2DP output on
 *  macOS alone runs 150-300 ms and the input side adds its own, and a field
 *  session produced a participant needing more than 500. */
export const MAX_MEASURABLE_RT_MS = 1000;
/** Slack after the latest click we accept, so its decay and the onset
 *  walk-back sit inside the buffer instead of being clipped by it. */
export const TAIL_MS = 80;
export const RECORD_MS =
  START_AT_LEAD_MS + CLICK_OFFSET_MS + MAX_MEASURABLE_RT_MS + TAIL_MS;
/** A peak nearer than this to the end of the capture is not treated as the
 *  click. See the throw in analyseCapture. */
export const EDGE_GUARD_MS = 40;
/** Below this, the measurement is not a speaker→air→mic round trip. Even a
 *  wired laptop with the mic touching the speaker sits around 20–40 ms once
 *  output buffering, the ADC and the capture graph are counted. */
export const MIN_PLAUSIBLE_LATENCY_MS = 8;

/** What the analysis saw. Filled in as far as it gets, so a trial that throws
 *  still reports how far it got (the noise floor, the marker...). */
export type CaptureDiag = Partial<{
  noiseFloor: number;
  capturedMs: number;
  markerMs: number;
  markerPeak: number;
  clickMs: number;
  clickPeak: number;
  clickPeakMs: number;
  gapMs: number;
  latencyMs: number;
}>;

/**
 * Measure the round-trip latency in a captured trial.
 *
 * @param buf        the capture; only the first `writeIdx` samples are valid
 * @param writeIdx   how many samples were actually captured
 * @param sampleRate the capture's sample rate
 * @param diag       filled in as the analysis progresses, also on failure
 * @returns the latency in whole milliseconds
 * @throws  with a user-facing message when the trial cannot be trusted
 */
export function analyseCapture(
  buf: Float32Array,
  writeIdx: number,
  sampleRate: number,
  diag: CaptureDiag = {},
): number {
  const ms = (samples: number) => (samples / sampleRate) * 1000;
  const toIdx = (millis: number) => Math.floor((millis / 1000) * sampleRate);

  // Estimate noise floor from the first 50 ms (pre-marker).
  let sumSq = 0;
  let count = 0;
  const noiseEnd = Math.min(writeIdx, toIdx(50));
  for (let i = 0; i < noiseEnd; i++) {
    sumSq += buf[i] * buf[i];
    count++;
  }
  const noiseFloor = count > 0 ? Math.sqrt(sumSq / count) : 0.001;
  diag.noiseFloor = +noiseFloor.toFixed(5);
  diag.capturedMs = +ms(writeIdx).toFixed(0);

  const peakIn = (start: number, end: number) => {
    let peak = 0;
    let idx = -1;
    for (let i = Math.max(0, start); i < Math.min(end, writeIdx); i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) { peak = a; idx = i; }
    }
    return { peak, idx };
  };
  /** Walk back from a peak to the sample where the transient actually starts.
   *  Onset detection has to be relative to the peak, not to an absolute
   *  threshold: an absolute threshold latches onto whatever room noise
   *  happens to be present at the start of the search window and reports a
   *  latency of ~0. */
  const onsetBefore = (peakIdx: number, peak: number, searchStart: number) => {
    const floor = Math.max(0.25 * peak, 3 * noiseFloor);
    let i = peakIdx;
    while (i > searchStart && Math.abs(buf[i - 1]) > floor) i--;
    return i;
  };

  // Marker: digitally injected at 0.7 amplitude, so nothing else in the
  // buffer comes close — find it as the loudest thing in the pre-click
  // region rather than the first sample over a soft threshold.
  const markerRegion = peakIn(0, toIdx(280));
  if (markerRegion.idx < 0 || markerRegion.peak < Math.max(0.15, 8 * noiseFloor)) {
    throw new Error("Internal sync marker lost — try again.");
  }
  const markerIdx = onsetBefore(markerRegion.idx, markerRegion.peak, 0);
  diag.markerMs = +ms(markerIdx).toFixed(1);
  diag.markerPeak = +markerRegion.peak.toFixed(4);

  // Acoustic click: scheduled for marker + 200 ms, arriving later by the
  // round-trip latency we're measuring. Take the loudest peak in the window
  // and back off to its onset; a real click through speakers dominates room
  // noise, which is what makes this immune to the false early trigger.
  const clickSearchStart = markerIdx + toIdx(SCHEDULED_GAP_MS) - toIdx(10);
  const clickRegion = peakIn(clickSearchStart, writeIdx);
  if (clickRegion.idx < 0 || clickRegion.peak < Math.max(0.015, 6 * noiseFloor)) {
    throw new Error("Click not heard. Move mic closer to the speaker / turn volume up.");
  }
  // A peak pressed up against the end of the capture is not evidence of the
  // click; it is evidence that the click may have landed OUTSIDE the window
  // and the loudest thing still inside got matched instead. That produces a
  // confident, repeatable, wrong number — the exact failure this measurement
  // exists to prevent — so refuse it rather than report it.
  if (clickRegion.idx > writeIdx - toIdx(EDGE_GUARD_MS)) {
    throw new Error(
      `Click arrived at the very end of the ${RECORD_MS} ms window — your ` +
      `round-trip delay is longer than this can measure. That is almost ` +
      `always a Bluetooth headset; try a wired one.`,
    );
  }
  const clickIdx = onsetBefore(clickRegion.idx, clickRegion.peak, clickSearchStart);
  diag.clickMs = +ms(clickIdx).toFixed(1);
  diag.clickPeak = +clickRegion.peak.toFixed(4);
  // Distance from clickPeakMs to capturedMs is what says whether the click
  // landed at the edge of the RECORD_MS window instead of inside it.
  diag.clickPeakMs = +ms(clickRegion.idx).toFixed(1);
  diag.gapMs = +ms(clickIdx - markerIdx).toFixed(1);

  const latencyMs = ms(clickIdx - markerIdx) - SCHEDULED_GAP_MS;
  diag.latencyMs = Math.round(latencyMs);

  if (latencyMs < MIN_PLAUSIBLE_LATENCY_MS) {
    // A speaker→air→mic round trip is never this fast. Either the click was
    // missed and we latched onto noise, or the "mic" is a digital loopback
    // of the output (virtual/monitor input device) — in which case the value
    // is meaningless for a real singer. Fail loudly instead of returning a 0
    // that silently mis-aligns every take.
    throw new Error(
      `Measured ${Math.round(latencyMs)} ms — too low to be a real acoustic path. ` +
      `Check that the click plays through speakers (not headphones) and that your ` +
      `input device is a real microphone, not a loopback/monitor.`,
    );
  }
  return Math.round(latencyMs);
}

// ── Reducing a run of trials to one number ───────────────────────────────────

/** Trials per run. Five rather than three so one bad trial can be discarded
 *  outright and still leave a majority to average. */
export const TRIALS = 5;
/** A run needs at least this many successful trials to report anything. */
export const MIN_SUCCESSFUL_TRIALS = 3;
/** Spread (max − min across the kept trials) above which the measurement is
 *  not trustworthy. The same device measured repeatedly should land inside
 *  20–30 ms; field reports of 110 ms on one run and 250 ms on the next, same
 *  hardware, are what this catches — either the click isn't being detected or
 *  the audio path is being reconfigured between runs, and both make the
 *  resulting number worse than useless, since it is applied to every take. */
export const SPREAD_LIMIT_MS = 50;

/**
 * Reduce a run's trials to a single latency.
 *
 * Trimmed mean, not the plain median it used to be: with 5 trials we can throw
 * away the highest AND lowest (the shape a missed click takes) and average what
 * is left, which uses three measurements instead of betting everything on the
 * middle one. The spread of the KEPT trials is returned alongside — that is the
 * number that says whether to believe the value at all.
 */
export function summariseTrials(trials: number[]) {
  const sorted = [...trials].sort((a, b) => a - b);
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  const value = Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
  const low = trimmed[0];
  const high = trimmed[trimmed.length - 1];
  return {
    value,
    low,
    high,
    spread: trimmed.length > 1 ? high - low : 0,
    droppedCount: sorted.length - trimmed.length,
  };
}
