import { useParticipantState } from "../app/hooks/useParticipantState";
import { ParticipantTileWrapper } from "./ParticipantTileWrapper";

type ParticipantVideoProps = {
  kind: "track" | "hand-zoom";
  userId?: string;
  track: any;
  room?: any;
  isMuted: boolean;
};

export const ParticipantComponent: React.FC<ParticipantVideoProps> = ({ kind, userId, track, room, isMuted }) => {
  const participantState = useParticipantState(userId ?? "");
  if (!participantState) return null;

  return (
    <ParticipantTileWrapper
      kind={kind}
      userId={userId}
      track={track}
      room={room}
      isMuted={isMuted}
      hasVideo={participantState.hasVideo}
      isSpeaking={participantState.isSpeaking}
    />
  );
};
