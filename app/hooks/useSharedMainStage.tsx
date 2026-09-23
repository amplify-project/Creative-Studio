import { useEffect, useMemo, useRef, useState } from "react";
import { RoomEvent, Track } from "livekit-client";
import { shallowArrEq, shallowObjEq, useWhyDidYouUpdate } from "../utils/utils";
import { ParticipantComponent } from "../../components/ParticipantComponent";
import { DisplayVideo } from "../types/displayVideo";
import { SharedStateAPI } from "./useSharedState";
import { logSetSubscribed, muteLog, registerStageDebug, setStageSnapshot } from "../utils/muteDebug";

registerStageDebug();

export type Position = { x: number; y: number; width: number; height: number; z: number };

export function useSharedMainStage(
  sharedAPI: SharedStateAPI,     // ← recibe el API completo en lugar de state suelto
  trackBySid: Map<string, any>,
  tracksSignature: string,
  room: any
) {
  const [mainStageVideos, setMainStageVideos] = useState<DisplayVideo[]>([]);
  const [customPositions, setCustomPositions] = useState<Record<string, Position>>({});
  const [layout, setLayout] = useState<"grid" | "custom" | "pin">("grid");
  const [pinnedVideo, setPinnedVideo] = useState<string | null>(null);

  const subscribedAudio = useRef<Map<string, boolean>>(new Map());
  const prevEntities = useRef<Record<string, any>>({});

  // ✅ Firma estable: solo cambia cuando el contenido relevante cambia de verdad
  const stateSignature = useMemo(() => JSON.stringify({
    entities: sharedAPI.state?.entities,
    ui: sharedAPI.state?.ui,
  }), [sharedAPI.state]);

  // ✅ Refs para leer valores actuales dentro del efecto sin que sean dependencias
  const apiRef = useRef(sharedAPI);
  useEffect(() => { apiRef.current = sharedAPI; }, [sharedAPI]);

  const trackBySidRef = useRef(trackBySid);
  useEffect(() => { trackBySidRef.current = trackBySid; }, [tracksSignature]);

  // Debug: solo activo en desarrollo, eliminar en producción
  useWhyDidYouUpdate("useSharedMainStage", { stateSignature, tracksSignature, room });

  const manageAudioSubscription = (participantId: string, shouldSubscribe: boolean) => {
    const participant = room.getParticipantByIdentity(participantId);
    if (!participant?.audioTrackPublications) return;

    // Siempre aplicar el estado a todas las publicaciones actuales.
    // Sin guard de caché: cuando el track se re-publica (nuevo SID),
    // el nuevo pub se auto-suscribe y necesitamos llamar setSubscribed
    // aunque el caché diga que ya estaba desuscrito.
    participant.audioTrackPublications.forEach((pub: any) => {
      if (!pub.setSubscribed) return;
      logSetSubscribed("manageAudio", participantId, pub.trackSid, shouldSubscribe);
    });

    if (shouldSubscribe) {
      // Small delay to avoid race with a recent setSubscribed(false)
      setTimeout(() => {
        participant.audioTrackPublications.forEach((pub: any) => {
          if (pub.setSubscribed) pub.setSubscribed(true);
        });
      }, 150);
    } else {
      participant.audioTrackPublications.forEach((pub: any) => {
        if (pub.setSubscribed) pub.setSubscribed(false);
      });
    }
    subscribedAudio.current.set(participantId, shouldSubscribe);
  };

  // Listener de TrackSubscribed: cuando LiveKit auto-suscribe un audio track
  // (incluso tras re-publicar por cambio de music/speech mode), bloquearlo
  // inmediatamente según el estado real de entities — no solo el cache.
  useEffect(() => {
    if (!room) return;

    const onTrackSubscribed = (track: any, pub: any, participant: any) => {
      if (track.kind !== Track.Kind.Audio) return;

      // If state is not loaded yet, don't block anything.
      // Blocking here and then calling setSubscribed(true) shortly after (when the
      // snapshot arrives) fails silently: the LiveKit server hasn't finished processing
      // the unsubscribe before we re-subscribe, leaving the track permanently muted.
      // The main effect will call manageAudioSubscription once the snapshot is applied.
      if (!apiRef.current.state) {
        muteLog("TrackSubscribed:audio:noState:skip", { participantId: participant.identity, pubSid: pub.trackSid });
        return;
      }

      const entities = apiRef.current.state.entities ?? {};
      const entry = Object.values(entities).find(
        (e: any) => e.participantId === participant.identity && (e.kind === "track" || e.kind === "hand-zoom")
      ) as any;
      // No entry → participant not on stage → block audio
      const shouldSubscribe = entry
        ? entry.visible && !entry.playback?.muted
        : false;

      muteLog("TrackSubscribed:audio", {
        participantId: participant.identity,
        pubSid: pub.trackSid,
        entryFound: !!entry,
        entryVisible: entry?.visible,
        entryMuted: entry?.playback?.muted,
        shouldSubscribe,
      });

      subscribedAudio.current.set(participant.identity, shouldSubscribe);

      if (!shouldSubscribe && pub.setSubscribed) {
        logSetSubscribed("useSharedMainStage:TrackSubscribed:block", participant.identity, pub.trackSid, false);
        pub.setSubscribed(false);
      }
    };

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => { room.off(RoomEvent.TrackSubscribed, onTrackSubscribed); };
  }, [room]);

  // ✅ El efecto ahora depende de firmas estables, no de objetos que se recrean
  useEffect(() => {
    const api = apiRef.current;
    const trackBySid = trackBySidRef.current;

    if (!api.state || !room) return;

    const currentEntities = api.state?.entities || {};

    // Desuscribirse de participantes que ya no existen
    for (const id of Object.keys(prevEntities.current)) {
      if (!currentEntities[id]) {
        const prevEnt = prevEntities.current[id];
        manageAudioSubscription(prevEnt.participantId, false);
      }
    }

    // Actualizar pinnedVideo solo si cambia
    const sharedPinned = api.state?.ui?.pinnedVideo ?? null;
    if (sharedPinned !== pinnedVideo) {
      setPinnedVideo(sharedPinned);
    }

    // Actualizar layout solo si cambia
    const nextLayout = (api.state?.ui?.layout ?? "grid") as "grid" | "custom" | "pin";
    if (nextLayout !== layout) {
      setLayout(nextLayout);
    }

    const nextMain: DisplayVideo[] = [];
    const nextPos: Record<string, Position> = {};

    for (const [id, entAny] of Object.entries(currentEntities)) {
      const ent = entAny as any;
      const sid: string | undefined = ent.trackSid || id;
      const track = sid ? trackBySid.get(sid) : undefined;
      const participant = room.getParticipantByIdentity(ent.participantId);

      const isAudioController = (ent.kind === "track" || ent.kind === "hand-zoom") && !!ent.participantId;
      if (isAudioController) {
        manageAudioSubscription(
          ent.participantId,
          ent.visible && !ent.playback.muted
        );
      }

      if (!ent?.visible) continue;

      const isMuted = ent.playback.muted;
      const hasAudio = !!(participant?.audioTrackPublications?.size);

      if (!track) {
        if (!ent.participantId) continue;
        if (!participant) continue;

        // Video entity (trackSid !== participantId) without a track in our map:
        // distinguish "still subscribing" (participant has video publications
        // active) from "video was unpublished" (camera turned off). Skip only
        // in the loading case — when unpublished, fall through to the audio
        // waveform so the participant stays visible on stage.
        if (ent.trackSid && ent.trackSid !== ent.participantId) {
          const hasVideoPubs = (participant.videoTrackPublications?.size ?? 0) > 0;
          if (hasVideoPubs) continue;
        }

        nextMain.push({
          type: ent.kind ?? "track",
          key: id,
          participantId: ent.participantId,
          // Wrap in ParticipantComponent so ParticipantOverlay (mute icon,
          // speaking indicator) renders on the waveform tile too. Earlier
          // version pushed <AudioWaveBackground> raw — overlay was missing.
          component: (
            <ParticipantComponent
              key={id}
              kind={ent.kind ?? "track"}
              userId={ent.participantId}
              track={null}
              room={room}
              isMuted={isMuted}
            />
          ),
          track: null,
          hasAudio,
          isMuted,
        });
        const lo = ent.layout || {};
        nextPos[id] = { x: lo.x ?? 0, y: lo.y ?? 0, width: lo.w ?? 200, height: lo.h ?? 150, z: lo.z ?? 10 };
        continue;
      }

      nextMain.push({
        type: ent.kind ?? "track",
        key: id,
        component: (
          <ParticipantComponent
            key={id}
            kind={ent.kind ?? "track"}
            userId={ent.participantId}
            track={track}
            room={room}
            isMuted={isMuted}
          />
        ),
        track,
        hasAudio,
        isMuted
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

    // TrackReference has shape { participant, publication, source } — no
    // top-level .sid. Use the publication.trackSid so the signature actually
    // changes when a track is added or removed (video↔waveform transition).
    const nextKeysTracksAudio = nextMain.map(
      (v) => `${v.key}_${v.track?.publication?.trackSid ?? ""}_${v.hasAudio ? 1 : 0}_${v.isMuted ? 1 : 0}_${v.type ?? ""}`
    );
    const currentKeysTracksAudio = mainStageVideos.map(
      (v) => `${v.key}_${v.track?.publication?.trackSid ?? ""}_${v.hasAudio ? 1 : 0}_${v.isMuted ? 1 : 0}_${v.type ?? ""}`
    );

    if (!shallowArrEq(nextKeysTracksAudio, currentKeysTracksAudio)) {
      setMainStageVideos(nextMain);
    }

    setCustomPositions((prev) => (shallowObjEq(prev, nextPos) ? prev : nextPos));

    // Block audio for remote participants not represented in entities.
    // This runs every time state or tracks change, closing the window between
    // state load and the first watchdog tick (up to 8 s).
    const stageIds = new Set(
      Object.values(currentEntities)
        .filter((e: any) => (e.kind === "track" || e.kind === "hand-zoom") && e.participantId)
        .map((e: any) => e.participantId)
    );
    room.remoteParticipants?.forEach((p: any) => {
      if (stageIds.has(p.identity)) return;
      p.audioTrackPublications?.forEach((pub: any) => {
        if (pub.setSubscribed && pub.isSubscribed) {
          muteLog("mainEffect:blockOffStage", { participantId: p.identity, pubSid: pub.trackSid });
          pub.setSubscribed(false);
          subscribedAudio.current.set(p.identity, false);
        }
      });
    });

    // Keep debug snapshot up to date for window.__stage()
    setStageSnapshot(
      currentEntities,
      Array.from(trackBySid.keys()),
      nextMain.map(v => ({ key: v.key, trackSid: v.track?.sid }))
    );

    prevEntities.current = currentEntities;

  }, [stateSignature, tracksSignature, room]); // ✅ solo 3 dependencias estables

  // Reconciliation watchdog: every 8 s compare desired state (sharedState entities)
  // with actual LiveKit subscription state and correct any drift silently.
  // Covers race conditions and missed events that the main effect cannot catch.
  useEffect(() => {
    if (!room) return;
    const id = setInterval(() => {
      const state = apiRef.current.state;
      if (!state) return;
      const entities = state.entities ?? {};
      // Build set of participantIds that are on stage
      const stageParticipantIds = new Set(
        Object.values(entities)
          .filter((e: any) => (e.kind === "track" || e.kind === "hand-zoom") && e.participantId)
          .map((e: any) => e.participantId)
      );

      // Pass 1: correct drift for on-stage participants
      for (const entAny of Object.values(entities)) {
        const ent = entAny as any;
        if ((ent.kind !== "track" && ent.kind !== "hand-zoom") || !ent.participantId) continue;
        const desired = ent.visible && !ent.playback?.muted;
        const participant = room.getParticipantByIdentity(ent.participantId);
        if (!participant?.audioTrackPublications) continue;
        participant.audioTrackPublications.forEach((pub: any) => {
          if (!pub.setSubscribed) return;
          if (pub.isSubscribed !== desired) {
            muteLog("watchdog:correcting", { participantId: ent.participantId, pubSid: pub.trackSid, desired, actual: pub.isSubscribed });
            pub.setSubscribed(desired);
            subscribedAudio.current.set(ent.participantId, desired);
          }
        });
      }

      // Pass 2: block audio for remote participants NOT on stage
      room.remoteParticipants.forEach((p: any) => {
        if (stageParticipantIds.has(p.identity)) return;
        p.audioTrackPublications.forEach((pub: any) => {
          if (!pub.setSubscribed) return;
          if (pub.isSubscribed) {
            muteLog("watchdog:blockOffStage", { participantId: p.identity, pubSid: pub.trackSid });
            pub.setSubscribed(false);
            subscribedAudio.current.set(p.identity, false);
          }
        });
      });
    }, 8_000);
    return () => clearInterval(id);
  }, [room]);

  const updatePosition = async (
    key: string,
    x: number,
    y: number,
    width?: number,
    height?: number,
    z?: number
  ) => {
    const prev = customPositions[key];
    const next = {
      ...customPositions,
      [key]: {
        x,
        y,
        width: width ?? prev?.width ?? 200,
        height: height ?? prev?.height ?? 150,
        z: z ?? prev?.z ?? 10,
      },
    };
    if (!shallowObjEq(prev, next[key])) setCustomPositions(next);

    if (apiRef.current?.setEntityLayout) {
      await apiRef.current.setEntityLayout(key, {
        x: next[key].x,
        y: next[key].y,
        w: next[key].width,
        h: next[key].height,
        z: next[key].z,
      });
    }
  };

  const bringToFront = (key: string) => {
    const maxZ = Math.max(...Object.values(customPositions).map((p) => p.z ?? 10));
    updatePosition(
      key,
      customPositions[key].x,
      customPositions[key].y,
      customPositions[key].width,
      customPositions[key].height,
      maxZ + 1
    );
  };

  const setLayoutMode = async (mode: "grid" | "custom" | "pin", pinnedVideo?: string) => {
    setLayout(mode);
    if (pinnedVideo) {
      await apiRef.current.setLayout(mode, pinnedVideo);
    } else if (apiRef.current?.setLayout) {
      await apiRef.current.setLayout(mode);
    }
  };

  return {
    mainStageVideos,
    customPositions,
    layout,
    setLayoutMode,
    updatePosition,
    bringToFront,
    pinnedVideo,
    setPinnedVideo,
  };
}