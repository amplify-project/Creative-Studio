import { useRoomContext } from "@livekit/components-react";
import { useCallback, useEffect, useRef } from "react";
import {
  CMD_TOPIC,
  type CommandRequest,
  type CommandOk,
  type CommandErr,
  type CmdInbound,
} from "../types/controlBusTypes";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: any;
};

type Subscriber = (msg: any) => void;

export type UseCommandBusAPI = {
  sendCommand: (
    name: string,
    args?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ) => Promise<unknown>;

  subscribe: (event: string, handler: Subscriber) => () => void;
};

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useCommandBus(): UseCommandBusAPI {
  const room = useRoomContext();
  const pending = useRef<Map<string, Pending>>(new Map());
  const subs = useRef<Map<string, Set<Subscriber>>>(new Map());

  useEffect(() => {
    if (!room) return;

    const handler = (
      payload: Uint8Array,
      _p: any,
      _kind: number,
      topic?: string
    ) => {
      if (topic !== CMD_TOPIC) return;

      const msg = JSON.parse(new TextDecoder().decode(payload)) as CmdInbound;
      // --- Caso 1: evento broadcast ---
      if (msg.type === "event") {
        const listeners = subs.current.get(msg.name);
        if (listeners) {
          listeners.forEach((fn) => fn(msg.args));
        }
      }
      else 
        // --- Caso 2: respuesta de comando ---
        if ("correlationId" in msg) {
          const entry = pending.current.get(msg.correlationId);
          if (!entry) return;

          if (msg.type === "cmd/ok") {
            clearTimeout(entry.timer);
            entry.resolve((msg as CommandOk).result);
            pending.current.delete(msg.correlationId);
          } else if (msg.type === "cmd/error") {
            clearTimeout(entry.timer);
            const err = msg as CommandErr;
            entry.reject(new Error(err.code + (err.message ? `: ${err.message}` : "")));
            pending.current.delete(msg.correlationId);
          }
          return;
        }

  
    };

    room.on("dataReceived", handler);
    return () => {
      room.off("dataReceived", handler);
    };
  }, [room]);

  // Enviar comando con promesa
  const sendCommand = useCallback(
    (name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
      return new Promise<unknown>((resolve, reject) => {
        if (!room) {
          reject(new Error("room_not_ready"));
          return;
        }
        const corr = uuid();
        const me = room.localParticipant?.identity ?? "unknown";
        const req: CommandRequest = {
          type: "cmd/request",
          correlationId: corr,
          ts: new Date().toISOString(),
          from: { identity: me },
          name,
          args,
        };

        const timer = setTimeout(() => {
          const entry = pending.current.get(corr);
          if (entry) {
            pending.current.delete(corr);
            entry.reject(new Error("timeout"));
          }
        }, opts?.timeoutMs ?? 5000);

        pending.current.set(corr, { resolve, reject, timer });

        room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify(req)),
          { reliable: true, topic: CMD_TOPIC }
        );
      });
    },
    [room]
  );

  // Subscripción a eventos broadcast
  const subscribe = useCallback((event: string, handler: Subscriber) => {
    if (!subs.current.has(event)) subs.current.set(event, new Set());
    subs.current.get(event)!.add(handler);

    return () => {
      subs.current.get(event)?.delete(handler);
    };
  }, []);

  return { sendCommand, subscribe };
}
