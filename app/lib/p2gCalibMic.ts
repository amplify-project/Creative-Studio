/**
 * Which microphone a Play2Gether calibration must measure.
 *
 * Kept out of the calibration component so it can be tested without a browser.
 */
import { Track, type Room } from "livekit-client";
import { readStoredInputDevice } from "../hooks/useOutputVolume";

/** The microphone a calibration must measure, and how it was chosen. */
export type CalibMic = { deviceId: string; source: "published" | "stored" | "default" };

/**
 * The mic the ROUND will record with, so calibration measures that one.
 *
 * Calibration used to open getUserMedia with no deviceId, i.e. the OS default
 * input — while the session publishes the mic picked in the app. When the two
 * differ the trial measures the wrong device: found on 2026-10-06 when the
 * system default was a silent virtual mic (noiseFloor exactly 0, "Click not
 * heard" five times) while the published mic worked fine. With two real mics
 * it is worse — a plausible number for a path nobody sings through.
 *
 * Order: the device of the mic track actually published in the room (the
 * truth), then the mic stored as picked in the app, then the OS default.
 */
export function calibrationMic(room: Room | null | undefined): CalibMic {
  try {
    const pub = room?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    const id = pub?.track?.mediaStreamTrack?.getSettings().deviceId;
    if (id) return { deviceId: id, source: "published" };
  } catch { /* fall through to the stored choice */ }
  const stored = readStoredInputDevice();
  if (stored && stored !== "default") return { deviceId: stored, source: "stored" };
  return { deviceId: "", source: "default" };
}
