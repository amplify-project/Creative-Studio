# Connection resilience and diagnostics

How the app survives flaky home/4G networks (Highland tutors on bursty
links being the canonical case), and how operators figure out what
happened after a complaint. Five subsystems work together:

1. **Connection-log telemetry** — every client emits LiveKit lifecycle
   events to the server. Persisted in Mongo, browsable in `/admin/connections`.
2. **Bug report enrichment** — local/remote audio levels, active device
   labels, per-stream stats baked into the report at submit time.
3. **Audio subscription watchdog** — host detects subscribed-but-no-RTP
   audio pubs and force-re-subscribes.
4. **Quality auto-pause with hysteresis** — camera/remote-video are
   torn down ONLY after sustained Poor/Lost, restored on sustained Good.
5. **Publish-error recovery modal** — when `getUserMedia` / `publishTrack`
   throws, the modal offers a device picker with a retry that bypasses
   virtual drivers.

Each section below explains what it does, what it avoided, and where
the code lives.

## 1. Connection-log telemetry

**Goal**: stop debugging connection complaints by asking the user for a
console screenshot. Capture everything we'd want to know about a
session, persistently.

### Client side

[app/participant/page.tsx](../../app/participant/page.tsx) and
[app/host/page.tsx](../../app/host/page.tsx) both listen for these
LiveKit `RoomEvent`s and POST a JSON line to `/api/connection-log`:

| Event | When it fires | Payload extras |
|---|---|---|
| `connected` | first successful join | LiveKit URL, `navigator.connection` snapshot |
| `connect_failed` | `room.connect()` rejected | error `name`, `message`, `tookMs` |
| `signal_reconnecting` | WebSocket dropped (earlier than `Reconnecting`) | — |
| `reconnecting` | LiveKit started reconnect attempts | — |
| `reconnected` | reconnect succeeded | — |
| `disconnected` | session ended | `reason` (`CLIENT_INITIATED` / `SIGNAL_DISCONNECTED` / `DUPLICATE_IDENTITY` / `SERVER_SHUTDOWN`…) |
| `quality` | local participant crossed the bad↔good boundary | new quality, `bad: bool` |
| `media_devices_error` | `RoomEvent.MediaDevicesError` | `name`, `message` |
| `visibility` | tab hidden/shown | `hidden: bool` |
| `pagehide` | user closed tab / navigated away | — |

Sent via `navigator.sendBeacon` (with `fetch({ keepalive: true })`
fallback). Beacons survive page unload, so even a clean tab close
records its `disconnected` + `pagehide`.

### Server side

[app/api/connection-log/route.ts](../../app/api/connection-log/route.ts)
accepts the beacon, mirrors to `console.info("[connlog] …")` for live
`docker logs … | grep connlog` triage, and persists into Mongo via
Prisma.

### Persistence model

`ConnectionEvent` in
[app/dbbackend/model/schema.prisma](../../app/dbbackend/model/schema.prisma).
Survives `docker compose down` because Mongo's data volume is mapped
to `./data1` on the host. **Not** foreign-keyed to `SessionDomain` on
purpose — `sessionId` can be a dev literal or a stale URL value, and we
don't want a bad client to fail-fast the insert.

Indexes on `(identity, ts)`, `(sessionId, ts)`, and `ts` so the
`/admin/connections` queries don't collection-scan.

### Build script wiring

`package.json` `build` now runs `prisma generate` then `next build`.
`start` runs `prisma db push --skip-generate` then `next start`. The
push has to be at start time, not build time, because Mongo isn't
reachable from the build container — its docker-compose service is on
a different network.

### Operator UI

[app/admin/connections/page.tsx](../../app/admin/connections/page.tsx)
is a paginated table with filter bar (identity, sessionId, event,
reason, time range, "only problems" toggle). Filters live in the URL
so a link to "Evan's events between 16:00 and 16:10" is shareable.

## 2. Bug report enrichment

`/api/bugs/report` already captured stage state, mute event log, and
LiveKit subscription state. Three pieces were added so a report can
diagnose itself without follow-up:

### Local capture level

[components/ui/BugReportDialog.tsx](../../components/ui/BugReportDialog.tsx)
pulls `audioLevel` / `totalAudioEnergy` / `totalSamplesDuration` from
the publisher PC's `media-source` stat (kind=audio) into
`webrtcStats.outboundAudio`.

Why: sustained `audioLevel ≈ 0` on a published, unmuted track is the
diagnostic signature of "wrong mic selected" — the
`Microsoft Teams Audio` virtual driver, OS gain at 0, AGC clamping
hard. Past reports had `packetsSent` climbing without participants
being able to hear; this stat would have caught them in seconds.

Admin detail surfaces it as a red **"silent — wrong mic?"** badge
when level is below `1e-3` in
[app/admin/bugs/[id]/page.tsx](../../app/admin/bugs/%5Bid%5D/page.tsx).

### Per-remote inbound playback level

Same `BugReportDialog` walks remote audio pubs and matches their
`mediaStreamTrack.id` against `inbound-rtp.trackIdentifier` from the
SUBSCRIBER PC stats. Each `audioPubs[j]` gets
`inboundAudioLevel` / `inboundPacketsReceived` / `inboundPacketsLost`.

Three diagnostic states surface in the admin table:

- `level > 0.01` → the remote is audible from this client's seat;
  look elsewhere for the bug.
- `level < 1e-3` with `packetsReceived` advancing → the remote is
  publishing silence (their problem, same class as above).
- `level < 1e-3` with `packetsReceived` not advancing → subscription
  is stuck (audio watchdog should catch this; see §3).

### Active capture devices

`activeInputDevices.microphone` / `.camera` capture the live
`MediaStreamTrack.getSettings()` of the published track: `deviceId`
(truncated), resolved label from `enumerateDevices()`, plus the
constraints actually negotiated (`echoCancellation`,
`noiseSuppression`, `autoGainControl`, `sampleRate`, …).

Admin detail flags virtual devices via a label regex
(`microsoft teams|zoom|discord|loopback|blackhole|soundflower|virtual|krisp|vb-audio`)
with a red "virtual — likely silent" badge, and amber-flags
`autoGainControl=true` because AGC clamping is the second most common
"very quiet" cause.

## 3. Audio subscription watchdog

**The bug**: on a flaky uplink, the host's PeerConnection can lose its
underlying RTC subscription to a remote audio track WITHOUT the LiveKit
JS state knowing. `pub.isSubscribed: true`, `pub.isMuted: false`, but
zero RTP packets ever arrive. Verified in production from a Highland
host's report — the server log showed `could not restart participant`
after a network blip; the fresh reconnect rewired the publisher side
but left subscriptions for already-known tracks broken.

**The watchdog** lives in
[components/HostContent.tsx](../../components/HostContent.tsx). Every
5 s:

1. Walk `room.remoteParticipants` and build a `trackIdentifier → pub`
   map for pubs that SHOULD be receiving audio (`isSubscribed &&
   !isMuted`).
2. `getStats()` on the subscriber PC. For each `inbound-rtp` of
   `kind: audio`, record `packetsReceived`.
3. If `packetsReceived` hasn't advanced for **10 s**, OR if a pub has
   no `inbound-rtp` stat at all for 10 s, force a re-subscribe:
   `pub.setSubscribed(false)` → 250 ms delay → `pub.setSubscribed(true)`.
4. Cap at **3 forced toggles per pub** with **15 s cooldown** between
   attempts. Past that, leave it alone — the publisher is genuinely
   offline / NACK loop / something deeper.

The watchdog ignores pubs where:
- `pub.isSubscribed` is false (host muted this participant via UI →
  `setSubscribed(false)` cascade).
- `pub.isMuted` is true (the publisher muted themselves).

Either signal means "no RTP expected", so stuck=0 is correct, not a
bug.

Logs every fired toggle:
`[audio watchdog] pub=TR_… participant=6a27e4… stuck at N packets for X.Xs — forcing re-subscribe (attempt M/3)`.

**Architectural note**: this is the same mitigation Jitsi's
`RTCStatsCollector`, the LiveKit mobile SDK, and Discord's audio stack
all implement. Selective-forwarding architectures (LiveKit, Jitsi,
mediasoup) are inherently fragile across reconnects — the cure is
client-side stats reconciliation. Server-side audio mixing (Meet, Zoom)
sidesteps this entirely but at the cost of per-participant mute
flexibility, which we need.

## 4. Quality auto-pause with hysteresis

**The bug**: LiveKit re-evaluates `ConnectionQuality` every ~5 s
server-side. In bursty 4G that produces frequent excellent ↔ poor
flapping, and the original `onQualityChanged` handler acted IMMEDIATELY
on every transition — disabling local camera and unsubscribing remote
video on each `poor`, restoring on each `good`. From every other
participant's seat that looked like the host's image appearing and
disappearing on a 5 s cadence.

Two subsequent rounds of feedback refined the cure further:

- Users on excellent connections complained that the amber banner
  flashed momentarily on isolated Poor events (GC pauses, single
  keyframe drops, brief jitter bursts) that never represented real
  degradation. Adding a warn-timer eliminates that.
- Tearing down video after 30 s was actually pessimistic: by then
  LiveKit's own adaptation (bitrate reduction, simulcast layer drop
  720p → 360p → 180p, `maintain-framerate` resolution sacrifice) had
  already absorbed the network problem in the vast majority of cases.
  The user was watching a pixelated but stable video with fluid audio,
  and our auto-pause made it WORSE by going to no video at all. Gating
  the teardown on actual audio packet loss eliminates the false-alarm
  pauses.

**The fix** — three-stage timer state machine plus an audio-loss gate:

```
quality event arrives
  │
  ├── isBad (Poor / Lost)
  │   │
  │   ├── clear goodRecoverTimer
  │   │
  │   ├── arm poorWarnTimer  (5 s)
  │   │     │
  │   │     └─ sustained bad → setPoorConnection(true)   [AMBER BANNER]
  │   │
  │   └── arm poorEscalateTimer (30 s)
  │         │
  │         └─ sustained bad → doPause()
  │              │
  │              ├─ measure audio packetsLost / packetsReceived on subscriber PC
  │              │
  │              ├─ loss < 5%   → LOG "escalation declined" and RETURN
  │              │                (banner stays amber, video stays on at
  │              │                 whatever degraded layer the SFU sends)
  │              │
  │              └─ loss ≥ 5%   → setCameraEnabled(false)
  │                                setSubscribed(false) on every remote video
  │                                setAutoDegraded(true)                  [ORANGE BANNER]
  │
  └── isGood (Good / Excellent)
      │
      ├── clear poorWarnTimer  (warning never appears for blips < 5 s)
      ├── clear poorEscalateTimer
      ├── setPoorConnection(false)   (hide banner if it was showing)
      │
      └── if already paused → arm goodRecoverTimer (10 s)
            │
            └─ sustained good → doRestore()
                 setCameraEnabled(true) (unless manually disabled)
                 setSubscribed(true) on every remote video
                 setAutoDegraded(false)
```

A bad → good blip cancels every pending timer; nothing is touched.
A good → bad blip cancels the pending recovery; the pause stays.
**Manual disable from the user (`manuallyDisabledCameraRef` on participant)
takes precedence** — auto-recovery never re-enables a camera the user
turned off explicitly.

Cleanup path clears all three timers so a delayed fire can't toggle
camera/subscriptions on an already-disconnected room.

### Two-stage banner copy

`autoDegraded` state drives the visible message so the user always
knows what's actually happening:

| State | Color | Copy |
|---|---|---|
| `poorConnection && !autoDegraded` | amber | "Unstable connection — keeping video for now" + manual "Disable camera now" button (participant only) |
| `autoDegraded` | orange | "Camera paused to preserve audio · auto-resumes when your connection recovers" |

Amber is the "we're watching your connection" phase. Orange means "we
just paused your camera; don't panic, it comes back on its own".

### Constants

| Constant | Value | Tradeoff |
|---|---|---|
| `POOR_WARN_MS` | 5 000 | Lower = banner reacts faster to genuine degradation but flashes on isolated Poor events. Higher = misses brief but real warnings. |
| `POOR_ESCALATE_MS` | 30 000 | Lower = quicker teardown when audio is in trouble. Higher = more breathing room for LiveKit adaptation to land. |
| `GOOD_RECOVER_MS` | 10 000 | Lower = camera comes back sooner. Higher = avoids ping-pong on a single brief good blip. |
| `AUDIO_LOSS_DOWNGRADE_THRESHOLD` | `0.05` | < this fraction of inbound-rtp/audio packets lost = teardown declined. Opus is resilient up to ~3 % (imperceptible), distorts at 5–10 %, has audible holes above. 5 % is the boundary at which dropping video to protect audio is a net win. |

All four live in both pages; keep them identical so host and participant
behave the same.

### The audio-loss gate — why it matters

When the 30 s timer fires, LiveKit has had:

| Time | What LiveKit did automatically |
|---|---|
| 0 → 2 s | Encoder bitrate continuously reduced via WebRTC Bandwidth Estimation. |
| 2 → 5 s | Simulcast drops 720p layer; SFU forwards 360p to subscribers. |
| 5 → 15 s | 360p drops; only 180p is sent. `maintain-framerate` chose this over framerate sacrifice. |
| 15 → 30 s | Subscriber-side `adaptiveStream` requests the lowest layer on small tiles. |

At 30 s the entire built-in cascade has exhausted itself. The audio-loss
gate exists to answer the actual question: **did all that adaptation
work?** If audio is fluid (< 5 % packet loss), the answer is yes — leave
the user watching ugly-but-fluid video. If audio is also losing packets,
adaptation failed and we sacrifice video to give audio more headroom.

The gate is logged at the point of decision so operators can correlate
with bug reports:

- `[quality] escalation declined: audio loss 0.12% < 5% — LiveKit adaptation working`
- `[quality] escalating teardown: audio loss 7.43% ≥ 5%`

A session full of "escalation declined" log lines means the auto-pause
is doing its job invisibly. A session that goes straight to "escalating
teardown" is a genuine bandwidth collapse where the teardown is the
right move.

## 5. Publish-error recovery modal

**The bug**: `createLocalAudioTrack` / `publishTrack` can throw
`UnhandledRejection: No CoreAudioCaptureSource device` on macOS Safari
when a virtual audio driver (Microsoft Teams Audio, BlackHole, etc.)
is set as the system default and the owning app is holding the device
exclusively. The original `toggleAudio` in `MediaControls` had no
catch — the error went to the console, the UI carried on as if the mic
were just muted, the user clicked unmute repeatedly, nothing audible
came out, and a bug report came in saying exactly that.

**The fix** — `toggleAudio` and `toggleVideo` in
[components/MediaControls.tsx](../../components/MediaControls.tsx) now
wrap the publish in try/catch. On error:

1. `enumerateDevices()` — labels only populate after a permission
   grant, so refresh now.
2. Set `publishError = { kind, message }` → opens
   [components/ui/MediaPublishErrorModal.tsx](../../components/ui/MediaPublishErrorModal.tsx).

The modal shows:

- Plain-language explanation: "another app is holding the device, or a
  virtual driver was selected as the default".
- Collapsible **Technical details** (raw error message, for operator
  triage when the report comes in).
- Device dropdown **split into "Physical (recommended)" vs
  "Virtual drivers (may not work)"** by a label regex:
  `microsoft teams|zoom|discord|loopback|blackhole|soundflower|virtual|krisp|vb-audio`.
- Auto-selects the first physical device on open → one-click recovery
  for the common case.
- **Try this device** button calls `retryAudioWithDevice(deviceId)` /
  `retryVideoWithDevice(deviceId)`, which re-attempts publish with
  `deviceId: { exact: ... }` constraint. The `exact` matters: without
  it, browsers can still resolve to the system default.
- Inline failure feedback if the retry also fails — modal stays open
  so the user can try a different device or quit the conflicting app.
- Advisory text naming the usual suspects (Teams, Zoom, FaceTime,
  OBS, GarageBand) — closing other apps isn't something we can do
  from the browser, but naming them often unblocks the user.

Success closes the modal automatically after 900 ms (long enough to
show the green ✓ confirmation).

### Why we DON'T listen to `RoomEvent.MediaDevicesError`

`MediaDevicesError` on the Room only fires for SDK-managed track
operations. The track creation path in `MediaControls` uses
`createLocalAudioTrack` / `createLocalVideoTrack` + `publishTrack`
directly, so the error short-circuits there and the room event never
fires. The `try/catch` in MediaControls is the right hook for this
user-facing flow. We DO log `media_devices_error` to connlog from the
page-level handler for the SDK paths (mostly auto-reconnect track
refresh) but don't surface that to the user.

## File map for the resilience subsystem

| File | Role |
|---|---|
| [app/api/connection-log/route.ts](../../app/api/connection-log/route.ts) | Beacon endpoint → console.info + Prisma insert |
| [app/dbbackend/model/schema.prisma](../../app/dbbackend/model/schema.prisma) | `ConnectionEvent` model |
| [app/admin/connections/page.tsx](../../app/admin/connections/page.tsx) | Admin filter + paginated table |
| [app/admin/bugs/[id]/page.tsx](../../app/admin/bugs/%5Bid%5D/page.tsx) | Bug-report detail: WebRTC stats, active devices, remote levels, virtual-driver badges |
| [app/host/page.tsx](../../app/host/page.tsx) | Quality hysteresis state machine + auto-pause |
| [app/participant/page.tsx](../../app/participant/page.tsx) | Same + manually-disabled-camera precedence + connlog beacon helpers |
| [components/HostContent.tsx](../../components/HostContent.tsx) | Audio subscription watchdog (5 s interval, 10 s stuck threshold, 3-retry cap) |
| [components/MediaControls.tsx](../../components/MediaControls.tsx) | toggleAudio / toggleVideo with try/catch + retry-with-deviceId |
| [components/ui/MediaPublishErrorModal.tsx](../../components/ui/MediaPublishErrorModal.tsx) | Recovery modal with physical/virtual device split |
| [components/ui/BugReportDialog.tsx](../../components/ui/BugReportDialog.tsx) | Captures `media-source` audioLevel, per-remote inbound levels, activeInputDevices |

## Things we explicitly DON'T do (related to this work)

### Don't add `red: true, dtx: true` to Room `publishDefaults`

DTX (Discontinuous Transmission) compresses silence into comfort
noise, which is fine for speech but **destroys music dynamics** —
sostenuto choir tails, piano decay, soft passages all get collapsed.
`audioSelector.tsx` already toggles `dtx` and `red` per mode
(speech: on, music: off) via `AUDIO_MODE_PRESETS`, and `MediaControls`
re-publishes when the mode changes. Setting Room defaults would
either be ignored (per-publish wins) or apply in an edge window
before mode switch — pure downside.

### Don't enable TURN on 443 with SNI multiplex

The existing `tcp_port: 7881` in `server/server.yaml` is enough for
home networks. Magnus's session in the field used it successfully
(`connectionType: "tcp"` in the server log). TURN-TLS-443 with nginx
SNI multiplex matters only for corporate/school firewalls that
whitelist 443; the Highland tutor population doesn't include those.
Revisit if the user base grows to include schools or hospitals.

### Don't poll quality on the client

`RoomEvent.ConnectionQualityChanged` is push-based from the server;
LiveKit re-evaluates every ~5 s and only sends when it crosses a
threshold. Don't add a `setInterval` to "double-check" — you'd just
duplicate work and lose the on-transition signal that the existing
handler depends on.

### Don't act on the first `Poor` event

This is the whole reason §4 exists. The handler must wait for
sustained Poor/Lost across THREE timers before tearing down media:

- 5 s of sustained Poor before the banner even appears.
- 30 s of sustained Poor before the teardown CONSIDERS firing.
- Audio packet loss ≥ 5 % at that point before the teardown actually
  fires; otherwise stay in amber and let the user keep watching the
  degraded video.

Skipping any one of these reintroduces a real user-reported regression:

- Skipping the warn timer (5 s) → false-alarm banners on
  excellent-but-occasionally-bursty connections (the GC-pause /
  single-jitter-burst case).
- Skipping the escalate timer (30 s) → camera flicker every 5 s on
  bursty 4G (the original bug).
- Skipping the audio-loss gate → unnecessary teardown of stable
  pixelated video on connections that LiveKit's adaptation already
  rescued — making the experience strictly worse than doing nothing.

## Reading order for an LLM debugging an incident

1. **`/admin/connections`** filtered by the user's identity + the
   incident time window. "Only problems" toggle = drop the noise.
2. If you see a `quality bad: true` followed by a `disconnected` with
   reason ≠ `CLIENT_INITIATED`, the network gave up. Tell the user.
3. **`/admin/bugs/<id>`** if they submitted a report — go straight to
   "Active capture devices" for the silent-mic case, "WebRTC stats"
   for the bandwidth case, "Remote participants" inbound levels for
   the "I can't hear X" case.
4. **`docker logs <next>` grep watchdog** if the report says "I
   couldn't hear someone" but their inbound level was 0 with
   `isSubscribed: true` — confirm the watchdog tried to recover.
5. **Browser console grep `[quality]`** in a recorded session: lines
   like "escalation declined: audio loss 0.12% < 5%" mean the
   auto-pause considered firing and chose not to (LiveKit's adaptation
   was enough). Lines like "escalating teardown: 7.4% ≥ 5%" mean it
   actually fired. Frequent "escalating teardown" in one session is a
   sign of genuine bandwidth collapse, not a configuration issue.
6. The Highland-tutor playbook for the user message:
   - Chrome over Safari.
   - Ethernet over WiFi.
   - Pause iCloud / OneDrive sync during the lesson.
   - Quit Teams / Zoom / FaceTime before joining.
