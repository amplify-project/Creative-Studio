"use client";

/**
 * Shared latency-calibration UI used by both Play2GetherClientPanel (the
 * participant overlay) and Play2GetherHostPanel (the host's control panel).
 *
 * Why one shared module: the host can also be a singer (target = "me"), so
 * they need the same acoustic-loopback calibration available to participants.
 */

import { useEffect, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import type { Room } from "livekit-client";
import { Loader2, CheckCircle2, AlertTriangle, Gauge, ChevronRight } from "lucide-react";
import { AUDIO_MODE_PRESETS } from "./audioSelector";
import { p2gLog, withNet } from "../app/lib/p2gTelemetry";

/**
 * What a trial saw, beyond the number it returned.
 *
 * Every field is optional and filled in as the trial gets far enough to know
 * it: a trial that throws on "marker lost" still reports its noise floor and
 * device rates, and that partial picture is the whole point — a calibration
 * that FAILS is the case with no server-side trace today, and it is exactly
 * the case a host reports as "it wouldn't calibrate".
 */
export type CalibDiag = Partial<{
  sampleRate: number; baseLatency: number; outputLatency: number; recordMs: number;
  /** What the OS actually gave this measurement, as opposed to what it asked
   *  for. `trackDeviceId` / `trackSampleRate` are the pair that says whether
   *  calibration and the round ran through the same audio path at all. */
  trackDeviceId: string; trackSampleRate: number; trackLatency: number;
  trackChannels: number; aec: boolean; ns: boolean; agc: boolean;
  noiseFloor: number; capturedMs: number;
  markerMs: number; markerPeak: number;
  clickMs: number; clickPeak: number; clickPeakMs: number; gapMs: number;
  latencyMs: number;
}>;

/**
 * Plays a click via speakers + an internal sync marker, captures the mic, and
 * measures the gap between them. Subtracting the *scheduled* gap (200 ms) from
 * the *observed* gap gives round-trip audio latency in milliseconds without
 * caring where the AudioContext "started" in absolute time — any unknown
 * offsets cancel out.
 *
 *   buffer:  [.... marker .... acoustic click .... ]
 *   gap between them in samples − scheduled gap = round-trip latency.
 *
 * Requires AEC off (mic must capture its own speaker output, which the browser
 * normally cancels). Opens a fresh getUserMedia for the measurement so we don't
 * disturb the LiveKit mic track.
 */
/** Below this, the measurement is not a speaker→air→mic round trip. Even a
 *  wired laptop with the mic touching the speaker sits around 20–40 ms once
 *  output buffering, the ADC and the capture graph are counted. */
const MIN_PLAUSIBLE_LATENCY_MS = 8;

export async function runAcousticTrial(
  onDiag?: (d: CalibDiag) => void,
): Promise<number> {
  const diag: CalibDiag = {};
  const stream = await navigator.mediaDevices.getUserMedia({
    // `latency` is in the Media Capture spec and Chrome honours it, but
    // lib.dom's MediaTrackConstraints hasn't caught up — hence the cast,
    // kept as tight as possible around the one offending property.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Match the capture buffer the ROUND will actually record with.
      //
      // The take is recorded off the published LiveKit track, created from
      // AUDIO_MODE_PRESETS (see MediaControls' createLocalAudioTrack), and the
      // music preset asks for a 100 ms buffer. This measurement used to omit
      // `latency` entirely, so it got the browser's small default — it was
      // measuring a faster microphone path than the one being recorded, and
      // the difference (~90 ms on a real session) was invisible: the number
      // looked plausible and every take landed that much late.
      //
      // Taken from the preset rather than written as a literal so the two
      // cannot drift apart; drifting apart is the whole bug.
      //
      // Only the music preset is referenced on purpose: recording a take in
      // speech mode is already warned against room-wide before the round
      // (see the host panel's music-mode warning), so it is not a
      // configuration this measurement needs to be correct in.
      latency: AUDIO_MODE_PRESETS.music.capture.latency,
    } as MediaTrackConstraints,
  });
  // Record the path the OS actually handed back, before anything else.
  //
  // Calibration opens its OWN getUserMedia so it does not disturb the LiveKit
  // mic track, and asks for AEC/NS/AGC off — which on macOS and on a Bluetooth
  // headset is exactly the kind of request that makes the system re-pick a
  // profile or a device. If it does, the measurement is a correct number for
  // an audio path the ROUND never used. That failure already happened once on
  // the buffer-size axis (see the `latency` constraint above, ~90 ms invisible);
  // deviceId and sampleRate are what make the device axis visible too.
  try {
    const st = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & {
      latency?: number;
    } | undefined;
    if (st) {
      diag.trackDeviceId = st.deviceId ?? "";
      diag.trackSampleRate = st.sampleRate ?? 0;
      diag.trackLatency = st.latency ?? 0;
      diag.trackChannels = st.channelCount ?? 0;
      diag.aec = !!st.echoCancellation;
      diag.ns = !!st.noiseSuppression;
      diag.agc = !!st.autoGainControl;
    }
  } catch { /* getSettings is advisory; never fail a trial over it */ }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    await ctx.resume();
    await ctx.audioWorklet.addModule("/play2gether-capture-worklet.js");

    const sampleRate = ctx.sampleRate;

    // ── The measurement window ──────────────────────────────────────────────
    //
    // Everything is scheduled relative to `startAt`, which is itself
    // START_AT_LEAD_MS after the capture gate opens — so the buffer has to hold
    // that lead-in as well as the trip being measured.
    //
    // This used to be a flat `RECORD_MS = 900` commented as "long enough for up
    // to ~600 ms BT latency". It was not: the lead-in ate 50 of those, leaving
    // ~550, and the comment went on claiming 600. Deriving the window from the
    // same constants that schedule the clicks is the only way the budget and
    // the schedule cannot drift apart again — the identical reasoning behind
    // taking the capture `latency` from AUDIO_MODE_PRESETS rather than
    // re-typing it.
    const START_AT_LEAD_MS = 50;
    const MARKER_OFFSET_MS = 100;
    const CLICK_OFFSET_MS = 300;       // 200 ms after marker
    const SCHEDULED_GAP_MS = CLICK_OFFSET_MS - MARKER_OFFSET_MS;
    /** Longest round trip this is willing to measure. Not 600: A2DP output on
     *  macOS alone runs 150-300 ms and the input side adds its own, and a field
     *  session produced a participant needing more than 500. */
    const MAX_MEASURABLE_RT_MS = 1000;
    /** Slack after the latest click we accept, so its decay and the onset
     *  walk-back sit inside the buffer instead of being clipped by it. */
    const TAIL_MS = 80;
    const RECORD_MS =
      START_AT_LEAD_MS + CLICK_OFFSET_MS + MAX_MEASURABLE_RT_MS + TAIL_MS;
    /** A peak nearer than this to the end of the capture is not treated as the
     *  click. See the throw below. */
    const EDGE_GUARD_MS = 40;

    diag.recordMs = RECORD_MS;
    diag.sampleRate = sampleRate;
    diag.baseLatency = ctx.baseLatency;
    diag.outputLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;

    const bufSamples = Math.ceil((RECORD_MS / 1000) * sampleRate);
    const buf = new Float32Array(bufSamples);
    let writeIdx = 0;

    const micSource = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, "p2g-capture");
    workletNode.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        const chunk = e.data;
        for (let i = 0; i < chunk.length && writeIdx < bufSamples; i++) {
          buf[writeIdx++] = chunk[i];
        }
      }
    };
    micSource.connect(workletNode);
    // Pull-through (silent sink) so the audio thread actually processes.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    workletNode.connect(silent);
    silent.connect(ctx.destination);

    // The capture worklet is START-GATED (it discards input until the main
    // thread posts {cmd:"start"} — see play2gether-capture-worklet.js). The
    // main recorder flips this gate at the clap; calibration has no clap, so we
    // must open the gate ourselves BEFORE the marker/click fire, otherwise the
    // worklet captures nothing, the buffer stays all-zero, and the marker scan
    // fails with "Internal sync marker lost". (This regressed calibration when
    // the gate was introduced.)
    workletNode.port.postMessage({ cmd: "start" });

    const makeClick = () => {
      const dur = 0.005;
      const cb = ctx!.createBuffer(1, Math.ceil(dur * sampleRate), sampleRate);
      const cd = cb.getChannelData(0);
      for (let i = 0; i < cd.length; i++) {
        cd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sampleRate) * 800);
      }
      return cb;
    };

    const startAt = ctx.currentTime + START_AT_LEAD_MS / 1000;

    // Sync marker: routed DIRECTLY into the worklet input (bypasses speakers).
    // Lands in the recording at its scheduled time exactly — gives us a known
    // reference point regardless of capture-start jitter.
    const markerSrc = ctx.createBufferSource();
    markerSrc.buffer = makeClick();
    const markerGain = ctx.createGain();
    markerGain.gain.value = 0.7;
    markerSrc.connect(markerGain);
    markerGain.connect(workletNode);
    markerSrc.start(startAt + MARKER_OFFSET_MS / 1000);

    // Acoustic click: through destination (speakers). Returns via mic with
    // round-trip latency.
    const clickSrc = ctx.createBufferSource();
    clickSrc.buffer = makeClick();
    const clickGain = ctx.createGain();
    clickGain.gain.value = 1.0;
    clickSrc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickSrc.start(startAt + CLICK_OFFSET_MS / 1000);

    await new Promise((r) => setTimeout(r, RECORD_MS + 100));

    // Ask the worklet for its partially-filled buffer: it only posts on every
    // 4800 samples (~100 ms), so without this the last ~100 ms of the window is
    // missing — exactly the region where a high-latency Bluetooth click lands.
    workletNode.port.postMessage({ cmd: "flush" });
    await new Promise((r) => setTimeout(r, 60));

    workletNode.disconnect();
    micSource.disconnect();
    silent.disconnect();

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

    // Diagnostics: this runs a handful of times per session on explicit user
    // action, so it always logs. A bad calibration is otherwise invisible —
    // the number just looks plausible and every take lands wrong.
    console.log("[p2g-calib]", diag);
    // Raw capture for offline inspection (dump it to a WAV if a trial looks off).
    (window as unknown as Record<string, unknown>).__p2gCalibLast = { buf: buf.slice(0, writeIdx), ...diag };

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
  } finally {
    // Before the teardown, and outside the success path on purpose: a thrown
    // trial is the one worth seeing.
    try { onDiag?.(diag); } catch { /* never let telemetry fail a trial */ }
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) await ctx.close().catch(() => {});
  }
}

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

/**
 * Acoustic-loopback latency calibration UI. Runs TRIALS measurements and
 * reports a trimmed mean, plus the spread that says whether to believe it.
 * Replaces the auto-detected `baseLatency + outputLatency + micLatency` sum
 * used as `clapOffset` — especially useful on Bluetooth where the
 * API-reported numbers under-report by 100+ ms.
 *
 * Requires the mic to actually hear the click: speakers facing it at close
 * range, or an earcup pressed against it. Afterwards they can go back to
 * headphones.
 */
/**
 * One beacon per calibration RUN — not per trial, and emitted on failure too.
 *
 * A run happens a handful of times per session on an explicit click, so this
 * is far inside the telemetry budget described in p2gTelemetry. What it buys:
 * the numbers that separate the known ways this measurement goes wrong were
 * previously `console.log` only, i.e. available only to whoever happened to
 * have devtools open on the affected machine — which is never the machine
 * that had the problem.
 *
 * The per-trial fields are sent as arrays rather than averaged because the
 * failure modes show up as ONE bad trial among good ones:
 *
 *   - `clickPeakMs` close to `capturedMs` → the click landed at the edge of
 *     the RECORD_MS window rather than inside it, so the detector reported the
 *     loudest thing that was still in the buffer. Under-measurement.
 *   - `markerMs` not reflecting a large `outputLatency` → the marker arrived
 *     past its own 280 ms search window and something else was matched.
 *   - `clickPeak` barely above `noiseFloor` → the click is being cancelled or
 *     filtered before it reaches the capture, which is what system-level voice
 *     processing does to it by design.
 */
function reportRun(
  room: Room | null | undefined,
  ok: boolean,
  results: number[],
  diags: CalibDiag[],
  errors: string[],
) {
  const last = diags[diags.length - 1] ?? {};
  const summary = results.length ? summariseTrials(results) : null;
  p2gLog(room, "p2g_calib", withNet({
    outcome: ok ? "ok" : "failed",
    trialsOk: results.length,
    trialsFailed: TRIALS - results.length,
    valueMs: summary?.value ?? null,
    spreadMs: summary?.spread ?? null,
    unstable: summary ? summary.spread > SPREAD_LIMIT_MS : null,
    // Per trial — the shape of the run, not just its average.
    gapMs: diags.map((d) => d.gapMs ?? null),
    markerMs: diags.map((d) => d.markerMs ?? null),
    clickPeakMs: diags.map((d) => d.clickPeakMs ?? null),
    clickPeak: diags.map((d) => d.clickPeak ?? null),
    // Device-level, constant across trials.
    capturedMs: last.capturedMs ?? null,
    recordMs: last.recordMs ?? null,
    noiseFloor: last.noiseFloor ?? null,
    sampleRate: last.sampleRate ?? null,
    trackDeviceId: last.trackDeviceId ?? null,
    trackSampleRate: last.trackSampleRate ?? null,
    trackLatencyMs: last.trackLatency != null ? Math.round(last.trackLatency * 1000) : null,
    trackChannels: last.trackChannels ?? null,
    // Whether the three "off" requests were actually honoured. AEC on means the
    // click is being cancelled by design.
    proc: [last.aec, last.ns, last.agc].map((b) => (b == null ? null : b ? 1 : 0)),
    baseLatencyMs: last.baseLatency != null ? Math.round(last.baseLatency * 1000) : null,
    outputLatencyMs: last.outputLatency != null ? Math.round(last.outputLatency * 1000) : null,
    errors,
  }));
}

/** Pause between trials. Long enough for the previous trial's AudioContext and
 *  getUserMedia to be torn down before the next one asks for the device again —
 *  on macOS and on Bluetooth, re-opening instantly is what makes the OS re-pick
 *  a profile mid-run, which shows up as one wild trial among four good ones. */
const TRIAL_GAP_MS = 250;

/** Progress of a run in flight, for whatever is drawing it. */
export type CalibRunProgress = { trialIdx: number; results: number[]; failed: number };

/**
 * Flat rather than a discriminated union, for the same reason `SyncDetectResult`
 * is (see syncDetect.ts): this project compiles with `strict: false`, so
 * `{ok: true} | {ok: false}` narrows nowhere and every caller would be casting.
 * The measurement fields are set iff `ok`, `error` iff not.
 */
export type CalibRunOutcome = {
  ok: boolean;
  latencyMs?: number;
  spreadMs?: number;
  unstable?: boolean;
  error?: string;
  /** Successful trials, set either way — a failed run's partial trials are the
   *  evidence for WHY it failed. */
  trials: number[];
};

/**
 * One complete calibration run, headless.
 *
 * Lifted out of `CalibrationFlow` so the self-serve button and the host-driven
 * **calibration round** (`startCalibRound` in usePlay2GetherSession — everyone
 * measured at once) execute the same measurement, and not merely a similar one.
 * The round's entire claim is that the number it puts in front of the host is
 * the number the button has always produced; two copies of this loop would be
 * two ways to trim the trials, to count a failure and to decide what "unstable"
 * means, and they would drift apart silently because both would look right.
 */
export async function runCalibrationRun(
  room: Room | null | undefined,
  opts: {
    onProgress?: (p: CalibRunProgress) => void;
    /** Polled between trials and around each await. A cancelled run reports
     *  nothing and emits no beacon: it measured nothing. */
    cancelled?: () => boolean;
  } = {},
): Promise<CalibRunOutcome> {
  const results: number[] = [];
  const diags: CalibDiag[] = [];
  const errors: string[] = [];
  let failed = 0;
  let lastError: string | null = null;
  const stopped = () => opts.cancelled?.() === true;
  const abandoned = (): CalibRunOutcome => ({ ok: false, error: "cancelled", trials: results });

  for (let i = 0; i < TRIALS; i++) {
    if (stopped()) return abandoned();
    opts.onProgress?.({ trialIdx: i, results: [...results], failed });
    try {
      const ms = await runAcousticTrial((d) => diags.push(d));
      if (stopped()) return abandoned();
      results.push(ms);
    } catch (err) {
      if (stopped()) return abandoned();
      // A failing trial does not abort the run: five trials exist so a couple
      // can be lost and still leave a majority. Only a run that cannot reach
      // MIN_SUCCESSFUL_TRIALS gives up.
      failed++;
      lastError = err instanceof Error ? err.message : String(err);
      if (!errors.includes(lastError)) errors.push(lastError);
    }
    opts.onProgress?.({ trialIdx: i, results: [...results], failed });
    await new Promise((r) => setTimeout(r, TRIAL_GAP_MS));
  }
  if (stopped()) return abandoned();

  const ok = results.length >= MIN_SUCCESSFUL_TRIALS;
  reportRun(room, ok, results, diags, errors);
  if (!ok) {
    return {
      ok: false,
      error: lastError ?? `Only ${results.length} of ${TRIALS} trials produced a measurement.`,
      trials: results,
    };
  }
  const { value, spread } = summariseTrials(results);
  return {
    ok: true,
    // Negative is not a latency; it is a detection that went wrong. Clamped
    // here rather than at every call site.
    latencyMs: Math.max(0, value),
    spreadMs: spread,
    unstable: spread > SPREAD_LIMIT_MS,
    trials: results,
  };
}

/**
 * What a calibration ROUND is doing on this client. Lives here rather than in
 * the hook so both panels can render it without importing the hook that runs
 * it — the hook already imports this module.
 */
export type CalibRoundState = {
  status: "idle" | "waiting" | "running" | "done" | "failed";
  /** LOCAL epoch ms at which the clicks start. Null when idle. Local, not
   *  server: the only thing it is ever compared against is `Date.now()`. */
  startsAt: number | null;
  trialIdx: number;
  trials: number[];
  failed: number;
  latencyMs: number | null;
  spreadMs: number | null;
  unstable: boolean;
  error: string | null;
};

export const IDLE_CALIB_ROUND: CalibRoundState = {
  status: "idle", startsAt: null, trialIdx: 0, trials: [], failed: 0,
  latencyMs: null, spreadMs: null, unstable: false, error: null,
};

/**
 * The participant's view of a host-driven calibration round.
 *
 * Deliberately loud about the mic during the lead-in, and only then. The mic has
 * to hear the click or there is nothing to measure, and that failure is not
 * obvious from the inside — the old detector latched onto room noise and
 * reported a confident number near zero.
 *
 * **The instruction is "earcup against the mic", not "headphones off", and the
 * order matters.** Off the head, the click goes out of the SPEAKERS, and that is
 * not the output the take is monitored on — it is the one standing objection to
 * calibration as a mixing number. An earcup held to the mic sends it out of the
 * HEADPHONES, buffer, Bluetooth and all, so what comes back is the path the
 * player actually performs through. That is very probably what the 2026-09-03
 * measurement did, and why its 135 ms matched the take instead of describing a
 * different route. Speakers stay as the fallback for someone who cannot reach.
 */
export function CalibRoundPanel({ state }: { state: CalibRoundState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== "waiting") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [state.status]);

  if (state.status === "waiting") {
    const secs = Math.max(0, Math.ceil(((state.startsAt ?? now) - now) / 1000));
    return (
      <>
        <Gauge className="w-10 h-10 text-teal-400" />
        <div className="text-center">
          <p className="text-lg font-semibold text-white">Latency check in {secs}s</p>
          <p className="text-sm text-amber-200 mt-2 font-semibold">
            Hold one earcup against your microphone. Keep them on.
          </p>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            Your device plays {TRIALS} clicks and listens for them with your mic —
            if the mic can&apos;t hear them there is nothing to measure. Pressing an
            earcup to the mic is the RIGHT way: it measures the headphones you
            actually play through. Only if you can&apos;t reach, take them off and
            let the speakers do it. Quiet room for about ten seconds.
          </p>
        </div>
        <p className="text-4xl font-bold tabular-nums text-teal-300">{secs}</p>
      </>
    );
  }

  if (state.status === "running") {
    return (
      <>
        <Loader2 className="w-10 h-10 text-teal-400 animate-spin" />
        <div className="text-center">
          <p className="text-lg font-semibold text-white">Measuring your latency…</p>
          <p className="text-xs text-zinc-400 mt-1">
            Trial {Math.min(state.trialIdx + 1, TRIALS)} / {TRIALS} · keep quiet
          </p>
        </div>
        {state.trials.length > 0 && (
          <p className="text-xs text-zinc-500 font-mono">
            so far: {state.trials.map((m) => `${m}ms`).join(" · ")}
          </p>
        )}
        {state.failed > 0 && (
          <p className="text-[11px] text-amber-300/80 text-center">
            {state.failed} trial{state.failed > 1 ? "s" : ""} didn&apos;t hear the click —
            turn the volume up and keep going.
          </p>
        )}
      </>
    );
  }

  if (state.status === "done") {
    return (
      <>
        {state.unstable
          ? <AlertTriangle className="w-10 h-10 text-amber-400" />
          : <CheckCircle2 className="w-10 h-10 text-teal-400" />}
        <div className="text-center">
          <p className="text-lg font-semibold text-white">
            {state.unstable ? "Measured, but unstable" : "Latency measured"}
          </p>
          <p className="text-3xl font-bold tabular-nums text-teal-300 mt-1">
            {state.latencyMs} ms
          </p>
          <p className="text-xs text-zinc-400 mt-2">
            {state.unstable
              ? `The trials disagree by ${state.spreadMs} ms, so this number is soft — `
                + "usually the mic is only just hearing the click. Tell the host; "
                + "louder speakers and a quieter room fix it."
              : "Headphones back on. The host has your number."}
          </p>
        </div>
      </>
    );
  }

  if (state.status === "failed") {
    return (
      <>
        <AlertTriangle className="w-10 h-10 text-red-400" />
        <div className="text-center">
          <p className="text-sm font-semibold text-red-300">Couldn&apos;t measure your latency</p>
          <p className="text-xs text-zinc-400 mt-1">{state.error}</p>
          <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
            Almost always the mic never heard the click: headphones still on, speakers
            muted or too quiet. Tell the host — they can run it again for everyone.
          </p>
        </div>
      </>
    );
  }

  return null;
}

export function CalibrationFlow({
  onComplete, onCancel,
}: {
  /**
   * `meta` carries what the round's own result carries, because the two end up
   * in the same place: a self-serve calibration seeds the mixer exactly like a
   * round's does, and the host's card has to be able to tell an unstable run
   * from a clean one whichever way it was started. Passing only the value —
   * which is what this took before calibration seeded anything — would have
   * left the button producing a second-class number that looked identical.
   */
  onComplete: (
    ms: number,
    meta: { spreadMs: number; unstable: boolean; trials: number[] },
  ) => void;
  onCancel: () => void;
}) {
  type Stage = "auto-intro" | "auto-running" | "auto-result" | "auto-error";
  const [stage, setStage] = useState<Stage>("auto-intro");
  const [autoTrials, setAutoTrials] = useState<number[]>([]);
  const [autoTrialIdx, setAutoTrialIdx] = useState(0);
  const [failedTrials, setFailedTrials] = useState(0);
  const [autoError, setAutoError] = useState<string | null>(null);
  // Optional on purpose: the flow renders inside the room on both panels, but
  // it must not become unusable if it is ever mounted outside one.
  const room = useMaybeRoomContext();

  // The trial loop itself lives in `runCalibrationRun`, shared with the
  // host-driven calibration round. Each trial opens its own mic + AudioContext
  // so failures don't cascade, and a failing trial does not abort the run.
  useEffect(() => {
    if (stage !== "auto-running") return;
    let cancelled = false;
    (async () => {
      const outcome = await runCalibrationRun(room ?? null, {
        cancelled: () => cancelled,
        onProgress: ({ trialIdx, results, failed }) => {
          setAutoTrialIdx(trialIdx);
          setAutoTrials(results);
          setFailedTrials(failed);
        },
      });
      if (cancelled) return;
      if (!outcome.ok) { setAutoError(outcome.error); setStage("auto-error"); return; }
      setStage("auto-result");
    })();
    return () => { cancelled = true; };
  }, [stage]);

  const restart = () => {
    setAutoTrials([]); setAutoError(null); setAutoTrialIdx(0); setFailedTrials(0);
    setStage("auto-running");
  };

  if (stage === "auto-intro") {
    return (
      <>
        <Gauge className="w-10 h-10 text-teal-400" />
        <div className="text-center">
          <p className="text-lg font-semibold text-white">Acoustic calibration</p>
          <p className="text-xs text-zinc-400 mt-2">
            We'll play {TRIALS} short clicks through your speakers and detect them
            with your mic. Round-trip = your audio latency.
          </p>
          <ul className="text-[11px] text-zinc-500 mt-2 space-y-1 text-left list-disc pl-4">
            <li>
              <span className="text-zinc-300">Your mic must be able to hear the click.</span>{" "}
              Wearing headphones? <span className="text-zinc-300">Hold one earcup
              against the mic</span> — that measures the very output you play
              through. Taking them off works too, but then it measures your
              speakers, which is not the path your take is recorded on.
            </li>
            <li>Turn volume up to a comfortable level.</li>
            <li>Keep the room quiet for about ten seconds.</li>
          </ul>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">
            Cancel
          </button>
          <button onClick={restart}
            className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm font-semibold">
            Start
          </button>
        </div>
      </>
    );
  }

  if (stage === "auto-running") {
    return (
      <>
        <Loader2 className="w-10 h-10 text-teal-400 animate-spin" />
        <div className="text-center">
          <p className="text-lg font-semibold text-white">Measuring…</p>
          <p className="text-xs text-zinc-400 mt-1">
            Trial {Math.min(autoTrialIdx + 1, TRIALS)} / {TRIALS}
          </p>
        </div>
        {autoTrials.length > 0 && (
          <p className="text-xs text-zinc-500 font-mono">
            so far: {autoTrials.map((m) => `${m}ms`).join(" · ")}
          </p>
        )}
        {failedTrials > 0 && (
          <p className="text-[11px] text-amber-300/80">
            {failedTrials} trial{failedTrials > 1 ? "s" : ""} didn&apos;t hear the
            click — carrying on with the rest.
          </p>
        )}
      </>
    );
  }

  if (stage === "auto-error") {
    return (
      <>
        <AlertTriangle className="w-10 h-10 text-red-400" />
        <div className="text-center">
          <p className="text-sm font-semibold text-red-300">Calibration failed</p>
          <p className="text-xs text-zinc-400 mt-1">{autoError}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">
            Cancel
          </button>
          <button onClick={restart}
            className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm font-semibold">
            Retry
          </button>
        </div>
      </>
    );
  }

  if (stage === "auto-result") {
    const { value, low, high, spread, droppedCount } = summariseTrials(autoTrials);
    const latency = Math.max(0, value);
    // A wide spread means the run measured different things, so the number is
    // not a property of the device. Reporting "232 ms" with a confident tick
    // is what makes that dangerous — it gets applied to every take.
    const unstable = spread > SPREAD_LIMIT_MS;
    return (
      <>
        {unstable
          ? <AlertTriangle className="w-10 h-10 text-amber-400" />
          : <CheckCircle2 className="w-10 h-10 text-teal-400" />}
        <p className="text-lg font-semibold text-white">
          {unstable ? "Measurement not stable" : "Calibration done"}
        </p>
        <div className="w-full text-xs text-zinc-400 font-mono bg-zinc-800 rounded p-2 space-y-1">
          <p>Trials: {autoTrials.map((m) => `${m}ms`).join(" · ")}</p>
          <p className="text-[11px] text-zinc-500">
            kept {low}–{high} ms (spread {spread} ms)
            {droppedCount > 0 && `, dropped the ${droppedCount === 1 ? "outlier" : "2 extremes"}`}
          </p>
          <p className={`font-bold pt-1 border-t border-zinc-700 ${unstable ? "text-amber-300" : "text-teal-300"}`}>
            Audio latency: {latency} ms
          </p>
        </div>

        {unstable ? (
          <>
            <p className="text-[11px] leading-snug text-amber-200/80 text-center">
              The same device should measure within ~{SPREAD_LIMIT_MS} ms; these
              disagree by {spread} ms. Usually the mic isn&apos;t really hearing
              the click — press an earcup or speaker against it and quieten the
              room. Measure under the conditions you&apos;ll record in (room
              joined, music mode): output latency depends on what the audio
              device is already doing.
            </p>
            <div className="flex gap-2">
              <button onClick={restart}
                className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm font-semibold">
                Measure again
              </button>
              <button onClick={onCancel}
                className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">
                Cancel
              </button>
            </div>
            {/* Escape hatch rather than a hard block: some hardware genuinely is
                this jittery, and a rough number the singer KNOWS is rough still
                beats the browser's estimate. Deliberately the quiet option. */}
            <button
              onClick={() => onComplete(latency, { spreadMs: spread, unstable, trials: autoTrials })}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 underline">
              Save {latency} ms anyway
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button onClick={restart}
              className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm">
              Retry
            </button>
            <button
              onClick={() => onComplete(latency, { spreadMs: spread, unstable, trials: autoTrials })}
              className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm font-semibold">
              Save
            </button>
          </div>
        )}
      </>
    );
  }

  return null;
}

/**
 * Compact device-latency row (channel-strip aesthetic). Calibrated → shows the
 * measured value + Re-calibrate / Clear; not calibrated → a tappable row that
 * opens the acoustic test. Shared by the host panel and the participant overlay.
 */
export function CalibrationButton({ calibratedLatencyMs, onOpen, onClear, warn = false }: {
  calibratedLatencyMs: number | null;
  onOpen: () => void;
  onClear: () => void;
  /** Render the uncalibrated state as a warning (amber, states the consequence)
   *  rather than a neutral suggestion. Set it where a take is imminent: an
   *  uncalibrated singer records against the browser's latency *estimate*,
   *  which under-reports Bluetooth by 100–300 ms, and nobody finds out until
   *  the host opens the mixer — by then the take already exists. Calibrating
   *  first is ~10 s; re-recording afterwards costs the whole round. */
  warn?: boolean;
}) {
  if (calibratedLatencyMs != null) {
    return (
      <div className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-xl bg-zinc-800/50 border border-zinc-700">
        <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0
                         text-teal-400 bg-teal-500/10 border border-teal-500/25">
          <Gauge className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 leading-tight">
          <p className="text-[12.5px] font-semibold text-zinc-100">Latency calibrated</p>
          <p className="text-[11px] text-zinc-400 tabular-nums">{calibratedLatencyMs} ms · this device</p>
        </div>
        <button onClick={onOpen}
          className="ml-auto text-[11.5px] font-semibold text-teal-400 hover:underline shrink-0">
          Re-calibrate
        </button>
        <button onClick={onClear}
          className="text-[11.5px] text-zinc-500 hover:text-zinc-300 shrink-0">
          Clear
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={onOpen}
      className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-xl text-left transition-colors
                  ${warn
                    ? "bg-amber-950/50 border border-amber-600/60 hover:border-amber-400"
                    : "bg-zinc-800/50 border border-zinc-700 hover:border-teal-500/40"}`}
    >
      <span className={`w-7 h-7 rounded-lg grid place-items-center shrink-0
                        ${warn
                          ? "text-amber-400 bg-amber-500/10 border border-amber-500/30"
                          : "text-zinc-400 bg-zinc-900 border border-zinc-700"}`}>
        {warn ? <AlertTriangle className="w-3.5 h-3.5" /> : <Gauge className="w-3.5 h-3.5" />}
      </span>
      <div className="min-w-0 leading-tight">
        <p className={`text-[12.5px] font-semibold ${warn ? "text-amber-200" : "text-zinc-100"}`}>
          {warn ? "Not calibrated yet" : "Calibrate audio latency"}
        </p>
        <p className={`text-[11px] ${warn ? "text-amber-200/70" : "text-zinc-400"}`}>
          {warn
            ? "Your take may land out of sync — tap to measure (~10 s)"
            : "Using auto-detected estimate — tap to measure"}
        </p>
      </div>
      <ChevronRight className={`w-4 h-4 ml-auto shrink-0 ${warn ? "text-amber-400/70" : "text-zinc-500"}`} />
    </button>
  );
}
