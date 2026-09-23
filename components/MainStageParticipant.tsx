"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import { RoomContext, useTracks } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import MainStage from "./MainStage";
import { useSharedState } from "../app/hooks/useSharedState";
import { useSharedMainStage } from "../app/hooks/useSharedMainStage";
import { AlertCircle, LogIn, LogOut as LogOutIcon } from "lucide-react";
import MediaControls from "./MediaControls";
import JoinSetup from "./JoinSetup";
import { useKicked } from "../app/hooks/useKicked";
import { useOutputVolume } from "../app/hooks/useOutputVolume";
import PopupMessage from "./ui/PopupMessage";
import type { AudioMode } from "../app/types/sharedStateTypes";
import Play2GetherClientPanel from "./Play2GetherClientPanel";
import { ToastLane, LANE_ORDER } from "./ui/ToastLane";

interface RoomNotification {
  id: string;
  name: string;
  type: "joined" | "left";
}


export default function MainStageParticipant() {
  const room = useContext(RoomContext);
  const tracks = useTracks();
  const state = useSharedState();
  const [joined, setJoined] = useState(false);
  const [notifications, setNotifications] = useState<RoomNotification[]>([]);

  const currentAudioMode: AudioMode = (state.state?.ui?.audioMode as AudioMode) ?? "speech";

  const trackBySid = useMemo(() => new Map(tracks.map((t) => [t.publication.trackSid, t])), [tracks]);
  const tracksSignature = useMemo(() => tracks.map((t) => t.publication.trackSid).join(","), [tracks]);

  const { mainStageVideos, customPositions, layout, pinnedVideo } =
    useSharedMainStage(state, trackBySid, tracksSignature, room);

  const kicked = useKicked(room);

  // Applies the speaker volume chosen on the pre-join screen, and keeps
  // applying it to participants who arrive later — LiveKit's knob is per
  // remote participant, so it is not a one-shot.
  useOutputVolume(room);

  useEffect(() => {
    if (!room) return;
    const push = (p: any, type: "joined" | "left") => {
      if (p.identity?.includes("agent")) return;
      const n: RoomNotification = {
        id: crypto.randomUUID(),
        name: p.name ?? p.identity ?? "Unknown",
        type,
      };
      setNotifications((prev) => [...prev.slice(-4), n]);
      setTimeout(() => setNotifications((prev) => prev.filter((x) => x.id !== n.id)), 4500);
    };
    const onJoined = (p: any) => push(p, "joined");
    const onLeft   = (p: any) => push(p, "left");
    room.on(RoomEvent.ParticipantConnected,    onJoined);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantConnected,    onJoined);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  if (!room) return <div>Conectando...</div>;
  const updatePosition = () => {};

  // A column, not a stage with things floating on top of it. The control bar
  // is a real row of its own height and the stage takes what is left
  // (`flex-1 min-h-0` — without the min-height the grid's aspect-ratio cells
  // push the column taller than the viewport instead of shrinking).
  //
  // `h-viewport`, not `h-screen`: 100vh on a mobile browser is taller than the
  // visible area, which buried the bottom of the stage behind the address bar.
  // `w-full` rather than `w-screen` because 100vw includes the desktop
  // scrollbar gutter.
  return (
    <div className="flex w-full h-viewport flex-col overflow-hidden bg-gray-900 text-white">
      {kicked && (
        <PopupMessage
          message="You have been kicked from the session"
          icon={<AlertCircle className="w-12 h-12" />}
          type="error"
          onClose={() => (window.location.href = "/")}
        />
      )}

      {/* Stage: everything the column has left over. `relative` because the
          Play2Gether overlay and the lyrics banner position against it. */}
      <div className="relative min-h-0 flex-1">
      <MainStage
        className="absolute inset-0"
        displayVideos={mainStageVideos}
        layout={layout}
        pinnedVideo={pinnedVideo}
        customPositions={customPositions}
        updatePosition={updatePosition}
        isHost={false}
      />

      {/* Play2Gether overlay — only visible when a session is active */}
      {joined && <Play2GetherClientPanel />}
      </div>

      {/* Control bar: its own row, so it never covers the stage. It carries
          its own padding and safe-area inset, and `shrink-0` keeps it at full
          height when the stage above is squeezed. */}
      {joined && (
        <MediaControls
          room={room}
          autoPublish={false}
          audioMode={currentAudioMode}
          variant="bar"
        />
      )}

      {/* Join Setup overlay — rendered last so it sits on top of everything */}
      {!joined && (
        <JoinSetup
          room={room}
          audioMode={currentAudioMode}
          onJoined={() => {
            setJoined(true);
            room.startAudio().catch(() => {});
          }}
        />
      )}

      {/* Join / leave notification toasts — rendered into the page's shared
          ToastLane so they queue with the chat and assistant stacks rather
          than overlapping them. */}
      <ToastLane order={LANE_ORDER.presence}>
        {notifications.map((n) => (
          <div
            key={n.id}
            className="flex items-center gap-2.5 px-3 py-2 rounded-xl shadow-lg text-sm font-medium
                       bg-zinc-900/90 backdrop-blur-md border border-white/10 text-white
                       animate-[fadeSlideIn_0.25s_ease_both]"
          >
            {n.type === "joined"
              ? <LogIn      className="w-4 h-4 text-green-400 shrink-0" />
              : <LogOutIcon className="w-4 h-4 text-red-400   shrink-0" />}
            <span className="truncate max-w-[180px]">{n.name}</span>
            <span className={n.type === "joined" ? "text-green-400" : "text-red-400"}>
              {n.type === "joined" ? "joined" : "left"}
            </span>
          </div>
        ))}
      </ToastLane>
    </div>
  );
}
