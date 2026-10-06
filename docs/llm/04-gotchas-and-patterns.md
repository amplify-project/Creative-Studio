# Gotchas, design decisions, and patterns

A grab-bag of "we tried X and it broke Y" entries, conventions to honor,
and patterns worth reusing. Maintained as facts, not aspirations.

## Things we explicitly DON'T do (and why)

### Don't rewrite `sendChange` to queue patches

`sendChange` in [app/hooks/useSharedState.tsx](../../app/hooks/useSharedState.tsx)
returns `"refused"` when a previous patch is awaiting ack. A natural fix
is to make it queue and serialize patches. **The user has explicitly
rejected this refactor.** Reason: `sendChange` is the spine of
mute/muteAll/layout/playback and they had nasty regressions there
before. Apply per-call-site retries instead. See `03-shared-state.md`.

### Don't make `Play2GetherLyricsBanner` call the hook from a sibling location

If you render `<Play2GetherLyricsBanner />` alongside `Play2GetherHostPanel`
or `Play2GetherClientPanel` (instead of inside them), you spawn a second
`usePlay2GetherSession` hook instance. Both arm `MediaRecorder` on the
same mic when the user is the recording target → duplicate uploads.

Current state: the banner calls `usePlay2GetherSession({ capture: false })`,
which skips the recorder/upload/metronome machinery, so it is safe to render
anywhere — rendering it *inside* a panel was never a single hook instance
anyway. It is rendered separately on both sides: HostContent.tsx, and
MainStageParticipant.tsx (inside the stage, since the participant panel became
a column beside it, 2026-09-29). The rule that still holds: any OTHER new
caller of the hook must pass `{ capture: false }` unless it is the panel.
Per-round idempotency (`uploadedClapAtRef`) remains the backstop.

### Don't replace AudioWorklet with MediaRecorder for takes

Earlier code used `MediaRecorder(stream, {mimeType: "audio/webm;codecs=opus"})`.
We migrated to AudioWorklet + WAV because:
- Opus encoder has ~5–20 ms lookahead → starts capturing samples LATE.
- `recorder.start()` itself has ~50–100 ms startup before frames flow.
- Together: every take started ~50–120 ms after `clapAt` → singer's
  voice arrives in the mix late → consistently early-clipped phrases.

WAV is larger (~10× Opus), accepted as trade-off for short choral takes.
Don't go back unless someone provides a quantitative argument.

### Don't skip the silent sink in the worklet path

`workletNode.connect(silentGain); silentGain.connect(destination);` is
NOT cosmetic. Without it, Web Audio can skip `process()` calls under
load → gaps in the recording that accumulate as drift. The muted
destination forces pull-through.

### Don't share MediaPipe `Hands` instances across `process_video` tasks

`mp.solutions.hands.Hands(...)` is not thread-safe. Concurrent tasks
through one instance produce incoherent bboxes (the state of "what was
the last frame" gets mixed). Each `process_video(track, …)` creates its
own instance.

### Don't call `gc.collect()` per frame in the agent

It used to do that. `gc.collect()` in a tight loop causes 10–50 ms
pauses per call → kills the effective framerate. Removed. Python's
default gc is fine for the small allocations in the per-frame path.

### Don't send agent bbox coords in pixels

Simulcast + adaptiveStream means the agent and the client see different
resolutions of the same track. Pixel coords from the agent don't map to
the client's frame. Always send normalized `[0, 1]` from the agent;
scale at `drawImage` time on the client. See `02-hand-zoom.md`.

### Don't use `await req.formData()` for multi-MB uploads under concurrency

`req.formData()` buffers the entire multipart body in JS heap before
resolving. One ~5.7 MB WAV is fine; **four arriving simultaneously**
peaks the Next.js process around 50–70 MB of transient allocation
(FormData double-buffers internally). The event loop stalls servicing
the parses, all four clients get stuck on "Uploading…", and GC pauses
cascade into 504s.

Symptom that matched in production: multiple participants finishing a
1-minute Play2Gether take at the same `clapAt`, all stuck uploading; the
host's stage stayed empty of takes; sometimes the WAVs were on disk on
the server, sometimes not.

Fix in `app/api/play2gether/record/route.ts`: stream the body to disk
with `Readable.fromWeb(req.body)` + `pipeline(…, createWriteStream(tempPath))`.
Metadata moves to URL query params. Memory per request drops to
O(chunk_size) ~64 KB. See `01-play2gether.md` "Streaming upload" for the
full architecture (UUID temp file written outside the per-session lock;
atomic `rename` to final filename inside the lock).

The same anti-pattern is still present in `app/api/play2gether/reference/route.ts`
(one upload per session, bounded memory). Apply the same refactor if
larger references become common.

### Don't put the zoom `<video>` offscreen

`document.createElement("video")` and assigning `srcObject` directly
bypasses LiveKit's `track.attach()` system. The SFU decides what
simulcast layer to send based on attached `<video>` element sizes; an
unattached video looks like "nobody's watching" → SFU drops to lowest
layer (pixelated in pin) or pauses subscription (black on remote
viewers). Always use `track.attach(domVideoEl)` with the element rendered
in the DOM at the right size, even if visually hidden.

### Don't edit `server/nginx/nginx.conf` — it is generated

The real configuration is
[`server/nginx/templates/nginx.conf.template`](../../server/nginx/templates/nginx.conf.template).
The nginx container's entrypoint runs
`gomplate -f /etc/nginx/templates/nginx.conf.template -o /etc/nginx/nginx.conf`
on **every start**, and the compose mount is read-write, so an edit to
`nginx.conf` is overwritten on the host at the next boot.

Why this traps people rather than merely inconveniencing them: `nginx.conf` is
tracked in git, sits in the obvious place, and reads as authoritative — while
being stale enough to disagree with the template about which host it serves
(`portable.` vs `creativestudio.`) and about the limits themselves (20M vs the
template's 50M). Anyone who reads it to answer "what does nginx allow?" gets a
confident wrong answer, and the fix they write is silently reverted.

Read the template. Change the template. The values it actually carries are in
"Production environment notes" below.

### Don't return from an async arm path without releasing its lock

`usePlay2GetherSession`'s prewarm effect takes `P2G_ARMED_LOCKS` + sets
`prewarmingRef`, then `await`s `audioWorklet.addModule`. A teardown during that
await used to return early without releasing either, so the remount bailed at
the guard and **nobody armed the recorder** — no error, no console line, zero
chunks, and `doUpload` reporting "No audio was recorded (mic track missing)"
for a mic that was present the whole time.

Two things made it nasty:

- `prewarmingRef` latches. Once it happened, every LATER round in that tab
  failed identically until a reload — so it reads as "Play2Gether is broken",
  not "that round lost the race".
- `reactStrictMode: true` turns it from possible into certain. In dev, React
  double-invokes effects (mount → cleanup → mount) and the cleanup always
  lands inside the await, so **every round fails in a dev build** while
  production only loses a round to a raced dep change.

The release belongs in the effect's cleanup, not in the `if (cancelled)` branch
inside `arm()`: the remount checks the guard synchronously, long before the
awaited `addModule` resolves. Guard it on `recorderRef` so a successfully armed
graph is left to the teardown effect that owns it.

## Worklet capture rules — the three "this was a real bug" rules

Documented also in `01-play2gether.md` but reiterated here because they
keep biting.

1. **Always write 128 samples per `process()`**, zero-pad on empty input.
2. **Stash `captureSampleRateRef = recCtx.sampleRate`** in its own ref;
   don't read `recCtx.sampleRate` inside `doUpload` (cleanup closes the
   context before).
3. **Silent sink** — workletNode must connect to `destination` via a
   muted gain, otherwise the audio thread can skip frames.

## Browser caching gotchas

Audio served with `Cache-Control: private, max-age=3600`. Any file path
that gets overwritten without changing URL will be served stale by the
browser. Three cache-busters wired across Play2Gether:

- `mix.webm`: `triggerMix` patches `resultUrl` with `?t=${Date.now()}`.
- `rec_*.wav`: host preview uses `?t=${participant.uploadedAt}`.
- `lyrics.lrc`: `uploadLyrics` patches `lyricsUrl` with `?t=${Date.now()}`.

If you ever overwrite the reference file in place (e.g. host re-records
the reference live), versioning `referenceUrl` similarly would be needed.

## Hot-mounted patterns

### Per-round idempotency refs

Used in `uploadedClapAtRef`. Pattern:
```ts
const refKey = useRef<KeyType | null>(null);

useEffect(() => {
  if (predicate) return;
  if (refKey.current === currentKey) return; // already handled this round
  refKey.current = currentKey;
  doSideEffect();
}, [deps]);

// Reset on the "new round" trigger:
useEffect(() => {
  refKey.current = null;
}, [keyChange]);
```

Use when an effect can re-fire from unrelated dep changes mid-round and
the side effect MUST NOT execute twice for the same logical operation.

### Synchronous lock + ref pair for resources

Used in `isRecordingScheduledRef` + `recorderRef`. The two-stage lock
distinguishes "scheduled but not yet created" from "actively running".
The scheduling effect:

```ts
if (isScheduledRef.current || resourceRef.current) return; // re-entry guard
isScheduledRef.current = true;                              // claim instantly
const timer = setTimeout(async () => {
  // ... async setup ...
  resourceRef.current = handle;
}, delay);
return () => {
  if (!resourceRef.current) {                               // setup hasn't completed
    clearTimeout(timer);
    isScheduledRef.current = false;
  }
};
```

Cleanup that runs once the resource is active should be in a separate
effect keyed on the relevant state ([phase] in our case), not on the
arming effect — so re-arming re-runs don't tear down a live resource.

### Per-session mutex for `session.json` (`withSessionLock`)

Read-modify-write of `session.json` under concurrent uploads loses
writes: two POST `/record` handlers each `readSession` → mutate
`participants` in their own copy → `writeSession`. Last writer wins;
the blob from the earlier writer is on disk but unreferenced.

Pattern in `app/api/play2gether/utils.ts`:

```ts
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  sessionLocks.set(sessionId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}
```

Process-local only — fine for single-process Next.js. If we ever cluster
the app behind PM2 or run multiple Node workers, switch to a file lock
(`proper-lockfile` against `session.json.lock`).

The expensive part of an upload (disk write of the WAV) runs OUTSIDE
the lock — only `rename(temp, final)` + the `readSession`/mutate/`writeSession`
trio run under it. Four 5.7 MB streams land on disk in parallel; the
metadata serialisation is microseconds.

### Module-level cross-instance locks for hooks that double-mount

`Play2GetherLyricsBanner` and `Play2GetherHostPanel` (or `…ClientPanel`)
each call `usePlay2GetherSession`. Refs declared inside the hook
(`uploadedClapAtRef`) only dedupe within one instance — both instances
still arm their own recorder and POST their own copy.

Fix: module-level `Set<string>` keyed by `(sessionId, clapAt)`:

```ts
const P2G_ARMED_LOCKS = new Set<string>();
const P2G_UPLOADED_LOCKS = new Set<string>();
const p2gLockKey = (sessionId: string, clapAt: number) => `${sessionId}:${clapAt}`;

// In the arming effect:
const key = p2gLockKey(sessionId, clapAt);
if (P2G_ARMED_LOCKS.has(key)) return;
P2G_ARMED_LOCKS.add(key);
// schedule recorder…

// In the upload effect:
if (P2G_UPLOADED_LOCKS.has(key)) return;
P2G_UPLOADED_LOCKS.add(key);
// doUpload…

// Cleared when clapAt changes (start of next round).
```

Survives React strict-mode double mount. Resets only on a full page
reload. The architectural cleanup — render the banner inline so there's
only one hook instance — would obsolete these locks but isn't blocked.

### One-shot reset on first mount per resource (`playbackResetForSessionRef`)

Shared state can carry stale "in-flight" flags across a host reload —
e.g. `playRehearsal: true` if the host refreshed mid-playback. Remounting
the hook would inherit the flag and immediately start broadcasting the
reference / mix audio again, surprising both host and participants.

Pattern in `usePlay2GetherSession`:

```ts
const playbackResetForSessionRef = useRef<string | null>(null);

useEffect(() => {
  if (!isHost || !sessionId) return;
  if (playbackResetForSessionRef.current === sessionId) return;
  playbackResetForSessionRef.current = sessionId;
  sendChange([
    { op: "add", path: "/playRehearsal", value: false },
    { op: "add", path: "/playResult", value: false },
  ], { reason: "host first mount: reset playback flags" });
}, [isHost, sessionId, sendChange]);
```

Only the host runs it (only role allowed to write those fields). Reruns
when sessionId changes (new session → fresh reset). Explicit user clicks
during the session still propagate normally because the reset only
happens once per (host, sessionId) pair.

### NTP-lite measurement

`measureServerClockOffset()` in `usePlay2GetherSession.ts`. Pattern:
- 5 samples of round-trip time to a server "now" endpoint.
- Each: `offset = serverNow - (t1 + (t2-t1)/2)`.
- Drop high-RTT half, take median of the rest.

Tolerated drift: unlimited (within Number precision). Production AWS
server has been observed drifting 10 s without breaking sync.

The diagnostic log line `[play2gether/sync] offset samples / selected offset`
makes drift visible.

## Conventions

- **UI strings are always English**, even though commit messages and
  internal docs are often in Spanish. The user codes in Spanish, ships in
  English.
- **Commit message style**: bracket-prefixed —
  `[update]:…`, `[fix]:…`, `[feat]:…`, `[ui]:…`, `[opt]:…`. Some older
  commits use `feat(play2gether):…` from develop PRs; match the current
  branch's style.
- **Don't introduce new "fix everything" architectural refactors**
  without explicit go-ahead. The user prefers small, scoped, reversible
  fixes — especially around shared state and audio paths. Past
  regressions on mute/audio have made them cautious.
- **`ffprobe` returns null for MediaRecorder WebM** — the EBML header
  lacks Segment Duration. Always have a wall-clock fallback when reading
  duration from blob uploads.

## Roles and where they're enforced

- App-side: `app/api/token/route.ts` maps URL `role` param to the agent
  role embedded in JWT metadata.
- Agent-side: `shared-state-agent` reads metadata and refuses writes to
  protected paths from non-`teacher` participants.
- Client-side: the panels conditionally render host controls only when
  role indicates host; this is UX, not security — the agent is the
  enforcer.

## When something propagates "weirdly" or doesn't apply

Triage order:
1. Did `sendChange` return `"refused"`? Check logs / wrap in
   `.then(r => console.log(r))`. If yes → that's silent drop, add retry
   per-call-site (`03-shared-state.md`).
2. Did the snapshot get re-requested? `state/changeRefused` triggers a
   resnapshot which discards in-flight optimistic state. Look for
   `[useSharedState]` warning logs.
3. Did an early `continue` in `useSharedMainStage` skip the entity
   because `trackBySid.get(sid)` returned undefined? Happens when a
   participant re-publishes (new SID). The watchdog catches this on the
   next 8 s tick by finding the participant's current track by identity
   and updating `entity.trackSid`.
4. Did the watchdog rewrite something just-set? Compare desired vs
   actual; the watchdog corrects toward `state.entities` so if the
   entity says "muted", the audio subscription will be killed on the
   next tick even if you just unsubscribed manually.

## Performance targets observed

- AudioWorklet capture: <5% CPU on a recent laptop.
- MediaPipe Hands at 480p, 1/3 frame decimation: ~10 fps detection per
  track, <15% CPU per track on a modest server.
- WAV encoding for a 30 s take: ~30 ms on the main thread (acceptable
  pause; only happens once per take at upload time).
- NTP-lite offset measurement: 200–600 ms wall time at mount (5 samples,
  not parallel). Off the critical path of UI rendering.
- Inter-client recording skew: <20 ms with calibration, <50 ms without
  (BT can ruin the latter).

## Production environment notes

- `chrony` on the AWS production server has been observed drifting up to
  10 s. The sync code compensates via measured offset — log
  `[play2gether/sync]` makes drift visible. Server checks:
  `chronyc tracking`, `timedatectl status`.
- On Ubuntu, `systemd-timesyncd` can stop syncing silently. `chrony` is
  more robust if a developer reports drift.
- Nginx has a `client_max_body_size` issue that bit upload of larger
  references — bumped to 50 MB in
  `server/nginx/templates/nginx.conf.template` (**not** in the generated
  `nginx.conf`; see the DON'T above). If a reference upload returns 413,
  check nginx config. 50M is also the true ceiling on Play2Gether take
  length: takes cross the link as WAV at 96 KB/s, so 50 MiB = 546 s.
- Nginx upload timeouts bumped to 300 s
  (`client_body_timeout`, `proxy_send_timeout`, `proxy_read_timeout`).
  Defaults are 60 s, which 504s a slow uplink mid-upload even though
  the body was on its way. Production runs nginx inside a Docker
  container — config lives in `server/nginx/templates/nginx.conf.template`
  and is templated at container start.
  These are **inactivity** timeouts, not whole-request budgets: a slow but
  steady upload never trips them however long it runs. What they bound is
  silence — including the record route, which replies only after ffmpeg,
  peaks and the session lock. No client-side timeout can pre-empt that 504.

### Deploying the webapp: `docker ps` must show a NAME, not a hash

The `webapp` service builds `webapp:latest` from the repo root. A tag points to
exactly one image, so **rebuilding moves the tag to the new image and leaves the
old one nameless** — while a container created earlier stays bound to that old
image by ID. `docker ps` then shows a bare hash in the IMAGE column, and the
container keeps serving the previous build no matter how many times you rebuild.

```
4d20ea870386   eb51a743d48f   …   webapp     ← old image, deploy did NOT land
4d20ea870386   webapp:latest  …   webapp     ← correct
```

`docker rmi webapp:latest` does not help and is what usually starts the
confusion: against an image a container is using, Docker refuses
(`conflict: … container is using its referenced image`) or, with `-f`, merely
untags it. Either way the container keeps running the old bits.

Removing the CONTAINER is the step that matters:

```bash
cd server
docker compose down webapp        # not `stop`, and not `rmi`
docker compose build webapp       # add --no-cache only if you suspect layer cache
docker compose up -d webapp
docker ps --filter name=webapp --format '{{.Image}}  {{.CreatedAt}}'
```

If the image already exists (the tag moved but the container never swapped),
`docker compose up -d --force-recreate webapp` is enough and takes seconds.

Verify what is actually deployed by grepping the built bundle for a string only
the new code has — chunk filenames are content-hashed, so unchanged code
legitimately keeps its hash and cannot tell you anything on its own:

```bash
docker exec webapp sh -c 'grep -rl "<a string from your change>" .next/static/chunks/'
docker exec webapp cat .next/BUILD_ID    # changes on every real build
```

This cost most of an evening on 2026-08-25, chasing a client bug that had
already been fixed.

## MediaControls: read room state, not React state, for toggle functions

`toggleAudio` and `toggleVideo` in [components/MediaControls.tsx](../../components/MediaControls.tsx)
used to check `media.audio.published` (React state) to decide whether
to publish or unpublish. This caused a stale-closure bug: rapid double-
clicks, or calling the function from a `setTimeout` (autoPublish), could
see stale state and publish twice or not at all.

Fix: read the actual room as source of truth:
```ts
const pubs = Array.from(room.localParticipant.trackPublications.values());
const isActuallyPublished = pubs.some(p => p.track?.kind === Track.Kind.Audio);
```

The React state update (`published: true/false`) still follows immediately
after, but the branch decision uses the room directly.

**Rule:** any toggle that calls `room.localParticipant.publishTrack` /
`unpublishTrack` should read the room's `trackPublications` to determine
current state, not a React state mirror of it.

## Grid layout: `gridAutoRows: 'minmax(0, 1fr)'` is required

CSS Grid with `auto` rows (the default) doesn't respect the parent's
height — cells overflow instead of fitting. In `MainStage` grid mode:

```tsx
style={{
  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
  gridAutoRows: "minmax(0, 1fr)",   // ← without this, rows have no defined height
}}
```

Video elements inside cells need `[&_video]:w-full [&_video]:h-full
[&_video]:object-contain` (Tailwind arbitrary variant) to fill their
cell. Without `object-contain`, the video crops instead of letterboxing.

## Reactions are unreliable delivery (by design)

Reactions use `room.localParticipant.publishData(…, { reliable: false, topic: "reaction" })`.
Unreliable (UDP-like) is correct here — a dropped reaction emoji is
invisible to the user; a queued reliable reaction arriving 3 seconds late
would be confusing. Don't change this to `reliable: true`.

Reactions now live inside `ParticipantControlPanel` (the "React" tab), not in the
old standalone `FloatingReactions` component. The data channel topic and logic are
the same; only the UI entry point changed.

## Promote-mix sourceFile allowlist

`POST /api/play2gether/promote-mix` validates `sourceFile` against an
allowlist derived from `meta.resultFile` and `meta.participants[x].file`.
This is a path-traversal guard — never skip it or expand it to accept
arbitrary user-supplied filenames.

## Screen share tracks don't set `hasVideo` in `useParticipantState`

`useParticipantState` computes `hasVideo` by looking at `Track.Source.Camera` only:
```ts
const videoTrack = participant.getTrackPublication(Track.Source.Camera);
hasVideo: videoTrack ? videoTrack.isSubscribed && !videoTrack.isMuted : false,
```
A participant sharing their screen (camera off) will have `hasVideo = false`. Without
a guard, `ParticipantTileWrapper` would show `<AudioWaveBackground>` instead of the
screen share video.

Fix in `ParticipantTileWrapper.tsx`:
```tsx
const isScreenShareTrack = track?.publication?.source === "screen_share";
if (!isLocal && !hasVideo && !isScreenShareTrack) {
  videoComponent = <AudioWaveBackground ... />;
}
```
Don't remove this check — `hasVideo` is used for camera-specific overlays and icons
elsewhere; changing its definition would break those.

## `"hand-zoom"` entities must be treated like `"track"` for audio

When the host enables zoom for a participant, the entity's `kind` changes
from `"track"` to `"hand-zoom"` via a single-field JSON Patch. All audio
subscription logic in `useSharedMainStage` that filters on `kind === "track"`
must also include `"hand-zoom"`, otherwise:

- `isAudioController` skips the entity → `manageAudioSubscription` is never
  called → audio subscription is left in whatever state it was when zoom
  was enabled.
- `stageIds` set doesn't include the participant → the post-loop block
  calls `setSubscribed(false)` on their audio track → audio goes silent.
- The 8 s watchdog's `stageParticipantIds` set doesn't include them →
  watchdog actively re-silences them on every tick.

Rule: any Set or filter over `state.entities` that is meant to represent
"participants on stage" must use:
```ts
.filter((e) => (e.kind === "track" || e.kind === "hand-zoom") && e.participantId)
```
This applies in the main effect, the `TrackSubscribed` handler, and the
watchdog — currently 5 locations in `useSharedMainStage`.

## `removeFromMainStage` is a pure remove (binary on/off)

`removeFromMainStage` in `HostContent.tsx` is `removeEntity(videoKey)`,
nothing else. Host "Hide from stage" = participant disappears completely.

The "stay as waveform when the participant turns off their camera"
behavior is driven by the participant action itself, not by
`removeFromMainStage`: the video unpublishes, the entity stays in shared
state with its old `trackSid`, and `useSharedMainStage` falls into the
waveform branch because the participant still has audio publications but
no live video track.

An earlier version mixed these two intents (host-Hide auto-downgraded
to audio-only). The user explicitly wanted them separated:
- Host Hide → gone (stage + audio).
- Camera off (participant action) → stays as waveform with existing mute state.

## `useSharedMainStage` waveform fallback when participant unpublishes video

Inside the `!track` branch, distinguish "track is loading" from "track was
unpublished" by checking the participant's current publications:

```ts
if (ent.trackSid && ent.trackSid !== ent.participantId) {
  const hasVideoPubs = (participant?.videoTrackPublications?.size ?? 0) > 0;
  if (hasVideoPubs) continue;   // still subscribing — wait, don't paint waveform
}
// otherwise fall through to AudioWaveBackground
```

Without this check the hook either:
- Skips the entity entirely when the entity has a stale video trackSid
  (component disappears from stage when participant turns off camera), or
- Shows a waveform momentarily while a fresh track is still subscribing
  (jittery).

## `TrackReference` has no top-level `.sid`

LiveKit's `TrackReference` (from `useTracks`) is shaped
`{ participant, publication, source }`. **No top-level `sid`.** Code that
reads `trackRef?.sid` always gets `undefined`.

This bit us in the `mainStageVideos` signature comparison in both
`HostContent.tsx` and `useSharedMainStage.tsx`. A signature using
`v.track?.sid` never changes between "has track" and "no track" states,
so `setMainStageVideos(nextMain)` doesn't fire when a participant
unpublishes/republishes. Symptom: the old `<ParticipantComponent>`
stays mounted referencing a dead track (black screen) while audio keeps
playing because the entity still says `visible && !muted`.

Use `v.track?.publication?.trackSid ?? ""` for the sid in signatures.

## Entity key ≠ live track sid after recovery

When a participant unpublishes their camera and republishes a new one,
LiveKit gives the new track a fresh `trackSid`. The host's render loop
detects this and patches the entity's `trackSid` **field** via
`sendChange`. The entity's **key** in `state.entities` is NOT changed —
it stays at the original `trackSid` (the one used when the entity was
first added via `addToMainStage`).

After recovery the entity has:
- `id` (the key) = `<originalTrackSid>` e.g. `"TR_abc"`
- `entity.trackSid` = `<newTrackSid>` e.g. `"TR_xyz"`
- `entity.participantId` = `<userId>`

ParticipantList button handlers must use the **entity key**, not the
live track sid:
- ✅ `onRemoveFromMainStage(onStageActive.key)`
- ✅ `toggleMute(stageEntityKey)` where `stageEntityKey = onStageActive?.key`
- ❌ `onRemoveFromMainStage(trackSid)` — fails silently after recovery
- ❌ `toggleMute(trackSid)` — JSON-patch auto-creates a bogus entity at
   `/entities/<liveSid>`

`mutedTracks` is keyed by entity id (built from
`Object.entries(state.entities)`), so the lookup must also use
`onStageActive.key`.

When matching a track to its stage entry in ParticipantList, fall back
to the publication's current trackSid so the lookup succeeds even after
recovery:
```ts
const onStageActive = mainStageVideos.find(
  (v) => v.key === trackSid || v.track?.publication?.trackSid === trackSid
);
```

## `upsertEntity` replaces the entire entity (don't use for partial updates)

`upsertEntity(id, data)` in `useSharedState.tsx` sends
`op: "add"` at `/entities/{id}` with `value: data`. Per JSON-Patch
semantics, this **replaces** the whole node. Calling
`upsertEntity(id, { trackSid: newSid })` wipes `kind`, `visible`,
`playback`, `layout`, and `participantId` — the entity becomes
unreachable on the next render (`ent.visible` is undefined → skipped).

For partial updates patch the specific subpath:
```ts
sendChange(
  [{ op: "add", path: `/entities/${id}/trackSid`, value: newSid }],
  { reason: "track recovery" }
);
```
This is the pattern used by `addZoom`/`removeZoom` (patching
`/entities/{id}/kind`) and by the track recovery loop in HostContent.

## Audio-only entities in `useSharedMainStage`

Entities representing audio-only participants have `trackSid === participantId`
(an identity string like `"user123"`), while video entities have a distinct LiveKit
track SID like `"TR_abc123"`.

In `useSharedMainStage`, the `!track` (no subscribed video track) branch must
distinguish between:
- **Video entity whose track isn't subscribed yet** → `trackSid !== participantId` →
  `continue` (don't show waveform, track will arrive soon)
- **Genuine audio-only entity** → `trackSid === participantId` (or no `trackSid`) →
  render `<AudioWaveBackground userId={ent.participantId} room={room} />`

Collapsing both cases into `if (!track) continue` silently drops audio-only
participants from the participant-side stage.

## Recent UX decisions worth knowing

- **Step 1 of the host panel is just "Open Session"** — countdown and
  duration moved to per-round controls in Step 4. The duration is
  auto-detected from the reference; the host can override per-round for
  chorus-only takes.
- **Calibration banner**: amber prompt appears at panel open if no
  `localStorage["play2gether:calibratedLatencyMs"]` is set. Not blocking.
- **Calibration mode**: acoustic-loopback only. The earlier "manual tap"
  mode was removed. Calibration persists across sessions in localStorage.
- **Multi-takes**: same participant can record several attempts in a
  session. Server keys them `identity`, `identity_2`, `identity_3`, …
  with filename suffix. Host can delete individual takes; gain=0 mutes a
  take entirely (ffmpeg skips it).
- **Pin mode**: removing the pinned video auto-pins the next available
  one (no falling back to grid unless the stage is empty). Clicking a
  thumbnail in pin mode swaps the pin.
- **Lyrics banner on the host**: rendered from HostContent, currently
  separate from the host panel. Spawns a second hook instance — only the
  duplicate-upload symptom is fixed (via `uploadedClapAtRef`).
  Architectural cleanup (render inline from panels) is a known TODO.

- **Layered recording (Feature #3) done**: host can promote the mix or any individual take to be the new reference after each round. `promoteMix(sourceFile?)` in the hook, `POST /api/play2gether/promote-mix` on the server, teal `Layers` buttons in the host panel mixer.
- **Back-to-grid button** in pin mode: `LayoutGrid` icon at the start of the thumbnail bar. Only visible when the `onGoToGrid` prop is passed (host side only — participants render but don't drive layout).
- **Bug report dialog** attached to a `Bug` icon in `MediaControls`. Captures audio diagnostics, console errors, network info, and LiveKit room snapshot automatically at submission time.
- **`/admin/bugs`** admin interface to list and inspect bug reports.
- **ParticipantControlPanel**: replaces the old `FloatingChat` + `FloatingReactions` combo on both /host and /participant. Sliding side panel with Chat, React (emoji), and Utils (self-camera preview, QR + sign out) tabs. `z-[100001]` toggle stays accessible over JoinSetup (`z-[99999]`).
- **PIP zoom mode**: `HandVideoCrop` now renders the cropped zoom as a small PIP overlay on top of the wide unzoomed video, not as a fullscreen crop. A button toggles `wide-main` ↔ `zoom-main` (swaps which is fullscreen and which is the PIP). The PIP smart-switches corners (TL/TR/BL/BR) to avoid covering the detected hands.
- **Connection quality indicator** in `ParticipantList`: a Signal icon next to each participant's name colored by `ConnectionQuality` (excellent/good = green-emerald, poor = amber, lost = red). Driven by a small `useConnectionQualities(room)` hook listening to `RoomEvent.ConnectionQualityChanged`.
- **Host hide is a binary toggle** — see `removeFromMainStage` section above. No more auto-downgrade.
- **Play2Gether record endpoint streams** — metadata in URL query params, raw WAV bytes as the body, `Readable.fromWeb(req.body)` piped to a temp file. Avoids `req.formData()` RAM buffering that stalled concurrent uploads.
- **Cross-instance Play2Gether locks** — `P2G_ARMED_LOCKS` / `P2G_UPLOADED_LOCKS` at module scope deduplicate arming and uploading when the hook is mounted twice (panel + lyrics banner).
- **Host playback flags reset on first mount per session** — prevents the post-refresh "auto-broadcasts the mix" surprise. `playbackResetForSessionRef` keyed by sessionId.
- **Nginx upload timeouts at 300 s** — both `client_body_timeout` and `proxy_*_timeout`. Defaults of 60 s were 504-ing slow uplinks.

## A fixed filename needs a versioned URL (P2G, 2026-09-04)

Three P2G artefacts are written to a **stable** name and replaced in place:
`reference<ext>`, `mix.webm` and `lyrics.lrc`. Their routes returned a bare
`/api/play2gether/file/<session>/<name>`, so the URL was identical before and
after the replacement — and three separate caches are keyed by exactly that
string: the browser's HTTP cache, `waveformCache` in the mixer, and
`acquireRefPlayer`.

The field symptom was *"you record the reference, delete it, record a new one
and the old one appears"*. The same defect was live on the mix, where it is
worse: a host re-mixes over and over to judge a balance, and every re-mix
returned the URL the player had already resolved.

All three now stamp `?t=${Date.now()}` on the URL they return. Take URLs in the
host panel already did this (`?t=${uploadedAt}`) and `promoteMix` already did it
client-side; these three were the ones that did not. **If you add another
artefact with a fixed name, stamp it — or give it a versioned filename like
`reference_v2.wav`.** Deleting the file is not enough: nothing invalidates a URL
that never changed.

## Never ask "has video?" with `kind === Track.Kind.Video`

A participant can publish several video tracks at once: the primary camera
(`Source.Camera`), a screen share (`Source.ScreenShare`), and any number of
extra cameras (`Source.Unknown`). Matching on kind alone catches all of them.

Two call sites were wrong this way and were fixed 2026-09-11: `toggleVideo`
plus its state-sync effect in `MediaControls` (with a share live, the camera
button reported "on" for a camera that was off, and turning it off
unpublished the share), and `ParticipantList`'s "no audio to mute" test.
Scope to the source you actually mean. See
`13-video-sources-and-stage-entities.md`.

## Stage entities are keyed per track, not per participant

`addToMainStage` used to remove every other entity with the same
`participantId` before adding the new one — written to clear the stale entity
a republish leaves behind, but it enforced one tile per person as a side
effect. Once extra sources began publishing from the participant's own
connection, adding a screen share silently took their camera off the stage.

It now removes only entities whose `trackSid` is no longer live. Don't
reintroduce a per-participant sweep there. The matching rule applies on the
way out: `TrackUnpublished` must remove the entity bound to the dead sid, not
only clean up when the participant has nothing left. Full reasoning and the
five-step check in `13-video-sources-and-stage-entities.md`.

## Serialize every publish through `runPublishOp`, not a local ref

`MediaControls` has a `runAudioOp` promise chain from the duplicate-mic
incident. It is a `useRef`, so it only serializes callers inside that
component. Extra video sources publish from elsewhere in the tree, so the
chain also exists at module scope in
[app/utils/publishQueue.ts](../../app/utils/publishQueue.ts), keyed on the
`Room` in a `WeakMap`, with separate `audio` and `video` lanes. Any new
publish path goes through it — adding a second component-local lock is how
this class of bug got in twice.

## Unlayered CSS outranks every Tailwind utility

Tailwind v4 puts its utilities in `@layer utilities`, and unlayered rules beat
any layer regardless of specificity. `globals.css` uses this deliberately —
the 16px form-control floor under `sm` wins over a `text-xs` without
`!important` — but it cuts both ways: `.pb-safe` *replaces* a Tailwind `pb-*`
on the same element instead of adding to it. The control bar composes its
inset inline for exactly that reason. See `14-ui-shell-and-mobile.md`.

## Don't gate visibility on hover without checking for a pointer

The control bar used to sit at 50% opacity and come back on `mouseenter`. A
touch device never fires that event, so on a phone it was a permanently
half-visible control with no way to restore it. `.hover-dim` is gated on
`@media (hover: hover) and (pointer: fine)`.

## Open ideas — present but not in plan

- Sample-accurate take-vs-take alignment via clap cross-correlation
  (~30 lines client-side; would refine ~5–15 ms inter-take alignment to
  ~1 ms; only useful for percussion ensembles).
- Server-side stem separation (Demucs / Spleeter) on uploaded takes.
- Periodic offset re-measurement during long sessions (today: once on
  hook mount).
- Auto-activation of zoom agent by audio + movement (no host click).
- Multi-crop split-screen when hands are far apart (piano open).
