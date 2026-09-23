import { useRoomContext } from "@livekit/components-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_TOPIC, type ChatEvent, type ChatInbound, type ChatOutbound } from "../types/controlBusTypes";

export type UseChatBusAPI = {
  history: ChatEvent[];                   // buffer local
  sendChat: (msg: Omit<ChatOutbound, "type">) => Promise<void>;
  clear: () => void;
};

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useChatBus(maxBuffer = 200): UseChatBusAPI {
  const room = useRoomContext();
  const [history, setHistory] = useState<ChatEvent[]>([]);
  const bufRef = useRef<ChatEvent[]>([]);

  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array, participant: any, _kind: number, topic?: string) => {
      if (topic !== CHAT_TOPIC) return;
      const msg = JSON.parse(new TextDecoder().decode(payload)) as ChatInbound;
      if (msg.type !== "chat/message") return;
      const incoming: ChatEvent = msg;
      bufRef.current = [...bufRef.current, incoming].slice(-maxBuffer);
      setHistory(bufRef.current);
    };
    room.on("dataReceived", handler);
    return () => {
        room.off("dataReceived", handler);
    }
  }, [room, maxBuffer]);

  const sendChat = useCallback(
    async (out: Omit<ChatOutbound, "type">) => {
      if (!room) return;
      const me = room.localParticipant?.identity ?? "unknown";
      const event: ChatEvent = {
        type: "chat/message",
        id: uuid(),
        ts: new Date().toISOString(),
        from: { identity: me },
        text: out.text,
        meta: out.meta,
      };
      // local echo (opcional)
      bufRef.current = [...bufRef.current, event].slice(-maxBuffer);
      setHistory(bufRef.current);

      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(event)),
        { reliable: true, topic: CHAT_TOPIC }
      );
    },
    [room, maxBuffer]
  );

  const clear = useCallback(() => {
    bufRef.current = [];
    setHistory([]);
  }, []);

  return { history, sendChat, clear };
}
