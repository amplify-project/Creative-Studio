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
import { useControlPanelOrNull } from "./ui/ControlPanelContext";
import { useExtraSources } from "../app/hooks/useExtraSources";
import { usePublishUrl } from "../app/hooks/usePublishUrl";
import { useReactionsOrNull } from "./ui/ReactionsContext";
import { QRCodeSVG } from "qrcode.react";
import MediaPublishErrorModal from "./ui/MediaPublishErrorModal";
import { registerRoomDebug } from "../app/utils/muteDebug";

interface MediaControlsProps {
  room: any;
  autoPublish?: boolean;
  audioMode?: AudioMode;
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
  const [media, setMedia] = useState({
    audio: {
      published: false,
      capture: {
        ...initialPreset.capture,
        deviceId: "default",
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
  const prevAudioModeRef = useRef<AudioMode | undefined>(audioMode);

  /** --------------------------------------------------------------
   * 🔁 Sync published state with actual room tracks
   * Handles: participant joins after JoinSetup, host autoPublish, etc.
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (!room) return;

    const syncState = () => {
      const pubs = Array.from(room.localParticipant.trackPublications.values()) as any[];
      const hasAudio = pubs.some((p) => p.track?.kind === Track.Kind.Audio);
      // Camera only. A screen share or a second camera is a video track too,
      // and counting them here made the camera button light up for a camera
      // that was off.
      const hasVideo = pubs.some(
        (p) => p.track?.kind === Track.Kind.Video && p.source === Track.Source.Camera,
      );
      setMedia((m) => ({
        ...m,
        audio: { ...m.audio, published: hasAudio },
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
   * 🔄 React to remote audioMode changes (music / speech)
   * Aplica el preset y re-publica si ya estaba activo
   * -------------------------------------------------------------- */
  useEffect(() => {
    if (!audioMode || !room) return;
    if (audioMode === prevAudioModeRef.current) return;
    prevAudioModeRef.current = audioMode;

    // ✅ Usar AUDIO_MODE_PRESETS de audioSelector, sin duplicar config
    const preset = AUDIO_MODE_PRESETS[audioMode];
    if (!preset) return;

    const nextCapture: AudioCaptureState = {
      ...media.audio.capture,
      ...preset.capture,
    };
    const nextPublish: AudioPublishState = preset.publish;

    console.log(`[AudioMode] → "${audioMode}"`, { nextCapture, nextPublish });

    setMedia((m) => ({
      ...m,
      audio: { ...m.audio, capture: nextCapture, publish: nextPublish },
    }));

    // Re-publish with the new preset, but only if a mic is actually live.
    // Serialized through runAudioOp + the room (not stale React state) is the
    // source of truth, so the unpublish→re-capture can't interleave with
    // another publish path and leave a duplicate/silent mic behind.
    runAudioOp(async () => {
      const audioPubs = (Array.from(room.localParticipant.trackPublications.values()) as any[])
        .filter((p) => p.track?.kind === Track.Kind.Audio);
      if (audioPubs.length === 0) return; // nothing live → nothing to re-publish
      audioPubs.forEach((p) => room.localParticipant.unpublishTrack(p.track));
      const track = await createLocalAudioTrack({ ...nextCapture });
      await room.localParticipant.publishTrack(track, { ...nextPublish });
      dedupeAudioTracks();
      console.log(`[AudioMode] Re-published in "${audioMode}" mode`);
    });
  }, [audioMode, room]);

  /** --------------------------------------------------------------
   * 🎤 Toggle AUDIO
   * -------------------------------------------------------------- */
  const toggleAudio = async (settings?: { capture: AudioCaptureState; publish: AudioPublishState }) => {
    if (!room) return;

    const nextState = {
      capture: settings?.capture ?? media.audio.capture,
      publish: settings?.publish ?? media.audio.publish,
    };

    if (settings) {
      setMedia((m) => ({ ...m, audio: { ...m.audio, ...nextState } }));
    }

    // Serialized through runAudioOp so concurrent paths (autoPublish, audioMode
    // re-publish, rapid double-clicks) can't double-publish the mic. Inside the
    // lock the room is the source of truth — avoids stale-closure issues where
    // React state lags behind the actual published state.
    await runAudioOp(async () => {
      const pubs = Array.from(room.localParticipant.trackPublications.values()) as any[];
      const isActuallyPublished = pubs.some((p) => p.track?.kind === Track.Kind.Audio);

      if (!isActuallyPublished) {
        try {
          const track = await createLocalAudioTrack({ ...nextState.capture });
          await room.localParticipant.publishTrack(track, { ...nextState.publish });
          dedupeAudioTracks();
          setMedia((m) => ({
            ...m,
            audio: { ...m.audio, published: true },
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
      } else {
        room.localParticipant.trackPublications.forEach((pub: any) => {
          if (pub.track?.kind === Track.Kind.Audio) {
            room.localParticipant.unpublishTrack(pub.track);
          }
        });
        setMedia((m) => ({ ...m, audio: { ...m.audio, published: false } }));
      }
    });
  };

  /** Re-attempt audio publish with an explicit deviceId. Used by the
   *  recovery modal. Throws on failure so the modal can show the inline
   *  "still failing" state and stay open. */
  const retryAudioWithDevice = async (deviceId: string) => {
    if (!room) throw new Error("Room not available");
    const captureOverride: AudioCaptureState = {
      ...media.audio.capture,
      deviceId,
    };
    // Serialized + drop any existing mic first so a retry REPLACES the track
    // rather than stacking a second one. runAudioOp propagates the rejection,
    // so the modal still sees the throw and stays open on failure.
    await runAudioOp(async () => {
      (Array.from(room.localParticipant.trackPublications.values()) as any[])
        .filter((p) => p.track?.kind === Track.Kind.Audio)
        .forEach((p) => room.localParticipant.unpublishTrack(p.track));
      const track = await createLocalAudioTrack({ ...captureOverride });
      await room.localParticipant.publishTrack(track, { ...media.audio.publish });
      dedupeAudioTracks();
    });
    setMedia((m) => ({
      ...m,
      audio: { ...m.audio, capture: captureOverride, published: true },
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
