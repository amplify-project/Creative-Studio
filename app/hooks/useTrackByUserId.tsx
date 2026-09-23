import { Track } from "livekit-client";
import { useTracks } from "@livekit/components-react";

export function useVideoTrackByUser(user_id: string) {
  const tracks = useTracks();

  return tracks.find(
    (t) =>
      t.participant.identity === user_id &&
      t.publication.kind === Track.Kind.Video
  )?.publication.track ?? null;
}
