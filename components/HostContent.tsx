"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import ParticipantList from "./ParticipantList";
import MainStage from "./MainStage";
import { useTracksByUser } from "../app/hooks/useTrackByUser";
import { DisplayVideo } from "../app/types/displayVideo";
import { Position } from "../app/types/positionType";
import { ParticipantComponent } from "./ParticipantComponent";
import { LogOut } from "lucide-react";
import MediaControls from "./MediaControls";
import { useSharedStateContext } from "../app/hooks/useSharedState";
import { muteLog } from "../app/utils/muteDebug";
import { shallowArrEq, shallowObjEq } from "../app/utils/utils";
import { AgentData } from "../app/utils/agentData";
import { ChevronLeft, ChevronRight, Video, User, Music, MessageSquare, Music2, LogIn, LogOut as LogOutIcon } from "lucide-react";
import Play2GetherHostPanel from "./Play2GetherHostPanel";
import ParticipantControlPanel from "./ParticipantControlPanel";
import { useControlPanel } from "./ui/ControlPanelContext";
import { Play2GetherLyricsBanner } from "./LyricsOverlay";
import { RoomEvent, Track } from "livekit-client";
import type { AudioMode } from "../app/types/sharedStateTypes";
import { useLayoutSnapshotEmitter } from "../app/hooks/useLayoutSnapshotEmitter";
import { JsonPatchOp } from "../app/types/sharedStateTypes";
import { useOutputVolume } from "../app/hooks/useOutputVolume";

interface RoomNotification {
  id: string;
  name: string;
  type: "joined" | "left";
}

export default function HostContent({ room }: { room: any }) {
  const tracksByUser = useTracksByUser();
  const panel = useControlPanel();
  // The host has no pre-join screen, but still gets the in-session speaker
  // control, and the room holds (calibration silence, result-playback duck)
  // are applied through this — the Play2Gether hook no longer touches
  // participant volumes directly.
  useOutputVolume(room);
  const [zoomedTrackSids, setZoomedTrackSids] = useState<Set<string>>(new Set());
  const [mainStageVideos, setMainStageVideos] = useState<DisplayVideo[]>([]);
  const [customPositions, setCustomPositions] = useState<Record<string, Position>>({});
  const [pinnedVideo, setPinnedVideo] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [roomName, setRoomName] = useState("test");
  const [showP2G, setShowP2G] = useState(false);
  const [notifications, setNotifications] = useState<RoomNotification[]>([]);

  const { state, setLayout, sendChange, removeEntity, setEntityLayout, setEntityPlayback, setMultiplePlayback, setAudioMode } = useSharedStateContext();

  const currentAudioMode: AudioMode = (state?.ui?.audioMode as AudioMode) ?? "speech";
  const toggleAudioMode = () => setAudioMode(currentAudioMode === "music" ? "speech" : "music");


  const pinVideo = async (trackSid: string) => {
    setPinnedVideo(trackSid);

    if (!state?.entities) return;

    // Pin is a PURE LAYOUT change — the per-entity playback state is
    // intentionally untouched. Earlier versions auto-unmuted the pinned
    // participant and force-muted everyone else ("audience focus" mode),
    // but the host could not reason about who was actually audible after
    // pinning, and unpinning didn't restore the prior state. Now the host
    // pins to focus the view; mute toggles stay where they were.
    const patches: JsonPatchOp[] = [
      { op: "replace", path: "/ui/layout", value: "pin" },
      { op: "add", path: "/ui/pinnedVideo", value: trackSid },
    ];

    await sendChange(patches, { reason: "pin" });
  };
  // Pick the next video on stage that we could pin (excluding `excludeKey`,
  // typically the one about to be removed / un-pinned). null when none left.
  const pickNextPin = (excludeKey?: string | null): string | null =>
    mainStageVideos.find((v) => v.key !== excludeKey)?.key ?? null;

  const unpinVideo = () => {
    // Instead of falling back to grid, hop to the next pinnable video.
    // Feels like "switch pin" instead of "leave pin mode" — closer to how
    // viewers use the feature in practice. If nothing else is on stage,
    // there's nothing to pin → grid is the only sane fallback.
    const next = pickNextPin(pinnedVideo);
    if (next) {
      pinVideo(next);
    } else {
      setPinnedVideo(null);
      setLayout("grid");
    }
  };

  // Watchdog: when the currently pinned video disappears from main stage
  // (participant left, host clicked "remove from stage" or deleted a zoom),
  // auto-repin to whatever is left. Without this the layout stays in "pin"
  // mode with an empty pinnedVideo → nothing renders.
  useEffect(() => {
    if (!pinnedVideo) return;
    const stillExists = mainStageVideos.some((v) => v.key === pinnedVideo);
    if (stillExists) return;
    const next = pickNextPin(pinnedVideo);
    if (next) {
      pinVideo(next);
    } else {
      setPinnedVideo(null);
      setLayout("grid");
    }
    // pinVideo / setLayout are stable enough that we intentionally only
    // re-run when the inputs change. pickNextPin reads mainStageVideos
    // directly via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainStageVideos, pinnedVideo]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      setRoomName(params.get("sessionId") || "test");
    }
  }, []);

  // Reconcile the host's LOCAL pin with the source of truth (shared state).
  // The `layout` memo below derives from the local `pinnedVideo`, which the
  // host's own pin/unpin buttons set optimistically — so without this, a skill
  // that writes shared state (stage.pinUser / stage.layoutGrid) changes the
  // participants' view but NOT the host's. We mirror /ui/pinnedVideo into the
  // local state so ANY writer (assistant, peer host) converges here.
  //
  // No feedback loop: we only setState when the value actually differs, so the
  // echo of the host's own optimistic pin (which already wrote the same value
  // to shared state) is a no-op. The local state is now a cache, not a
  // competing source of truth. NOTE: this is the minimal fix — the deeper
  // design debt (host derives layout locally while participants read
  // state.ui.layout directly) is tracked for a later unification into
  // useSharedMainStage.
  const sharedPinned = state?.ui?.pinnedVideo ?? null;
  useEffect(() => {
    setPinnedVideo((cur) => (cur === sharedPinned ? cur : sharedPinned));
  }, [sharedPinned]);

  if (!room) return <div>Conectando...</div>;
  const layout = useMemo<"grid" | "custom" | "pin">(
    () => (pinnedVideo ? "pin" : state?.ui.layout === "custom" ? "custom" : "grid"),
    [pinnedVideo, state?.ui.layout]
  );


  // tracks signature para comparar cambios
  const tracksSignature = useMemo(() => {
    const sids: string[] = [];
    for (const userId of Object.keys(tracksByUser || {})) {
      const arr = tracksByUser[userId] || [];
      for (const t of arr) {
        const sid = t?.publication?.track?.sid;
        if (sid) sids.push(sid);
      }
    }
    sids.sort();
    return sids.join("|");
  }, [tracksByUser]);

  const trackBySid = useMemo(() => {
    const idx = new Map<string, any>();
    for (const userId of Object.keys(tracksByUser || {})) {
      const arr = tracksByUser[userId] || [];
      for (const t of arr) {
        const sid = t?.publication?.track?.sid;
        if (sid) idx.set(sid, t);
      }
    }
    return idx;
  }, [tracksSignature]);
  useLayoutSnapshotEmitter();
  // Ref para leer state actual dentro de event handlers sin re-registrar listeners
  const stateRef = useRef<typeof state>(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // ── Join / leave notifications ───────────────────────────────────────────
  useEffect(() => {
    if (!room) return;
    const push = (p: any, type: "joined" | "left") => {
      const n: RoomNotification = {
        id: crypto.randomUUID(),
        name: p.name ?? p.identity ?? "Unknown",
        type,
      };
      setNotifications((prev) => [...prev.slice(-4), n]); // keep max 5
      setTimeout(() => setNotifications((prev) => prev.filter((x) => x.id !== n.id)), 4500);
    };
    const onJoined = (p: any) => push(p, "joined");
    const onLeft   = (p: any) => push(p, "left");
    room.on(RoomEvent.ParticipantConnected,    onJoined);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantConnected,    onJoined);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  // Auto-cleanup stale/zombie entities when the snapshot first loads or
  // when a participant leaves. Removes:
  //  - entities without participantId (old format, pre-fix)
  //  - entities whose participant is no longer in the room
  useEffect(() => {
    if (!state?.entities || !room) return;
    // Run once per snapshot load, and again when room participants change
    const entities = state.entities;
    const patches: JsonPatchOp[] = [];
    for (const [id, entAny] of Object.entries(entities)) {
      const ent = entAny as any;
      if (!ent.participantId) {
        // Old-format zombie: no participantId
        patches.push({ op: "remove", path: `/entities/${id}` });
      } else if (!room.getParticipantByIdentity(ent.participantId)) {
        // Participant has left the room
        patches.push({ op: "remove", path: `/entities/${id}` });
      }
    }
    if (patches.length > 0) {
      console.info(`[HostContent] cleaning ${patches.length} stale entities`, patches.map(p => p.path));
      sendChange(patches, { reason: "cleanup stale entities" });
    }
  }, [state?.entities, room]);

  // sendChange answers "refused" while a previous patch is still awaiting its
  // ack, and the cleanup patches below fire from room events that routinely
  // land right behind another change. Firing and forgetting leaves the orphan
  // tile on stage for the rest of the session, so keep asking for a moment.
  // The cleanups are `remove` ops, which the patch applier resolves to a
  // `delete` — replaying one that already landed is a no-op.
  const sendChangeInsisting = useMemo(
    () => async (patches: JsonPatchOp[], meta?: Record<string, unknown>) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await sendChange(patches, meta);
        if (res !== "refused") return res;
        await new Promise((r) => setTimeout(r, 150));
      }
      console.warn("[HostContent] patch still refused after retries", meta);
      return "refused";
    },
    [sendChange]
  );

  // Live cleanup on ParticipantDisconnected. The snapshot-based effect above
  // only re-runs when state.entities OR the room reference change — neither
  // happens when a participant simply leaves, so a disconnected user's stage
  // entity would stay orphaned. Worst hit: the secondary camera (phone
  // joined via QR is its own LiveKit participant — when it goes away, its
  // tile is stuck on stage and ParticipantList no longer renders a row to
  // click Remove from). Hook directly into the event so removal is instant.
  useEffect(() => {
    if (!room) return;
    const onParticipantLeft = (p: any) => {
      const entities = stateRef.current?.entities;
      if (!entities) return;
      const patches: JsonPatchOp[] = Object.entries(entities)
        .filter(([, e]: [string, any]) => e?.participantId === p.identity)
        .map(([id]) => ({ op: "remove", path: `/entities/${id}` }));
      if (patches.length > 0) {
        console.info(`[HostContent] removing ${patches.length} entities for departed ${p.identity}`);
        sendChangeInsisting(patches, { reason: `cleanup on disconnect: ${p.identity}` });
      }
    };
    room.on(RoomEvent.ParticipantDisconnected, onParticipantLeft);
    return () => { room.off(RoomEvent.ParticipantDisconnected, onParticipantLeft); };
  }, [room, sendChangeInsisting]);

  // Live cleanup when a participant unpublishes their last track. The
  // secondary camera (phone via QR / desktop "Add phone camera") is its
  // own LiveKit participant — see app/publish/PublishClient.tsx which
  // explicitly calls setMicrophoneEnabled(false) on connect, so the
  // secondary NEVER publishes audio. When its only video track stops,
  // the participant stays connected with 0 publications: ParticipantList
  // drops the row (no tracks to render) and the host has no way to evict
  // the zombie tile.
  //
  // A primary participant keeps their audio publication even when muted,
  // so they never hit 0 → this listener leaves them on stage as a waveform
  // (the desired "camera off but still here" UX).
  //
  // Both events are needed. `RoomEvent.TrackUnpublished` is remote-only; when
  // the host stops their OWN screen share (their button, or the browser's
  // "Stop sharing" bar) only `LocalTrackUnpublished` fires. Without it the
  // entity survived its track, and the recovery pass below then rebound it to
  // the host's camera — the share tile did not disappear, it turned into a
  // second copy of their face.
  useEffect(() => {
    if (!room) return;
    const onTrackUnpublished = (pub: any, p: any) => {
      const entities = stateRef.current?.entities;
      if (!entities) return;

      // Total publications remaining for this participant after the
      // unpublish. `trackPublications` is the union of audio+video Maps.
      const remaining = p?.trackPublications?.size
        ?? ((p?.audioTrackPublications?.size ?? 0) + (p?.videoTrackPublications?.size ?? 0));

      // Nothing left: the participant is audio-and-video silent, so every
      // entity of theirs is dead.
      //
      // Something left, but this particular track is gone: remove only the
      // entity bound to it. This case appeared when extra cameras and screen
      // shares started publishing from the participant's own connection —
      // ending a screen share used to be indistinguishable from "still here
      // with audio", so its tile stayed in shared state for good.
      const deadSid: string | undefined = pub?.trackSid;
      const patches: JsonPatchOp[] = Object.entries(entities)
        .filter(([, e]: [string, any]) => {
          if (e?.participantId !== p.identity) return false;
          return remaining === 0 || (!!deadSid && e?.trackSid === deadSid);
        })
        .map(([id]) => ({ op: "remove", path: `/entities/${id}` }));

      if (patches.length > 0) {
        console.info(`[HostContent] removing ${patches.length} entities for ${p.identity} after unpublish`, { deadSid, remaining });
        sendChangeInsisting(patches, { reason: `cleanup on unpublish: ${p.identity}` });
      }
    };
    const onLocalTrackUnpublished = (pub: any) =>
      onTrackUnpublished(pub, room.localParticipant);
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    return () => {
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    };
  }, [room, sendChangeInsisting]);

  // Audio subscription watchdog. The bug we keep seeing on flaky Highland
  // networks: a participant's audio pub shows `isSubscribed: true,
  // isMuted: false` at the LiveKit JS layer, but the underlying WebRTC PC
  // never gets RTP for that track. Happens after a failed resume +
  // fresh-reconnect of the host — the new subscriber PC is created but
  // some previously-subscribed tracks don't actually wire up downstream.
  //
  // Detection: every 5 s, walk subscribed/unmuted audio pubs, get the
  // current packetsReceived from the subscriber PC. If a pub has had no
  // new packets for 10 s, force a re-subscribe (setSubscribed(false) →
  // setSubscribed(true) after 250 ms). Cap at 3 retries per pub to avoid
  // ping-ponging when the publisher is genuinely silent or absent.
  //
  // This is the same mitigation Jitsi's RTCStatsCollector, the LiveKit
  // mobile SDK and Discord's audio stack all implement — selective
  // forwarding architectures are inherently fragile across reconnects;
  // the cure is client-side stats reconciliation.
  useEffect(() => {
    if (!room) return;
    // Per-trackSid bookkeeping. `lastPackets` is the most recent packets
    // count we saw; `stuckSince` is when packets stopped advancing. Reset
    // each time packets move. `forceCount` caps repeated re-toggles.
    const watch = new Map<string, { lastPackets: number; stuckSince: number; lastForcedAt: number; forceCount: number }>();
    const STUCK_THRESHOLD_MS = 10_000;
    const FORCE_COOLDOWN_MS = 15_000;
    const MAX_FORCES_PER_PUB = 3;

    const tick = async () => {
      const pc = (room.engine as any)?.pcManager?.subscriber?.pc as RTCPeerConnection | undefined;
      if (!pc) return;
      // Build trackId → pub map only for pubs that SHOULD be receiving
      // audio. Unsubscribed/muted pubs don't get RTP by design.
      const trackIdToPub = new Map<string, { pub: any; participantIdentity: string }>();
      for (const p of room.remoteParticipants.values() as any) {
        for (const pub of p.audioTrackPublications?.values?.() ?? []) {
          const msid = pub?.track?.mediaStreamTrack?.id;
          if (msid && pub.isSubscribed && !pub.isMuted) {
            trackIdToPub.set(msid, { pub, participantIdentity: p.identity });
          }
        }
      }
      if (trackIdToPub.size === 0) {
        // Clean up bookkeeping for pubs that are no longer eligible.
        watch.clear();
        return;
      }

      const stats = await pc.getStats().catch(() => null);
      if (!stats) return;
      const now = Date.now();
      const livePubSids = new Set<string>();

      stats.forEach((s: any) => {
        if (s.type !== "inbound-rtp" || s.kind !== "audio" || !s.trackIdentifier) return;
        const info = trackIdToPub.get(s.trackIdentifier);
        if (!info) return;
        const pubSid = info.pub.trackSid as string;
        livePubSids.add(pubSid);
        const packets = typeof s.packetsReceived === "number" ? s.packetsReceived : 0;
        const cur = watch.get(pubSid) ?? { lastPackets: packets, stuckSince: now, lastForcedAt: 0, forceCount: 0 };
        if (packets > cur.lastPackets) {
          // Forward motion — reset the stuck timer.
          cur.lastPackets = packets;
          cur.stuckSince = now;
        }
        watch.set(pubSid, cur);

        const stuckMs = now - cur.stuckSince;
        const sinceForce = now - cur.lastForcedAt;
        if (stuckMs > STUCK_THRESHOLD_MS && sinceForce > FORCE_COOLDOWN_MS && cur.forceCount < MAX_FORCES_PER_PUB) {
          console.warn(
            `[audio watchdog] pub=${pubSid} participant=${info.participantIdentity} stuck at ${packets} packets for ${(stuckMs / 1000).toFixed(1)}s — forcing re-subscribe (attempt ${cur.forceCount + 1}/${MAX_FORCES_PER_PUB})`,
          );
          try {
            info.pub.setSubscribed(false);
            // Brief delay so the SFU sees a clean unsubscribe before we
            // re-add. Without this the toggle is sometimes coalesced into
            // a no-op by the LiveKit signal layer.
            setTimeout(() => {
              try { info.pub.setSubscribed(true); } catch { /* pub may be gone */ }
            }, 250);
          } catch (e) {
            console.error("[audio watchdog] toggle failed", e);
          }
          cur.lastForcedAt = now;
          cur.forceCount++;
        }
      });

      // Inbound-rtp stat absent for a track we expected = even worse than
      // "stuck"; the receiver isn't even getting a stat block. Treat the
      // same way: if we'd already seen this pub before (was in watch) and
      // now there's no entry at all, retry.
      const expected = Array.from(trackIdToPub.values()).map((v) => v.pub.trackSid as string);
      for (const expectedSid of expected) {
        if (livePubSids.has(expectedSid)) continue;
        const info = Array.from(trackIdToPub.values()).find((v) => v.pub.trackSid === expectedSid);
        if (!info) continue;
        const cur = watch.get(expectedSid) ?? { lastPackets: 0, stuckSince: now, lastForcedAt: 0, forceCount: 0 };
        watch.set(expectedSid, cur);
        const stuckMs = now - cur.stuckSince;
        const sinceForce = now - cur.lastForcedAt;
        if (stuckMs > STUCK_THRESHOLD_MS && sinceForce > FORCE_COOLDOWN_MS && cur.forceCount < MAX_FORCES_PER_PUB) {
          console.warn(
            `[audio watchdog] pub=${expectedSid} participant=${info.participantIdentity} has NO inbound-rtp stat for ${(stuckMs / 1000).toFixed(1)}s — forcing re-subscribe (attempt ${cur.forceCount + 1}/${MAX_FORCES_PER_PUB})`,
          );
          try {
            info.pub.setSubscribed(false);
            setTimeout(() => {
              try { info.pub.setSubscribed(true); } catch { /* */ }
            }, 250);
          } catch { /* */ }
          cur.lastForcedAt = now;
          cur.forceCount++;
        }
      }

      // GC entries for pubs that are no longer subscribed (host hid them,
      // participant left, etc). Without this `watch` grows over a long
      // session.
      const eligible = new Set(Array.from(trackIdToPub.values()).map((v) => v.pub.trackSid as string));
      for (const key of Array.from(watch.keys())) {
        if (!eligible.has(key)) watch.delete(key);
      }
    };

    const interval = setInterval(() => { tick().catch(() => {}); }, 5000);
    return () => clearInterval(interval);
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const handleTrackSubscribed = (track: any, pub: any) => {
      // Block audio by default — the main sync effect will enable it if the entity says so
      if (track.kind === Track.Kind.Audio) {
        pub.setSubscribed(false);
      }
    };

    room.on("trackSubscribed", handleTrackSubscribed);

    return () => {
      room.off("trackSubscribed", handleTrackSubscribed);
    };
  }, [room]);

  const mutedByTrackSid = useMemo(() => {
    const result: Record<string, boolean> = {};

    Object.entries(state?.entities || {}).forEach(([trackSid, ent]: any) => {
      // Default: muted = true (Si no está en el estado, asumimos que está "muteado" o inactivo para el host)
      result[trackSid] = ent.playback?.muted ?? true;
    });

    return result;
  }, [state?.entities]);

  const handleToggleMute = (trackSid: string) => {
    const nextMuted = !mutedByTrackSid[trackSid];
    muteLog("host:toggleMute", { trackSid, nextMuted });
    setEntityPlayback(trackSid, { muted: nextMuted });
  };

  const handleMuteAll = async () => {
    if (!state?.entities) return;
    muteLog("host:muteAll", { entityCount: Object.keys(state.entities).length });
    const changes: Record<string, { muted: boolean }> = {};
    Object.entries(state.entities).forEach(([trackSid, ent]: [string, any]) => {
      if (ent.visible) changes[trackSid] = { muted: true };
    });
    if (Object.keys(changes).length > 0) await setMultiplePlayback(changes);
  };

  const handleUnmuteAll = async () => {
    if (!state?.entities) return;
    muteLog("host:unmuteAll", { entityCount: Object.keys(state.entities).length });
    const changes: Record<string, { muted: boolean }> = {};
    Object.entries(state.entities).forEach(([trackSid, ent]: [string, any]) => {
      if (ent.visible) changes[trackSid] = { muted: false };
    });
    if (Object.keys(changes).length > 0) await setMultiplePlayback(changes);
  };
  // ------------------------------------

  // sincronización con sharedState
  useEffect(() => {
    if (!state) return;

    const nextMain: DisplayVideo[] = [];
    const nextPos: Record<string, Position> = {};

    for (const [id, entAny] of Object.entries(state.entities || {})) {
      const ent = entAny as any;
      const participant = room.getParticipantByIdentity(ent.participantId);
      const isLocal = participant === room.localParticipant;

      if (!ent?.visible) {
        if (!isLocal)
          participant?.audioTrackPublications?.forEach(pub => {
            pub.setSubscribed(false);
          });
        continue;
      }

      const sid: string | undefined = ent.trackSid;
      let track = sid ? trackBySid.get(sid) : undefined;

      // Track not found by SID: participant re-published (e.g. music/speech mode change).
      // Find their current video track by identity and update the entity's trackSid.
      // Skip when trackSid === participantId — that marks an intentional audio-only
      // entity; recovering the video track would silently undo the downgrade.
      //
      // "Their current video track" has to mean the same KIND of video track.
      // Any-video-will-do turned a screen share that had just ended into the
      // participant's camera: the tile stayed on stage showing the wrong feed
      // instead of going away. Entities record the source they were added
      // with; the ones that predate that field only recover onto a camera,
      // which is the republish case this recovery was written for.
      //
      // A sid another entity already holds is not a candidate either —
      // rebinding onto it would put the same track on stage twice.
      if (!track && participant && ent.trackSid !== ent.participantId) {
        const wantSource: string = ent.source ?? Track.Source.Camera;
        const takenSids = new Set<string>();
        for (const [otherId, otherAny] of Object.entries(state.entities || {})) {
          const other = otherAny as any;
          if (otherId !== id && other?.trackSid) takenSids.add(other.trackSid);
        }
        for (const [newSid, t] of trackBySid.entries()) {
          if (
            t.participant?.identity === ent.participantId &&
            t.publication?.kind === "video" &&
            (t.publication?.source ?? Track.Source.Camera) === wantSource &&
            !takenSids.has(newSid)
          ) {
            track = t;
            // Patch only the /trackSid subpath — upsertEntity does op:"add"
            // at /entities/{id} which would wipe the entire entity (kind,
            // visible, playback, layout, participantId) and break the render
            // loop, making the participant disappear from stage permanently.
            sendChange(
              [{ op: "add", path: `/entities/${id}/trackSid`, value: newSid }],
              { reason: "track recovery" }
            );
            break;
          }
        }
      }

      // Audio subscription: remote participants only (local hears themselves via MediaControls)
      if (!isLocal && participant?.audioTrackPublications) {
        participant.audioTrackPublications.forEach((pub: any) => {
          const shouldHear = !!ent.visible && ent.playback?.muted === false;
          pub.setSubscribed(shouldHear);
        });
      }

      const hasAudio = !ent.playback?.muted;
      if (!track) {
        // No video track: render audio waveform for both remote and local
        // participants — wrapped in ParticipantComponent so ParticipantOverlay
        // (mute icon, speaking indicator) renders on the waveform tile too.
        if (participant) {
          nextMain.push({
            type: "track",
            key: id,
            component: (
              <ParticipantComponent
                key={id}
                kind="track"
                userId={ent.participantId}
                track={null}
                room={room}
                isMuted={ent.playback?.muted}
              />
            ),
            track: null,
            participantId: ent.participantId,
            hasAudio: !ent.playback?.muted,
            isMuted: ent.playback?.muted ?? false,
          });
          const l = ent.layout || {};
          nextPos[id] = { x: l.x ?? 0, y: l.y ?? 0, width: l.w ?? 200, height: l.h ?? 150, z: l.z ?? 10 };
        }
        continue;
      }

      nextMain.push({
        type: ent.kind ?? "track",
        key: id,
        component: <ParticipantComponent key={id} kind={ent.kind ?? "track"} userId={ent.participantId} track={track} room={room} isMuted={ent.playback?.muted} />,
        track,
        participantId: ent.participantId,
        hasAudio,
        isMuted: ent.playback?.muted ?? true,
      });

      const l = ent.layout || {};
      nextPos[id] = {
        x: l.x ?? 0,
        y: l.y ?? 0,
        width: l.w ?? 200,
        height: l.h ?? 150,
        z: l.z ?? 10,
      };
    }

    // Force-unsubscribe audio for remote participants that have NO stage
    // entity at all. The for-loop above only touches participants that have
    // an entity in shared state — when `removeEntity()` is called (host
    // "Hide from stage"), the entity disappears completely and the loop
    // simply skips that participant, leaving their previous audio
    // subscription intact. The host kept hearing them.
    //
    // Mirror of the equivalent block in useSharedMainStage. Without this
    // the bug only manifests on the HOST side (participants already had
    // the same block via their hook).
    const stageParticipantIds = new Set(
      Object.values(state.entities || {})
        .filter((e: any) => (e.kind === "track" || e.kind === "hand-zoom") && e.participantId)
        .map((e: any) => e.participantId)
    );
    room.remoteParticipants?.forEach((p: any) => {
      if (stageParticipantIds.has(p.identity)) return;
      p.audioTrackPublications?.forEach((pub: any) => {
        if (pub.setSubscribed && pub.isSubscribed) {
          pub.setSubscribed(false);
        }
      });
    });

    // Include the publication's trackSid so the video↔waveform transition is
    // detected (TrackReference has shape { participant, publication, source }
    // with no top-level .sid — `v.track?.sid` is always undefined and would
    // never change between video and waveform states).
    const nextKeys = nextMain.map((v) => `${v.key}_${v.track?.publication?.trackSid ?? ""}_${v.hasAudio}_${v.type}`);
    const currKeys = mainStageVideos.map((v) => `${v.key}_${v.track?.publication?.trackSid ?? ""}_${v.hasAudio}_${v.type}`);

    if (!shallowArrEq(nextKeys, currKeys)) {
      setMainStageVideos(nextMain);
    }
    if (!shallowObjEq(nextPos, customPositions)) setCustomPositions(nextPos);
  }, [state, trackBySid, tracksSignature, room]);

  // Handlers
  const addToMainStage = async (video: DisplayVideo) => {
    const id = video.key;
    const participantId = video.participantId ?? video.track?.participant?.identity;
    const trackSid = video.track?.publication?.track?.sid;
    // Recorded so the recovery pass in the sync effect can tell a camera from
    // a screen share when the sid goes away — see "Track not found by SID".
    const source: string | undefined = video.track?.publication?.source;
    // If zoom is already active for this track, add it in hand-zoom mode from the start
    const effectiveKind = (trackSid && zoomedTrackSids.has(trackSid)) ? "hand-zoom" : (video.type ?? "track");

    // Build patches atomically: drop the participant's dead entities and add
    // the new one in one sendChange call. Two separate calls would deadlock on
    // awaitingAck.
    const patches: JsonPatchOp[] = [];

    if (participantId && state?.entities) {
      for (const [existingId, ent] of Object.entries(state.entities)) {
        const e = ent as any;
        if (e.participantId !== participantId || existingId === id) continue;

        // Only entities whose track is gone. This used to remove *every* other
        // entity for the participant, which was written to clean up the stale
        // one left behind by a republish (new trackSid, same person) but also
        // enforced one tile per participant as a side effect. That went
        // unnoticed while extra cameras and screen shares joined under their
        // own `-secondary-`/`-screen-` identities; now that they publish from
        // the participant's own connection, it meant adding a screen share
        // silently replaced their camera on the stage.
        //
        // Still removed, and deliberately:
        //   - a stale entity from before a republish — its sid is not live;
        //   - the audio-only placeholder, whose trackSid is the participant
        //     identity rather than a real sid, so it is not live either. A
        //     waveform tile should give way to the camera that just arrived.
        const stillLive = !!(e.trackSid && trackBySid.has(e.trackSid));
        if (!stillLive) {
          patches.push({ op: "remove", path: `/entities/${existingId}` });
        }
      }
    }

    patches.push({
      op: "add",
      path: `/entities/${id}`,
      value: {
        kind: effectiveKind,
        visible: true,
        // Start unmuted regardless of audio/video kind. The host explicitly
        // added this participant to the stage — the implicit intent is "I
        // want to see/hear them". If audio-only users started muted the host
        // would always have to click unmute right after adding.
        playback: { muted: false, paused: false, rate: 1 },
        layout: { z: 10 },
        trackSid,
        source,
        participantId,
      },
    });

    muteLog("host:addToStage", { id, participantId, kind: effectiveKind, removedCount: patches.length - 1 });
    await sendChange(patches, { reason: "add to main stage" });
  };

  const removeSaved = async () => {
    mainStageVideos.forEach((el) => removeEntity(el.key));
  };

  const removeFromMainStage = async (videoKey: string) => {
    muteLog("host:removeFromStage", { videoKey });
    // Hide is a binary toggle: removing the entity also unsubscribes audio
    // (handled by useSharedMainStage's prevEntities tracking). The
    // "participant turned off their own camera but stays on stage as audio"
    // case is handled separately by useSharedMainStage rendering the
    // waveform when the entity is still visible but has no live video track.
    await removeEntity(videoKey);
  };

  // Locate the entity that corresponds to a live track sid. After recovery
  // the entity stays at its original key (the trackSid at creation time)
  // while its trackSid field is updated to the new sid — so a direct lookup
  // by the live sid misses, and the kind patch is silently skipped.
  const findEntityForTrack = (trackSid: string): string | undefined => {
    if (!state?.entities) return undefined;
    return Object.keys(state.entities).find((k) => {
      const e = state.entities[k] as any;
      return k === trackSid || e?.trackSid === trackSid;
    });
  };

  const addZoom = (_userId: string, track: any) => {
    const trackSid = track.publication?.track?.sid;
    if (!trackSid) return;
    if (zoomedTrackSids.has(trackSid)) return;

    const agentData = new AgentData("agent_zoom", "hand_zoom", "enable", { track_id: trackSid });
    room.localParticipant.publishData(new TextEncoder().encode(agentData.toEvent()), { reliable: true, topic: "cmd" });

    setZoomedTrackSids((prev) => { const next = new Set(prev); next.add(trackSid); return next; });

    // Patch only the /kind subpath — upsertEntity does op:"add" at /entities/{id}
    // which would wipe the entire entity (visible, playback, layout, participantId).
    const entityId = findEntityForTrack(trackSid);
    if (entityId) {
      sendChange([{ op: "add", path: `/entities/${entityId}/kind`, value: "hand-zoom" }], { reason: "zoom enable" });
    }
  };

  const removeZoom = (_userId: string, track: any) => {
    const trackSid = track.publication?.track?.sid;
    if (!trackSid) return;

    setZoomedTrackSids((prev) => { const next = new Set(prev); next.delete(trackSid); return next; });

    const agentData = new AgentData("agent_zoom", "hand_zoom", "disable", { track_id: trackSid });
    room.localParticipant.publishData(new TextEncoder().encode(agentData.toEvent()), { reliable: true, topic: "cmd" });

    const entityId = findEntityForTrack(trackSid);
    if (entityId) {
      sendChange([{ op: "add", path: `/entities/${entityId}/kind`, value: "track" }], { reason: "zoom disable" });
    }
  };

  const updatePosition = async (key: string, x: number, y: number, width?: number, height?: number, z?: number) => {
    const next = {
      ...customPositions,
      [key]: {
        x,
        y,
        width: width ?? customPositions[key]?.width ?? 200,
        height: height ?? customPositions[key]?.height ?? 150,
        z: z ?? customPositions[key]?.z ?? 10,
      },
    };
    if (!shallowObjEq(next, customPositions)) setCustomPositions(next);
    await setEntityLayout?.(key, { x, y, w: width, h: height, z });
  };

  const handleSignOut = async () => {
    removeSaved();
    setZoomedTrackSids(new Set());
    setMainStageVideos([]);
    setCustomPositions({});
    window.location.href = "/";
  };

  const onKickParticipant = async (
  livekitIdentity: string
) => {
  await fetch("/api/sessions/kick-participant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: roomName,
      livekitIdentity,
    }),
  });
};
  return (
    <div className="h-screen flex text-white relative" style={{ backgroundColor: "#09090b" }}>
      {/* Botón siempre visible */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="bg-zinc-800 hover:bg-zinc-700 text-white rounded-r-md p-2 shadow-md transition-colors z-50"
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        title="Sidebar open/close"
      >
        {sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
      </button>
      {/* Sidebar */}
      <div
        className={`flex flex-col h-full bg-zinc-900 transition-all duration-300 relative 
    ${sidebarOpen ? "w-72 p-4" : "w-20 p-2"}`}
      >


        {/* Sidebar ABIERTO (siempre montado, solo cambia opacidad) */}
        <div
          className={`
      transition-opacity duration-300 
      ${sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none absolute"}
    `}
        >

          <h2 className="font-bold text-lg mt-2">Participants</h2>

          {/* Play2Gether */}
          <button
            onClick={() => {
              // Open → bring the tab to the front if the column is hidden or
              // on another tab; only a click while it is already showing closes.
              if (showP2G && !(panel.open && panel.tab === "p2g")) panel.openPanel("p2g");
              else setShowP2G((v) => !v);
            }}
            className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg font-medium text-sm transition-colors mb-2 ${
              showP2G ? "bg-indigo-700 hover:bg-indigo-600" : "bg-zinc-700 hover:bg-zinc-600"
            }`}
            title="Play2Gether — synchronized recording session"
          >
            <Music2 className="w-4 h-4" /> Play2Gether
          </button>

          {/* Audio Mode Toggle */}
          <button
            onClick={toggleAudioMode}
            className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg font-medium text-sm transition-colors mb-2 ${
              currentAudioMode === "music"
                ? "bg-purple-600 hover:bg-purple-700"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
            title="Toggle audio mode for all participants"
          >
            {currentAudioMode === "music" ? (
              <><Music className="w-4 h-4" /> Music Mode</>
            ) : (
              <><MessageSquare className="w-4 h-4" /> Speech Mode</>
            )}
          </button>
          <p className="text-xs text-gray-400 mb-2">
            {currentAudioMode === "music"
              ? "No echo/noise filters. Participants need headphones."
              : "Echo cancellation & noise suppression ON for all."}
          </p>

          <ParticipantList
            hostId={room.localParticipant.identity}
            room={room}
            tracksByUser={tracksByUser}
            zoomedTrackSids={zoomedTrackSids}
            mainStageVideos={mainStageVideos}
            pinnedVideo={pinnedVideo}
            onPinVideo={pinVideo}
            onUnpinVideo={unpinVideo}
            toggleMute={handleToggleMute}
            onMuteAll={handleMuteAll}
            onUnmuteAll={handleUnmuteAll}
            onAddZoom={addZoom}
            onRemoveZoom={removeZoom}
            onAddToMainStage={addToMainStage}
            onRemoveFromMainStage={removeFromMainStage}
            onKickParticipant={onKickParticipant}
            mutedTracks={mutedByTrackSid}
          />


        </div>

        {/* Sidebar CERRADO (iconos), también montado */}
        <div
          className={`
      flex flex-col items-center gap-4 mt-6 transition-opacity duration-300 
      ${!sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none absolute"}
    `}
        >
          <div className="w-12 h-12 rounded bg-zinc-700 flex items-center justify-center hover:bg-zinc-600 transition-colors">
            <Video className="w-6 h-6 text-white"  onClick={() => setSidebarOpen(!sidebarOpen)}/>
          </div>
          <div className="w-12 h-12 rounded bg-zinc-700 flex items-center justify-center hover:bg-zinc-600 transition-colors">
            <User className="w-6 h-6 text-white"  onClick={() => setSidebarOpen(!sidebarOpen)}/>
          </div>

          <div className="bg-red-600 w-12 h-12 rounded flex items-center justify-center"  onClick={() => setSidebarOpen(!sidebarOpen)}></div>

        </div>
        <button
          onClick={handleSignOut}
          className="mt-auto bg-red-500 hover:bg-red-600 text-white py-2 rounded-lg font-medium flex items-center justify-center gap-2"
          title="Sign out"
        >
          <LogOut className="w-5 h-5" />

        </button>
      </div>

      {/* Stage column: the stage takes what is left of the height and the
          control bar is a row under it, same as /participant. It used to be a
          floating pill over the video, which is why it had to dim itself.
          `min-w-0` so a wide stage cannot push the sidebar off-screen. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 p-4" style={{ backgroundColor: "#09090b" }}>
          <MainStage
            displayVideos={mainStageVideos}
            layout={layout}
            customPositions={customPositions}
            updatePosition={updatePosition}
            pinnedVideo={pinnedVideo}
            onPinVideo={pinVideo}
            onGoToGrid={() => { setPinnedVideo(null); setLayout("grid"); }}
          />

          {/* Lyrics banner — same one participants see, so the host can follow
              the song to give cues / conduct. Self-gates by phase + lyricsUrl,
              so it stays out of the way when there are no lyrics. It lives
              inside the stage now rather than against the page, so the control
              bar does not sit on top of it. */}
          <Play2GetherLyricsBanner />
        </div>

        <MediaControls
          room={room}
          autoPublish={true}
          audioMode={currentAudioMode}
          telemetryRole="host"
          variant="bar"
        />
      </div>

      {/* Side column: chat, files, audio, utils — and the Play2Gether mixer
          as its "Play" tab while it is open. Docked like the participant's:
          the stage is resized around it instead of the mixer floating over the
          videos the host is there to watch. The mixer is mounted while open
          whichever tab is showing, so switching to the chat keeps its state. */}
      <ParticipantControlPanel
        role="host"
        docked
        play={{
          content: showP2G
            ? <Play2GetherHostPanel embedded onClose={() => setShowP2G(false)} />
            : null,
          active: showP2G,
          wide: true,
        }}
      />

      {/* ── Join / leave notification toasts ── */}
      <div className="fixed top-16 right-4 z-[99990] flex flex-col gap-2 pointer-events-none">
        {notifications.map((n) => (
          <div
            key={n.id}
            className="flex items-center gap-2.5 px-3 py-2 rounded-xl shadow-lg text-sm font-medium
                       bg-zinc-900/90 backdrop-blur-md border border-white/10 text-white
                       animate-[fadeSlideIn_0.25s_ease_both]"
          >
            {n.type === "joined"
              ? <LogIn  className="w-4 h-4 text-green-400 shrink-0" />
              : <LogOutIcon className="w-4 h-4 text-red-400 shrink-0" />}
            <span className="truncate max-w-[180px]">{n.name}</span>
            <span className={n.type === "joined" ? "text-green-400" : "text-red-400"}>
              {n.type === "joined" ? "joined" : "left"}
            </span>
          </div>
        ))}
      </div>

    </div>
  );
}
