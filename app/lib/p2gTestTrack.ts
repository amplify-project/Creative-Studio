/**
 * Test track: a participant sends an audio FILE as their take instead of the
 * microphone, delayed by a simulated output latency. Lets a host exercise the
 * whole round (countdown, staggered upload, record route, mixer, DTW) with a
 * known answer and without musicians.
 *
 * The simulation, and why it is just a delay: a real player hears the
 * reference `L` ms late (their output latency) and plays in time with what they
 * hear, so everything they play lands `L` ms late in their take. A take that is
 * the file preceded by `L` ms of silence is exactly that player, minus the
 * human. The correct Sync value for such a take is therefore `L` — which the
 * mixer shows next to it, so every alignment method can be checked against it.
 *
 * Opt-in only: the picker appears with `?p2gtest` in the participant's URL.
 */

export type P2GTestTrack = {
  name: string;
  /** Mono, at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  /** Simulated output latency: how late the take lands, in ms. */
  latencyMs: number;
  /** Send `latencyMs` as this take's calibration (a perfectly calibrated
   *  player), or send nothing (an uncalibrated one). */
  reportAsCalibration: boolean;
};

/** Decode a file to mono at 48 kHz — the rate real takes are captured at. */
export async function decodeTestTrack(file: File): Promise<{ samples: Float32Array; sampleRate: number }> {
  const sampleRate = 48000;
  // An offline context's decodeAudioData resamples to the context's rate.
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await ctx.decodeAudioData(await file.arrayBuffer());
  const samples = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) samples[i] += ch[i] / audio.numberOfChannels;
  }
  return { samples, sampleRate };
}

/**
 * The take a player with this latency would have produced over a round of
 * `durationMs`: `latencyMs` of silence, then the track, cut or padded with
 * silence to the round's length.
 */
export function buildTestTake(
  samples: Float32Array,
  sampleRate: number,
  latencyMs: number,
  durationMs: number,
): Float32Array {
  const total = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  const lead = Math.min(total, Math.max(0, Math.round((latencyMs / 1000) * sampleRate)));
  const out = new Float32Array(total);
  out.set(samples.subarray(0, total - lead), lead);
  return out;
}
