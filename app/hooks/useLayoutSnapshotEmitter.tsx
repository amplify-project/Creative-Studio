import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { useSharedStateContext } from "./useSharedState"; // ajusta path
import { AgentData } from "../utils/agentData";
import { usePageVisibility } from "./usePageVisibility";

type LayoutSnapshot = {
  ts: number;
  version: number;
  layout?: string;
  entities: Record<
    string,
    {
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      visible?: boolean;
      trackSid?: string;
      participantId?: string;
    }
  >;
  visibility:boolean;
};

const LAYOUT_TOPIC = "layout";

export function useLayoutSnapshotEmitter() {
  const room = useRoomContext();
  const { state } = useSharedStateContext();
  const isVisible  = usePageVisibility()
  // Evita reenviar el mismo version
  const lastVersionRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!room || !state) return;

    const key = `${state.version}-${isVisible}`;

    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;

    const snapshot: LayoutSnapshot = {
      ts: performance.now(), // consistente en frontend
      version: state.version,
      layout: state.ui?.layout,
      entities: {},
      visibility:isVisible
    };

    for (const [id, e] of Object.entries(state.entities ?? {})) {
      snapshot.entities[id] = {
        x: e.layout?.x,
        y: e.layout?.y,
        w: e.layout?.w,
        h: e.layout?.h,
        visible: e.visible,
        trackSid: (e.trackSid as string),
        participantId: e.participantId,
      };
    }

    const agentData = new AgentData(
      "agent_layout",
      "layout_snapshot",
      "update",
      snapshot
    );

    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(agentData.toEvent()),
        {
          reliable: true,
          topic: "cmd",
        }
      );
    } catch (err) {
      console.warn("Failed to publish layout snapshot", err);
    }
  }, [room, state?.version,isVisible]);
}

