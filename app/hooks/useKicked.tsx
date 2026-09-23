"use client";

import { useEffect, useState } from "react";
import { Room, RoomEvent } from "livekit-client";

export function useKicked(room: Room | null) {
  const [kicked, setKicked] = useState(false);

  useEffect(() => {
    if (!room) return;

    const handleDisconnected = (reason?: any) => {
      setKicked(true);
    };

    const handleParticipantLeft = (participant: any) => {
      if (participant.identity === room.localParticipant.identity) {
        setKicked(true);
      }
    };

    room.on(RoomEvent.Disconnected,handleDisconnected);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantLeft);

    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnected);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantLeft);
    };
  }, [room]);

  return kicked;
}
