"use client";

import { useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import { Room, VideoPresets, RoomEvent, ConnectionQuality, DisconnectReason, Track } from "livekit-client";
import type { RemoteTrackPublication } from "livekit-client";
import { RoomContext, RoomAudioRenderer } from "@livekit/components-react";
import "@livekit/components-styles";
import { SharedStateProvider } from "../hooks/useSharedState";
import { AssistantSuggestionsProvider } from "../hooks/useAssistantSuggestions";
import AssistantSuggestionStack from "../../components/AssistantSuggestionStack";
import { ToastLaneProvider } from "../../components/ui/ToastLane";
import { ControlPanelProvider } from "../../components/ui/ControlPanelContext";
import { ReactionsProvider } from "../../components/ui/ReactionsContext";
import { MicIssuesProvider } from "../../components/ui/MicIssuesContext";
import { useSession } from "next-auth/react";
import { WifiOff, Loader2 } from "lucide-react";
import { makeConnLogger, logQualityChange, netInfo, type QualityTracker } from "../lib/connLog";

const HostContent = dynamic(() => import("../../components/HostContent"), {
  ssr: false,
});

export default function HostPage() {
  const { data: session, status } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);

  // Instancia única de Room
  const roomRef = useRef<Room | null>(null);
  if (!roomRef.current) {
    roomRef.current = new Room({
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: {
        simulcast: true,
        videoCodec: 'vp8',
        videoSimulcastLayers: [
          VideoPresets.h720,
          VideoPresets.h360,
          VideoPresets.h180,
        ],
        // maintain-framerate: on bad network, reduce resolution rather than
        // freezing the video entirely. Frozen video looks like a disconnect.
        degradationPreference: 'maintain-framerate',
      },
      videoCaptureDefaults: {
        resolution: { width: 1280, height: 720 },
        frameRate: 15,
      },
      // More aggressive reconnect: up to 10 retries, cap at 15 s per attempt.
      // Default policy gives up after ~3 retries (~15 s total) — too short for
      // a 4G signal drop that might last 20–30 s.
      reconnectPolicy: {
        nextRetryDelayInMs: (ctx) => {
          if (ctx.retryCount >= 10) return null;
          return Math.min(1000 * (2 ** ctx.retryCount), 15_000);
        },
      },
    });
  }
  const roomInstance = roomRef.current;

  // ✅ Control para ejecutar solo una vez
  const hasConnectedRef = useRef(false);
  // Network resilience state
  const [reconnecting, setReconnecting]   = useState(false);
  const [disconnected, setDisconnected]   = useState(false);
  const [poorConnection, setPoorConnection] = useState(false);
  // True only AFTER the quality auto-pause has actually torn down the
  // camera. Drives the banner copy split: warning vs degraded.
  const [autoDegraded, setAutoDegraded]     = useState(false);
  // True when we auto-paused the camera due to poor quality. Lets us restore
  // it on recovery without re-enabling a camera the user had turned off.
  const autoPausedCameraRef      = useRef(false);
  const autoPausedRemoteVideoRef = useRef(false);


  useEffect(() => {
    // Evita ejecución repetida
    if (hasConnectedRef.current) return;
    if (status !== "authenticated" || !session) return;

    hasConnectedRef.current = true; // 🔒 Bloquea reejecuciones

    const params = new URLSearchParams(window.location.search);
    const room = params.get("sessionId") || "test";
    const uid = (session as any).uid as string | undefined;
    const displayName = session.user?.name ?? session.user?.email?.split("@")[0] ?? "Host";

    if (!uid) {
      console.warn("⚠️ Falta uid en la sesión");
      return;
    }

    setIdentity(uid);

    (async () => {
      try {
        const res = await fetch(
          `/api/token?identity=${encodeURIComponent(uid)}&name=${encodeURIComponent(displayName)}&role=host&room_name=${encodeURIComponent(room)}`
        );
        const data = await res.json();
        setToken(data.token);
      } catch (err) {
        console.error("Error obteniendo token:", err);
      }
    })();
  }, [status, session]);

  useEffect(() => {
    if (!token || !identity) return;

    // Telemetry. The host was previously NOT monitored — only participants
    // reported connection events. But a host-side drop takes down the whole
    // session, so it's the most important connection to have logged.
    const logConn = makeConnLogger("host", identity);
    const qualityTracker: QualityTracker = { last: null };

    // ── Network resilience handlers ──────────────────────────────────────────
    const onReconnecting = () => { setReconnecting(true); logConn("reconnecting"); };
    const onReconnected  = () => { setReconnecting(false); setDisconnected(false); logConn("reconnected"); };
    const onDisconnected = (reason?: DisconnectReason) => {
      logConn("disconnected", { reason: reason !== undefined ? DisconnectReason[reason] ?? String(reason) : null });
      // CLIENT_INITIATED = user clicked "Leave" — not an error.
      if (reason !== DisconnectReason.CLIENT_INITIATED) {
        setReconnecting(false);
        setDisconnected(true);
      }
    };
    // LiveKit re-evaluates ConnectionQuality every ~5 s server-side. In
    // bursty 4G this produces frequent excellent ↔ poor flapping. Acting
    // immediately on every transition (original implementation) toggled
    // the host's camera every few seconds — visible to every participant
    // as Ron's image disappearing/reappearing.
    //
    // Three-stage hysteresis:
    //   POOR_WARN_MS    → sustained Poor/Lost before the AMBER banner
    //                     appears. Filters single-blip false alarms that
    //                     fire on otherwise-excellent connections (browser
    //                     GC pause, isolated jitter burst, single keyframe
    //                     drop trigger one "Poor" event followed by
    //                     immediate recovery — should never alarm the
    //                     host).
    //   POOR_ESCALATE_MS → sustained Poor/Lost before the actual camera /
    //                     remote-video teardown fires and the banner
    //                     flips to ORANGE.
    //   GOOD_RECOVER_MS  → sustained Good/Excellent before recovery
    //                     unwinds the teardown.
    // Same configuration as the participant page so behaviour is
    // consistent on both sides.
    const POOR_WARN_MS = 5_000;
    const POOR_ESCALATE_MS = 30_000;
    const GOOD_RECOVER_MS = 10_000;
    let poorWarnTimer: ReturnType<typeof setTimeout> | null = null;
    let poorEscalateTimer: ReturnType<typeof setTimeout> | null = null;
    let goodRecoverTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (which: "warn" | "poor" | "good") => {
      const ref = which === "warn" ? poorWarnTimer
        : which === "poor" ? poorEscalateTimer
        : goodRecoverTimer;
      if (ref) clearTimeout(ref);
      if (which === "warn") poorWarnTimer = null;
      else if (which === "poor") poorEscalateTimer = null;
      else goodRecoverTimer = null;
    };
    // Audio-loss threshold below which we DECLINE to teardown video even
    // though LiveKit reported sustained Poor. By the time the 30s timer
    // fires, LiveKit has had time to play its full adaptive cascade
    // (bitrate reduction, simulcast layer drop, `maintain-framerate`
    // resolution sacrifice). If audio is still fluid the user is fine —
    // tearing video down at that point makes things WORSE (no video vs
    // ugly video) unless audio is suffering too. See note in
    // app/participant/page.tsx for the full rationale.
    const AUDIO_LOSS_DOWNGRADE_THRESHOLD = 0.05;
    const measureAudioLoss = async (): Promise<number> => {
      const pc = (roomInstance.engine as any)?.pcManager?.subscriber?.pc as
        RTCPeerConnection | undefined;
      if (!pc) return 0;
      try {
        const stats = await pc.getStats();
        let lost = 0, received = 0;
        stats.forEach((s: any) => {
          if (s.type === "inbound-rtp" && s.kind === "audio") {
            lost += s.packetsLost ?? 0;
            received += s.packetsReceived ?? 0;
          }
        });
        const total = lost + received;
        return total > 0 ? lost / total : 0;
      } catch { return 0; }
    };

    const doPause = async () => {
      const loss = await measureAudioLoss();
      if (loss < AUDIO_LOSS_DOWNGRADE_THRESHOLD) {
        console.info(
          `[quality] escalation declined: audio loss ${(loss * 100).toFixed(2)}% < ${AUDIO_LOSS_DOWNGRADE_THRESHOLD * 100}% — LiveKit adaptation working`,
        );
        return;
      }
      console.warn(
        `[quality] escalating teardown: audio loss ${(loss * 100).toFixed(2)}% ≥ ${AUDIO_LOSS_DOWNGRADE_THRESHOLD * 100}%`,
      );
      const camPub = roomInstance.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub && !camPub.isMuted && !autoPausedCameraRef.current) {
        autoPausedCameraRef.current = true;
        roomInstance.localParticipant.setCameraEnabled(false).catch(() => {});
      }
      if (!autoPausedRemoteVideoRef.current) {
        autoPausedRemoteVideoRef.current = true;
        for (const p of roomInstance.remoteParticipants.values()) {
          for (const pub of p.trackPublications.values()) {
            if (pub.kind === Track.Kind.Video)
              (pub as RemoteTrackPublication).setSubscribed(false);
          }
        }
      }
      setAutoDegraded(true);
    };
    const doRestore = () => {
      if (autoPausedCameraRef.current) {
        autoPausedCameraRef.current = false;
        roomInstance.localParticipant.setCameraEnabled(true).catch(() => {});
      }
      if (autoPausedRemoteVideoRef.current) {
        autoPausedRemoteVideoRef.current = false;
        for (const p of roomInstance.remoteParticipants.values()) {
          for (const pub of p.trackPublications.values()) {
            if (pub.kind === Track.Kind.Video)
              (pub as RemoteTrackPublication).setSubscribed(true);
          }
        }
      }
      setAutoDegraded(false);
    };
    const onQualityChanged = (quality: ConnectionQuality, participant: { identity: string }) => {
      if (participant.identity !== roomInstance.localParticipant.identity) return;
      logQualityChange(logConn, qualityTracker, quality);
      const isBad = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
      if (isBad) {
        clearTimer("good");
        // Stage 1: warn timer. Only after POOR_WARN_MS of sustained bad
        // do we flip the amber banner. Avoids alarming on isolated Poor
        // events that recover within the next 5s evaluation window — the
        // pattern users on excellent connections were complaining about.
        if (!poorConnection && !poorWarnTimer) {
          poorWarnTimer = setTimeout(() => {
            poorWarnTimer = null;
            setPoorConnection(true);
          }, POOR_WARN_MS);
        }
        // Stage 2: escalation timer.
        const alreadyPaused = autoPausedCameraRef.current || autoPausedRemoteVideoRef.current;
        if (!alreadyPaused && !poorEscalateTimer) {
          poorEscalateTimer = setTimeout(() => {
            poorEscalateTimer = null;
            doPause().catch(() => {});
          }, POOR_ESCALATE_MS);
        }
      } else {
        clearTimer("warn");
        clearTimer("poor");
        // Banner off — both timers cancelled, and if the banner was
        // already showing (warn timer had fired) hide it now.
        setPoorConnection(false);
        const alreadyPaused = autoPausedCameraRef.current || autoPausedRemoteVideoRef.current;
        if (alreadyPaused && !goodRecoverTimer) {
          goodRecoverTimer = setTimeout(() => {
            goodRecoverTimer = null;
            doRestore();
          }, GOOD_RECOVER_MS);
        }
      }
    };
    const cancelQualityTimers = () => {
      clearTimer("warn");
      clearTimer("poor");
      clearTimer("good");
    };

    // First successful join — confirms the host actually reached the SFU.
    const onConnected = () => logConn("connected", { url: process.env.NEXT_PUBLIC_LIVEKIT_URL, ...netInfo() });
    // Signal-level reconnect (WebSocket dropped, media may still be up) —
    // fires earlier than RoomEvent.Reconnecting in some failure modes.
    const onSignalReconnecting = () => logConn("signal_reconnecting");
    // getUserMedia / device errors (mic in use, permission denied) — often
    // the real reason a host "couldn't start" while the room looks fine.
    const onMediaDevicesError = (error: Error) => {
      logConn("media_devices_error", {
        name: error?.name ?? null,
        message: error?.message?.slice(0, 200) ?? null,
      });
    };

    roomInstance.on(RoomEvent.Connected,               onConnected);
    roomInstance.on(RoomEvent.Reconnecting,            onReconnecting);
    roomInstance.on(RoomEvent.Reconnected,             onReconnected);
    roomInstance.on(RoomEvent.SignalReconnecting,      onSignalReconnecting);
    roomInstance.on(RoomEvent.Disconnected,            onDisconnected);
    roomInstance.on(RoomEvent.ConnectionQualityChanged, onQualityChanged);
    roomInstance.on(RoomEvent.MediaDevicesError,       onMediaDevicesError);

    // Page lifecycle — distinguishes "host backgrounded the tab" (timers
    // suspended, not a real fault) from a genuine drop, and records the
    // host closing/navigating away (sendBeacon survives pagehide).
    const onVisibility = () => logConn("visibility", { hidden: document.hidden });
    const onPageHide = () => logConn("pagehide");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    const connectRoom = async () => {
      const t0 = Date.now();
      try {
        await roomInstance.connect(process.env.NEXT_PUBLIC_LIVEKIT_URL!, token);

        roomInstance.localParticipant.setMetadata(
          JSON.stringify({ role: "teacher", identity })
        );
      } catch (err: any) {
        console.error("❌ Error connecting to LiveKit:", err);
        logConn("connect_failed", {
          name: err?.name ?? null,
          message: err?.message?.slice(0, 200) ?? String(err).slice(0, 200),
          tookMs: Date.now() - t0,
        });
      }
    };

    connectRoom();

    return () => {
      roomInstance.off(RoomEvent.Connected,               onConnected);
      roomInstance.off(RoomEvent.Reconnecting,            onReconnecting);
      roomInstance.off(RoomEvent.Reconnected,             onReconnected);
      roomInstance.off(RoomEvent.SignalReconnecting,      onSignalReconnecting);
      roomInstance.off(RoomEvent.Disconnected,            onDisconnected);
      roomInstance.off(RoomEvent.ConnectionQualityChanged, onQualityChanged);
      // Cancel any pending escalate/recover so a delayed timer doesn't
      // toggle camera/subscriptions on an already-disconnected room.
      cancelQualityTimers();
      roomInstance.off(RoomEvent.MediaDevicesError,       onMediaDevicesError);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      if (roomInstance.state === "connected") {
        roomInstance.disconnect();
      }
    };
  }, [token, identity]);

  if (status === "loading") return <div>Loading session...</div>;
  if (!session) return <div>No active session</div>;
  if (!token) return <div>Connecting to LiveKit...</div>;
  return (
    <RoomContext.Provider value={roomInstance}>
      <RoomAudioRenderer />
      <SharedStateProvider>
        {/* AI assistant suggestions: bus + UI. Wrapped INSIDE SharedState
          * because the manifest publish + skill handlers both reach into
          * the shared-state API. localRole drives which suggestions get
          * shown — the host sees everything intended for hosts. */}
        {/* One shared column for every transient overlay below — see
            components/ui/ToastLane.tsx. `pushed` drops it below the
            full-width connection banners this page renders at top-0. */}
        <ToastLaneProvider pushed={reconnecting || poorConnection}>
          <ControlPanelProvider>
            {/* Owns the reaction overlay and the only data-channel
                subscription for it — mounting it twice would spawn every
                emoji twice. The control bar's picker reads `send` from
                here; without this provider it renders no button at all. */}
            <ReactionsProvider>
              <AssistantSuggestionsProvider localRole="host">
                {/* The side panel is mounted by HostContent, docked in its
                    layout row (it also carries the Play2Gether mixer tab). */}
                {/* Colours the mic meters red while the analyser hears
                    someone clipping. Host only, so it lives here. */}
                <MicIssuesProvider>
                  <HostContent room={roomInstance} />
                </MicIssuesProvider>
                <AssistantSuggestionStack />
              </AssistantSuggestionsProvider>
            </ReactionsProvider>
          </ControlPanelProvider>
        </ToastLaneProvider>
      </SharedStateProvider>

      {/* ── Network banners ─────────────────────────────────────────────── */}
      {reconnecting && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2
                        bg-yellow-600/90 text-white text-sm py-2 px-4 pointer-events-none">
          <Loader2 className="w-4 h-4 animate-spin" />
          Reconnecting…
        </div>
      )}
      {poorConnection && !reconnecting && (
        // Warning amber while the network is bad but nothing's been
        // touched (POOR_ESCALATE_MS grace window). Solid orange once the
        // auto-pause has actually kicked in — makes it explicit to the
        // host why participants stopped seeing their camera.
        <div className={`fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-1.5 ${autoDegraded ? "bg-orange-600/90" : "bg-amber-600/80"} text-white text-sm py-2 px-4 pointer-events-none`}>
          <WifiOff className="w-4 h-4" />
          {autoDegraded
            ? "Camera paused to preserve audio · auto-resumes when your connection recovers"
            : "Unstable connection — keeping video for now"}
        </div>
      )}
      {disconnected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 flex flex-col
                          items-center gap-4 max-w-sm w-full mx-4 text-center shadow-2xl">
            <WifiOff className="w-8 h-8 text-red-400" />
            <p className="text-white font-semibold text-lg">Connection lost</p>
            <p className="text-zinc-400 text-sm">
              The session was disconnected after multiple reconnect attempts.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500
                         rounded-lg text-sm font-medium text-white transition-colors"
            >
              Rejoin
            </button>
          </div>
        </div>
      )}
    </RoomContext.Provider>
  );
}
