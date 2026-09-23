# Hand-zoom system — technical reference

A Python LiveKit worker detects singer hands in each subscribed video
track via MediaPipe and broadcasts bounding boxes; clients render the
video into a canvas, animating the crop toward the bbox.

User-facing flow:
- Host sees a "zoom" button per participant in the sidebar.
- Click → host publishes `{ name: "zoom", payload: { command: "enable", track_id } }`
  on the `cmd` data channel.
- Agent receives → spawns `process_video` task for that track.
- Agent emits bbox events per frame; all clients in the room receive them.
- The host can show the zoom view in the main stage (separate entity) or
  use it as a thumbnail. Clicking a thumbnail in pin mode swaps it to
  the pinned slot.

## File map

| File | Role |
|---|---|
| [server/agents/zoom_agent.py](../../server/agents/zoom_agent.py) | Python LiveKit worker. Per-track MediaPipe instance, downsamples to 480p, processes 1/3 frames (~10 fps effective). Emits NORMALIZED `[0, 1]` bbox + explicit `hands: []` when detection lost. |
| [server/agents/agent_data.py](../../server/agents/agent_data.py) | Shared `AgentData` dataclass for cmd-bus protocol. |
| [components/HandVideoCrop.tsx](../../components/HandVideoCrop.tsx) | Client renderer: in-DOM hidden `<video>` (via `track.attach()`) feeds a canvas; the bbox target is eased with frame-rate-independent exponential smoothing. |
| [components/ParticipantTileWrapper.tsx](../../components/ParticipantTileWrapper.tsx) | Routes `kind: "track"` → `<ParticipantTile>`, anything else → `<HandVideoCrop>`. |
| [components/HostContent.tsx](../../components/HostContent.tsx) | `addZoom` / `removeZoom` host methods. Zoom entity stored in shared state with id `${userId}-zoom`, kind `"hand-zoom"`. |

## Coordinate system: NORMALIZED `[0, 1]`

**Critical detail.** LiveKit simulcast + `adaptiveStream: true` mean the
agent and the client receive **different resolutions of the same track**:
the agent (a hidden worker) typically subscribes to the lowest layer
(~320×180); a client in pin mode pulls the highest layer (~1920×1080).

If the agent sent pixel coords from its own 320×180 frame, those numbers
would land in the wrong place when applied to the client's 1080p video.
The original implementation did exactly this and produced "el zoom se
vuelve loco" reports in pin mode while grid worked OK by accident.

Current protocol: the agent always emits bboxes in `[0.0, 1.0]` (4 decimal
precision via `round(float(v), 4)`), and the client scales by its live
`videoWidth/videoHeight` at `drawImage` time. Resolution-independent
end to end — simulcast can switch layers mid-stream and nothing breaks.

Internal client state (`targetBboxRef`, `currentBboxRef`) also lives in
normalized space; conversion to pixels happens only in the draw loop.

## Agent: `zoom_agent.py`

### Worker setup

```python
opts = WorkerOptions(
    entrypoint_fnc=entrypoint,
    permissions=WorkerPermissions(
        can_publish=True,
        can_subscribe=True,
        hidden=True,            # doesn't show up in participant lists
    ),
    agent_name=AGENT_IDENTITY,  # "zoom-agent"
)
```

Named agents do NOT auto-join rooms — see project tour for dispatch flow.

### Entrypoint

Connects with `await ctx.connect()`, attaches the room to a `HandZoomAgent`
instance. Three room event handlers registered:

- `track_subscribed` — store the video track in `agent.video_tracks[pub.sid]`.
- `track_unsubscribed` — cancel any active `process_video` task for that
  track, remove from the dict.
- `data_received` — decode the data packet as `AgentData`, route to
  `agent.handle_message`.

Logs to look for in production:
- `"registered worker"` — worker connected to LiveKit but no dispatch yet.
- `[zoom-agent] entrypoint START` — got a job for some room.
- `Video track saved: <sid>` — saw a remote video track.
- `Enabling video processing for track <sid>` — host enabled zoom for it.
- `Starting video processing` — `process_video` task is running.
- `Task cancelled` / `Video processing ended` — clean shutdown.

### `process_video(track, track_id)`

- Creates a **per-track MediaPipe instance** (`mp.solutions.hands.Hands(...)`).
  The global singleton in earlier versions was not thread-safe — concurrent
  tasks racing through it produced incoherent bboxes.
- `frame_counter % FRAME_DECIMATION` skips frames. Default `FRAME_DECIMATION = 3`
  → ~10 fps at 30 fps source.
- For each kept frame: converts to RGB24 via `frm.convert`, downsamples to
  `MP_SMALL_WIDTH = 480` wide via `cv2.resize` (saves ~5× CPU at 1080p).
  MediaPipe landmarks come back normalized regardless of input resolution.
- Computes bbox of all hand landmarks, applies `HAND_ZOOM_FACTOR = 1.0`
  around the centroid, clamps to `[0, 1]`. (Lowered from 1.5 after the
  client switched to PIP rendering — a tighter crop produces a more
  visible zoom now that it lives in a small corner instead of full tile.)
- Smooths with `BBOX_EMA_ALPHA = 0.35` (modest — the client also smooths,
  this just kills single-frame jitter at the source).
- Emits via `send_hand_info(bbox, track_id)`:
  ```json
  { "type": "event", "name": "zoom",
    "args": { "track_id": "...",
              "hands": [{ "bbox": [x1, y1, x2, y2] }] } }
  ```
  Only the smoothed union bbox is sent. An earlier version also shipped
  per-hand landmark arrays (`lm` field) for a client-side skeleton
  overlay, but it was perceptually desynchronized with the eased crop
  and was reverted.
- When detection is lost AFTER having had one: emits ONE `hands: []` event
  via `send_no_hands` and falls silent until detection returns. The
  `had_detection` flag tracks the edge. Saves data-channel bandwidth and
  the client's hysteresis covers brief MediaPipe glitches.

### `handle_message(msg)`

Two commands recognized for `name == "zoom"`:
- `command: "enable"` with `track_id`: spawn `process_video` task, store
  in `active_tasks[track_id]`, echo the event back over the cmd bus
  (reliable=True) so the client knows the enable was acknowledged.
- `command: "disable"` with `track_id`: cancel the task, remove from dict.

`reliable=False` is used for bbox events (high-frequency, drop-tolerant);
`reliable=True` for the enable echo.

## Client: `HandVideoCrop`

### Why the `<video>` element is full-size in the DOM

LiveKit `adaptiveStream` selects the simulcast layer based on the size of
attached `<video>` elements. An offscreen `<video>` created via
`document.createElement("video")` is invisible to that system:
- Remote viewers saw black canvas (SFU paused the subscription).
- Pin mode pulled only the lowest simulcast layer (~320×180), pixelated.

Current pattern — the `<video>` is always full-size in the layout, even
when visually covered by the zoom canvas in `zoom-main` mode:
```jsx
<video
  ref={videoRef}
  autoPlay playsInline muted
  className="absolute inset-0 w-full h-full object-cover"
  style={{ opacity: isWideMain ? 1 : 0 }}
/>
```

In `wide-main` mode (default) the video is visible and the canvas is the
small PIP. In `zoom-main` mode the canvas covers the tile and the video
sits underneath at `opacity: 0` — still full-size in layout, so adaptive
keeps the high-quality layer.

Connection uses `track.attach(videoEl)` instead of raw `srcObject`:
```ts
if (typeof (track as any).attach === "function") {
  (track as any).attach(videoEl);
} else {
  videoEl.srcObject = new MediaStream([track.mediaStreamTrack]);
}
```

Cleanup calls `track.detach(videoEl)`. Critical for adaptiveStream
bookkeeping.

### Easing model (current values)

| Constant | Value | Meaning |
|---|---|---|
| `HYSTERESIS_MS` | `1500` | After detection is lost, hold the current zoom this long before reacting. Eats single-frame MediaPipe glitches. |
| `ZOOM_IN_TAU_MS` | `600` | Exponential time constant when moving toward a fresh target. |
| `ZOOM_OUT_TAU_MS` | `1200` | Slower easing toward fallback. (Only used in `"zoomout"` lost-detection mode.) |
| `CLIENT_PAD_RATIO` | `0.04` | Extra 4% padding around the agent's bbox — tighter crop for chord/fret visibility. Was 0.10; reduced for music instrument use. |
| `SIZE_SHRINK_RATIO` | `0.50` | Width/height shrink at 1/2 the normal alpha. Faster zoom-in when hands come together for a chord. Was 0.25; raised because it was too slow to zoom in on guitar/accordion chord positions. |
| `SHOW_LOST_INDICATOR_AFTER_MS` | `2000` | After this long without a fresh bbox, fade in the "Waiting for hands…" overlay. |
| `ON_HANDS_LOST` | `"freeze"` | Default behavior after hysteresis: freeze the current zoom forever (until detection returns or host disables). Alternative `"zoomout"` eases back to fullframe. |

Per-frame in `requestAnimationFrame` loop:
1. `dt = time - lastFrameAt`.
2. `alpha = 1 - exp(-dt / tau)` (frame-rate-independent).
3. `interpolateBbox(current, target, alpha)` — eases `cx, cy` at full
   alpha, eases `w, h` at full alpha when growing / `× SIZE_SHRINK_RATIO`
   alpha when shrinking. The center+size representation prevents
   corner-morphing.
4. `snapToAspect(target, canvasRatio / videoRatio)` BEFORE interpolation
   ensures the eased rectangle never passes through intermediate aspect
   ratios (visible as "the image deforming with the movement").
5. Clamp the eased normalized bbox to `[0, 1]` (uniform scale down if it
   exceeds bounds), then convert to pixel `(sx, sy, sw, sh)` via
   `videoWidth/Height` for `drawImage`.

### PIP display + smart corner switching

The zoom is shown as a Picture-in-Picture overlay, not as a fullscreen
crop. Two layout modes, toggled by a "Wide big / Zoom big" button in
the top-left of the tile:

| Mode | Fullscreen | PIP corner |
|---|---|---|
| `wide-main` (default) | Wide unzoomed video | Cropped zoom (small) |
| `zoom-main` | Cropped zoom (full tile) | Wide unzoomed video (small) |

**Smart corner.** Each rAF the draw loop computes the point-to-rectangle
distance from each corner (TL/TR/BL/BR) to the current hand bbox; the
farthest wins. A `PIP_CURRENT_CORNER_BONUS = 1.3` bias toward staying +
`PIP_CORNER_THROTTLE_MS = 500` ms switch throttle prevent flapping at
ambiguous positions. CSS `transition: left/top 0.5s ease-out` animates
the move so the PIP slides between corners instead of jumping.

**Two canvases in `zoom-main`.** The main `canvasRef` paints the cropped
zoom over the full tile (covering the `opacity: 0` video). A second
`wideCanvasRef` (only rendered in zoom-main) paints the full video frame
into the PIP corner each rAF — `drawImage(video, srcX, srcY, srcW, srcH,
0, 0, w, h)` with a cover-crop computed from the canvas / video aspect
so the PIP doesn't squish. In `wide-main` the wide canvas isn't rendered;
the underlying `<video>` is visible directly.

PIP-related constants in `HandVideoCrop.tsx`:
- `PIP_W_FRAC = 0.30` — PIP occupies 30% of tile width
- `PIP_MARGIN_PX = 12`
- `PIP_CORNER_THROTTLE_MS = 500`
- `PIP_CURRENT_CORNER_BONUS = 1.3`

### Lost-detection UI

A small bottom-of-canvas chip:
```jsx
<div className="absolute inset-0 pointer-events-none
                bg-gradient-to-t from-black/60 via-black/10 to-transparent
                flex items-end justify-center pb-6
                transition-opacity duration-500"
     style={{ opacity: handsLost ? 1 : 0 }}>
  <div className="...flex items-center gap-2...">
    <Hand className="text-amber-300" /> <span>Waiting for hands…</span>
  </div>
</div>
```

Driven from the draw loop via a `handsLostRef` to avoid React re-renders on
every animation frame — `setHandsLost` is called only when the boolean flips.

## Host-side state model

The host has two distinct concepts for a "zoom":

1. **Local `zoomVideos` list** in [components/HostContent.tsx](../../components/HostContent.tsx).
   Sidebar entries. Adding a zoom puts a `<HandVideoCrop>` here so the
   host can preview it before deciding to put it on the main stage.
2. **`state.entities[<userId>-zoom]`** in shared state. When the host
   clicks "Show on Main Stage" for a zoom, this entity is created. All
   clients render the zoom as part of their `mainStageVideos`.

`addZoom(userId, track)`:
- Publishes `enable` to the `cmd` bus (agent starts processing).
- Pushes a `DisplayVideo` to local `zoomVideos`.

`removeZoom(userId, track)`:
- Removes from local `zoomVideos` (sidebar updates immediately).
- Calls `removeEntity(userId-zoom)`. **Retries up to 1.5 s** because
  `sendChange` can return `"refused"` when a previous patch is still
  awaiting ack — without retry the zoom entity persists in shared state
  and every client keeps showing it on the main stage. Scoped retry only;
  see `03-shared-state.md`.
- Publishes `disable` to the `cmd` bus.

## Pin-mode interactions

Pin mode has a "primary" video (fullscreen) and a thumbnail strip at the
bottom. The host's pin watchdog handles cases where the pinned video
disappears (participant left, host removed it, deleted zoom): it
automatically pins the next available video in `mainStageVideos`, falling
back to grid only when the stage is empty.

Thumbnails are clickable (when `onPinVideo` prop is provided to MainStage)
— clicking calls `pinVideo(key)` which swaps the pin immediately. The
host's MainStage passes the prop; the participant's MainStage does not
(participants can't drive pin from their side).
