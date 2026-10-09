"use client";

import { useEffect, useState } from "react";
import { DisconnectReason, Room, RoomEvent } from "livekit-client";

/**
 * True once the host has removed this participant from the room.
 *
 * Only `PARTICIPANT_REMOVED` counts — the reason LiveKit gives when the
 * server calls `removeParticipant` (api/sessions/kick-participant). Every
 * other disconnect (network drop, reconnect window expired, tab closed, server
 * restart) used to raise "You have been kicked" as well, on top of the page's
 * own connection-lost UI, telling someone whose Wi-Fi blinked that the host
 * threw them out. Those are handled by `onDisconnected` in
 * app/participant/page.tsx.
 *
 * (The old ParticipantDisconnected check for our own identity never fired:
 * LiveKit only emits that event for REMOTE participants.)
 */
export function useKicked(room: Room | null) {
  const [kicked, setKicked] = useState(false);

  useEffect(() => {
    if (!room) return;

    const handleDisconnected = (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) setKicked(true);
    };

    room.on(RoomEvent.Disconnected, handleDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [room]);

  return kicked;
}
