# Shared state — LiveKit data channel protocol

The app maintains one authoritative state document per room, served by the
`shared-state-agent` Python worker. Clients send JSON Patch operations to
mutate it; the agent rebroadcasts diffs to everyone. Includes optimistic
ack handling and snapshot bootstrap.

## File map

| File | Role |
|---|---|
| [app/hooks/useSharedState.tsx](../../app/hooks/useSharedState.tsx) | Client hook: connects to the room's data channel on topic `state`, requests a snapshot on mount, applies incoming diffs, exposes `sendChange` + typed helpers. |
| [app/hooks/useCmdBus.tsx](../../app/hooks/useCmdBus.tsx) | Separate command bus on topic `"cmd"` for events (zoom enable, bbox broadcasts, kick, etc.). Doesn't go through shared state. |
| [server/agents/shareState/agent.py](../../server/agents/shareState/agent.py) | Python worker. Holds the state document, applies patches, enforces role-based write permissions, broadcasts diffs and replies to snapshot requests. |
| [app/types/controlBusTypes.tsx](../../app/types/controlBusTypes.tsx) | Shared types for command bus + state messages (`CmdInbound`, `StateSnapshotMsg`, `StateChangeMsg`, etc.). |

## Topics

- **`state`** — JSON Patch ops + diffs + snapshots. Reliable=true.
  Used by `useSharedState`.
- **`cmd`** — fire-and-forget commands and broadcasts. Reliable=true for
  acknowledgments, reliable=false for high-frequency telemetry (bbox).
  Used by `useCommandBus`.

## State document shape

Roughly:
```ts
type State = {
  version: number;
  entities: Record<string, Entity>;
  ui: {
    layout: "grid" | "custom" | "pin";
    pinnedVideo: string | null;
    audioMode: "music" | "speech";
  };
  // Feature slices attached at the top level:
  play2gether: P2GSharedState;
};

type Entity = {
  kind: "track" | "hand-zoom";
  participantId: string;
  trackSid: string;
  visible: boolean;
  playback: { muted: boolean; paused: boolean; rate: number };
  layout?: { x?: number; y?: number; w?: number; h?: number; z?: number };
};
```

Entity ID conventions:
- Regular video track: entity ID = trackSid (or a custom ID set by the host).
- Hand-zoom: `${participantId}-zoom`.

## `sendChange(patch, meta?)` semantics

```ts
sendChange: (patch: JsonPatchOp[], meta?: Record<string, unknown>) =>
  Promise<"ok" | "refused">
```

- Sends a single patch message to the agent containing the JSON Patch ops
  and the local `baseVersion`.
- Sets a local `awaitingAck` flag.
- Returns `"ok"` if the message went out, `"refused"` if a previous patch
  is still pending ack.
- The agent applies the patch, increments version, broadcasts a `state/change`
  to all clients. When the client receives its OWN change back, it sees
  the new version and clears `awaitingAck`.

### IMPORTANT: silent drops

`sendChange` returns `"refused"` immediately when `awaitingAck` is true,
**without sending the patch**. Most call sites ignore the return value
(plain `sendChange(...)` not `await sendChange(...).then(check)`), so
fast successive operations silently lose the second patch.

Real-world example: clicking "Show on Main Stage" then immediately
clicking "Remove Zoom" → the remove patch is dropped → the zoom entity
stays in shared state → every client keeps showing the zoom.

### Three ways to deal with this

1. **Per-call-site retry** (preferred). Loop with a 1.5 s deadline,
   retrying `removeEntity` until it returns `"ok"`. Used in
   [components/HostContent.tsx](../../components/HostContent.tsx) `removeZoom`.
   Scoped, low-risk, doesn't change global semantics.
2. **Global queue** — make `sendChange` await previous acks before sending
   the next patch. The cleanest architecturally but touches the spine of
   mute/muteAll/layout/playback. The user has explicitly REJECTED this
   refactor due to past regressions on those flows. Don't attempt it
   without explicit go-ahead.
3. **Watchdog reconciliation** — already partially done by
   `useSharedMainStage` (8 s interval that corrects audio subscription
   drift). Could be extended for other invariants but the per-site retry
   pattern is more obvious and easier to debug.

## Helper methods on the hook

```ts
const {
  state, version, sending, sendChange,
  setLayout,            // (layout, pinnedVideo?) → patches ui.layout + ui.pinnedVideo
  setAudioMode,         // (mode) → patches ui.audioMode
  upsertEntity,         // (id, data) → /entities/${id}
  setEntityLayout,      // (id, layout) → /entities/${id}/layout
  setEntityPlayback,    // (id, playback) → /entities/${id}/playback
  setMultiplePlayback,  // (changesById) → batch of /entities/${id}/playback
  setEntityVisible,     // (id, visible) → /entities/${id}/visible
  removeEntity,         // (id) → remove /entities/${id}
} = useSharedState();
```

`patchP2G(partial)` in `usePlay2GetherSession` builds a patch that adds
all the provided keys under `/play2gether/` via `add` ops (which is
JSON Patch's idempotent way to set a path that may or may not exist).

## Role-based write permissions

The agent reads `participant.metadata` (set at token issuance) as
`{ role: "teacher" | "assistant" | "guest" }` and only accepts patches
from `teacher` for protected paths:
- `/entities/*` (creating/modifying/removing entities)
- `/ui/layout`, `/ui/pinnedVideo`, `/ui/audioMode`
- `/play2gether/*`
- Kick commands on the cmd bus

Mapping from app role to agent role lives in
[app/api/token/route.ts](../../app/api/token/route.ts):
- `host` or `teacher` → `"teacher"`
- `assistant` → `"assistant"`
- anything else → `"guest"`

If a write fails permission, the agent responds with
`{ type: "state/changeRefused" }` and the client requests a fresh
snapshot to recover.

## Snapshot bootstrap + diff recovery

On mount, the client sends a snapshot request. The agent replies with the
full state document tagged with the current version. Clients that joined
later still receive ongoing `state/change` events but apply them only
when `change.toVersion > localVersion`.

If a client receives a `state/change` with `toVersion > localVersion + 1`
(it missed an intermediate patch), it requests a fresh snapshot. Pending
changes are buffered and reapplied after snapshot resolves.

## Command bus (`useCommandBus`)

Topic `"cmd"`. Two message kinds:

1. **Event (broadcast)**:
   ```json
   { "type": "event", "name": "zoom",
     "args": { "track_id": "...", "hands": [{ "bbox": [...] }] } }
   ```
   Anyone subscribed to "zoom" via `subscribe("zoom", handler)` receives.
2. **Command/response**:
   ```json
   { "type": "command", "correlationId": "abc",
     "name": "kick", "args": { "identity": "alice" } }
   ```
   The receiver responds with
   `{ "type": "cmd/ok", "correlationId": "abc", "result": ... }` or
   `{ "type": "cmd/error", "correlationId": "abc", "code": "...", "message": "..." }`.
   `sendCommand(name, args)` returns a Promise resolved by the response.

Bbox events from `zoom-agent` go through this bus — `HandVideoCrop`
subscribes via `subscribe("zoom", handler)`.

## Watchdogs

Two reconciliation loops worth knowing:

1. **`useSharedMainStage` audio watchdog** — every 8 s, compares desired
   audio subscription state (from `state.entities[].playback.muted` and
   `.visible`) against actual LiveKit subscriptions. Corrects drift
   silently. Also blocks audio for participants who aren't on stage.
   Catches race conditions where setSubscribed(false) followed by a
   re-publish leaves the new pub auto-subscribed.
2. **Zoom pin watchdog** in [components/HostContent.tsx](../../components/HostContent.tsx).
   Effect listens to `[mainStageVideos, pinnedVideo]`. If `pinnedVideo`
   is set but the entity is no longer in `mainStageVideos` (participant
   left, host removed it), it auto-pins the next available video, or
   falls back to grid if none remain.
