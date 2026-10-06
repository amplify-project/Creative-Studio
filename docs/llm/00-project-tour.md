# Project tour — `portable_amp` / Creative Studio

A Next.js + LiveKit web app for remote choral / vocal sessions. The product
was renamed from "Amplify Portable" to "Creative Studio" in a recent commit
but the repo root is still called `portable_amp`.

## Stack

- **Next.js 13+** (App Router) — Node runtime for API routes, React on the
  client. TypeScript everywhere.
- **LiveKit Cloud / self-hosted** for video + audio + data channels.
  Browsers join via `livekit-client` + `@livekit/components-react`.
- **`livekit-server-sdk`** in Next.js API routes for token issuance and
  agent dispatch (`AgentDispatchClient`).
- **Python LiveKit agents** (`livekit.agents`) for workers that connect to
  rooms as participants. Three agents:
  - `shared-state-agent` — authoritative store of room shared state
    (JSON Patch with optimistic ack).
  - `zoom-agent` — MediaPipe Hands detection on subscribed video tracks,
    broadcasts bbox events.
  - `pose-gaze-agent` — data collection (gaze / player testing).
- **`ffmpeg` + `ffprobe`** on the server for audio mixing and reference
  duration probing.
- **`next-auth`** for host authentication (Google OAuth typical).
- **`react-rnd`** for the draggable Play2Gether host panel.
- **`lucide-react`** for icons.

## Top-level layout

```
portable_amp/
├── app/                          Next.js App Router
│   ├── api/                      Server routes
│   │   ├── auth/                 next-auth handlers
│   │   ├── bugs/report/          POST bug report → JSONL ring file
│   │   ├── invite/               magic-link invite flow
│   │   ├── play2gether/          Play2Gether endpoints (see 01-play2gether.md)
│   │   ├── setupAgent/           Bulk dispatch helper used by invite flow
│   │   ├── token/                Token issuance + per-room agent dispatch
│   │   └── sessions/             Space / session CRUD (admin)
│   ├── admin/                    /admin pages (Server Components, requireAdmin)
│   │   ├── page.tsx              Spaces + host management
│   │   ├── bugs/page.tsx         Bug report list (newest first)
│   │   └── bugs/[id]/page.tsx    Bug report detail with collapsible sections
│   ├── host/                     /host page (host control surface)
│   ├── participant/              /participant page (singer-facing)
│   ├── publish/                  /publish page (second-camera mobile flow)
│   ├── spaces/[spaceId]/         /spaces (admin)
│   └── hooks/                    React hooks (see below)
├── components/                   React components
├── server/agents/                Python LiveKit workers
│   ├── shareState/agent.py       shared-state-agent worker
│   ├── zoom_agent.py             zoom-agent worker
│   └── dataCollection/agent_data.py  pose-gaze-agent worker
├── public/                       Static assets + AudioWorklet processor
└── docs/                         Documentation (this folder is the LLM-tuned set)
```

## Page entry points

| Page | File | Renders |
|---|---|---|
| `/host` | [app/host/page.tsx](../../app/host/page.tsx) | `HostContent` wrapped in LiveKit `RoomContext` |
| `/participant` | [app/participant/page.tsx](../../app/participant/page.tsx) | `MainStageParticipant` wrapped in `RoomContext` |
| `/publish` | [app/publish/page.tsx](../../app/publish/page.tsx) | `PublishClient` (camera-only publisher for QR/mobile flow) |

Both `/host` and `/participant` enable `simulcast: true` and
`adaptiveStream: true` on the Room — important for the hand-zoom client
because adaptiveStream picks the simulcast layer based on the size of
attached `<video>` elements.

## React hooks worth knowing

| Hook | File | Purpose |
|---|---|---|
| `usePlay2GetherSession` | [app/hooks/usePlay2GetherSession.ts](../../app/hooks/usePlay2GetherSession.ts) | Single source of truth for Play2Gether on the client: shared state slice, phase derivation, AudioWorklet capture, WAV encoding, NTP-lite clock offset, host methods. **Calling it twice in the same React tree spawns two recorders — guard with passive flag or keep the second caller out of the tree.** |
| `useSharedState` | [app/hooks/useSharedState.tsx](../../app/hooks/useSharedState.tsx) | LiveKit shared-state client. Sends JSON Patch operations to `shared-state-agent`, applies snapshots/diffs locally. Exposes `sendChange`, `upsertEntity`, `removeEntity`, `setLayout`, `setEntityPlayback`, etc. See `03-shared-state.md`. |
| `useSharedMainStage` | [app/hooks/useSharedMainStage.tsx](../../app/hooks/useSharedMainStage.tsx) | Reconciles `state.entities` against current LiveKit tracks, builds `mainStageVideos`, manages audio subscriptions, runs an 8s watchdog to correct drift. |
| `useCommandBus` | [app/hooks/useCmdBus.tsx](../../app/hooks/useCmdBus.tsx) | Data channel pub/sub on topic `"cmd"`. Used by host ↔ agents for events like zoom enable / disable, bbox payloads. |
| `useParticipantState` | [app/hooks/useParticipantState.tsx](../../app/hooks/useParticipantState.tsx) | Tracks per-participant `isMuted`, `hasVideo`, `isSpeaking` for overlay rendering. |
| `useKicked` | [app/hooks/useKicked.tsx](../../app/hooks/useKicked.tsx) | Subscribes to kick commands → triggers participant exit. |
| `useChatBus` | [app/hooks/useChatBus.tsx](../../app/hooks/useChatBus.tsx) | LiveKit data channel chat on topic `"chat"`. Ring buffer, local echo, reliable delivery. |
| `useExtraSources` | [app/hooks/useExtraSources.ts](../../app/hooks/useExtraSources.ts) | Screen share + extra cameras published from the participant's own connection. Extra cameras are `Track.Source.Unknown`, there is no limit of one, and state is derived from the live track list rather than React. See `13-video-sources-and-stage-entities.md`. |
| `useMicLevel` | [app/hooks/useMicLevel.ts](../../app/hooks/useMicLevel.ts) | dBFS peak + hold + clip detection for one mic track. Shared by `MicCalibrationPanel` (published track) and `JoinSetup` (pre-join capture) so the two readings cannot drift. |
| `useOutputVolume` | [app/hooks/useOutputVolume.ts](../../app/hooks/useOutputVolume.ts) | Applies the speaker volume chosen before joining. LiveKit's knob is per remote participant, so it re-applies on `ParticipantConnected` and `TrackSubscribed`, not once. |
| `usePublishUrl` | [app/hooks/usePublishUrl.ts](../../app/hooks/usePublishUrl.ts) | The `/publish` QR target, shared by the control bar's add-camera menu and the panel's Utils tab so they cannot point at different rooms. |

## Key React Contexts

- **`RoomContext`** (from `@livekit/components-react`) wraps both `/host`
  and `/participant`. All hooks that talk to LiveKit get the `Room` from
  here.
- **`SharedStateContext`** (custom, in `useSharedState.tsx`) wraps inside
  RoomContext and provides `state`, `sendChange`, etc. to the whole tree.

## Roles and metadata

The token payload embeds a role in `participant.metadata` as JSON:
`{ role: "teacher" | "assistant" | "guest" }`. The Python
shared-state-agent reads this from the participant's metadata and only
accepts patches from `teacher` for protected paths (the `play2gether` key,
layout changes, kick commands, etc.).

App-side mapping (in [app/api/token/route.ts](../../app/api/token/route.ts)):
- App role `host` or `teacher` → agent role `"teacher"`
- App role `assistant` → agent role `"assistant"`
- Anything else → `"guest"`

## Agent dispatch lifecycle

LiveKit "named" agents (`WorkerOptions(agent_name=...)`) don't auto-join
rooms — they need explicit dispatch via the server SDK. The Next.js
backend dispatches them in two places:

1. **[app/api/token/route.ts](../../app/api/token/route.ts)** — every host
   token request runs `ensureAgentInRoom(roomName)`. Iterates
   `ROOM_AGENTS = ["shared-state-agent", "zoom-agent", "pose-gaze-agent"]`,
   lists existing participants + pending dispatches once, and creates
   dispatches for any agent that isn't already covered. Idempotent and
   fire-and-forget (token is returned without waiting for dispatch ack).
2. **[app/api/setupAgent/route.tsx](../../app/api/setupAgent/route.tsx)** —
   bulk dispatcher used by the invite-flow and the admin sessions page.
   Same agent list.

If a host sees `"registered worker"` in the Python logs but never
`[zoom-agent] entrypoint START`, the dispatch wasn't created — usually
because the user joined via a code path that bypasses both endpoints.

## Notable standalone components

| Component | File | Notes |
|---|---|---|
| `ParticipantControlPanel` | [components/ParticipantControlPanel.tsx](../../components/ParticipantControlPanel.tsx) | Sliding side panel used by **both** /host and /participant. Three tabs: **Chat** (full message list, unread badge, Enter-to-send), **React** (6-emoji picker with flying-emoji overlay, LiveKit data channel topic `"reaction"` unreliable), **Utils** (preview of every video stream this user is publishing, QR code for the `/publish` other-device flow, Sign Out — the publish-from-here buttons moved to the control bar). Open/tab state lives in `ControlPanelContext` so the bar can drive it. Edge toggle anchored at `right-0 top-1/2 z-[100001]`, widened to 44px under `sm` — accessible even over JoinSetup. Replaces the old `FloatingChat` + `FloatingReactions` combo. **Docked (2026-09-29):** both pages mount it `docked` from their own layout (`MainStageParticipant`, `HostContent`) as a column in the stage row — the stage is resized, not covered; a band under the stage on phones; a thin strip when closed on sm+. The overlay mode still exists (`docked` false) but nothing uses it. The page fills a **Play** tab via the `play` prop: the participant's `Play2GetherClientPanel` (opens by itself when a session starts, jumps to the front for countdown/take/calibration round), the host's `Play2GetherHostPanel embedded` (opened from the sidebar button; column widens to 420px on that tab). `play.content` is only ever hidden, never unmounted, while given — the participant panel owns the capture hook. |
| `MediaControls` | [components/MediaControls.tsx](../../components/MediaControls.tsx) | The session control strip, in flow at the bottom of both pages (`variant="bar"`; a `"floating"` overlay variant is kept but unused). Six buttons: camera, mic, add-camera (menu: this device or QR), screen share, chat, bug report. Camera and mic toggles read actual room publications, not React state, and scope to `Track.Source.Camera` — with a screen share live, matching on `kind === Video` made the camera button lie. All publishing goes through `runPublishOp`. `degradationPreference: 'maintain-framerate'`. See `13-video-sources-and-stage-entities.md` and `14-ui-shell-and-mobile.md`. |
| `BugReportDialog` | [components/ui/BugReportDialog.tsx](../../components/ui/BugReportDialog.tsx) | Modal that captures full audio/network diagnostic snapshot at the moment of the report. POSTs to `/api/bugs/report`. Captures: muteEvents ring buffer, lkAudio subscriptions, stage state, console errors, network info, LiveKit room snapshot, sessionDuration. |
| `MainStage` | [components/MainStage.tsx](../../components/MainStage.tsx) | Renders grid / pin / custom layouts. Grid uses `gridAutoRows: 'minmax(0, 1fr)'` for consistent video cell heights. Pin mode has a back-to-grid button (`LayoutGrid` icon). |
| `ToastLane` | [components/ui/ToastLane.tsx](../../components/ui/ToastLane.tsx) | One shared fixed column that join/leave, chat and assistant toasts portal into. Replaced three independently positioned `top-4` stacks that overlapped on a phone. Consumers declare only a relative `order`. See `14-ui-shell-and-mobile.md`. |
| `ControlPanelContext` | [components/ui/ControlPanelContext.tsx](../../components/ui/ControlPanelContext.tsx) | Shared open/tab state for `ParticipantControlPanel`, so the control bar's Chat button (a sibling) can open it and carry the unread badge. Falls back to real local state without a provider. |

## Network resilience (host + participant pages)

Both `/host` and `/participant` now include network resilience logic:

- **Reconnect policy**: up to 10 retries, exponential backoff `min(1000 × 2^n, 15000)` ms.
- **Poor connection auto-response** (`ConnectionQualityChanged`):
  - Local camera paused (unpublished) when quality is `Poor` or `Lost`.
  - All remote video tracks unsubscribed (`setSubscribed(false)`) — audio-only mode.
  - Both restored automatically when quality recovers.
- **UI banners**: yellow "Reconnecting…" (covers top), orange "Poor connection" with "Disable camera" button (covers top), full-screen "Connection lost" modal with "Rejoin" (reload) button.
- **State refs**: `autoPausedCameraRef`, `autoPausedRemoteVideoRef` — track what the system auto-paused so it can restore cleanly.
- **`manuallyDisabledCameraRef`** (participant only): when the user explicitly presses "Disable camera" during a poor-connection banner, this ref prevents auto-restore of the camera even when quality improves.
- **JoinSetup** (`components/JoinSetup.tsx`): pre-join screen with camera preview, mic/camera device selector, audio-only toggle ("Join without camera"), and a connection quality indicator banner (`RoomEvent.ConnectionQualityChanged`) so users know about network issues before joining.

## Bug report system

Reports stored at `server/data1/bugs/reports.jsonl` (one JSON per line, appended).

Each report contains: `id`, `receivedAt`, `description`, `participantId`, `roomName`, `timestamp`, `muteEvents`, `lkAudio`, `stageState`, `muteState`, `consoleErrors`, `networkInfo`, `roomSnapshot`, `sessionDuration`, `userAgent`.

`muteDebug.ts` patches `console.error` and installs `error`/`unhandledrejection` listeners into a ring buffer (last 30 errors). `window.__getConsoleErrors()` exposes the buffer.

Admin interface at `/admin/bugs` (Server Component, `requireAdmin`).

## Storage

- Play2Gether sessions live under `/tmp/play2gether/{sessionId}/`
  (`session.json`, `reference.*`, `lyrics.lrc`, `rec_*.wav`, `mix.webm`).
  Ephemeral — production needs persistent storage.
- Session metadata schema: see
  [app/api/play2gether/utils.ts](../../app/api/play2gether/utils.ts).

## Configuration

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` for the server SDK.
- `NEXT_PUBLIC_LIVEKIT_URL` for the client.
- `APP_BASE_URL` used by the invite flow to call `/api/setupAgent`.
- `next-auth` env vars (`NEXTAUTH_URL`, OAuth client secrets).

## Branch model (as of writing)

- `master` — production / stable.
- `develop` — integration. After PR merges, master gets bumped.
- `feature/play2ther` — Play2Gether feature work (huge branch, merged into
  develop via PR).
- `feature/improve_zoom` — hand-zoom improvements (merged via PR #49).
- `feature/play2gether_anyreference` — current iteration, focused on
  Play2Gether enhancements (duration auto, evolving reference, video
  reference). Started from develop after the zoom merge.

Recent commit message style is bracket-prefixed: `[update]:…`, `[fix]:…`,
`[feat]:…`, `[ui]:…`, `[opt]:…`. Match this style when committing.
