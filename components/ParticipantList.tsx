import { useEffect, useRef, useState } from "react";
import { ConnectionQuality, RoomEvent, Track } from "livekit-client";
import { ParticipantTile, VideoTrack } from "@livekit/components-react";
import { DisplayVideo } from "../app/types/displayVideo";
import {
  ZoomIn, Eye, EyeOff, Pin, X, PinOff, Volume2, VolumeX, Mic, MicOff, UserX, Radio,
  Signal, SignalHigh, SignalLow, WifiOff,
} from "lucide-react";

// Short rising two-tone "join" ping (C5 → E5). Lower and warmer than the
// chat ping so the host can distinguish "someone joined" from "new message".
// Web Audio so we don't ship an audio asset; needs a prior user gesture
// (browser autoplay policy) — works the moment the host has clicked anywhere.
function playJoinPing() {
  try {
    const AudioContextClass =
      typeof window !== "undefined"
        ? window.AudioContext || (window as any).webkitAudioContext
        : null;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const tone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };
    tone(523, 0, 0.15);
    tone(659, 0.12, 0.18);
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch { /* ignore — autoplay policy gating */ }
}

const baseOf = (id: string) => id.split("-")[0];

// Subscribes to ConnectionQualityChanged and returns identity → quality.
// Includes the local participant so the host's own quality also surfaces.
function useConnectionQualities(room: any): Record<string, ConnectionQuality> {
  const [qualities, setQualities] = useState<Record<string, ConnectionQuality>>({});

  useEffect(() => {
    if (!room) return;

    // Función limpia para mapear las calidades actuales reales
    const updateAllQualities = () => {
      const m: Record<string, ConnectionQuality> = {};
      
      if (room.localParticipant) {
        m[room.localParticipant.identity] = room.localParticipant.connectionQuality;
      }
      
      room.remoteParticipants?.forEach((p: any) => {
        m[p.identity] = p.connectionQuality;
      });

      setQualities(m);
    };

    // Ejecución inicial
    updateAllQualities();

    // Escuchamos el evento. Livekit pasa el (participant) afectado como primer argumento.
    // Al reutilizar updateAllQualities nos aseguramos de no perder ninguna identidad
    // y forzar a React a renderizar con los datos más frescos del objeto 'room'.
    room.on(RoomEvent.ConnectionQualityChanged, updateAllQualities);
    room.on(RoomEvent.ParticipantConnected, updateAllQualities);
    room.on(RoomEvent.ParticipantDisconnected, updateAllQualities);

    return () => {
      room.off(RoomEvent.ConnectionQualityChanged, updateAllQualities);
      room.off(RoomEvent.ParticipantConnected, updateAllQualities);
      room.off(RoomEvent.ParticipantDisconnected, updateAllQualities);
    };
  }, [room]);

  return qualities;
}

const QUALITY_UI: Record<string, { Icon: any; color: string; label: string }> = {
  excellent: { Icon: SignalHigh, color: "text-green-400",   label: "Excellent" },
  good:      { Icon: Signal,     color: "text-emerald-400", label: "Good" },
  poor:      { Icon: SignalLow,  color: "text-amber-400",   label: "Poor" },
  lost:      { Icon: WifiOff,    color: "text-red-400",     label: "Lost" },
  unknown:   { Icon: Signal,     color: "text-zinc-500",    label: "Unknown" },
};

function QualityIndicator({ quality }: { quality?: ConnectionQuality }) {
  const cfg = QUALITY_UI[(quality as string) ?? "unknown"] ?? QUALITY_UI.unknown;
  const Icon = cfg.Icon;
  return (
    <span title={`Connection: ${cfg.label}`} className="shrink-0">
      <Icon size={14} className={cfg.color} />
    </span>
  );
}

type ParticipantListProps = {
  hostId: string;
  room: any;
  tracksByUser: Record<string, any>;
  zoomedTrackSids: Set<string>;
  mainStageVideos: DisplayVideo[];
  pinnedVideo?: string | null;
  onPinVideo?: (video: string) => void;
  onUnpinVideo?: () => void;
  toggleMute: (video: string) => void;
  onMuteAll: () => void;
  onUnmuteAll: () => void;
  onAddZoom: (userId: string, track: any) => void;
  onRemoveZoom: (userId: string, track: any) => void;
  onAddToMainStage: (video: DisplayVideo) => void;
  onRemoveFromMainStage: (videoKey: string) => void;
  onKickParticipant: (participantId: string) => void;
  mutedTracks: any;
};

export default function ParticipantList({
  hostId,
  room,
  tracksByUser,
  zoomedTrackSids,
  mainStageVideos,
  pinnedVideo,
  onPinVideo,
  onUnpinVideo,
  toggleMute,
  onMuteAll,
  onUnmuteAll,
  onAddZoom,
  onRemoveZoom,
  onAddToMainStage,
  onRemoveFromMainStage,
  onKickParticipant,
  mutedTracks
}: ParticipantListProps) {
  const baseIds = Object.keys(tracksByUser);
  const qualities = useConnectionQualities(room);

  // "Unattended" = participants that joined after the host opened the page
  // (or were here on mount but never added to stage) and the host hasn't
  // acknowledged yet. Drives the amber pulse + NEW badge so the host
  // doesn't miss a quiet join.
  const [unattended, setUnattended] = useState<Set<string>>(new Set());
  // tracksByUser via ref so the ParticipantConnected handler reads its
  // latest value without re-registering the listener on every render.
  const tracksByUserRef = useRef(tracksByUser);
  useEffect(() => { tracksByUserRef.current = tracksByUser; }, [tracksByUser]);

  // On mount, anyone already in the room and not yet on stage is also
  // "unattended" — covers the case where the host opens the page late.
  // Runs once (room change).
  useEffect(() => {
    if (!room) return;
    const initial = new Set<string>();
    room.remoteParticipants?.forEach((p: any) => {
      if (p.identity?.includes?.("agent")) return;
      const base = baseOf(p.identity);
      const alreadyOnStage = mainStageVideos.some(
        (v) => v.participantId === base || v.key === base
      );
      if (!alreadyOnStage) initial.add(base);
    });
    if (initial.size > 0) setUnattended((prev) => new Set([...prev, ...initial]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Listen for new joiners after mount. Filter out:
  //   - LiveKit agents (zoom/shared-state) — internal infra, never user-visible
  //   - Secondary cams of an already-known logical user — same baseId, just
  //     extra equipment, no need to re-flag
  useEffect(() => {
    if (!room) return;
    const onJoin = (p: any) => {
      if (!p?.identity || p.identity.includes("agent")) return;
      const base = baseOf(p.identity);
      if (tracksByUserRef.current[base]) return;
      setUnattended((prev) => (prev.has(base) ? prev : new Set([...prev, base])));
      playJoinPing();
    };
    const onLeave = (p: any) => {
      if (!p?.identity) return;
      const base = baseOf(p.identity);
      setUnattended((prev) => {
        if (!prev.has(base)) return prev;
        const next = new Set(prev);
        next.delete(base);
        return next;
      });
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room]);

  // Clear the unattended flag for anyone the host has added to stage.
  useEffect(() => {
    if (unattended.size === 0) return;
    const onStageBaseIds = new Set<string>();
    mainStageVideos.forEach((v) => {
      const pid = v.participantId ?? v.track?.participant?.identity;
      if (pid) onStageBaseIds.add(baseOf(pid));
    });
    let dirty = false;
    const next = new Set(unattended);
    onStageBaseIds.forEach((id) => {
      if (next.delete(id)) dirty = true;
    });
    if (dirty) setUnattended(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainStageVideos]);

  // Manual acknowledge — any click within a highlighted row clears the
  // flag without requiring stage-add (sometimes the host just wants to
  // dismiss the alert without putting the participant on stage).
  const acknowledge = (base: string) => {
    setUnattended((prev) => {
      if (!prev.has(base)) return prev;
      const next = new Set(prev);
      next.delete(base);
      return next;
    });
  };

  // Auto-scroll the list so a newly-unattended participant lands in view.
  // Without this the amber pulse + NEW badge + ping all happen but the
  // row may be scrolled below the fold of the 80vh container — the host
  // hears the ping but can't see who joined. We scroll only on
  // freshly-added baseIds, not on every re-render of the set.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevUnattendedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newlyAdded = [...unattended].filter((id) => !prevUnattendedRef.current.has(id));
    prevUnattendedRef.current = new Set(unattended);
    if (newlyAdded.length === 0) return;
    // requestAnimationFrame: ensure the row is in the DOM (it was just
    // rendered with the new className) before we ask it to scroll.
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(newlyAdded[0]);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [unattended]);

  return (
    <div className="flex flex-col gap-4 overflow-y-auto pr-2" style={{"maxHeight":"80vh"}}>
      <style>{`
        @keyframes new-pp-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.55); }
          70%  { box-shadow: 0 0 0 8px rgba(251, 191, 36, 0); }
          100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0); }
        }
        .new-pp-pulse {
          animation: new-pp-pulse 1.8s ease-out infinite;
          border-color: rgb(251, 191, 36) !important;
        }
      `}</style>
      {/* GLOBAL AUDIO CONTROLS */}
      <div className="flex gap-2 mb-2">
        <button
          onClick={onMuteAll}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/25 border border-red-500/40 hover:border-red-500/70 text-red-400 hover:text-red-300 transition-all duration-150 text-xs font-semibold tracking-wide"
          title="Mute All"
        >
          <MicOff size={13} />
          Mute All
        </button>
        <button
          onClick={onUnmuteAll}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-green-500/10 hover:bg-green-500/25 border border-green-500/40 hover:border-green-500/70 text-green-400 hover:text-green-300 transition-all duration-150 text-xs font-semibold tracking-wide"
          title="Unmute All"
        >
          <Mic size={13} />
          Unmute All
        </button>
      </div>
      {baseIds.map((baseId) => {
        const videoTracks = tracksByUser[baseId].filter((t: any) => t.publication.kind !== "audio");
        const numCols = videoTracks.length > 2 ? 2 : Math.max(videoTracks.length, 1);
        const isUnattended = unattended.has(baseId);

        return (
          <div
            key={baseId}
            className={`border rounded-lg p-2 bg-zinc-800 ${isUnattended ? "new-pp-pulse" : ""}`}
            onClick={isUnattended ? () => acknowledge(baseId) : undefined}
          >
            <div className="flex items-center gap-2">
              <strong className="text-white flex-1 truncate">
                {room?.getParticipantByIdentity(baseId)?.name ?? baseId}
              </strong>
              {isUnattended && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500 text-black shrink-0 tracking-wider">
                  NEW
                </span>
              )}
              <QualityIndicator quality={qualities[baseId]} />
              {/* Indicador mic: basado en audioTrackPublications del room,
                  independiente de si estamos suscritos o no */}
              <span title={(room?.getParticipantByIdentity(baseId)?.audioTrackPublications?.size ?? 0) > 0 ? "Mic on" : "Mic off"}>
                {(room?.getParticipantByIdentity(baseId)?.audioTrackPublications?.size ?? 0) > 0
                  ? <Mic size={14} className="text-green-400 shrink-0" />
                  : <MicOff size={14} className="text-gray-500 shrink-0" />
                }
              </span>
            </div>
            {baseId !== hostId  && (
              <button
                onClick={() => {
                  const displayName = room?.getParticipantByIdentity(baseId)?.name ?? baseId;
                if (confirm(`Kick ${displayName}?`)) {
                    onKickParticipant(baseId);
                  }
                }}
                className="p-1 rounded bg-red-600/20 text-red-500 hover:bg-red-600/40 transition-colors"
                title="Kick user"
              >
                <UserX size={16} />
              </button>
            )}
            {/* Audio-only participant: no video track published */}
            {tracksByUser[baseId].every((t: any) => t.publication.kind === "audio") && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <Radio size={13} className="text-zinc-400 shrink-0" />
                <span className="text-xs text-zinc-400">Audio only</span>
                {(() => {
                  // Match by key=baseId (audio-only entity) OR participantId=baseId
                  // (video entity that lost its track — state sync keeps the old
                  // trackSid as key but sets participantId on the waveform entry).
                  const stageEntry = mainStageVideos.find(
                    (v) => v.key === baseId || v.participantId === baseId
                  );
                  if (!stageEntry) {
                    return (
                      <button
                        className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs"
                        onClick={() => onAddToMainStage({
                          type: "track",
                          key: baseId,
                          participantId: baseId,
                          component: null,
                          track: null,
                          hasAudio: true,
                          isMuted: false,
                        })}
                        title="Add to stage"
                      >
                        <Eye size={12} /> Add to stage
                      </button>
                    );
                  }
                  const audioMuted = mutedTracks[stageEntry.key] ?? true;
                  return (
                    <>
                      {/* Mute/unmute audio for this participant */}
                      <button
                        className={`p-1 rounded text-white ${audioMuted ? "bg-red-500 hover:bg-red-600" : "bg-green-500 hover:bg-green-600"}`}
                        onClick={() => toggleMute(stageEntry.key)}
                        title={audioMuted ? "Unmute audio" : "Mute audio"}
                      >
                        {audioMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      </button>
                      <button
                        className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-zinc-600 hover:bg-zinc-500 text-white text-xs"
                        onClick={() => onRemoveFromMainStage(stageEntry.key)}
                        title="Remove from stage"
                      >
                        <EyeOff size={12} /> Remove
                      </button>
                    </>
                  );
                })()}
              </div>
            )}

            <div className={`mt-2 grid grid-cols-${numCols} gap-3`}>
              {/* TRACKS NORMALES */}
              {tracksByUser[baseId].map((t: any) => {
                if (t.publication.kind === "audio") return null;

                const trackSid = t.publication.track?.sid!;
                const zoomActive = zoomedTrackSids.has(trackSid);
                // Match by entity key (entity was added with this trackSid as key)
                // OR by the entity's current track sid (when recovery updated the
                // entity's trackSid field but the key stayed as the original sid).
                const onStageActive = mainStageVideos.find(
                  (v) => v.key === trackSid || v.track?.publication?.trackSid === trackSid
                );
                const isPinned = pinnedVideo === trackSid;
                // Mute state and toggle are keyed by the ENTITY id, not the
                // live track sid — after recovery these differ (entity stays
                // at the original key; trackSid field is updated). Reading
                // mutedTracks[trackSid] would always return the default
                // (true / muted) and toggling would create a bogus entity at
                // /entities/<liveSid> via the JSON patch auto-create.
                const stageEntityKey = onStageActive?.key;
                const muted = stageEntityKey ? (mutedTracks[stageEntityKey] ?? true) : true;
                const isScreenShare = t.publication?.source === Track.Source.ScreenShare;
                // "Has no microphone behind it", which is what the mute button
                // below actually cares about. Two ways to be that:
                //
                //  - a video track that isn't the primary camera — a screen
                //    share, or a second camera published from the control
                //    panel, which carries Source.Unknown;
                //  - a whole participant joined from /publish, whose identity
                //    is `<base>-secondary-<rnd>` or `<base>-screen-<rnd>`.
                //
                // The identity test used to be `endsWith("-secondary")`, which
                // stopped matching when PublishClient began appending a random
                // suffix, so the host has been offering a mute button on tracks
                // with no audio. The regex accepts both spellings.
                const isExtraVideo =
                  t.publication?.kind === Track.Kind.Video &&
                  t.publication?.source !== Track.Source.Camera;
                const isSecondary =
                  isExtraVideo ||
                  /-(secondary|screen)(-|$)/.test(t.participant?.identity ?? "");
                return (
                  <div key={trackSid} className="w-full">
                    {/* VIDEO */}
                    <div className="relative w-full aspect-video border rounded overflow-hidden">
                      <VideoTrack
                        trackRef={t}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    </div>

                    {/* BOTONERA FUERA DEL VIDEO */}
                    <div className="mt-2 flex flex-row flex-wrap gap-1 bg-black/20 px-2 py-1 rounded-md">
                      {/* ZOOM */}
                      {!zoomActive ? (
                        <button
                          className="bg-white text-black p-1 rounded"
                          onClick={() => onAddZoom(baseId, t)}
                          title="Zoom"
                        >
                          <ZoomIn size={16} />
                        </button>
                      ) : (
                        <button
                          className="bg-red-500 text-white p-1 rounded"
                          onClick={() => onRemoveZoom(baseId, t)}
                          title="Remove Zoom"
                        >
                          <X size={16} />
                        </button>
                      )}

                      {/* MAIN STAGE */}
                      {!onStageActive ? (
                        <button
                          className="bg-blue-500 text-white p-1 rounded"
                          onClick={() =>
                            onAddToMainStage({
                              type: "track",
                              key: trackSid,
                              component: (
                                <ParticipantTile
                                  trackRef={t}
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "cover",
                                  }}
                                />
                              ),
                              track: t,
                              hasAudio: false,
                              isMuted: true,
                            })
                          }
                          title="Show on Main Stage"
                        >
                          <Eye size={16} />
                        </button>
                      ) : (
                        <button
                          className="bg-gray-500 text-white p-1 rounded"
                          onClick={() => onRemoveFromMainStage(onStageActive.key)}
                          title="Hide from Main Stage"
                        >
                          <EyeOff size={16} />
                        </button>
                      )}

                      {/* PIN */}
                      {onPinVideo && onUnpinVideo && (
                        <button
                          className={`p-1 rounded ${
                            isPinned ? "bg-yellow-500 text-blue-800" : "bg-indigo-500 text-white"
                          }`}
                          onClick={() =>
                            isPinned ? onUnpinVideo() : onPinVideo(trackSid)
                          }
                          title={isPinned ? "Unpin" : "Pin"}
                        >
                          {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
                        </button>
                      )}
                      
                      {/* MUTE/UNMUTE — only when on stage. Off stage there is
                          no entity to mute; clicking would create one. */}
                      {isScreenShare || isSecondary ? (
                        <span className="p-1 rounded bg-gray-700/40 text-gray-500 flex items-center" title="No audio">
                          <VolumeX size={16} />
                        </span>
                      ) : stageEntityKey ? (
                        <button
                          className={`p-1 rounded text-white ${
                            muted ? "bg-red-500 hover:bg-red-600" : "bg-green-500 hover:bg-green-600"
                          }`}
                          onClick={() => toggleMute(stageEntityKey)}
                          title={muted ? "Unmute" : "Mute"}
                        >
                          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}

            </div>
          </div>
        );
      })}
    </div>
  );
}