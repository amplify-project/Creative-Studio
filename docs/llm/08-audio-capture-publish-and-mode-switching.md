# Audio capture, mic publishing, and music/speech mode switching

How the local microphone is captured and published, why it can go wrong on
iPad/Safari, and how switching between **music** and **speech** mode is handled.
Read this when debugging "participants can't hear me", "my mic went quiet",
duplicate mic tracks, or anything about audio mode presets.

This area was hardened in **June 2026** after two field reports from the same
iPad host in one session:

- *"Participants can't hear me"* — diagnostics showed **two** microphone tracks
  published locally and `outboundAudio.packetsSent = 53` over a 9-minute session
  (vs `outboundVideo.packetsSent = 11615`). The mic track was effectively dead;
  the SFU was forwarding the silent duplicate.
- *"My mic has gone quiet"* — 7 minutes later: down to one mic track, audio
  flowing again (a re-publish had collapsed the duplicate), but the capture had
  come back at a low level. `sampleRate` had changed 48000 → 44100 between the
  two reports, i.e. the mic had been re-captured.

Both trace back to the same machinery: **the mic gets published/re-published
from several async paths, and those paths could race**.

## Where the code lives

| Concern | File |
|---|---|
| Mic/cam publish + toggle + mode reaction | [components/MediaControls.tsx](../../components/MediaControls.tsx) |
| Audio presets (music/speech) | [components/audioSelector.tsx](../../components/audioSelector.tsx) |
| Initial publish on join | [components/JoinSetup.tsx](../../components/JoinSetup.tsx) |
| Play2Gether reference recording (MediaRecorder) | [components/Play2GetherHostPanel.tsx](../../components/Play2GetherHostPanel.tsx) |
| Reference upload (server) | [app/api/play2gether/reference/route.ts](../../app/api/play2gether/reference/route.ts) |

The async publish paths that can all touch the mic:

1. `autoPublish` — `MediaControls` fires `toggleAudio()` 1.5s after mount (host).
2. `JoinSetup.handleJoin` — publishes the mic on join (participants).
3. Manual mic button / `AudioSettingsPanel` save → `toggleAudio(settings)`.
4. `audioMode` change (music↔speech) → re-capture with the new preset.
5. The publish-error recovery modal → `retryAudioWithDevice`.

## 1. The duplicate-mic race (fixed)

`toggleAudio` guards with `isActuallyPublished`, read from
`room.localParticipant.trackPublications`. The bug: `createLocalAudioTrack` +
`publishTrack` are async and **slow on iOS Safari**, and an in-flight track is
**not yet in `trackPublications`**. So a second path passes the guard (reads
"not published") and publishes a **second** mic. The SFU then forwards whichever
one ends up silent → nobody hears the host.

### The fix — serialize + dedupe

`MediaControls.tsx` now routes every audio publish/unpublish through a
**promise-chain lock**:

```ts
const audioOpChain = useRef<Promise<unknown>>(Promise.resolve());
const runAudioOp = <T,>(fn: () => Promise<T>): Promise<T> => {
  const result = audioOpChain.current.then(fn, fn); // run after prev settles
  audioOpChain.current = result.then(() => undefined, () => undefined);
  return result;
};
```

Each op runs only after the previous one fully resolves, so the second op
re-reads room state and **sees** the track the first one published — the
read-after-write window is closed. `toggleAudio`, the `audioMode` effect, and
`retryAudioWithDevice` all run inside `runAudioOp`.

Belt-and-suspenders: `dedupeAudioTracks()` runs after every publish and, if more
than one mic track is ever live, **keeps the most recent and unpublishes the
rest** (the `trackPublications` Map preserves publish order, so the last entry is
newest). This kills the symptom even if a duplicate slips in some other way
(e.g. JoinSetup + autoPublish, or a reconnect).

**Do not** revert to reading `media.audio.published` (React state) inside these
ops — it lags the real publish state; the room is the source of truth.

## 2. Cross-browser reference recording (fixed)

`Play2GetherHostPanel` records a reference take with `MediaRecorder`. It used to
hard-code `mimeType: "audio/webm;codecs=opus"`. **Safari (incl. iPadOS) only
supports MP4/AAC and throws `NotSupportedError` straight from the constructor.**
With no UI feedback, the host just mashed the button (the field logs show 6
failed clicks in 4 seconds right before "mic went quiet").

Fix:

- `pickCaptureMime()` returns the first container the browser supports
  (WebM/Opus → MP4 → AAC) via `MediaRecorder.isTypeSupported`.
- If nothing is supported, we **don't construct the MediaRecorder** (no throw),
  show a message, and **disable the Record button** (`captureSupported` state).
- The final `Blob` uses the same container we recorded with, so the server picks
  the right extension. `extFromMime` in the reference route **strips the
  `;codecs=` param** so an MP4 take saves as `.m4a` (not the `.webm` default).

The server already accepts `audio/mp4`/`audio/aac` and serves `.m4a` as
`audio/mp4`; `mix`/`promote-mix` read `meta.referenceFile` dynamically, so ffmpeg
handles m4a fine.

## 3. Music vs speech mode

Presets live in `audioSelector.tsx` (`AUDIO_MODE_PRESETS`). What differs:

| | music | speech |
|---|---|---|
| `echoCancellation` / `noiseSuppression` / `voiceIsolation` | off (raw fidelity) | on |
| `autoGainControl` | off (would pump the dynamics) | on (lifts quiet laptop mics — without it speakers reported "too quiet") |
| **capture** = getUserMedia constraints | — | — |
| `dtx` / `red` / `audioPreset` = **publish-time** opts | set at `publishTrack` | set at `publishTrack` |

The key distinction: **capture constraints need a fresh `getUserMedia` to
change** (`applyConstraints` for EC/NS/AGC is unreliable), while **`dtx`/`red`
are negotiated in the SDP at publish time and cannot change on a live track
without renegotiating** (= unpublish + republish).

### develop behaviour (current mainline)

**Which mode the live mic is in is read from the track itself**
(`captureModeOf` in `app/utils/micCapture.ts`: the *requested*
`echoCancellation` in `LocalTrack.constraints`). `reconcileAudioMode` compares
that with the room's mode on every mode change AND on every new mic track
(JoinSetup, autoPublish, a re-capture). It used to compare the previous prop
with the new one, which missed every mic published before the mode was known:
a refreshed host (autoPublish runs a 1.5 s-old closure built before shared
state arrived) or a participant whose JoinSetup ran early stayed in speech in
a music room. Never read the mode from `getSettings()` — iOS reports
echoCancellation=true in music and the reconcile would loop (it is also
capped at two re-captures per target mode). A capture saved from the settings
panel is the user's own choice and only an explicit mode change overrides it.

On a mismatch it does `unpublish → createLocalAudioTrack → publishTrack` with
the new preset. This is now **wrapped in `runAudioOp`** so it
can't race, but it still tears the publication down and back up. Cost: on iPad
each re-capture restarts the OS audio pipeline, which can bring the track back at
a low level (the "mic went quiet" symptom) and briefly churns SFU subscriptions.

### Experimental: `feature/music_mode_no_republish` (option B)

A cleaner design lives on branch **`feature/music_mode_no_republish`**:

- **Publish opts made mode-independent** — `AUDIO_PUBLISH_CONFIG`
  (`dtx:false`, `red:true`, `musicHighQualityStereo`) is shared by both modes,
  so they're set **once** at publish and never need to change.
- On `audioMode` change, swap only the capture constraints **in place** via
  `LocalAudioTrack.restartTrack(constraints)`. This does a fresh getUserMedia
  (so EC/NS actually flip) but keeps the **same publication / same `trackSid` /
  same `RTCRtpSender`** — no unpublish, no republish, **no duplicate-mic window
  and no subscription churn at all** on a mode change.

Tradeoffs: speech now rides the music bitrate (tune per-mode live via
`sender.setParameters({ encodings:[{ maxBitrate }] })` if bandwidth matters), and
`dtx` is off for both (music needs it off; speech only pays a little idle
bandwidth). `restartTrack` still does a getUserMedia, so the iPad "quiet on
re-capture" can still occur — but without the racing/duplication.

### Mute still unpublishes (muting in place: considered, not done)

The mic button still mutes by **unpublishing**, so every unmute is a fresh
getUserMedia + publish: slow on iOS (first words lost), the OS audio pipeline
restarts (a candidate for the "came back quiet" report), listeners
re-subscribe. `track.mute()` / `unmute()` would avoid all of that (LiveKit 2.15
keeps the capture open on mute), and was written on feature/improve_audio, then
taken out as too wide a behaviour change for now: code across the app reads
"muted = no mic publication". If it is ever done, at least:

- anything that records `pub.track.mediaStreamTrack` must check `isMuted`, or
  it records silence — the P2G round recorder (`usePlay2GetherSession`) and the
  host's reference capture (`Play2GetherHostPanel`);
- the mic button needs a third state (published + muted);
- the re-capture paths must re-mute the new track (a muted track publishes
  muted via AddTrackRequest.muted);
- the browser's mic indicator stays on while muted.

Note `HostContent`'s comment that "a primary participant keeps their audio
publication even when muted" is NOT true today: camera off + muted = zero
publications.

### Channels

Speech captures **mono** (echo cancellation processes mono anyway; the preset
said "mono" but asked for 2). Music captures **stereo**, but a stereo capture
with one dead side — a USB interface with the mic in input 1 — put that person
in one ear. `watchForDeadChannel` listens to a stereo music capture until there
is sound: one side ~30 dB under the other for 1.5 s → the device id is stored
in `amplify.monoInputs` and re-captured mono; both sides active → real stereo,
left alone. `captureFor(mode, deviceId)` is the one builder every publish path
uses (MediaControls, JoinSetup, the retry modal).

### Telemetry

Every new mic track sends a `mic_capture` beacon to `/api/connection-log`:
`why` (unmute / settings / mode:… / dead-channel / retry / publish),
`roomMode`, and `micSnapshot()` = requested vs effective EC/NS/AGC/
voiceIsolation/channels. Bug reports carry `captureMode` + `requested` next to
the effective settings. Use these before calling a "music cuts out" report a
network problem: echo cancellation forced on (iOS) produces exactly that, and
we tested that EC alone breaks music even with NS/AGC off.

### "It got quieter when we changed mode"

Expected physics, not a bug: speech has AGC on, music has it off, so a mic
AGC was lifting arrives at its own level after the switch. On desktop Chrome
the AGC can also move the **OS input slider** (seen on Linux/PulseAudio; Chrome
does the same on Windows/macOS), which then stays low for the AGC-less music
capture. Only the user's input gain fixes it, so the app measures and points:

- `MicLevelMonitor` (`app/utils/micLevelMonitor.ts`) follows the live mic:
  p75 RMS of 100 ms frames above -50 dBFS (silence/mute say nothing).
- `reconcileAudioMode` stores the level before a switch; after 8 s of sound
  on the new track MediaControls logs `mic_level_after_mode` (from, to,
  beforeDb, afterDb, dropDb, quiet). Quiet in music (< -36 dBFS, or ≥ 10 dB
  down and < -28) offers `audio.calibrateMic` / `low_level` — the same panel,
  skill and dedup key (`audio-cal:low_level:<id>`) the server analyser uses.
  Thresholds are first guesses; tune them from the beacons.
- Local code offers skills through `useSuggestions().offer(msg)`: the same
  message shape and gates (skill, role, personal) as the data topic.
- The panel's low_level text adds where the input slider lives per OS.

## 4. The iOS/WebKit constraint caveat

Whether the browser actually **honours** disabling `echoCancellation` /
`noiseSuppression` / `autoGainControl` depends on the **engine, not the browser
name**:

- **Chrome/Edge/Firefox on desktop** (Blink/Gecko) → honoured. Music mode
  captures clean.
- **Any browser on iOS/iPadOS** → WebKit (Apple mandates it, so "Chrome on iPad"
  is Safari underneath) → often **keeps system voice processing on regardless**,
  and tends to force mono. So music mode's "raw audio" may be only partially
  effective on iPad — and that's a platform ceiling, not something the app code
  can fix.
- **Safari on macOS** (desktop WebKit) → mostly honours it, better than iOS.

### Debug flag (on the B branch)

`MediaControls.tsx` on `feature/music_mode_no_republish` has a flag, **off by
default**, that logs requested vs effective constraints after a mode switch:

```js
window.__audioDebug = true      // this session
localStorage.audioDebug = "1"   // persists across reloads (handy on iPad)
```

It logs `track.mediaStreamTrack.getSettings()` (what the browser actually
applied) next to what we requested. Compare a **desktop Chrome** baseline (should
show `echoCancellation: false` in music) against the iPad (likely `true`) to
prove whether a mismatch is iOS or our code. Behaviour varies by iOS version, so
note it when testing.

## 5. Chosen devices: the mic survives re-captures, the app's own sound follows the speaker

Field reports 2026-09-28 (Mac, Chrome, EarPods chosen at join, system default
output = laptop speakers): "the audio switches to the in-built when Play2Gether
is used", "the recording comes through the internal speakers", "adjusting the
volume does not work". Two separate causes, both "the device the user picked
was forgotten":

- **Input.** `MediaControls` started with `deviceId: "default"` and never
  learned what JoinSetup published with, so every re-capture — the
  music/speech switch (`audioMode` effect), unmute (`toggleAudio`) — moved
  the user back to the OS default mic. Now JoinSetup persists the pick
  (`amplify.inputDeviceId`), and the re-capture ops take the device of the
  **live** mic (`resolveMicDeviceId`: room first, same rule as §1), falling
  back to the stored pick. **A live `"default"` is not a pick**, though: it is
  what the host's autoPublish gets before any panel, and what LiveKit
  restarts a published mic on when it ends. Reusing it made every later
  music/speech switch ignore the mic chosen afterwards (2026-10-02), so a live
  "default" yields to a stored explicit pick. Re-captures also **await** the
  unpublish before opening the new capture (`unpublishAllMics`), so the old
  track is never still published when it ends — LiveKit's
  `handleTrackEnded` would otherwise restart it with `deviceId: 'default'`.
  `mic_capture` beacons carry `device.requested` / `device.opened`.
- **Output.** LiveKit's audio follows `switchActiveDevice` +
  `participant.setVolume`; nothing the app plays itself did. The Play2Gether
  reference, metronome, clap, result, the host mixer preview and UI chimes
  all went to the system default at full scale. `app/utils/outputBus.ts` is
  the one place that knows the speaker and volume: elements call
  `routeElement(el)`, contexts connect to `outputNode(ctx)` instead of
  `ctx.destination` (a master gain + `AudioContext.setSinkId`). Changes
  broadcast live. **Any new sound the app plays must use one of the two.**
  The acoustic calibration uses `routeContextDeviceOnly` — right device, no
  volume, so it measures the path the player actually hears.

The bus also owns temporary **holds on the room's audio**
(`holdRemoteAudio(factor)`): calibration rounds hold it at 0, result playback
ducks it to 0.15 (every room mic hears the mix off its own speakers and sends it
back — "artefacts in the headphones"). `useOutputVolume` applies
`volume × min(holds)` on every subscription; do not call
`participant.setVolume` directly any more — the hook overwrites it on the next
`TrackSubscribed`, which is how the old calibration silence got undone.

Speaker and volume are still chosen only on the pre-join screen. An in-session
control was tried and dropped: once everything follows the chosen device, the
OS volume keys work, and a second knob on top of them is one more way to end up
unable to hear. `setOutputVolume` / `setOutputDevice` are there if one is ever
wanted. Bug reports carry `output` (speaker, volume, room hold), and the active
mic label is looked up by kind + id (`"default"` exists in every kind).

## Verification status

The audio fixes (#1, #2) are on **`develop`**; option B + the debug flag are on
**`feature/music_mode_no_republish`**. Neither has been compiler-verified in the
working checkout (its `node_modules` was incomplete) — run `npm install && npx
tsc --noEmit` and test on a real iPad/Safari before merging B.
