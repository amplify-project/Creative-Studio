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
import { useSession } from "next-auth/react";
import { WifiOff, Loader2 } from "lucide-react";
import { makeConnLogger, logQualityChange, netInfo, type QualityTracker } from "../lib/connLog";

const MainStageParticipant = dynamic(() => import("../../components/MainStageParticipant"), { ssr: false });

export default function ParticipantPage() {
  const { data: session, status } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);

  // Instancia única del Room
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
        degradationPreference: 'maintain-framerate',
      },
      videoCaptureDefaults: {
        resolution: { width: 1280, height: 720 },
        frameRate: 15,
      },
      reconnectPolicy: {
        nextRetryDelayInMs: (ctx) => {
          if (ctx.retryCount >= 10) return null;
          return Math.min(1000 * (2 ** ctx.retryCount), 15_000);
        },
      },
    });
  }
  const roomInstance = roomRef.current;

  // 🔒 Control para evitar ejecuciones múltiples
  const hasConnectedRef = useRef(false);

  // Network resilience state
  const [reconnecting, setReconnecting]       = useState(false);
  const [disconnected, setDisconnected]       = useState(false);
  const [poorConnection, setPoorConnection]   = useState(false);
  // True only AFTER the quality auto-pause has actually torn down the
  // camera (after POOR_ESCALATE_MS sustained). `poorConnection` covers
  // the warning phase too — we use this one to flip the banner copy from
  // "watching your connection" to "we just paused your camera".
  const [autoDegraded, setAutoDegraded]       = useState(false);
  const [cameraDisabled, setCameraDisabled]   = useState(false);
  // True when the host (role: "teacher") has left the room and we tore
  // down our own connection in response.
  const [endedByHost, setEndedByHost]         = useState(false);
  const autoPausedCameraRef                   = useRef(false);
  const autoPausedRemoteVideoRef              = useRef(false);
  const manuallyDisabledCameraRef             = useRef(false);

  const disableCamera = () => {
    roomInstance.localParticipant.setCameraEnabled(false).catch(() => {});
    manuallyDisabledCameraRef.current = true;
    autoPausedCameraRef.current = false;
    setCameraDisabled(true);
  };

  useEffect(() => {
    if (hasConnectedRef.current) return;
    if (status !== "authenticated" || !session) return;

    hasConnectedRef.current = true; // ✅ Bloquea ejecuciones repetidas

    const params = new URLSearchParams(window.location.search);
    const room = params.get("sessionId") || "test";

    const uid = (session as any).uid as string | undefined;
    const displayName = session.user?.name ?? session.user?.email?.split("@")[0] ?? "Participant";

    if (!uid) {
      console.warn("⚠️ Falta uid en la sesión");
      return;
    }

    setIdentity(uid);

    (async () => {
      try {
        const res = await fetch(
          `/api/token?identity=${encodeURIComponent(uid)}&name=${encodeURIComponent(displayName)}&role=participant&room_name=${encodeURIComponent(room)}`
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

    // Fire-and-forget beacon to the server so we can answer "did this user
    // actually have a connection problem?" from the host log instead of
    // asking them for a console screenshot. sendBeacon survives unload so
    // even a disconnect-on-tab-close gets recorded. Shared with the host page
    // via makeConnLogger so both sides log the same schema (incl. `role`).
    const logConn = makeConnLogger("participant", identity);
    const qualityTracker: QualityTracker = { last: null };

    const onReconnecting = () => { setReconnecting(true); logConn("reconnecting"); };
    const onReconnected  = () => {
      setReconnecting(false); setDisconnected(false);
      logConn("reconnected");
    };
    const onDisconnected = (reason?: DisconnectReason) => {
      logConn("disconnected", { reason: reason !== undefined ? DisconnectReason[reason] ?? String(reason) : null });
      // PARTICIPANT_REMOVED = the host kicked us: useKicked shows that, and a
      // "Connection lost · Rejoin" over it would offer a rejoin the deleted
      // role refuses.
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        setReconnecting(false);
      } else if (reason !== DisconnectReason.CLIENT_INITIATED) {
        setReconnecting(false);
        setDisconnected(true);
      }
    };
    // ConnectionQualityChanged fires once per participant per level change.
    // LiveKit re-evaluates every ~5s server-side; in bursty 4G that produces
    // frequent excellent ↔ poor flapping. Acting IMMEDIATELY on every
    // transition (the original implementation) caused the camera to
    // toggle on/off every few seconds — visible to ALL other participants
    // as the host's image disappearing and reappearing. We now apply
    // hysteresis: the badge banner reacts at once, but the actual track
    // teardown waits for `POOR_ESCALATE_MS` of sustained Poor/Lost.
    // Recovery follows the same pattern with `GOOD_RECOVER_MS`.
    //
    // Manual disable from the user (`manuallyDisabledCameraRef`) still
    // takes precedence — auto-recovery never re-enables a camera the user
    // turned off explicitly.
    // Three-stage hysteresis instead of two:
    //   POOR_WARN_MS    → after this many ms of sustained Poor/Lost, the
    //                     amber banner appears. Single 5s blips never
    //                     surface to the user. Critical for connections
    //                     that ARE good but get one isolated "Poor" event
    //                     per minute (browser GC pause, brief jitter
    //                     burst, single keyframe drop) — those should
    //                     never alarm the user.
    //   POOR_ESCALATE_MS → after this many ms of sustained Poor/Lost, the
    //                     actual camera / remote-video teardown fires
    //                     and the banner flips to orange.
    //   GOOD_RECOVER_MS  → recovery requires this many ms of sustained
    //                     Good/Excellent before restoring.
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
    // Audio-loss threshold (5%) below which we DECLINE to teardown video
    // even though LiveKit reported sustained Poor. Rationale: by the time
    // POOR_ESCALATE_MS has elapsed, LiveKit has had ~30s to play its full
    // adaptive cascade — bitrate reduction, simulcast layer drop (720p →
    // 360p → 180p), `maintain-framerate` resolution sacrifice — and the
    // user typically ended up watching low-res video on a stable but
    // limited link. Tearing the video down at THAT point is sobreactuación:
    // it makes things WORSE for the user (no video at all vs ugly video)
    // unless the audio is also suffering.
    //
    // Audio fluido = LiveKit's adaptation worked. Leave it. Only escalate
    // if the audio is actually losing > 5% of packets — that's the point
    // where dropping video to give audio bandwidth headroom is a net win.
    const AUDIO_LOSS_DOWNGRADE_THRESHOLD = 0.05;
    const measureAudioLoss = async (): Promise<number> => {
      // Subscriber PC carries the inbound audio from every remote we're
      // currently subscribed to. We aggregate loss across ALL streams so
      // one bad publisher doesn't push us to teardown.
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
      // Before tearing anything down, check whether LiveKit's built-in
      // adaptation already absorbed the network problem. If audio is
      // flowing cleanly, the user is fine — even at 180p degraded video.
      const loss = await measureAudioLoss();
      if (loss < AUDIO_LOSS_DOWNGRADE_THRESHOLD) {
        // Audio survived the degradation. Don't escalate to teardown.
        // Banner stays amber ("watching your connection"); if quality
        // later genuinely collapses, the next quality event re-arms the
        // escalation timer and we recheck.
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
      // Flip the banner copy to the explicit "we paused your camera"
      // message so the user knows why they suddenly stopped being seen.
      setAutoDegraded(true);
    };
    const doRestore = () => {
      if (autoPausedCameraRef.current && !manuallyDisabledCameraRef.current) {
        autoPausedCameraRef.current = false;
        roomInstance.localParticipant.setCameraEnabled(true).catch(() => {});
      } else {
        autoPausedCameraRef.current = false;
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
        // Cancel any pending recovery: we just went bad again.
        clearTimer("good");
        // Stage 1: arm warning timer. The banner only appears after
        // POOR_WARN_MS of sustained bad — single-event blips (browser GC
        // pause, isolated jitter burst, single keyframe drop) never
        // surface to the user. The previous version called
        // setPoorConnection(true) on the FIRST poor event, which generated
        // false-alarm banners on otherwise excellent connections.
        if (!poorConnection && !poorWarnTimer) {
          poorWarnTimer = setTimeout(() => {
            poorWarnTimer = null;
            setPoorConnection(true);
          }, POOR_WARN_MS);
        }
        // Stage 2: arm escalation timer. Coalesces with any existing
        // pending escalation — a brief good → bad bounce doesn't reset
        // the 30s budget.
        const alreadyPaused = autoPausedCameraRef.current || autoPausedRemoteVideoRef.current;
        if (!alreadyPaused && !poorEscalateTimer) {
          poorEscalateTimer = setTimeout(() => {
            poorEscalateTimer = null;
            doPause().catch(() => {});
          }, POOR_ESCALATE_MS);
        }
      } else {
        // Cancel both pending warn + escalate: we recovered before either
        // fired. This is the common case in bursty 4G AND on stable
        // connections that occasionally throw a single Poor event — both
        // paths converge here and the user sees nothing.
        clearTimer("warn");
        clearTimer("poor");
        // If the banner is currently showing (we got past the warn timer
        // but recovered before the 30s escalate), hide it now — there's
        // nothing more to warn about.
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
    // Capture timer refs for the cleanup below — they're function-scoped
    // here so the disconnect path can cancel pending fires.
    const cancelQualityTimers = () => {
      clearTimer("warn");
      clearTimer("poor");
      clearTimer("good");
    };

    // When the host (role: "teacher") leaves the room, end the session for
    // this participant too. LiveKit only fires ParticipantDisconnected after
    // the SFU declares the participant truly gone (i.e. after a transient
    // reconnect window), so a brief host network blip won't kick everyone.
    // We tear down the local room via disconnect() to stop publishing media;
    // `endedByHost` then drives the dedicated "session ended" modal so the
    // user sees that this was intentional, not a connection failure.
    const onParticipantLeft = (p: any) => {
      let role: string | undefined;
      try {
        role = p?.metadata ? JSON.parse(p.metadata)?.role : undefined;
      } catch { /* malformed metadata — treat as non-host */ }
      if (role !== "teacher") return;
      console.log("[participant] host left the session, disconnecting");
      setEndedByHost(true);
      roomInstance.disconnect().catch(() => {});
    };

    // First successful connection. Lets us measure time-from-token-to-room
    // and confirm the user actually got into the SFU (not just loaded the
    // page). RoomEvent.Connected fires after the join sequence completes.
    const onConnected = () => logConn("connected", { url: process.env.NEXT_PUBLIC_LIVEKIT_URL, ...netInfo() });

    // Signal-level reconnect — fires earlier than RoomEvent.Reconnecting in
    // some failure modes (e.g. WebSocket dropping but UDP media still up).
    const onSignalReconnecting = () => logConn("signal_reconnecting");

    // getUserMedia / device errors (permission denied, mic in use, no
    // camera). Often the real reason a user "didn't get in" but the room
    // looks fine server-side.
    const onMediaDevicesError = (error: Error) => {
      logConn("media_devices_error", {
        name: error?.name ?? null,
        message: error?.message?.slice(0, 200) ?? null,
      });
    };

    roomInstance.on(RoomEvent.Connected,                onConnected);
    roomInstance.on(RoomEvent.Reconnecting,             onReconnecting);
    roomInstance.on(RoomEvent.Reconnected,              onReconnected);
    roomInstance.on(RoomEvent.SignalReconnecting,       onSignalReconnecting);
    roomInstance.on(RoomEvent.Disconnected,             onDisconnected);
    roomInstance.on(RoomEvent.ConnectionQualityChanged, onQualityChanged);
    roomInstance.on(RoomEvent.MediaDevicesError,        onMediaDevicesError);
    roomInstance.on(RoomEvent.ParticipantDisconnected,  onParticipantLeft);

    // Page lifecycle. `visibilitychange` distinguishes "tab backgrounded /
    // phone locked" (no real problem) from "session went bad" later. Browsers
    // suspend JS timers in background tabs, so a 3-minute gap in heartbeat
    // means very different things in each case.
    const onVisibility = () => logConn("visibility", { hidden: document.hidden });
    // `pagehide` is the most reliable "user closed/navigated away" signal —
    // beforeunload doesn't fire on mobile when the user hits Home. sendBeacon
    // is the only fetch that survives this event, which logConn already uses.
    const onPageHide = () => logConn("pagehide", { persisted: false /* not all browsers expose .persisted reliably */ });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    const connectRoom = async () => {
      const t0 = Date.now();
      try {
        await roomInstance.connect(process.env.NEXT_PUBLIC_LIVEKIT_URL!, token);
        console.log("✅ Participant conectado a LiveKit");
      } catch (err: any) {
        console.error("❌ Error connecting to LiveKit:", err);
        // Surface to the same log stream so "user couldn't join" cases are
        // discoverable — these often correlate with token expiry, signal
        // server down, or VPN-blocked turn:443.
        logConn("connect_failed", {
          name: err?.name ?? null,
          message: err?.message?.slice(0, 200) ?? String(err).slice(0, 200),
          tookMs: Date.now() - t0,
        });
      }
    };

    connectRoom();

    return () => {
      roomInstance.off(RoomEvent.Connected,                onConnected);
      roomInstance.off(RoomEvent.Reconnecting,             onReconnecting);
      roomInstance.off(RoomEvent.Reconnected,              onReconnected);
      roomInstance.off(RoomEvent.SignalReconnecting,       onSignalReconnecting);
      roomInstance.off(RoomEvent.Disconnected,             onDisconnected);
      roomInstance.off(RoomEvent.ConnectionQualityChanged, onQualityChanged);
      // Cancel any pending escalate/recover so a delayed timer doesn't
      // toggle camera/subscriptions on an already-disconnected room.
      cancelQualityTimers();
      roomInstance.off(RoomEvent.MediaDevicesError,        onMediaDevicesError);
      roomInstance.off(RoomEvent.ParticipantDisconnected,  onParticipantLeft);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      if (roomInstance.state === "connected") {
        roomInstance.disconnect();
      }
    };
  }, [token, identity]);

if (status === "loading")
  return (
    <div className="flex flex-col items-center justify-center h-viewport text-gray-600 space-y-4">
      <div className="animate-spin h-8 w-8 border-4 border-gray-300 border-t-transparent rounded-full" />
      <p className="text-lg font-medium">Loading session...</p>
    </div>
  );

if (!session)
  return (
    <div className="flex flex-col items-center justify-center h-viewport text-gray-600 space-y-4">
      <div className="animate-pulse text-2xl font-semibold">🕓</div>
      <p className="text-lg font-medium">Waiting for Host</p>
      <p className="text-sm text-gray-400">Your session will start soon</p>
    </div>
  );

if (!token)
  return (
    <div className="flex flex-col items-center justify-center h-viewport text-gray-600 space-y-4">
      <div className="animate-spin h-8 w-8 border-4 border-gray-300 border-t-transparent rounded-full" />
      <p className="text-lg font-medium">Connecting to server...</p>
    </div>
  );

  return (
    <RoomContext.Provider value={roomInstance}>
      <RoomAudioRenderer />
      <SharedStateProvider>
        {/* AI assistant suggestions: bus + UI. See app/host/page.tsx for
          * the full rationale — same provider, different role. */}
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
              <AssistantSuggestionsProvider localRole="participant">
                {/* The side panel is mounted by MainStageParticipant now, as a
                    column in its stage row (docked) rather than an overlay. */}
                <MainStageParticipant />
                <AssistantSuggestionStack />
              </AssistantSuggestionsProvider>
            </ReactionsProvider>
          </ControlPanelProvider>
        </ToastLaneProvider>
      </SharedStateProvider>

      {reconnecting && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2
                        bg-yellow-600/90 text-white text-sm py-2 px-4 pointer-events-none">
          <Loader2 className="w-4 h-4 animate-spin" />
          Reconnecting…
        </div>
      )}
      {poorConnection && !reconnecting && (
        // Two states, two messages:
        //   - `autoDegraded: false` → warning phase. Network is poor but we
        //     haven't touched anything yet (waiting out POOR_ESCALATE_MS).
        //     Amber banner suggests the user can pre-empt by disabling
        //     their camera manually.
        //   - `autoDegraded: true`  → camera + remote video have actually
        //     been paused. Orange banner makes it explicit so the user
        //     understands why others stopped seeing them. Auto-restores
        //     when network recovers — they don't need to do anything.
        <div className={`fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-3 ${autoDegraded ? "bg-orange-600/90" : "bg-amber-600/80"} text-white text-sm py-2 px-4`}>
          <WifiOff className="w-4 h-4 shrink-0" />
          {autoDegraded ? (
            <span>Camera paused to preserve audio · auto-resumes when your connection recovers</span>
          ) : (
            <>
              <span>Unstable connection — keeping video for now</span>
              {!cameraDisabled && (
                <button
                  onClick={disableCamera}
                  className="ml-1 px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-medium transition-colors"
                >
                  Disable camera now
                </button>
              )}
              {cameraDisabled && (
                <span className="ml-1 text-xs text-white/70 italic">Camera disabled</span>
              )}
            </>
          )}
        </div>
      )}
      {endedByHost && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 flex flex-col
                          items-center gap-4 max-w-sm w-full mx-4 text-center shadow-2xl">
            <div className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center">
              <span className="text-2xl">👋</span>
            </div>
            <p className="text-white font-semibold text-lg">Session ended</p>
            <p className="text-zinc-400 text-sm">
              The host has left. You can rejoin when they come back — the
              link in your address bar still works.
            </p>
            {/* Primary action reloads the current URL so ?sessionId=… is
              * preserved. The SessionRole record persists in the DB, so as
              * long as next-auth is still logged in the participant can
              * rejoin without a new invite token. */}
            <button
              onClick={() => window.location.reload()}
              className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500
                         rounded-lg text-sm font-medium text-white transition-colors"
            >
              Rejoin
            </button>
            {/* Secondary action goes to /, but forwards sessionId so the
              * link to this room is still recoverable from / if we ever
              * surface a "recent session" entry there. */}
            <button
              onClick={() => {
                const sid = new URLSearchParams(window.location.search).get("sessionId");
                window.location.href = sid ? `/?sessionId=${encodeURIComponent(sid)}` : "/";
              }}
              className="text-xs text-zinc-400 hover:text-white transition-colors"
            >
              Return to home
            </button>
          </div>
        </div>
      )}
      {disconnected && !endedByHost && (
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
