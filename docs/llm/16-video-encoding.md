# Camera capture and encoding: tuned for movement

> **Status: pending review.** Branch `feature/video_motion_quality`
> (commit `e193418`), pushed, no PR yet. Type-checks and unit tests pass;
> **not yet tried on real phones.** See "Before merging" below.

How every camera in the app is captured and encoded, why the defaults favour
frame rate over detail, and how the codec is chosen. Read this before
touching anything that calls `createLocalVideoTrack`, `publishTrack` for
video, or the `Room` constructor's `publishDefaults`.

## What prompted it: the Lab artistic performance (2026-10)

A performance with phones as cameras, outdoors, good light, good network.
Viewers saw some feeds stall whenever the phone moved. Measured from a
screen recording of the participant page (first 20 s, 25 fps recording, so
25 is the ceiling; "new frames" = frames whose crop differs from the previous
one):

| Feed | Source | Mean fps | Worst | Sharpness |
|---|---|---|---|---|
| Irene (panning over foliage) | QR extra camera, 4:3 | 16 | **5–8 fps for ~5 s** | high throughout |
| Patricia (handheld, walking) | QR extra camera, 4:3 | 18 | 10–12 | low |
| Ibra (static, trumpet) | normal participant, 16:9 | 17 | 14 | medium |

The tell is Irene's feed: when the camera panned over leaves and a mural,
the picture **stayed sharp and the frame rate collapsed**. That is an
encoder out of bits — it held quality and dropped frames. For a performance
the opposite trade is wanted.

### Root cause

The two stalling feeds came through the QR "extra camera" page
(`app/publish/PublishClient.tsx`, see doc 13). That page created its room
with a bare `new Room()` and captured 640×480. With no `videoEncoding`,
LiveKit picks `VideoPresets43.h480` = **500 kbps, 20 fps max**. Foliage in
motion is about the worst content a codec sees; 500 kbps cannot carry it.

Three more problems turned up on the way:

1. **The video settings panel did nothing.** `VideoSettingsPanel` collected
   resolution, fps, simulcast and degradation preference, then called
   `onSave={toggleVideo}` — and `toggleVideo()` took no arguments and
   published a bare `{ resolution }` track named `primary`. Every choice was
   discarded. (It does not turn the camera *off*: the panel only opens while
   the camera is off.)
2. **No frame rate was ever requested.** The rooms' `videoCaptureDefaults`
   said 15 fps, but those only apply to `setCameraEnabled()`. Every real
   publish path called `createLocalVideoTrack` with a resolution only, so
   the camera ran at whatever it chose (usually 30).
3. **VP8 on iPhone/iPad is a software encoder.** VP8 was in the first commit
   with no recorded reason — it is LiveKit's default. Encoding three VP8
   layers in software on a phone with a moving picture is CPU the phone does
   not have.

We could not tell from the recording alone whether Irene's phone was
CPU-limited or bitrate-limited; the changes address both. The bug-report
dialog already records `outboundVideo.qualityLimitationReason` (`cpu` /
`bandwidth` / `none`) — ask for a report during the next test to confirm.

## The design

One module decides everything:
[app/utils/videoPublish.ts](../../app/utils/videoPublish.ts).

| Function | Used for |
|---|---|
| `videoCaptureOptions(prefs, {deviceId, facingMode})` | `createLocalVideoTrack` / `restartTrack`. Always includes `frameRate`. `deviceId` wins over `facingMode`. |
| `videoPublishOptions(prefs, name)` | `publishTrack`. Codec, simulcast, top-layer `videoEncoding`, lower layers, `degradationPreference`. |
| `roomVideoDefaults()` | The `Room` constructor in host and participant pages, so `setCameraEnabled(true)` (quality auto-restore, doc 06) encodes the same way. |
| `applyMotionHint(track)` | Sets `mediaStreamTrack.contentHint = "motion"`: the browser prefers keeping fps over detail. Best-effort. |
| `load/saveVideoPrefs`, `load/saveExtraCameraPrefs` | Per-device persistence in `localStorage` (`cs.videoPrefs.v1`, `cs.extraCameraPrefs.v1`), sanitized field by field. |

### Defaults

| | Capture | Top layer | Extra layers | Codec (auto) |
|---|---|---|---|---|
| Desktop | 1280×720 @ 24 | ~2.2 Mbps | 640×360, 320×180 | VP8 |
| Phone (normal participant) | 960×540 @ 24 | ~1.24 Mbps | 320×180 | H.264 on iOS, VP8 on Android |
| QR extra camera | 960×720 @ 24 (still 4:3) | ~1.66 Mbps | 320×240 | H.264 on iOS, VP8 on Android |

All use `degradationPreference: "maintain-framerate"`.

**Bitrate rule:** `width × height × fps × 0.1` bits/s, clamped to
100 kbps – 2.5 Mbps. LiveKit's presets sit nearer 0.05–0.08 bpp, which suits
talking heads; a handheld camera needs more. Lower layers use the same rule
at ≤ 20 fps.

**Phones send one extra simulcast layer, not two**: every layer is another
encode on the CPU that is already the bottleneck when the picture moves.
The QR page also enables `dynacast`, so layers nobody watches are paused.

**The QR page stays 4:3** so the stage tiles keep the shape people know.

### Codec choice

`auto` → H.264 on iPhone/iPad (hardware encoder; iPadOS is detected by
"Mac" + touch points), VP8 everywhere else. Android stays on VP8 because some
Android H.264 hardware encoders mishandle simulcast (black or corrupt
layers) and Firefox on Android is unreliable with H.264. H.264 can still be
picked by hand.

The codec is negotiated at publish time, so changing it means republishing.
Where to pick it:

- **QR extra camera page**: a small "Codec" select under the buttons,
  disabled while the camera is live.
- **Video settings panel** (opens when you turn the camera on): "Codec"
  select. The old "Priority" field, which did nothing, was removed.

Agents (`server/agents/*.py`) receive frames decoded by the LiveKit SDK and
do not depend on VP8.

## Files touched

- `app/utils/videoPublish.ts` — new, the module above.
- `app/publish/PublishClient.tsx` — QR page: prefs, dynacast, codec select.
- `components/MediaControls.tsx` — `publishCamera()`; panel choices applied
  and saved (`startVideoWith`); retry path uses the same options.
- `components/videoSelector.tsx` — `codec` replaces `priority`.
- `components/JoinSetup.tsx`, `app/hooks/useExtraSources.ts` — same options.
- `app/host/page.tsx`, `app/participant/page.tsx` — `...roomVideoDefaults()`.
- `tests/unit/videoPublish.test.ts` — device detection, codec rule,
  bitrates, layers, prefs sanitizing.

## Before merging

1. **Repeat the failing scene.** A phone via QR, panning over foliage, once
   with Auto and once with VP8. Compare fps on the receiving side (the same
   per-tile frame count used above, or the admin bug-report view).
2. **File a bug report from the phone mid-pan** and read
   `qualityLimitationReason` in `/admin/bugs`: `cpu` → codec/layers matter
   most; `bandwidth` → bitrate/resolution; `none` with low fps → the camera
   itself (exposure in low light).
3. **Android with H.264 picked by hand** on the actual devices you will use;
   if any layer comes out black or blocky, leave them on VP8.
4. **Desktop sanity check**: the 720p top layer went from 1.7 to ~2.2 Mbps;
   watch a weak-uplink participant for more frequent layer drops.
5. **Low light**: none of this helps if the phone lengthens exposure and the
   sensor itself delivers fewer frames. Worth checking under stage lighting.

## Open questions

- 24 fps vs 30 for performances: 24 was chosen to leave bits for detail;
  revisit if movement still looks choppy with the new bitrate.
- Should the room (host) be able to push a "performance mode" to everyone,
  instead of per-device prefs? Not done; prefs are per device for now.
- `contentHint` is lost if LiveKit swaps the underlying `MediaStreamTrack`
  (device switch in `MediaControls`); the QR page re-applies it after a flip.
