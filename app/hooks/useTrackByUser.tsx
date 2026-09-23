"use client";
import { useTracks, useParticipants } from "@livekit/components-react";
import { useMemo } from "react";

export function useTracksByUser() {
  const tracks = useTracks();
  const participants = useParticipants();

  return useMemo(() => {
    const filteredTracks = tracks.filter(
      (t) => !t.participant.identity.includes("agent")
    );

    const grouped: Record<string, typeof filteredTracks> = {};
    filteredTracks.forEach((t) => {
      const baseId = t.participant.identity.split("-")[0];
      if (!grouped[baseId]) grouped[baseId] = [];
      grouped[baseId].push(t);
    });

    // Ensure every non-agent participant always has an entry even when all
    // their tracks are unsubscribed (e.g. audio-only after video unpublish,
    // where setSubscribed(false) keeps audio out of useTracks results).
    participants.forEach((p) => {
      if (p.identity.includes("agent")) return;
      const baseId = p.identity.split("-")[0];
      if (!grouped[baseId]) grouped[baseId] = [];
    });

    return grouped;
  }, [tracks, participants]);
}
