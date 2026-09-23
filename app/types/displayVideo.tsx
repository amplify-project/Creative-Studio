export type DisplayVideo = {
  type: "track" | "hand-zoom"; // si es track normal o un HandVideoCrop
  key: string;                  // id único
  component: React.ReactNode;   // el JSX a renderizar
  track: any;
  hasAudio: boolean;
  isMuted: boolean;
  participantId?: string;       // set for audio-only participants (no video trackSid available)
};