# Shared State, Chat, and Command Protocol for LiveKit Agents

This document describes how to use the shared state system, chat, and command channels implemented for LiveKit. It covers both client-side usage (React + LiveKit JS) and server-side implementation (Python agent).

---

## Overview

The system defines **three logical channels** over LiveKit’s data track:

- **`state`** → shared state management (layouts, entities, metadata).
- **`chat`** → append-only chat messages.
- **`cmd`** → request/response command channel.

Each channel is distinguished by its **topic** (LiveKit JS) or **pkt.topic** (LiveKit Python).  
The JSON payloads inside each channel contain a `type` field describing the message kind.

---

## Shared State (`topic: "state"`)

The shared state represents UI layout, entities, and metadata, synchronized across all participants.

### State Shape

```ts
type SharedState = {
  version: number;
  ui: { layout: string; theme?: string; spotlight?: string | null };
  entities: Record<string, {
    kind: string;
    visible?: boolean;
    playback?: { muted?: boolean; paused?: boolean; rate?: number };
    layout?: { x?: number; y?: number; w?: number; h?: number; z?: number };
  }>;
  meta: { updatedBy: string | null; timestamp: number | null };
};
```

### Message Types

- **Request Snapshot**
```json
{ "type": "state/requestSnapshot" }
```

- **Snapshot Response**
```json
{
  "type": "state/snapshot",
  "state": { ...SharedState }
}
```

- **Patch Request**
```json
{
  "type": "state/patch",
  "baseVersion": 3,
  "patch": [
    { "op": "replace", "path": "/ui/layout", "value": "grid" }
  ],
  "meta": { "reason": "teacher changed layout" }
}
```

- **Change Broadcast**
```json
{
  "type": "state/change",
  "fromVersion": 3,
  "toVersion": 4,
  "diff": [{ "op": "replace", "path": "/ui/layout", "value": "custom" }],
  "who": { "identity": "teacher-1", "role": "teacher" },
  "ts": 1699999999999
}
```

- **Change Refused**
```json
{
  "type": "state/changeRefused",
  "reason": "version_conflict",
  "expectedBaseVersion": 3,
  "currentVersion": 5
}
```

### Client API (React Hook)

- `useSharedStateContext()` → access shared state and mutation helpers
- Helpers: `setLayout`, `upsertEntity`, `setEntityLayout`, `setEntityPlayback`, `setEntityVisible`, `removeEntity`
- Automatically requests a snapshot once per connection and updates on `state/change` events.

---

## Chat (`topic: "chat"`)

Simple append-only message bus.

### Message Shape

```json
{
  "type": "chat/message",
  "id": "svr-1699999999999",
  "ts": "2025-09-15T10:00:00Z",
  "from": { "identity": "student-5", "role": "student" },
  "text": "Hello world!",
  "meta": {}
}
```

- Clients send `chat/message` with at least `text`.
- Server stamps `id`, `ts`, `from.role` before rebroadcasting.

### Client API (React Hook)

- `useChatBus()` returns `{ history, sendChat, clear }`.

---

## Commands (`topic: "cmd"`)

Request/response bus with correlation IDs.

### Message Types

- **Request**
```json
{
  "type": "cmd/request",
  "correlationId": "abc-123",
  "ts": "2025-09-15T10:00:00Z",
  "from": { "identity": "teacher-1" },
  "name": "gotoSlide",
  "args": { "page": 7 }
}
```

- **OK Response**
```json
{
  "type": "cmd/ok",
  "correlationId": "abc-123",
  "ts": "2025-09-15T10:00:01Z",
  "result": { "page": 7 }
}
```

- **Error Response**
```json
{
  "type": "cmd/error",
  "correlationId": "abc-123",
  "ts": "2025-09-15T10:00:01Z",
  "code": "forbidden",
  "message": "role student not allowed for gotoSlide"
}
```

### Client API (React Hook)

- `useCommandBus()` returns `{ sendCommand }`
- `sendCommand(name, args, opts)` → Promise resolved with result or rejected with error.

---

## Server Agent (Python)

- Uses `pkt.topic` to route messages.
- Implements three buses:  
  - **SharedStateAgent** → handles patches, snapshots, and broadcasts.  
  - **ChatBus** → validates and re-broadcasts chat messages.  
  - **CommandBus** → routes `cmd/request` to registered handlers, replies with `cmd/ok` or `cmd/error`.

### Example Routing

```python
@room.on("data_received")
def _on_data(pkt: rtc.DataPacket):
    async def _handle():
        msg = json.loads(pkt.data.decode())
        topic = getattr(pkt, "topic", "") or ""
        if topic == "state":
            await state_agent.handle_message(msg, pkt.participant)
        elif topic == "chat":
            await chat_bus.on_chat_message(msg, pkt.participant)
        elif topic == "cmd":
            await cmd_bus.on_cmd_request(msg, pkt.participant)
    asyncio.create_task(_handle())
```

---

## Key Points

- Always publish with explicit `topic`: `"state"`, `"chat"`, `"cmd"`.
- The `type` field inside the JSON indicates the message action.
- Version control on state prevents conflicts (optimistic concurrency).
- Chat is append-only and server-stamped.
- Commands must include `correlationId` to link requests and responses.

---
