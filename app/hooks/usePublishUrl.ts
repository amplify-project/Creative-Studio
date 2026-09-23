"use client";

/**
 * The `/publish` URL for this room and user — the QR target for adding a
 * camera from a phone.
 *
 * Shared because it is now built in two places (the control panel's Utils tab
 * and the control bar's add-camera menu) and the two must agree: a QR pointing
 * at a different room than the panel's link is the kind of drift that only
 * shows up in a live session.
 */

import { useEffect, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";

export function usePublishUrl(): string {
  const { localParticipant } = useLocalParticipant();
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const roomName = params.get("sessionId") || "test";
    const identity = localParticipant?.identity ?? "";
    const displayName = localParticipant?.name ?? identity;
    const { protocol, host } = window.location;
    setUrl(
      `${protocol}//${host}/publish?identity=${encodeURIComponent(identity)}` +
      `&name=${encodeURIComponent(displayName)}&room_name=${roomName}`,
    );
  }, [localParticipant?.identity, localParticipant?.name]);

  return url;
}
