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
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === "start") {
        this.pos = 0;
        this.capturing = true;
      } else if (cmd === "stop") {
        this.capturing = false;
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

  process(inputs) {
    // Warm but idle until the clap — discard input, keep the graph alive.
    if (!this.capturing) return true;
    const ch0 = inputs[0]?.[0];
    const inLen = ch0 ? ch0.length : 0;

    // Always write exactly QUANTUM samples — fill from the input if present,
    // pad with zeros otherwise. This keeps our sample timeline locked to the
    // audio thread, which is locked to the hardware clock.
    for (let i = 0; i < QUANTUM; i++) {
      this.buf[this.pos++] = i < inLen ? ch0[i] : 0;
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
