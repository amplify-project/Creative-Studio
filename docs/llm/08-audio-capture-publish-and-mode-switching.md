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
| **capture** = getUserMedia constraints | — | — |
| `dtx` / `red` / `audioPreset` = **publish-time** opts | set at `publishTrack` | set at `publishTrack` |

The key distinction: **capture constraints need a fresh `getUserMedia` to
change** (`applyConstraints` for EC/NS/AGC is unreliable), while **`dtx`/`red`
are negotiated in the SDP at publish time and cannot change on a live track
without renegotiating** (= unpublish + republish).

### develop behaviour (current mainline)

On an `audioMode` change, the effect does `unpublish → createLocalAudioTrack →
publishTrack` with the new preset. This is now **wrapped in `runAudioOp`** so it
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

## Verification status

The audio fixes (#1, #2) are on **`develop`**; option B + the debug flag are on
**`feature/music_mode_no_republish`**. Neither has been compiler-verified in the
working checkout (its `node_modules` was incomplete) — run `npm install && npx
tsc --noEmit` and test on a real iPad/Safari before merging B.
