// src/controlBus/controlBusTypes.ts
export const CHAT_TOPIC = "chat" as const;
export const CMD_TOPIC  = "cmd"  as const;

export type IsoDate = string; // ISO 8601

export type ChatEvent = {
  type: "chat/message";
  id: string;              // server or client generated
  ts: IsoDate;             // new Date().toISOString()
  from: { identity: string; role?: string };
  text: string;
  // optional metadata (room, thread id, mentions…)
  meta?: Record<string, unknown>;
};

export type ChatInbound = ChatEvent;
export type ChatOutbound = Omit<ChatEvent, "id" | "ts" | "from"> & {
  type: "chat/message";
  meta?: Record<string, unknown>;
};

export type CommandRequest = {
  type: "cmd/request";
  correlationId: string;
  ts: string;
  from: { identity: string };
  name: string;
  args?: Record<string, unknown>;
};

export type CommandOk = {
  type: "cmd/ok";
  correlationId: string;
  result: unknown;
};

export type CommandErr = {
  type: "cmd/error";
  correlationId: string;
  code: string;
  message?: string;
};

// 👇 Añadimos el tipo de evento broadcast
export type CommandEvent = {
  type: "event";
  name: string;
  args: any;
};

// 👇 Y lo incluimos en la unión
export type CmdInbound = CommandRequest | CommandOk | CommandErr | CommandEvent;