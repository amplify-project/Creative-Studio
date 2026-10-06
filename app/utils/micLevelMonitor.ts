/**
 * Rolling "how loud is this person when they make sound" for the live mic.
 *
 * Feeds the mode-switch level check in MediaControls: music mode turns
 * automatic gain off, so a mic that AGC was lifting in speech arrives at its
 * own, often much lower, level the moment the room switches. The fix is the
 * user's input gain, which no code can set, so the job here is only to notice
 * and say so — through the existing `audio.calibrateMic` / low_level panel.
 *
 * Measures the PUBLISHED track (never a second capture — doc 08) at 10 Hz:
 * RMS of 100 ms frames, kept only when above ACTIVE_FLOOR_DB so silence and a
 * muted track say nothing. The level reported is the 75th percentile of those
 * active frames: the median would be dragged down by room noise and tails in
 * music mode (no noise suppression), the peak by a single knock. A stereo
 * capture is downmixed by the AnalyserNode, which is also what a mono listener
 * hears.
 */

/** Frames quieter than this are silence / room noise, not the person. */
export const ACTIVE_FLOOR_DB = -50;
/** Need at least this much sound before a level means anything. */
const MIN_ACTIVE_FRAMES = 30; // 3 s
/** Keep the most recent ~30 s of sound. */
const MAX_ACTIVE_FRAMES = 300;

export class MicLevelMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private track: MediaStreamTrack | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf = new Float32Array(2048);
  private active: number[] = [];

  /** Follow this track; a different track starts a fresh measurement. */
  attach(mst: MediaStreamTrack | null | undefined): void {
    if (!mst || mst === this.track) return;
    this.track = mst;
    this.active = [];
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined =
          window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
      }
      try { this.src?.disconnect(); } catch { /* ignore */ }
      this.src = this.ctx.createMediaStreamSource(new MediaStream([mst]));
      this.src.connect(this.analyser!);
    } catch {
      this.src = null;
      return;
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    const ctx = this.ctx, an = this.analyser, t = this.track;
    if (!ctx || !an || !t || !this.src) return;
    // The host publishes before any click: the context starts suspended and
    // can only run after a gesture, so keep asking.
    if (ctx.state !== "running") { ctx.resume().catch(() => {}); return; }
    if (t.readyState === "ended" || !t.enabled) return;
    an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const db = 10 * Math.log10(s / this.buf.length + 1e-24);
    if (db <= ACTIVE_FLOOR_DB) return;
    this.active.push(db);
    if (this.active.length > MAX_ACTIVE_FRAMES) this.active.shift();
  }

  /** Seconds of sound measured on the current track. */
  activeSeconds(): number {
    return this.active.length / 10;
  }

  /** Active level in dBFS (p75 of active frames), or null without enough sound. */
  level(): number | null {
    if (this.active.length < MIN_ACTIVE_FRAMES) return null;
    const sorted = [...this.active].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length * 0.75)] * 10) / 10;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.src?.disconnect(); } catch { /* ignore */ }
    this.ctx?.close().catch(() => {});
    this.ctx = null; this.analyser = null; this.src = null; this.track = null;
  }
}
