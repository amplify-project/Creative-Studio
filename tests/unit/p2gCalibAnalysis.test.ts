/**
 * The calibration measurement against synthetic captures.
 *
 * Each capture is built the way a real trial lays it out: room noise, the
 * digital sync marker START_AT_LEAD_MS + MARKER_OFFSET_MS in, and the acoustic
 * click SCHEDULED_GAP_MS later plus the round trip under test. The failure
 * cases are the ones that have happened in the field — the point of this
 * function is to refuse a measurement rather than return a plausible wrong one.
 */
import { describe, expect, it } from "vitest";
import {
  analyseCapture,
  EDGE_GUARD_MS,
  MARKER_OFFSET_MS,
  RECORD_MS,
  SCHEDULED_GAP_MS,
  SPREAD_LIMIT_MS,
  START_AT_LEAD_MS,
  summariseTrials,
  type CaptureDiag,
} from "../../app/lib/p2gCalibAnalysis";

const SR = 48_000;
const MARKER_AT_MS = START_AT_LEAD_MS + MARKER_OFFSET_MS;
const idx = (ms: number) => Math.floor((ms / 1000) * SR);

/** Deterministic noise, so a failing test fails the same way every time. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** A short decaying 2 kHz burst with a sharp onset — what a click looks like. */
function addBurst(buf: Float32Array, atMs: number, amplitude: number) {
  const start = idx(atMs);
  const len = idx(5);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    buf[start + i] += amplitude * Math.exp(-i / (len / 4)) * Math.sin((2 * Math.PI * 2000 * i) / SR);
  }
}

function capture(opts: {
  latencyMs?: number | null;   // null = no click at all
  clickAmplitude?: number;
  noiseAmplitude?: number;
  marker?: boolean;
  extra?: (buf: Float32Array) => void;
}) {
  const { latencyMs = 60, clickAmplitude = 0.4, noiseAmplitude = 0.002, marker = true } = opts;
  const buf = new Float32Array(idx(RECORD_MS));
  const rnd = noise(42);
  for (let i = 0; i < buf.length; i++) buf[i] = noiseAmplitude * rnd();
  if (marker) addBurst(buf, MARKER_AT_MS, 0.7);
  if (latencyMs !== null) addBurst(buf, MARKER_AT_MS + SCHEDULED_GAP_MS + latencyMs, clickAmplitude);
  opts.extra?.(buf);
  return buf;
}

const analyse = (buf: Float32Array, diag: CaptureDiag = {}) => analyseCapture(buf, buf.length, SR, diag);

describe("analyseCapture — measures", () => {
  it.each([20, 60, 150, 400, 900])("a %i ms round trip", (latency) => {
    expect(analyse(capture({ latencyMs: latency }))).toBeCloseTo(latency, -0.5); // within ±1.5 ms
  });

  it("a quiet click well above the noise", () => {
    expect(analyse(capture({ latencyMs: 80, clickAmplitude: 0.05 }))).toBeCloseTo(80, -0.5);
  });

  it("from the click's onset, not from room noise earlier in the window", () => {
    // A noise burst right where the click search starts: the old absolute
    // threshold latched onto exactly this and reported ~0 ms.
    const buf = capture({
      latencyMs: 120,
      extra: (b) => addBurst(b, MARKER_AT_MS + SCHEDULED_GAP_MS + 2, 0.06),
    });
    expect(analyse(buf)).toBeCloseTo(120, -0.5);
  });

  it("fills in the diagnostics", () => {
    const diag: CaptureDiag = {};
    analyse(capture({ latencyMs: 60 }), diag);
    expect(diag.markerMs).toBeCloseTo(MARKER_AT_MS, 0);
    expect(diag.latencyMs).toBe(60);
    expect(diag.gapMs).toBeCloseTo(SCHEDULED_GAP_MS + 60, 0);
    expect(diag.clickPeak).toBeGreaterThan(0.3);
  });
});

describe("analyseCapture — refuses", () => {
  it("when no click arrives", () => {
    expect(() => analyse(capture({ latencyMs: null }))).toThrow(/Click not heard/);
  });

  it("when the mic delivers digital silence (2026-10-06: a silent virtual mic as OS default)", () => {
    // The marker is injected digitally, so it is there even when the mic is
    // dead; everything else is exact zeros, noiseFloor 0.
    const diag: CaptureDiag = {};
    expect(() => analyse(capture({ latencyMs: null, noiseAmplitude: 0 }), diag)).toThrow(/Click not heard/);
    expect(diag.noiseFloor).toBe(0);
    expect(diag.markerMs).toBeCloseTo(MARKER_AT_MS, 0);
  });

  it("when the click is buried in noise", () => {
    expect(() => analyse(capture({ latencyMs: 80, clickAmplitude: 0.01, noiseAmplitude: 0.01 }))).toThrow(
      /Click not heard/,
    );
  });

  it("when the sync marker is missing", () => {
    expect(() => analyse(capture({ marker: false }))).toThrow(/marker lost/);
  });

  it("when the click lands at the very end of the window (round trip too long to measure)", () => {
    const atEnd = RECORD_MS - EDGE_GUARD_MS / 2 - (MARKER_AT_MS + SCHEDULED_GAP_MS);
    expect(() => analyse(capture({ latencyMs: atEnd }))).toThrow(/very end/);
  });

  it("when the round trip is too short to be acoustic (loopback / monitor input)", () => {
    expect(() => analyse(capture({ latencyMs: 2 }))).toThrow(/too low to be a real acoustic path/);
  });

  it("still reports the noise floor when it refuses", () => {
    const diag: CaptureDiag = {};
    expect(() => analyse(capture({ latencyMs: null, noiseAmplitude: 0.004 }), diag)).toThrow();
    expect(diag.noiseFloor).toBeGreaterThan(0);
    expect(diag.capturedMs).toBe(RECORD_MS);
  });
});

describe("summariseTrials", () => {
  it("drops the highest and lowest of five and averages the rest", () => {
    expect(summariseTrials([100, 60, 62, 64, 10])).toEqual({
      value: 62,
      low: 60,
      high: 64,
      spread: 4,
      droppedCount: 2,
    });
  });

  it("keeps every trial when there are fewer than five", () => {
    expect(summariseTrials([60, 70, 80])).toMatchObject({ value: 70, spread: 20, droppedCount: 0 });
  });

  it("reports a spread past the limit when the kept trials disagree", () => {
    const { spread } = summariseTrials([110, 115, 180, 250, 255]);
    expect(spread).toBeGreaterThan(SPREAD_LIMIT_MS);
  });

  it("does not modify its input", () => {
    const trials = [3, 1, 2];
    summariseTrials(trials);
    expect(trials).toEqual([3, 1, 2]);
  });
});
