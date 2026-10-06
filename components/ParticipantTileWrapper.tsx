import React from "react";
import { ParticipantOverlay, ParticipantOverlayProps } from "./ParticipantOverlay";
import { ParticipantTile } from "@livekit/components-react";
import HandVideoCrop from "./HandVideoCrop";
import AudioWaveBackground from "./AudioWaveBackground";
import IncomingAudioMeter from "./ui/IncomingAudioMeter";

type ParticipantTileWrapperProps = {
  kind: "track" | "hand-zoom";
  userId?: string;
  track: any;
  room?: any; // solo si usas HandVideoCrop
} & ParticipantOverlayProps;

export const ParticipantTileWrapper: React.FC<ParticipantTileWrapperProps> = ({
  kind,
  userId,
  track,
  room,
  isMuted,
  hasVideo,
  isSpeaking,
}) => {
  const isLocal = room?.localParticipant?.identity === userId;
  const participant = room?.getParticipantByIdentity(userId ?? "");
  const isVideoOnly = (participant?.audioTrackPublications?.size ?? 0) === 0;

  let videoComponent: React.ReactNode;
  // No video track at all → render the waveform tile for everyone (remote AND
  // local audio-only). We used to early-return here, which dropped the
  // ParticipantOverlay (mute indicator missing on waveform tiles).
  if (!track) {
    videoComponent = <AudioWaveBackground userId={userId ?? ""} room={room} />;
  } else if (kind === "track") {
    const isScreenShareTrack = track?.publication?.source === "screen_share";
    if (!isLocal && !hasVideo && !isScreenShareTrack) {
      // No video and not a screen share: show audio waveform as the tile content
      videoComponent = <AudioWaveBackground userId={userId ?? ""} room={room} />;
    } else if (!isLocal) {
      videoComponent = (
        <ParticipantTile
          trackRef={track}
          disableSpeakingIndicator={true}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      );
    } else {
      videoComponent = (
        <ParticipantTile
          trackRef={track}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      );
    }
  } else {
    videoComponent = <HandVideoCrop user_id={userId ?? ""} videoTrack={track} room={room} />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {videoComponent}
      <ParticipantOverlay
        isMuted={isMuted}
        hasVideo={hasVideo}
        isSpeaking={isSpeaking}
        showAudioIndicator={!isVideoOnly}
        showVideoIndicator={false}
      />
      {/* Who is making sound — on every tile, so a leaking mic can be spotted
          without muting people one by one. Hidden when their mic is off.
          Top-left: the bottom-left corner is the tile's name label, and the
          top-right is the muted-mic badge. A hand-zoom tile has its swap
          toggle in that corner, so there it drops below it. */}
      <div
        className={`absolute left-1.5 rounded-md bg-black/45 px-1.5 py-1 ${
          kind === "hand-zoom" ? "top-12" : "top-1.5"
        }`}
        style={{ pointerEvents: "none" }}
      >
        <IncomingAudioMeter identity={userId} size="md" />
      </div>
    </div>
  );
};
