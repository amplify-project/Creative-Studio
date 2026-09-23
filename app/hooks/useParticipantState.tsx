import { useEffect, useState } from "react";
import {
  Track,
  RemoteParticipant,
  LocalParticipant,
  Participant,
  ParticipantEvent,
} from "livekit-client";
import { useRoomContext } from "@livekit/components-react";

export type ParticipantState = {
  id: string;
  name?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  hasVideo: boolean;
  metadata: any;
  hasAudioTrack: boolean;
  lastEvent?: ParticipantEvent;
  isLocal: boolean;
};

export function useParticipantState(
  identity: string,
  onChange?: (state: ParticipantState) => void
) {
  const room = useRoomContext();
  const [state, setState] = useState<ParticipantState | null>(null);

  useEffect(() => {
    if (!room || !identity) return;

    // soporta tanto local como remote
    let participant: Participant | undefined;
    if (room.localParticipant.identity === identity) {
      participant = room.localParticipant;
    } else {
      participant = room.remoteParticipants.get(identity);
    }
    if (!participant) return;

    let unsubTimeout: NodeJS.Timeout;

    const setParticipantState = (
      audioTrack: any,
      videoTrack: any,
      event?: ParticipantEvent
    ) => {
      const newState: ParticipantState = {
        id: participant!.identity,
        name: participant!.identity,
        hasAudioTrack: !!audioTrack,
        isMuted: audioTrack ? audioTrack.isMuted : true,
        isSpeaking: participant!.isSpeaking,
        hasVideo: videoTrack ? videoTrack.isSubscribed && !videoTrack.isMuted : false,
        metadata: participant!.metadata ? JSON.parse(participant!.metadata) : null,
        lastEvent: event,
        isLocal: participant instanceof LocalParticipant,
      };

      setState(newState);
      if (onChange) onChange(newState);
    };

    const updateState = (event?: ParticipantEvent) => {
      const audioTrack = participant!.getTrackPublication(Track.Source.Microphone);
      const videoTrack = participant!.getTrackPublication(Track.Source.Camera);

      if (event === ParticipantEvent.TrackUnsubscribed) {
        clearTimeout(unsubTimeout);
        unsubTimeout = setTimeout(() => {
          const audioTrack1 = participant!.getTrackPublication(Track.Source.Microphone);
          const videoTrack1 = participant!.getTrackPublication(Track.Source.Camera);
          setParticipantState(audioTrack1, videoTrack1, event);
        }, 100);
      } else {
        setParticipantState(audioTrack, videoTrack, event);
      }
    };

    // inicial
    updateState();

    const events: ParticipantEvent[] = [
      ParticipantEvent.TrackMuted,
      ParticipantEvent.TrackUnmuted,
      ParticipantEvent.TrackSubscribed,
      ParticipantEvent.TrackUnsubscribed,
      ParticipantEvent.LocalTrackUnpublished,
      ParticipantEvent.ParticipantMetadataChanged,
      ParticipantEvent.IsSpeakingChanged,
    ];

    const handlers: Record<ParticipantEvent, () => void> = {} as any;
    events.forEach((ev) => {
      handlers[ev] = () => updateState(ev);
      (participant as any).on(ev, handlers[ev]);
    });

    return () => {
      clearTimeout(unsubTimeout);
      events.forEach((ev) => (participant as any).off(ev, handlers[ev]));
    };
  }, [room, identity, onChange]);

  return state;
}
