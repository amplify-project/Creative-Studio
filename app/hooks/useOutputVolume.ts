"use client";

/**
 * Playback volume for everyone else in the room, chosen before joining.
 *
 * LiveKit has no room-wide output volume: the knob is `setVolume` on each
 * remote participant, applied to the audio element `RoomAudioRenderer`
 * creates when their track is subscribed. So a preference picked on the
 * pre-join screen has to be re-applied to every participant who arrives
 * afterwards — hence the subscription here rather than a one-shot call.
 *
 * The value is per-viewer and per-device by nature ("this laptop's speakers
 * are too loud"), so it lives in localStorage rather than shared state. Every
 * access is guarded: a private window or blocked site data makes these throw
 * rather than return null.
 */

import { useCallback, useEffect } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";
import {
  getOutputState,
  remoteAudioFactor,
  setOutputDevice,
  setOutputVolume,
  subscribeOutput,
} from "../utils/outputBus";

const VOLUME_KEY = "amplify.outputVolume";
const DEVICE_KEY = "amplify.outputDeviceId";

/** 0-1. Defaults to full scale, which is what the app did before this existed. */
export function readStoredVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw == null) return 1;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  } catch {
    return 1;
  }
}

export function writeStoredVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(1, v))));
  } catch {
    /* storage unavailable — the session just runs at the default */
  }
}

/** Empty string means "system default", which is also `switchActiveDevice`'s. */
export function readStoredOutputDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredOutputDevice(id: string): void {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* as above */
  }
}

const INPUT_DEVICE_KEY = "amplify.inputDeviceId";

/**
 * The microphone chosen on the pre-join screen. Empty string = system default.
 * Lives next to the speaker choice because it is the same kind of preference
 * (per viewer, per device) and fails the same way when it is not persisted:
 * every later re-capture falls back to whatever the OS calls default.
 */
export function readStoredInputDevice(): string {
  try {
    return localStorage.getItem(INPUT_DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredInputDevice(id: string): void {
  try {
    localStorage.setItem(INPUT_DEVICE_KEY, id);
  } catch {
    /* as above */
  }
}

/**
 * `setSinkId` is Chromium-only — Safari (desktop and iOS) has no way to pick
 * an output device, so the picker must be hidden rather than shown broken.
 */
export function canChooseOutputDevice(): boolean {
  return typeof window !== "undefined"
    && typeof HTMLMediaElement !== "undefined"
    && "setSinkId" in HTMLMediaElement.prototype;
}

/**
 * Keeps LiveKit's remote audio on the listener's output bus (app/utils/outputBus):
 * every remote participant at `volume × holds`, and the room's audio elements
 * on the chosen speaker. Re-applied on every subscription, because the element
 * LiveKit's knob acts on only exists once a track is subscribed — which can be
 * long after the participant connected, and happens again on every republish
 * (music/speech switches republish everyone's mic).
 *
 * Returns setters for an in-session control; they go through the bus so the
 * Play2Gether playback and every other app sound follow the same change.
 */
export function useOutputVolume(room: Room | null | undefined) {
  const applyToAll = useCallback(() => {
    if (!room) return;
    const v = getOutputState().volume * remoteAudioFactor();
    room.remoteParticipants.forEach((p) => {
      // One participant failing (already gone, older client) must not skip
      // the rest.
      try { p.setVolume(v); } catch { /* ignore */ }
    });
  }, [room]);

  useEffect(() => {
    if (!room) return;
    applyToAll();

    let lastDevice = getOutputState().deviceId;
    const offBus = subscribeOutput((s) => {
      applyToAll();
      if (s.deviceId !== lastDevice) {
        lastDevice = s.deviceId;
        room.switchActiveDevice("audiooutput", s.deviceId || "default").catch(() => {});
      }
    });

    const onChanged = () => applyToAll();
    room.on(RoomEvent.ParticipantConnected, onChanged);
    room.on(RoomEvent.TrackSubscribed, onChanged);
    return () => {
      offBus();
      room.off(RoomEvent.ParticipantConnected, onChanged);
      room.off(RoomEvent.TrackSubscribed, onChanged);
    };
  }, [room, applyToAll]);

  return { setVolume: setOutputVolume, setDevice: setOutputDevice };
}
