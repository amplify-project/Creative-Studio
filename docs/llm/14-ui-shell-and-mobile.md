# The session UI shell: control bar, overlays, and mobile

How `/participant` and `/host` are laid out, where transient overlays go, and
the handful of rules that keep the pages usable on a phone. Written after the
2026-09-11 UI pass (PR #68 and #69).

Read this before adding anything that floats over the video, or anything that
anchors to a screen edge.

## The page is a column, not a stage with things on top of it

Both session pages lay out the same way:

```
h-viewport, flex, flex-col
├── stage      flex-1 min-h-0 relative
└── control bar  shrink-0
```

On `/host` that column sits inside the sidebar row (`h-screen flex`), so the
sidebar keeps full height beside it.

`min-h-0` on the stage is load-bearing: without it the grid's `aspect-video`
cells push the column taller than the viewport instead of shrinking.

The controls used to be a `fixed` overlay pinned over the video. That is why
they dimmed until hovered, and why everything anchored to the bottom of the
stage — the pin-layout thumbnail carousel, the Play2Gether lyrics banner — had
hand-tuned offsets to dodge them. All three went away with the overlay. If you
are about to add a `bottom-*` offset to clear the bar, you are re-introducing
a workaround that no longer has a cause.

`MediaControls` keeps a `variant` prop (`"bar" | "floating"`). Both pages pass
`"bar"`; `"floating"` currently has no caller and is kept deliberately,
because which of the two the host wants has already changed once.

### `h-viewport`, not `h-screen`

`100vh` on iOS Safari and Chrome Android measures the viewport *without* the
address bar, so an `h-screen` root is taller than what you can see and its
bottom strip is unreachable behind the browser chrome. `.h-viewport` in
`globals.css` pairs `100vh` with a `100dvh` override — a browser that does not
know `dvh` keeps the first declaration. `.max-h-viewport` is the same pair for
dialogs.

## `ToastLane`: one column for every transient overlay

[components/ui/ToastLane.tsx](../../components/ui/ToastLane.tsx)

Three stacks used to position themselves independently at `top-4` with their
own `right-*`: join/leave toasts, chat toasts, assistant suggestions. On a
desktop window they happened to miss each other. On a phone the assistant
stack is nearly the screen width, so it covered the other two outright.

Fixed offsets cannot fix that — the stacks have dynamic heights, so an offset
that clears two toasts is wrong for three. So the stacks stopped positioning
themselves. `ToastLaneProvider` owns one fixed column and hands out the
element; `ToastLane` portals its children into it and ordinary flex layout
keeps them apart whatever their height.

The lane knows nothing about chat, presence or the assistant. A consumer only
declares a relative `order` (`LANE_ORDER`). Without a provider `ToastLane`
falls back to its own top-right column, so a page that has not adopted it
keeps working.

`pushed` on the provider drops the column below the full-width connection
banners the session pages render at `top-0`. The page owns both, so it is the
right place to know one is showing.

**Add new toasts through the lane.** A fourth independently-positioned stack
puts the count back where it was.

## `ControlPanelContext`: the bar drives the side panel

[components/ui/ControlPanelContext.tsx](../../components/ui/ControlPanelContext.tsx)

The side panel used to own its `open`/`tab` state, which was fine while its
edge tab was the only thing that opened it. The control bar's Chat button is a
**sibling**, so it needs a way to say "open on Chat" without reaching into
another component's `useState`. `unreadChat` travels the other way for the
same reason: the panel counts unread messages, but the badge belongs on the
bar button where someone watching the video will see it.

`useControlPanel()` falls back to real local state (not a stub) when there is
no provider, so the panel still works on a page that forgets to mount one.
`useControlPanelOrNull()` returns `null` there instead — callers that only
*drive* the panel hide their control rather than render a dead button.

## Mobile rules that are easy to undo

All four live in `app/globals.css`, all four are generic utilities.

### Form controls are 16px below `sm`

iOS Safari zooms the whole page when a focused control renders under 16px, and
never zooms back — leaving the user stranded at 2x on a video stage. A single
rule forces 16px under `sm` and bumps `.panel` control padding to a tappable
size.

That rule is **unlayered on purpose**. Tailwind's utilities live in
`@layer utilities`, and unlayered rules outrank every layer, so it wins over a
`text-xs` on the element without `!important`.

The same property is a trap in the other direction: `.pb-safe` is unlayered
too, so it *replaces* a Tailwind `pb-*` rather than adding to it. The control
bar therefore composes its inset inline —
`calc(0.5rem + env(safe-area-inset-bottom, 0px))` — instead of using the
utility. Watch for this whenever an unlayered helper meets a Tailwind spacing
class on the same element.

### Dim-until-hover is gated on a real pointer

`.hover-dim` sits inside `@media (hover: hover) and (pointer: fine)`. A touch
device never fires `mouseenter`, so an unconditional 50% opacity is a control
with no way to restore it — which is exactly what the floating bar was on a
phone.

### Safe areas

The root layout ships `viewport-fit=cover` (`app/layout.tsx`), so the page
paints under the notch and home indicator. Everything anchored to the bottom
edge pays for that with `.pb-safe` / `.mb-safe`, which resolve to 0 elsewhere.
`maximumScale` is deliberately **not** set: pinch-zoom stays available.

### Never truncate what the user has to read

The lyrics banner used `truncate`. On a desktop stage a line of lyrics almost
never reaches the width; in phone portrait it cut nearly every line — the one
thing the singer actually needs. The current line now wraps to two balanced
lines; the prev/next context lines stay single-line, since they are
orientation rather than the words being sung.

## Pre-join audio check

[components/JoinSetup.tsx](../../components/JoinSetup.tsx)

**The mic gets a meter, not a gain slider.** Input gain is an OS setting and
the `volume` capture constraint is honoured by no browser, so the only honest
thing the screen can do is show what the room will hear and say which way to
move. Do not add a gain slider that silently does nothing.

The preview capture uses the same constraints the join will publish with, so
the reading is the processed signal rather than the browser default chain. The
dBFS maths lives in [app/hooks/useMicLevel.ts](../../app/hooks/useMicLevel.ts),
shared with `MicCalibrationPanel` — the two readings have to agree, or a level
set before joining looks different once in session.

Two care points around capture, both from `08-audio-capture-publish-and-mode-switching.md`:
the mic preview is stopped **before** `handleJoin` opens the real track, and
it waits for the device-enumeration probe to release its own capture first.
Two overlapping `getUserMedia` calls is the case that document was written
about; on iOS the second can come back silent.

**Speaker volume is per remote participant.** LiveKit has no room-wide output
volume, so [app/hooks/useOutputVolume.ts](../../app/hooks/useOutputVolume.ts)
re-applies the stored value on `ParticipantConnected` *and* `TrackSubscribed`
— the audio element the volume applies to only exists once the track is
subscribed, which is a separate event and can arrive much later on a slow
link. The preference is per-viewer and per-device, so it lives in
`localStorage` with every access guarded.

The output-device picker uses `setSinkId`, which is Chromium-only. It is
hidden where the API is absent rather than shown doing nothing on Safari. The
test tone is a generated WAV played through an `<audio>` element, because that
is the only thing carrying both `.volume` and `setSinkId`.
