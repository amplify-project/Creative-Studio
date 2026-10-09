/**
 * A test take is the file, `latencyMs` late, cut to the round. The mixer tells
 * the host the correct Sync value is exactly `latencyMs`, so the delay has to
 * be exact to the sample.
 */
import { describe, expect, it } from "vitest";
import { buildTestTake } from "../../app/lib/p2gTestTrack";

const SR = 48000;
const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i + 1);

describe("buildTestTake", () => {
  it("delays the track by the latency, to the sample", () => {
    const take = buildTestTake(ramp(SR), SR, 131, 2000);
    const lead = Math.round(0.131 * SR);
    expect(take.length).toBe(2 * SR);
    expect(take[lead - 1]).toBe(0);
    expect(take[lead]).toBe(1);               // the file's first sample
    expect(take[lead + SR - 1]).toBe(SR);     // its last
    expect(take[lead + SR]).toBe(0);          // then silence to the round's end
  });

  it("cuts a track longer than the round", () => {
    const take = buildTestTake(ramp(10 * SR), SR, 100, 1000);
    expect(take.length).toBe(SR);
    expect(take[SR - 1]).toBe(SR - Math.round(0.1 * SR));
  });

  it("zero latency is the file itself; a latency past the round is silence", () => {
    expect(buildTestTake(ramp(10), SR, 0, (10 / SR) * 1000)).toEqual(ramp(10));
    expect(buildTestTake(ramp(SR), SR, 5000, 1000).every((v) => v === 0)).toBe(true);
  });
});
