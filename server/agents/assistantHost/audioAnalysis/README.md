# audioAnalysis

What `plugins/audio_analysis.py` runs on every participant's audio track, once
per 960 ms window.

```
LiveKit track
  → AudioStream(sample_rate=16000, num_channels=1, frame_size_ms=960)
      resampled and downmixed in the Rust SDK; one frame per window
  → silence gate: RMS < −55 dBFS → dropped           (ANALYZER_SILENCE_RMS_DBFS)
  → YAMNet → content_mlp → singing / speech / instrumental / other
  → distortion detector
      speech:          clean / clipping / bass_boost / low_fidelity
      anything else:   clipping only, confirmed by clip_tail
```

## The models

| File | Size | Origin | Licence | In git? |
|---|---|---|---|---|
| `content_mlp.onnx` | 2.6 MB | Trained for this project (PyTorch 2.12.1) | GPLv3, with this repo | **yes** |
| `distortion/distortion_detector.onnx` | 12.6 MB | Trained for this project (Salsa Sound, 2026-10-30) | GPLv3, with this repo; attribution in `distortion/NOTICE.txt` | **yes** |
| `yamnet_model.onnx` | 16 MB | Google YAMNet, converted with `tf2onnx` 1.16.1 | Apache-2.0 | no — fetched |

Get YAMNet with `./scripts/fetch-models.sh` from the repository root.

**YAMNet is not in git** because it is someone else's weights, and shipping
them inside a GPLv3 source tree muddles the licensing.

**The other two are**, because nothing public reproduces them and without them
the analyser has no outputs.

**The distortion detector contains no third-party weights.** Its encoder was
distilled from the Descript Audio Codec encoder (MIT): trained to reproduce
DAC's embeddings, with DAC used only as the teacher. It was trained only on
audio licensed for commercial use (public domain, CC0, CC BY); the datasets are
listed in `distortion/NOTICE.txt`, which must ship with it. It replaced the
previous pair (`dac_encoder.onnx`, 86 MB, plus `distortion_mlp.onnx`), which
cost ~100x more CPU (366 ms per window against 3.8 ms on one thread).

## The content classifier

`content_mlp.onnx` maps a YAMNet embedding to
`["singing", "speech", "instrumental", "other"]`. It was trained on embeddings
of exactly this `yamnet_model.onnx`. **Do not swap in a different YAMNet
export**: a re-export from another `tf2onnx` version can shift the embeddings,
and nothing raises an error — the classifier just gets quieter and wronger.
`fetch-models.sh` verifies the SHA-256 for that reason.

## The distortion detector

`distortion/distortion_detector.onnx` plus `distortion/detector_config.json`.
Per window it returns a softmax over the four classes, plus DSP measurements
that a decision layer (`distortion/distortion_detector.py`) combines with the
model's output:

- **The model's call.** A window counts as distorted if `1 − P(clean) ≥ τ`.
- **Clipping veto.** A clipping call stands only if samples really pile up at
  the waveform's ceiling (`clip_tail`). Loud, bright audio fools the model;
  this check doesn't.
- **Narrowband override** (speech only). About 5 s of speech that stays at or
  below 5 kHz raises low quality, whatever the model says. This is how phone
  bridges, Bluetooth headsets in hands-free mode and starved links get caught.
- **Smoothing.** An alarm needs 3 of the last 5 windows. `distortion_labels`
  is that alarm: at most one class.

The plugin applies its own holds on top (`AUDIO_DISTORTION_TYPE_HOLD_WINDOWS`,
`AUDIO_CLIP_SUGGEST_MIN_SEC`).

**τ** (`DISTORTION_THRESHOLD`) defaults to the bundle's value for a 0.96 s
hop, 0.7. On the real-audio test set (clean speech):

| τ | False alarms per hour | Recall: clipping | Bass boost | Low quality |
|---|---|---|---|---|
| 0.5 | 6.8 | 0.61 | 0.53 | 0.71 |
| **0.7** | **3.0** | **0.56** | **0.33** | **0.69** |
| 0.85 | 1.5 | 0.47 | 0.25 | 0.69 |

### Speech, and everything else

The detector was trained on speech only. On singing or instruments a sustained
bass note reads as bass boost and a bright synth as low quality. But this is a
music app, and clipping is the one problem that matters most while people
sing — so outside speech the detector still runs, and **only clipping counts**
(`ClippingOnlyDecision` in `audio_classifiers.py`): same τ, same clip_tail
veto, same 3-of-5 smoothing, every other class treated as clean, no
narrowband override. `distortion_scope` on the result says which rule ran
(`full` or `clipping`).

Measured 2026-11-02 on two solo singers (Dagstuhl ChoirSet, dynamic mic), a
folk tune set, a drum group and a mixed track, each hard-clipped at five
drives and round-tripped through Opus 64k:

| Drive | Samples clipped | Windows with a clipping alarm |
|---|---|---|
| clean (×1, ×2) | 0% | **0% on all five** |
| ×4 | 0.1–0.8% | 0–3% (missed) |
| ×8 | 5–12% | singing 13–32%, folk set 94% |
| ×16 | 15–39% | singing 50–63% |
| drums | any | never |

bass_boost and low_fidelity both fired on *clean* music (a bass singer reads
as boomy), which is why they stay speech-only. `ANALYZER_MUSIC_CLIPPING=false`
restores speech-only behaviour.

After `ANALYZER_DISTORTION_RESET_AFTER_WINDOWS` (default 3) windows without
speech the speech decision layer is cleared, and likewise the music one after
that many windows without music; silent windows count. A new stretch is judged
on its own.

### Known limits

- Mild clipping is often missed, and clipping on drums is never caught.
- Bass boost is the weakest class. A laptop mic held too close is rarely caught.
- Low quality means narrowband in practice. Wideband audio with codec
  artefacts is mostly missed.
- Speech over an instrument is unreliable: the model, the level and the
  bandwidth all see the mix.
- **Acoustic feedback is not clipping.** A howling feedback loop sounds awful
  but browser AGC/limiting keeps it off the ceiling (seen at −11 dBFS RMS in
  the field), so nothing fires. Detecting feedback would be a separate feature.
- In speech mode the browser's AGC lowers the input before it clips, so
  clipping is far more likely to be seen in music mode.

## Who is told what

Every issue is published on each `audio/analysis` event and shown to the host
(Audio tab, red mic meter for clipping). Only the issues in
`AUDIO_NOTIFY_ISSUES` (default `clipping,low_fidelity,low_level`) also reach
the participant as a suggestion, after `AUDIO_CLIP_SUGGEST_MIN_SEC` (8 s) of
persistence. `bass_boost` is host-only. Set it to `""` for shadow mode. Every
due alert is logged as `mic_issue_due ... notify=True|False`, sent or not, so
a shadow session still counts how often each person would have been
interrupted. During a Play2Gether countdown/recording the client holds all
suggestions (`holdQuiet` on the suggestion bus) and shows them after the take.

## On or off per session

The assistant is **on by default** for every session (`SessionDomain.assistantEnabled`;
absent reads as on, only an explicit `false` turns it off). A host can switch it
off or on in two places, and both act on the running room immediately — the
agent leaves or joins now, not on the next join:

- the session editor (`app/spaces/[spaceId]/sessions`), per session;
- the **On/Off** switch in the host's Audio tab, during the session.

Both go through `app/dbbackend/assistantAgent.ts` (`applyAssistantToRoom`:
dispatch on, or delete the dispatch and remove the agent participant), and
`/api/token` reads the same setting on every join. The API is
`GET/POST /api/sessions/[id]/assistant`, hosts of the session or its space
only.

## Updating the models

**The distortion detector.** Rebuild the bundle in the training repo, then
replace `distortion/` as a whole: `distortion_detector.py`,
`distortion_detector.onnx`, `detector_config.json` and `NOTICE.txt`. The
config's thresholds belong to that model. `tests/python/test_audio_classifiers.py`
checks the class order and window size against the code. Re-run the
music-clipping measurement above before trusting the new build outside speech.

**The content classifier.** Retrain against the exact `yamnet_model.onnx` that
`fetch-models.sh` pins.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DISTORTION_BUNDLE_DIR` | `audioAnalysis/distortion` | Folder with `distortion_detector.onnx` and `detector_config.json` |
| `DISTORTION_THRESHOLD` | bundle's τ (0.7) | `1 − P(clean)` needed for a window to count as distorted |
| `ANALYZER_MUSIC_CLIPPING` | `true` | Run the detector outside speech, clipping only |
| `ANALYZER_DISTORTION_RESET_AFTER_WINDOWS` | `3` | Windows without speech (or music) before that decision layer is cleared |
| `ANALYZER_SILENCE_RMS_DBFS` | `-55` | Silence gate |
| `AUDIO_NOTIFY_ISSUES` | `clipping,low_fidelity,low_level` | Issues that reach the participant; `""` = shadow mode |
| `YAMNET_MODEL_PATH`, `CONTENT_MODEL_PATH` | in this folder | Content classifier models |

`assistant_host.py` also loads `agents/assistantHost/.env.local` with
`load_dotenv`. Variables set there exist only inside the Python process, so
`docker exec … env` does **not** show them — check that file when a flag
seems to be on for no visible reason.

## Cost

Measured in the container on the server, 2026-11-02: the models cost ~1.3% of
a core per audio track. The agent connects audio-only
(`AutoSubscribe.AUDIO_ONLY`); with the default it also subscribed to — and
the SDK decoded — every camera in the room, which cost far more than the
models.
