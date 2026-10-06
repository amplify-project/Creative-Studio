/**
 * Mic capture helpers shared by MediaControls and JoinSetup.
 *
 * Three things live here so the publish paths agree on them:
 *
 * 1. **Which mode a live mic was captured in.** Read from the track's own
 *    *requested* constraints (`LocalTrack.constraints`), never from
 *    `getSettings()`: iOS WebKit reports echoCancellation=true even when music
 *    asked for false, and reading the effective value would make a music track
 *    look like speech forever and re-capture in a loop. The room, not React
 *    state, says what is live — same rule as the rest of doc 08.
 *
 * 2. **Building the capture for a mode.** Speech is mono (echo cancellation
 *    processes in mono anyway). Music is stereo unless this input device has
 *    been seen with a dead channel — see 3.
 *
 * 3. **Dead-channel detection.** A USB interface with the mic in input 1 gives
 *    a stereo capture whose right channel is empty, so the room hears that
 *    person in one ear only (or 3 dB down after a downmix). We watch a stereo
 *    music capture until there is sound; if one side stays ~30 dB under the
 *    other, the device is remembered as mono and re-captured in mono. A real
 *    stereo source (keyboard, stereo pair) shows both sides active and keeps
 *    its stereo.
 */

import { Track } from "livekit-client";
import { AUDIO_MODE_PRESETS, type AudioCaptureState, type AudioMode } from "../../components/audioSelector";

// ── 1. Mode of a live track ──────────────────────────────────────────────────

function unwrap(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as { exact?: unknown; ideal?: unknown };
    return o.exact ?? o.ideal;
  }
  return v;
}

/** "music" | "speech" from what the track was REQUESTED with, or null when it
 *  can't be told (no constraints exposed) — callers must then leave it alone. */
export function captureModeOf(track: any): AudioMode | null {
  const c = track?.constraints as MediaTrackConstraints | undefined;
  if (!c) return null;
  const ec = unwrap(c.echoCancellation);
  if (ec === false) return "music";
  if (ec === true) return "speech";
  return null;
}

/** Requested channel count of a live track (1 when not specified). */
export function requestedChannelsOf(track: any): number {
  const n = Number(unwrap((track?.constraints as MediaTrackConstraints | undefined)?.channelCount));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The live local mic publication, if any. */
export function liveMicPub(room: any): any | null {
  if (!room?.localParticipant) return null;
  const pubs = Array.from(room.localParticipant.trackPublications.values()) as any[];
  return (
    pubs.find((p) => p.track?.kind === Track.Kind.Audio && p.source === Track.Source.Microphone) ??
    pubs.find((p) => p.track?.kind === Track.Kind.Audio) ??
    null
  );
}

// ── 2. Building the capture ──────────────────────────────────────────────────

const MONO_KEY = "amplify.monoInputs";

function readMonoSet(): Set<string> {
  try {
    const raw = localStorage.getItem(MONO_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** True when this input device was seen giving a stereo capture with one dead side. */
export function isMonoInput(deviceId?: string | null): boolean {
  return !!deviceId && readMonoSet().has(deviceId);
}

export function markMonoInput(deviceId?: string | null): void {
  if (!deviceId) return;
  try {
    const s = readMonoSet();
    s.add(deviceId);
    localStorage.setItem(MONO_KEY, JSON.stringify([...s].slice(-20)));
  } catch {
    /* storage unavailable — detection just runs again next capture */
  }
}

/** Capture constraints for a mode on a given device. */
export function captureFor(
  mode: AudioMode,
  deviceId: string,
  base?: Partial<AudioCaptureState>,
): AudioCaptureState {
  const preset = AUDIO_MODE_PRESETS[mode].capture;
  const stereo = mode === "music" && preset.channelCount >= 2 && !isMonoInput(deviceId);
  return {
    ...(base ?? {}),
    ...preset,
    channelCount: stereo ? 2 : 1,
    deviceId,
  } as AudioCaptureState;
}

// ── 3. Dead-channel detection ────────────────────────────────────────────────

/**
 * Watch a stereo track until it has had sound for a while, then report whether
 * one side was dead. Calls `onDead()` at most once; never calls it for a mono
 * track, a muted one, or a real stereo source. Returns a cancel function.
 *
 * Decision rule (100 ms frames, only frames where the louder side is above
 * -50 dBFS count — silence and a muted track say nothing):
 *   - 1.5 s of frames with the sides > 30 dB apart → dead channel.
 *   - 1.5 s of frames with the sides < 12 dB apart → real stereo, stop.
 *   - 90 s of listening (running context, unmuted track) without a verdict →
 *     stop, leave it alone.
 *
 * The host's mic is published before any click, when the AudioContext starts
 * suspended; it is resumed on every tick until a gesture lets it run.
 */
export function watchForDeadChannel(mst: MediaStreamTrack, onDead: () => void): () => void {
  let settings: MediaTrackSettings = {};
  try { settings = mst.getSettings(); } catch { /* ignore */ }
  if ((settings.channelCount ?? 1) < 2) return () => {};
  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined" ? (window.AudioContext || (window as any).webkitAudioContext) : undefined;
  if (!AC) return () => {};

  let done = false;
  let ctx: AudioContext;
  try {
    ctx = new AC();
  } catch {
    return () => {};
  }
  ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(new MediaStream([mst]));
  const split = ctx.createChannelSplitter(2);
  const aL = ctx.createAnalyser();
  const aR = ctx.createAnalyser();
  aL.fftSize = aR.fftSize = 2048;
  src.connect(split);
  split.connect(aL, 0);
  split.connect(aR, 1);

  const buf = new Float32Array(2048);
  const dbOf = (a: AnalyserNode) => {
    a.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return 10 * Math.log10(s / buf.length + 1e-24);
  };
  let deadMs = 0, bothMs = 0, listenedMs = 0;

  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(iv);
    try { src.disconnect(); } catch { /* ignore */ }
    ctx.close().catch(() => {});
  };
  const iv = setInterval(() => {
    if (mst.readyState === "ended") return stop();
    if (ctx.state !== "running") { ctx.resume().catch(() => {}); return; }
    if (!mst.enabled) return; // muted: silence says nothing
    listenedMs += 100;
    const l = dbOf(aL), r = dbOf(aR);
    const hi = Math.max(l, r), gap = Math.abs(l - r);
    if (hi > -50) {
      if (gap > 30) deadMs += 100;
      else if (gap < 12) bothMs += 100;
    }
    if (deadMs >= 1500) { stop(); onDead(); }
    else if (bothMs >= 1500 || listenedMs > 90_000) stop();
  }, 100);
  return stop;
}

// ── Telemetry snapshot ───────────────────────────────────────────────────────

/** What was asked for vs what the browser applied — the pair that tells "iOS
 *  forced voice processing" apart from "our code asked for it". */
export function micSnapshot(track: any): Record<string, unknown> {
  const c = (track?.constraints ?? {}) as MediaTrackConstraints & Record<string, unknown>;
  let s: MediaTrackSettings & Record<string, unknown> = {};
  try { s = track?.mediaStreamTrack?.getSettings?.() ?? {}; } catch { /* ignore */ }
  const short = (v: unknown) => (typeof v === "string" ? (v === "default" ? v : v.slice(0, 8)) : v ?? null);
  return {
    mode: captureModeOf(track),
    // "default" vs a specific id: the music/speech switch used to fall back
    // to "default" and ignore the mic the user had picked.
    device: { requested: short(unwrap(c.deviceId)), opened: short(s.deviceId) },
    requested: {
      echoCancellation: unwrap(c.echoCancellation),
      noiseSuppression: unwrap(c.noiseSuppression),
      autoGainControl: unwrap(c.autoGainControl),
      voiceIsolation: unwrap(c.voiceIsolation),
      channelCount: unwrap(c.channelCount),
    },
    effective: {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      voiceIsolation: (s as any).voiceIsolation,
      channelCount: s.channelCount,
      sampleRate: s.sampleRate,
      latency: (s as any).latency,
    },
  };
}
