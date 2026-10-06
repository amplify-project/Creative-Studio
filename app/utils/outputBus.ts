"use client";

/**
 * The listener's output: which speaker, and how loud.
 *
 * LiveKit's remote audio follows `room.switchActiveDevice("audiooutput")` and
 * `participant.setVolume`, but everything the app plays by itself — the
 * Play2Gether reference, metronome, clap, the finished mix, the host's mixer
 * preview, UI chimes — goes through its own `<audio>` element or AudioContext,
 * and those follow neither. They used to play at full scale on the SYSTEM
 * default output. Field report 2026-09-28: a participant on a Mac with EarPods
 * chosen as the speaker heard the room in the EarPods and every Play2Gether
 * sound out of the laptop speakers ("the audio switches to the in-built"), and
 * turning the volume down did nothing to it.
 *
 * So there is one bus. Anything that makes sound registers with it:
 *   - an element → `routeElement(el)`: `setSinkId` + `.volume`
 *   - a context  → connect to `outputNode(ctx)` instead of `ctx.destination`:
 *     a per-context master gain, and `AudioContext.setSinkId` on the context.
 * Both are updated live when the listener changes device or volume, so the bus
 * never needs to know which feature a sound belongs to.
 *
 * The values live in localStorage (per viewer, per device); the read/write
 * helpers are in useOutputVolume, which also applies them to LiveKit.
 *
 * `setSinkId` is Chromium-only (AudioContext's since Chrome 110). Where it is
 * missing the device half is a no-op — the same place the picker is hidden —
 * and the volume half still works.
 */

import {
  readStoredOutputDevice,
  readStoredVolume,
  writeStoredOutputDevice,
  writeStoredVolume,
} from "../hooks/useOutputVolume";

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

type Listener = (s: { deviceId: string; volume: number }) => void;

const listeners = new Set<Listener>();
const elements = new Set<HTMLMediaElement>();
/** Contexts we have a master gain on. A Map, not a WeakMap, because a live
 *  change of device/volume has to walk them; closed ones are pruned on the walk. */
const contexts = new Map<AudioContext, GainNode>();

let cached: { deviceId: string; volume: number } | null = null;

export function getOutputState(): { deviceId: string; volume: number } {
  if (!cached) cached = { deviceId: readStoredOutputDevice(), volume: readStoredVolume() };
  return cached;
}

function applySink(target: SinkCapable, deviceId: string): Promise<void> {
  if (typeof target.setSinkId !== "function") return Promise.resolve();
  // "" is the system default for both the element and the context API.
  return target.setSinkId(deviceId).catch((err) => {
    console.warn("[outputBus] setSinkId failed — staying on the current output:", err);
  });
}

/** Route an element through the bus. Safe to call repeatedly on the same one. */
export function routeElement(el: HTMLMediaElement): void {
  const { deviceId, volume } = getOutputState();
  elements.add(el);
  el.volume = volume;
  if (deviceId) void applySink(el as unknown as SinkCapable, deviceId);
}

export function unrouteElement(el: HTMLMediaElement): void {
  elements.delete(el);
}

/**
 * The node to connect a context's audible output to, in place of
 * `ctx.destination`. One master gain per context, created on first use; the
 * context is pointed at the chosen speaker at the same moment.
 *
 * A gain node adds no latency, so this is safe on the timing-critical
 * Play2Gether monitor context.
 */
export function outputNode(ctx: AudioContext): AudioNode {
  const existing = contexts.get(ctx);
  if (existing) return existing;
  // UI chimes make a short-lived context each; drop the closed ones here too,
  // not only on a device/volume change, so they don't pile up in the map.
  contexts.forEach((_g, c) => { if (c.state === "closed") contexts.delete(c); });
  const { deviceId, volume } = getOutputState();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  contexts.set(ctx, gain);
  if (deviceId) void applySink(ctx as unknown as SinkCapable, deviceId);
  return gain;
}

/**
 * Point a context at the chosen speaker WITHOUT the volume gain, and wait for
 * it. For measurements (the acoustic calibration) that must run on the device
 * the listener actually hears, at a level the listener's volume must not
 * change.
 */
export function routeContextDeviceOnly(ctx: AudioContext): Promise<void> {
  const { deviceId } = getOutputState();
  return deviceId ? applySink(ctx as unknown as SinkCapable, deviceId) : Promise.resolve();
}

function broadcast(deviceChanged: boolean): void {
  const s = getOutputState();
  elements.forEach((el) => {
    el.volume = s.volume;
    if (deviceChanged) void applySink(el as unknown as SinkCapable, s.deviceId);
  });
  contexts.forEach((gain, ctx) => {
    if (ctx.state === "closed") { contexts.delete(ctx); return; }
    gain.gain.setTargetAtTime(s.volume, ctx.currentTime, 0.02);
    if (deviceChanged) void applySink(ctx as unknown as SinkCapable, s.deviceId);
  });
  notify();
}

function notify(): void {
  const s = getOutputState();
  listeners.forEach((l) => { try { l(s); } catch { /* one listener never blocks the rest */ } });
}

export function setOutputVolume(v: number): void {
  const volume = Math.max(0, Math.min(1, v));
  writeStoredVolume(volume);
  cached = { ...getOutputState(), volume };
  broadcast(false);
}

export function setOutputDevice(deviceId: string): void {
  writeStoredOutputDevice(deviceId);
  cached = { ...getOutputState(), deviceId };
  broadcast(true);
}

export function subscribeOutput(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// ─── Temporary holds on the room's audio ─────────────────────────────────────
//
// Some moments need everyone else quieter for a while without touching the
// listener's own volume: a calibration round (silence — every device clicks at
// once and music mode has no echo cancellation), the finished mix playing on
// every client at once (ducked — each room mic picks the mix up off its own
// speakers and sends it back, which reads as "artefacts in the headphones").
//
// These used to be done by calling `participant.setVolume` directly, which the
// volume hook then overwrote the moment a track (re)subscribed. As holds on the
// bus, the effective remote volume is always `volume × min(holds)`, recomputed
// by whoever applies it, so nothing can undo a hold by accident and the bus
// still never learns which feature asked.
const holds = new Map<symbol, number>();

/** Multiplier for remote (LiveKit) audio right now: 1 with no holds. */
export function remoteAudioFactor(): number {
  let f = 1;
  holds.forEach((v) => { f = Math.min(f, v); });
  return f;
}

/** Hold the room's audio at `factor` (0 = silent) until the returned release is
 *  called. Idempotent release. */
export function holdRemoteAudio(factor: number): () => void {
  const key = Symbol("hold");
  holds.set(key, Math.max(0, Math.min(1, factor)));
  notify();
  return () => {
    if (!holds.delete(key)) return;
    notify();
  };
}
