import React, { useEffect, useRef, useState } from "react";
import { Room } from "livekit-client";
import { Hand, ArrowLeftRight } from "lucide-react";
import { useCommandBus } from "../app/hooks/useCmdBus";

/**
 * Client-side renderer for the hand-zoom feature. Receives target bboxes
 * from the Python agent via the `cmd` data channel and animates the canvas
 * crop towards them with frame-rate-independent exponential smoothing.
 *
 * Design goals (driven by user feedback that the old direct-assign version
 * felt "abrupt" and "incoherent"):
 *
 *   - Memoria temporal: when packets stop arriving (agent lost the hands),
 *     hold the current zoom for HYSTERESIS_MS before deciding to leave.
 *     Avoids one-frame MediaPipe glitches knocking the camera back to fullframe.
 *   - Smooth interpolation: every animation frame nudges currentBbox toward
 *     targetBbox using `dt`-aware easing, so the perceived motion is smooth
 *     regardless of how often the agent pushes (currently ~6 fps).
 *   - Asymmetric easing: zoom-in is snappier (~400 ms) than zoom-out (~800 ms),
 *     which feels intentional/cinematic rather than reactive/twitchy.
 *   - Center + size interpolation (vs raw corners): the rectangle scales
 *     around its center, no weird corner-morphing when both position and
 *     size change at once.
 */
const HYSTERESIS_MS = 1500;     // keep last zoom this long after losing detection
const ZOOM_IN_TAU_MS = 600;     // exponential time constant when target moves / appears
const ZOOM_OUT_TAU_MS = 1200;   // (only used when ON_HANDS_LOST = "zoomout")
const CLIENT_PAD_RATIO = 0.04;  // 4% padding — tighter crop for chord/fret visibility
/**
 * What to do when MediaPipe stops detecting hands for longer than HYSTERESIS_MS:
 *   - "freeze":  hold the camera at its current zoom forever. Best for musical
 *                performances where the hands briefly leave the detector but
 *                will return to the same spot (pianist's pause, guitarist
 *                reaching for a tuner). No distracting "in-out-in" cycles.
 *   - "zoomout": ease back to the full frame so the viewer sees the whole
 *                scene when the singer is genuinely absent. Closer to the
 *                original behavior; useful when the camera framing is wide
 *                and the performer wanders out of it.
 * The host always has the explicit on/off toggle as the source of truth, so
 * "freeze" doesn't leave a stuck zoom — disabling the feature unmounts this
 * component entirely.
 */
const ON_HANDS_LOST: "freeze" | "zoomout" = "freeze";
// After this long without a fresh bbox from the agent, fade in the "waiting
// for hands" overlay so the viewer understands why the camera stopped
// following — otherwise the frozen image looks like a stall.
const SHOW_LOST_INDICATOR_AFTER_MS = 2000;
// Asymmetric size easing. When the target bbox is BIGGER than what we're
// currently showing (singer spreads hands for a chord) we grow at the normal
// rate so the gesture is captured. When it's SMALLER (hands come back together)
// we shrink at SHRINK_RATIO × the normal rate — this prevents the camera
// from "breathing" rapidly during sustained playing, which is what users see
// as the image "deforming with the movement".
const SIZE_SHRINK_RATIO = 0.5;  // faster zoom-in when hands come together for a chord

type Bbox = { cx: number; cy: number; w: number; h: number };
type PipCorner = "tl" | "tr" | "bl" | "br";

// PIP zoom: small canvas overlay on top of the wide video. Picks the corner
// farthest from the detected hands so the zoom doesn't cover them.
const PIP_W_FRAC = 0.30;                // PIP occupies 30% of tile width
const PIP_MARGIN_PX = 12;
const PIP_CORNER_THROTTLE_MS = 500;     // don't switch corners more often than this
const PIP_CURRENT_CORNER_BONUS = 1.3;   // bias toward staying — avoids flap at ambiguous positions
const PIP_CORNERS: Record<PipCorner, { x: number; y: number }> = {
  tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 },
  bl: { x: 0, y: 1 }, br: { x: 1, y: 1 },
};

function bboxFromCorners(x1: number, y1: number, x2: number, y2: number): Bbox {
  const w = x2 - x1;
  const h = y2 - y1;
  return { cx: x1 + w / 2, cy: y1 + h / 2, w, h };
}

/** Identity bbox in NORMALIZED [0,1] space: covers the whole video. */
function fullframeBbox(): Bbox {
  return { cx: 0.5, cy: 0.5, w: 1, h: 1 };
}

function lerp(a: number, b: number, alpha: number) {
  return a + (b - a) * alpha;
}

function interpolateBbox(current: Bbox, target: Bbox, alpha: number): Bbox {
  // Position eases at the full alpha (camera should follow hands promptly).
  // Size eases asymmetrically: full alpha when growing (capture the gesture),
  // SIZE_SHRINK_RATIO × alpha when shrinking (don't chase every micro-relax).
  // This stops the camera from breathing during sustained piano-style playing.
  const wAlpha = target.w > current.w ? alpha : alpha * SIZE_SHRINK_RATIO;
  const hAlpha = target.h > current.h ? alpha : alpha * SIZE_SHRINK_RATIO;
  return {
    cx: lerp(current.cx, target.cx, alpha),
    cy: lerp(current.cy, target.cy, alpha),
    w:  lerp(current.w,  target.w,  wAlpha),
    h:  lerp(current.h,  target.h,  hAlpha),
  };
}

/**
 * Expand a bbox so its aspect ratio matches `canvasRatio`, keeping the same
 * center. If we ease between two bboxes with mismatched aspects (which is
 * what MediaPipe produces frame-to-frame as fingers stretch), the in-between
 * frames have intermediate aspects → the displayed rectangle morphs.
 * Snapping each target to canvas aspect before easing keeps the easing
 * uniformly-shaped end-to-end → no aspect morphing.
 */
function snapToAspect(b: Bbox, canvasRatio: number): Bbox {
  const sourceRatio = b.w / b.h;
  if (sourceRatio > canvasRatio) {
    return { cx: b.cx, cy: b.cy, w: b.w, h: b.w / canvasRatio };
  }
  return { cx: b.cx, cy: b.cy, w: b.h * canvasRatio, h: b.h };
}

export default function HandVideoCrop({
  room,
  videoTrack,
  user_id: _user_id,
}: {
  room: Room;
  videoTrack: any;
  user_id: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The <video> is the wide main view, rendered full-size in the tile. The
  // canvas paints a cropped/zoomed PIP of the hands in a corner on top.
  // Both are visible simultaneously. The video must remain a meaningful-sized
  // DOM element so LiveKit's adaptiveStream keeps the right simulcast layer
  // subscribed (otherwise the SFU pauses or sends only the lowest layer).
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { subscribe } = useCommandBus();

  // Latest bbox the agent told us about. Updated by the data channel handler.
  // null = no detection yet (or never).
  const targetBboxRef = useRef<Bbox | null>(null);
  // Bbox actually being drawn this frame. Eased toward targetBbox (or toward
  // a fullframe bbox when we decide hands are lost) every animation frame.
  const currentBboxRef = useRef<Bbox | null>(null);
  // performance.now() of the last data-channel payload. Used for hysteresis.
  const lastReceivedAtRef = useRef(0);

  // Visual "waiting for hands" overlay. Driven from the draw loop but only
  // setState'd when the boolean actually changes — keeps the per-frame cost
  // to a couple of comparisons instead of triggering a React re-render every
  // requestAnimationFrame tick.
  const [handsLost, setHandsLost] = useState(false);
  const handsLostRef = useRef(false);

  // PIP corner — auto-switches to the corner farthest from the detected
  // hands so the zoom doesn't cover them. A bonus to the current corner
  // + throttle prevent rapid flapping at ambiguous positions (hands near
  // the middle of the frame).
  const [pipCorner, setPipCorner] = useState<PipCorner>("br");
  const pipCornerRef = useRef<PipCorner>("br");
  const lastCornerSwitchAtRef = useRef(0);
  const [tileSize, setTileSize] = useState({ w: 0, h: 0 });

  // Which view is the main (big) one. Toggle swaps the roles: when zoom is
  // main, the cropped close-up fills the tile and the wide context lives in
  // the PIP. Useful for music lessons where the zoom is the focus.
  const [pipMode, setPipMode] = useState<"wide-main" | "zoom-main">("wide-main");
  // The wide canvas is only used in zoom-main mode (paints the full video
  // frame into the small PIP). Null otherwise (conditionally rendered).
  const wideCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Connect the video track to the in-DOM <video> element using LiveKit's
  // track.attach(). That registers the element as a "consumer" so the SFU
  // keeps the subscription alive at the right simulcast layer. A raw
  // srcObject bypasses that registration → SFU thinks no one is watching →
  // sends only the lowest layer (pixelated in pin) or pauses entirely (black
  // on remote viewers).
  //
  // Depend on the publication's trackSid rather than the videoTrack reference.
  // useTracks() recomputes its TrackReference wrappers on every state update
  // (entity changes, recovery loop patches, etc.), so the videoTrack reference
  // changes constantly even when the underlying media track is the same.
  // Re-running the effect every time triggers detach → attach cycles, and
  // LiveKit's detach() removes the track from the element's MediaStream and
  // sets srcObject = null when the stream is empty → the user sees a brief
  // black flash per re-run, and if a re-run is interrupted, the video stays
  // black until the next state change re-attaches it (random failure).
  //
  // Using trackSid as the dep means: re-run only when the actual track
  // identity changes (republish, kind transition that swaps the track).
  const publicationTrackSid = (videoTrack as any)?.publication?.trackSid;
  useEffect(() => {
    const track = videoTrack?.track ?? videoTrack?.publication?.track;
    const videoEl = videoRef.current;
    if (!track?.mediaStreamTrack || !videoEl) {
      targetBboxRef.current = null;
      currentBboxRef.current = null;
      if (videoEl) videoEl.srcObject = null;
      return;
    }

    // Idempotency: if the video element is already showing this exact track,
    // skip the attach. Avoids unnecessary churn if the effect re-runs and
    // the existing stream is already correct.
    const existing = videoEl.srcObject as MediaStream | null;
    const alreadyAttached =
      !!existing &&
      existing.getTracks().some((t) => t.id === track.mediaStreamTrack.id);

    if (!alreadyAttached) {
      // Configure autoplay/muted BEFORE attach. LiveKit's track.attach()
      // calls .play() internally as part of attaching, and that play() is
      // governed by the browser's autoplay policy. If we set muted/playsInline
      // AFTER attach, the initial play() runs while `muted === false` and
      // the browser may block it silently — the promise is rejected, LiveKit
      // logs a warn, but our code doesn't notice. Result: the <video> is
      // paused indefinitely, videoWidth stays 0, the draw loop returns early,
      // and the canvas never paints (random "zoom black" symptom).
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;

      if (typeof (track as any).attach === "function") {
        (track as any).attach(videoEl);
      } else {
        videoEl.srcObject = new MediaStream([track.mediaStreamTrack]);
      }
      console.log("[HVC] attach", publicationTrackSid, { videoWidth: videoEl.videoWidth, readyState: videoEl.readyState });

      // Belt-and-suspenders: if the initial play() inside attach was still
      // blocked (e.g. the page hasn't received a user gesture yet), retry
      // once the element signals it's ready. Use addEventListener with
      // {once:true} so we don't accumulate handlers across re-attaches.
      const retry = () => {
        console.log("[HVC] retry play on", publicationTrackSid, { videoWidth: videoEl.videoWidth, readyState: videoEl.readyState });
        videoEl.play().catch((e) => console.warn("[HVC] play rejected", publicationTrackSid, e?.name));
      };
      videoEl.addEventListener("loadedmetadata", retry, { once: true });
      videoEl.addEventListener("canplay", retry, { once: true });
    }

    return () => {
      console.log("[HVC] detach", publicationTrackSid);
      if (typeof (track as any).detach === "function") {
        (track as any).detach(videoEl);
      } else if (videoEl) {
        videoEl.srcObject = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicationTrackSid]);

  // Watchdog for the random "zoom black" failure. When the HandVideoCrop
  // mounts on top of a kind=track → kind=hand-zoom transition, there's a
  // moment where the track's attachedElements briefly drops to 0 (between
  // ParticipantTile unmount + our mount). Sometimes the SFU subscription
  // recovers fast; sometimes the <video> stays in a "loading" state with
  // videoWidth === 0 indefinitely. The draw loop returns early in that
  // state → canvas never paints → user sees a black tile.
  //
  // The fix isn't event-driven because no single event is missing —
  // play() resolves, loadedmetadata sometimes fires but videoWidth is
  // still 0. We poll instead: 750 ms of stuck state → retry play();
  // 2 s of stuck state → force a full detach + reattach. Self-clears
  // once frames start flowing.
  const videoTrackRef = useRef(videoTrack);
  useEffect(() => { videoTrackRef.current = videoTrack; }, [videoTrack]);
  useEffect(() => {
    const videoEl = videoRef.current;
    const canvas = canvasRef.current;
    if (!videoEl) return;
    let attempts = 0;
    let wasStuck = false;
    const id = setInterval(() => {
      if (videoEl.videoWidth > 0) {
        if (wasStuck) {
          console.log("[HVC] recovered after stuck", {
            videoWidth: videoEl.videoWidth,
            canvasWidth: canvas?.width,
          });
          wasStuck = false;
        }
        attempts = 0;
        return;
      }
      attempts++;
      if (attempts === 3) {
        wasStuck = true;
        console.warn("[HVC] stuck — retry play", {
          videoWidth: videoEl.videoWidth,
          readyState: videoEl.readyState,
          paused: videoEl.paused,
          canvasWidth: canvas?.width,
          canvasClientWidth: canvas?.clientWidth,
          srcObject: !!videoEl.srcObject,
        });
        videoEl.play().catch((e) => console.warn("[HVC] play retry rejected", e?.name));
      } else if (attempts >= 8) {
        console.warn("[HVC] still stuck — force reattach", { videoWidth: videoEl.videoWidth, readyState: videoEl.readyState });
        const vt: any = videoTrackRef.current;
        const t = vt?.track ?? vt?.publication?.track;
        if (t?.mediaStreamTrack) {
          try { t.detach?.(videoEl); } catch { /* noop */ }
          try { t.attach?.(videoEl); } catch { /* noop */ }
          videoEl.play().catch(() => { /* noop */ });
        }
        attempts = 0;
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Receive bboxes from the agent. We do NOT snap currentBboxRef here —
  // we only update the target so the draw loop interpolates toward it.
  useEffect(() => {
    if (!room || !videoTrack) return;
    const track = videoTrack?.track ?? videoTrack?.publication?.track;

    const unsub = subscribe("zoom", (data: any) => {
      if (data?.track_id !== track?.sid) return;
      if (!data?.hands?.length) {
        // Explicit "no hands" — clear the target so the easing pulls us out.
        targetBboxRef.current = null;
        lastReceivedAtRef.current = performance.now();
        return;
      }

      // Bbox arrives in NORMALIZED [0, 1] coords from the agent, so simulcast
      // layer switches between grid (low-res) and pin (high-res) don't break
      // the mapping. We stay in normalized space and convert to pixels only
      // at drawImage time using the live videoWidth/videoHeight.
      const xs = data.hands.flatMap((h: any) => [h.bbox[0], h.bbox[2]]);
      const ys = data.hands.flatMap((h: any) => [h.bbox[1], h.bbox[3]]);
      let x1 = Math.min(...xs);
      let y1 = Math.min(...ys);
      let x2 = Math.max(...xs);
      let y2 = Math.max(...ys);

      // Padding in normalized space — has the same visual effect regardless
      // of the underlying video resolution.
      const padX = (x2 - x1) * CLIENT_PAD_RATIO;
      const padY = (y2 - y1) * CLIENT_PAD_RATIO;
      x1 = Math.max(0, x1 - padX);
      y1 = Math.max(0, y1 - padY);
      x2 = Math.min(1, x2 + padX);
      y2 = Math.min(1, y2 + padY);

      targetBboxRef.current = bboxFromCorners(x1, y1, x2, y2);
      lastReceivedAtRef.current = performance.now();
    });

    return unsub;
  }, [room, videoTrack, subscribe]);

  // Track wrapper size so the PIP canvas can be sized + positioned in pixels.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => setTileSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Match the canvas backing buffer to its CSS-applied size so drawImage
  // doesn't stretch. The CSS size comes from the inline style on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeCanvas = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    };
    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Draw loop. Runs on every requestAnimationFrame so the easing is smooth
  // (~60 fps) even though agent updates land at ~6 fps. Cost is one
  // drawImage + a handful of multiplications — negligible.
  useEffect(() => {
    let animFrame: number;
    let lastFrameAt = performance.now();

    const draw = (time: number) => {
      animFrame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      // Defensive: keep the canvas backing buffer in sync with its CSS
      // size. The ResizeObserver hooked up in the resize useEffect handles
      // this for explicit size changes, but on the initial mount it can
      // miss the moment when inline style first applies (clientWidth was
      // 0 in the useEffect tick, the observer hasn't fired yet). Writing
      // canvas.width clears the canvas, so we only do it when actually
      // out of sync to avoid stomping painted frames every rAF.
      if (canvas.width !== canvas.clientWidth) canvas.width = canvas.clientWidth;
      if (canvas.height !== canvas.clientHeight) canvas.height = canvas.clientHeight;

      if (!video.videoWidth || !video.videoHeight) return;
      if (!canvas.width || !canvas.height) return;

      const dt = Math.max(1, time - lastFrameAt);
      lastFrameAt = time;

      const vw = video.videoWidth;
      const vh = video.videoHeight;

      // Decide effective target based on memory: if the agent has been silent
      // for too long, drift back toward fullframe — but only after the
      // hysteresis window, so a single missed packet doesn't pop the camera out.
      const sinceReceive = time - lastReceivedAtRef.current;
      const hasFreshTarget =
        targetBboxRef.current !== null &&
        lastReceivedAtRef.current > 0 &&
        sinceReceive < HYSTERESIS_MS;

      // Toggle the "waiting for hands" overlay. Shown when we either never
      // got a bbox (lastReceived == 0 → sinceReceive is "infinity" against the
      // threshold) or haven't gotten one for SHOW_LOST_INDICATOR_AFTER_MS.
      // setState only fires when the boolean flips, not every frame.
      const shouldShowLost =
        lastReceivedAtRef.current === 0 ||
        sinceReceive > SHOW_LOST_INDICATOR_AFTER_MS;
      if (shouldShowLost !== handsLostRef.current) {
        handsLostRef.current = shouldShowLost;
        setHandsLost(shouldShowLost);
      }

      // Pick the raw target before snap. When detection is fresh we follow it.
      // Otherwise behaviour is configurable: either drift back to the full
      // frame, or freeze on the current visible region until detection returns.
      const rawTarget = hasFreshTarget
        ? targetBboxRef.current!
        : ON_HANDS_LOST === "zoomout"
          ? fullframeBbox()
          : (currentBboxRef.current ?? fullframeBbox());

      // Snap the target to the canvas aspect BEFORE easing. Without this, when
      // MediaPipe produces a tall-narrow bbox one frame and a short-wide one
      // the next, the interpolated rectangle passes through intermediate
      // aspects — that's the "image deforming with the movement" singers
      // complained about.
      //
      // We're in normalized [0,1] video space and the displayed region's
      // *pixel* aspect is (bbox.w * vw) / (bbox.h * vh). For zero distortion
      // when drawn onto the canvas that has to equal cw/ch, which means the
      // target normalized aspect is (cw/ch) / (vw/vh).
      const cw = canvas.width;
      const ch = canvas.height;
      const canvasRatio = cw / ch;
      const videoRatio = vw / vh;
      const targetNormRatio = canvasRatio / videoRatio;
      const effectiveTarget = snapToAspect(rawTarget, targetNormRatio);

      // Pick easing speed: snap toward fresh detections, drift slowly back
      // toward the configured "lost" target. In freeze mode the target equals
      // the current bbox, so the easing rate doesn't matter — the interpolation
      // is a no-op visually.
      const tau = hasFreshTarget ? ZOOM_IN_TAU_MS : ZOOM_OUT_TAU_MS;
      const alpha = 1 - Math.exp(-dt / tau);

      const next = currentBboxRef.current
        ? interpolateBbox(currentBboxRef.current, effectiveTarget, alpha)
        : effectiveTarget; // first frame: snap (avoid a from-zero animation)
      currentBboxRef.current = next;

      // PIP corner selection: pick the corner farthest from the hand bbox.
      // Distance is point-to-rectangle (a corner inside the bbox scores 0).
      // Bonus to the current corner avoids flapping when distances are
      // nearly equal; throttle on actual switches keeps the visual smooth.
      const bx1 = next.cx - next.w / 2;
      const by1 = next.cy - next.h / 2;
      const bx2 = next.cx + next.w / 2;
      const by2 = next.cy + next.h / 2;
      let bestCorner: PipCorner = pipCornerRef.current;
      let bestScore = -1;
      for (const c of Object.keys(PIP_CORNERS) as PipCorner[]) {
        const { x: ccx, y: ccy } = PIP_CORNERS[c];
        const dx2 = Math.max(bx1 - ccx, 0, ccx - bx2);
        const dy2 = Math.max(by1 - ccy, 0, ccy - by2);
        const d = Math.hypot(dx2, dy2);
        const score = c === pipCornerRef.current ? d * PIP_CURRENT_CORNER_BONUS : d;
        if (score > bestScore) {
          bestScore = score;
          bestCorner = c;
        }
      }
      if (
        bestCorner !== pipCornerRef.current &&
        time - lastCornerSwitchAtRef.current > PIP_CORNER_THROTTLE_MS
      ) {
        pipCornerRef.current = bestCorner;
        lastCornerSwitchAtRef.current = time;
        setPipCorner(bestCorner);
      }

      // Convert normalized bbox to pixel-space source rect. If the snap
      // expanded the bbox beyond the video edges (e.g. portrait canvas on a
      // landscape video at fullframe), shrink uniformly so aspect is preserved
      // and the source still fits in the actual frame — no clamp distortion.
      let nw = next.w;
      let nh = next.h;
      const sizeScale = Math.min(1, 1 / nw, 1 / nh);
      nw *= sizeScale;
      nh *= sizeScale;
      const ncx = Math.max(nw / 2, Math.min(1 - nw / 2, next.cx));
      const ncy = Math.max(nh / 2, Math.min(1 - nh / 2, next.cy));

      const sx = (ncx - nw / 2) * vw;
      const sy = (ncy - nh / 2) * vh;
      const sw = nw * vw;
      const sh = nh * vh;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);

      // Paint the wide PIP (only used in zoom-main mode). Cover-crop the
      // full frame into the small canvas so its aspect matches the tile's.
      const wideCanvas = wideCanvasRef.current;
      if (wideCanvas) {
        if (wideCanvas.width !== wideCanvas.clientWidth) wideCanvas.width = wideCanvas.clientWidth;
        if (wideCanvas.height !== wideCanvas.clientHeight) wideCanvas.height = wideCanvas.clientHeight;
        const ww = wideCanvas.width, wh = wideCanvas.height;
        if (ww > 0 && wh > 0) {
          const wctx = wideCanvas.getContext("2d");
          if (wctx) {
            const wcr = ww / wh;
            let wsx: number, wsy: number, wsw: number, wsh: number;
            if (videoRatio > wcr) {
              wsh = vh; wsw = vh * wcr;
              wsx = (vw - wsw) / 2; wsy = 0;
            } else {
              wsw = vw; wsh = vw / wcr;
              wsx = 0; wsy = (vh - wsh) / 2;
            }
            wctx.clearRect(0, 0, ww, wh);
            wctx.drawImage(video, wsx, wsy, wsw, wsh, 0, 0, ww, wh);
          }
        }
      }
    };

    animFrame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrame);
  }, []);

  const pipW = Math.round(tileSize.w * PIP_W_FRAC);
  const pipH = tileSize.w > 0 && tileSize.h > 0
    ? Math.round(pipW * (tileSize.h / tileSize.w))
    : Math.round(pipW * 9 / 16);
  const pipLeft = pipCorner === "tl" || pipCorner === "bl"
    ? PIP_MARGIN_PX
    : tileSize.w - pipW - PIP_MARGIN_PX;
  const pipTop = pipCorner === "tl" || pipCorner === "tr"
    ? PIP_MARGIN_PX
    : tileSize.h - pipH - PIP_MARGIN_PX;

  const isWideMain = pipMode === "wide-main";
  const pipTransition = "left 0.5s cubic-bezier(0.4, 0, 0.2, 1), top 0.5s cubic-bezier(0.4, 0, 0.2, 1)";

  return (
    <div ref={wrapperRef} className="relative w-full h-full overflow-hidden bg-black">
      {/* The <video> stays full-size in the layout regardless of mode so
          LiveKit's adaptiveStream keeps the high-quality simulcast layer.
          In zoom-main mode the zoom canvas covers it visually (opacity 0
          on the video would also work but visibility-via-layer-stack is
          enough since the canvas is opaque). */}
      {/* Video is always at full opacity. In wide-main it's the main view;
          in zoom-main it's covered by the zoom canvas BUT acts as a fallback
          while the canvas is still loading (drawImage from a video with no
          metadata is a no-op, so the canvas would be transparent until
          videoWidth>0 — and with no bg-black on the canvas, the user sees
          this video underneath instead of a black tile). */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Zoom canvas — main view when zoom-main, corner PIP when wide-main.
          No bg-black: canvas is transparent until drawImage paints, so the
          underlying <video> shows through during the brief load window. */}
      <canvas
        ref={canvasRef}
        className={`absolute pointer-events-none ${
          isWideMain ? "rounded-lg border-2 border-white/60 shadow-2xl" : ""
        }`}
        style={
          isWideMain
            ? { width: pipW, height: pipH, left: pipLeft, top: pipTop, transition: pipTransition }
            : { inset: 0, width: "100%", height: "100%" }
        }
      />

      {/* Wide PIP canvas — only rendered in zoom-main mode. Painted from the
          full video frame each rAF (see draw loop). No bg-black for same
          reason as the zoom canvas. */}
      {!isWideMain && (
        <canvas
          ref={wideCanvasRef}
          className="absolute rounded-lg border-2 border-white/60 shadow-2xl pointer-events-none"
          style={{ width: pipW, height: pipH, left: pipLeft, top: pipTop, transition: pipTransition }}
        />
      )}

      {/* Swap toggle — top-left, clear of any PIP corner the wide-main mode
          might end up in (its smart corner is one of the four extremes). */}
      <button
        onClick={() => setPipMode((m) => (m === "wide-main" ? "zoom-main" : "wide-main"))}
        className="absolute top-2 left-2 z-20 flex items-center gap-1.5
                   px-2.5 py-1.5 rounded-md
                   bg-black/60 hover:bg-black/80 backdrop-blur-sm
                   text-white text-xs font-medium shadow-lg transition-colors"
        title="Swap zoom and wide views"
      >
        <ArrowLeftRight size={12} />
        <span>{isWideMain ? "Zoom big" : "Wide big"}</span>
      </button>

      {/* "Waiting for hands" overlay — small badge at the bottom. */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none
                   bg-gradient-to-t from-black/50 via-transparent to-transparent
                   flex justify-center pb-4
                   transition-opacity duration-500"
        style={{ opacity: handsLost ? 1 : 0 }}
      >
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full
                        bg-black/60 backdrop-blur-sm text-white text-xs font-medium
                        shadow-lg">
          <Hand className="w-3.5 h-3.5 text-amber-300" />
          <span>Waiting for hands…</span>
        </div>
      </div>
    </div>
  );
}
