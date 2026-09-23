# LLM-oriented project docs

This folder contains documents written for ingestion into an LLM context (e.g.
NotebookLM). They're optimized for an LLM asking "where does X live?",
"why was this implemented this way?", "what should I avoid breaking?".

Recommended upload order to a NotebookLM notebook:

| File | What it covers |
|---|---|
| [00-project-tour.md](00-project-tour.md) | Stack, file map, page entry points, key contexts. Read this first for architecture. |
| [01-play2gether.md](01-play2gether.md) | Play2Gether (synchronized choral recording): hook, capture pipeline, calibration, lyrics, mixer, server endpoints. |
| [02-hand-zoom.md](02-hand-zoom.md) | Hand-zoom agent (Python LiveKit worker + client canvas crop): protocol, easing, simulcast handling, PIP rendering. |
| [03-shared-state.md](03-shared-state.md) | LiveKit shared-state protocol, the `useSharedState` hook, the data-channel command bus, the Python `shared-state-agent`. |
| [04-gotchas-and-patterns.md](04-gotchas-and-patterns.md) | Things that broke and why, design decisions worth NOT reverting, conventions. |
| [06-connection-resilience-and-diagnostics.md](06-connection-resilience-and-diagnostics.md) | Connection-log telemetry, bug-report enrichment, audio subscription watchdog, quality auto-pause hysteresis, publish-error recovery modal. Read this when debugging an incident reported by a tutor. |
| [07-assistant-suggestions.md](07-assistant-suggestions.md) | AI assistant skill/suggestion protocol. Read this when adding a new agent or a new actionable capability. |
| [08-audio-capture-publish-and-mode-switching.md](08-audio-capture-publish-and-mode-switching.md) | Mic capture/publish paths, the duplicate-mic race fix, cross-browser reference recording, music/speech mode switching (republish vs `restartTrack`), and the iOS/WebKit constraint caveat. Read this when debugging "can't hear me" / "mic went quiet" / audio mode issues. |
| [09-assistant-host-offload.md](09-assistant-host-offload.md) | **Deferred plan, nothing implemented.** Moving the `assistant_host` ONNX worker to Fargate: why, the steps, the traps, and the larger cost items left open (stopping the box on a schedule, egress). Read this before touching deployment or agent hosting. |
| [10-calibration-detection.md](10-calibration-detection.md) | How the latency calibration actually measures (differential, digital marker), the window budget and why it is derived, how to read a `p2g_calib` beacon, and the deferred matched-filter rewrite. Also the **calibration round** — everyone measured at once, why the lead-in says "earcup against the mic" rather than "headphones off", and why it seeds the mixer. Read this before touching `runAcousticTrial`. |
| [11-sync-rounds.md](11-sync-rounds.md) | Sync rounds: measuring where a musician puts a beat. **Demoted to a fallback 2026-09-03** — it reads 50–70 ms low (players anticipate a click) so it seeds only where calibration could not measure someone; play a NOTE, never a clap; entering a beat late is the commonest refusal. Read the closing section first. |
| [12-dtw-alignment.md](12-dtw-alignment.md) | Aligning a take against the reference with DTW: the only measurement taken on the take itself, plus the drift curve nothing else can see. Why the band must be narrow and centred, why librosa is not needed on the server, why it is manual, and what the synthetic cross-instrument fixtures proved (including that it beats cross-correlation, and where it doesn't work). |
| [13-video-sources-and-stage-entities.md](13-video-sources-and-stage-entities.md) | Publishing more than one video track per person — screen share and extra cameras — why they are `Source.Unknown`, the per-room publish queue, and why stage entities are keyed per **track** and not per participant. Read this before touching anything that publishes video or decides what goes on the stage. |
| [14-ui-shell-and-mobile.md](14-ui-shell-and-mobile.md) | Layout of the session pages (stage column + control bar), the shared `ToastLane` every transient overlay portals into, `ControlPanelContext`, the pre-join mic/speaker check, and the mobile rules that are easy to undo (`h-viewport`, the 16px form-control floor, safe areas, hover gating). |

Older Spanish technical docs in the parent folder (`../play2gether.md`,
`../sync.md`) predate features like WAV capture, calibration, lyrics, and
the normalized-bbox protocol — use them for historical context only, not
as the source of truth for current behavior. The same goes for
`../protocol_doc.md` (the original state/chat/cmd channel spec, superseded by
03-shared-state.md).

`../feature-distortion_suggestions.md` is a branch write-up rather than a
subsystem reference: what the `feature/distortion_suggestions` work changed and
which fronts it left open. Read it for the *why* behind the audio-analysis
plugin; read the numbered docs above for how things work now.
