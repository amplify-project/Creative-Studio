# Extra video sources, the publish queue, and stage entities

How a participant publishes more than one video track — a screen share, one
or more extra cameras — and why the stage can show several tiles for the same
person. Written after the 2026-09-11 UI pass (PR #69), which added the feature
and, in doing so, uncovered three places that had quietly assumed one video
track per participant.

Read this before touching anything that publishes video, or anything that
decides what goes on the main stage.

## The model in one paragraph

A participant's video tracks are distinguished by **`Track.Source`**, never by
participant identity and never by count. The primary camera is
`Source.Camera`. A screen share is `Source.ScreenShare`. Every additional
camera is `Source.Unknown`. The stage keys its tiles by **track**, not by
person, so one participant can occupy three tiles at once.

## Why extra cameras are `Source.Unknown`

The obvious choice — publish a second camera as `Source.Camera` too — breaks
every "is my camera on?" test in the app, because there is then no way to ask
which of the two is *the* camera. `Source.Unknown` sidesteps that, and costs
nothing: `useTracks()`'s default source list is

```
[Camera, Microphone, ScreenShare, ScreenShareAudio, Unknown]
```

(verified in the `@livekit/components-react` bundle). Every bare `useTracks()`
call in this repo therefore picks extra cameras up already — the stage, the
host's `ParticipantList`, the control panel's feed preview — without any of
them being taught that extra cameras exist. That is the point: the mechanism
is generic, and no component learns the feature's name.

`createLocalVideoTrack` sets `source = Camera`, so the source is overwritten
on the track object just before publishing:

```ts
(track as any).source = Track.Source.Unknown;
await room.localParticipant.publishTrack(track, { name: "secondary" });
```

## There is no limit of one extra camera

`useExtraSources` ([app/hooks/useExtraSources.ts](../../app/hooks/useExtraSources.ts))
exposes `extraCameras` / `addCamera(deviceId)` / `removeCamera(trackSid)` —
not a single "second camera" slot. A machine with two USB cameras can publish
both, alongside the primary and a screen share.

The device picker offers only cameras **not already in use**, the primary
included: publishing the same device twice either fails or duplicates a stream
nobody asked for. "In use" is decided by reading
`publication.track.mediaStreamTrack.getSettings().deviceId` off the live
tracks, because nothing else reliably says which device a published track came
from. The hook re-enumerates on `devicechange`, so a camera plugged in
mid-session appears without a reload.

## The publish queue

[app/utils/publishQueue.ts](../../app/utils/publishQueue.ts) —
`runPublishOp(room, lane, fn)`.

`MediaControls` has had a `runAudioOp` promise chain since the duplicate-mic
incident (see `08-audio-capture-publish-and-mode-switching.md`). That chain is
a `useRef`, so it serializes callers **inside that one component** — which was
enough while it was the only thing publishing.

It no longer is. Extra sources publish from the control bar and, historically,
from the control panel. A ref cannot serialize across components, so the chain
moved to module scope, keyed on the `Room` object in a `WeakMap`. Anything
holding the same room queues against the same chain whatever tree it renders
in.

`lane` is `"audio"` or `"video"`, so a mic toggle never waits behind a
screen-share picker the user is still looking at. Operations on one lane run
strictly in order, each reading room state after the previous has settled.

**Use this for any new publish path.** Do not add a second component-local
lock — that is precisely the gap that let this class of bug through twice.

## Capability gating, and why iOS still needs the QR

Neither feature is offered where it cannot work:

- **Screen share** requires `navigator.mediaDevices.getDisplayMedia`, which
  does not exist in Safari on iOS at any version.
- **Extra cameras** require a second video input that is not already in use;
  iOS will not hold two cameras open at once.

Both checks are capability tests, not browser sniffing, and both happen to
hide the buttons on iPhone and iPad. That is why the `/publish` QR flow
([app/publish/PublishClient.tsx](../../app/publish/PublishClient.tsx)) stays:
on iOS it is the only route to a second camera, and it remains useful
everywhere for pointing a phone at an instrument. It is a camera route only —
a phone cannot share a screen, so the page no longer pretends to offer it. The QR lives in the control bar's add-camera menu and
in the control panel's Utils tab; both build it through
[app/hooks/usePublishUrl.ts](../../app/hooks/usePublishUrl.ts) so they cannot
drift about which room they point at.

`/publish` joins as a *separate LiveKit participant* with identity
`<base>-secondary-<rnd>`. In-page sources do not — they publish from the
participant's own connection under their own identity. Both shapes exist in
the wild; code that groups feeds by person must handle both
(`ParticipantControlPanel` does it with `identity.split("-")[0]`).

### One page, one camera

The page used to connect **twice** — a `-secondary-` participant for the
camera and a `-screen-` one for a screen share — and split the phone screen
between two panels. The screen half was removed: the QR is offered as "add a
camera from your phone" in both places it appears, and getDisplayMedia exists
in no mobile browser, Chrome on Android included. A desktop that opens the
link is better served by the in-page share, which does not join a second
participant. One scan is now one connection.

`<base>-screen-<rnd>` therefore has no producer left. The identity regex in
`ParticipantList` still accepts it, deliberately: it costs nothing and the
shape may come back.

What the page does with its one track is worth keeping:

- **Front camera by default**, with a switch button — a phone is usually held
  before it is propped.
- **The flip restarts the track, it does not republish it.** The publication
  keeps its sid, so the host's stage tile neither blinks nor goes through
  entity recovery for a camera that never left.
- It then **reads `getSettings().facingMode` back**. A one-camera device does
  not always reject the constraint; some browsers hand back the same camera
  silently, and a label reading "Back camera" over the front one is worse than
  no button. Desktops report no `facingMode` at all — not a mismatch, just a
  browser with nothing to say.
- **A screen wake lock while publishing.** A phone on a stand gets no touches,
  so it locks on its own timer and the capture stops. Best-effort: absent
  below iOS 16.4, and dropped whenever the page is hidden, so it is
  re-acquired on `visibilitychange`.
- **`live` is re-derived from the room** on `LocalTrackUnpublished`. A camera
  taken by another app must not leave a button claiming to be live.

## Stage entities are per track, not per person

This is the part that broke, and the part most likely to break again.

`useSharedMainStage` was always per-entity: it iterates `state.entities` and
renders one tile per entity, each carrying its own `trackSid`. Several tiles
per participant were always representable.

The host's **add** path was not. `addToMainStage` in
[components/HostContent.tsx](../../components/HostContent.tsx) removed every
other entity whose `participantId` matched before adding the new one. That
line was written to clear the stale entity a republish leaves behind (same
person, new `trackSid`) and enforced one-tile-per-participant only as a side
effect.

It was invisible for as long as extra sources joined under their own
`-secondary-`/`-screen-` identities — different `participantId`, no match. The
moment they began publishing from the participant's own connection, adding a
screen share started silently taking that person's camera off the stage.

It now removes only entities whose `trackSid` is **absent from
`trackBySid`** — i.e. not live. That still does the two things the removal was
for:

- the post-republish zombie is cleared (its sid is dead);
- the audio-only waveform tile gives way to a camera that just arrived — that
  entity's `trackSid` is the participant identity, never a real sid, so it is
  never "live".

…while leaving a live screen share alone.

### The matching hole on the way out

`RoomEvent.TrackUnpublished` only cleaned up when the participant had
**nothing** left published (`remaining === 0`). Ending a screen share while
still on camera therefore orphaned its tile in shared state for good. The
handler now also removes the entity bound to the sid that went away:

```ts
remaining === 0 || (!!deadSid && e?.trackSid === deadSid)
```

### …and the half of it that only the host could hit

`RoomEvent.TrackUnpublished` is **remote-only**. When the *host* stops their
own screen share — their button, or Chrome's "Stop sharing" bar — the only
event the room emits is `RoomEvent.LocalTrackUnpublished`. Nothing removed the
entity, and the symptom was not an orphan tile: the sync effect's recovery pass
took over and the share turned into a second copy of the host's camera. The
picker row disappeared correctly, which made it look like a stage-only bug.

Both events now run the same handler (`LocalTrackUnpublished` passes
`room.localParticipant` as the participant argument).

### The recovery pass must not change what a tile *is*

When an entity's `trackSid` is no longer in `trackBySid`, the sync effect looks
for another video track from the same participant and rebinds the entity to it.
That exists for republishes — music↔speech mode changes hand the same camera a
new sid. But "another video track" was matched on `kind === "video"` alone, so
a share that had just ended happily recovered onto the camera.

Entities now record the `source` they were added with, and recovery only
accepts a candidate of the same source, whose sid no entity already holds.
Entities written before the field default to `Source.Camera` — the republish
case the recovery was written for.

This is also why recovery must not be the thing that hides a missing cleanup:
it will always find *something* to bind to.

### Cleanup patches have to insist

`sendChange` returns `"refused"` while a previous patch is still awaiting its
ack, and these cleanups fire from room events that routinely land right behind
another change. Fired and forgotten, a refused cleanup leaves the tile on stage
for the rest of the session. Both cleanups go through `sendChangeInsisting`,
which retries a refusal a few times; the patches are `remove` ops, which the
applier resolves to `delete`, so replaying one that already landed is a no-op.

### The check that covers this end to end

No compiler covers any of it — it is shared-state logic over live media.

1. Participant on camera → host adds them to the stage.
2. Participant shares their screen → host adds it. **Both visible.**
3. Participant adds a second camera → host adds it. **Three tiles.**
4. Participant ends the share from the browser's own "Stop sharing" bar →
   that tile disappears, the other two stay.
5. Participant refreshes → the stale entity is cleared, not accumulated.
6. **Host** shares their own screen, adds it to the stage, then stops it →
   the tile disappears. It must not become a second copy of the host's camera.

Steps 4 and 5 were fixed without a local reproduction; step 6 was the field
report that followed. Re-run all of them after any change to entity lifecycle.

## Two bugs this uncovered elsewhere

Both predate the feature and were latent for as long as a participant could
only publish one video track.

**`toggleVideo` matched on `kind === Track.Kind.Video`** — *any* video track.
With a screen share live, the camera button reported the camera as on when it
was off, and turning it off unpublished the share as well. It and the
state-sync effect in `MediaControls` now scope to `Source.Camera`.

**`ParticipantList` decided "this track has no audio to mute"** from
`identity.endsWith("-secondary")`. That stopped matching when `PublishClient`
began appending a random suffix, so the host had been offering a mute button
on audioless tracks for a while. It now asks by track source, with the
identity test kept as a regex accepting both spellings.

**The general rule:** never test "does this participant have video" with
`kind === Track.Kind.Video`. Scope to the source you mean.
