/**
 * Where a Play2Gether take lost audio, as far as the client can tell.
 *
 * Two independent views, both reported on the `p2g_take` beacon:
 *
 * - The capture worklet's own counters (`public/play2gether-capture-worklet.js`):
 *   runs of exact digital zeros in the samples it wrote. That is what a gap
 *   looks like from inside the graph — when the mic or the track's FIFO runs
 *   dry the browser feeds silence, not an empty input. Counted in every browser.
 *
 * - `MediaStreamTrack.stats` (Chrome only): frames the track produced but never
 *   delivered to its sinks, between the clap and the stop. Safari and Firefox
 *   don't have it, so those fields are simply absent there.
 *
 * Telemetry only for now: nothing here changes the take, the mix or the UI.
 * The third kind of loss — render callbacks the recorder never got — is
 * already `ctxLagMs`, and it leaves no zeros behind (the take just comes out
 * shorter), so it is deliberately not counted again here.
 */

/** How long the teardown waits for the worklet's `done` before giving up. */
export const CAPTURE_DONE_TIMEOUT_MS = 500;

/** Gap events listed individually on the beacon; the totals cover the rest. */
const MAX_LISTED_GAPS = 12;

/** The worklet's `done` message for a take that started. */
export type CaptureStats = {
  type: "done";
  started: true;
  sampleRate: number;
  writtenSamples: number;
  emptyQuanta: number;
  shortQuanta: number;
  zeroRuns: number;
  zeroRunSamples: number;
  longestZeroRun: number;
  /** First runs in the take, in samples from the start gate. */
  gaps: { at: number; len: number }[];
};

export type TrackAudioStatsSnapshot = {
  totalFrames: number;
  deliveredFrames: number;
  totalFramesDuration: number;     // ms
  deliveredFramesDuration: number; // ms
};

const ms = (samples: number, sampleRate: number) =>
  Math.round((samples / sampleRate) * 10000) / 10;

/** `p2g_take` fields from the worklet's counters; empty when it never reported. */
export function captureGapFields(stats: CaptureStats | null): Record<string, unknown> {
  if (!stats || !(stats.sampleRate > 0)) return { gapStats: false };
  const sr = stats.sampleRate;
  return {
    gapStats: true,
    gapCount: stats.zeroRuns,
    gapMs: ms(stats.zeroRunSamples, sr),
    gapLongestMs: ms(stats.longestZeroRun, sr),
    emptyQuanta: stats.emptyQuanta,
    shortQuanta: stats.shortQuanta,
    writtenMs: ms(stats.writtenSamples, sr),
    // "12.34s+45.0ms" — readable straight off the admin page.
    gaps: stats.gaps.length
      ? stats.gaps
          .slice(0, MAX_LISTED_GAPS)
          .map((g) => `${(g.at / sr).toFixed(2)}s+${ms(g.len, sr)}ms`)
          .join(" ")
      : undefined,
  };
}

/** Snapshot `track.stats`, or null where the browser doesn't implement it. */
export function readTrackAudioStats(track: MediaStreamTrack | null): TrackAudioStatsSnapshot | null {
  try {
    const s = (track as (MediaStreamTrack & { stats?: Partial<TrackAudioStatsSnapshot> }) | null)?.stats;
    if (!s || typeof s.totalFrames !== "number" || typeof s.deliveredFrames !== "number") return null;
    return {
      totalFrames: s.totalFrames,
      deliveredFrames: s.deliveredFrames,
      totalFramesDuration: s.totalFramesDuration ?? 0,
      deliveredFramesDuration: s.deliveredFramesDuration ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Frames the track dropped during the take. Absent (not zero) when either
 * snapshot is missing, so "no data" never reads as "no loss".
 */
export function trackDropFields(
  start: TrackAudioStatsSnapshot | null,
  end: TrackAudioStatsSnapshot | null,
): Record<string, unknown> {
  if (!start || !end) return {};
  const dropped = (s: TrackAudioStatsSnapshot) => s.totalFrames - s.deliveredFrames;
  const droppedMs = (s: TrackAudioStatsSnapshot) => s.totalFramesDuration - s.deliveredFramesDuration;
  return {
    trackDroppedFrames: Math.max(0, dropped(end) - dropped(start)),
    trackDroppedMs: Math.max(0, Math.round((droppedMs(end) - droppedMs(start)) * 10) / 10),
    trackTotalFrames: end.totalFrames - start.totalFrames,
  };
}
