"use client";

import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { Rnd } from "react-rnd";
import {
  usePlay2GetherSession, scheduleMetronomeClick, MAX_RECORDING_DURATION_SEC,
  CALIB_ROUND_LEAD_MS, type P2GPhase,
} from "../app/hooks/usePlay2GetherSession";
import { useRoomContext } from "@livekit/components-react";
import { Track } from "livekit-client";
import {
  Music2, Upload, Mic, Play, Pause, Square, StopCircle,
  Timer, Loader2, CheckCircle2, X, Download, Check, ChevronDown,
  Headphones, SlidersHorizontal, Trash2, HelpCircle, Layers, AlertTriangle,
  Volume2, VolumeX, MoreVertical, Activity, Gauge,
} from "lucide-react";
import {
  CalibrationFlow, CalibrationButton, CalibRoundPanel, SPREAD_LIMIT_MS,
} from "./Play2GetherCalibration";
import {
  SYNC_BPM, SYNC_BARS, SYNC_SPREAD_GOOD_MS, SYNC_SPREAD_FAIR_MS,
  syncRoundDurationSec,
} from "../app/lib/p2gSync";
import { useSharedStateContext } from "../app/hooks/useSharedState";
import { outputNode } from "../app/utils/outputBus";

// ─── Small helpers ────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-2">
      {children}
    </p>
  );
}

function NumberField({ label, value, onChange, min, max, disabled }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; disabled?: boolean;
}) {
  const lo = min ?? 1;
  const hi = max ?? 999;
  // <input type="number"> only validates min/max for spinner clicks. Typing
  // an out-of-range value (or clearing the field → NaN) silently flows through
  // to onChange and downstream — e.g. clapAt = serverNow + NaN*1000 = NaN
  // → countdown 0. Clamp on blur so the displayed value always equals the
  // actual stored value before the host clicks "Open Session".
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={lo}
        max={hi}
        disabled={disabled}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (Number.isFinite(raw)) onChange(raw);
        }}
        onBlur={(e) => {
          const raw = Number(e.target.value);
          const clamped = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : lo;
          if (clamped !== value) onChange(clamped);
        }}
        className="w-full bg-zinc-800 text-white text-sm rounded px-2 py-1.5
                   border border-zinc-700 focus:outline-none focus:border-teal-500
                   disabled:opacity-40"
      />
    </label>
  );
}

// ─── Take waveform (static, decoded from the recorded WAV) ─────────────────────
//
// The mixer used to be blind — the host aligned takes by ear with the Sync
// slider. This draws each take's amplitude envelope and, for participant takes,
// overlays the reference (faint) on the SAME time axis so misalignment is
// visible. The take is shifted by the exact amount the mix applies
// (captureDelayMs auto-pad minus the manual Sync offset), so dragging Sync
// slides the waveform live and "aligned on screen" == "aligned in the mix".

type WaveData = { peaks: Float32Array; duration: number };

/**
 * The mixer's shared time axis. One object for every strip, so all takes are
 * drawn on the same window and "lined up on screen" keeps meaning "lined up in
 * the mix" at any zoom.
 */
type TimeView = { startSec: number; spanSec: number };

/** Zoom floor, in ms per pixel. Past this the envelope is being magnified
 *  rather than read — 5 ms/px already matches the fine-tune slider's step. */
const MIN_MS_PER_PX = 2;

function clampView(v: TimeView, totalSec: number, widthPx: number): TimeView {
  const minSpan = (MIN_MS_PER_PX / 1000) * widthPx;
  const span = Math.max(minSpan, Math.min(totalSec, v.spanSec));
  const start = Math.max(0, Math.min(totalSec - span, v.startSec));
  return { startSec: start, spanSec: span };
}

// Decode once per URL (URLs are cache-busted by uploadedAt, so a re-record gets
// a fresh entry). A single shared AudioContext does all decoding.
const waveformCache = new Map<string, Promise<WaveData | null>>();
let decodeCtx: AudioContext | null = null;
function getDecodeCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!decodeCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    decodeCtx = new Ctor();
  }
  return decodeCtx;
}

/**
 * Fetch a take's HIGH-RESOLUTION envelope (`<take>.peaks.bin`) — a float64
 * duration header followed by one byte of amplitude per ~5 ms bucket.
 *
 * This is what makes zooming worth anything. The JSON envelope below is a fixed
 * 900 buckets whatever the take's length, so on a four-minute song each bucket
 * is 267 ms — coarser than the misalignment the host is zooming in to see, and
 * no zoom can recover data that was never sampled. One byte per bucket keeps
 * the finer version smaller in absolute terms than you would guess: a
 * four-minute take is ~48 KB.
 */
async function loadPeaksBin(url: string): Promise<WaveData | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength <= 8) return null;
    const duration = new DataView(buf).getFloat64(0, true);
    if (!(duration > 0)) return null;
    const bytes = new Uint8Array(buf, 8);
    const peaks = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) peaks[i] = bytes[i] / 255;
    return { peaks, duration };
  } catch {
    return null;
  }
}

/**
 * Fetch a take's PRECOMPUTED envelope (`<take>.peaks.json`, ~8 KB), written by
 * the record route at ingest.
 *
 * This exists because the fallback below — download the take and run
 * decodeAudioData on it — costs the whole file. With 10 singers that was
 * ~170 MB pulled into the host's browser purely to draw ten envelopes, before
 * the host had pressed play on anything. Returns null when the take predates
 * this (no peaksFile) or the fetch fails, and the caller decodes instead.
 */
async function loadPeaksJson(url: string): Promise<WaveData | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.peaks) || typeof data?.duration !== "number") return null;
    return { peaks: Float32Array.from(data.peaks as number[]), duration: data.duration };
  } catch {
    return null;
  }
}

async function loadWaveform(url: string, buckets = 900): Promise<WaveData | null> {
  try {
    const ctx = getDecodeCtx();
    if (!ctx) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const audio = await ctx.decodeAudioData(await res.arrayBuffer());
    const ch = audio.getChannelData(0);
    const peaks = new Float32Array(buckets);
    const block = Math.max(1, Math.floor(ch.length / buckets));
    let gmax = 1e-6;
    for (let b = 0; b < buckets; b++) {
      const start = b * block;
      const end = Math.min(ch.length, start + block);
      let mx = 0;
      for (let i = start; i < end; i++) { const a = Math.abs(ch[i]); if (a > mx) mx = a; }
      peaks[b] = mx;
      if (mx > gmax) gmax = mx;
    }
    for (let b = 0; b < buckets; b++) peaks[b] /= gmax; // normalize to [0,1]
    return { peaks, duration: audio.duration };
  } catch {
    return null; // decode unsupported / fetch failed → just render nothing
  }
}

/**
 * Envelope for a track, best available first: the high-resolution sidecar, then
 * the 900-bucket JSON, then decoding the audio outright (takes recorded before
 * either sidecar existed, and the reference, which has no sidecar at all).
 *
 * `enabled` gates the work entirely: in compact mode only the expanded strip
 * draws a waveform, so collapsed rows cost nothing at all.
 */
function useWaveform(url?: string, peaksUrl?: string, binUrl?: string, enabled = true): WaveData | null {
  const [data, setData] = useState<WaveData | null>(null);
  useEffect(() => {
    if (!url || !enabled) { setData(null); return; }
    let alive = true;
    const key = binUrl ?? peaksUrl ?? url;
    let p = waveformCache.get(key);
    if (!p) {
      p = binUrl
        ? loadPeaksBin(binUrl).then((d) => d ?? (peaksUrl ? loadPeaksJson(peaksUrl) : null)).then((d) => d ?? loadWaveform(url))
        : peaksUrl
        ? loadPeaksJson(peaksUrl).then((d) => d ?? loadWaveform(url))
        : loadWaveform(url);
      waveformCache.set(key, p);
    }
    setData(null);
    p.then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [url, peaksUrl, binUrl, enabled]);
  return data;
}

/**
 * Map a track onto the shared view and hand back, per pixel column, the loudest
 * bucket covering it.
 *
 * Per-pixel MAX rather than a point sample. At 900 buckets across a whole song
 * point-sampling was merely lossy; with a 5 ms envelope zoomed out to fit, one
 * pixel spans hundreds of buckets and point-sampling would draw a sparse,
 * flickering mess that changes shape as you pan.
 */
function columnsFor(
  data: WaveData, trackStartSec: number, view: TimeView, widthPx: number,
): Float32Array {
  const cols = new Float32Array(widthPx);
  const n = data.peaks.length;
  const secPerPx = view.spanSec / widthPx;
  for (let x = 0; x < widthPx; x++) {
    const t0 = view.startSec + x * secPerPx - trackStartSec;
    const t1 = t0 + secPerPx;
    if (t1 <= 0 || t0 >= data.duration) { cols[x] = -1; continue; } // outside the track
    const b0 = Math.max(0, Math.floor((t0 / data.duration) * n));
    const b1 = Math.min(n - 1, Math.ceil((t1 / data.duration) * n));
    let mx = 0;
    for (let b = b0; b <= b1; b++) if (data.peaks[b] > mx) mx = data.peaks[b];
    cols[x] = mx;
  }
  return cols;
}

function drawColumns(
  ctx: CanvasRenderingContext2D, cols: Float32Array,
  mid: number, halfH: number, color: string,
) {
  ctx.fillStyle = color;
  for (let x = 0; x < cols.length; x++) {
    const p = cols[x];
    if (p < 0) continue;
    const h = Math.max(0.5, p * halfH);
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
}

/** Mirrored envelope (a closed shape), filled and/or stroked. Used for the
 *  reference behind a take: a faint body plus a crisp contour drawn ON TOP of
 *  the take so it stays visible to align against. */
function drawEnvelopeColumns(
  ctx: CanvasRenderingContext2D, cols: Float32Array,
  mid: number, halfH: number,
  opts: { fill?: string; stroke?: string; lineWidth?: number },
) {
  const yTop = (x: number) => mid - Math.max(0.5, Math.max(0, cols[x]) * halfH);
  ctx.beginPath();
  let started = false;
  for (let x = 0; x < cols.length; x++) {
    if (cols[x] < 0) continue;
    if (!started) { ctx.moveTo(x, yTop(x)); started = true; } else ctx.lineTo(x, yTop(x));
  }
  if (!started) return;
  for (let x = cols.length - 1; x >= 0; x--) {
    if (cols[x] < 0) continue;
    ctx.lineTo(x, mid + (mid - yTop(x)));
  }
  ctx.closePath();
  if (opts.fill) { ctx.fillStyle = opts.fill; ctx.fill(); }
  if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.lineWidth ?? 1.25; ctx.stroke(); }
}

/**
 * One track drawn on the mixer's shared time axis.
 *
 * The take is shifted by exactly what the mix applies (`captureDelayMs` pad
 * minus the manual Sync offset), so dragging slides the waveform live and
 * "aligned on screen" == "aligned in the mix" — at any zoom.
 *
 * Interaction, in the order a host reaches for it:
 *   drag            nudge THIS take (participants only) — the thing you came for
 *   wheel           zoom the shared axis about the cursor
 *   shift + drag    pan the shared axis
 *
 * Nudging is the plain drag rather than the modified one deliberately: it is the
 * only action here that changes the mix, it is the reason the waveform is drawn
 * at all, and a host doing eleven takes under time pressure should not be
 * holding a modifier for it.
 */
function TakeWaveform({
  url, peaksUrl, binUrl, referenceUrl, referencePeaksUrl,
  offsetMs = 0, captureDelayMs = 0, height = 40, isReference = false,
  view, totalSec, onView, onNudge, playheadSec,
}: {
  url?: string;
  peaksUrl?: string;
  /** High-resolution sidecar for `url`, when the take has one. */
  binUrl?: string;
  referenceUrl?: string;
  referencePeaksUrl?: string;
  offsetMs?: number;
  captureDelayMs?: number;
  height?: number;
  isReference?: boolean;
  view: TimeView;
  totalSec: number;
  onView: (v: TimeView) => void;
  /** Called with a delta in ms while dragging. Absent = this row can't be
   *  nudged (the reference), and a plain drag pans instead. */
  onNudge?: (deltaMs: number) => void;
  /** Where playback has reached, in MIX time (not take time), or null when
   *  nothing is playing. Shared across the mixer, so pressing play on the
   *  reference draws the line through every take at once — which is the whole
   *  point: you are checking alignment, and a line on one strip cannot show
   *  you that. */
  playheadSec?: number | null;
}) {
  const take = useWaveform(url, peaksUrl, binUrl);
  const ref = useWaveform(referenceUrl, referencePeaksUrl);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The playhead gets its OWN canvas, stacked over the envelope. Redrawing the
  // envelope on every animation frame would mean recomputing per-pixel maxima
  // over a 48,000-bucket envelope, for every strip, sixty times a second. This
  // one only ever clears a rectangle and draws a line.
  const headRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(280);
  // Live drag bookkeeping. Refs, not state: a drag repaints through the parent's
  // offset already, and re-rendering on every mousemove to store a pixel would
  // drop frames on a ten-strip mixer.
  const dragRef = useRef<{ x: number; pan: boolean; startSec: number; acc: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 280));
    ro.observe(el);
    setW(el.clientWidth || 280);
    return () => ro.disconnect();
  }, []);

  const netDelayMs = Math.max(0, Math.round(captureDelayMs)) - Math.round(offsetMs);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !take) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w)), H = height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;
    const halfH = H / 2 - 1;
    const pxPerSec = W / view.spanSec;

    // Beat-free time gridlines, spaced so they stay readable at any zoom.
    const stepSec = gridStepSec(view.spanSec);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let t = Math.ceil(view.startSec / stepSec) * stepSec; t < view.startSec + view.spanSec; t += stepSec) {
      ctx.fillRect(Math.round((t - view.startSec) * pxPerSec), 0, 1, H);
    }

    if (ref) {
      drawEnvelopeColumns(ctx, columnsFor(ref, 0, view, W), mid, halfH,
        { fill: "rgba(143,150,249,0.16)" });
    }
    // Clap / t=0 marker (where the reference starts).
    if (view.startSec <= 0 && view.startSec + view.spanSec >= 0) {
      ctx.fillStyle = "rgba(251,92,114,0.55)";
      ctx.fillRect(Math.round((0 - view.startSec) * pxPerSec), 0, 1, H);
    }
    drawColumns(ctx, columnsFor(take, netDelayMs / 1000, view, W), mid, halfH,
      isReference ? "rgba(143,150,249,0.92)" : "rgba(45,212,191,0.7)");
    if (ref) {
      drawEnvelopeColumns(ctx, columnsFor(ref, 0, view, W), mid, halfH,
        { stroke: "rgba(165,172,255,0.95)", lineWidth: 1.5 });
    }
  }, [take, ref, netDelayMs, w, height, isReference, view]);

  useEffect(() => {
    const canvas = headRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w)), H = height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (playheadSec == null) return;
    const x = ((playheadSec - view.startSec) / view.spanSec) * W;
    if (x < 0 || x > W) return;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(Math.round(x), 0, 1, H);
  }, [playheadSec, view, w, height]);

  // Wheel goes on as a NATIVE listener with `passive: false`. React attaches
  // wheel handlers to the root passively, so `preventDefault` inside an onWheel
  // prop is silently ignored and zooming would scroll the host panel away under
  // the cursor at the same time.
  //
  // Latest-state-in-a-ref rather than re-binding the listener on every view
  // change: re-subscribing on each wheel tick is how a zoom gesture ends up
  // dropping events halfway through.
  const wheelState = useRef({ view, totalSec, w, onView });
  wheelState.current = { view, totalSec, w, onView };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, totalSec: total, w: width, onView: emit } = wheelState.current;
      const rect = el.getBoundingClientRect();
      if (e.shiftKey) {
        emit(clampView({ ...v, startSec: v.startSec + (e.deltaY / 200) * v.spanSec }, total, width));
        return;
      }
      // Zoom about the cursor: the instant under the pointer stays put, which is
      // what makes it possible to home in on one transient instead of hunting.
      const frac = (e.clientX - rect.left) / Math.max(1, rect.width);
      const anchor = v.startSec + frac * v.spanSec;
      const span = v.spanSec * (e.deltaY > 0 ? 1.25 : 0.8);
      emit(clampView({ startSec: anchor - frac * span, spanSec: span }, total, width));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Clicking a take arms the arrow keys for it. A div with tabIndex focuses on
    // mousedown in most browsers but not reliably across all of them, and the
    // whole point is that you drag roughly into place and then finish with the
    // keys without hunting for a second control.
    wrapRef.current?.focus();
    dragRef.current = {
      x: e.clientX,
      // Pan on the RIGHT button as well as on shift-drag. Zoomed in to a few
      // ms/px the two gestures a host alternates between are "move this take"
      // and "look somewhere else", and putting the second one on a modifier
      // meant holding shift for most of the work. The right button is free
      // here — a canvas has no text selection and no native menu worth
      // keeping — and it is the gesture every DAW and map already uses.
      pan: e.shiftKey || e.button === 2 || !onNudge,
      startSec: view.startSec,
      acc: 0,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (d.pan) {
      onView(clampView(
        { ...view, startSec: d.startSec - (dx / Math.max(1, w)) * view.spanSec }, totalSec, w));
      return;
    }
    // Dragging RIGHT moves the take later on screen, which is a smaller Sync
    // offset (the mix pulls by `offsetMs`). Accumulate sub-step motion so a slow
    // drag at high zoom doesn't quantise to nothing.
    const msPerPx = (view.spanSec * 1000) / Math.max(1, w);
    d.acc += dx * msPerPx;
    d.x = e.clientX;
    const steps = Math.trunc(d.acc / SYNC_SLIDER_STEP_MS);
    if (steps !== 0) {
      d.acc -= steps * SYNC_SLIDER_STEP_MS;
      // A DELTA, applied functionally upstream. Adding it to a captured
      // `offsetMs` here would read whatever value this render closed over, and a
      // fast drag fires several moves before React re-renders — every one of
      // them starting from the same stale base and stomping the last.
      onNudge!(-steps * SYNC_SLIDER_STEP_MS);
    }
  };
  const endDrag = () => { dragRef.current = null; };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!onNudge) return;
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();   // otherwise the mixer scrolls sideways under the strip
    // Right = later on screen = a smaller Sync offset, the same mapping the
    // drag uses; the two controls must agree or one of them feels inverted.
    onNudge(-dir * (e.shiftKey ? SYNC_KEY_COARSE_MS : SYNC_SLIDER_STEP_MS));
  };

  if (!url) return null;
  return (
    <div
      ref={wrapRef}
      className="w-full touch-none select-none rounded-sm outline-none
                 focus-visible:ring-1 focus-visible:ring-teal-400/70"
      style={{ cursor: onNudge ? "ew-resize" : "grab" }}
      tabIndex={onNudge ? 0 : undefined}
      role={onNudge ? "slider" : undefined}
      aria-label={onNudge ? "Take sync offset — arrow keys to nudge" : undefined}
      aria-valuenow={onNudge ? Math.round(offsetMs) : undefined}
      aria-valuemin={onNudge ? -SYNC_SLIDER_MAX_MS : undefined}
      aria-valuemax={onNudge ? SYNC_SLIDER_MAX_MS : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // Without this the browser menu opens on top of the pan the host just
      // started, and the pointer capture is lost under it.
      onContextMenu={(e) => e.preventDefault()}
      title={onNudge
        ? `Drag to nudge this take · ← → nudge ${SYNC_SLIDER_STEP_MS} ms ` +
          `(shift ${SYNC_KEY_COARSE_MS} ms) · wheel to zoom · right-drag or shift-drag to pan`
        : "Wheel to zoom · drag to pan"}
    >
      {take
        ? (
          <div className="relative" style={{ height }}>
            <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} />
            <canvas
              ref={headRef}
              className="absolute inset-0 pointer-events-none"
              style={{ width: "100%", height, display: "block" }}
            />
          </div>
        )
        : <div style={{ height }} className="w-full rounded bg-zinc-800/60 animate-pulse" />}
    </div>
  );
}

/**
 * The drift of one take's alignment over its own length.
 *
 * Small, and the only genuinely new thing DTW produces. A calibration round and
 * a sync round both answer "how late is this person", once, before the take
 * exists; neither can see that a player starts 130 ms late and ends 90 ms late,
 * which is a take that HAS no single correct offset. Drawn as a line rather
 * than reported as a range because the shape is the information: a ramp is a
 * player speeding up, a step is something that changed, scatter is a soft
 * measurement.
 */
function DriftSpark({ drift, height = 20 }: {
  drift: { tSec: number; lagMs: number }[]; height?: number;
}) {
  if (drift.length < 2) return null;
  const lags = drift.map((d) => d.lagMs);
  const lo = Math.min(...lags), hi = Math.max(...lags);
  const span = Math.max(hi - lo, 10);          // never magnify pure noise
  const W = 100;
  const pts = drift.map((d, i) => {
    const x = (i / (drift.length - 1)) * W;
    const y = height - 2 - ((d.lagMs - lo) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={
      drift.map((d) => `${d.tSec}s: ${d.lagMs > 0 ? "+" : ""}${d.lagMs}ms`).join("\n")}>
      <svg width={W} height={height} className="overflow-visible" aria-hidden>
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2"
                  className="text-violet-300/80" />
      </svg>
      <span className="text-[10px] text-zinc-500 tabular-nums">
        {Math.round(lo)}…{Math.round(hi)} ms
      </span>
    </span>
  );
}

/**
 * The DTW row in a take's fine-tune drawer.
 *
 * Third opinion, and deliberately the one you have to ask for. The other two
 * measurements are rounds: they run once for everybody and their numbers are
 * simply there. This one runs against a specific take, costs a couple of
 * seconds of server CPU, and — this is the part that keeps it manual — its
 * failure mode is a CONFIDENT answer a beat out on periodic material. A number
 * you pressed a button for is a number you look at; one that appears on its own
 * is one you trust.
 *
 * What it is worth having anyway: it is the only one of the three that measures
 * the take rather than a proxy for it, and the only one that can show drift.
 */
function AlignRow({ alignment, onAnalyse, analysing, takeFile, takeUploadedAt, slider, onOffsetChange }: {
  alignment?: ServerAlignment;
  onAnalyse?: () => void;
  analysing?: boolean;
  takeFile?: string;
  /** When the take under this row arrived. See `stale`. */
  takeUploadedAt?: number;
  slider: number;
  onOffsetChange?: (ms: number) => void;
}) {
  if (!onAnalyse) return null;

  // A stored alignment describes the take it was computed from.
  //
  // Comparing FILENAMES is not enough and that was a real bug: take keys and
  // filenames are reused, so deleting a take and recording it again gives the
  // new performance the old one's name, the old alignment matched it, and the
  // row showed a number measured from audio that no longer existed — with no
  // Align button, because the button only appears when there is nothing to
  // show. The upload time is the honest test: an alignment measured before the
  // take arrived cannot be about that take. (The server now also drops the
  // alignment when a take is deleted or replaced; this is the half that does
  // not depend on the session having been rewritten.)
  const stale = !!alignment && (
    (!!takeFile && alignment.takeFile !== takeFile)
    || (!!takeUploadedAt && alignment.measuredAt < takeUploadedAt)
  );

  if (analysing) {
    return (
      <span className="inline-flex items-center gap-1.5 self-start text-violet-300/80">
        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
        Aligning this take against the reference…
      </span>
    );
  }

  if (!alignment || stale) {
    return (
      <button
        type="button"
        onClick={onAnalyse}
        className="inline-flex items-center gap-1.5 self-start text-left text-violet-300 hover:underline"
        title="Warps this take against the reference and reports how late it sits, plus how that changes over the take. A couple of seconds."
      >
        <Activity className="w-3 h-3 shrink-0" />
        {stale ? "Re-align this take (the take changed)" : "Align this take against the reference"}
      </button>
    );
  }

  const applied = slider === clampToSlider(alignment.offsetMs);
  // Colour on the SCATTER, never on the offset — the same rule the sync card
  // follows. A large offset is a slow monitoring path and is corrected exactly;
  // a large MAD means the warping path never settled, and no single slider
  // position places this take.
  //
  // 40 ms is not a guess. On the fixture set (`scripts/p2g_dtw_fixtures.py`),
  // the worst error among results with a MAD at or under 40 was 25.5 ms, and
  // the lowest MAD among results wrong by more than 60 ms was 52.2 — so there
  // is a gap, and this sits in it. The scorer prints both numbers; if they ever
  // cross, this threshold has stopped separating anything and has to move.
  const soft = alignment.madMs > 40;

  // The caveats used to be four stacked paragraphs — around sixty words under a
  // single number, on every take, which pushed the next strip off screen and
  // got skipped for exactly that reason. Each one is now a couple of words
  // carrying its full old text in the tooltip, on one line, worst first.
  const flags: { label: string; title: string; strong: boolean }[] = [];
  if (alignment.driftRangeMs > 60) {
    flags.push({
      label: `drifts ${Math.round(alignment.driftRangeMs)} ms`,
      strong: true,
      title: `This take drifts ${Math.round(alignment.driftRangeMs)} ms from start to end, so `
        + `no single slider position places all of it. Worth hearing before spending time on `
        + `the number.`,
    });
  }
  if (soft) {
    flags.push({
      label: `soft ±${Math.round(alignment.madMs)}`,
      strong: true,
      title: `The warping path scattered ±${Math.round(alignment.madMs)} ms, so this alignment `
        + `is soft. On repetitive material DTW can settle a beat out and still look confident — `
        + `check it against the calibration figure before trusting it.`,
    });
  }
  if (alignment.atBandEdge) {
    flags.push({
      label: "at the search edge",
      strong: true,
      title: "The result sat against the edge of the search range, so the real delay may be "
        + "larger than this.",
    });
  }
  if (!alignment.centred) {
    flags.push({
      label: "blind",
      strong: false,
      title: "This player has no calibration or sync round, so the search had nothing to centre "
        + "on and had to be twice as wide. On the fixture set that costs about half the "
        + "accuracy — measure them and re-run for a better answer.",
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => onOffsetChange!(clampToSlider(alignment.offsetMs))}
        disabled={applied}
        className={`inline-flex items-center gap-1.5 self-start text-left rounded
                    disabled:cursor-default enabled:hover:underline
                    ${soft ? "text-amber-300" : "text-violet-300"}`}
        title={`DTW against the reference: musical events land ${alignment.lagMs} ms later in `
          + `this take than in the reference, with a ${alignment.madMs} ms scatter along the `
          + `warping path (feature: ${alignment.feature}).`}
      >
        <Activity className="w-3 h-3 shrink-0" />
        DTW {alignment.offsetMs > 0 ? "+" : ""}{Math.round(alignment.offsetMs)} ms
        {" ±"}{Math.round(alignment.madMs)}
        {" · "}{applied ? "applied" : "apply"}
      </button>
      {alignment.drift.length > 1 && (
        <div className="flex items-center gap-2">
          <DriftSpark drift={alignment.drift} />
          <button type="button" onClick={onAnalyse}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 shrink-0">
            re-run
          </button>
        </div>
      )}
      {flags.length > 0 && (
        <p className="text-[10px] leading-snug text-zinc-500 flex flex-wrap gap-x-1.5">
          {flags.map((f, i) => (
            <span key={f.label} className={f.strong ? "text-amber-200/70" : undefined}
                  title={f.title}>
              {i > 0 && <span className="text-zinc-700 mr-1.5">·</span>}
              {f.label}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** Gridline spacing that keeps roughly 4–10 lines on screen at any zoom. */
function gridStepSec(spanSec: number): number {
  const raw = spanSec / 6;
  const steps = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s >= raw) ?? 600;
}

/**
 * Sync round — the fallback measurement, for people acoustic calibration could
 * not reach.
 *
 * Withdrawn from the flow on the morning of 2026-09-03 and back the same
 * afternoon in a smaller role, because one thing about it changed and one thing
 * did not.
 *
 * **What changed: what you play.** The round used to say "the sharpest attack
 * the instrument has… a pad patch does not measure; clap instead", which reads
 * as "a clap is the safe default". From the field: *"según qué nota del piano va
 * mejor, con palmadas va mal"*. Both halves are explained by things already in
 * doc 11 and never connected. A hand clap is the least steady thing a person can
 * produce — the steadiest measured here was ±12 ms, against a good drummer's ±5
 * — and it is broadband, exactly like the click, so on a laptop it competes with
 * the metronome's own bleed for the energy vote. One note held on a pitched
 * instrument is steadier AND spectrally distinct from the click. So the card now
 * asks for a note, and mentions a clap only as the last resort it is.
 *
 * **What did not change: it reads low.** Three measurements, all one direction
 * (82 against a click at 99.8; 85 against a calibration of 135 and a hand
 * alignment of 135; ~60 against a calibration of ~130). Players anticipate a
 * steady click, and anticipating cancels part of the latency being measured. So
 * this is a FALLBACK, below the calibration round in the seeding order, and the
 * card says so rather than pretending the two are interchangeable.
 *
 * It is the only thing that measures the player at all, which is why it earns a
 * place at all: `spreadMs` answers "can this person hold a beat", and nothing
 * else asks.
 */
function SyncRoundCard({ results, calibResults, onRun, busy, running, participantCount }: {
  results: Record<string, ServerSyncOffset>;
  /** Who the calibration round already measured. This card exists for the
   *  others, so it says how many those are rather than making the host compare
   *  two lists by eye. */
  calibResults: Record<string, ServerCalibOffset>;
  onRun: () => void;
  busy: boolean;
  running: boolean;
  participantCount: number;
}) {
  const [open, setOpen] = useState(false);
  const rows = Object.entries(results).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const measured = rows.length;
  const calibrated = Object.keys(calibResults).length;
  const missing = Math.max(0, participantCount - calibrated);

  const band = (spreadMs: number) =>
    spreadMs <= SYNC_SPREAD_GOOD_MS ? { c: "text-emerald-400", t: "steady" }
    : spreadMs <= SYNC_SPREAD_FAIR_MS ? { c: "text-amber-300", t: "loose" }
    : { c: "text-rose-400", t: "unsteady" };

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-800/30 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <Activity className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        <span className="text-[13px] font-semibold text-zinc-200">Sync round</span>
        <span className="text-[10px] text-zinc-500 shrink-0">fallback</span>
        {measured > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
            {measured} measured
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-[11px] text-zinc-400 hover:underline shrink-0 inline-flex items-center gap-1"
        >
          {open ? "hide" : "what to play"}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      <p className="text-[11px] leading-snug text-zinc-400">
        {missing > 0
          ? `${missing} of ${participantCount} have no calibration — this can measure them.`
          : "Everyone has a calibration. Run this only if one of those numbers looks wrong."}
      </p>

      {open && (
        <div className="text-[11px] leading-relaxed text-zinc-400 border border-dashed border-zinc-700 rounded-lg p-2 flex flex-col gap-1.5">
          <p>
            Everyone at once, headphones ON (the opposite of a calibration round).
            One bar of <strong className="text-zinc-200">count-in</strong>, then{" "}
            <strong className="text-zinc-200">{SYNC_BARS} bars of one note per click</strong>.
            About {Math.round(syncRoundDurationSec())}s at {SYNC_BPM} BPM.
          </p>
          <p className="text-zinc-300">
            <strong>Play a NOTE, not a clap.</strong> One note on a pitched
            instrument, repeated — a key, a plucked string, a tongued staccato. A
            clap is the least steady thing a hand can do and it sounds like the
            click, so on a laptop the round can measure the metronome instead of
            you. Clap only if the instrument genuinely has no attack.
          </p>
          <p className="text-amber-200/70">
            <strong className="text-amber-200">Nobody plays during the count-in.</strong>{" "}
            Four clicks, then everyone comes in on the next accent — the ordinary
            &ldquo;1, 2, 3, 4&rdquo;. Coming in on the wrong click is the round&apos;s worst
            failure: against a steady click it is indistinguishable from an enormous
            monitoring delay, so it refuses rather than guessing which beat you were on.
          </p>
          <p className="text-zinc-500">
            It reads LOW, always — people anticipate a steady click, and
            anticipating cancels part of the delay being measured. In testing it
            came back 50–70 ms under the device figure. Use it where there is no
            calibration, not to overrule one.
          </p>
          <p className="text-zinc-500">
            <strong className="text-zinc-400">Run it twice and keep the second</strong>;
            the first measures someone learning the task. The scatter is the half
            worth reading: a player at ±40 ms has no single correct offset.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {rows.map(([id, r]) => {
            const b = band(r.spreadMs);
            return (
              <div key={id} className="flex items-center gap-2 text-[11px] px-0.5 py-0.5">
                <span className="truncate min-w-0 flex-1 text-zinc-300" title={r.name}>{r.name}</span>
                <span className="font-mono tabular-nums text-zinc-100 shrink-0">
                  {r.offsetMs > 0 ? "+" : ""}{r.offsetMs} ms
                </span>
                <span className={`font-mono tabular-nums shrink-0 ${b.c}`} title={`Per-beat scatter (MAD) — ${b.t}`}>
                  ±{r.spreadMs}
                </span>
                <span className="tabular-nums text-zinc-500 shrink-0 w-10 text-right">{r.hits}/{r.expected}</span>
                {calibResults[id] && (
                  <span
                    className="shrink-0 text-[10px] text-zinc-600 tabular-nums"
                    title={`Calibration says ${calibResults[id].latencyMs} ms for this device. `
                      + `The gap is how far ahead of the click this player sits — it is not an error `
                      + `in either number, and the calibration is the one that seeds the mixer.`}
                  >
                    calib {calibResults[id].latencyMs}
                  </span>
                )}
                {r.atSearchEdge && (
                  <span
                    className="shrink-0 leading-none"
                    title="The measurement sat against the edge of what can be measured — the real delay may be larger. Check for Bluetooth audio."
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-400" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={onRun}
        disabled={busy || running}
        className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg
                   bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50
                   text-[13px] font-medium transition-colors"
      >
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
        {running ? "Measuring…" : measured > 0 ? "Run sync round again" : "Run sync round"}
      </button>
    </div>
  );
}

/**
 * Calibration round — the device half of the alignment, measured on everyone at
 * once.
 *
 * This is the acoustic calibration that has existed all along, with the one
 * thing changed that was actually wrong with it: who starts it. As a per-person
 * button it was something each musician had to remember, understand and get
 * right on their own, and on 2026-08-31 three of eleven simply never pressed
 * it. As a round the host presses once, everybody is measured in fifteen
 * seconds, and the host can see at a glance who came back with a number.
 *
 * **Why it seeds the mixer and the sync round now only fills the gaps.** From
 * the field, 2026-09-03, same person and same take: calibration said 135 ms,
 * the sync round said 85 ±5, and lining the take up against the reference by
 * hand said 135. Doc 11 predicted exactly this and read it the other way up —
 * a sync round measures the device PLUS how the player sits against the click,
 * and a player who has settled into a metronome ANTICIPATES it, which cancels
 * part of the very latency being measured. The human term does not transfer
 * from a click to a song, so including it subtracts something real.
 *
 * The sync round stays, and is still the only thing that measures the player:
 * it fills in anyone whose mic could not hear the click, and its scatter is
 * still the honest answer to "can this person hold a beat at all".
 */
function CalibRoundCard({ results, onRun, onClear, busy, participantCount }: {
  results: Record<string, ServerCalibOffset>;
  onRun: () => void;
  onClear: (participantId: string) => void;
  busy: boolean;
  participantCount: number;
}) {
  const [open, setOpen] = useState(false);
  const rows = Object.entries(results).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const measured = rows.length;

  return (
    <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.06] p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <Gauge className="w-3.5 h-3.5 text-sky-300 shrink-0" />
        <span className="text-[13px] font-semibold text-zinc-100">Calibration round</span>
        <span className="text-[10px] text-zinc-500 shrink-0">seeds the mixer</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
          {measured > 0 ? `${measured} measured` : "not run"}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-[11px] text-sky-300 hover:underline shrink-0 inline-flex items-center gap-1"
        >
          {open ? "hide" : "what happens"}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="text-[11px] leading-relaxed text-zinc-400 border border-dashed border-zinc-700 rounded-lg p-2 flex flex-col gap-1.5">
          <p>
            Everyone at once. Each device plays five clicks and finds them with its
            own mic; the gap is that device&apos;s round-trip latency. Nothing is
            recorded and nothing is uploaded — about
            {" "}{Math.round((CALIB_ROUND_LEAD_MS + 9000) / 1000)}s in total.
          </p>
          <p className="text-amber-200/70">
            <strong className="text-amber-200">Everyone holds one earcup against
            their mic</strong>, headphones still on. That is not a workaround for
            not having speakers — it is the point: it measures the output they
            actually play through, which is the whole reason this number places a
            take. Someone who cannot reach can take them off instead, and their
            number then describes their speakers rather than their headphones.
            Each person gets a {Math.round(CALIB_ROUND_LEAD_MS / 1000)}s warning on
            their own screen; say it out loud too.
          </p>
          <p className="text-zinc-500">
            Quiet room, normal listening level. Each person&apos;s number is
            applied to their takes automatically — including takes already
            recorded, unless you have moved that slider by hand.
          </p>
          <p className="text-zinc-500">
            This measures the DEVICE, with nobody playing. That is why it is the
            number the mixer starts from: the sync round measures the device plus
            where the player sits against the click, and a player who has settled
            into a metronome anticipates it — which is why it read 85 ms where
            this read 135 and 135 was the one that lined the take up.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {rows.map(([id, r]) => (
            <div key={id} className="flex items-center gap-2 text-[11px] px-0.5 py-0.5">
              <span className="truncate min-w-0 flex-1 text-zinc-300" title={r.name}>{r.name}</span>
              <span className="font-mono tabular-nums text-zinc-100 shrink-0">{r.latencyMs} ms</span>
              <span
                className={`font-mono tabular-nums shrink-0 ${r.unstable ? "text-amber-300" : "text-emerald-400"}`}
                title={r.unstable
                  ? `The kept trials disagree by ${r.spreadMs} ms — past ${SPREAD_LIMIT_MS} ms this number is soft. Trials: ${r.trialsMs.join(", ")} ms`
                  : `Spread across the kept trials. Trials: ${r.trialsMs.join(", ")} ms`}
              >
                ±{r.spreadMs}
              </span>
              {r.unstable && (
                <span className="shrink-0 leading-none" title="Unstable — usually the mic is only just hearing the click">
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                </span>
              )}
              <button
                onClick={() => onClear(id)}
                title="Drop this number — the take falls back to their sync round, or to no correction"
                className="shrink-0 text-zinc-600 hover:text-rose-400 leading-none px-0.5"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {measured > 0 && measured < participantCount && (
        <p className="text-[10px] text-amber-200/70 leading-snug">
          {participantCount - measured} of {participantCount} came back with nothing —
          almost always headphones still on, or speakers too quiet. Run it again for
          them; their takes fall back to their sync round if they have one.
        </p>
      )}

      <button
        onClick={onRun}
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg
                   bg-sky-600 hover:bg-sky-500 disabled:opacity-50
                   text-[13px] font-medium transition-colors"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
        {measured > 0 ? "Run calibration round again" : "Run calibration round"}
      </button>
    </div>
  );
}

/**
 * Zoom control for the mixer's shared time axis.
 *
 * The panel is 420 px wide, so a 31 s take used to be drawn at 82 ms per pixel
 * and a four-minute song at 632 ms — against a fine-tune slider whose step is
 * 5 ms. The waveform was decorative: the error being corrected was a fraction of
 * a pixel. The readout is in ms/px for that reason, because that number, not the
 * zoom factor, is what says whether what you are looking at can show you the
 * problem.
 */
function ZoomBar({ view, totalSec, widthPx, onView }: {
  view: TimeView; totalSec: number; widthPx: number; onView: (v: TimeView) => void;
}) {
  const msPerPx = (view.spanSec * 1000) / Math.max(1, widthPx);
  const zoomBy = (factor: number) => {
    const centre = view.startSec + view.spanSec / 2;
    const span = view.spanSec * factor;
    onView(clampView({ startSec: centre - span / 2, spanSec: span }, totalSec, widthPx));
  };
  const fitted = view.spanSec >= totalSec - 0.01 && view.startSec <= 0.01;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 px-0.5">
      <button
        onClick={() => zoomBy(1.6)}
        title="Zoom out"
        className="w-5 h-5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 grid place-items-center"
      >−</button>
      <button
        onClick={() => zoomBy(1 / 1.6)}
        title="Zoom in"
        className="w-5 h-5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 grid place-items-center"
      >+</button>
      <button
        onClick={() => onView({ startSec: 0, spanSec: totalSec })}
        disabled={fitted}
        className="px-1.5 h-5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100
                   disabled:opacity-40 disabled:hover:text-zinc-400"
      >Fit</button>
      <span className="font-mono tabular-nums">
        {msPerPx < 10 ? msPerPx.toFixed(1) : Math.round(msPerPx)} ms/px
      </span>
      <span className="flex-1" />
      <span className="font-mono tabular-nums">
        {fmtTime(view.startSec, view.spanSec)}–{fmtTime(view.startSec + view.spanSec, view.spanSec)}
      </span>
    </div>
  );
}

/** Decimals follow the zoom, not the value: at 30 s across the panel a
 *  hundredth of a second is noise, at 300 ms it is the whole point. */
function fmtTime(sec: number, spanSec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const dp = spanSec < 2 ? 3 : spanSec < 20 ? 2 : spanSec < 120 ? 1 : 0;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(dp)}`;
}

/** Sentinel id for the reference row, which has no participant id of its own —
 *  it is the key the mixer expands and collapses it by. */
const REFERENCE_TRACK_ID = "__reference__";
/** Per-browser memory of whether this host wants the sync round offered in
 *  Launch. Deliberately local rather than shared state: it is a preference of
 *  the person driving the panel, not a property of the session, and a host who
 *  switched it on to test should not switch it on for the next tutor. */
const SHOW_SYNC_ROUND_KEY = "p2g.showSyncRound";
/** Above this many takes the mixer collapses to one line per track. Five full
 *  strips still fit in the panel; ten do not. */
const COMPACT_LIST_THRESHOLD = 5;

// Fine-tune sync slider bounds (ms). Module constants because the seeded
// latency has to be quantised to a value the slider can actually represent —
// an off-step thumb jumps on the host's first drag.
const SYNC_SLIDER_MAX_MS  = 1000;
const SYNC_SLIDER_STEP_MS = 5;
/** Shift + arrow jumps ten steps. There is deliberately no finer step than
 *  SYNC_SLIDER_STEP_MS in the other direction: the slider snaps to 5 ms (an
 *  off-step value makes its thumb jump on the host's next drag), the zoom
 *  envelope resolves 5 ms, and a player's own beat-to-beat scatter is 12–30 ms.
 *  A 1 ms control would be below the noise floor of everything it acts on. */
const SYNC_KEY_COARSE_MS  = SYNC_SLIDER_STEP_MS * 10;
function clampToSlider(ms: number): number {
  const snapped = Math.round(ms / SYNC_SLIDER_STEP_MS) * SYNC_SLIDER_STEP_MS;
  return Math.max(-SYNC_SLIDER_MAX_MS, Math.min(SYNC_SLIDER_MAX_MS, snapped));
}

// ─── Mixer preview ───────────────────────────────────────────────────────────

/**
 * Play the whole balance — every audible take plus the reference — in the
 * host's browser, each source placed exactly where the mix will put it.
 *
 * Two rounds of simplification got here (2026-09-04). Solo was a server render
 * of one track with the reference removed, which is the one thing you need to
 * hear a take against; it became a per-strip preview of take + reference; and
 * that became this, because a strip-per-button mixer has ten play buttons and
 * no way to hear the thing you are actually building. There is now ONE
 * transport, and the faders and mutes are how you isolate — which is what
 * faders and mutes are for.
 *
 * **Decoded buffers, not `<audio>` elements.** Media elements started in the
 * same tick drift by tens of milliseconds and by a different amount each time.
 * This exists to judge a 20 ms misalignment, so element scheduling would invent
 * the flam the host is listening for. Buffers on one AudioContext clock are
 * sample-accurate.
 *
 * **Decoded at PREVIEW_SAMPLE_RATE**, not the file's. `decodeAudioData`
 * resamples to its context's rate, and memory is linear in it: eleven
 * five-minute takes at 48 kHz float is over half a gigabyte of tab, which is
 * the tab dying on the one session this has to survive. 24 kHz halves it and
 * changes nothing about the timing — scheduling accuracy does not depend on the
 * sample rate, and this is a monitoring path, not a mastering one.
 */
const PREVIEW_SAMPLE_RATE = 24000;
/** Refuse rather than kill the tab. Estimated from durations before anything is
 *  fetched; past this the host has the server mix, which is what a round that
 *  size wants anyway. */
const PREVIEW_BUDGET_BYTES = 250 * 1024 * 1024;

/** Whatever is playing right now, from any strip or the mixer's own transport.
 *  One AudioContext and one pair of ears: starting a second player while the
 *  first ran would stack them, and the balance you would hear is not one the
 *  mix will ever produce. */
let activePreviewStop: (() => void) | null = null;

let previewCtx: AudioContext | null = null;
function getPreviewCtx(): AudioContext | null {
  if (previewCtx) return previewCtx;
  const AC = typeof window === "undefined" ? undefined : (window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AC) return null;
  try { previewCtx = new AC({ sampleRate: PREVIEW_SAMPLE_RATE }); }
  catch { previewCtx = new AC(); }   // Safari has refused explicit rates before
  return previewCtx;
}

/** Decoded audio, keyed by URL — and every URL here carries its version
 *  (`?t=`), so a re-recorded take or a replaced reference is a different key
 *  and can never be served stale from this. Only the reference is kept between
 *  plays; takes are dropped, since holding eleven of them is the memory problem
 *  this file already has once, in capture. */
const refBufferCache = new Map<string, Promise<AudioBuffer | null>>();

async function loadPreviewBuffer(
  ctx: AudioContext, url: string, cache: boolean,
): Promise<AudioBuffer | null> {
  const hit = cache ? refBufferCache.get(url) : undefined;
  if (hit) return hit;
  const job = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch { return null; }
  })();
  if (cache) refBufferCache.set(url, job);
  return job;
}

export type PreviewSource = {
  id: string;
  url: string;
  /** Where this source sits on the MIX timeline — `captureDelayMs - manual`,
   *  the same shift ffmpeg applies. Negative starts partway into the file. */
  netDelaySec: number;
  gain: number;
  /** The reference is cached across plays; takes are not. */
  cache?: boolean;
};

function useMixPreview({ sources, onPlayhead }: {
  sources: PreviewSource[];
  onPlayhead?: (sec: number | null) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const stopRef = useRef<(() => void) | null>(null);
  const gainNodesRef = useRef<Map<string, GainNode>>(new Map());

  // Faders stay live while it plays: moving one and hearing it move is the
  // entire point of a mixer, and re-starting playback on every fader change
  // would make the control unusable.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(() => {
    for (const src of sources) {
      const node = gainNodesRef.current.get(src.id);
      if (node) node.gain.value = src.gain;
    }
  }, [sources]);
  useEffect(() => () => stopRef.current?.(), []);

  const toggle = async () => {
    if (stopRef.current) { stopRef.current(); return; }
    activePreviewStop?.();
    const wanted = sourcesRef.current.filter((s) => s.gain > 0);
    if (wanted.length === 0) return;
    const ctx = getPreviewCtx();
    if (!ctx) return;
    setState("loading");
    // Resume inside the gesture — iOS will not start a context otherwise.
    await ctx.resume().catch(() => {});

    const buffers = await Promise.all(
      wanted.map((s) => loadPreviewBuffer(ctx, s.url, s.cache === true)));
    const usable = wanted
      .map((s, i) => ({ src: s, buf: buffers[i] }))
      .filter((e): e is { src: PreviewSource; buf: AudioBuffer } => !!e.buf);
    if (usable.length === 0) { setState("idle"); return; }

    const t0 = ctx.currentTime + 0.15;   // one lead for all of them, or none
    const nodes: AudioBufferSourceNode[] = [];
    let endsAt = 0;
    for (const { src, buf } of usable) {
      const g = ctx.createGain();
      g.gain.value = src.gain;
      g.connect(outputNode(ctx));
      gainNodesRef.current.set(src.id, g);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(g);
      // Mix time 0 is the reference's first sample. A source that sits later
      // starts later; one pulled earlier starts now, from further into itself.
      if (src.netDelaySec >= 0) node.start(t0 + src.netDelaySec);
      else node.start(t0, Math.min(-src.netDelaySec, buf.duration));
      nodes.push(node);
      endsAt = Math.max(endsAt, Math.max(0, src.netDelaySec) + buf.duration);
    }

    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const n of nodes) { try { n.stop(); } catch { /* already ended */ } }
      for (const g of gainNodesRef.current.values()) g.disconnect();
      gainNodesRef.current.clear();
      stopRef.current = null;
      if (activePreviewStop === stop) activePreviewStop = null;
      onPlayhead?.(null);
      setState("idle");
    };
    stopRef.current = stop;
    activePreviewStop = stop;
    setState("playing");

    const tick = () => {
      const at = ctx.currentTime - t0;
      if (at >= endsAt) { stop(); return; }
      onPlayhead?.(Math.max(0, at));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  return { state, toggle };
}

/**
 * One mixer channel strip — reference row or a participant take. Restyled as a
 * self-contained card (channel strip): name + take/backing badge, a collapsible
 * "Auto-synced" chip that reveals the fine-tune sync slider and the latency
 * readout, a gain fader with mute, an overflow menu (delete / use-as-layer), and
 * the take waveform with the reference silhouette overlaid as a visual sync aid.
 */
function GainSlider({ name, takeNum, isReference, value, onChange, audioUrl, peaksUrl, peaksBinUrl, referenceUrl, referencePeaksUrl, captureDelayMs, onDelete, onUseAsRef, offsetMs, onOffsetChange, onOffsetNudge, syncOffset, calibOffset,
  alignment, onAnalyse, analysing = false, takeFile, takeUploadedAt, levelDb, peakDb, compact = false, expanded = false, onToggleExpanded, view, totalSec, onView, playheadSec, onPlayhead }: {
  name: string; value: number; onChange: (v: number) => void;
  /** This row is the reference / backing track (styled violet, no take controls). */
  isReference?: boolean;
  /** 2+ when the same singer has multiple takes; shown as a "take N" badge. */
  takeNum?: number;
  audioUrl?: string; onDelete?: () => void; onUseAsRef?: () => void;
  /** Server-precomputed envelope for this take, when it has one. */
  peaksUrl?: string;
  /** High-resolution sidecar (`<take>.peaks.bin`) — what the zoom reads. */
  peaksBinUrl?: string;
  /** The reference's own high-res sidecar, when the reference is a promoted
   *  take (layered sessions) rather than an uploaded file. */
  referencePeaksUrl?: string;
  /** The mixer's shared time window. Every strip draws the same one, so a
   *  zoom or a pan on any of them moves all of them together — comparing two
   *  takes at different scales would be worse than not zooming at all. */
  view: TimeView;
  totalSec: number;
  onView: (v: TimeView) => void;
  /** Shared playhead in mix time, drawn on every strip. */
  playheadSec?: number | null;
  /** Report this strip's playback position, already converted to mix time, or
   *  null when it stops. The mixer owns the value so one strip's playback draws
   *  a line through all of them. */
  onPlayhead?: (sec: number | null) => void;
  /** Collapse to a single scannable line unless `expanded`. Set by the parent
   *  once a round has more takes than fit on screen — ten full strips is
   *  ~2200 px of scrolling inside a 600 px panel. */
  compact?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Reference track URL — overlaid faintly behind participant take waveforms
   *  so the host can see alignment, AND played underneath this take by the
   *  preview button. Omit for the reference row itself. */
  referenceUrl?: string;
  /** Auto capture-start pad (ms) applied to this take in the mix — shifts the
   *  drawn waveform so the overlay matches the mixed timing. */
  captureDelayMs?: number;
  offsetMs?: number; onOffsetChange?: (ms: number) => void;
  /** Apply a RELATIVE change, resolved against the live value by the parent.
   *  Dragging the waveform uses this rather than `onOffsetChange`; see the
   *  stale-base note in the drag handler. */
  onOffsetNudge?: (deltaMs: number) => void;
  /** This player's sync-round measurement, when they have one. Seeded into the
   *  Sync slider by the parent, so this row is a readout of what is ALREADY
   *  applied — clicking it restores it after a manual nudge. Absent = nobody
   *  measured this player, and the take is mixed as recorded. */
  syncOffset?: ServerSyncOffset;
  calibOffset?: ServerCalibOffset;
  alignment?: ServerAlignment;
  /** Host-triggered DTW of this take against the reference. Absent on the
   *  reference strip and on takes with nothing to align against. */
  onAnalyse?: () => void;
  analysing?: boolean;
  /** Upload time of the take under this strip — the honest staleness test for
   *  a stored alignment, since take filenames are reused. */
  takeUploadedAt?: number;
  /** Measured level of this take, dBFS, and its sample peak. Shown next to the
   *  fader so "why is this one buried" has an answer that is not the host
   *  playing every strip in turn. */
  levelDb?: number;
  peakDb?: number;
  /** So a stored alignment can be shown as stale when the take was re-recorded
   *  under the same key — the number would otherwise describe a performance
   *  that no longer exists. */
  takeFile?: string;
}) {
  // Fine-tune sync open by default so the alignment slider sits right under the
  // waveform — the host can nudge the take against the reference contour without
  // hunting for a control. Still collapsible per take.
  const [tuneOpen, setTuneOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // Remember the last audible gain so the mute toggle can restore it. Mute maps
  // to gain=0, which ffmpeg skips entirely in the mix — a real mute, not a fade.
  const lastGain = useRef(value > 0 ? value : 1);
  useEffect(() => { if (value > 0) lastGain.current = value; }, [value]);
  const muted = value === 0;

  const sliderMs = offsetMs ?? 0;
  // Where this take sits on the mix timeline — `captureDelayMs` pad minus the
  // manual Sync offset, exactly what ffmpeg applies. Take time + this = mix time.
  const netDelaySec = (Math.max(0, Math.round(captureDelayMs ?? 0)) - Math.round(sliderMs)) / 1000;

  // Play THIS track on its own. The mixer's transport plays the balance; this
  // answers the other question a host asks of one row — what did this person
  // actually record — without muting everything else to get at it. Same engine,
  // one source, and starting either stops the other.
  //
  // It keeps `netDelaySec`, so the playhead reads in mix time like every other
  // line in the panel and lands on the waveform drawn under it.
  const stripPreview = useMixPreview({
    sources: audioUrl
      // `value || 1`: a MUTED row still plays here. Mute means "not in the mix",
      // not "unlistenable" — auditioning the take you just muted, to decide
      // whether to keep it out, is the obvious next thing a host does.
      ? [{ id: `strip:${takeFile ?? name}`, url: audioUrl, netDelaySec, gain: value || 1,
           cache: !!isReference }]
      : [],
    onPlayhead,
  });

  const slider = sliderMs;
  const hasTuning = !isReference && !!onOffsetChange;
  // -0.5 dBFS or hotter: the level pass runs on an 8 kHz mono decode, which
  // rounds the corners off a clipped waveform, so a take still reading this hot
  // AT THAT RESOLUTION was hitting the ceiling hard.
  const clipping = typeof peakDb === "number" && peakDb >= -0.5;
  // Everything below the name row — fader, waveform, fine-tune — is detail. In
  // compact mode only the expanded strip shows it, which is also what keeps the
  // collapsed rows from fetching envelopes or audio at all.
  const showDetail = !compact || expanded;
  // A muted row reads as "not in the mix".
  const dimmed = muted;

  return (
    <div className={`rounded-xl border ${compact && !expanded ? "px-2.5 py-1.5" : "p-2.5"}
                     flex flex-col gap-2 transition-opacity ${
      isReference ? "bg-violet-500/[0.07] border-violet-500/25" : "bg-zinc-900/70 border-zinc-800"
    } ${dimmed ? "opacity-60" : ""}`}>

      {/* Row 1: icon + name + badge + auto-synced chip + overflow menu */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-5 h-5 rounded-md grid place-items-center text-[11px] bg-zinc-800 text-zinc-400 shrink-0">
          {isReference ? "♫" : "🎤"}
        </span>
        <span className="text-[13px] font-semibold text-zinc-100 truncate min-w-0" title={name}>{name}</span>
        {isReference ? (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/30 shrink-0">
            Backing track
          </span>
        ) : takeNum && takeNum > 1 ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 shrink-0">
            take {takeNum}
          </span>
        ) : null}

        <span className="flex-1" />

        {/* Collapsed rows still carry the two controls a host uses while
            scanning a long list: the level at a glance, and mute. */}
        {compact && !expanded && (
          <>
            <span className="text-[11px] tabular-nums text-zinc-400 shrink-0">
              {Math.round(value * 100)}%
            </span>
            {audioUrl && (
              <button
                onClick={() => onChange(muted ? lastGain.current : 0)}
                title={muted ? "Unmute" : "Mute"}
                className={`w-6 h-6 rounded grid place-items-center shrink-0 transition-colors ${
                  muted ? "text-rose-400" : "text-zinc-500 hover:text-zinc-100"
                }`}
              >
                {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            )}
          </>
        )}

        {hasTuning && showDetail && (
          <button
            onClick={() => setTuneOpen((o) => !o)}
            aria-expanded={tuneOpen}
            title="Fine-tune this take's timing against the reference"
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400
                       border border-emerald-500/30 rounded-full pl-1.5 pr-2 py-0.5 hover:bg-emerald-500/10 transition-colors"
          >
            <Check className="w-3 h-3" />
            {slider !== 0 ? "Synced" : "As recorded"}
            <ChevronDown className={`w-3 h-3 transition-transform ${tuneOpen ? "rotate-180" : ""}`} />
          </button>
        )}

        {compact && onToggleExpanded && (
          <button
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            title={expanded ? "Collapse" : "Open this track"}
            className="shrink-0 w-6 h-6 rounded grid place-items-center text-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}

        {(onDelete || onUseAsRef) && (
          <div className="relative shrink-0">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              title="More"
              className="w-7 h-7 rounded-md grid place-items-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <>
                <button
                  className="fixed inset-0 z-10 cursor-default"
                  aria-hidden tabIndex={-1}
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 top-8 z-20 min-w-[160px] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-1.5 flex flex-col">
                  {onUseAsRef && (
                    <button
                      onClick={() => { setMenuOpen(false); onUseAsRef(); }}
                      className="flex items-center gap-2.5 text-[12.5px] text-zinc-200 hover:bg-zinc-800 rounded-md px-2 py-1.5 text-left transition-colors"
                    >
                      <Layers className="w-3.5 h-3.5 text-teal-400" /> Use as new layer
                    </button>
                  )}
                  {onUseAsRef && onDelete && <div className="h-px bg-zinc-800 my-1 mx-1" />}
                  {onDelete && (
                    <button
                      onClick={() => { setMenuOpen(false); onDelete(); }}
                      className="flex items-center gap-2.5 text-[12.5px] text-rose-400 hover:bg-zinc-800 rounded-md px-2 py-1.5 text-left transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete take
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Row 2: play-this-track-alone + gain fader + mute. Two transports, two
          questions: the mixer's Preview plays the BALANCE (every take over the
          reference, where the mix puts them), this one plays this row on its
          own. Only one of them can run at a time — see activePreviewStop. */}
      {showDetail && (
      <div className="flex items-center gap-2">
        {audioUrl && (
          <button
            onClick={stripPreview.toggle}
            disabled={stripPreview.state === "loading"}
            title={stripPreview.state === "playing"
              ? "Stop"
              : isReference ? "Play the backing track on its own"
                            : "Play only this take — the mixer's Preview plays the balance"}
            className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 border transition-colors ${
              stripPreview.state === "playing"
                ? "bg-teal-500 border-teal-500 text-zinc-950"
                : "bg-zinc-800 border-zinc-700 text-zinc-200 hover:border-teal-400 hover:text-teal-400"
            }`}
          >
            {stripPreview.state === "loading"
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : stripPreview.state === "playing"
                ? <Pause className="w-4 h-4" />
                : <Play className="w-4 h-4 ml-0.5" />}
          </button>
        )}
        <span className="text-zinc-500 shrink-0" title="Gain">
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </span>
        <input
          type="range"
          min={0} max={2} step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${name} gain`}
          className={`flex-1 min-w-0 ${isReference ? "accent-violet-400" : "accent-teal-400"}`}
        />
        <span className="text-[11px] font-medium tabular-nums text-zinc-100 w-9 text-right shrink-0">
          {Math.round(value * 100)}%
        </span>
        {showDetail && typeof levelDb === "number" && (
          <span
            className={`text-[10px] tabular-nums shrink-0 w-12 text-right ${
              clipping ? "text-rose-400" : "text-zinc-500"
            }`}
            title={`Measured when this take arrived: gated RMS ${levelDb} dBFS`
              + (typeof peakDb === "number" ? `, peak ${peakDb} dBFS` : "")
              + (clipping
                  ? ". The peak is at the ceiling — this take was already distorted when it "
                    + "arrived, and no fader here undoes that."
                  : ". Match levels sets the faders from this number.")}
          >
            {clipping ? "clipped" : `${levelDb.toFixed(0)} dB`}
          </span>
        )}
        {audioUrl && (
          <button
            onClick={() => onChange(muted ? lastGain.current : 0)}
            title={muted ? "Unmute" : "Mute"}
            className={`w-7 h-7 rounded-md grid place-items-center shrink-0 border transition-colors ${
              muted ? "text-rose-400 border-rose-500/40 bg-rose-500/10"
                    : "text-zinc-400 border-zinc-700 hover:text-zinc-100"
            }`}
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        )}
      </div>
      )}

      {/* Waveform first: take + (for participants) the reference contour on the
          same time axis, so you can SEE whether the take is in sync without
          listening. The rose line marks the clap / t=0. Drag it to nudge. */}
      {showDetail && audioUrl && (
        <TakeWaveform
          url={audioUrl}
          peaksUrl={peaksUrl}
          binUrl={peaksBinUrl}
          referenceUrl={referenceUrl}
          referencePeaksUrl={referencePeaksUrl}
          offsetMs={offsetMs ?? 0}
          captureDelayMs={captureDelayMs ?? 0}
          isReference={isReference}
          height={isReference ? 44 : 56}
          view={view}
          totalSec={totalSec}
          onView={onView}
          playheadSec={playheadSec}
          onNudge={hasTuning ? onOffsetNudge : undefined}
        />
      )}
      {showDetail && !isReference && audioUrl && referenceUrl && (
        <div className="flex items-center gap-3 text-[10px] text-zinc-500 px-0.5">
          <span className="inline-flex items-center gap-1.5">
            <i className="w-2 h-2 rounded-[2px] inline-block" style={{ background: "rgb(45,212,191)" }} /> Your take
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="w-2 h-2 rounded-[2px] inline-block" style={{ background: "rgba(143,150,249,0.7)" }} /> Reference — align to this
          </span>
          <span className="flex-1" />
          {/* Spelled out rather than left in a tooltip: the drag gets you close
              in one gesture and the keys finish the job, but nobody discovers
              arrow keys on a canvas by guessing. */}
          <span className="shrink-0 text-zinc-600" title="Click the waveform first, then use the arrow keys. Right-drag pans the view; the wheel zooms.">
            drag · ←→ {SYNC_SLIDER_STEP_MS}ms · ⇧←→ {SYNC_KEY_COARSE_MS}ms · right-drag pans
          </span>
        </div>
      )}

      {/* Fine-tune drawer sits right under the waveform so you nudge the take
          against the reference contour and watch it move. Open by default; the
          take is mixed as recorded (0), + advances (trim start), − delays. */}
      {hasTuning && showDetail && tuneOpen && (
        <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-800/40 p-2.5 flex flex-col gap-2.5">
          <div>
            <div className="flex justify-between text-[11px] text-zinc-400">
              <span>Fine-tune sync</span>
              <span className="font-mono tabular-nums text-zinc-200">{slider > 0 ? "+" : ""}{slider} ms</span>
            </div>
            <input
              type="range"
              min={-SYNC_SLIDER_MAX_MS} max={SYNC_SLIDER_MAX_MS} step={SYNC_SLIDER_STEP_MS}
              value={slider}
              onChange={(e) => onOffsetChange!(Number(e.target.value))}
              aria-label={`${name} sync offset`}
              className="w-full mt-1.5 accent-teal-400"
            />
          </div>
          {/* Where the seeded value came from — and, when there are two of
              them, what the other one said.
              
              Both are shown rather than only the winner, because the pair is
              informative in a way neither is alone: calibration is the device,
              the sync round is the device plus the player, so the DIFFERENCE is
              how that person sits against a click. A big gap is someone
              anticipating hard (2026-09-03: 135 vs 85, and 135 was right by
              hand). Clicking either applies it — the automatic choice is a
              starting point, not a verdict. */}
          {(calibOffset || syncOffset) ? (
            <div className="flex flex-col gap-1 text-[11px]">
              {calibOffset && (
                <button
                  type="button"
                  onClick={() => onOffsetChange!(clampToSlider(calibOffset.latencyMs))}
                  disabled={slider === clampToSlider(calibOffset.latencyMs)}
                  className={`inline-flex items-center gap-1.5 self-start text-left rounded
                              disabled:cursor-default enabled:hover:underline
                              ${calibOffset.unstable ? "text-amber-300" : "text-sky-300"}`}
                  title={`Calibration round: this device's acoustic round trip is `
                    + `${calibOffset.latencyMs} ms (trials ${calibOffset.trialsMs.join(", ")} ms). `
                    + `Measured with nobody playing, which is why it seeds the slider.`}
                >
                  <Check className="w-3 h-3 shrink-0" />
                  Calibration {calibOffset.latencyMs} ms ±{calibOffset.spreadMs}
                  {" · "}
                  {slider === clampToSlider(calibOffset.latencyMs) ? "applied" : "apply"}
                </button>
              )}
              {syncOffset && (
                <button
                  type="button"
                  onClick={() => onOffsetChange!(clampToSlider(syncOffset.offsetMs))}
                  disabled={slider === clampToSlider(syncOffset.offsetMs)}
                  className={`inline-flex items-center gap-1.5 self-start text-left rounded
                              disabled:cursor-default enabled:hover:underline
                              ${syncOffset.spreadMs <= SYNC_SPREAD_FAIR_MS ? "text-emerald-400" : "text-amber-300"}`}
                  title={`Sync round: this player's notes landed ${syncOffset.offsetMs} ms after `
                    + `the click, scatter ${syncOffset.spreadMs} ms over ${syncOffset.hits} beats. `
                    + `Device AND player, so it reads low by however far ahead of the click they `
                    + `sit — which is why calibration outranks it when both exist.`}
                >
                  <Check className="w-3 h-3 shrink-0" />
                  Sync round {syncOffset.offsetMs > 0 ? "+" : ""}{syncOffset.offsetMs} ms
                  {" ±"}{syncOffset.spreadMs}
                  {" · "}
                  {slider === clampToSlider(syncOffset.offsetMs) ? "applied" : "apply"}
                </button>
              )}
              {syncOffset && calibOffset && (
                <p className="text-[10px] leading-snug text-zinc-500">
                  The {Math.round(calibOffset.latencyMs - syncOffset.offsetMs)} ms between these
                  two is how far ahead of the click this player sits. It is not an
                  error in either number, and it is the reason the calibration one
                  is applied.
                </p>
              )}
              {syncOffset && syncOffset.spreadMs > SYNC_SPREAD_FAIR_MS && (
                <p className="text-[10px] leading-snug text-amber-200/70">
                  This player scattered ±{syncOffset.spreadMs} ms around the click,
                  so their notes will scatter by about that much here too — there
                  is no single offset that places this take.
                </p>
              )}
              {calibOffset?.unstable && (
                <p className="text-[10px] leading-snug text-amber-200/70">
                  Their calibration trials disagreed by {calibOffset.spreadMs} ms, so
                  this number is soft — usually a mic only just hearing the click.
                  Worth re-running the calibration round for them.
                </p>
              )}
              <AlignRow alignment={alignment} onAnalyse={onAnalyse} analysing={analysing}
                        takeFile={takeFile} takeUploadedAt={takeUploadedAt}
                        slider={slider} onOffsetChange={onOffsetChange} />
            </div>
          ) : (
            <div className="flex flex-col gap-1 text-[11px]">
              <span className="inline-flex items-center gap-1.5 self-start text-amber-300">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                Not measured — mixed as recorded
              </span>
              <p className="text-[10px] leading-snug text-amber-200/70">
                This player has neither a calibration nor a sync round, so nothing
                is being corrected for them and their take sits where it was
                captured — late by whatever their monitoring delay is. Run either
                round and this take re-seeds itself, align it by hand against the
                reference contour above, or measure this take directly:
              </p>
              <AlignRow alignment={alignment} onAnalyse={onAnalyse} analysing={analysing}
                        takeFile={takeFile} takeUploadedAt={takeUploadedAt}
                        slider={slider} onOffsetChange={onOffsetChange} />
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/**
 * Custom transport for the final mix — the one place with a full, seekable
 * scrubber (per-take rows only get a play button). Replaces the raw
 * <audio controls> so the master reads as the hero of the mixer.
 */
function MasterPlayer({ src, label = "Master mix", fallbackDuration, onPlayhead }: {
  src: string;
  label?: string;
  /** Drive the mixer's shared playhead. The mix IS the mix timeline, so its
   *  position needs no conversion — and playing the master is the most useful
   *  way to watch the line cross every strip at once. */
  onPlayhead?: (sec: number | null) => void;
  /** Duration to show when the media element can't report one — MediaRecorder
   *  WebM has no duration in its header, so audio.duration is Infinity. The
   *  server probes/estimates it (referenceDuration) and we pass it here. */
  fallbackDuration?: number | null;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // The mix already lives on the mix timeline, so its currentTime IS the
  // playhead — no conversion, unlike a take, which has to be shifted by what
  // ffmpeg applies to it.
  useEffect(() => {
    if (!playing || !onPlayhead) return;
    let raf = 0;
    const tick = () => {
      const a = ref.current;
      if (a) onPlayhead(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); onPlayhead(null); };
  }, [playing, onPlayhead]);
  const [cur, setCur] = useState(0);
  const [rawDur, setRawDur] = useState(0);

  // Prefer a finite duration from the element; otherwise fall back to the
  // server-provided one so recorded (Infinity-duration) references still show
  // a length and get a working scrubber.
  const dur = rawDur > 0 && Number.isFinite(rawDur)
    ? rawDur
    : (fallbackDuration && fallbackDuration > 0 ? fallbackDuration : 0);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = ref.current;
    if (!a || !dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - rect.left) / rect.width;
    a.currentTime = Math.max(0, Math.min(1, p)) * dur;
  };
  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        title={playing ? "Pause" : "Play mix"}
        className="w-11 h-11 rounded-xl grid place-items-center shrink-0 bg-teal-500 text-zinc-950
                   hover:bg-teal-400 transition-colors"
      >
        {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[13px] font-semibold text-zinc-100 leading-none">{label}</span>
          <span className="text-[11px] font-mono tabular-nums text-zinc-400 leading-none">
            {fmt(cur)} / {fmt(dur)}
          </span>
        </div>
        <div
          onClick={seek}
          className="h-1.5 rounded-full bg-zinc-700 cursor-pointer relative overflow-hidden"
        >
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-teal-500 to-teal-300 rounded-full"
            style={{ width: dur ? `${(cur / dur) * 100}%` : "0%" }}
          />
        </div>
      </div>
      <audio
        ref={ref}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCur(ref.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setRawDur(ref.current?.duration ?? 0)}
        onDurationChange={() => setRawDur(ref.current?.duration ?? 0)}
        className="hidden"
      />
    </div>
  );
}

// ─── Help panel content ───────────────────────────────────────────────────────

function HelpPanel({ onClose, width, height, fill = false }: {
  onClose: () => void; width: number; height: number;
  /** Take the parent's box instead of a fixed size (embedded panel). */
  fill?: boolean;
}) {
  return (
    <div
      className={fill
        ? "bg-zinc-900 flex flex-col overflow-hidden flex-1 min-h-0"
        : "bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"}
      style={fill ? undefined : { width, height }}
    >
      <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-amber-400" />
          <span className="font-semibold text-sm text-white">How it works</span>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1 min-h-0 text-xs text-zinc-300 leading-relaxed">
        <section className="flex flex-col gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
          <p className="text-xs font-semibold text-amber-300 uppercase tracking-widest flex items-center gap-1.5">
            <Headphones className="w-3.5 h-3.5" /> Before recording
          </p>
          <ul className="flex flex-col gap-1.5 list-disc list-inside marker:text-amber-500/70">
            <li>
              <span className="font-medium text-white">Use headphones.</span>{" "}
              In a video call, your speakers leak everyone else's audio into your mic. Headphones keep each take clean.
            </li>
            <li>
              <span className="font-medium text-white">Mute the videoconference.</span>{" "}
              While recording, the host should manually mute participants' video-call audio so chatter and breathing don't bleed into the take.
            </li>
            <li>Pick a quiet room and keep the mic close to your mouth.</li>
            <li>Stay silent during the countdown and clap — the clap is the sync marker.</li>
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">1 · Configure</p>
          <p>Set the countdown (3–30 s) and the max recording duration (5–360 s). Open the session — everyone in the room will see the participant overlay.</p>
        </section>

        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">2 · Reference audio</p>
          <p>Required — this is the base every participant records on top of. Upload a backing track or record one from your own mic; participants hear it timed to the clap and it's blended into the final mix.</p>
        </section>

        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">3 · Rehearsal (optional)</p>
          <p>Play the reference for everyone so they can level their mics and feel the timing. Each participant taps "I'm ready" when set.</p>
        </section>

        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">4 · Launch</p>
          <p>Pick who records — <em>Everyone</em>, or a single participant to re-do a bad take. A timestamp is shared so every client starts at the exact same moment (a synthetic clap is injected into each recording as a sync marker).</p>
        </section>

        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">5 · Mixer & listen</p>
          <p>Adjust per-track volumes, mix with ffmpeg, then play the result for everyone. You can re-record any participant, re-mix as many times as you want, and download the final <code className="text-amber-300">mix.webm</code>.</p>
          <p className="text-zinc-500">Tip: delete a take with the trash icon next to its slider before mixing.</p>
        </section>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<P2GPhase, { text: string; color: string }> = {
  idle:      { text: "Idle",      color: "bg-zinc-700 text-zinc-300" },
  preparing: { text: "Setup",     color: "bg-zinc-700 text-zinc-200" },
  rehearsal: { text: "Rehearsal", color: "bg-amber-700 text-amber-50" },
  countdown: { text: "Countdown", color: "bg-amber-500 text-amber-950" },
  recording: { text: "Recording", color: "bg-rose-600 text-white" },
  uploading: { text: "Uploading", color: "bg-teal-700 text-teal-50" },
  mixing:    { text: "Mixing…",   color: "bg-teal-600 text-white" },
  done:      { text: "Done",      color: "bg-emerald-600 text-white" },
};

function PhaseBadge({ phase }: { phase: P2GPhase }) {
  const { text, color } = PHASE_LABEL[phase];
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>{text}</span>;
}

// ─── Polled session data ──────────────────────────────────────────────────────

type ServerParticipant = {
  file: string;
  /** Sidecar `<take>.peaks.json` written at ingest — the waveform without
   *  downloading the take. Absent on takes recorded before it existed. */
  peaksFile?: string;
  /** High-resolution envelope (`<take>.peaks.bin`) the zoom reads. Absent on
   *  takes recorded before it existed. */
  peaksBinFile?: string;
  name: string;
  clapOffset: number;
  calibrated?: boolean;
  /** Measured capture-start delay (ms) the mixer pads the take by — used to
   *  shift this take's waveform so the overlay matches the mixed alignment. */
  captureDelayMs?: number;
  uploadedAt: number;
  takeNum?: number;
  participantId?: string;
  /** Gated RMS level of the take in dBFS, measured at ingest. Absent on takes
   *  recorded before it existed, and on takes too quiet to measure. */
  levelDb?: number;
  /** Sample peak in dBFS, same pass. Near 0 means the take arrived clipped. */
  peakDb?: number;
};
/** One musician's measured playing offset, from a sync round. */
type ServerSyncOffset = {
  name: string;
  offsetMs: number;
  spreadMs: number;
  hits: number;
  expected: number;
  bpm: number;
  deviationsMs: number[];
  atSearchEdge?: boolean;
  measuredAt: number;
  file?: string;
};
/** One musician's device round trip, from a calibration round. */
type ServerCalibOffset = {
  name: string;
  latencyMs: number;
  spreadMs: number;
  trialsMs: number[];
  unstable: boolean;
  measuredAt: number;
};
/** What a DTW run measured for one TAKE. Keyed by the take, not the person —
 *  it describes a performance, so `takeFile` says which one. */
type ServerAlignment = {
  name: string;
  offsetMs: number;
  lagMs: number;
  madMs: number;
  driftRangeMs: number;
  drift: { tSec: number; lagMs: number }[];
  feature: string;
  atBandEdge: boolean;
  centred: boolean;
  takeFile: string;
  measuredAt: number;
};
type ServerReady = { name: string };
type ServerFailure = { name: string; reason: string; clapAt: number | null; at: number };
type ServerSession = {
  participants: Record<string, ServerParticipant>;
  ready: Record<string, ServerReady>;
  failures?: Record<string, ServerFailure>;
  /** Keyed by participantId, not by take key — an offset belongs to the person
   *  and outlives any individual take they record. */
  syncOffsets?: Record<string, ServerSyncOffset>;
  /** Keyed by participantId, like `syncOffsets` and for the same reason. */
  calibOffsets?: Record<string, ServerCalibOffset>;
  /** Keyed by TAKE, unlike the two above. See ServerAlignment. */
  alignments?: Record<string, ServerAlignment>;
  /** Master gain applied to the last render, and the peak it was measured
   *  from. Shown under the master player so the output level is a number the
   *  host can see rather than a surprise. */
  masterGainDb?: number;
  mixPeakDb?: number;
};

// MediaRecorder container support varies by browser: Chromium records
// WebM/Opus, but Safari (incl. iPadOS) only does MP4/AAC and THROWS
// `NotSupportedError` straight from the constructor on an unsupported
// mimeType. Hard-coding "audio/webm" meant the Record button threw on every
// click on iPad — with no UI feedback the host just mashed it (see field bug
// reports). Pick the first container the browser actually supports instead.
const CAPTURE_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/aac",
];
function pickCaptureMime(): string | null {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return CAPTURE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * @param embedded Render as the content of the host's docked side column (the
 *   "Play" tab) instead of a draggable floating card: no Rnd, fills its box,
 *   and the help replaces the body instead of opening beside it. The host
 *   asked for it after the participant panel moved to a column — the floating
 *   card sat on the videos the host is there to watch.
 */
export default function Play2GetherHostPanel({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  embedded?: boolean;
}) {
  const room = useRoomContext();
  const {
    p2g, phase, countdown, recordingProgress, host,
    uploading, uploadError, uploadErrorKind, retryUpload,
    calibratedLatencyMs, setCalibratedLatency, publishCalibration, clearPublishedCalibration, calibRound,
  } = usePlay2GetherSession();
  const [calibrating, setCalibrating] = useState(false);

  // Room capture mode. Absent reads as "speech" — the same way the clients and
  // the assistant's audio plugin resolve it.
  const { state: sharedState, setAudioMode } = useSharedStateContext();
  const roomAudioMode = (sharedState as any)?.ui?.audioMode === "music" ? "music" : "speech";

  // Countdown / duration now live in shared state and are tweaked per-round
  // from Step 4. No local pre-session state needed any more.

  // Reference mic-recording state
  const [isCapturing, setIsCapturing]       = useState(false);
  // Live elapsed seconds while recording the reference from the mic, so the
  // host can see how long the take is running.
  const [captureElapsed, setCaptureElapsed] = useState(0);
  const captureRecorderRef                  = useRef<MediaRecorder | null>(null);
  // Wall-clock start of the current capture. MediaRecorder's WebM output
  // doesn't carry duration in the EBML header → server-side ffprobe returns
  // N/A, so we measure the duration here and ship it as a hint to the server.
  const captureStartedAtRef                 = useRef<number>(0);
  const captureChunksRef                    = useRef<Blob[]>([]);
  // The container chosen at start, reused for the final Blob so the server
  // derives the right extension. Null when this browser can't record at all.
  const captureMimeRef                      = useRef<string | null>(null);
  // Resolved on the client (MediaRecorder is undefined during SSR) so we can
  // disable the Record button instead of letting it throw on Safari/iPad.
  const [captureSupported, setCaptureSupported] = useState(true);
  useEffect(() => { setCaptureSupported(pickCaptureMime() !== null); }, []);

  // UI feedback
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-track gains for the mixer (local — not shared state)
  const [refGain, setRefGain]                                     = useState(p2g.referenceGain);
  const [participantGains, setParticipantGains]                   = useState<Record<string, number>>({});
  // Per-track fine-tune sync offsets (ms), additive to each take's auto-detected
  // playback latency. Negative = singer was too early, positive = too late.
  // Seeded from each take's measured `clapOffset` — see the poll below.
  const [participantOffsets, setParticipantOffsets]               = useState<Record<string, number>>({});
  // The mixer's shared time window. One per mixer, not one per strip: comparing
  // two takes drawn at different scales is worse than not zooming at all.
  // `null` = follow the whole session (refit when the span changes).
  const [timeView, setTimeView] = useState<TimeView | null>(null);
  const [mixerWidth, setMixerWidth] = useState(380);
  // Playback position in MIX time, owned here rather than per strip: pressing
  // play on one track has to draw the line through all of them, because what
  // the host is judging is whether a take sits right against the reference and
  // a line on a single strip cannot show that.
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const mixerWidthRef = useRef<HTMLDivElement>(null);
  // `uploadedAt` of the take whose latency we already seeded into the slider,
  // per participant. Guards the seeding against re-running on every poll tick
  // (which would stomp the host's manual nudge every 3 s) while still letting a
  // RE-recorded take re-seed, since that upload carries its own measurement.
  // What each take was last seeded FROM: `uploadedAt` plus the sync measurement
  // in force at the time. Both, so that measuring a person AFTER their take has
  // already landed re-seeds it — keyed on `uploadedAt` alone, running a sync
  // round to fix an alignment problem silently did nothing to the takes already
  // in the mixer, which is the wrong way round for the one control that exists
  // to fix them.
  const seededOffsetsRef                                          = useRef<Record<string, string>>({});
  // Takes whose offset the host has set by hand (slider, drag or arrow keys).
  // Re-seeding must never overwrite those: an automatic number is a starting
  // point, and a human who has already looked at the waveform outranks it.
  const touchedOffsetsRef                                         = useRef<Set<string>>(new Set());
  // Mixer list density. A choral round is 8–10 singers, and ten full channel
  // strips (name + fader + waveform + fine-tune drawer) is ~2200 px inside a
  // 600 px panel — the Mix button ends up several screens below the first take.
  // Past the threshold the list collapses to one line per take with a single
  // strip expanded; the host can force either mode.
  const [densityPref, setDensityPref] = useState<"auto" | "full" | "compact">("auto");
  const [expandedTakeId, setExpandedTakeId] = useState<string | null>(null);
  // Target for the next countdown — "" means everyone records.
  const [targetIdSel, setTargetIdSel] = useState<string>("");

  // The sync round is OFF the host's flow by default (2026-09-04). It was
  // withdrawn on 2026-09-03 for reading systematically low, came back the same
  // afternoon as a fallback, and it still asks the band for thirteen seconds of
  // a task they can get wrong in a way the detector then has to refuse. With
  // calibration seeding the mixer and the slider finishing the job, an extra
  // card in Launch is one more thing to explain in front of a live band.
  //
  // It is HIDDEN, not removed — same decision as 2026-09-03, and the reason is
  // the same: the round, the detector and its fixtures are the only thing that
  // measures the player rather than the device, and `spreadMs` answers "can
  // this person hold a beat", which nothing else asks. The link at the foot of
  // Launch brings it back for a session, and the choice sticks on this browser
  // so a host testing it does not re-enable it every reload.
  const [showSyncRound, setShowSyncRound] = useState(false);
  useEffect(() => {
    try { setShowSyncRound(window.localStorage.getItem(SHOW_SYNC_ROUND_KEY) === "1"); }
    catch { /* private mode — the default (hidden) is the safe one */ }
  }, []);
  const toggleSyncRound = useCallback(() => {
    setShowSyncRound((v) => {
      const next = !v;
      try { window.localStorage.setItem(SHOW_SYNC_ROUND_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  // Cancelling a round is destructive — the take is discarded on every client
  // and there is no undo — so the button arms before it fires. It also sits
  // next to a progress bar during a five-minute take, which is a long time for
  // a one-click "throw it all away" to be within reach of a stray tap.
  const [cancelArmed, setCancelArmed] = useState(false);
  // Disarm whenever no round is running. The confirm only renders during
  // countdown/recording, so without this it would survive unmounted and the
  // NEXT round would open already showing "Yes, discard it".
  useEffect(() => {
    if (phase !== "countdown" && phase !== "recording") setCancelArmed(false);
  }, [phase]);

  // Help/tutorial side panel.
  const [helpOpen, setHelpOpen] = useState(false);

  // Controlled position so we can recenter when the help panel toggles
  // (otherwise the panel grows rightward and clips on smaller screens).
  // MAIN_W drives the panel's actual width; nothing else may hardcode it, or
  // widening the panel silently desyncs the Rnd box from the rendered card.
  const MAIN_W = 420;
  const HELP_W = 320;
  // Matches the `gap-3` between the two cards below.
  const PANEL_GAP = 12;
  const TOTAL_W_WITH_HELP = MAIN_W + PANEL_GAP + HELP_W;
  const GAP = 8;
  // Fixed panel height — content scrolls inside. Avoids the panel growing
  // past the bottom of the viewport when the steps list gets long.
  const PANEL_H = typeof window !== "undefined"
    ? Math.min(Math.round(window.innerHeight * 0.85), 720)
    : 600;
  const [position, setPosition] = useState(() => {
    if (typeof window === "undefined") return { x: 64, y: 64 };
    return {
      x: Math.max(GAP, Math.round((window.innerWidth - MAIN_W) / 2)),
      y: Math.max(GAP, Math.round((window.innerHeight - PANEL_H) / 2)),
    };
  });

  const toggleHelp = () => {
    setHelpOpen((prev) => {
      const willOpen = !prev;
      // Shift x so the wider/narrower panel stays visually centered around
      // its current center point, clamped to the viewport.
      const dx = (TOTAL_W_WITH_HELP - MAIN_W) / 2;
      setPosition((p) => {
        const winW = typeof window !== "undefined" ? window.innerWidth : 1200;
        const newW = willOpen ? TOTAL_W_WITH_HELP : MAIN_W;
        const targetX = willOpen ? p.x - dx : p.x + dx;
        const maxX = Math.max(GAP, winW - newW - GAP);
        return { x: Math.max(GAP, Math.min(maxX, targetX)), y: p.y };
      });
      return willOpen;
    });
  };

  // Polled server session (participant uploads + readiness)
  const [serverSession, setServerSession] = useState<ServerSession>({ participants: {}, ready: {} });
  // Takes with a DTW analysis in flight. A Set rather than a boolean: the host
  // can fire several and they run independently on the server.
  const [analysing, setAnalysing] = useState<Set<string>>(new Set());

  /**
   * Ask the server to align one take against the reference.
   *
   * The result is merged into `serverSession` on the spot rather than waited
   * for from the 3 s poll: the host pressed a button and a result that appears
   * up to three seconds later reads as the button not having worked.
   */
  const handleAnalyse = async (takeKey: string) => {
    if (!p2g.sessionId || analysing.has(takeKey)) return;
    setAnalysing((prev) => new Set(prev).add(takeKey));
    try {
      const res = await fetch("/api/play2gether/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: p2g.sessionId, participantId: takeKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.reason ?? data.error ?? "The alignment could not be computed");
        return;
      }
      const take = serverSession.participants[takeKey];
      setServerSession((prev) => ({
        ...prev,
        alignments: {
          ...(prev.alignments ?? {}),
          [takeKey]: {
            name: take?.name ?? takeKey,
            offsetMs: data.offsetMs, lagMs: data.lagMs, madMs: data.madMs,
            driftRangeMs: data.driftRangeMs ?? 0, drift: data.drift ?? [],
            feature: data.feature, atBandEdge: data.atBandEdge === true,
            centred: data.centred === true,
            takeFile: take?.file ?? "", measuredAt: Date.now(),
          },
        },
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setAnalysing((prev) => { const next = new Set(prev); next.delete(takeKey); return next; });
    }
  };

  // Sync refGain from shared state when panel opens
  useEffect(() => { setRefGain(p2g.referenceGain); }, [p2g.referenceGain]);

  // Poll session.json during recording/uploading/rehearsal phases
  useEffect(() => {
    if (!p2g.sessionId) return;
    // "preparing" and "done" are in the list so the sync-round results and the
    // take list repopulate after a host refresh, not only while a round is live.
    if (!["preparing", "rehearsal", "recording", "uploading", "done"].includes(phase)) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/play2gether/session?sessionId=${p2g.sessionId}`);
        if (!res.ok) return;
        const data: ServerSession = await res.json();
        setServerSession(data);
        // Init gains for newly uploaded participants at 1.0
        setParticipantGains((prev) => {
          const next = { ...prev };
          Object.keys(data.participants).forEach((id) => {
            if (!(id in next)) next[id] = 1.0;
          });
          return next;
        });
        // Seed the fine-tune slider from a MEASUREMENT, so the aligned mix is
        // the default and the host only touches the slider to correct it.
        //
        // Two sources with a FIXED precedence — calibration first, sync round
        // only where there is no calibration. Not two the host adjudicates
        // between, and the order is not arbitrary:
        //
        //   2026-09-03, same person, same take — calibration 135 ms, sync round
        //   85 ±5, and aligning the take against the reference by hand said 135.
        //   Later the same day, another player: sync round 60 where the device
        //   measured 130.
        //
        // Players ANTICIPATE a click, and anticipating is cancelling by hand
        // part of the latency being measured — which is why doc 11's four
        // consecutive rounds converged 118 → 87 ms, downwards, away from the
        // physical path. The human term does not transfer to a song either
        // (53 and 108 ms on two takes of one piece), so it is not a constant
        // that could be subtracted even if it were wanted.
        //
        // A sync round still SEEDS where there is no calibration, and that is
        // not a contradiction. Reading 50–70 ms low is a bounded, one-directional
        // error against a take that would otherwise sit at its full monitoring
        // delay — most of the way to right beats nowhere near it. What it must
        // never do is overrule a calibration figure, which is what this ordering
        // encodes.
        //
        // What is NOT a source, and stays gone: the take's own `clapOffset`,
        // i.e. the browser's guess. That is what mixed three of eleven players
        // against a 61–412 ms estimate on 2026-08-31. A confident wrong
        // correction is worse than no correction, because no correction is
        // VISIBLE — an unmeasured take sits where it was captured, obviously
        // late, and the zoom is good enough to fix it by hand.
        //
        // Keyed on `uploadedAt` + both `measuredAt`s so that measuring a person
        // AFTER their take has landed re-seeds it, and skipped entirely once the
        // host has set that take's offset by hand.
        // Ref bookkeeping stays outside the updater: React may invoke updaters
        // twice, and a second pass would see the ref already set and skip.
        const seeds: Record<string, number> = {};
        Object.entries(data.participants).forEach(([id, p]) => {
          const pid = p.participantId ?? id;
          const sync = data.syncOffsets?.[pid];
          const calib = data.calibOffsets?.[pid];
          const stamp = `${p.uploadedAt}:${sync?.measuredAt ?? 0}:${calib?.measuredAt ?? 0}`;
          if (seededOffsetsRef.current[id] === stamp) return;
          seededOffsetsRef.current[id] = stamp;
          if (touchedOffsetsRef.current.has(id)) return;
          seeds[id] = calib ? clampToSlider(calib.latencyMs)
                    : sync  ? clampToSlider(sync.offsetMs)
                    : 0;
        });
        if (Object.keys(seeds).length > 0) {
          setParticipantOffsets((prev) => ({ ...prev, ...seeds }));
        }
      } catch { /* ignore */ }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [p2g.sessionId, phase]);

  useEffect(() => {
    const el = mixerWidthRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setMixerWidth(el.clientWidth || 380));
    ro.observe(el);
    setMixerWidth(el.clientWidth || 380);
    return () => ro.disconnect();
  }, [phase]);

  // The full span the axis can show: the reference, plus the longest take, plus
  // the largest shift any take can be given, so a take pushed to the end of its
  // range never falls off the axis and out of reach.
  const totalSec = useMemo(() => {
    // Takes can outlast the reference (the host overrode the duration, or a
    // capture overran), so the axis is the longer of the two — plus the widest
    // shift the Sync slider can apply, so a take pushed to the end of its range
    // never slides off the axis and out of reach.
    const longest = Math.max(p2g.referenceDuration ?? 0, p2g.recordingDuration ?? 0, 30);
    return longest + SYNC_SLIDER_MAX_MS / 1000;
  }, [p2g.referenceDuration, p2g.recordingDuration]);

  /**
   * Everything the preview would play, in mix time. Rebuilt on every fader and
   * nudge so the running preview follows them: `useMixPreview` reads the gains
   * live, and a source list that lagged the faders would mean listening to a
   * balance the host had already changed.
   */
  const previewSources: PreviewSource[] = useMemo(() => {
    const list: PreviewSource[] = [];
    if (p2g.referenceUrl) {
      list.push({
        id: REFERENCE_TRACK_ID, url: p2g.referenceUrl,
        netDelaySec: 0, gain: refGain, cache: true,
      });
    }
    for (const id of Object.keys(serverSession.participants)) {
      const take = serverSession.participants[id];
      if (!take?.file || !p2g.sessionId) continue;
      list.push({
        id,
        url: `/api/play2gether/file/${p2g.sessionId}/${take.file}?t=${take.uploadedAt ?? 0}`,
        // The same shift ffmpeg applies, so what you hear is where it will land.
        netDelaySec: (Math.max(0, Math.round(take.captureDelayMs ?? 0))
                      - Math.round(participantOffsets[id] ?? 0)) / 1000,
        gain: participantGains[id] ?? 1.0,
      });
    }
    return list;
  }, [p2g.referenceUrl, p2g.sessionId, serverSession.participants,
      participantGains, participantOffsets, refGain]);

  const preview = useMixPreview({ sources: previewSources, onPlayhead: setPlayheadSec });
  // Estimated from the timeline rather than measured, because it has to be
  // known BEFORE anything is fetched. Float samples at the preview rate, one
  // channel assumed — an under-estimate for a stereo reference, which is why
  // the budget is well under what a tab can really hold.
  const previewBytes = previewSources.filter((x) => x.gain > 0).length
    * Math.max(1, totalSec) * PREVIEW_SAMPLE_RATE * 4;
  const previewTooBig = previewBytes > PREVIEW_BUDGET_BYTES;

  // Clamped on READ as well as on write: `totalSec` changes when a reference is
  // replaced or promoted, and a zoom saved against the old span would otherwise
  // point off the end of the new one.
  const view = clampView(timeView ?? { startSec: 0, spanSec: totalSec }, totalSec, mixerWidth);
  const setView = (v: TimeView) => setTimeView(clampView(v, totalSec, mixerWidth));

  // Follow the playhead when it leaves the window, and only then. Zoomed in to
  // 200 ms the line is off screen a frame after you press play, which makes the
  // indicator useless; scrolling continuously instead would make the waveform
  // slide under a stationary line, which is far harder to read alignment from.
  // Jumping the window when the line runs off the end keeps the picture still
  // between jumps. It cannot fight a host who is panning: they are listening.
  useEffect(() => {
    if (playheadSec == null) return;
    if (playheadSec >= view.startSec && playheadSec <= view.startSec + view.spanSec) return;
    if (view.spanSec >= totalSec) return;    // fully zoomed out, nothing to follow
    setTimeView(clampView(
      { startSec: playheadSec - view.spanSec * 0.1, spanSec: view.spanSec }, totalSec, mixerWidth));
  }, [playheadSec, view.startSec, view.spanSec, totalSec, mixerWidth]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const wrap = async <T,>(fn: () => Promise<T>) => {
    setError(null); setBusy(true);
    try { return await fn(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const gainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefGain = (value: number) => {
    setRefGain(value);
    if (gainTimerRef.current) clearTimeout(gainTimerRef.current);
    gainTimerRef.current = setTimeout(() => host.setReferenceGain(value), 300);
  };

  // ── Event handlers ─────────────────────────────────────────────────────────

  // openSession defaults are now the source of truth for the initial
  // countdownSecs / recordingDuration. The reference upload overwrites
  // recordingDuration with the actual song length, and the host tunes
  // countdown per-round from Step 4.
  const handleOpen = () => wrap(() => host.openSession());

  const handleClose = () => wrap(async () => { await host.closeSession(); onClose(); });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    wrap(() => host.uploadReference(file));
    e.target.value = "";
  };

  const handleStartCapture = () => {
    const mime = pickCaptureMime();
    if (!mime) {
      // No supported container → don't construct MediaRecorder (it would throw
      // a NotSupportedError that the user can't see). Tell them instead.
      setError("Recording isn't supported in this browser. Use Chrome on desktop, or upload a file.");
      return;
    }
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const rawTrack = pub?.track?.mediaStreamTrack;
    if (!rawTrack) { setError("No mic track available"); return; }
    captureMimeRef.current = mime;
    captureChunksRef.current = [];
    const recorder = new MediaRecorder(new MediaStream([rawTrack]), {
      mimeType: mime, audioBitsPerSecond: 64_000,
    });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) captureChunksRef.current.push(e.data); };
    recorder.start(500);
    captureRecorderRef.current = recorder;
    captureStartedAtRef.current = performance.now();
    setIsCapturing(true);
  };

  const handleStopCapture = () => {
    const recorder = captureRecorderRef.current;
    if (!recorder) return;
    // Snapshot duration BEFORE stop() fires onstop asynchronously.
    const durationSec = (performance.now() - captureStartedAtRef.current) / 1000;
    recorder.onstop = () => {
      // Same container we recorded with, so the server picks the right
      // extension (MP4 on Safari, WebM on Chromium).
      const blob = new Blob(captureChunksRef.current, { type: captureMimeRef.current ?? "audio/webm" });
      wrap(() => host.uploadReference(blob, undefined, durationSec));
    };
    recorder.stop();
    captureRecorderRef.current = null;
    setIsCapturing(false);
  };

  // Metronome while capturing the reference from the mic — a guide for whoever
  // is playing the base, nothing else. Deliberately NOT phase-locked to
  // anything: the round metronome hangs off `clapAt` (tick k=0 lands on the
  // clap, which is also the reference's t=0), but there is no clap here, and
  // MediaRecorder starts tens of ms after `start()` returns, so pretending this
  // click defines a grid the base sits on would be a lie. It free-runs from the
  // moment recording starts.
  //
  // Rolling scheduler rather than the round metronome's schedule-it-all-up-front
  // loop, because a reference capture has no known duration — it runs until the
  // host presses Stop.
  useEffect(() => {
    const bpm = p2g.metronomeBpm;
    if (!isCapturing || !(bpm > 0)) return;
    const AC = typeof window !== "undefined"
      ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : null;
    if (!AC) return;

    const ctx = new AC();
    ctx.resume().catch(() => {});
    const beat = 60 / bpm;
    const beatsPerBar = 4;
    const firstBeatAt = ctx.currentTime + 0.15; // let the context spin up
    const LOOKAHEAD_S = 1.0;
    let k = 0;
    const pump = () => {
      while (firstBeatAt + k * beat < ctx.currentTime + LOOKAHEAD_S) {
        scheduleMetronomeClick(ctx, firstBeatAt + k * beat, k % beatsPerBar === 0);
        k++;
      }
    };
    pump();
    const id = setInterval(pump, 250);
    return () => { clearInterval(id); ctx.close().catch(() => {}); };
  }, [isCapturing, p2g.metronomeBpm]);

  // Tick the reference-recording elapsed time while capturing.
  useEffect(() => {
    if (!isCapturing) { setCaptureElapsed(0); return; }
    setCaptureElapsed((performance.now() - captureStartedAtRef.current) / 1000);
    const id = setInterval(() => {
      setCaptureElapsed((performance.now() - captureStartedAtRef.current) / 1000);
    }, 200);
    return () => clearInterval(id);
  }, [isCapturing]);

  // Pass the immediate local refGain — not the debounced shared-state value —
  // so the mix always uses exactly what the reference slider shows.
  const handleMix = () => wrap(
    () => host.triggerMix(participantGains, participantOffsets, refGain));

  const handleDeleteTake = (participantId: string) => wrap(async () => {
    if (!p2g.sessionId) return;
    const res = await fetch("/api/play2gether/record", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p2g.sessionId, participantId }),
    });
    if (!res.ok) throw new Error(`delete failed: ${res.status}`);
    // Optimistic local update — polling is paused during `done`, so without
    // this the row would stick around until the next phase change.
    setServerSession((prev) => {
      const { [participantId]: _removed, ...rest } = prev.participants;
      return { ...prev, participants: rest };
    });
    setParticipantGains((prev) => {
      const { [participantId]: _removed, ...rest } = prev;
      return rest;
    });
    setParticipantOffsets((prev) => {
      const { [participantId]: _removed, ...rest } = prev;
      return rest;
    });
    // Forget the seed too, so a re-record of this participant seeds again
    // instead of being treated as already-applied.
    delete seededOffsetsRef.current[participantId];
    touchedOffsetsRef.current.delete(participantId);
    // A deleted take must not keep holding the one expanded slot.
    setExpandedTakeId((prev) => (prev === participantId ? null : prev));
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const sessionCreated   = p2g.status !== "idle";
  const isRehearsal      = phase === "rehearsal";
  const isPreparing      = phase === "preparing";
  const isUploading      = phase === "uploading";
  // A sync round is in flight only while this client is still sending its own
  // take. It is NOT "phase === uploading": `status` stays "active" after a round
  // ends, so `derivePhase` returns "uploading" indefinitely — for a take round
  // the mix is what moves it on, but a sync round has no mix, so keying the Run
  // button off the phase left it disabled forever and the host could not run two
  // in a row (reported from the first field run, 2026-09-01).
  const syncRoundInFlight =
    p2g.roundKind === "sync" &&
    (phase === "countdown" || phase === "recording" || (isUploading && uploading));
  const isDone           = phase === "done";
  const canRehearsal     = isPreparing && !!p2g.referenceUrl;
  // Host can launch a fresh round from preparing/rehearsal (first take), from
  // uploading (re-do someone's take before mixing), or from done (after mix).
  //
  // A reference is NOT required. It used to be, on the reasoning that every
  // take is layered on top of one — but that forecloses the case where the
  // base itself is played by a participant rather than by the host: target
  // that one player, let them record against the metronome, then promote their
  // take with "Use as new layer" and it becomes the reference everyone else
  // records against.
  //
  // Nothing downstream needed changing for this. The reference playback effect
  // already no-ops without a URL (usePlay2GetherSession.ts), the metronome
  // never depended on a reference, and runMix already treats the reference as
  // optional ("if present"). This gate was the only thing in the way.
  const canStart         = (isPreparing || isRehearsal || isUploading || isDone)
                            && !!p2g.sessionId;
  const uploadedCount    = Object.keys(serverSession.participants).length;
  // Host can re-mix as many times as they want while there are recordings.
  const canMix           = (phase === "uploading" || isDone) && uploadedCount > 0;
  const isMixing         = phase === "mixing";
  const totalParticipants = room?.remoteParticipants.size ?? 0;
  const uploadedIds      = Object.keys(serverSession.participants);

  /**
   * Match levels — one fader per take, so the takes sit at the same loudness.
   *
   * The anchor is the MEDIAN of the measured levels, not the loudest and not
   * the quietest, and the 2026-09-04 two-machine session is why. Its two takes
   * arrived at -20.1 and -41.9 dBFS: a 21.7 dB spread, out of which the mix
   * came back 90 % one take, 6 % reference and 3 % the other. Anchoring on the
   * quietest would pull the loud take 21.7 dB down into the same hole;
   * anchoring on the loudest asks for a 12x boost the fader does not have (it
   * stops at 2). The median splits it: on that session it proposes 0.29 and
   * 2.00 and lands the pair ~5 dB apart instead of 22.
   *
   * Boosting is bounded twice — by the fader's own maximum and by the take's
   * measured PEAK, which is never pushed past PEAK_CEILING_DB. `amix` runs with
   * `normalize=0` (mix/route.ts), so takes are summed with nothing dividing
   * them down and a boost spends real headroom.
   *
   * When a take cannot reach the target the note says so, because that is a
   * RECORDING problem no fader fixes: a take 22 dB below the rest was made on
   * an input gain that was never going to work, and the answer is to raise it
   * before the next round.
   *
   * Deliberately a BUTTON, not automatic. Levels are a musical decision — a
   * backing part is meant to sit under a lead — so this proposes the starting
   * point a host would otherwise set by ear, and every fader stays theirs
   * afterwards. Same rule the alignment measurements follow: they propose.
   */
  const PEAK_CEILING_DB = -3;
  const [levelNote, setLevelNote] = useState<string | null>(null);
  const measuredLevels = uploadedIds
    .map((id) => ({
      id,
      levelDb: serverSession.participants[id]?.levelDb,
      peakDb: serverSession.participants[id]?.peakDb,
    }))
    .filter((r): r is { id: string; levelDb: number; peakDb: number | undefined } =>
      typeof r.levelDb === "number");

  const matchLevels = () => {
    // A muted take is not in the mix, so it neither takes a fader from this nor
    // votes on the median. Writing a gain over a 0 would silently UNMUTE it,
    // which is the one thing a level button must never do: the host muted that
    // take on purpose and nothing here knows why.
    const active = measuredLevels.filter(({ id }) => (participantGains[id] ?? 1) !== 0);
    if (active.length < 2) return;
    const sorted = [...active].sort((a, b) => a.levelDb - b.levelDb);
    const mid = Math.floor(sorted.length / 2);
    const target = sorted.length % 2
      ? sorted[mid].levelDb
      : (sorted[mid - 1].levelDb + sorted[mid].levelDb) / 2;

    const next = { ...participantGains };
    let short = 0;
    for (const { id, levelDb, peakDb } of active) {
      const wanted = Math.pow(10, (target - levelDb) / 20);
      const peakLimit = typeof peakDb === "number"
        ? Math.pow(10, (PEAK_CEILING_DB - peakDb) / 20)
        : Infinity;
      const gain = Math.max(0.05, Math.min(2, peakLimit, wanted));
      next[id] = Math.round(gain * 100) / 100;
      // More than a dB short of where it was asked to sit: say so, rather than
      // leaving the host wondering why two faders did not even the takes up.
      if (Math.abs(20 * Math.log10(gain / wanted)) > 1) short++;
    }
    setParticipantGains(next);

    const muted = measuredLevels.length - active.length;
    const unmeasured = uploadedIds.length - measuredLevels.length;
    setLevelNote(
      `Matched ${active.length} takes to ${target.toFixed(0)} dB`
      + (muted ? ` · ${muted} left muted` : "")
      + (short ? ` · ${short} could not reach it (too far below the rest — raise their input gain)` : "")
      + (unmeasured ? ` · ${unmeasured} without a measured level` : "")
    );
  };
  const compactList      = densityPref === "compact"
                            || (densityPref === "auto" && uploadedIds.length > COMPACT_LIST_THRESHOLD);
  const readyIds         = Object.keys(serverSession.ready).filter((k) => serverSession.ready[k]);
  // Participant recording/upload failures reported for the CURRENT round only
  // (keyed by clapAt so stale failures from earlier rounds don't linger).
  const roundFailures    = Object.entries(serverSession.failures ?? {})
    .filter(([, f]) => f.clapAt == null || f.clapAt === p2g.clapAt);

  // ── Render ─────────────────────────────────────────────────────────────────

  const card = (
        <div
          className={embedded
            ? "bg-zinc-950 flex flex-col overflow-hidden h-full min-h-0"
            : "bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden"}
          style={embedded ? undefined : { width: MAIN_W, height: PANEL_H }}
        >

        {/* Header */}
        <div className={`${embedded ? "" : "p2g-drag-handle cursor-grab active:cursor-grabbing "}select-none
                        flex items-center justify-between px-4 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0`}>
          <div className="flex items-center gap-2">
            <Music2 className="w-4 h-4 text-teal-400" />
            <span className="font-semibold text-sm text-white">Play2Gether</span>
            <PhaseBadge phase={phase} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleHelp}
              title={helpOpen ? "Hide help" : "Show help"}
              className={`transition-colors ${helpOpen ? "text-teal-400" : "text-zinc-400 hover:text-white"}`}
            >
              <HelpCircle className="w-4 h-4" />
            </button>
            <button onClick={() => sessionCreated ? handleClose() : onClose()}
              className="text-zinc-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {embedded && helpOpen && (
          <HelpPanel fill onClose={() => setHelpOpen(false)} width={HELP_W} height={PANEL_H} />
        )}
        <div className={`${embedded && helpOpen ? "hidden" : "flex"} flex-col gap-4 p-4 overflow-y-auto flex-1 min-h-0
                        [scrollbar-width:thin] [scrollbar-color:rgb(13_148_136)_transparent]
                        [&::-webkit-scrollbar]:w-2
                        [&::-webkit-scrollbar-track]:bg-transparent
                        [&::-webkit-scrollbar-thumb]:rounded-full
                        [&::-webkit-scrollbar-thumb]:bg-teal-600/70
                        [&::-webkit-scrollbar-thumb]:hover:bg-teal-500`}>
          {error && (
            <div className="bg-rose-900/60 border border-rose-700 rounded px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          {/* ── Capture-mode warning ──
              Takes are recorded off the PUBLISHED mic track, so in speech mode
              they go through Chrome's voice processing. Measured on a real
              session (2026-07-21): 45% of every take came back as exact digital
              zeros — voiceIsolation deleting the quiet passages — and the
              processing delay put the takes ~100ms behind the reference.
              A sync round DOES see that delay — it measures the take's own audio
              path — but only if the round is recorded in the same mode the takes
              will be, which is one more reason this warning stands.
              Deliberately a WARNING, not an automatic switch: music mode turns
              echo cancellation off for the whole room, which feeds back badly if
              anyone is on speakers rather than headphones. That is the host's
              call to make, not ours. ── */}
          {sessionCreated && roomAudioMode !== "music" && (
            <div className="flex flex-col gap-2 bg-amber-950/50 border border-amber-700/60
                            rounded-lg px-3 py-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-[11px] leading-snug">
                  <p className="font-semibold text-amber-300">The room is in speech mode</p>
                  <p className="text-amber-200/80 mt-0.5">
                    Takes will be recorded through noise suppression and voice
                    isolation: quiet passages get cut out, and they land late
                    against the reference. Switch to music mode before recording.
                  </p>
                </div>
              </div>
              <button
                onClick={() => { void setAudioMode("music"); }}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg
                           bg-amber-600 hover:bg-amber-500 text-[11.5px] font-semibold
                           text-amber-50 transition-colors"
              >
                <Music2 className="w-3.5 h-3.5" /> Switch the room to music mode
              </button>
              <p className="text-[10px] text-amber-200/50 leading-snug">
                This turns echo cancellation off for everyone — fine on headphones,
                but it can cause feedback if someone is listening on speakers.
              </p>
            </div>
          )}

          {/* Acoustic latency calibration used to sit here, and it is gone from
              the flow on purpose (2026-09-01). It measured a DEVICE round trip;
              the sync round in Step 4 measures the same path plus where the
              player actually puts a beat, in the audio path the take is recorded
              through. Two numbers that nearly agree and sometimes do not is a
              question the host has to adjudicate mid-session, and the answer was
              always the sync round.

              `runAcousticTrial` and its plumbing are still in the tree, unused
              from here: deleting them three days before a field session is the
              thing docs 10 and 11 both say not to do. Doing that cleanup is the
              open item — see docs/llm/11-sync-rounds.md. */}

          {/* ── STEP 1: Open Session ──
              Countdown and duration used to live here as required inputs.
              Now duration auto-syncs from the reference (ffprobe on upload)
              and countdown is a per-round control next to "Start Countdown"
              in Step 4 — keeps this step a single confident click. */}
          {!sessionCreated && (
            <div className="flex flex-col gap-3">
              <SectionTitle>1 · Open Session</SectionTitle>
              <p className="text-xs text-zinc-500">
                Recording duration auto-adapts to the reference track's length.
                Countdown defaults to 3s and can be tuned before each take.
              </p>
              <button onClick={handleOpen} disabled={busy}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg
                           bg-teal-600 hover:bg-teal-500 disabled:opacity-50
                           text-sm font-medium transition-colors">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Open Session
              </button>
            </div>
          )}

          {/* ── STEP 2: Reference audio ── */}
          {sessionCreated && (isPreparing || isRehearsal) && (
            <div className="flex flex-col gap-2">
              <SectionTitle>2 · Reference audio</SectionTitle>

              {p2g.referenceUrl ? (
                <div className="flex items-center gap-2 bg-emerald-900/40 border border-emerald-700
                                rounded px-3 py-2 text-xs text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 truncate">Reference ready</span>
                  <button
                    onClick={() => wrap(() => host.clearReference())}
                    disabled={busy}
                    title="Remove reference — then record or upload a new one"
                    className="text-emerald-400/70 hover:text-rose-400 disabled:opacity-40 transition-colors p-0.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  The backing track participants hear while recording — every take is
                  layered on top of it.
                  <span className="block mt-1 text-zinc-600">
                    Optional: skip this and have a participant play the base instead.
                    Set a metronome BPM in step 4, record just that player, then use
                    their take as the new layer.
                  </span>
                </p>
              )}

              <div className="flex gap-2">
                <label className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg
                                  bg-zinc-700 hover:bg-zinc-600 cursor-pointer text-xs font-medium">
                  <Upload className="w-3.5 h-3.5" /> File
                  <input type="file" accept="audio/*" className="hidden"
                    onChange={handleFileUpload} disabled={busy} />
                </label>
                {isCapturing ? (
                  <button onClick={handleStopCapture}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg
                               bg-rose-600 hover:bg-rose-500 text-xs font-medium">
                    <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                    Stop
                    <span className="font-mono tabular-nums">
                      {Math.floor(captureElapsed / 60)}:{String(Math.floor(captureElapsed % 60)).padStart(2, "0")}
                    </span>
                  </button>
                ) : (
                  <button onClick={handleStartCapture} disabled={busy || !captureSupported}
                    title={captureSupported ? "Record reference from mic" : "Recording isn't supported in this browser — use Chrome on desktop or upload a file"}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg
                               bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium">
                    <Mic className="w-3.5 h-3.5" /> Record
                  </button>
                )}
              </div>

              {/* Metronome for the base take. Whoever plays the reference has
                  nothing to keep time against — every later round has the
                  reference itself, this one has silence. Same tempo field as
                  the round metronome (one BPM per session), so setting it here
                  also arms the count-in for the rounds. */}
              <div className="flex items-center gap-2.5">
                <div className="w-20 shrink-0"
                  title="Metronome click while recording the base. 0 = off. Audible only — it is not recorded, as long as you're on headphones.">
                  <NumberField
                    label="Metro (BPM)"
                    value={p2g.metronomeBpm}
                    onChange={(v) => host.setMetronomeBpm(v)}
                    min={0}
                    max={240}
                    disabled={busy || isCapturing}
                  />
                </div>
                <p className="text-[10.5px] leading-snug text-zinc-500 min-w-0">
                  {p2g.metronomeBpm > 0
                    ? isCapturing
                      ? "Clicking now — free-running from the start of the recording."
                      : "Clicks while you record the base, as a tempo guide."
                    : "Optional click while recording the base. 0 = off."}
                </p>
              </div>

              {/* Bleed matters more here than anywhere else: a click captured
                  into the base is permanent — it plays under every round and
                  ends up in every mix. */}
              {p2g.metronomeBpm > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-700/50
                                bg-amber-950/40 px-2.5 py-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[10.5px] leading-snug text-amber-200/80">
                    Wear headphones. On speakers your mic records the click into
                    the base, and the base is permanent — it plays under every
                    round and lands in every mix.
                  </p>
                </div>
              )}

              {p2g.referenceUrl && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
                  <MasterPlayer key={p2g.referenceUrl} src={p2g.referenceUrl} label="Reference preview"
                    fallbackDuration={p2g.referenceDuration} />
                </div>
              )}

              {/* Optional .lrc lyrics synced to the reference. Participants see
                  prev/current/next lines at the bottom of their screen while
                  the reference is playing. */}
              <div className="flex flex-col gap-1 mt-1 pt-2 border-t border-zinc-800">
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">
                  Lyrics (optional, .lrc)
                </p>
                {p2g.lyricsUrl ? (
                  <div className="flex items-center gap-2 bg-emerald-900/30 border border-emerald-700/40
                                  rounded px-3 py-1.5 text-xs text-emerald-300">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="flex-1 truncate">Lyrics uploaded — singers will see them</span>
                    <button
                      onClick={() => wrap(() => host.clearLyrics())}
                      title="Remove lyrics"
                      className="text-zinc-500 hover:text-rose-400 transition-colors p-0.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg
                                    bg-zinc-800 hover:bg-zinc-700 cursor-pointer text-xs">
                    <Upload className="w-3.5 h-3.5" /> Upload .lrc
                    <input
                      type="file"
                      accept=".lrc,text/plain"
                      className="hidden"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) wrap(() => host.uploadLyrics(f));
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 3: Rehearsal ── */}
          {sessionCreated && (isPreparing || isRehearsal) && (
            <div className="flex flex-col gap-2">
              <SectionTitle>3 · Rehearsal</SectionTitle>

              {!isRehearsal && (
                <p className="text-xs text-zinc-500">
                  Let participants hear the reference and adjust levels before recording.
                </p>
              )}

              {isRehearsal && (
                <>
                  {/* Ready counter */}
                  <div className="flex items-center justify-between bg-zinc-800 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-teal-300">
                      <Headphones className="w-3.5 h-3.5" />
                      Participants ready
                    </div>
                    <span className="text-sm font-bold text-white tabular-nums">
                      {readyIds.length}
                      <span className="text-zinc-500 font-normal">
                        {totalParticipants > 0 ? ` / ${totalParticipants}` : ""}
                      </span>
                    </span>
                  </div>

                  {readyIds.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {readyIds.map((id) => (
                        <div key={id} className="flex items-center gap-2 text-xs text-emerald-400">
                          <CheckCircle2 className="w-3 h-3 shrink-0" />
                          <span className="truncate">{serverSession.ready[id]?.name ?? id}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Play reference for participants */}
                  <button onClick={() => host.setPlayRehearsal(!p2g.playRehearsal)}
                    className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg
                                text-sm font-medium transition-colors ${
                                  p2g.playRehearsal
                                    ? "bg-rose-700 hover:bg-rose-600"
                                    : "bg-emerald-700 hover:bg-emerald-600"
                                }`}>
                    {p2g.playRehearsal
                      ? <><StopCircle className="w-4 h-4" /> Stop reference for all</>
                      : <><Play className="w-4 h-4" /> Play reference for all</>}
                  </button>
                </>
              )}

              {/* Toggle rehearsal */}
              <button
                onClick={() => isRehearsal ? host.endRehearsal() : host.startRehearsal()}
                disabled={!canRehearsal && !isRehearsal}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg
                            text-sm font-medium transition-colors disabled:opacity-40 ${
                              isRehearsal
                                ? "bg-zinc-700 hover:bg-zinc-600"
                                : "bg-teal-800 hover:bg-teal-700"
                            }`}>
                <Headphones className="w-4 h-4" />
                {isRehearsal ? "End rehearsal" : "Start rehearsal"}
              </button>
            </div>
          )}

          {/* ── STEP 4: Launch ── */}
          {sessionCreated && (
            <div className="flex flex-col gap-2">
              <SectionTitle>4 · Launch</SectionTitle>

              {/* Device calibration, now a round rather than a button each
                  musician has to remember. This is the number the mixer starts
                  from — see CalibRoundCard for why it outranks the sync round.

                  While a round is live this card becomes the host's own
                  measurement: the host is frequently the singer, and they need
                  the same six seconds of "headphones off" as everyone else. */}
              {phase !== "countdown" && phase !== "recording" && (
                calibRound.status !== "idle" ? (
                  <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.06] p-4
                                  flex flex-col items-center gap-3">
                    <CalibRoundPanel state={calibRound} />
                  </div>
                ) : (
                  <CalibRoundCard
                    results={serverSession.calibOffsets ?? {}}
                    // The host is measured too, so the population is the room.
                    participantCount={totalParticipants + 1}
                    busy={busy}
                    onRun={() => wrap(() => host.startCalibRound())}
                    onClear={(participantId) => {
                      void fetch("/api/play2gether/calib", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sessionId: p2g.sessionId, participantId }),
                      }).catch(() => {});
                      // Drop the seeding memo so the next poll re-seeds this
                      // person's takes from whatever is left (their sync round,
                      // or nothing) instead of leaving the deleted number on
                      // the slider.
                      seededOffsetsRef.current = {};
                      setServerSession((prev) => {
                        const next = { ...(prev.calibOffsets ?? {}) };
                        delete next[participantId];
                        return { ...prev, calibOffsets: next };
                      });
                    }}
                  />
                )
              )}

              {/* The sync round is HIDDEN by default (2026-09-04) and comes back
                  on the link at the foot of this step — see `showSyncRound`.
                  When it is shown it sits BELOW the calibration card on
                  purpose: the order of these two is the order the mixer seeds
                  from them, and a host reading top to bottom should meet them
                  that way. It is the fallback for anyone calibration could not
                  measure — see SyncRoundCard for what changed on 2026-09-03. */}
              {showSyncRound
                && phase !== "countdown" && phase !== "recording" && calibRound.status === "idle" && (
                <SyncRoundCard
                  results={serverSession.syncOffsets ?? {}}
                  calibResults={serverSession.calibOffsets ?? {}}
                  // The host records too on an everyone round, so the population
                  // that should have a measurement is the room, host included.
                  participantCount={totalParticipants + 1}
                  busy={busy}
                  running={syncRoundInFlight}
                  onRun={() => wrap(() => host.startSyncRound())}
                />
              )}

              {/* The self-serve button stays for the host alone: measuring one
                  device without pulling the whole band's headphones off is
                  exactly what you want when someone's number looks wrong. */}
              {phase !== "countdown" && phase !== "recording" && calibRound.status === "idle" && (
                calibrating ? (
                  <CalibrationFlow
                    onComplete={(ms, meta) => {
                      setCalibratedLatency(ms);
                      // Same destination as a calibration round's result: the mixer
                      // seeds from the server copy, so a measurement that only reached
                      // localStorage would be invisible to the host.
                      publishCalibration({ latencyMs: ms, ...meta });
                      setCalibrating(false);
                    }}
                    onCancel={() => setCalibrating(false)}
                  />
                ) : (
                  <CalibrationButton
                    calibratedLatencyMs={calibratedLatencyMs}
                    onOpen={() => setCalibrating(true)}
                    onClear={() => { setCalibratedLatency(null); clearPublishedCalibration(); }}
                  />
                )
              )}

              {/* The way back to the sync round. A footnote, not a card: the
                  host who wants it knows what it is, and the host who does not
                  should not have to decide about it mid-session. */}
              {phase !== "countdown" && phase !== "recording" && calibRound.status === "idle" && (
                <button
                  onClick={toggleSyncRound}
                  aria-pressed={showSyncRound}
                  className="self-center text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                  title={showSyncRound
                    ? "Take the sync round back out of this panel"
                    : "Bring back the click round that measures where a player puts the beat. "
                      + "It reads low and it can refuse — calibration is the number the mixer uses."}
                >
                  {showSyncRound ? "hide the sync round" : "show the sync round"}
                </button>
              )}

              {phase === "countdown" && (
                <div className="text-center py-3">
                  <span className="text-5xl font-bold text-amber-400 tabular-nums">{countdown}</span>
                  <p className="text-xs text-zinc-400 mt-1">
                    {p2g.roundKind === "sync"
                      ? `Sync round — one note on every click, ${SYNC_BARS} bars`
                      : "Starting…"}
                  </p>
                </div>
              )}

              {phase === "recording" && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                    </span>
                    <span className="text-xs font-medium text-rose-400">
                      {p2g.roundKind === "sync" ? "Measuring — play on every click" : "Recording"}
                    </span>
                  </div>
                  <div className="w-full bg-zinc-700 rounded-full h-1.5">
                    <div className="bg-rose-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${recordingProgress * 100}%` }} />
                  </div>
                </div>
              )}

              {/* Abandon the round. Host-only by construction: this panel is the
                  host's, and `cancelRound` lives under `host` in the hook.
                  Offered during the countdown too — "something is wrong, stop"
                  is most often noticed before anyone has played a note. */}
              {(phase === "countdown" || phase === "recording") && (
                cancelArmed ? (
                  <div className="flex flex-col gap-1.5 bg-rose-950/40 border border-rose-800/60 rounded-lg px-3 py-2">
                    <div className="flex items-start gap-2 text-xs text-rose-200">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        Discard this round? Everyone stops recording and the take
                        is lost — it cannot be recovered.
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setCancelArmed(false); wrap(() => host.cancelRound()); }}
                        disabled={busy}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md
                                   bg-rose-600 hover:bg-rose-500 disabled:opacity-50
                                   text-xs font-medium transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Yes, discard it
                      </button>
                      <button
                        onClick={() => setCancelArmed(false)}
                        className="flex-1 py-1.5 rounded-md bg-zinc-700 hover:bg-zinc-600
                                   text-xs font-medium transition-colors"
                      >
                        Keep recording
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setCancelArmed(true)}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg
                               bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-rose-300
                               text-xs font-medium transition-colors"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel round
                  </button>
                )
              )}

              {/* Take rounds only. A sync round produces no takes at all — its
                  uploads are measured and land in `syncOffsets`, never in
                  `participants` — so this counter read "Recordings received 0"
                  throughout one and then stayed there, since the phase never
                  ends. The sync card's own "N measured" badge is the counter
                  that means something during a sync round. */}
              {p2g.roundKind !== "sync" && (phase === "recording" || phase === "uploading") && (
                <div className="flex items-center justify-between bg-zinc-800 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-amber-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Recordings received
                  </div>
                  <span className="text-sm font-bold text-white tabular-nums">
                    {uploadedIds.length}
                    <span className="text-zinc-500 font-normal">
                      {totalParticipants > 0 ? ` / ${totalParticipants}` : ""}
                    </span>
                  </span>
                </div>
              )}

              {/* Host's OWN take failed (e.g. mic not published in time). The
                  host records too when the round targets everyone, but the host
                  panel used to swallow this error silently. Only a "upload"-kind
                  failure can be retried (bytes still in memory); a "capture"
                  failure means the round has to be re-run. */}
              {uploadError && (
                <div className="flex items-center justify-between gap-2 bg-rose-950/60 border border-rose-800 rounded-lg px-3 py-2">
                  <span className="text-xs text-rose-300 min-w-0">
                    <span className="font-semibold">
                      {uploadErrorKind === "capture" ? "Your take failed: " : "Your upload failed: "}
                    </span>
                    {uploadError}
                  </span>
                  {uploadErrorKind !== "capture" && (
                    <button
                      onClick={retryUpload}
                      className="text-[11px] uppercase tracking-wide text-rose-300 hover:text-white
                                 border border-rose-700 rounded px-2 py-0.5 shrink-0 transition-colors"
                    >
                      retry
                    </button>
                  )}
                </div>
              )}

              {/* Participants whose take failed this round — reported to the
                  server so the host sees who dropped out instead of waiting for
                  a take that will never arrive. */}
              {roundFailures.length > 0 && (
                <div className="flex flex-col gap-1">
                  {roundFailures.map(([id, f]) => (
                    <div key={id} className="flex items-start gap-2 text-xs text-rose-300
                                             bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                      <span className="min-w-0">
                        <span className="font-semibold">{f.name}</span> — {f.reason}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {phase === "uploading" && uploadedIds.length > 0 && (
                <div className="flex flex-col gap-1">
                  {uploadedIds.map((id) => {
                    const p = serverSession.participants[id];
                    const label = p?.takeNum && p.takeNum > 1
                      ? `${p.name} (${p.takeNum})`
                      : (p?.name ?? id);
                    return (
                      <div key={id} className="flex items-center gap-2 text-xs text-emerald-400">
                        <CheckCircle2 className="w-3 h-3 shrink-0" />
                        <span className="truncate">{label}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {canStart && (
                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                    <label className="flex flex-col gap-1 min-w-0">
                      <span className="text-xs text-zinc-400">Who records this round</span>
                      <select
                        value={targetIdSel}
                        onChange={(e) => setTargetIdSel(e.target.value)}
                        disabled={busy}
                        className="w-full bg-zinc-800 text-white text-sm rounded px-2 py-1.5
                                   border border-zinc-700 focus:outline-none focus:border-teal-500
                                   disabled:opacity-40"
                      >
                        <option value="">Everyone</option>
                        {room?.localParticipant && (
                          <option value={room.localParticipant.identity}>
                            {(room.localParticipant.name || room.localParticipant.identity) + " (me)"}
                          </option>
                        )}
                        {Array.from(room?.remoteParticipants.values() ?? []).map((p) => (
                          <option key={p.identity} value={p.identity}>
                            {p.name || p.identity}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="w-20">
                      <NumberField
                        label="Countdown (s)"
                        value={p2g.countdownSecs}
                        onChange={(v) => host.setCountdownSecs(v)}
                        min={1}
                        max={30}
                        disabled={busy}
                      />
                    </div>
                    <div
                      className="w-20"
                      title={p2g.referenceDuration
                        ? `Auto-detected from reference (${p2g.referenceDuration.toFixed(1)}s). Override to record a section.`
                        : "Override the recording length manually."}
                    >
                      <NumberField
                        label="Duration (s)"
                        value={p2g.recordingDuration}
                        onChange={(v) => host.setRecordingDuration(v)}
                        min={5}
                        max={MAX_RECORDING_DURATION_SEC}
                        disabled={busy}
                      />
                    </div>
                    <div
                      className="w-20"
                      title="Optional metronome click, phase-locked to the clap (count-in + through the take). 0 = off. Audible cue only — not recorded. Use headphones to avoid bleed."
                    >
                      <NumberField
                        label="Metro (BPM)"
                        value={p2g.metronomeBpm}
                        onChange={(v) => host.setMetronomeBpm(v)}
                        min={0}
                        max={240}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => wrap(() => host.startCountdown(targetIdSel || null))}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg
                               bg-rose-600 hover:bg-rose-500 disabled:opacity-50
                               text-sm font-medium transition-colors"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Timer className="w-4 h-4" />}
                    {targetIdSel
                      ? `Record ${(room?.getParticipantByIdentity(targetIdSel)?.name) || "selected"} only`
                      : (isDone || isUploading) ? "Record another take" : "Start Countdown"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 5: Mixer ── */}
          {(canMix || isMixing || p2g.resultUrl) && (
            <div className="flex flex-col gap-2">
              <SectionTitle>
                <span className="flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3 h-3" /> 5 · Mixer & listen
                </span>
              </SectionTitle>

              {isMixing && (
                <div className="flex items-center gap-2 text-xs text-teal-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Mixing tracks with ffmpeg…
                </div>
              )}

              {/* Track count + density control. Only worth the row once there
                  are enough takes for the list to be a problem. */}
              {canMix && !isMixing && uploadedIds.length > 0 && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>{uploadedIds.length} takes</span>
                  <span className="flex-1" />
                  {measuredLevels.filter(({ id }) => (participantGains[id] ?? 1) !== 0).length > 1 && (
                    <button
                      onClick={matchLevels}
                      className="inline-flex items-center gap-1 rounded border border-zinc-700
                                 px-1.5 py-0.5 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                      title={"Sets each take's fader from the level measured when it arrived, so they "
                        + "all sit at the same loudness. It moves faders only — no compression, nothing "
                        + "touched inside a take, and the reference is left alone. Every fader is still "
                        + "yours afterwards."}
                    >
                      <Gauge className="w-3 h-3" />
                      Match levels
                    </button>
                  )}
                  {uploadedIds.length > 3 && (
                  <button
                    onClick={() => setDensityPref(compactList ? "full" : "compact")}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700
                               px-1.5 py-0.5 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                    title={compactList
                      ? "Show every take's full channel strip"
                      : "Collapse takes to one line each"}
                  >
                    {compactList ? "Expand all" : "Compact list"}
                  </button>
                  )}
                </div>
              )}

              {levelNote && (
                <p className="text-[10px] text-zinc-500 -mt-1">{levelNote}</p>
              )}

              {/* Per-track channel strips */}
              {canMix && !isMixing && (
                <div ref={mixerWidthRef} className="flex flex-col gap-2">
                  <ZoomBar view={view} totalSec={totalSec} widthPx={mixerWidth} onView={setView} />
                  {p2g.referenceUrl && (
                    <GainSlider
                      name="Reference"
                      isReference
                      value={refGain}
                      onChange={debouncedRefGain}
                      audioUrl={p2g.referenceUrl}
                      compact={compactList}
                      expanded={expandedTakeId === REFERENCE_TRACK_ID}
                      onToggleExpanded={() => setExpandedTakeId(
                        expandedTakeId === REFERENCE_TRACK_ID ? null : REFERENCE_TRACK_ID)}
                      view={view}
                      totalSec={totalSec}
                      onView={setView}
                      playheadSec={playheadSec}
                      onPlayhead={setPlayheadSec}
                    />
                  )}
                  {uploadedIds.map((id) => {
                    const participant = serverSession.participants[id];
                    const file = participant?.file;
                    const baseName = participant?.name ?? id;
                    // Bust the browser cache when the participant re-records:
                    // same filename on disk, but uploadedAt changes → new URL.
                    const audioUrl = file && p2g.sessionId
                      ? `/api/play2gether/file/${p2g.sessionId}/${file}?t=${participant?.uploadedAt ?? 0}`
                      : undefined;
                    // Precomputed envelope written at ingest. Absent on takes
                    // recorded before it existed → the strip decodes the audio,
                    // as it always did.
                    const peaksUrl = participant?.peaksFile && p2g.sessionId
                      ? `/api/play2gether/file/${p2g.sessionId}/${participant.peaksFile}?t=${participant?.uploadedAt ?? 0}`
                      : undefined;
                    // High-resolution envelope — the one the zoom reads. Absent
                    // on takes recorded before it existed, which fall back to
                    // the 900-bucket JSON above and simply zoom to a blockier
                    // picture rather than failing.
                    const peaksBinUrl = participant?.peaksBinFile && p2g.sessionId
                      ? `/api/play2gether/file/${p2g.sessionId}/${participant.peaksBinFile}?t=${participant?.uploadedAt ?? 0}`
                      : undefined;
                    return (
                      <GainSlider
                        key={id}
                        name={baseName}
                        takeNum={participant?.takeNum}
                        value={participantGains[id] ?? 1.0}
                        onChange={(v) => setParticipantGains((prev) => ({ ...prev, [id]: v }))}
                        audioUrl={audioUrl}
                        peaksUrl={peaksUrl}
                        peaksBinUrl={peaksBinUrl}
                        view={view}
                        totalSec={totalSec}
                        onView={setView}
                        playheadSec={playheadSec}
                        onPlayhead={setPlayheadSec}
                        compact={compactList}
                        expanded={expandedTakeId === id}
                        onToggleExpanded={() => setExpandedTakeId(expandedTakeId === id ? null : id)}
                        referenceUrl={p2g.referenceUrl ?? undefined}
                        captureDelayMs={participant?.captureDelayMs ?? 0}
                        onUseAsRef={file ? () => wrap(async () => {
                          await host.promoteMix(file);
                          setServerSession({ participants: {}, ready: {} });
                          setParticipantGains({});
                          setParticipantOffsets({});
                          setExpandedTakeId(null);
                          seededOffsetsRef.current = {};
                          touchedOffsetsRef.current = new Set();
                        }) : undefined}
                        onDelete={() => handleDeleteTake(id)}
                        offsetMs={participantOffsets[id] ?? 0}
                        onOffsetChange={(ms) => {
                          touchedOffsetsRef.current.add(id);
                          setParticipantOffsets((prev) => ({ ...prev, [id]: ms }));
                        }}
                        onOffsetNudge={(deltaMs) => {
                          touchedOffsetsRef.current.add(id);
                          setParticipantOffsets((prev) => ({
                            ...prev, [id]: clampToSlider((prev[id] ?? 0) + deltaMs),
                          }));
                        }}
                        syncOffset={serverSession.syncOffsets?.[participant?.participantId ?? id]}
                        calibOffset={serverSession.calibOffsets?.[participant?.participantId ?? id]}
                        // Keyed by the TAKE, not by the person: this one
                        // describes a performance, so re-recording invalidates
                        // it and the row says so.
                        alignment={serverSession.alignments?.[id]}
                        takeFile={file}
                        takeUploadedAt={participant?.uploadedAt}
                        levelDb={participant?.levelDb}
                        peakDb={participant?.peakDb}
                        analysing={analysing.has(id)}
                        onAnalyse={p2g.referenceUrl ? () => handleAnalyse(id) : undefined}
                      />
                    );
                  })}
                </div>
              )}

              {/* Sticky action bar. These are the two things the host does over
                  and over while working the faders — re-render, and play the
                  result to the room. With ten strips above them they'd
                  otherwise sit several screens below the fold. The full master
                  card (download, share, layer) stays in flow underneath. */}
              {canMix && !isMixing && (
                <div className="sticky bottom-0 z-10 -mx-4 px-4 py-2 flex gap-2
                                bg-zinc-950/95 backdrop-blur-sm border-t border-zinc-800">
                  {/* Hear the balance without rendering it. This is the only
                      transport in the mixer: it plays every audible take over
                      the reference, each where the mix will put it, and the
                      faders move it live. */}
                  <button
                    onClick={preview.toggle}
                    disabled={preview.state === "loading" || previewTooBig}
                    title={previewTooBig
                      ? `${Math.round(previewBytes / 1e6)} MB of audio to decode — too much to `
                        + `preview in the browser. Mix it instead, or mute some takes.`
                      : preview.state === "playing"
                        ? "Stop"
                        : "Play every audible take over the reference, exactly where the mix "
                          + "puts them. Nothing is rendered; the faders move it as it plays."}
                    className={`w-11 shrink-0 grid place-items-center rounded-lg transition-colors
                                disabled:opacity-40 ${
                                  preview.state === "playing"
                                    ? "bg-teal-500 text-zinc-950"
                                    : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                                }`}>
                    {preview.state === "loading"
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : preview.state === "playing"
                        ? <Pause className="w-4 h-4" />
                        : <Play className="w-4 h-4 ml-0.5" />}
                  </button>
                  <button onClick={handleMix} disabled={busy}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg
                               bg-teal-700 hover:bg-teal-600 disabled:opacity-50
                               text-sm font-medium transition-colors">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Music2 className="w-4 h-4" />}
                    {p2g.resultUrl ? "Mix again" : "Mix recordings"}
                  </button>
                  {p2g.resultUrl && (
                    <button
                      onClick={() => host.setPlayResult(!p2g.playResult)}
                      title={p2g.playResult ? "Stop for everyone" : "Play for everyone"}
                      className={`w-11 shrink-0 grid place-items-center rounded-lg transition-colors ${
                        p2g.playResult
                          ? "bg-rose-600 hover:bg-rose-500 text-white"
                          : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950"
                      }`}>
                      {p2g.playResult ? <StopCircle className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              )}

              {/* Master mix — the payoff of the whole flow, elevated in its own
                  teal-accented card with the primary "Play for everyone" action. */}
              {p2g.resultUrl && (
                <div className="rounded-xl border border-teal-500/25 bg-gradient-to-b from-zinc-900 to-zinc-900/50
                                shadow-lg shadow-black/30 p-3 flex flex-col gap-3">
                  <MasterPlayer key={p2g.resultUrl} src={p2g.resultUrl} onPlayhead={setPlayheadSec} />

                  {/* What the render did to the output level. The faders set the
                      balance; this says where the whole thing ended up, so a mix
                      that comes back louder than the faders suggest is explained
                      instead of mysterious. */}
                  {typeof serverSession.masterGainDb === "number"
                    && Math.abs(serverSession.masterGainDb) > 0.05 && (
                    <p
                      className={`text-[10px] tabular-nums -mt-1 ${
                        serverSession.masterGainDb < 0 ? "text-amber-200/70" : "text-zinc-500"
                      }`}
                      title={"The master scales every track by the same number, so it does not "
                        + "change the balance you set — it only puts the finished mix at a sensible "
                        + "output level. A negative value means the faders summed past full scale "
                        + "and the render was pulled back to stop it clipping."}
                    >
                      Master {serverSession.masterGainDb > 0 ? "+" : ""}
                      {serverSession.masterGainDb.toFixed(1)} dB
                      {typeof serverSession.mixPeakDb === "number"
                        && ` · peak was ${serverSession.mixPeakDb.toFixed(1)} dBFS`}
                      {serverSession.masterGainDb < 0 && " · the faders were summing past full scale"}
                    </p>
                  )}

                  <button onClick={() => host.setPlayResult(!p2g.playResult)}
                    className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg
                                text-sm font-semibold transition-colors ${
                                  p2g.playResult
                                    ? "bg-rose-600 hover:bg-rose-500 text-white"
                                    : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950"
                                }`}>
                    {p2g.playResult
                      ? <><StopCircle className="w-4 h-4" /> Stop for everyone</>
                      : <><Play className="w-4 h-4" /> Play for everyone</>}
                  </button>

                  <div className="flex gap-2">
                    <a href={p2g.resultUrl} download="play2gether-mix.webm"
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg
                                 bg-zinc-800 border border-zinc-700 hover:border-teal-500/40 hover:text-teal-300
                                 text-xs font-medium transition-colors">
                      <Download className="w-3.5 h-3.5" /> Download
                    </a>
                    <button
                      onClick={() => host.setAllowDownload(!p2g.allowDownload)}
                      title={p2g.allowDownload
                        ? "Participants can download the mix — click to revoke"
                        : "Let participants download the mix"}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg
                                  text-xs font-medium border transition-colors ${
                                    p2g.allowDownload
                                      ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                                      : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-600"
                                  }`}>
                      {p2g.allowDownload ? "Shared ✓" : "Share with class"}
                    </button>
                  </div>

                  <button
                    onClick={() => wrap(async () => {
                      await host.promoteMix();
                      setServerSession({ participants: {}, ready: {} });
                      setParticipantGains({});
                      setParticipantOffsets({});
                                        setExpandedTakeId(null);
                      seededOffsetsRef.current = {};
                      touchedOffsetsRef.current = new Set();
                    })}
                    disabled={busy}
                    title="Layer the mix as the new reference. All singers record on top of this."
                    className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg
                               bg-teal-500/10 border border-teal-500/30 text-teal-300
                               hover:bg-teal-500/20 disabled:opacity-50 text-xs font-medium transition-colors"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                    Use mix as new layer
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Reset ── */}
          {sessionCreated && phase !== "recording" && phase !== "countdown" && (
            <button onClick={handleClose} disabled={busy}
              className="w-full py-1.5 rounded-lg border border-zinc-700
                         hover:bg-zinc-800 text-xs text-zinc-400 transition-colors">
              Close session
            </button>
          )}
        </div>
        </div>
  );

  if (embedded) return card;

  return (
    <Rnd
      position={position}
      onDragStop={(_, d) => setPosition({ x: d.x, y: d.y })}
      size={{ width: helpOpen ? TOTAL_W_WITH_HELP : MAIN_W, height: "auto" }}
      enableResizing={false} dragHandleClassName="p2g-drag-handle"
      className="z-50" bounds="parent">
      <div className="flex gap-3 items-stretch">
        {card}
        {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} width={HELP_W} height={PANEL_H} />}
      </div>
    </Rnd>
  );
}