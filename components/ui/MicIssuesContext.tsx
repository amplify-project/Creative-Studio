"use client";

/**
 * Who has a mic problem right now, by identity — for the host's mic meters.
 *
 * Owns the one subscription to the `audio/analysis` events the assistant-host
 * analyser broadcasts (~1 per second per audio track, issues already damped by
 * the server's per-issue hold). The event carries a track sid; only the client
 * can say whose it is, so consumers ask by identity.
 *
 * Mounted on /host only. Without it `useMicIssues` returns nothing, so the
 * meters on the participant page stay plain without every call site having to
 * know about roles.
 *
 * Informational only: it colours a meter, it never interrupts anyone.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import type { Participant, TrackPublication } from "livekit-client";
import { useCommandBus } from "../../app/hooks/useCmdBus";

// The analyser emits nothing during silence, so a reading has to expire on its
// own; same window as AudioAnalysisTab.
const STALE_AFTER_MS = 4000;

type AudioAnalysis = { track_id: string; issues?: string[] };
type Entry = { issues: string[]; at: number };

const NONE: readonly string[] = [];
const Ctx = createContext<Map<string, Entry> | null>(null);

function ownerOf(room: any, trackSid: string): Participant | undefined {
  const everyone: Participant[] = [
    room.localParticipant,
    ...Array.from(room.remoteParticipants.values() as Iterable<Participant>),
  ];
  return everyone.find((p) =>
    Array.from(p.audioTrackPublications.values() as Iterable<TrackPublication>).some(
      (pub) => pub.trackSid === trackSid,
    ),
  );
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function MicIssuesProvider({ children }: { children: React.ReactNode }) {
  const room = useRoomContext();
  const { subscribe } = useCommandBus();
  const [byIdentity, setByIdentity] = useState<Map<string, Entry>>(new Map());
  const latest = useRef(byIdentity);
  latest.current = byIdentity;

  useEffect(() => {
    if (!room) return;
    return subscribe("audio/analysis", (args: AudioAnalysis) => {
      if (!args?.track_id) return;
      const who = ownerOf(room, args.track_id);
      if (!who) return;
      const issues = [...(args.issues ?? [])].sort();
      const prev = latest.current.get(who.identity);
      const now = Date.now();
      // Most events change nothing. Only re-render the meters when the
      // picture does; otherwise just refresh the timestamp in place.
      if (prev && same(prev.issues, issues)) {
        prev.at = now;
        return;
      }
      setByIdentity((m) => new Map(m).set(who.identity, { issues, at: now }));
    });
  }, [room, subscribe]);

  // Expire readings that stopped arriving (silence, mute, left the room).
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const m = latest.current;
      const stale = [...m.entries()].filter(
        ([, e]) => e.issues.length > 0 && now - e.at > STALE_AFTER_MS,
      );
      if (stale.length === 0) return;
      setByIdentity((cur) => {
        const next = new Map(cur);
        stale.forEach(([id]) => next.delete(id));
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return <Ctx.Provider value={byIdentity}>{children}</Ctx.Provider>;
}

/** Current mic issues for one participant (e.g. ["clipping"]). Empty outside
 *  the provider, i.e. anywhere but the host page. */
export function useMicIssues(identity: string | undefined): readonly string[] {
  const m = useContext(Ctx);
  if (!m || !identity) return NONE;
  return m.get(identity)?.issues ?? NONE;
}
