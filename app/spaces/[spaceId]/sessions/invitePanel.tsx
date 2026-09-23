"use client";
import { useState } from "react";

export default function InvitePanel({ sessionId }: { sessionId: string }) {
  const [hostUrl, setHostUrl] = useState<string>("");
  const [participantUrl, setParticipantUrl] = useState<string>("");

  const create = async (role: "host" | "participant") => {
    const res = await fetch("/api/invites/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, role, ttlMinutes: 240 }),
    });
    const j = await res.json();
    if (res.ok) {
      if (role === "host") setHostUrl(j.url);
      else setParticipantUrl(j.url);
    } else {
      alert(j.error || "Error creating invite");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button className="btn" onClick={() => create("host")}>Invite Host</button>
      <button className="btn" onClick={() => create("participant")}>Invite Participant</button>
      {(hostUrl || participantUrl) && (
        <div className="ml-2 text-xs">
          {hostUrl && (<div>Host link: <a className="link" href={hostUrl} target="_blank" rel="noreferrer">{hostUrl}</a></div>)}
          {participantUrl && (<div>Participant link: <a className="link" href={participantUrl} target="_blank" rel="noreferrer">{participantUrl}</a></div>)}
        </div>
      )}
    </div>
  );
}
