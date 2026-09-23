"use client";

/**
 * Publishing extra video alongside the primary camera — screen shares and
 * additional cameras — from the connection already open, plus the capability
 * checks that say whether either is possible on this device.
 *
 * Lifted out of ParticipantControlPanel when the control bar grew its own
 * buttons: two components driving the same publishes with two copies of the
 * logic is how the mic ended up with a duplicate track (docs/llm/08).
 *
 * There is no fixed limit of one extra camera. A machine with two USB cameras
 * can publish both, alongside a screen share and the primary — they are
 * independent tracks and the stage keys tiles by track, not by person.
 *
 * State is derived from the room's live track list, never kept in React — a
 * share the user ends from the browser's own "Stop sharing" bar, or a publish
 * that fails, must not leave a button claiming otherwise.
 */

import { useCallback, useEffect, useState } from "react";
import { Track, createLocalVideoTrack } from "livekit-client";
import { useLocalParticipant, useRoomContext, useTracks } from "@livekit/components-react";
import { runPublishOp } from "../utils/publishQueue";

export type ExtraCamera = {
  trackSid: string;
  /** Empty when the browser will not report it — still removable by sid. */
  deviceId: string;
  label: string;
};

export type ExtraSources = {
  isSharingScreen: boolean;
  /** Every published camera that is not the primary one. */
  extraCameras: ExtraCamera[];
  /** Cameras not currently published, primary included. */
  availableCameras: MediaDeviceInfo[];
  /** getDisplayMedia exists — false on iOS Safari at every version. */
  canScreenShare: boolean;
  busy: boolean;
  /** Last failure, excluding the user simply dismissing a picker. */
  error: string | null;
  clearError: () => void;
  toggleScreenShare: () => Promise<void>;
  addCamera: (deviceId: string) => Promise<void>;
  removeCamera: (trackSid: string) => Promise<void>;
};

/** The deviceId a live track is actually capturing from, when reported. */
function deviceIdOf(pubOrTrack: any): string {
  try {
    return pubOrTrack?.track?.mediaStreamTrack?.getSettings?.().deviceId ?? "";
  } catch {
    return "";
  }
}

export function useExtraSources(): ExtraSources {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const allTracks = useTracks();

  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      navigator.mediaDevices?.enumerateDevices?.()
        .then((list) => setVideoInputs(list.filter((d) => d.kind === "videoinput")))
        .catch(() => {});
    };
    read();
    // A camera plugged in mid-session should show up in the picker.
    navigator.mediaDevices?.addEventListener?.("devicechange", read);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", read);
  }, []);

  // Derived from useTracks, which re-renders on publish and unpublish; a plain
  // read of trackPublications would leave the buttons a render behind.
  const ownVideo = allTracks.filter(
    (t) => t.participant.identity === localParticipant?.identity
        && t.publication.kind === Track.Kind.Video,
  );
  const isSharingScreen = ownVideo.some(
    (t) => t.publication.source === Track.Source.ScreenShare,
  );

  const extraCameras: ExtraCamera[] = ownVideo
    .filter((t) => t.publication.source !== Track.Source.Camera
                && t.publication.source !== Track.Source.ScreenShare)
    .map((t) => {
      const deviceId = deviceIdOf(t.publication);
      const known = videoInputs.find((d) => d.deviceId === deviceId);
      return {
        trackSid: t.publication.trackSid,
        deviceId,
        label: known?.label || "Camera",
      };
    });

  // Everything already on air is off the menu — the primary camera included,
  // since publishing the same device twice either fails or duplicates a
  // stream nobody asked for.
  const inUse = new Set(ownVideo.map((t) => deviceIdOf(t.publication)).filter(Boolean));
  const availableCameras = videoInputs.filter((d) => !inUse.has(d.deviceId));

  const canScreenShare = typeof navigator !== "undefined"
    && !!navigator.mediaDevices
    && typeof (navigator.mediaDevices as any).getDisplayMedia === "function";

  const toggleScreenShare = useCallback(async () => {
    if (!room || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runPublishOp(room, "video", async () => {
        const sharing = Array.from(room.localParticipant.trackPublications.values())
          .some((p: any) => p.source === Track.Source.ScreenShare);
        await room.localParticipant.setScreenShareEnabled(!sharing);
      });
    } catch (e: any) {
      // Dismissing the picker rejects with NotAllowedError. That is a
      // decision, not a failure, so it gets no error banner.
      if (e?.name !== "NotAllowedError") setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [room, busy]);

  const addCamera = useCallback(async (deviceId: string) => {
    if (!room || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runPublishOp(room, "video", async () => {
        const track = await createLocalVideoTrack({
          resolution: { width: 1280, height: 720 },
          deviceId: deviceId || undefined,
        });
        // Not Source.Camera: that is the primary, and several tracks claiming
        // it would make every "is my camera on" check ambiguous. Unknown is in
        // useTracks()'s default source list, so the stage and the host's list
        // pick these up without being taught about extra cameras.
        (track as any).source = Track.Source.Unknown;
        await room.localParticipant.publishTrack(track, { name: "secondary" });
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [room, busy]);

  const removeCamera = useCallback(async (trackSid: string) => {
    if (!room || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runPublishOp(room, "video", async () => {
        const pub = Array.from(room.localParticipant.trackPublications.values())
          .find((p: any) => p.trackSid === trackSid) as any;
        if (pub?.track) await room.localParticipant.unpublishTrack(pub.track);
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [room, busy]);

  return {
    isSharingScreen,
    extraCameras,
    availableCameras,
    canScreenShare,
    busy,
    error,
    clearError: () => setError(null),
    toggleScreenShare,
    addCamera,
    removeCamera,
  };
}
