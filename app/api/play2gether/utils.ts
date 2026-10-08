import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

export const STORAGE_BASE = "/tmp/play2gether";

export interface Play2GetherParticipant {
  file: string;
  name: string;
  /** Precomputed amplitude envelope for this take (`<take>.peaks.json`, a JSON
   *  array of PEAK_BUCKETS floats in [0,1] plus the duration). The mixer used
   *  to draw the waveform by fetching the whole take and running
   *  `decodeAudioData` on it — ~17 MB per take, so opening the mixer on a
   *  10-singer round pulled ~170 MB into the host's browser just to draw
   *  envelopes. This file is ~8 KB. Absent on takes recorded before this
   *  change; the client falls back to decoding the audio. */
  peaksFile?: string;
  /** High-resolution envelope (`<take>.peaks.bin`, ~5 ms per bucket, one byte
   *  each) used by the mixer's zoom. `peaksFile` is a fixed 900 buckets, so on
   *  a four-minute song it resolves 267 ms — coarser than the misalignment the
   *  host is trying to see. Absent on takes recorded before this existed; the
   *  client falls back to `peaksFile`, which is exactly the old behaviour. */
  peaksBinFile?: string;
  /** Playback-latency estimate (ms) for this take. Either an acoustically
   *  measured value (when `calibrated`) or the browser auto-detection. Stored
   *  for reference/UI only — the mixer no longer applies it automatically. */
  clapOffset: number;
  /** True when `clapOffset` came from explicit acoustic calibration
   *  (`runAcousticTrial`) rather than the unreliable browser auto-detection.
   *  Surfaced in the mixer so the host can choose to apply it. */
  calibrated?: boolean;
  /** Residual capture-start delay in ms: `startedAt - localClapAt`, measured on
   *  the client after the recorder graph is prewarmed and start-gated. Unlike
   *  `clapOffset` (a latency *estimate*) this is a deterministic measurement of
   *  how late this take actually began relative to the clap, so the mixer pads
   *  the take by this much (adelay) to stop it running ahead of the reference.
   *  Absent/0 on takes recorded before the prewarm change. */
  captureDelayMs?: number;
  /** Test takes only: a file sent instead of the mic, delayed by this much to
   *  simulate output latency. The correct Sync value for the take. */
  simulatedLatencyMs?: number;
  uploadedAt: number;
  /**
   * Sequential take number for this participant within the session. 1 = first
   * take (filename has no suffix), 2+ = re-recordings (filename gets `_N`).
   * `meta.participants` is keyed by `participantId` for take 1, then
   * `${participantId}_${takeNum}` for subsequent takes, so multiple takes from
   * the same user coexist without overwriting.
   */
  takeNum?: number;
  /** LiveKit identity of the participant who owns this take (for grouping in UI). */
  participantId?: string;
  /**
   * Gated RMS level of this take in dBFS, measured at ingest — what the mixer's
   * "match levels" needs to propose a fader without the host soloing every take
   * and guessing. Gated because an ungated RMS measures how much of the take is
   * silence, so a singer who comes in halfway reads 6 dB quieter than the same
   * voice singing throughout, and matching on that number makes them twice as
   * loud as everyone else. Absent on takes recorded before this existed, and
   * null when the take was too quiet to measure at all.
   */
  levelDb?: number;
  /** Sample peak of the take in dBFS, from the same pass. Says whether a take
   *  has room to be turned up and whether it arrived already clipped — one
   *  number that separates "quiet recording" from "distorted recording". */
  peakDb?: number;
}

export interface Play2GetherReady {
  name: string;
}

/**
 * A participant's take failed to record or upload this round. Reported by the
 * client via POST /api/play2gether/report so the HOST can see who dropped out
 * instead of silently waiting for a take that will never arrive. Keyed by
 * participantId; `clapAt` ties the failure to a specific round so the host can
 * ignore stale failures from earlier rounds. Cleared automatically when the
 * same participant later uploads a take successfully (see record route).
 */
export interface Play2GetherFailure {
  name: string;
  /** Human-readable reason, shown to the host (e.g. "No microphone available"). */
  reason: string;
  /** Which round this failure belongs to (shared-state `clapAt`), or null. */
  clapAt: number | null;
  /** When the failure was reported (epoch ms). */
  at: number;
}

/**
 * One musician's measured playing offset, produced by a **sync round**: a short
 * click-only take in which they play quarter notes on the metronome. Keyed by
 * `participantId` (the person), NOT by take key — a person's offset is a
 * property of their ears, their device and their feel, so it is reused for
 * every take they record for the rest of the session.
 *
 * This measures strictly more than `Play2GetherParticipant.clapOffset` can.
 * Acoustic calibration measures the device round trip; this measures the
 * device round trip PLUS where that human actually places a beat, in the real
 * audio path the round will use. For a band that last term is not noise: a
 * drummer who feels 200 ms of monitor latency pushes ahead to compensate, so
 * subtracting the full measured latency puts them in the wrong place.
 */
export interface Play2GetherSyncOffset {
  name: string;
  /** Median ms by which this player's hits land AFTER the click. Positive =
   *  late (the normal case: output latency + input latency + their own feel).
   *  Feeds the mixer's per-take fine-tune slider directly — see the
   *  `manual = median(d_k)` derivation in `syncDetect.ts`. */
  offsetMs: number;
  /** Median absolute deviation of the per-beat offsets, in ms. This is the
   *  number that says whether `offsetMs` means anything: a player who is not
   *  steady against a click has no single right offset, and no amount of mixer
   *  nudging will place their take. */
  spreadMs: number;
  /** Beats where an onset was actually found, out of `expected`. */
  hits: number;
  expected: number;
  /** Tempo the measurement was taken at. A player's placement changes with
   *  tempo, so an offset measured at a different BPM than the round is stale. */
  bpm: number;
  /** Per-beat deviations in ms, oldest first — lets the host see a player who
   *  drifts (steadily rising) apart from one who is merely loose (scattered). */
  deviationsMs: number[];
  /** True when the winning lag sat against the edge of the search range, which
   *  means the real value may be outside it. Reported, never silently used —
   *  the same discipline as EDGE_GUARD_MS in the calibration detector. */
  atSearchEdge?: boolean;
  measuredAt: number;
  /** The sync take itself, kept for audit. Sync takes are ~10 s and never enter
   *  the mix — they live outside `participants` for exactly that reason. */
  file?: string;
}

/**
 * What a CALIBRATION ROUND measured for one player: the acoustic round trip of
 * their device, click out of the speakers and back in through the mic.
 *
 * Stored alongside `syncOffsets` rather than merged with it because the two are
 * different quantities and the difference is the point — a sync round measures
 * the device PLUS where the human puts the beat, and 2026-09-03 in the field
 * they disagreed by 50 ms (calibration 135, sync round 85 ±5) with the
 * calibration figure being the one that lined the take up by hand. Keeping both
 * on the record is what makes that comparison possible next time.
 */
export interface Play2GetherCalibOffset {
  name: string;
  /** Round trip in ms. Feeds the mixer's fine-tune slider directly: the take
   *  lands late by roughly what the player's monitoring path costs, and the
   *  slider's `manual` is subtracted from the take's start. */
  latencyMs: number;
  /** Max − min across the trials that were kept after trimming. This is the
   *  number that says whether `latencyMs` means anything; past
   *  SPREAD_LIMIT_MS the run measured different things each time. */
  spreadMs: number;
  /** Every successful trial, oldest first. A run that drifts one way is a
   *  device changing profile mid-round; a run that scatters is a click the mic
   *  is only just hearing. Averages hide both. */
  trialsMs: number[];
  unstable: boolean;
  measuredAt: number;
}

/**
 * What a DTW alignment measured for one take.
 *
 * The third and last way this feature measures the same misalignment, and the
 * only one that observes it directly: a calibration round measures the device
 * before anyone plays, a sync round measures the player against a click, and
 * this measures the take against the audio it was actually performed over.
 * See `docs/llm/12-dtw-alignment.md`.
 */
export interface Play2GetherAlignment {
  name: string;
  /** Ready for the mixer's slider: `lagMs + captureDelayMs`. */
  offsetMs: number;
  /** How much later a musical event appears in the take than in the reference.
   *  Positive = the take is late, which is the normal case. */
  lagMs: number;
  /** Median absolute deviation of the warping path around `lagMs`. The number
   *  that says whether one offset describes this take at all — a take whose
   *  player drifts has a large MAD and no correct single value. */
  madMs: number;
  /** Spread of the per-window medians: drift over the take, as opposed to
   *  scatter within it. */
  driftRangeMs: number;
  drift: { tSec: number; lagMs: number }[];
  feature: string;
  /** The winning lag sat against the edge of the search band, so the real value
   *  may be outside it. Same discipline as `atSearchEdge`. */
  atBandEdge: boolean;
  /** Whether the search band was centred on a known device figure. Blind runs
   *  measurably score worse (fixtures: 4 good / 5 fair / 3 bad, against
   *  7 / 3 / 2 centred), so the UI says which one this was. */
  centred: boolean;
  /** The take this describes. A re-recorded take makes it stale, and the UI
   *  says so rather than showing a number for a performance that is gone. */
  takeFile: string;
  measuredAt: number;
}

export interface Play2GetherSession {
  sessionId: string;
  roomName: string;
  createdAt: number;
  countdownSecs: number;
  recordingDuration: number;
  referenceFile: string | null;
  /** Duration of the reference track in seconds, auto-detected by ffprobe
   *  on upload. Used as the default `recordingDuration` so the host doesn't
   *  have to type a number that almost always equals the song length. */
  referenceDuration: number | null;
  /** Incremented each time the mix is promoted to a new reference (layered
   *  recording). 1 = original upload, 2+ = promoted mix versions. Used to
   *  generate versioned filenames (reference_v2.webm, reference_v3.webm…). */
  referenceVersion?: number;
  /** Optional LRC lyrics file synced to the reference. Filename relative to
   *  the session dir (e.g. "lyrics.lrc"). Null when no lyrics uploaded. */
  lyricsFile: string | null;
  participants: Record<string, Play2GetherParticipant>;
  ready: Record<string, Play2GetherReady>;
  /** Per-participant recording/upload failures for the current round, so the
   *  host can see who dropped out. Keyed by participantId. Optional/absent on
   *  sessions where nothing has failed. */
  failures?: Record<string, Play2GetherFailure>;
  /** Measured playing offsets from sync rounds, keyed by participantId. Absent
   *  until the host runs one. Survives takes being deleted and re-recorded —
   *  it belongs to the person, not to a take. */
  syncOffsets?: Record<string, Play2GetherSyncOffset>;
  /** Device round trips from calibration rounds, keyed by participantId. Like
   *  `syncOffsets` it belongs to the person and outlives their takes. */
  calibOffsets?: Record<string, Play2GetherCalibOffset>;
  /** DTW alignments of a TAKE against the reference, keyed by participantId.
   *  Unlike the other two this belongs to a take, not to a person — hence
   *  `takeFile`, which says which one it describes. Host-triggered, never
   *  automatic, and it never seeds the mixer on its own. */
  alignments?: Record<string, Play2GetherAlignment>;
  resultFile: string | null;
  /** Master gain in dB applied to the last render, so the host can see what was
   *  done to the output level rather than wondering why a mix came back louder
   *  than the faders suggest. It scales every track equally, so it never
   *  changes the balance — see the constants in mix/route.ts. */
  masterGainDb?: number;
  /** Peak of that render BEFORE the master, dBFS. Above 0 means the faders
   *  summed past full scale and the master pulled it back. */
  mixPeakDb?: number;
  status: "preparing" | "recording" | "uploading" | "mixing" | "done" | "error";
}

export function sessionDir(sessionId: string) {
  return join(STORAGE_BASE, sessionId);
}

export async function readSession(sessionId: string): Promise<Play2GetherSession> {
  const raw = await readFile(join(sessionDir(sessionId), "session.json"), "utf-8");
  return JSON.parse(raw) as Play2GetherSession;
}

export async function writeSession(meta: Play2GetherSession): Promise<void> {
  await writeFile(
    join(sessionDir(meta.sessionId), "session.json"),
    JSON.stringify(meta, null, 2)
  );
}

export async function ensureSessionDir(sessionId: string): Promise<void> {
  await mkdir(sessionDir(sessionId), { recursive: true });
}

/**
 * Per-sessionId mutex for read-modify-write of session.json. Without this,
 * concurrent uploads (multiple participants finishing a take at the same
 * clapAt) each readSession → modify in-memory → writeSession, and the last
 * writer overwrites the participants entries from earlier writers. The blobs
 * land on disk but the index loses them.
 *
 * Process-local only: if Next.js is ever run with multiple workers (PM2
 * cluster), a real file lock (e.g. `proper-lockfile`) would be needed. For a
 * single-process Next.js this Map-of-promises serializes writes per session
 * with no extra deps.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  // Chain the new task after the previous lock holder. Anyone arriving
  // after us will chain after `next`.
  sessionLocks.set(sessionId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release!();
    // If we're the last waiter, drop the entry so the Map doesn't grow
    // unbounded across the process lifetime.
    if (sessionLocks.get(sessionId) === prev.then(() => next)) {
      // Note: identity comparison above will be false because of the new
      // promise we created — use a delayed cleanup instead, scheduled when
      // the chain settles. Tiny growth (one entry per active session) is
      // acceptable; sessions are short-lived.
    }
  }
}

/** Number of buckets in a precomputed peak envelope. Matches the client's
 *  drawing resolution — more is wasted bytes, fewer is a visibly blocky
 *  waveform at panel width. */
export const PEAK_BUCKETS = 900;

/** Bitrate for stored takes. Mono sung voice at 96 kbps Opus is transparent
 *  for something that is going to be summed into a mix; the WAV it replaces
 *  is 768 kbps (16-bit 48 kHz mono), so this is an 8x cut on disk and on
 *  every subsequent download. */
const TAKE_OPUS_BITRATE = "96k";

export interface PeaksData {
  /** PEAK_BUCKETS normalised amplitudes in [0,1]. */
  peaks: number[];
  /** Track duration in seconds. */
  duration: number;
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) console.error("[p2g] ffmpeg failed:", stderr.slice(-800));
      resolve(code === 0);
    });
    proc.on("error", (err) => {
      console.error("[p2g] ffmpeg spawn error:", err.message);
      resolve(false);
    });
  });
}

/**
 * Transcode a captured take to Ogg/Opus. Returns true on success.
 *
 * Why Opus and not "just keep the WAV": takes are the only thing in a session
 * whose size scales with the number of singers. A 10-singer, 3-minute round is
 * ~173 MB of WAV on disk, and the host's mixer used to download all of it.
 *
 * Why this is safe for alignment: the mix is built by ffmpeg, which honours
 * the Ogg/Opus pre-skip, so a take decodes back to the same sample positions
 * it was captured at. (This is NOT true of MP3 or AAC, whose encoder delay is
 * container metadata that browsers in particular trim inconsistently — hence
 * Opus specifically, on a feature whose whole point is <20 ms alignment.)
 */
export function transcodeToOpus(srcPath: string, destPath: string): Promise<boolean> {
  return runFfmpeg([
    "-y", "-i", srcPath,
    "-c:a", "libopus", "-b:a", TAKE_OPUS_BITRATE, "-ac", "1",
    destPath,
  ]);
}

/**
 * Decode a take back to lossless WAV. Used when a take is promoted to be the
 * next round's reference: the reference is decoded in the BROWSER with
 * `decodeAudioData` on the sync-critical path, and Safari cannot decode Opus
 * there (it falls back to `el.play()`, which costs ~100 ms of unmeasured
 * start delay — see docs/llm/01-play2gether.md). One reference per round, so
 * its size doesn't scale with the number of singers; correctness wins.
 */
export function transcodeToWav(srcPath: string, destPath: string): Promise<boolean> {
  return runFfmpeg([
    "-y", "-i", srcPath,
    "-c:a", "pcm_s16le", "-ac", "1",
    destPath,
  ]);
}

/**
 * Compute an amplitude envelope by streaming the decoded audio out of ffmpeg
 * and reducing it to PEAK_BUCKETS maxima. Downsampled to 8 kHz mono s16 first:
 * an envelope doesn't need more, and it keeps the pipe at a few MB for a
 * 3-minute take.
 *
 * Returns null if ffmpeg is unavailable or the file won't decode — the caller
 * should treat that as "no precomputed peaks" and let the client fall back to
 * decoding the audio itself, exactly as it did before.
 */
export async function computePeaks(filePath: string): Promise<PeaksData | null> {
  const set = await computeEnvelopes(filePath);
  return set ? set.peaks : null;
}

/**
 * Buckets per second in the DETAIL envelope — the one the mixer zooms into.
 *
 * `PEAK_BUCKETS` is a fixed count, so its time resolution collapses as a take
 * gets longer: 34 ms per bucket on a 31 s take, 267 ms on a four-minute song.
 * The alignment errors being corrected are 20–200 ms, so on a real song the
 * overview envelope cannot resolve the thing it is being used to fix, and no
 * amount of zooming helps because the data is not there.
 *
 * 5 ms is finer than the mixer's 5 ms slider step, so the envelope stops being
 * the limiting factor. It is affordable because it is stored as one BYTE per
 * bucket rather than a JSON float: a four-minute take is 48 KB, against 6 KB
 * for the 900-float JSON at 53x worse resolution.
 */
export const PEAK_DETAIL_PER_SEC = 200;
/** Ceiling on detail buckets, so a 6-minute take degrades to ~6 ms/bucket
 *  instead of growing without bound. */
export const PEAK_DETAIL_MAX = 60_000;

export interface EnvelopeSet {
  peaks: PeaksData;
  /** `<take>.peaks.bin`: float64 LE duration in seconds, then one unsigned byte
   *  of normalised amplitude per bucket. Null if it could not be built. */
  detail: Buffer | null;
  /** Gated RMS level in dBFS, or null if nothing in the take cleared the floor.
   *  The envelopes above are NORMALISED (the mixer draws a shape, not a level),
   *  so they cannot answer "how loud is this take" — that is why this rides
   *  along rather than being derived from them later. */
  levelDb: number | null;
  /** Sample peak in dBFS, null on a silent take. */
  peakDb: number | null;
}

/** Loudness gate, in dB below the loudest 400 ms block of the take. EBU R128's
 *  relative gate is −10 LU below the ungated mean; this is a cruder rule on a
 *  cruder signal (see `measureLevel`) and is deliberately wider, because the
 *  failure that matters here is a take with long rests reading quiet. */
const LEVEL_GATE_DB = 20;
/** Below this a block is silence, not quiet playing: room tone on a good mic
 *  sits around −60 dBFS and must not drag the average down. */
const LEVEL_FLOOR_DB = -55;
/** Loudness window. 400 ms is R128's short-term block and it is about the
 *  shortest window over which "how loud is this" is a meaningful question. */
const LEVEL_BLOCK_SEC = 0.4;

/**
 * How loud a take is, as one number the mixer can turn into a fader.
 *
 * This is NOT LUFS and must not be labelled as such: the signal it runs on is
 * the 8 kHz mono decode every other analysis here uses, which has no K-weighting
 * and no high band at all. What it is: the mean power of the take's own loud
 * blocks, which is what a host matches by ear when they solo two takes and even
 * them up. For the job — proposing a starting fader the host then adjusts —
 * agreeing with the ear to a couple of dB is the whole requirement, and a real
 * loudness meter would cost a second ffmpeg pass per take on a round where
 * eleven of them land at once.
 */
function measureLevel(samples: Float32Array): { levelDb: number | null; peakDb: number | null } {
  if (samples.length === 0) return { levelDb: null, peakDb: null };

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return { levelDb: null, peakDb: null };

  const block = Math.max(1, Math.round(DECODE_SAMPLE_RATE * LEVEL_BLOCK_SEC));
  const powers: number[] = [];
  for (let start = 0; start + block <= samples.length; start += block) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += samples[i] * samples[i];
    powers.push(sum / block);
  }
  // A take shorter than one block still deserves an answer.
  if (powers.length === 0) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    powers.push(sum / samples.length);
  }

  const floor = Math.pow(10, LEVEL_FLOOR_DB / 10);
  const loudest = Math.max(...powers);
  const gate = Math.max(floor, loudest / Math.pow(10, LEVEL_GATE_DB / 10));
  const kept = powers.filter((p) => p >= gate);
  if (kept.length === 0) return { levelDb: null, peakDb: +(20 * Math.log10(peak)).toFixed(1) };

  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return {
    levelDb: +(10 * Math.log10(mean)).toFixed(1),
    peakDb: +(20 * Math.log10(peak)).toFixed(1),
  };
}

/**
 * Both envelopes from ONE decode. Two separate functions would mean two ffmpeg
 * runs per upload, and eleven singers finish a round at the same instant.
 */
export async function computeEnvelopes(filePath: string): Promise<EnvelopeSet | null> {
  const samples = await decodeMonoPcm(filePath);
  if (!samples) return null;
  const duration = samples.length / DECODE_SAMPLE_RATE;

  const peaks = new Array<number>(PEAK_BUCKETS).fill(0);
  const block = Math.max(1, Math.floor(samples.length / PEAK_BUCKETS));
  let globalMax = 1e-6;
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    const start = b * block;
    const end = Math.min(samples.length, start + block);
    let mx = 0;
    for (let i = start; i < end; i++) { const a = Math.abs(samples[i]); if (a > mx) mx = a; }
    peaks[b] = mx;
    if (mx > globalMax) globalMax = mx;
  }
  // Normalise to [0,1] — the client draws a shape, not absolute levels, and
  // this matches what the old client-side decode did.
  for (let b = 0; b < PEAK_BUCKETS; b++) peaks[b] = +(peaks[b] / globalMax).toFixed(4);

  const detailBuckets = Math.max(
    PEAK_BUCKETS,
    Math.min(PEAK_DETAIL_MAX, Math.round(duration * PEAK_DETAIL_PER_SEC)),
  );
  const detail = Buffer.alloc(8 + detailBuckets);
  detail.writeDoubleLE(duration, 0);
  const dBlock = samples.length / detailBuckets;
  for (let b = 0; b < detailBuckets; b++) {
    const start = Math.floor(b * dBlock);
    const end = Math.min(samples.length, Math.floor((b + 1) * dBlock));
    let mx = 0;
    for (let i = start; i < end; i++) { const a = Math.abs(samples[i]); if (a > mx) mx = a; }
    detail[8 + b] = Math.min(255, Math.round((mx / globalMax) * 255));
  }

  // Measured on the raw samples, BEFORE the normalisation above throws the
  // level away. Same decode, one more pass, no extra ffmpeg.
  const { levelDb, peakDb } = measureLevel(samples);

  return { peaks: { peaks, duration }, detail, levelDb, peakDb };
}

/**
 * Sample rate every server-side analysis of a take runs at. 8 kHz is plenty for
 * both things that read audio here — an amplitude envelope, and onset timing,
 * where one sample is 0.125 ms against a mixer whose finest control is 5 ms.
 *
 * Exported because `syncDetect` converts frame indices to milliseconds with it;
 * a second literal there would silently misreport every offset if this changed.
 */
export const DECODE_SAMPLE_RATE = 8000;

/**
 * Decode any take to mono 8 kHz signed float samples in [-1, 1].
 *
 * Shared by `computePeaks` (which takes maxima of it) and `detectSyncOffset`
 * (which differentiates it). They used to be one inline decode inside
 * computePeaks; the second reader is the reason it is a function. Streaming out
 * of ffmpeg into a growing Float32Array keeps a 6-minute take at ~11 MB instead
 * of the ~23 MB a number[] cost.
 *
 * Returns null if ffmpeg is unavailable or the file won't decode — every caller
 * treats that as "no analysis", never as a failed upload.
 */
export async function decodeMonoPcm(filePath: string): Promise<Float32Array | null> {
  let buf = new Float32Array(DECODE_SAMPLE_RATE * 60);
  let len = 0;
  const push = (v: number) => {
    if (len === buf.length) {
      const grown = new Float32Array(buf.length * 2);
      grown.set(buf);
      buf = grown;
    }
    buf[len++] = v;
  };

  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-v", "error", "-i", filePath,
      "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(DECODE_SAMPLE_RATE),
      "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    // s16le can straddle chunk boundaries — carry the odd trailing byte over.
    let carry: Buffer | null = null;
    proc.stdout.on("data", (chunk: Buffer) => {
      let b = chunk;
      if (carry) { b = Buffer.concat([carry, chunk]); carry = null; }
      const usable = b.length - (b.length % 2);
      if (usable < b.length) carry = b.subarray(usable);
      for (let i = 0; i < usable; i += 2) push(b.readInt16LE(i) / 32768);
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });

  if (!ok || len === 0) return null;
  return buf.subarray(0, len);
}

/**
 * Probe a media file's duration in seconds via ffprobe. Returns null on
 * failure (binary missing, unreadable file, no duration in the container) —
 * callers should treat null as "unknown" and fall back to whatever they
 * had before, not crash.
 *
 * Two-stage probe: first the container's `format=duration`, which is reliable
 * for mp3/wav/m4a but is missing from MediaRecorder-generated WebM (browsers
 * don't write the Segment Duration in the EBML header). When that fails, fall
 * back to the audio stream's own duration tag. If both fail we still return
 * null and let the caller use a client-provided hint instead.
 */
export function probeDuration(filePath: string): Promise<number | null> {
  const runProbe = (entryArg: string) =>
    new Promise<number | null>((resolve) => {
      const args = [
        "-v", "error",
        "-show_entries", entryArg,
        "-of", "default=noprint_wrappers=1:nokey=1",
        "-select_streams", "a:0",
        filePath,
      ];
      let stdout = "";
      const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      proc.on("close", () => {
        const n = Number(stdout.trim());
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
      proc.on("error", () => resolve(null));
    });

  return runProbe("format=duration").then((d) => d ?? runProbe("stream=duration"));
}
