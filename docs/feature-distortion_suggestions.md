# Branch `feature/distortion_suggestions` — change documentation

Self-contained record of everything this branch adds on top of `develop`.
Written to be read (or indexed) without the repo at hand.

- **Base:** `develop` (merge base `6776205`).
- **Size:** 43 commits, 47 files, +3,699 / −426 lines of text, plus ~102 MB of
  binary ONNX models.
- **Span:** April → July 2026. Includes earlier work from the `Salsa_Dev` branch
  (a standalone audio-analysis agent) which is converted into a plugin here.
- **Product:** Amplify Creative Studio — a Next.js app for synchronous
  collaborative video/audio sessions over LiveKit, used by tutors/hosts.

The branch carries **two independent lines of work** that coexist because they
were developed in parallel:

- **Block A — Assistant + real-time audio analysis.** This is what the branch is
  named after.
- **Block B — Play2Gether** (synchronized choral recording): a sync correctness
  fix and a mixer redesign.

---

## 1. File map

### New

| File | What it is |
|---|---|
| `server/agents/assistantHost/plugins/audio_analysis.py` | Assistant plugin: classifies each participant's audio and decides when to suggest. 706 lines. |
| `server/agents/assistantHost/audioAnalysis/audio_classifiers.py` | ONNX inference engine + DSP features. 397 lines. |
| `server/agents/assistantHost/audioAnalysis/*.onnx` | Four models: `yamnet_model` (16 MB), `content_mlp` (2.6 MB), `dac_encoder` (86 MB), `distortion_mlp` (1.2 MB). |
| `components/MicCalibrationPanel.tsx` | Live mic level meter, local to the affected user. |
| `components/AudioAnalysisTab.tsx` | Host-panel tab showing what the analyser hears per participant. |
| `app/api/play2gether/report/route.ts` | Per-participant recording/upload failure reporting. |
| `scripts/p2g_measure_lag.py` | Objective cross-correlation measurement of each take's lag against the reference. |

### Notably modified

`app/hooks/usePlay2GetherSession.ts` (+411), `components/Play2GetherHostPanel.tsx` (+879),
`app/api/play2gether/mix/route.ts`, `app/api/play2gether/record|reference/route.ts`,
`app/api/play2gether/utils.ts`, `public/play2gether-capture-worklet.js`,
`components/Play2GetherCalibration.tsx`, `components/Play2GetherClientPanel.tsx`,
`app/hooks/useAssistantSuggestions.tsx`, `app/skills/{index,types}.ts`,
`app/api/token/route.ts`, `app/dbbackend/model/schema.prisma`,
`server/agents/assistantHost/{assistant_host.py,creativestudio_assistant/__init__.py}`,
`server/agents/shareState/agent.py`, `docs/llm/01-play2gether.md`, `.gitignore`.

---

## 2. Block A — Audio analysis and suggestions

### 2.1 Architecture

The `assistant-host` agent (Python, LiveKit Agents) already existed with a plugin
system and a suggestion bus. This branch:

1. Converts the old standalone `AudioAnalysisAgent` (from `dataCollection/`) into
   a **plugin**: `plugins/audio_analysis.py`.
2. Extends the plugin framework so plugins can **subscribe to audio tracks** and
   **publish high-frequency events**.

End-to-end flow:

```
participant audio track (LiveKit)
  → audio_analysis plugin (960 ms windows)
      → AudioContentAnalyzer (4 ONNX models + DSP features)
          → content class: singing | speech | instrumental | other
          → distortion labels (multi-label, independent sigmoid per class)
          → window RMS dBFS
      → hold state machines + episode clocks
          → `audio/analysis` event (topic `cmd`, broadcast, unreliable)
          → capture-mode switch suggestion  → to the host
          → mic calibration suggestion      → ONLY to the mic's owner
```

### 2.2 The analyser (`audio_classifiers.py`)

- **Window:** 960 ms at the capture rate (48 kHz → 46,080 samples), **0 % overlap**
  (was 50 %) to save CPU. One result per window.
- **Preprocessing:** normalise to float32, resample 48 k → 16 k with `np.interp`
  (linear interpolation, **no anti-alias filter** — see technical debt).
- **Content classifier:** YAMNet embeddings (1024-d) → MLP → softmax over
  `["singing", "speech", "instrumental", "other"]`.
- **Distortion classifier:** 16 kHz DAC encoder (mean-pooled embedding)
  concatenated with 9 hand-crafted DSP features → MLP → **independent sigmoid per
  class**, i.e. **multi-label**, over
  `["clipping", "bw_limit", "bass_boost", "codec", "packet_loss"]`. Threshold 0.5.
  - DSP features (fixed order, versioned as `DSP_FEATURE_VERSION = 2`):
    `crest_factor_norm`, `clip_ratio`, `spectral_flatness`, `hf_energy_ratio`,
    `lf_energy_ratio`, `mid_band_ratio`, `spectral_centroid`, `rms_level_norm`,
    `dip_db_norm` (the deepest 20 ms sub-frame level dip, aimed at
    `packet_loss`/PLC artifacts).
- **Silence gate (`ANALYZER_SILENCE_RMS_DBFS`, −55 dBFS):** windows below that
  level are **not classified at all** and produce no result.
  - *Why:* the models have no "nothing here" output. The content classifier must
    spread probability on every window it is given, so an empty room was being
    reported as music. The distortion side is worse: what little is present
    during silence is room rumble and mains hum, i.e. low frequency, so
    `lf_energy_ratio` dominates and near-silence carries exactly the feature
    signature of `bass_boost`.
  - Dropping the window rather than reporting "silent" is deliberate: silence is
    the *absence* of a measurement, not a measurement, and the downstream holds
    and episode clocks must not see it. It also skips three ONNX runs.
- **Window RMS** is measured at the capture rate, *before* resampling and
  normalisation, and carried on the result: the models describe *what* the audio
  is, never *how loud* it is.
- ONNX Runtime pinned to 1 intra/inter-op thread.

### 2.3 Debouncing: two kinds of hold

The classifier flickers window to window. Two different state machines damp it,
depending on the kind of field:

- **`_StickyHold`** — adopts the first candidate immediately; after that a
  different candidate only replaces the reported value once it has been seen N
  consecutive windows. For fields that always need a defined value (content
  class, distortion on/off).
- **`_ConfirmedHold`** — only reports a candidate (including "no candidate") once
  it has held for N updates. Here "nothing detected" is a normal steady state
  rather than a placeholder to escape on first observation. Used for mic issues,
  which should stay empty until the problem has actually been consistent. Also
  accumulates the mean confidence.

N = 3 windows by default (`AUDIO_CONTENT_HOLD_WINDOWS`, etc.).

### 2.4 Capture-mode suggestion (music ↔ speech)

If the room has been playing music for a while, the host should switch to
music-optimised mode (echo cancellation off, raw stereo capture) — and back.

The non-obvious decisions, all of them driven by observed field failures:

- **Episodes are keyed on the target mode, not on the content class.** `singing`
  and `instrumental` are different classes that want the same mode, so keying on
  the class made every alternation between them restart the clock — and someone
  singing over their own playing alternates constantly. The episode never reached
  the threshold and no suggestion ever fired. (`CONTENT_TO_MODE`; `other` maps to
  nothing on purpose.)
- **The episode start is backdated by the whole confirmation**
  (`CONTENT_HOLD_WINDOWS × window duration`, ~2.9 s). By the time `_StickyHold`
  reports a new class, the room has genuinely been doing it that long; crediting a
  single window threw away ~2 s of every episode.
- **5 s threshold** (`AUDIO_MODE_SUGGEST_MIN_SEC`, was 12 s). It is a confidence
  threshold, not a safety one: the suggestion is a dismissable toast the host must
  accept, so a false positive costs an ignored toast, not a wrong mode switch.
- **A 3 s gap in the result stream ends the episode**
  (`AUDIO_MODE_EPISODE_GAP_SEC`). Silent windows are dropped, so a pause leaves a
  hole. Without this, "music → pause → music" was one unbroken episode and the
  second stretch was never suggested.
- **Re-offer after 60 s within the same episode** (`AUDIO_MODE_RESUGGEST_SEC`).
  It used to be offered exactly once per episode, which conflated *ignored* with
  *refused*: a continuous hour of music was one episode and one single chance.
  Refusing does stick, because dismissing a toast puts its key in a client-side
  cooldown.
- **Dedup key per direction** (`audio-switch-music` / `audio-switch-speech`): a
  switch back to speech must not be swallowed by the cooldown left over from the
  music suggestion.

### 2.5 Personal mic suggestions (clipping / boomy / low level)

Three issues with their own copy, addressed **only to the mic's owner**:

| Issue | Source | Message |
|---|---|---|
| `clipping` | model | "Your microphone is clipping" — lower the input gain |
| `bass_boost` | model | "Your microphone sounds boomy" — proximity effect, back off |
| `low_level` | **window RMS**, not the model | "Your microphone is very quiet" — raise the gain |

Key decisions:

- **Each label is gated on its own probability, never on the argmax.** The model
  is multi-label and `bw_limit` and `codec` sit near 1.0 in any WebRTC room by
  construction; an argmax gate let a structural, unactionable label mask a real
  clipping detection sitting just behind it. Measured: clipping 0.92 losing to
  bw_limit 0.99 on audibly clipped audio.
- **Three classes are excluded and also filtered out of the published event**
  (`MEANINGFUL_DISTORTIONS`), not merely left un-suggested:
  - `bw_limit` — the analyser resamples 48 k → 16 k with unfiltered `np.interp`,
    so it never sees above 8 kHz: **the model is detecting its own pipeline**.
  - `codec` — every track in the room is Opus. Always true, says nothing.
  - `packet_loss` — contradicted in the field on 2026-07-20: the label fired while
    WebRTC stats reported no loss at all. Untrusted until that disagreement is
    explained.
  - Leaving them in meant `distortion` was permanently `True` and therefore
    carried no information at all.
- **`low_level` is read off the RMS**, because the classifiers will never say
  *how loud* something is, and it is gated on the content class being a real one
  (`singing`/`speech`/`instrumental`): it only fires when we can hear you and you
  are simply too quiet, not when you have stopped playing. Threshold −42 dBFS.
- **One episode clock per issue**, independent from the content one: it is a
  property of one mic, not of what the room is doing, so it must not reset when
  the content class changes. 8 s sustained before interrupting
  (`AUDIO_CLIP_SUGGEST_MIN_SEC`).
- **No recipient, no suggestion.** `to=[]` is LiveKit's broadcast, so a fallback
  would put "your mic is clipping" on every screen in the room.
- **`ENABLE_DISTORTION_SUGGESTIONS` defaults to `false`.** Detection keeps
  running and is published on every event and in the host panel — observation
  without interruption — but it interrupts nobody until the thresholds have been
  proven against real lessons. An unreliable personal alert is worse than none.

### 2.6 The `audio/analysis` event

Published on topic `cmd`, unreliable (it is a continuous stream), once per window
per track:

```json
{ "type": "event", "name": "audio/analysis",
  "args": { "track_id", "content_type", "distortion", "distortion_type",
            "duration", "rms_dbfs", "issues", "ts" } }
```

`rms_dbfs` and `issues` are added by this branch: the host panel shows them
directly, so it sees what the analyser sees rather than only the suggestions the
agent chose to raise. They are also what the silence and low-level thresholds get
calibrated against.

### 2.7 Assistant framework changes

- `PluginContext.publish_data(data, topic, reliable)` — new path for
  high-frequency events, separate from `suggest()`.
- `PluginContext.suggest(..., to=[identity])` — unicast suggestions.
  `destination_identities` accepts an empty list (broadcast) but **not `None`**:
  `publish_data` calls `.extend()` on it and raises `TypeError`.
- New plugin hooks: `on_track_subscribed` / `on_track_unsubscribed`.
- The agent now joins with `audio_enabled=True` in `RoomInputOptions` (it
  received no audio before) and **picks up tracks published before it joined**.
- **Duplicate logging fixed:** LiveKit runs every job in a child process that
  re-imports the module and forwards its records to the worker. Adding a handler
  in the child too printed every line twice. Now only `MainProcess` calls
  `basicConfig`; the child only sets the level (without it the root logger falls
  back to WARNING and INFO records are dropped before reaching the worker).
- **The skill manifest starts empty** instead of hand-seeded: it is owned by the
  client (`state.skills`) and arrives via snapshot. Seeding it made
  `manifest.all()` truthy, which both silenced the snapshot retry and turned
  validation on against an inventory we made up.
- **`replyTo` in the shared-state protocol** (`shareState/agent.py`): every agent
  in this repo joins hidden, so shared-state-agent sees `pkt.participant is None`
  and had no address to return the snapshot to. The requester now sends its own
  identity as `replyTo`. **Explicit security note in the code: `replyTo` is a
  return address only; authorization still comes from `parse_role(sender)`, which
  returns `guest` for an unresolvable sender and is refused.**
- `onnxruntime` added to `requirements.txt`.

### 2.8 Client side

**New skill `audio.calibrateMic`** (`app/skills/index.ts`):

- Params `participantId` (identity) and `issue` (`clipping|bass_boost|low_level`).
- Roles `host` and `participant` — the host sings too, so the host's own mic can
  clip.
- Marked **`personal: true`**: a new flag in the skill registry. The listener
  only renders the suggestion if `args.participantId` matches the local identity,
  and fails closed when it is missing. It is the local backstop in case a plugin
  forgets to unicast on the transport. The flag travels in the published manifest
  so agents know to address it.
- **`SkillContext.ui`**: a new, deliberately narrow surface for local UI
  (`openMicCalibration`). It mutates nothing shared, so there is nothing for the
  agent permission model to guard; the alternative was handlers reaching into
  random hooks or firing `window` events, which is exactly what the registry's
  "no side effects beyond shared state" rule exists to stop.

**`MicCalibrationPanel.tsx`** — live level meter:

- Reads the **already published** mic track rather than opening a fresh
  `getUserMedia`: it measures the signal the room actually receives, with the
  active mode's constraints applied, and a second capture is exactly the
  duplicate-mic race documented in `docs/llm/08`. (`Play2GetherCalibration` does
  open its own capture, because it needs AEC off for the acoustic loopback — a
  level meter has the opposite requirement.)
- **Never connected to `destination`**: routing the mic to the speakers would
  feed back into the room.
- Peak plus a slow-falling *peak hold*. Level advice is read off the hold, never
  the instantaneous peak: the instantaneous one dips below any threshold on every
  breath, which made the panel nag "raise your gain" at people who simply hadn't
  started yet.
- The panel **measures and guides; it does not fix**: input gain lives in the OS,
  the `volume` constraint is not honoured by browsers, and once a signal clips at
  the converter no filter recovers it.
- Copy varies per `issue`.

**`AudioAnalysisTab.tsx`** — an "Audio" tab in the control panel:

- Consumes the `audio/analysis` events the plugin already emitted and nothing had
  ever consumed. No polling, no server round-trip.
- One row per participant (the event carries a `track_id`; only the client can
  join sid ↔ person, since the plugin never sees display names), with a level
  meter, content class and detected issues.
- **Readings go stale after 4 s**: events stop arriving when a track goes silent,
  so a reading has to be allowed to go stale rather than be treated as current
  forever.
- This is observation, not action: it shows the raw state, not only what the
  agent decided was worth interrupting someone about. You cannot calibrate what
  you cannot see.

**`useAssistantSuggestions.tsx`**:

- **Dismiss cooldown 60 s → 300 s.** Dismissing is an explicit "no", so it has to
  outlast the server's re-offer interval (60 s) — otherwise the retry that exists
  to rescue *ignored* suggestions immediately re-asks something the user had just
  *refused*.
- **Dropped suggestions are logged** (cooldown or already-queued): a dropped
  suggestion and one that was never sent look identical from the console, and
  telling those apart is most of debugging "why did no toast appear".
- **While the calibration panel is open the queue is hidden and the TTL sweep is
  paused.** The user is doing a focused, physical task (watching a meter while
  reaching for an OS slider); toasts stacking over that are pure interruption, and
  one of them is very likely the same problem they are already fixing. And a
  hidden suggestion that quietly runs out its TTL is worse than an interrupting
  one: the user never got the chance to act. Observed in the field with a
  mode-switch suggestion that expired unseen. Closing the panel restarts the clock
  on whatever queued up behind it.

### 2.9 The assistant becomes opt-in per session

Reason: it is the expensive path — three ONNX inferences per 960 ms window **per
audio track**, so cost scales with active participants.

- `SessionDomain.assistantEnabled` in Prisma, **`Boolean?` optional rather than
  `Boolean @default(false)`**: this is MongoDB and existing documents have no such
  field; a required one would make every one of them fail to deserialise until
  backfilled. Absent reads as "not enabled", which is the wanted default anyway.
- An "AI assistant" checkbox in the session-creation form.
- `/api/token` reads the flag **server-side, by room name** (rooms are
  `SessionDomain` ids) and only then dispatches `assistant-host`. Never from a
  client parameter: every participant requests a token and could otherwise turn it
  on or off for the whole room. If the lookup fails (malformed ObjectId, DB down)
  the answer is no.
- `assistant-host` is moved out of `ROOM_AGENTS` into its own constant so the
  default is "not dispatched": forgetting to handle a case leaves the expensive
  agent off, not on.
- **Concurrent dispatch dedup** (`inFlight`): the `listDispatch` check alone does
  not dedupe — two token requests that both list before either dispatches will
  each dispatch, and the agent ends up running twice in the room.

---

## 3. Block B — Play2Gether

Synchronized choral recording: the host coordinates everyone to record their
voice locally over a shared reference; the server mixes afterwards with ffmpeg.

### 3.1 Robust sync (the big fix)

**Field symptom:** participant takes ran systematically **ahead** of the
reference in the mix.

**Confirmed root cause:** the recorder did `new AudioContext()` +
`await audioWorklet.addModule()` **inside** the clap `setTimeout`, so capture
started a device-variable Δ (tens to hundreds of ms) after the clap. Since the
mix pins takes at offset 0, those missing first milliseconds shove the content
earlier. Evidence: take durations spread ~200 ms, and windowed cross-correlation
of the one clean take showed a **flat** 50–70 ms lead (a fixed offset, not a
growing tempo drift).

**Fix, in three pieces:**

1. **A start gate in the worklet** (`play2gether-capture-worklet.js`): the
   processor discards input until it receives `{cmd:"start"}`.
2. **Prewarm + start-gate in the hook**: the graph (AudioContext + worklet module
   + mic connected) is built during the countdown; at the clap we only flip the
   gate. Capture-start jitter drops to ~1 quantum, uniform across devices.
3. **`captureDelayMs`**: the residual `startedAt − localClapAt` is recorded,
   persisted with the take, and compensated in the mix with an `adelay`.

**Derived regressions, all fixed:**

- **Calibration broke** when the gate was introduced: `runAcousticTrial` has no
  clap, so it must open the gate itself before the marker and click fire.
  Otherwise the buffer stays all-zero and the scan fails with "Internal sync
  marker lost".
- **Prewarm needs the mic already published**, but publishing is serialized
  (`runAudioOp`) and is often still in flight at round start: prewarm found no
  track and bailed permanently. It now retries every 150 ms until the end of the
  take, and the failure is reported to the host (`/api/play2gether/report` →
  `session.failures`) instead of showing up as a take that never arrives.
- **The `LyricsBanner` was stealing capture**: it mounts a second hook instance,
  and because the module-level upload lock lets only one run, when the banner won
  the panel was stuck on the "Uploading…" spinner forever. The banner now passes
  `{ capture: false }` and the panel is the sole owner.

### 3.2 Mix alignment

- **Bidirectional** front shift per take:
  `netDelay = captureDelayMs − hostManualOffset`; `>0` pads with silence
  (`adelay`), `<0` trims (`-ss`).
- `clapOffset` (the device latency estimate, auto or calibrated) is **still not
  auto-applied**: it is unreliable; it is surfaced to the host with an "Apply"
  button.
- Tracks at gain 0 are skipped entirely from the command: `amix` still counted
  them toward `duration=longest` and left a silent tail. Same for a muted
  reference (and in layered sessions the reference *is* a voice, so muting it must
  actually remove it).
- Explicit `NaN` check on `referenceGain`: `Number(x) || 0.5` made a gain of 0
  (host muted the reference) snap back to 0.5.
- The full ffmpeg command and the received gains are logged, to diagnose whether
  the host's faders actually reach the mix and whether their keys line up with
  the take keys in `session.json`.

### 3.3 Mixer and UX redesign

- `GainSlider` reworked into a **channel strip**; unified black + single-accent
  (teal) theme; participant overlay rethemed to match.
- **Per-take waveform with the reference overlaid** on the same time axis: the
  mixer used to be blind and the host aligned by ear. The take is drawn shifted by
  exactly what the mix applies, so "aligned on screen" == "aligned in the mix".
  Shown by default alongside the sync slider.
- **Master card** for the mix, with its own transport.
- **Compact device-latency calibration row**, shared by the host panel and the
  participant overlay.
- **Opt-in metronome** (only when the host sets BPM > 0): clicks phase-locked to
  the clap, count-in during the countdown, never injected into the recording.
- **Reference:** preview with duration, delete and re-record
  (`DELETE /api/play2gether/reference`); the reference stops exactly when the take
  ends (a song longer than the recording duration kept playing).
- Fixed **reference-gain staleness** (now passed directly).

### 3.4 Measurement tool

`scripts/p2g_measure_lag.py <sessionId>` — cross-correlation lag of each take
against the reference, in ms. Negative = the take runs ahead. It documents how to
isolate system fault from human timing: use a click track and do not sing, letting
the reference bleed into the mic (acoustic loopback).

---

## 4. Other changes

- **`.gitignore` fixed:** `./server/.env` never matched anything (a leading `./`
  is not a valid gitignore pattern). Added `node_modules`, `.next`, `out`,
  `__pycache__`, `*.pyc`, `/server/data1`. These were untracked but not ignored,
  so a stray `git add -A` staged them and left ~280 MB of unreachable objects
  behind.
- **`useSharedState`:** the ref is now written together with `setState` instead of
  from an effect. Child effects run before the parent's, so a consumer calling
  `sendChange` as soon as state first arrived read a stale null ref and got a
  spurious "refused".
- **`GazePoseAgent`:** OpenCV and MediaPipe become optional
  (`ENABLE_VIDEO_PROCESSING`, default off); downscaling uses numpy
  nearest-neighbour instead of `cv2.resize`. New `audio_clips` and
  `audio_analysis` tables in the `dataCollection` SQLite, with column migration
  via `PRAGMA table_info`.
- `docs/llm/01-play2gether.md` updated with prewarm/start-gate, the
  calibration-must-open-the-gate rule, the cross-instance locks and the banner's
  `capture: false`.

---

## 5. Technical debt and open fronts

1. **Clipping never fires on real room audio.** It does on the bench; in a room
   `bass_boost` reads ~0.97 on audibly clipped audio. Opus and PulseAudio have
   been ruled out. Next step: `ENABLE_AUDIO_DEBUG` (currently on in
   `docker-compose.dev.yaml` together with `ANALYZER_DEBUG_EVERY_N_WINDOWS=1`) to
   read `avg_rms` — a full-scale clipped signal should read ~0.6–0.7, so a low
   value means something in the capture path attenuates before the analyser — and
   the full per-class probability vector.
2. **`content_type = other` is partly a resampling alias.** The unfiltered
   48 k → 16 k `np.interp` aliases real audio into "other". Proven with the real
   models; deferred.
3. **`ENABLE_DISTORTION_SUGGESTIONS` is still `false`** — detection observes but
   does not interrupt until the thresholds are proven.
4. **`packet_loss` is untrusted** until it is explained why it fired with clean
   WebRTC stats.
5. **Noisy debug is enabled** in `docker-compose.dev.yaml`; turn it off once the
   diagnosis is settled.
6. **Play2Gether: a constant residual offset (~100 ms) remains**, which the host
   dials into the sync slider by hand every session. Diagnosis: it is the
   uncompensated monitoring round-trip (`<audio>` element start + AudioContext
   output buffer + input buffer), not `captureDelayMs`. Neither the auto estimate
   nor the acoustic calibration measures the `<audio>`-element term. Cheap idea:
   the clap is audible and leaks in through the mic, so its transient sits in
   every uploaded WAV at exactly output+input latency; peak-picking it server-side
   would give a real per-take measurement.
7. **Repo weight:** ~102 MB of ONNX models versioned in git (the DAC encoder alone
   is 86 MB), plus a binary `data.db` from `dataCollection`. Worth moving to LFS
   or an external store.
8. **Secrets in the repo:** `server/agents/.env.local` and
   `server/agents/assistantHost/.env.local` carry `LIVEKIT_API_KEY` /
   `LIVEKIT_API_SECRET` in clear and are versioned. `server/agents/.env.local` now
   also points at production (`wss://creativestudio.amplifyproject.eu/live`)
   instead of localhost.
9. Pending authorization audit on the `/api/play2gether/*` routes: they
   authenticate, but do not check that the caller is the host of — or a member of
   — that session.

---

## 6. Constants and environment variables

| Variable | Default | What it controls |
|---|---|---|
| `ENABLE_ONNX_AUDIO_ANALYSIS` | `true` | Whether the analyser is loaded |
| `ENABLE_DISTORTION_SUGGESTIONS` | `false` | Whether a detected mic issue interrupts its owner |
| `ENABLE_AUDIO_DEBUG` | `false` | Periodic frames/RMS/errors log; also enables `ENABLE_ANALYZER_DEBUG` |
| `ENABLE_AUDIO_EVENT_LOG` | `false` | Dumps every published `audio/analysis` event |
| `ANALYZER_SILENCE_RMS_DBFS` | `-55` | Analyser silence gate |
| `DISTORTION_THRESHOLD` | `0.5` | Per-class sigmoid threshold |
| `AUDIO_LOW_LEVEL_DBFS` | `-42` | "Mic too quiet" threshold |
| `AUDIO_MODE_SUGGEST_MIN_SEC` | `5` | Episode length before suggesting a mode |
| `AUDIO_MODE_RESUGGEST_SEC` | `60` | Re-offer within the same episode |
| `AUDIO_MODE_EPISODE_GAP_SEC` | `3` | Gap that ends an episode |
| `AUDIO_CLIP_SUGGEST_MIN_SEC` | `8` | Persistence before warning about a mic |
| `AUDIO_*_HOLD_WINDOWS` | `3` | Consecutive windows for the holds |
| `ANALYZER_DEBUG_EVERY_N_WINDOWS` | `10` | Analyser log cadence |

All of them are logged once at plugin startup: the container mounts the directory
live but Python only reloads on restart, so "which code is actually running" is
the first question whenever a measured delay disagrees with the configured one.
