"use client";

/**
 * The QR target: one page, one job — publish this phone's camera into the
 * session as an extra feed.
 *
 * It used to open two LiveKit connections (a `-secondary-` one for the camera
 * and a `-screen-` one for a screen share) and render both panels side by
 * side. Nothing wanted that here: the page is reached by scanning a QR headed
 * "add a camera from your phone", and no mobile browser implements
 * `getDisplayMedia` at all — Safari on iOS at every version, Chrome on
 * Android too. On a desktop the in-page button (`useExtraSources`) shares a
 * screen from the connection already open, which is strictly better than a
 * second participant. So the screen half is gone, and with it one connection
 * and one participant per scan.
 *
 * No audio, ever. The mic is disabled on connect and no capture call here
 * asks for it: this device sits next to one already in the room, so a second
 * mic would be the same voice twice — feedback at best, an echo the mixer
 * cannot undo at worst.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import {
  createLocalVideoTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
} from "livekit-client";
import { Camera, CameraOff, SwitchCamera, Wifi, WifiOff, Loader2 } from "lucide-react";
import { runPublishOp } from "../utils/publishQueue";

/** Requested capture size. The browser is free to hand back less. */
const CAPTURE = { width: 640, height: 480 };

type Facing = "user" | "environment";

// ── Hook: one LiveKit room connection ────────────────────────────────────────
function usePublishRoom(identity: string, displayName: string, roomName: string) {
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");

  useEffect(() => {
    if (!roomName || !identity) return;
    let instance: Room;
    setStatus("connecting");

    (async () => {
      try {
        const res = await fetch(`/api/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(displayName)}&role=student&room_name=${encodeURIComponent(roomName)}`);
        const { token } = await res.json();
        instance = new Room();
        await instance.connect(process.env.NEXT_PUBLIC_LIVEKIT_URL!, token);
        instance.localParticipant.setMicrophoneEnabled(false);
        setRoom(instance);
        setStatus("connected");
      } catch {
        setStatus("error");
      }
    })();

    return () => { instance?.disconnect(); };
  }, [identity, displayName, roomName]);

  return { room, status };
}

/**
 * Keep the screen awake while publishing. A phone propped up as a second
 * camera gets no touches, so it dims and locks on its own timer — and a
 * locked screen stops the capture. Every part of this is best-effort:
 * the API does not exist on iOS below 16.4, and the lock is dropped
 * whenever the page is hidden, hence the re-acquire on visibilitychange.
 */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let sentinel: any = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        sentinel = await (navigator as any).wakeLock?.request?.("screen");
        if (cancelled) { sentinel?.release?.(); sentinel = null; }
      } catch { /* denied or unsupported — the phone just dims as usual */ }
    };

    const onVisibility = () => { if (document.visibilityState === "visible") acquire(); };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release?.().catch?.(() => {});
    };
  }, [active]);
}

// ── Main component ───────────────────────────────────────────────────────────
export default function PublishClient({ identity, displayName }: { identity: string; displayName: string }) {
  const [roomName, setRoomName] = useState("");

  // Unique per page load so several devices (a desktop tab and a phone scan)
  // can be in the room at once without LiveKit evicting each other.
  const [suffix] = useState(() => Math.random().toString(36).slice(2, 8));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRoomName(params.get("room_name") || "test");
  }, []);

  const { room, status } = usePublishRoom(
    `${identity}-secondary-${suffix}`,
    `${displayName} Camera`,
    roomName,
  );

  if (status === "error") {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <WifiOff className="h-9 w-9 text-red-400" />
          <p className="font-semibold text-white">Connection failed</p>
          <p className="text-sm text-zinc-400">Check your network and try again.</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 rounded-xl border border-zinc-700 bg-zinc-800 px-5 py-3 text-base text-white transition-colors hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </Screen>
    );
  }

  if (status !== "connected" || !room) {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
          <p className="text-sm text-zinc-400">Connecting…</p>
        </div>
      </Screen>
    );
  }

  return <CameraPage room={room} roomName={roomName} />;
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-viewport flex items-center justify-center bg-zinc-950">
      {children}
    </div>
  );
}

// ── The page proper ──────────────────────────────────────────────────────────
function CameraPage({ room, roomName }: { room: Room; roomName: string }) {
  const [live, setLive] = useState(false);
  const [facing, setFacing] = useState<Facing>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackRef = useRef<LocalVideoTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useWakeLock(live);

  // The room is the source of truth for "am I publishing", not this
  // component: the track can end without us (the camera is taken by another
  // app, the tab is evicted), and a button still reading "Stop" then does
  // nothing when tapped.
  useEffect(() => {
    const sync = () => {
      const stillUp = Array.from(room.localParticipant.trackPublications.values())
        .some((p: any) => p.track && p.track === trackRef.current);
      if (!stillUp) {
        trackRef.current = null;
        setLive(false);
      }
    };
    room.on(RoomEvent.LocalTrackUnpublished, sync);
    return () => { room.off(RoomEvent.LocalTrackUnpublished, sync); };
  }, [room]);

  const start = useCallback(async (nextFacing: Facing) => {
    setError(null);
    setBusy(true);
    try {
      await runPublishOp(room, "video", async () => {
        const track = await createLocalVideoTrack({
          facingMode: nextFacing,
          resolution: CAPTURE,
        });
        await room.localParticipant.publishTrack(track, { name: "camera" });
        trackRef.current = track;
        // attach(), not srcObject: LiveKit re-points every attached element
        // when the track restarts, which is what the flip below does.
        if (videoRef.current) track.attach(videoRef.current);
        setLive(true);
      });
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Camera permission denied. Allow it in your browser settings and reload."
          : e?.name === "NotFoundError"
            ? "No camera found on this device."
            : "Could not start the camera. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [room]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await runPublishOp(room, "video", async () => {
        const track = trackRef.current;
        if (track) {
          track.detach();
          await room.localParticipant.unpublishTrack(track, true);
        }
        trackRef.current = null;
        setLive(false);
      });
    } finally {
      setBusy(false);
    }
  }, [room]);

  /**
   * Flip front↔back by restarting the existing track, not by republishing.
   * The publication — and therefore its sid — survives, so the host's stage
   * tile keeps pointing at the same track: no blink, and nothing for the
   * host's entity cleanup to reconcile. Republishing would hand the same
   * camera a new sid and put the tile through the recovery path for no
   * reason (docs/llm/13).
   */
  const flip = useCallback(async () => {
    const next: Facing = facing === "user" ? "environment" : "user";
    if (!live || !trackRef.current) { setFacing(next); return; }

    setBusy(true);
    setError(null);
    try {
      await runPublishOp(room, "video", async () => {
        await trackRef.current!.restartTrack({ facingMode: next, resolution: CAPTURE });
        // Ask the track what it actually got. A device with one camera does
        // not always reject the constraint — some browsers hand back the
        // same camera and say nothing, and a label reading "Back camera"
        // over the front one is worse than no button at all. Desktops
        // usually report no facingMode; that is not a mismatch, just a
        // browser with nothing to say.
        const got = trackRef.current!.mediaStreamTrack.getSettings().facingMode;
        if (got && got !== next) {
          setError("This device has only one camera.");
          return;
        }
        setFacing(next);
      });
    } catch {
      setError("Could not switch camera.");
    } finally {
      setBusy(false);
    }
  }, [facing, live, room]);

  return (
    <div className="h-viewport flex flex-col overflow-hidden bg-zinc-950 text-white">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Extra camera</span>
        </div>
        <span className="max-w-[110px] truncate font-mono text-[11px] text-zinc-600">{roomName}</span>
        {live ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <Wifi className="h-3 w-3" /> Live
          </span>
        ) : (
          <span className="text-[11px] text-zinc-600">Not sending</span>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-black p-2">
        <div className="col-start-1 row-start-1 grid grid-cols-1 grid-rows-1 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="col-start-1 row-start-1 h-full w-full min-h-0 object-contain"
            // Mirrored only for the front camera, and only here: it is how a
            // phone shows you yourself. The published frames are untouched.
            style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
          />
          {!live && (
            <div className="col-start-1 row-start-1 flex flex-col items-center justify-center gap-2 bg-zinc-900">
              <CameraOff className="h-8 w-8 text-zinc-600" />
              <span className="text-sm text-zinc-600">Camera off</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="flex-shrink-0 px-4 pb-1 text-center text-[13px] leading-snug text-amber-300/90">
          {error}
        </p>
      )}

      <footer className="pb-safe flex-shrink-0 px-4 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => (live ? stop() : start(facing))}
            disabled={busy}
            className={[
              "flex flex-1 items-center justify-center gap-2 rounded-2xl py-4 text-base font-semibold shadow-md transition-all active:scale-[0.98] disabled:opacity-40",
              live ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500",
            ].join(" ")}
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" />
                  : live ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
            {live ? "Stop camera" : "Start camera"}
          </button>

          <button
            onClick={flip}
            disabled={busy}
            aria-label="Switch camera"
            title="Switch camera"
            className="flex items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-800 p-4 transition-colors hover:bg-zinc-700 disabled:opacity-40"
          >
            <SwitchCamera className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-zinc-600">
          Microphone off · {facing === "user" ? "Front camera" : "Back camera"}
        </p>
      </footer>
    </div>
  );
}
