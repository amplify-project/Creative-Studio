"use client";

import { useEffect, useRef, useState } from "react";
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  Track,
  RoomEvent,
} from "livekit-client";
import VideoSettingsPanel, {
  VideoCaptureState,
  VideoPublishState,
} from "./videoSelector";
import AudioSettingsPanel, {
  AudioCaptureState,
  AudioPublishState,
  AudioMode,
  AUDIO_MODE_PRESETS,
} from "./audioSelector";
import {
  Bug, Mic, MicOff, Video, VideoOff,
  MonitorUp, MonitorX, MessageSquare, Camera, Smile,
} from "lucide-react";
import BugReportDialog from "./ui/BugReportDialog";
import { runPublishOp } from "../app/utils/publishQueue";
import { readStoredInputDevice, writeStoredInputDevice } from "../app/hooks/useOutputVolume";
import { useControlPanelOrNull } from "./ui/ControlPanelContext";
import { useExtraSources } from "../app/hooks/useExtraSources";
import { usePublishUrl } from "../app/hooks/usePublishUrl";
import { useReactionsOrNull } from "./ui/ReactionsContext";
import { QRCodeSVG } from "qrcode.react";
import MediaPublishErrorModal from "./ui/MediaPublishErrorModal";
import { registerRoomDebug } from "../app/utils/muteDebug";
import {
  captureFor,
  captureModeOf,
  liveMicPub,
  markMonoInput,
  micSnapshot,
  requestedChannelsOf,
  watchForDeadChannel,
} from "../app/utils/micCapture";
import { makeConnLogger } from "../app/lib/connLog";
import { MicLevelMonitor } from "../app/utils/micLevelMonitor";
import { useSuggestionsOrNull } from "../app/hooks/useAssistantSuggestions";

// Mode-switch level check (see the effect near reconcileAudioMode). First
// guesses, to be tuned against the `mic_level_after_mode` beacons:
/** Active level (p75 RMS) below this in music = quiet, whatever came before. */
const QUIET_DB = -36;
/** ...or it dropped at least this much from speech AND landed below DROP_FLOOR_DB. */
const DROP_DB = 10;
const DROP_FLOOR_DB = -28;
/** Seconds of sound in the new mode before judging. */
const LEVEL_CHECK_ACTIVE_S = 8;

interface MediaControlsProps {
  room: any;
  autoPublish?: boolean;
  audioMode?: AudioMode;
  /** Role stamped on the `mic_capture` telemetry beacons. */
  telemetryRole?: "host" | "participant";
  /**
   * `"floating"` — the original overlay pinned over the video, dimmed until
   * hovered. Still what /host uses, where the page is a row (sidebar + stage)
   * and there is nowhere to put a strip without restructuring it.
   *
   * `"bar"` — an in-flow strip the parent lays out, so it never covers the
   * stage and nothing has to dodge it. /participant uses this.
   */
  variant?: "floating" | "bar";
}

export default function MediaControls({
  room,
  autoPublish = false,
  audioMode,
  telemetryRole,
  variant = "floating",
}: MediaControlsProps) {
  const isBar = variant === "bar";
  const panel = useControlPanelOrNull();
  const extra = useExtraSources();
  // Anchored popover for "add a camera": the two routes are publishing from
  // this device and scanning the QR, and which are available differs per
  // device, so a menu beats two more buttons in the strip.
  const [showCameraMenu, setShowCameraMenu] = useState(false);
  const reactions = useReactionsOrNull();
  const [showReactions, setShowReactions] = useState(false);
  const mobileUrl = usePublishUrl();
  const [secondCamDevice, setSecondCamDevice] = useState("");
  const initialPreset = AUDIO_MODE_PRESETS[audioMode ?? "speech"];
  // The room's mode, readable from inside async ops and timers. `toggleAudio`
  // used to build its capture from the `media` of the render that created it:
  // the host's autoPublish runs a 1.5 s-old closure, from before shared state
  // arrived, so a refreshed host in a music room published in speech.
  const audioModeRef = useRef<AudioMode | undefined>(audioMode);
  audioModeRef.current = audioMode;
  const [media, setMedia] = useState({
    audio: {
      published: false,
      capture: {
        // The mic picked on the pre-join screen (JoinSetup persists it). This
        // used to be a hardcoded "default", so every re-capture below — a
        // music/speech switch, an unmute — silently moved the user back to
        // the OS default mic (field report 2026-09-28).
        ...captureFor(audioMode ?? "speech", readStoredInputDevice() || "default"),
      } as AudioCaptureState,
      publish: initialPreset.publish as AudioPublishState,
    },
    video: {
      published: false,
      capture: {
        width: 1280,
        height: 720,
        frameRate: 15,
        facingMode: "user",
        deviceId: undefined,
      } as VideoCaptureState,
      publish: {
        simulcast: true,
        priority: 1,
        degradationPreference: "maintain-framerate",
      } as VideoPublishState,
    },
    ui: {
      showAudioSettings: false,
      showVideoSettings: false,
      showBugReport: false,
    },
  });

  const autoPublishedRef = useRef(false);

  // 🔒 Serialize every audio publish/unpublish op. On iPad Safari the field
  // reports showed a duplicate mic track: `createLocalAudioTrack` +
  // `publishTrack` are async and slow, and an in-flight track isn't yet in
  // `trackPublications`, so the `isActuallyPublished` guard reads false and a
  // SECOND publish path (autoPublish, audioMode re-publish, manual toggle,
  // retry modal) sneaks in. The SFU then forwards the silent duplicate →
  // "participants can't hear me". Chaining ops through one promise closes the
  // window: each op runs only after the previous fully resolves, so the second
  // re-reads room state and sees the track the first one published.
  const audioOpChain = useRef<Promise<unknown>>(Promise.resolve());
  const runAudioOp = <T,>(fn: () => Promise<T>): Promise<T> => {
    // Run fn whether the previous op resolved or rejected, so one failure
    // doesn't wedge the chain forever.
    const result = audioOpChain.current.then(fn, fn);
    audioOpChain.current = result.then(() => undefined, () => undefined);
    return result;
  };

  // 🧹 Belt-and-suspenders: if more than one mic track is ever live (a publish
  // that raced before the lock, JoinSetup + autoPublish, a reconnect…), keep
  // the most recent and unpublish the rest. The `trackPublications` Map keeps
  // insertion (= publish) order, so the last entry is the newest track.
  /**
   * The mic to re-capture from. The room is the source of truth, same as for
   * everything else in these ops: if a mic is live on a SPECIFIC device, reuse
   * it — that is the one the user is actually on, however they got there
   * (pre-join screen, settings panel, recovery modal).
   *
   * A live "default" is not a choice, though. It is what a capture gets when
   * nothing was picked yet (the host's autoPublish runs before any panel) or
   * what LiveKit falls back to when a published mic ends. Reusing it made every
   * later music/speech switch inherit "default" and ignore the mic the user
   * picked afterwards (field report 2026-10-02). So a live "default" yields to
   * a remembered explicit pick.
   */
  const resolveMicDeviceId = (fallback?: string): string => {
    const stored = readStoredInputDevice();
    if (room) {
      const live = (Array.from(room.localParticipant.trackPublications.values()) as any[])
        .find((p) => p.track?.kind === Track.Kind.Audio);
      const id = live?.track?.mediaStreamTrack?.getSettings?.().deviceId;
      if (id && id !== "default") return id;
      if (id === "default" && !stored) return id;
    }
    if (fallback && fallback !== "default") return fallback;
    return stored || "default";
  };

  /**
   * Unpublish every local mic and WAIT for it. The old track must be off the
   * room before the replacement capture opens: opening the same device with
   * different processing can end the old track, and LiveKit answers an
   * `ended` on a still-published mic by restarting it on deviceId "default"
   * ("track ended, attempting to use a different device"). Not awaiting this
   * left exactly that window open on every mode switch.
   */
  const unpublishAllMics = async () => {
    const mics = (Array.from(room.localParticipant.trackPublications.values()) as any[])
      .filter((p) => p.track?.kind === Track.Kind.Audio);
    await Promise.all(
      mics.map((p) => Promise.resolve(room.localParticipant.unpublishTrack(p.track)).catch(() => {})),
    );
  };

  const dedupeAudioTracks = () => {
    if (!room) return;
    const audioPubs = (Array.from(room.localParticipant.trackPublications.values()) as any[])
      .filter((p) => p.track?.kind === Track.Kind.Audio);
    if (audioPubs.length <= 1) return;
    audioPubs.slice(0, -1).forEach((p) => {
      console.warn("[MediaControls] dropping duplicate mic track", p.trackSid);
      room.localParticipant.unpublishTrack(p.track);
    });
  };

  // Publish-error recovery modal. Populated when toggleAudio / toggleVideo
  // catch a getUserMedia / publishTrack failure — we used to leave the UI
  // saying "mic muted" with no underlying track, which led to bug reports
  // like "I'm trying to unmute and nothing works". Now the modal surfaces
  // the error AND offers a device picker so the user can bypass virtual
  // drivers (Microsoft Teams Audio, BlackHole…) without leaving the page.
  const [publishError, setPublishError] = useState<{
    kind: "audio" | "video";
    message: string;
  } | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);

  // Refresh the device list every time the modal opens — labels are only
  // populated after the user grants a permission, so a freshly-blocked
  // device might appear with an empty label until the next enumerate.
  const refreshInputs = async (kind: "audio" | "video") => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (kind === "audio") setAudioInputs(all.filter((d) => d.kind === "audioinput"));
      else setVideoInputs(all.filter((d) => d.kind === "videoinput"));
    } catch { /* ignore enumerate failures — modal will show empty list */ }
  };

  // Register room with debug helpers so __lkAudio() and __muteState() are
  // available in the browser console from both participant and host views.
  useEffect(() => { if (room) registerRoomDebug(room); }, [room]);
  const mediaRef = useRef(media);
  mediaRef.current = media;

  // ── mic_capture telemetry: requested vs effective, once per new mic track ──
  const connLogRef = useRef<ReturnType<typeof makeConnLogger> | null>(null);
  const logMicEvent = (event: string, extra: Record<string, unknown>) => {
    const identity = room?.localParticipant?.identity;
    if (!identity) return;
    if (!connLogRef.current) connLogRef.current = makeConnLogger(telemetryRole ?? "participant", identity);
    connLogRef.current(event, extra);
  };
  /** Why the next mic publish happens, stamped on its telemetry beacon. */
  const pendingWhyRef = useRef<string | null>(null);
  /** Track published from the settings panel: its capture is the user's own
   *  choice, so only an explicit room mode change re-captures it. */
  const manualMicSidRef = useRef<string | null>(null);

  // Level of the live mic, and a pending before/after comparison across a
  // mode switch. `armed` flips when the NEW track is attached — until then the
  // monitor is still reading the old one.
  const monitorRef = useRef<MicLevelMonitor | null>(null);
  const levelCheckRef = useRef<{
    from: AudioMode; to: AudioMode; beforeDb: number | null; startedAt: number; armed: boolean;
  } | null>(null);
  const suggestions = useSuggestionsOrNull();
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  /** --------------------------------------------------------------
   * 🔁 Sync published state with actual room tracks
   * Handles: participant joins after JoinSetup, host autoPublish, etc.
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (!room) return;

    const syncState = () => {
      const pubs = Array.from(room.localParticipant.trackPublications.values()) as any[];
      const mic = liveMicPub(room);
      // Camera only. A screen share or a second camera is a video track too,
      // and counting them here made the camera button light up for a camera
      // that was off.
      const hasVideo = pubs.some(
        (p) => p.track?.kind === Track.Kind.Video && p.source === Track.Source.Camera,
      );
      setMedia((m) => ({
        ...m,
        audio: { ...m.audio, published: !!mic?.track },
        video: { ...m.video, published: hasVideo },
      }));
    };

    // Sync on mount (covers JoinSetup case where tracks are already published)
    syncState();

    room.on(RoomEvent.LocalTrackPublished, syncState);
    room.on(RoomEvent.LocalTrackUnpublished, syncState);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, syncState);
      room.off(RoomEvent.LocalTrackUnpublished, syncState);
    };
  }, [room]);

  /**
   * Replace the live mic with a fresh capture. Must run inside runAudioOp; the caller resolves the device BEFORE this unpublishes — there
   * is no live track to read it from afterwards.
   */
  const recaptureMic = async (capture: AudioCaptureState, publish: AudioPublishState, why: string) => {
    await unpublishAllMics();
    try {
      const track = await createLocalAudioTrack({ ...capture });
      pendingWhyRef.current = why;
      await room.localParticipant.publishTrack(track, { ...publish });
      dedupeAudioTracks();
    } catch (e: any) {
      // The old mic is already gone: say so and offer the device picker,
      // instead of leaving the person silently without a mic.
      pendingWhyRef.current = null;
      console.warn(`[MediaControls] mic re-capture (${why}) failed:`, e);
      setMedia((m) => ({ ...m, audio: { ...m.audio, published: false } }));
      await refreshInputs("audio");
      setPublishError({ kind: "audio", message: e?.message ?? String(e) });
    }
  };

  /** --------------------------------------------------------------
   * 🔄 Keep the live mic in the room's mode
   *
   * Compares the room's mode with the mode the LIVE track was captured in
   * (its requested constraints), not the previous prop with the new one. The
   * old prev-vs-next check missed every mic published before the mode was
   * known: a refreshed host (autoPublish ran a stale speech closure), a
   * participant whose JoinSetup ran before shared state arrived. Those stayed
   * in speech in a music room until someone toggled the mode twice.
   *
   * `force` = an explicit room mode change, which also overrides a capture the
   * user set up by hand in the settings panel.
   * -------------------------------------------------------------- */
  const reconcileTriesRef = useRef<{ mode?: AudioMode; n: number }>({ n: 0 });
  const reconcileAudioMode = (why: string, force = false) =>
    runAudioOp(async () => {
      const want = audioModeRef.current;
      if (!want || !room) return;
      const pub = liveMicPub(room);
      if (!pub?.track) return;
      if (!force && pub.trackSid && pub.trackSid === manualMicSidRef.current) return;
      const have = captureModeOf(pub.track);
      if (have === null || have === want) return;
      // Never loop: at most two re-captures per target mode.
      if (reconcileTriesRef.current.mode !== want) reconcileTriesRef.current = { mode: want, n: 0 };
      if (reconcileTriesRef.current.n >= 2) {
        console.warn(`[AudioMode] mic still in "${have}" after 2 re-captures; leaving it`);
        return;
      }
      reconcileTriesRef.current.n++;
      levelCheckRef.current = {
        from: have, to: want, beforeDb: monitorRef.current?.level() ?? null,
        startedAt: Date.now(), armed: false,
      };
      const deviceId = resolveMicDeviceId(mediaRef.current.audio.capture.deviceId);
      const capture = captureFor(want, deviceId);
      const publish = AUDIO_MODE_PRESETS[want].publish;
      setMedia((m) => ({ ...m, audio: { ...m.audio, capture, publish } }));
      console.log(`[AudioMode] mic "${have}" → "${want}" (${why})`);
      await recaptureMic(capture, publish, `mode:${why}`);
    });

  /** --------------------------------------------------------------
   * 🎚️ Stereo music capture with a dead side → mono
   * -------------------------------------------------------------- */
  const stopChannelWatchRef = useRef<() => void>(() => {});
  const watchMicChannels = () => {
    stopChannelWatchRef.current();
    stopChannelWatchRef.current = () => {};
    const pub = liveMicPub(room);
    const track = pub?.track;
    if (!track?.mediaStreamTrack) return;
    if (captureModeOf(track) !== "music" || requestedChannelsOf(track) < 2) return;
    const sid = pub.trackSid;
    stopChannelWatchRef.current = watchForDeadChannel(track.mediaStreamTrack, () => {
      void runAudioOp(async () => {
        const live = liveMicPub(room);
        if (!live?.track || live.trackSid !== sid) return; // replaced meanwhile
        const deviceId = resolveMicDeviceId(mediaRef.current.audio.capture.deviceId);
        markMonoInput(deviceId);
        const capture = { ...mediaRef.current.audio.capture, channelCount: 1, deviceId };
        setMedia((m) => ({ ...m, audio: { ...m.audio, capture } }));
        console.warn("[MediaControls] one stereo channel is silent → re-capturing mono");
        if (sid === manualMicSidRef.current) manualMicSidRef.current = null;
        await recaptureMic(capture, mediaRef.current.audio.publish, "dead-channel");
      });
    });
  };

  // Every new mic track, however it was published (JoinSetup, autoPublish,
  // settings panel, a re-capture): log what was asked vs applied, start the
  // channel watch, and bring it into the room's mode.
  useEffect(() => {
    if (!room) return;
    let lastSid: string | null = null;
    const onPublished = () => {
      const pub = liveMicPub(room);
      if (!pub?.track || pub.trackSid === lastSid) return;
      lastSid = pub.trackSid;
      logMicEvent("mic_capture", {
        why: pendingWhyRef.current ?? "publish",
        roomMode: audioModeRef.current ?? null,
        ...micSnapshot(pub.track),
      });
      pendingWhyRef.current = null;
      if (!monitorRef.current) monitorRef.current = new MicLevelMonitor();
      monitorRef.current.attach(pub.track.mediaStreamTrack);
      if (levelCheckRef.current) levelCheckRef.current.armed = true;
      watchMicChannels();
      void reconcileAudioMode("publish");
    };
    onPublished();
    room.on(RoomEvent.LocalTrackPublished, onPublished);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, onPublished);
      stopChannelWatchRef.current();
      monitorRef.current?.dispose();
      monitorRef.current = null;
    };
  }, [room]);

  /** --------------------------------------------------------------
   * 🔉 Did the switch leave this person quiet?
   *
   * Music turns automatic gain off, so a mic AGC was lifting in speech arrives
   * at its own level — the "it got quieter when we changed mode" report. Only
   * the user's input gain fixes that, so this measures and, when the result is
   * quiet in music, offers the existing calibration panel (`audio.calibrateMic`,
   * low_level) through the suggestion bus — the same skill and dedup key the
   * server's analyser uses, so dismissing one quiets both. Both directions are
   * logged as `mic_level_after_mode`.
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (!room) return;
    const iv = setInterval(() => {
      const chk = levelCheckRef.current;
      const mon = monitorRef.current;
      if (!chk?.armed || !mon) return;
      const timedOut = Date.now() - chk.startedAt > 120_000;
      if (mon.activeSeconds() < LEVEL_CHECK_ACTIVE_S && !timedOut) return;
      levelCheckRef.current = null;
      const afterDb = mon.level();
      const dropDb = chk.beforeDb != null && afterDb != null
        ? Math.round((chk.beforeDb - afterDb) * 10) / 10
        : null;
      const quiet = afterDb != null && (
        afterDb < QUIET_DB || (dropDb != null && dropDb >= DROP_DB && afterDb < DROP_FLOOR_DB)
      );
      logMicEvent("mic_level_after_mode", {
        from: chk.from, to: chk.to, beforeDb: chk.beforeDb, afterDb, dropDb, quiet,
        activeS: mon.activeSeconds(),
      });
      if (!quiet || chk.to !== "music") return;
      const identity = room.localParticipant?.identity;
      if (!identity) return;
      suggestionsRef.current?.offer({
        source: "mic-level",
        title: "Your mic got quieter in music mode",
        description:
          (dropDb != null && dropDb > 0
            ? `About ${Math.round(dropDb)} dB lower than a moment ago. `
            : "") +
          "Music mode turns off automatic gain, so the room now hears your mic's own level. " +
          "Raise your input gain, or move closer to the mic.",
        severity: "alert",
        ttlMs: 30_000,
        dedupKey: `audio-cal:low_level:${identity}`,
        invoke: { skill: "audio.calibrateMic", args: { participantId: identity, issue: "low_level" } },
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [room]);

  /** --------------------------------------------------------------
   * 📌 Auto-Publish on mount
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (autoPublish && !autoPublishedRef.current) {
      autoPublishedRef.current = true;
      setTimeout(() => {
        toggleAudio();
        toggleVideo();
      }, 1500);
    }
  }, [autoPublish]);

  /** --------------------------------------------------------------
   * 🔄 React to room audioMode changes (music / speech)
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (!audioMode || !room) return;
    setMedia((m) => ({
      ...m,
      audio: {
        ...m.audio,
        capture: captureFor(audioMode, m.audio.capture.deviceId, m.audio.capture),
        publish: AUDIO_MODE_PRESETS[audioMode].publish,
      },
    }));
    void reconcileAudioMode("mode-change", true);
  }, [audioMode, room]);

  /** --------------------------------------------------------------
   * 🎤 Toggle AUDIO
   *
   * With a mic live this mutes by unpublishing it (see doc 08 for why muting
   * in place was considered and not done). With no mic live it captures and
   * publishes — `settings` from the settings panel, otherwise the ROOM's mode
   * read through the ref (not `media`, which is stale in the autoPublish
   * timer: that is how a refreshed host ended up in speech).
   * -------------------------------------------------------------- */
  const toggleAudio = async (settings?: { capture: AudioCaptureState; publish: AudioPublishState }) => {
    if (!room) return;

    if (settings) {
      setMedia((m) => ({ ...m, audio: { ...m.audio, ...settings } }));
    }

    // Serialized through runAudioOp so concurrent paths (autoPublish, audioMode
    // re-capture, rapid double-clicks) can't double-publish the mic. Inside the
    // lock the room is the source of truth.
    await runAudioOp(async () => {
      const mic = liveMicPub(room);

      if (mic?.track && !settings) {
        (Array.from(room.localParticipant.trackPublications.values()) as any[])
          .filter((p) => p.track?.kind === Track.Kind.Audio)
          .forEach((p) => room.localParticipant.unpublishTrack(p.track));
        setMedia((m) => ({ ...m, audio: { ...m.audio, published: false } }));
        return;
      }

      try {
        const want: AudioMode = audioModeRef.current ?? "speech";
        // An explicit pick from the settings panel wins and is remembered;
        // otherwise the mic the user chose, not the OS default.
        const deviceId = settings
          ? settings.capture.deviceId
          : resolveMicDeviceId(mediaRef.current.audio.capture.deviceId);
        if (settings && deviceId) writeStoredInputDevice(deviceId === "default" ? "" : deviceId);
        const capture = settings ? { ...settings.capture, deviceId } : captureFor(want, deviceId);
        const publish = settings ? settings.publish : AUDIO_MODE_PRESETS[want].publish;

        if (mic?.track) {
          // Settings saved while a mic is live: apply them to a fresh capture.
          await recaptureMic(capture, publish, "settings");
        } else {
          const track = await createLocalAudioTrack({ ...capture });
          pendingWhyRef.current = settings ? "settings" : "unmute";
          await room.localParticipant.publishTrack(track, { ...publish });
          dedupeAudioTracks();
        }
        if (settings) manualMicSidRef.current = liveMicPub(room)?.trackSid ?? null;
        setMedia((m) => ({
          ...m,
          audio: { ...m.audio, capture, publish, published: true },
          ui: { ...m.ui, showAudioSettings: false },
        }));
      } catch (e: any) {
        // Surface the failure instead of leaving the UI claiming the mic
        // is muted. Classic case: macOS Safari with Teams running →
        // "No CoreAudioCaptureSource device". Refresh device list now
        // (labels appear after permission grant) and open the modal so
        // the user can pick a non-default device and retry.
        console.warn("[MediaControls] audio publish failed:", e);
        await refreshInputs("audio");
        setPublishError({
          kind: "audio",
          message: e?.message ?? String(e),
        });
      }
    });
  };

  /** Re-attempt audio publish with an explicit deviceId. Used by the
   *  recovery modal. Throws on failure so the modal can show the inline
   *  "still failing" state and stay open. */
  const retryAudioWithDevice = async (deviceId: string) => {
    if (!room) throw new Error("Room not available");
    const want: AudioMode = audioModeRef.current ?? "speech";
    const captureOverride = captureFor(want, deviceId);
    const publish = AUDIO_MODE_PRESETS[want].publish;
    // Serialized + drop any existing mic first so a retry REPLACES the track
    // rather than stacking a second one. runAudioOp propagates the rejection,
    // so the modal still sees the throw and stays open on failure.
    await runAudioOp(async () => {
      await unpublishAllMics();
      const track = await createLocalAudioTrack({ ...captureOverride });
      writeStoredInputDevice(deviceId);
      pendingWhyRef.current = "retry";
      await room.localParticipant.publishTrack(track, { ...publish });
      dedupeAudioTracks();
    });
    setMedia((m) => ({
      ...m,
      audio: { ...m.audio, capture: captureOverride, publish, published: true },
    }));
  };

  /** --------------------------------------------------------------
   * 🎥 Toggle VIDEO
   * -------------------------------------------------------------- */
  const toggleVideo = async () => {
    if (!room) return;

    // Serialized on the shared video lane, and scoped to `Source.Camera`.
    // This used to match on `kind === Video`, which meant *any* video track:
    // with a screen share or a second camera live, the button reported the
    // camera as on when it wasn't, and turning it off unpublished those
    // tracks too. Read the room, not React state — same rule as audio.
    await runPublishOp(room, "video", async () => {
      const pubs = Array.from(room.localParticipant.trackPublications.values()) as any[];
      const cameraPub = pubs.find(
        (p) => p.track?.kind === Track.Kind.Video && p.source === Track.Source.Camera,
      );

      if (!cameraPub) {
        try {
          const track = await createLocalVideoTrack({
            resolution: { width: media.video.capture.width, height: media.video.capture.height },
          });
          await room.localParticipant.publishTrack(track, { name: "primary" });
          setMedia((m) => ({
            ...m,
            video: { ...m.video, published: true },
            ui: { ...m.ui, showVideoSettings: false },
          }));
        } catch (e: any) {
          // Same pattern as audio: surface the failure instead of leaving
          // the UI saying "camera on" with no track. Common cause on Mac:
          // FaceTime / Photo Booth / OBS holding the FaceTime HD Camera.
          console.warn("[MediaControls] video publish failed:", e);
          await refreshInputs("video");
          setPublishError({
            kind: "video",
            message: e?.message ?? String(e),
          });
        }
      } else {
        await room.localParticipant.unpublishTrack(cameraPub.track);
        setMedia((m) => ({ ...m, video: { ...m.video, published: false } }));
      }
    });
  };

  /** Re-attempt video publish with an explicit deviceId. Same shape as
   *  retryAudioWithDevice — throws on failure to keep the modal open. */
  const retryVideoWithDevice = async (deviceId: string) => {
    if (!room) throw new Error("Room not available");
    const track = await createLocalVideoTrack({
      resolution: { width: media.video.capture.width, height: media.video.capture.height },
      deviceId,
    });
    await room.localParticipant.publishTrack(track, { name: "primary" });
    setMedia((m) => ({
      ...m,
      video: { ...m.video, capture: { ...m.video.capture, deviceId }, published: true },
    }));
  };

  return (
    <>
      {/* ── Control strip ───────────────────────────────────────────
          `bar`: an in-flow strip the parent sizes and places. Nothing
          overlaps the stage, so nothing has to dodge it — which is why the
          pin carousel and the lyrics banner went back to plain `bottom-4`.

          `floating`: the original overlay, still used by /host. It sits over
          the video, so it dims until hovered via `.hover-dim` — a CSS rule
          gated on `(hover: hover)`, because a touch device never fires
          `mouseenter` and an unconditional 50% opacity is a control you
          cannot get back.
      ────────────────────────────────────────────────────────────── */}
      <div
        className={
          isBar
            ? "relative z-30 flex w-full shrink-0 items-center justify-center gap-2 sm:gap-3 " +
              "border-t border-white/10 bg-zinc-950 px-3 pt-2 sm:pt-3"
            : "hover-dim fixed z-[99999] left-1/2 -translate-x-1/2 top-4 " +
              "flex flex-row items-center gap-2 sm:gap-3 px-3 py-2 sm:px-4 sm:py-3 " +
              "bg-black/50 backdrop-blur-md rounded-2xl shadow-xl border border-white/10"
        }
        // Composed rather than the `.pb-safe` utility: that rule is unlayered
        // CSS, so it outranks Tailwind's layered `pb-*` and would replace the
        // strip's padding with the inset instead of adding to it — zero on
        // every device without a home indicator.
        style={isBar
          ? { paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }
          : undefined}
      >
        {/* ── Botón VIDEO ── */}
        <button
          onClick={
            media.video.published
              ? toggleVideo
              : () => setMedia((m) => ({ ...m, ui: { ...m.ui, showVideoSettings: true } }))
          }
          title={media.video.published ? "Stop video" : "Start video"}
          className={[
            "flex items-center justify-center rounded-full transition-colors",
            // Tamaño: más pequeño en móvil, normal en md+
            "w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12",
            media.video.published
              ? "bg-blue-600 hover:bg-blue-500 text-white"
              : "bg-gray-700 hover:bg-gray-600 text-gray-300",
          ].join(" ")}
        >
          {media.video.published
            ? <Video className="w-4 h-4 sm:w-5 sm:h-5" />
            : <VideoOff className="w-4 h-4 sm:w-5 sm:h-5" />}
        </button>

        {/* ── Etiqueta vídeo (solo sm+) ── */}
        <span className="hidden sm:block text-xs text-gray-400 select-none -ml-1 mr-1">
          {media.video.published ? "Camera" : "No camera"}
        </span>

        {/* ── Divisor vertical ── */}
        <div className="w-px h-6 bg-white/20 mx-1 hidden sm:block" />

        {/* ── Botón AUDIO ── */}
        <button
          onClick={
            media.audio.published
              ? () => toggleAudio()
              : () => setMedia((m) => ({ ...m, ui: { ...m.ui, showAudioSettings: true } }))
          }
          title={media.audio.published ? "Mute microphone" : "Enable microphone"}
          className={[
            "flex items-center justify-center rounded-full transition-colors",
            "w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12",
            media.audio.published
              ? "bg-green-600 hover:bg-green-500 text-white"
              : "bg-gray-700 hover:bg-gray-600 text-gray-300",
          ].join(" ")}
        >
          {media.audio.published
            ? <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
            : <MicOff className="w-4 h-4 sm:w-5 sm:h-5" />}
        </button>

        {/* ── Etiqueta audio (solo sm+) ── */}
        <span className="hidden sm:block text-xs text-gray-400 select-none -ml-1">
          {media.audio.published ? "Mic on" : "No mic"}
        </span>

        {/* ── Divisor vertical ── */}
        <div className="w-px h-6 bg-white/20 mx-1 hidden sm:block" />

        {/* ── Botón AÑADIR CÁMARA ──
            Two routes, so a menu rather than two more buttons: publish from
            this device, or scan the QR and publish from a phone. Which are
            available differs per device — on iOS only the QR is, since Safari
            will not hold two cameras open at once. */}
        <div className="relative">
          <button
            onClick={() => setShowCameraMenu((v) => !v)}
            title="Add a camera"
            aria-expanded={showCameraMenu}
            className={[
              "relative flex items-center justify-center rounded-full transition-colors",
              "w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12",
              extra.extraCameras.length > 0
                ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                : "bg-gray-700 hover:bg-gray-600 text-gray-300",
            ].join(" ")}
          >
            {/* A stills-camera glyph, deliberately not the movie-camera one
                the primary Video button uses, so the two do not read as the
                same control. The `+` says this one adds rather than toggles. */}
            <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
            {extra.extraCameras.length === 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center
                               justify-center rounded-full bg-zinc-900 text-[9px]
                               font-bold leading-none text-zinc-300">
                +
              </span>
            )}
          </button>

          {showCameraMenu && (
            <>
              {/* Click-away. A plain overlay rather than a document listener:
                  it cannot miss a click that lands on another control. */}
              <div
                className="fixed inset-0 z-[99998]"
                onClick={() => setShowCameraMenu(false)}
              />
              <div
                className={[
                  "absolute z-[99999] w-64 rounded-2xl border border-white/10",
                  "bg-zinc-900 p-3 shadow-2xl left-1/2 -translate-x-1/2",
                  // The strip is at the bottom of the page and the floating
                  // pill at the top, so the menu opens away from each.
                  isBar ? "bottom-full mb-3" : "top-full mt-3",
                ].join(" ")}
              >
                {/* Whatever is already on air, each removable on its own.
                    There is no cap of one: a machine with two USB cameras can
                    publish both, and the stage keys tiles by track. */}
                {extra.extraCameras.length > 0 && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                      Publishing now
                    </p>
                    {extra.extraCameras.map((cam) => (
                      <div
                        key={cam.trackSid}
                        className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">
                          {cam.label}
                        </span>
                        <button
                          onClick={() => extra.removeCamera(cam.trackSid)}
                          disabled={extra.busy}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium
                                     text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {extra.availableCameras.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                      From this device
                    </p>
                    <select
                      value={secondCamDevice}
                      onChange={(e) => setSecondCamDevice(e.target.value)}
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-zinc-200"
                    >
                      <option value="">Choose a camera…</option>
                      {extra.availableCameras.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Camera (${d.deviceId.slice(0, 8)})`}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        if (!secondCamDevice) return;
                        extra.addCamera(secondCamDevice);
                        setSecondCamDevice("");
                        setShowCameraMenu(false);
                      }}
                      disabled={extra.busy || !secondCamDevice}
                      className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium
                                 text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Add it
                    </button>
                  </div>
                ) : (
                  <p className="text-[10px] leading-relaxed text-zinc-500">
                    Every camera on this device is already in use. Another one
                    has to come from your phone.
                  </p>
                )}

                <div className="my-3 border-t border-white/10" />

                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  From your phone
                </p>
                <div className="flex justify-center rounded-xl bg-white p-2">
                  {mobileUrl && <QRCodeSVG value={mobileUrl} size={120} />}
                </div>

                {extra.error && (
                  <p className="mt-2 text-[10px] leading-relaxed text-amber-300/90">
                    {extra.error}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Botón COMPARTIR PANTALLA ──
            Hidden where getDisplayMedia does not exist, which is iOS Safari at
            every version — a button that can only throw is worse than none. */}
        {extra.canScreenShare && (
          <button
            onClick={() => extra.toggleScreenShare()}
            disabled={extra.busy}
            title={extra.isSharingScreen ? "Stop sharing your screen" : "Share your screen"}
            className={[
              "flex items-center justify-center rounded-full transition-colors disabled:opacity-50",
              "w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12",
              extra.isSharingScreen
                ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                : "bg-gray-700 hover:bg-gray-600 text-gray-300",
            ].join(" ")}
          >
            {extra.isSharingScreen
              ? <MonitorX className="w-4 h-4 sm:w-5 sm:h-5" />
              : <MonitorUp className="w-4 h-4 sm:w-5 sm:h-5" />}
          </button>
        )}

        {/* ── Divisor vertical ── */}
        <div className="w-px h-6 bg-white/20 mx-1 hidden sm:block" />

        {/* ── Botón REACCIONES ──
            Was a tab in the side panel, which made a one-tap gesture take
            three and hid the result behind the panel on a phone. Only rendered
            where a ReactionsProvider is mounted, so it is never a button that
            does nothing. */}
        {reactions && (
          <div className="relative">
            <button
              onClick={() => setShowReactions((v) => !v)}
              title="Send a reaction"
              aria-expanded={showReactions}
              className={[
                "flex items-center justify-center rounded-full transition-colors",
                "w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12",
                showReactions
                  ? "bg-indigo-600 hover:bg-indigo-500"
                  : "bg-gray-700 hover:bg-gray-600",
              ].join(" ")}
            >
              <Smile className="w-4 h-4 sm:w-5 sm:h-5 text-gray-300" />
            </button>

            {showReactions && (
              <>
                {/* Click-away overlay rather than a document listener: it
                    cannot miss a click that lands on another control. */}
                <div
                  className="fixed inset-0 z-[99998]"
                  onClick={() => setShowReactions(false)}
                />
                <div
                  className={[
                    "absolute w-max z-[99999] rounded-2xl border border-white/10",
                    "bg-zinc-900 p-2 shadow-2xl left-1/2 -translate-x-1/2",
                    isBar ? "bottom-full mb-3" : "top-full mt-3",
                  ].join(" ")}
                >
                  <div className="grid grid-cols-4 gap-1.5">
                    {reactions.emojis.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          reactions.send(emoji);
                          // Stays open: reactions come in bursts, and
                          // reopening the picker for each one is what made
                          // the panel tab tiring to use.
                        }}
                        className="flex h-11 w-11 items-center justify-center rounded-xl
                                   border border-white/10 bg-white/5 text-2xl
                                   transition-all hover:scale-110 hover:bg-white/15 active:scale-95"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Botón CHAT ──
            Only opens the side panel on its Chat tab; the panel still owns the
            conversation. Rendered only where a ControlPanelProvider exists, so
            it is never a button that does nothing. The unread badge lives here
            now — on the edge tab it was off to the side of where people look. */}
        {panel && (
          <button
            onClick={() => panel.openPanel("chat")}
            title="Open chat"
            className="relative flex items-center justify-center rounded-full transition-colors
                       w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12
                       bg-gray-700 hover:bg-gray-600 text-gray-300"
          >
            <MessageSquare className="w-4 h-4 sm:w-5 sm:h-5" />
            {panel.unreadChat > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center
                               justify-center rounded-full bg-indigo-500 px-1
                               text-[9px] font-bold text-white">
                {panel.unreadChat > 9 ? "9+" : panel.unreadChat}
              </span>
            )}
          </button>
        )}

        {/* ── Botón BUG REPORT ── */}
        <button
          onClick={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showBugReport: true } }))}
          title="Report an issue"
          className="flex items-center justify-center rounded-full transition-colors w-10 h-10 sm:w-11 sm:h-11 md:w-12 md:h-12 bg-zinc-700 hover:bg-amber-500/80 text-gray-400 hover:text-black"
        >
          <Bug className="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>

      {/* ── Modales (fuera del panel para no afectar su layout) ── */}

      {media.ui.showVideoSettings && (
        <div
          className="fixed inset-0 z-[999998] bg-black/50 flex items-start justify-center p-4 sm:pt-[2%] overflow-y-auto"
          onClick={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showVideoSettings: false } }))}
        >
          <div className="w-full max-w-[350px] max-h-viewport overflow-y-auto rounded-xl" onClick={(e) => e.stopPropagation()}>
            <VideoSettingsPanel
              initialCapture={media.video.capture}
              initialPublish={media.video.publish}
              onSave={toggleVideo}
              onClose={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showVideoSettings: false } }))}
            />
          </div>
        </div>
      )}

      {media.ui.showBugReport && (
        <BugReportDialog
          onClose={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showBugReport: false } }))}
          participantId={room?.localParticipant?.identity}
          roomName={room?.name}
        />
      )}

      {/* Publish-error recovery modal. Triggered by toggleAudio /
          toggleVideo catches. The retry callback is selected by `kind`
          so the same modal handles both with the right device list. */}
      <MediaPublishErrorModal
        open={publishError !== null}
        kind={publishError?.kind ?? "audio"}
        errorMessage={publishError?.message ?? ""}
        devices={publishError?.kind === "video" ? videoInputs : audioInputs}
        onRetry={publishError?.kind === "video" ? retryVideoWithDevice : retryAudioWithDevice}
        onClose={() => setPublishError(null)}
      />

      {media.ui.showAudioSettings && (
        <div
          className="fixed inset-0 z-[999998] bg-black/50 flex items-start justify-center p-4 sm:pt-[2%] overflow-y-auto"
          onClick={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showAudioSettings: false } }))}
        >
          <div className="w-full max-w-[350px] max-h-viewport overflow-y-auto rounded-xl" onClick={(e) => e.stopPropagation()}>
            <AudioSettingsPanel
              initialCapture={media.audio.capture}
              initialPublish={media.audio.publish}
              initialMode={audioMode ?? "speech"}
              onSave={toggleAudio}
              onClose={() => setMedia((m) => ({ ...m, ui: { ...m.ui, showAudioSettings: false } }))}
            />
          </div>
        </div>
      )}
    </>
  );
}
