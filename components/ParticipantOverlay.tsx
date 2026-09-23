import React from "react";
import { FaMicrophoneSlash, FaVideoSlash } from "react-icons/fa";

export type ParticipantOverlayProps = {
  isMuted: boolean;
  hasVideo: boolean;
  isSpeaking: boolean;
  showAudioIndicator?: boolean;
  showVideoIndicator?: boolean;
};

export const ParticipantOverlay: React.FC<ParticipantOverlayProps> = ({
  isMuted,
  hasVideo,
  showAudioIndicator = true,
  showVideoIndicator = true,
}) => {
  const showMic = showAudioIndicator && isMuted;
  const showNoVideo = showVideoIndicator && !hasVideo;

  if (!showMic && !showNoVideo) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 5,
        right: 5,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: "rgba(0,0,0,0.3)",
        padding: "4px",
        borderRadius: 6,
        pointerEvents: "none",
      }}
    >
      {showMic && <FaMicrophoneSlash color="red" size={18} />}
      {showNoVideo && <FaVideoSlash color="red" size={18} />}
    </div>
  );
};
