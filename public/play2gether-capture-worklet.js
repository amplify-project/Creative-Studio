// AudioWorklet processor for Play2Gether — accumulates mic audio into a
// pre-allocated buffer and ships it to the main thread in batches.
//
// CRITICAL: the audio thread calls process() at a steady cadence (128 samples
// per call at the AudioContext sample rate), regardless of whether the input
// is producing data this tick. We MUST advance the write position by 128
// samples every call (zero-filling when the input is momentarily empty) —
// otherwise the captured WAV ends up shorter than wall-clock time and every
// take drifts forward as the song progresses.
const QUANTUM = 128;
const FLUSH_SAMPLES = 4800; // ~100 ms at 48 kHz

// A run of this many consecutive exact-zero samples is counted as a gap.
//
// Why exact zeros and not "the input was empty": with a MediaStreamSource
// connected, an empty `inputs[0]` almost never happens. When the mic or the
// track's FIFO runs dry the browser feeds the graph SILENCE — 128 real zeros —
// so a counter on the empty branch would read 0 on exactly the takes that had
// gaps. A live mic in music mode (no noise suppression) never sits at exact
// 0.0 for 64 samples (~1.3 ms at 48 kHz): its noise floor is never that clean.
// A device with a hard noise gate would, and that is why the runs are reported
// with their lengths rather than turned into a verdict here.
const MIN_ZERO_RUN = 64;
// Enough to see where gaps fall in a take; a take with more than this has a
// problem the totals already describe.
const MAX_GAP_EVENTS = 32;

class P2GCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FLUSH_SAMPLES);
    this.pos = 0;
    // Start gated: the node is created + connected during the countdown so the
    // expensive AudioContext/worklet-module setup is paid BEFORE the clap. We
    // only begin accumulating samples when the main thread posts {cmd:"start"}
    // at the clap instant. This turns the old, device-variable capture-start
    // delay (new AudioContext + await addModule inside the clap timer, tens to
    // hundreds of ms) into a single quantum of jitter, so takes no longer run
    // ahead of the reference by a random per-device amount.
    this.capturing = false;
    this.resetStats();
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === "start") {
        this.pos = 0;
        this.resetStats();
        this.capturing = true;
      } else if (cmd === "stop") {
        // Ship the partial buffer, THEN report. Stop used to just close the
        // gate, so the last 0–100 ms of every take (whatever had not yet
        // filled a FLUSH_SAMPLES batch) never left the worklet. Port messages
        // are ordered, so a main thread that waits for "done" has every
        // sample of the take.
        const wasCapturing = this.capturing;
        this.capturing = false;
        // Never started (round cancelled before the clap): still answer, so
        // the main thread isn't left waiting out its timeout.
        if (!wasCapturing) {
          this.port.postMessage({ type: "done", started: false });
          return;
        }
        this.closeZeroRun();
        if (this.pos > 0) {
          const tail = this.buf.slice(0, this.pos);
          this.port.postMessage(tail, [tail.buffer]);
          this.pos = 0;
        }
        this.port.postMessage({
          type: "done",
          started: true,
          sampleRate,
          writtenSamples: this.written,
          emptyQuanta: this.emptyQuanta,
          shortQuanta: this.shortQuanta,
          zeroRuns: this.zeroRuns,
          zeroRunSamples: this.zeroRunSamples,
          longestZeroRun: this.longestZeroRun,
          gaps: this.gaps,
        });
      } else if (cmd === "flush") {
        // Ship whatever is in the partial buffer without waiting for it to
        // fill. Only calibration uses this (it needs the tail of a short
        // window); the recorder never sends it. Copies rather than transfers
        // so this.buf stays usable if capture continues.
        if (this.pos > 0) {
          this.port.postMessage(this.buf.slice(0, this.pos));
          this.pos = 0;
        }
      }
    };
  }

  resetStats() {
    this.written = 0;          // samples written since start
    this.emptyQuanta = 0;      // process() calls with no input channel at all
    this.shortQuanta = 0;      // calls whose input had fewer than QUANTUM samples
    this.zeroRuns = 0;         // runs of >= MIN_ZERO_RUN exact zeros
    this.zeroRunSamples = 0;   // samples inside those runs
    this.longestZeroRun = 0;
    this.curZeroRun = 0;
    this.gaps = [];            // first MAX_GAP_EVENTS runs: { at, len } in samples
  }

  closeZeroRun() {
    const run = this.curZeroRun;
    this.curZeroRun = 0;
    if (run < MIN_ZERO_RUN) return;
    this.zeroRuns++;
    this.zeroRunSamples += run;
    if (run > this.longestZeroRun) this.longestZeroRun = run;
    if (this.gaps.length < MAX_GAP_EVENTS) {
      this.gaps.push({ at: this.written - run, len: run });
    }
  }

  process(inputs) {
    // Warm but idle until the clap — discard input, keep the graph alive.
    if (!this.capturing) return true;
    const ch0 = inputs[0]?.[0];
    const inLen = ch0 ? ch0.length : 0;
    if (!ch0) this.emptyQuanta++;
    else if (inLen < QUANTUM) this.shortQuanta++;

    // Always write exactly QUANTUM samples — fill from the input if present,
    // pad with zeros otherwise. This keeps our sample timeline locked to the
    // audio thread, which is locked to the hardware clock.
    for (let i = 0; i < QUANTUM; i++) {
      const s = i < inLen ? ch0[i] : 0;
      if (s === 0) this.curZeroRun++;
      else if (this.curZeroRun > 0) this.closeZeroRun();
      this.written++;
      this.buf[this.pos++] = s;
      if (this.pos >= FLUSH_SAMPLES) {
        // Transfer the full buffer to the main thread (zero-copy) and
        // allocate a fresh one — the previous one's ArrayBuffer is detached.
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(FLUSH_SAMPLES);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor("p2g-capture", P2GCaptureProcessor);
