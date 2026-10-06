/**
 * Which mic a calibration measures. It must be the one the round records with:
 * calibration used to open the OS default, and on 2026-10-06 that was a silent
 * virtual mic while the published one worked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "livekit-client";
import { calibrationMic } from "../../app/lib/p2gCalibMic";

const STORED_KEY = "amplify.inputDeviceId";

/** The slice of a LiveKit Room that calibrationMic reads. */
function roomWithMic(deviceId: string | undefined): Room {
  const pub = deviceId === undefined
    ? undefined
    : { track: { mediaStreamTrack: { getSettings: () => ({ deviceId }) } } };
  return {
    localParticipant: { getTrackPublication: () => pub },
  } as unknown as Room;
}

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("calibrationMic", () => {
  it("measures the mic published in the room, over the stored choice", () => {
    store[STORED_KEY] = "stored-mic";
    expect(calibrationMic(roomWithMic("published-mic"))).toEqual({
      deviceId: "published-mic",
      source: "published",
    });
  });

  it("falls back to the mic picked in the app when nothing is published", () => {
    store[STORED_KEY] = "stored-mic";
    expect(calibrationMic(roomWithMic(undefined))).toEqual({ deviceId: "stored-mic", source: "stored" });
  });

  it("falls back to the OS default when there is neither", () => {
    expect(calibrationMic(roomWithMic(undefined))).toEqual({ deviceId: "", source: "default" });
    expect(calibrationMic(null)).toEqual({ deviceId: "", source: "default" });
  });

  it('treats a stored "default" as no choice', () => {
    store[STORED_KEY] = "default";
    expect(calibrationMic(null).source).toBe("default");
  });

  it("survives a room whose track cannot be read", () => {
    store[STORED_KEY] = "stored-mic";
    const broken = {
      localParticipant: { getTrackPublication: () => { throw new Error("gone"); } },
    } as unknown as Room;
    expect(calibrationMic(broken)).toEqual({ deviceId: "stored-mic", source: "stored" });
  });

  it("survives storage that throws (private window, blocked site data)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error("SecurityError"); },
    };
    expect(calibrationMic(null)).toEqual({ deviceId: "", source: "default" });
  });
});
