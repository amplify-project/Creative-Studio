/**
 * The capture worklet, run for real against a fake audio thread.
 *
 * Two things it has to get right: every sample written reaches the main thread
 * (the tail used to stay behind in the partial buffer when the take stopped),
 * and a gap in the input is counted where it happened, whether it arrived as
 * an empty input or — the usual case — as the zeros the browser feeds when the
 * mic runs dry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { captureGapFields, trackDropFields, type CaptureStats } from "../../app/lib/p2gCaptureStats";

const SR = 48000;
const Q = 128;

type Msg = Float32Array | Record<string, unknown>;

function loadProcessor() {
  const posted: Msg[] = [];
  let Ctor: any = null;
  class FakeProcessor {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: Msg) => posted.push(m),
    };
  }
  const context = vm.createContext({
    AudioWorkletProcessor: FakeProcessor,
    registerProcessor: (_name: string, c: unknown) => { Ctor = c; },
    sampleRate: SR,
    Float32Array,
  });
  const src = readFileSync(join(__dirname, "../../public/play2gether-capture-worklet.js"), "utf8");
  vm.runInContext(src, context);
  const proc = new Ctor();
  const send = (cmd: string) => proc.port.onmessage({ data: { cmd } });
  return { proc, posted, send };
}

/** Quantum of low-level noise — a live mic never sits at exact zero. */
function noise(n = Q, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = ((x / 2147483648) - 0.5) * 1e-3 || 1e-6;
  }
  return out;
}

const samplesOf = (posted: Msg[]) =>
  posted.filter((m): m is Float32Array => m instanceof Float32Array);
const doneOf = (posted: Msg[]) =>
  posted.find((m) => !(m instanceof Float32Array) && (m as any).type === "done") as any;

describe("capture worklet", () => {
  it("ships the partial buffer on stop, then reports done", () => {
    const { proc, posted, send } = loadProcessor();
    send("start");
    const quanta = 100; // 12 800 samples: two full 4800 batches + a 3200 tail
    for (let i = 0; i < quanta; i++) proc.process([[noise(Q, i + 1)]]);
    send("stop");

    const total = samplesOf(posted).reduce((s, c) => s + c.length, 0);
    expect(total).toBe(quanta * Q);
    const done = doneOf(posted);
    expect(done).toBeTruthy();
    expect(posted[posted.length - 1]).toBe(done); // after the last samples
    expect(done.writtenSamples).toBe(quanta * Q);
    expect(done.zeroRuns).toBe(0);
  });

  it("counts a gap that arrives as zeros, at the right place", () => {
    const { proc, posted, send } = loadProcessor();
    send("start");
    for (let i = 0; i < 10; i++) proc.process([[noise(Q, i + 1)]]);
    for (let i = 0; i < 5; i++) proc.process([[new Float32Array(Q)]]); // 640 zeros
    for (let i = 0; i < 10; i++) proc.process([[noise(Q, i + 50)]]);
    send("stop");

    const done = doneOf(posted);
    expect(done.emptyQuanta).toBe(0);
    expect(done.zeroRuns).toBe(1);
    expect(done.zeroRunSamples).toBe(5 * Q);
    expect(done.longestZeroRun).toBe(5 * Q);
    expect(done.gaps).toEqual([{ at: 10 * Q, len: 5 * Q }]);
  });

  it("counts an empty input separately and still keeps the timeline", () => {
    const { proc, posted, send } = loadProcessor();
    send("start");
    proc.process([[noise()]]);
    proc.process([[]]);
    proc.process([]);
    proc.process([[noise()]]);
    send("stop");

    const done = doneOf(posted);
    expect(done.emptyQuanta).toBe(2);
    expect(done.writtenSamples).toBe(4 * Q);
    expect(done.zeroRuns).toBe(1);
    expect(done.longestZeroRun).toBe(2 * Q);
  });

  it("ignores short runs of zeros and closes a run open at the stop", () => {
    const { proc, posted, send } = loadProcessor();
    send("start");
    const q = noise();
    q.fill(0, 10, 40); // 30 zeros: under the threshold
    proc.process([[q]]);
    proc.process([[new Float32Array(Q)]]); // a run still open when we stop
    send("stop");

    const done = doneOf(posted);
    expect(done.zeroRuns).toBe(1);
    expect(done.gaps).toEqual([{ at: Q, len: Q }]);
  });

  it("answers stop even when it never started", () => {
    const { proc, posted, send } = loadProcessor();
    proc.process([[noise()]]);
    send("stop");
    expect(samplesOf(posted)).toHaveLength(0);
    expect(doneOf(posted)).toEqual({ type: "done", started: false });
  });
});

describe("p2g_take gap fields", () => {
  it("turns samples into ms and lists the gaps", () => {
    const stats: CaptureStats = {
      type: "done", started: true, sampleRate: SR, writtenSamples: SR * 10,
      emptyQuanta: 0, shortQuanta: 0, zeroRuns: 2, zeroRunSamples: 4800,
      longestZeroRun: 2400, gaps: [{ at: SR * 2, len: 2400 }, { at: SR * 5, len: 2400 }],
    };
    expect(captureGapFields(stats)).toMatchObject({
      gapStats: true, gapCount: 2, gapMs: 100, gapLongestMs: 50, writtenMs: 10000,
      gaps: "2.00s+50ms 5.00s+50ms",
    });
  });

  it("says when the worklet never reported, rather than reporting zero gaps", () => {
    expect(captureGapFields(null)).toEqual({ gapStats: false });
  });

  it("reports track drops only between the two snapshots", () => {
    const start = { totalFrames: 1000, deliveredFrames: 990, totalFramesDuration: 100, deliveredFramesDuration: 99 };
    const end = { totalFrames: 5000, deliveredFrames: 4950, totalFramesDuration: 500, deliveredFramesDuration: 495 };
    expect(trackDropFields(start, end)).toEqual({
      trackDroppedFrames: 40, trackDroppedMs: 4, trackTotalFrames: 4000,
    });
    expect(trackDropFields(null, end)).toEqual({});
  });
});
