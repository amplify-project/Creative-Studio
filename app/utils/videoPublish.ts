/**
 * One place that decides how a camera is captured and encoded.
 *
 * Before this, every publish site picked its own settings: the room
 * constructors said VP8 + 720/360/180 layers, MediaControls and JoinSetup
 * passed only a resolution (so the camera ran at whatever fps it liked), and
 * the phone "extra camera" page (/publish) used `new Room()` with nothing at
 * all — 640×480 with LiveKit's default ceiling of 500 kbps / 20 fps.
 *
 * Field test 2026-10 (Lab artistic performance): phones panning over
 * foliage dropped to 5–8 fps for seconds at a time while the picture stayed
 * sharp. The encoder was out of bits and kept quality by dropping frames.
 * For a performance the opposite trade is wanted: fewer pixels, more frames.
 * So the defaults here are: a bitrate sized to the capture, an explicit fps,
 * `maintain-framerate`, a "motion" content hint, fewer simulcast layers on
 * phones, and H.264 (hardware encoder) on iPhone/iPad where VP8 is software.
 */
import {
  VideoPreset,
  type LocalVideoTrack,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  type VideoCodec,
} from "livekit-client";

export type VideoCodecChoice = "auto" | "vp8" | "h264";
export type DegradationPref = "balanced" | "maintain-resolution" | "maintain-framerate";

export type VideoPrefs = {
  width: number;
  height: number;
  frameRate: number;
  codec: VideoCodecChoice;
  simulcast: boolean;
  degradationPreference: DegradationPref;
  /** Ceiling for the top layer in kbps; 0 = auto (sized to the capture). */
  maxBitrateKbps: number;
};

/** Choices offered in the settings UIs. 0 = auto. */
export const BITRATE_CHOICES_KBPS = [0, 1000, 1500, 2000, 3000, 4000, 6000] as const;

/** What we know about the device. Injectable so the rules are testable. */
export type DeviceEnv = { ua: string; platform: string; maxTouchPoints: number };

export function currentEnv(): DeviceEnv {
  if (typeof navigator === "undefined") return { ua: "", platform: "", maxTouchPoints: 0 };
  return {
    ua: navigator.userAgent ?? "",
    platform: (navigator as any).platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/** iPhone / iPad, including iPadOS which reports itself as a Mac. */
export function isAppleMobile(env: DeviceEnv = currentEnv()): boolean {
  if (/iPhone|iPad|iPod/i.test(env.ua)) return true;
  return /Macintosh|MacIntel/i.test(env.ua + env.platform) && env.maxTouchPoints > 1;
}

export function isMobileDevice(env: DeviceEnv = currentEnv()): boolean {
  return isAppleMobile(env) || /Android|Mobi/i.test(env.ua);
}

/** auto → H.264 on iPhone/iPad (hardware encoder), VP8 elsewhere. Some
 *  Android H.264 encoders mishandle simulcast, so Android stays on VP8
 *  unless someone picks H.264 by hand for a device they have tested. */
export function resolveCodec(choice: VideoCodecChoice, env: DeviceEnv = currentEnv()): VideoCodec {
  if (choice === "vp8" || choice === "h264") return choice;
  return isAppleMobile(env) ? "h264" : "vp8";
}

export function defaultVideoPrefs(env: DeviceEnv = currentEnv()): VideoPrefs {
  const mobile = isMobileDevice(env);
  return {
    width: mobile ? 960 : 1280,
    height: mobile ? 540 : 720,
    frameRate: 24,
    codec: "auto",
    simulcast: true,
    degradationPreference: "maintain-framerate",
    maxBitrateKbps: 0,
  };
}

/** Defaults for the phone "extra camera" page. Stays 4:3 like before, so the
 *  stage tiles keep their shape — just with real bits behind it. */
export function extraCameraPrefs(): VideoPrefs {
  return {
    width: 960,
    height: 720,
    frameRate: 24,
    codec: "auto",
    simulcast: true,
    degradationPreference: "maintain-framerate",
    maxBitrateKbps: 0,
  };
}

// Bits per pixel per frame for the top layer. LiveKit's presets sit near
// 0.05–0.08 (tuned for talking heads); the 640×480 default the /publish page
// fell into is 0.08 at 20 fps — which is where the 5–8 fps came from. 0.1 was
// the first try; a phone test on good wifi (2026-10-23) still looked like it
// was short of bits when moving (codec made no difference, so not CPU), so
// 0.15. maxBitrate is a ceiling, not a target: on a weak uplink the
// bandwidth estimator still holds it lower.
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE = 100_000;
const MAX_BITRATE = 4_000_000;

export function topLayerBitrate(width: number, height: number, fps: number): number {
  const raw = width * height * fps * BITS_PER_PIXEL;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw)) / 10_000) * 10_000;
}

/** Lower simulcast layers. Phones send one extra layer (~1/3 size) instead
 *  of two: every layer is another encode on a CPU that is already the
 *  bottleneck when the picture is moving. */
export function simulcastLayers(prefs: VideoPrefs, mobile: boolean): VideoPreset[] {
  const divisors = mobile ? [3] : [2, 4];
  return divisors
    .map((d) => {
      const w = Math.round(prefs.width / d / 2) * 2;
      const h = Math.round(prefs.height / d / 2) * 2;
      const fps = Math.min(prefs.frameRate, 20);
      return new VideoPreset(w, h, topLayerBitrate(w, h, fps), fps);
    })
    .filter((p) => p.height >= 120);
}

export function videoCaptureOptions(
  prefs: VideoPrefs,
  extra: { deviceId?: string; facingMode?: VideoCaptureOptions["facingMode"] } = {},
): VideoCaptureOptions {
  return {
    resolution: { width: prefs.width, height: prefs.height, frameRate: prefs.frameRate },
    ...(extra.deviceId ? { deviceId: extra.deviceId } : {}),
    ...(extra.facingMode && !extra.deviceId ? { facingMode: extra.facingMode } : {}),
  };
}

export function videoPublishOptions(
  prefs: VideoPrefs,
  name?: string,
  env: DeviceEnv = currentEnv(),
): TrackPublishOptions {
  const mobile = isMobileDevice(env);
  return {
    ...(name ? { name } : {}),
    videoCodec: resolveCodec(prefs.codec, env),
    simulcast: prefs.simulcast,
    videoEncoding: {
      maxBitrate: prefs.maxBitrateKbps > 0
        ? prefs.maxBitrateKbps * 1000
        : topLayerBitrate(prefs.width, prefs.height, prefs.frameRate),
      maxFramerate: prefs.frameRate,
    },
    videoSimulcastLayers: simulcastLayers(prefs, mobile),
    degradationPreference: prefs.degradationPreference,
  };
}

/** Room-level defaults, for the paths that go through setCameraEnabled()
 *  (the hosts' and participants' quality auto-pause/restore). */
export function roomVideoDefaults(env: DeviceEnv = currentEnv()): {
  publishDefaults: TrackPublishOptions;
  videoCaptureDefaults: VideoCaptureOptions;
} {
  const prefs = loadVideoPrefs(env);
  return {
    publishDefaults: videoPublishOptions(prefs, undefined, env),
    videoCaptureDefaults: videoCaptureOptions(prefs),
  };
}

/** Tell the browser this is moving content: it then prefers keeping the
 *  frame rate over keeping detail when it has to give something up.
 *  Best-effort — the property is missing on older Safari. */
export function applyMotionHint(track: LocalVideoTrack): void {
  try {
    const mst = track.mediaStreamTrack as MediaStreamTrack & { contentHint?: string };
    if (mst && "contentHint" in mst) mst.contentHint = "motion";
  } catch { /* best-effort */ }
}

// ── Persistence (per device, per browser) ─────────────────────────────────
const STORAGE_KEY = "cs.videoPrefs.v1";
const EXTRA_STORAGE_KEY = "cs.extraCameraPrefs.v1";

function sanitize(raw: any, base: VideoPrefs): VideoPrefs {
  if (!raw || typeof raw !== "object") return base;
  const num = (v: any, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d;
  return {
    width: num(raw.width, 160, 3840, base.width),
    height: num(raw.height, 120, 2160, base.height),
    frameRate: num(raw.frameRate, 5, 60, base.frameRate),
    maxBitrateKbps: num(raw.maxBitrateKbps, 0, 20_000, base.maxBitrateKbps),
    codec: ["auto", "vp8", "h264"].includes(raw.codec) ? raw.codec : base.codec,
    simulcast: typeof raw.simulcast === "boolean" ? raw.simulcast : base.simulcast,
    degradationPreference: ["balanced", "maintain-resolution", "maintain-framerate"]
      .includes(raw.degradationPreference) ? raw.degradationPreference : base.degradationPreference,
  };
}

function load(key: string, base: VideoPrefs): VideoPrefs {
  try {
    const s = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    return s ? sanitize(JSON.parse(s), base) : base;
  } catch {
    return base;
  }
}

function save(key: string, prefs: VideoPrefs): void {
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* private mode etc. */ }
}

export const loadVideoPrefs = (env: DeviceEnv = currentEnv()) => load(STORAGE_KEY, defaultVideoPrefs(env));
export const saveVideoPrefs = (p: VideoPrefs) => save(STORAGE_KEY, p);
export const loadExtraCameraPrefs = () => load(EXTRA_STORAGE_KEY, extraCameraPrefs());
export const saveExtraCameraPrefs = (p: VideoPrefs) => save(EXTRA_STORAGE_KEY, p);
export { sanitize as sanitizeVideoPrefs };
