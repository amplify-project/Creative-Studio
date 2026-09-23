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

import { useCallback, useEffect, useRef } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";

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
 * Keeps every remote participant at the stored volume. Returns a setter so an
 * in-session control can change it live; the stored value is the source of
 * truth for participants who join later.
 */
export function useOutputVolume(room: Room | null | undefined) {
  const volumeRef = useRef(1);

  const applyToAll = useCallback(() => {
    if (!room) return;
    room.remoteParticipants.forEach((p) => {
      // One participant failing (already gone, older client) must not skip
      // the rest.
      try { p.setVolume(volumeRef.current); } catch { /* ignore */ }
    });
  }, [room]);

  const setVolume = useCallback((v: number) => {
    volumeRef.current = Math.max(0, Math.min(1, v));
    writeStoredVolume(volumeRef.current);
    applyToAll();
  }, [applyToAll]);

  useEffect(() => {
    if (!room) return;
    volumeRef.current = readStoredVolume();
    applyToAll();

    // ParticipantConnected alone is not enough: the audio element the volume
    // applies to only exists once their track is subscribed, which is a
    // separate event and can arrive much later on a slow link.
    const onChanged = () => applyToAll();
    room.on(RoomEvent.ParticipantConnected, onChanged);
    room.on(RoomEvent.TrackSubscribed, onChanged);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onChanged);
      room.off(RoomEvent.TrackSubscribed, onChanged);
    };
  }, [room, applyToAll]);

  return { setVolume };
}
