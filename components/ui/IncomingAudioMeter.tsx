"use client";

/**
 * A small live meter of how much sound a participant is SENDING.
 *
 * Field session 2026-09-28: someone's speakers were leaking into their mic and
 * the room heard it, but nothing on screen said whose mic it was — the host
 * found it by muting people one at a time. This shows it at a glance.
 *
 * The level is the SFU's (`participant.audioLevel`, pushed with the active
 * speaker updates), not a local analyser of the received track, for two
 * reasons: it costs nothing per participant (no AudioContext each, which with
 * 15 people is real), and it keeps working when THIS client is not subscribed
 * to that person — the host muting someone on stage unsubscribes them locally,
 * and that is exactly when you want to see whether they are the noise.
 *
 * Nothing is drawn when the participant has no mic published or has it muted:
 * a flat meter there would read as "silent" when it means "not sending".
 */

import { useEffect, useRef, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import { ParticipantEvent, Track, type Participant } from "livekit-client";
import { Mic } from "lucide-react";
import { useMicIssues } from "./MicIssuesContext";

/** Bar thresholds on the SFU level (0–1). The first is the silence floor:
 *  below it the level is room tone, not someone making sound. */
const BARS = [0.02, 0.08, 0.2] as const;
const POLL_MS = 150;

function micIsLive(p: Participant): boolean {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  return !!pub && !pub.isMuted;
}

export function useIncomingAudioLevel(identity: string | undefined): { live: boolean; level: number } {
  // Maybe: the list and tiles are rendered in places a test harness or a
  // future page might mount outside <LiveKitRoom>; no room = no meter.
  const room = useMaybeRoomContext();
  const [state, setState] = useState({ live: false, level: 0 });
  const last = useRef(state);

  useEffect(() => {
    if (!room || !identity) return;
    const find = (): Participant | undefined =>
      room.localParticipant.identity === identity
        ? room.localParticipant
        : room.remoteParticipants.get(identity);

    const tick = () => {
      const p = find();
      const live = !!p && micIsLive(p);
      // Quantised to the bars so React only re-renders when the picture changes.
      const raw = live ? p!.audioLevel ?? 0 : 0;
      const level = BARS.filter((b) => raw >= b).length;
      if (live !== last.current.live || level !== last.current.level) {
        last.current = { live, level };
        setState(last.current);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);

    // Mute/unmute should show immediately, not on the next poll.
    const p = find();
    const events = [ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted,
      ParticipantEvent.TrackPublished, ParticipantEvent.TrackUnpublished];
    events.forEach((e) => p?.on(e as any, tick));
    return () => {
      clearInterval(id);
      events.forEach((e) => p?.off(e as any, tick));
    };
  }, [room, identity]);

  return state;
}

/**
 * A microphone that fills green from the bottom with the level — the way
 * Zoom and Meet show "this person is making sound". The first version was
 * three rising bars, which in testing read as a signal-strength / connection
 * indicator (and in the host's list sat right next to the real one).
 */
export default function IncomingAudioMeter({
  identity,
  className = "",
  size = "sm",
  whenOff = null,
}: {
  identity: string | undefined;
  className?: string;
  size?: "sm" | "md";
  /** Shown instead when the participant has no live mic (e.g. a MicOff icon). */
  whenOff?: React.ReactNode;
}) {
  const { live, level } = useIncomingAudioLevel(identity);
  // Host page only (see MicIssuesContext): red, like a mixing-desk meter, while
  // the analyser hears this mic clipping. Informational — not clickable.
  const clipping = useMicIssues(identity).includes("clipping");
  if (!live) return <>{whenOff}</>;

  const px = size === "md" ? 18 : 14;
  // level is 0..BARS.length; a sliver at the lowest step so any sound shows.
  const fill = level === 0 ? 0 : [0, 40, 70, 100][level];
  const label = clipping
    ? "Mic clipping: their input level is too high"
    : level > 0 ? "Sending sound" : "Mic on, silent";
  return (
    <span
      className={`relative inline-flex shrink-0 ${className}`}
      style={{ width: px, height: px }}
      title={label}
      aria-label={label}
    >
      <Mic size={px} className="absolute inset-0 text-zinc-400" />
      <Mic
        size={px}
        className={`absolute inset-0 transition-[clip-path] duration-100 ${
          clipping ? "text-red-500" : "text-green-400"
        }`}
        style={{ clipPath: `inset(${100 - fill}% 0 0 0)` }}
        strokeWidth={2.75}
      />
    </span>
  );
}
