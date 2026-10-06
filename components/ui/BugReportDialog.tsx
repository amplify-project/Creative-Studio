"use client";

import { useState } from "react";
import { Bug, X, Send, CheckCircle, AlertCircle } from "lucide-react";
import { getOutputState, remoteAudioFactor } from "../../app/utils/outputBus";
import { micSnapshot } from "../../app/utils/micCapture";

interface BugReportDialogProps {
  onClose: () => void;
  participantId?: string;
  roomName?: string;
}

type Status = "idle" | "sending" | "sent" | "error";

export default function BugReportDialog({ onClose, participantId, roomName }: BugReportDialogProps) {
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const handleSubmit = async () => {
    if (!description.trim()) return;
    setStatus("sending");

    // Capture all available debug state at the moment of the report
    const w = window as any;
    const safe = (fn: () => unknown) => { try { return fn(); } catch { return null; } };
    const muteEvents   = w.__muteDump   ? safe(() => JSON.parse(w.__muteDump())) ?? [] : [];
    const lkAudio      = w.__lkAudio    ? safe(() => w.__lkAudio())  ?? [] : [];
    const stageState   = w.__stage      ? safe(() => w.__stage())     ?? [] : [];
    const muteState    = w.__muteState  ? safe(() => w.__muteState()) ?? {} : {};
    const consoleErrors = w.__getConsoleErrors ? safe(() => w.__getConsoleErrors()) ?? [] : [];

    // Network info (Network Information API — not available on all browsers)
    const conn = (navigator as any).connection ?? (navigator as any).mozConnection ?? (navigator as any).webkitConnection;
    const networkInfo = conn ? {
      effectiveType: conn.effectiveType,
      downlink: conn.downlink,
      rtt: conn.rtt,
      saveData: conn.saveData,
    } : null;

    // LiveKit room snapshot
    const room = w.__room;
    const roomSnapshot = room ? safe(() => {
      const local = room.localParticipant;
      const pubs = Array.from(local?.trackPublications?.values() ?? []) as any[];
      return {
        state: room.state,
        connectionQuality: local?.connectionQuality,
        remoteParticipantCount: room.remoteParticipants?.size ?? 0,
        localTracks: pubs.map((p: any) => ({
          kind: p.kind,
          source: p.source,
          isMuted: p.isMuted,
          simulcast: p.simulcast,
        })),
      };
    }) : null;

    // Pre-pass over the subscriber PC stats: build a map from remote
    // trackSid → what THIS client is actually playing back (audioLevel,
    // packetsLost, jitter). Used below to enrich `remoteParticipants` so
    // every audio pub carries its real per-stream playback level — closes
    // the diagnostic gap of "Alice says Bob is silent; what does Alice
    // actually receive from Bob right now?".
    //
    // The bridge from RTP stats to LiveKit pubs is the underlying
    // MediaStreamTrack.id — `inbound-rtp.trackIdentifier` matches the
    // browser id, which we can look up on `pub.track.mediaStreamTrack.id`.
    const inboundAudioByTrackSid = new Map<string, {
      audioLevel?: number;
      packetsReceived?: number;
      packetsLost?: number;
      jitter?: number;
      totalSamplesReceived?: number;
    }>();
    if (room?.engine?.pcManager?.subscriber?.pc) {
      try {
        const trackIdToTrackSid = new Map<string, string>();
        for (const p of room.remoteParticipants.values() as any) {
          for (const pub of p.audioTrackPublications?.values?.() ?? []) {
            const msid = pub.track?.mediaStreamTrack?.id;
            if (msid && pub.trackSid) trackIdToTrackSid.set(msid, pub.trackSid);
          }
        }
        const stats = await room.engine.pcManager.subscriber.pc.getStats();
        stats.forEach((s: any) => {
          if (s.type !== "inbound-rtp" || s.kind !== "audio" || !s.trackIdentifier) return;
          const trackSid = trackIdToTrackSid.get(s.trackIdentifier);
          if (!trackSid) return;
          inboundAudioByTrackSid.set(trackSid, {
            audioLevel: s.audioLevel,
            packetsReceived: s.packetsReceived,
            packetsLost: s.packetsLost,
            jitter: s.jitter,
            totalSamplesReceived: s.totalSamplesReceived,
          });
        });
      } catch { /* old SDK / no PC */ }
    }

    // Full remote participants snapshot — name, identity, quality, what
    // they publish, AND what this client is actually playing back from
    // them. The host needs this to answer "why couldn't Alice hear Bob":
    // now we know Bob's audio pub state from Alice's perspective AND the
    // signal Alice's browser is rendering from Bob (audioLevel ≈ 0 with
    // packets arriving = Bob is silent at source; audioLevel ≈ 0 with
    // packets NOT arriving = subscription/network problem).
    const remoteParticipants = room ? safe(() => {
      const list = Array.from(room.remoteParticipants?.values?.() ?? []) as any[];
      return list.map((p: any) => ({
        identity: p.identity,
        name: p.name,
        connectionQuality: p.connectionQuality,
        isSpeaking: p.isSpeaking,
        audioLevel: p.audioLevel,
        audioPubs: Array.from(p.audioTrackPublications?.values?.() ?? []).map((pub: any) => {
          const inbound = pub.trackSid ? inboundAudioByTrackSid.get(pub.trackSid) : undefined;
          return {
            trackSid: pub.trackSid,
            isSubscribed: pub.isSubscribed,
            isMuted: pub.isMuted,
            source: pub.source,
            // Per-stream playback diagnostics — undefined when stats
            // weren't available (track not yet subscribed at submit time,
            // or subscriber PC missing).
            inboundAudioLevel: inbound?.audioLevel,
            inboundPacketsReceived: inbound?.packetsReceived,
            inboundPacketsLost: inbound?.packetsLost,
          };
        }),
        videoPubs: Array.from(p.videoTrackPublications?.values?.() ?? []).map((pub: any) => ({
          trackSid: pub.trackSid,
          isSubscribed: pub.isSubscribed,
          isMuted: pub.isMuted,
          source: pub.source,
        })),
      }));
    }) : null;

    // WebRTC stats — the single best signal for "actual connection quality".
    // Publisher PC has outgoing RTT + packet loss; subscriber PC has incoming.
    // Without these we only know "events fired", not "audio was choppy".
    const webrtcStats = room ? await (async () => {
      const result: any = { publisher: null, subscriber: null };
      try {
        const pcm = room.engine?.pcManager;
        const collectFrom = async (pc: RTCPeerConnection | undefined | null) => {
          if (!pc) return null;
          const out: any = { transport: null, outboundAudio: null, inboundAudio: null, outboundVideo: null, inboundVideo: null };
          const stats = await pc.getStats();
          stats.forEach((s: any) => {
            if (s.type === "transport") {
              out.transport = { bytesSent: s.bytesSent, bytesReceived: s.bytesReceived, currentRoundTripTime: s.currentRoundTripTime };
            }
            if (s.type === "outbound-rtp" && s.kind === "audio") {
              // Merge into any media-source values already populated below.
              out.outboundAudio = {
                ...out.outboundAudio,
                packetsSent: s.packetsSent,
                bytesSent: s.bytesSent,
              };
            }
            // `media-source` reports the SIGNAL LEVEL at the capture device,
            // BEFORE encoding — the single best signal for "is the user
            // actually emitting audio?". `audioLevel ≈ 0` for tens of
            // seconds while the track is published & unmuted = wrong mic
            // selected (virtual device like "Microsoft Teams Audio"), OS
            // input gain at 0, or AGC clamped down. Past bug reports
            // showed packetsSent climbing but participants couldn't hear —
            // this stat would have caught it in seconds.
            if (s.type === "media-source" && s.kind === "audio") {
              out.outboundAudio = {
                ...out.outboundAudio,
                audioLevel: s.audioLevel,
                totalAudioEnergy: s.totalAudioEnergy,
                totalSamplesDuration: s.totalSamplesDuration,
              };
            }
            if (s.type === "inbound-rtp" && s.kind === "audio") {
              out.inboundAudio = { packetsReceived: s.packetsReceived, packetsLost: s.packetsLost, jitter: s.jitter, audioLevel: s.audioLevel };
            }
            if (s.type === "outbound-rtp" && s.kind === "video") {
              out.outboundVideo = { packetsSent: s.packetsSent, framesEncoded: s.framesEncoded, framesPerSecond: s.framesPerSecond, qualityLimitationReason: s.qualityLimitationReason };
            }
            if (s.type === "inbound-rtp" && s.kind === "video") {
              out.inboundVideo = { packetsReceived: s.packetsReceived, packetsLost: s.packetsLost, framesDecoded: s.framesDecoded, framesPerSecond: s.framesPerSecond };
            }
          });
          return out;
        };
        result.publisher  = await collectFrom(pcm?.publisher?.getConnectedAddress ? pcm.publisher.pc : pcm?.publisher?.pc).catch(() => null);
        result.subscriber = await collectFrom(pcm?.subscriber?.pc).catch(() => null);
      } catch { /* old SDK or no PC yet */ }
      return result;
    })() : null;

    // Permissions — most common cause of "no me oyen": the user denied mic
    // and the error already happened minutes ago, so it's no longer in the
    // visible UI. permissions API gives us the truth right now.
    const permissions = await (async () => {
      const out: any = {};
      try {
        out.microphone = (await (navigator as any).permissions?.query?.({ name: "microphone" as PermissionName }))?.state ?? null;
      } catch { out.microphone = null; }
      try {
        out.camera = (await (navigator as any).permissions?.query?.({ name: "camera" as PermissionName }))?.state ?? null;
      } catch { out.camera = null; }
      return out;
    })();

    // Available media devices. When the user reports "no me sale el sonido",
    // sometimes it's that their headphones are selected as input. Knowing
    // the device list (and the active deviceId from the current track) is
    // the difference between "user error" and "real bug".
    const mediaDevices = await (async () => {
      try {
        const all = await navigator.mediaDevices?.enumerateDevices?.();
        return (all ?? []).map((d) => ({
          kind: d.kind,
          // Labels are empty when no permission has been granted yet —
          // that itself is a useful signal.
          label: d.label,
          deviceId: d.deviceId ? d.deviceId.slice(0, 8) + "…" : "",
        }));
      } catch { return []; }
    })();

    // Which device IS the page actually capturing from right now, with the
    // negotiated constraints? The mediaDevices list above shows what's
    // available; this shows what's SELECTED. Past reports had Ron with
    // packetsSent climbing but participants couldn't hear — the missing
    // piece was "which mic was the page using"; once you see the active
    // label is e.g. "Microsoft Teams Audio" (a virtual silence-emitting
    // device), the diagnosis is instant.
    //
    // `getSettings()` also exposes echoCancellation / noiseSuppression /
    // autoGainControl — AGC off with a low level is the usual "very quiet"
    // report, AEC off of "they hear themselves echoing".
    const activeInputDevices = await (async () => {
      const result: any = { microphone: null, camera: null };
      if (!room) return result;
      try {
        const allDevices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
        // Keyed by kind AND id: "default" is a deviceId in every kind, so a
        // map on the id alone let the audiooutput entry overwrite the mic's
        // and reported a mic labelled "Default - MacBook Pro Speakers".
        const labelOf = new Map(allDevices.map((d) => [`${d.kind}:${d.deviceId}`, d.label]));
        const lp = room.localParticipant;
        const grab = (source: "microphone" | "camera") => {
          // RoomEvent flow guarantees publications are populated before
          // any user-facing capture. Walk them defensively anyway.
          const lpAny: any = lp;
          const pubs: any[] = Array.from(lpAny.trackPublications?.values?.() ?? []);
          const pub = pubs.find(
            (p) =>
              (source === "microphone" && p.kind === "audio" && p.source === "microphone") ||
              (source === "camera" && p.kind === "video" && p.source === "camera"),
          );
          const mst = pub?.track?.mediaStreamTrack;
          if (!mst) return null;
          const settings = safe(() => mst.getSettings()) as MediaTrackSettings | null;
          if (!settings) return null;
          return {
            deviceId: settings.deviceId ? settings.deviceId.slice(0, 8) + "…" : null,
            label: settings.deviceId
              ? (labelOf.get(`${source === "microphone" ? "audioinput" : "videoinput"}:${settings.deviceId}`) ?? null)
              : null,
            isMuted: pub?.isMuted ?? null,
            // What we ASKED for and the mode it implies, next to what the
            // browser applied below: iOS WebKit often keeps voice processing on
            // in music mode, and only the pair tells that apart from our code.
            ...(source === "microphone"
              ? { captureMode: safe(() => micSnapshot(pub?.track).mode), requested: safe(() => micSnapshot(pub?.track).requested) }
              : {}),
            constraints: source === "microphone"
              ? {
                  echoCancellation: settings.echoCancellation,
                  noiseSuppression: settings.noiseSuppression,
                  autoGainControl: settings.autoGainControl,
                  voiceIsolation: (settings as any).voiceIsolation,
                  sampleRate: settings.sampleRate,
                  channelCount: settings.channelCount,
                  latency: (settings as any).latency,
                }
              : {
                  width: settings.width,
                  height: settings.height,
                  frameRate: settings.frameRate,
                  facingMode: (settings as any).facingMode,
                  resizeMode: (settings as any).resizeMode,
                },
          };
        };
        result.microphone = grab("microphone");
        result.camera = grab("camera");
      } catch { /* ignore */ }
      return result;
    })();

    // Page visibility at submit time. If the user is reporting "I couldn't
    // hear anything" but `docHidden: true`, the browser may have suspended
    // audio. Different bug than "audio track unsubscribed".
    const docHidden = typeof document !== "undefined" ? document.hidden : null;

    // Memory pressure — JS heap usage. Long sessions on low-end devices
    // can OOM the tab. Only Chrome exposes performance.memory.
    const memory = safe(() => {
      const m: any = (performance as any).memory;
      return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } : null;
    });

    // Where this client's sound is going. Without it "the audio came out of
    // the laptop speakers" could not be told apart from a device the user
    // picked, and the report had no record of the in-app volume at all.
    const output = await (async () => {
      try {
        const s = getOutputState();
        const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
        const chosen = s.deviceId || "default";
        return {
          deviceId: s.deviceId ? s.deviceId.slice(0, 8) + "…" : "default",
          label: all.find((d) => d.kind === "audiooutput" && d.deviceId === chosen)?.label ?? null,
          volume: Math.round(s.volume * 100) / 100,
          roomFactor: remoteAudioFactor(),
        };
      } catch {
        return null;
      }
    })();

    try {
      const res = await fetch("/api/bugs/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          participantId: participantId ?? "unknown",
          roomName: roomName ?? "unknown",
          timestamp: new Date().toISOString(),
          muteEvents,         // ring buffer: last 400 audio events
          lkAudio,            // LiveKit pub.isSubscribed / canHear per remote participant
          stageState,         // sharedState entities vs live trackBySid keys
          muteState,          // internal subscription cache per participantId
          consoleErrors,      // last 30 console.error / unhandled exceptions
          networkInfo,        // effectiveType, downlink, rtt
          roomSnapshot,       // room.state, connectionQuality, localTracks
          remoteParticipants, // identity, name, quality + audio/video pubs per remote
          webrtcStats,        // publisher + subscriber PC stats: RTT, packet loss, jitter
          permissions,        // microphone / camera permission state
          mediaDevices,       // enumerated devices (mic/cam/speaker)
          activeInputDevices, // which device is actually being captured + constraints
          output,             // chosen speaker + in-app volume + any active room duck
          docHidden,          // was the tab visible at submit time?
          memory,             // JS heap usage (Chrome only)
          userAgent: navigator.userAgent,
          sessionDuration: Math.round(performance.now() / 1000), // seconds since page load
        }),
      });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white">
            <Bug className="w-5 h-5 text-amber-400" />
            <span className="font-semibold text-base">Report an issue</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors rounded-full p-1 hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {status === "sent" ? (
          /* Success state */
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle className="w-10 h-10 text-green-400" />
            <p className="text-white font-medium">Report sent. Thank you!</p>
            <p className="text-gray-400 text-sm">Audio diagnostics were included automatically.</p>
            <button
              onClick={onClose}
              className="mt-2 px-5 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg text-sm transition-colors"
            >
              Close
            </button>
          </div>
        ) : status === "error" ? (
          /* Error state */
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <AlertCircle className="w-10 h-10 text-red-400" />
            <p className="text-white font-medium">Failed to send the report.</p>
            <p className="text-gray-400 text-sm">Please try again or contact support directly.</p>
            <button
              onClick={() => setStatus("idle")}
              className="mt-2 px-5 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg text-sm transition-colors"
            >
              Try again
            </button>
          </div>
        ) : (
          /* Form */
          <>
            <p className="text-gray-400 text-sm leading-relaxed">
              Describe the problem. Audio diagnostics will be attached automatically.
            </p>

            <textarea
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. I can't hear the host even though they are unmuted..."
              rows={4}
              className="w-full bg-zinc-800 border border-white/10 rounded-xl text-white text-sm placeholder-gray-500 p-3 resize-none focus:outline-none focus:border-amber-400/50 transition-colors"
            />

            <p className="text-gray-500 text-xs">
              Audio event log and subscription state will be included in the report.
            </p>

            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!description.trim() || status === "sending"}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black rounded-lg transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                {status === "sending" ? "Sending…" : "Send report"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
