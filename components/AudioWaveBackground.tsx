"use client";

import { useEffect, useRef, useState } from "react";
import { RoomEvent, Track } from "livekit-client";

const BAR_COUNT = 22;

function identityHue(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string) {
  return name
    .split(/[\s_-]+/)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase() || "?";
}

export default function AudioWaveBackground({
  userId,
  room,
}: {
  userId: string;
  room?: any;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  // Bumped whenever this participant's audio track set changes so the analyser
  // effect re-runs and rebinds. Without this the effect ran once at mount —
  // if the remote audio wasn't subscribed yet the bars stayed flat forever.
  const [audioEpoch, setAudioEpoch] = useState(0);

  useEffect(() => {
    if (!room) return;
    const bump = (_t: any, _pub: any, p: any) => {
      if (p?.identity === userId) setAudioEpoch((e) => e + 1);
    };
    const onSubscribed = (track: any, pub: any, p: any) => {
      if (track?.kind !== Track.Kind.Audio) return;
      bump(track, pub, p);
    };
    const onUnsubscribed = (track: any, pub: any, p: any) => {
      if (track?.kind !== Track.Kind.Audio) return;
      bump(track, pub, p);
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    };
  }, [room, userId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // find the participant's first subscribed audio track
    const participant =
      room?.remoteParticipants?.get(userId) ??
      (room?.localParticipant?.identity === userId ? room?.localParticipant : undefined);

    const pubs = Array.from(
      (participant?.audioTrackPublications as Map<string, any> | undefined)?.values() ?? []
    );
    // Prefer a publication that already has a MediaStream (subscribed). When
    // none has it (audio still arriving), fall back to building a MediaStream
    // around the bare MediaStreamTrack so the analyser is wired the moment a
    // track exists, not only after `track.mediaStream` is populated.
    const pubWithStream = pubs.find((p: any) => p.track?.mediaStream);
    const pubWithMst = pubs.find((p: any) => p.track?.mediaStreamTrack);
    let stream: MediaStream | undefined = pubWithStream?.track?.mediaStream;
    if (!stream && pubWithMst?.track?.mediaStreamTrack) {
      try {
        stream = new MediaStream([pubWithMst.track.mediaStreamTrack]);
      } catch { /* older browsers — leave undefined */ }
    }

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let dataArray: Uint8Array<ArrayBuffer>;

    if (stream) {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;           // 32 frequency bins
      analyser.smoothingTimeConstant = 0.82;
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);        // NOT connected to destination → no double-play
      dataArray = new Uint8Array(analyser.frequencyBinCount) as unknown as Uint8Array<ArrayBuffer>;
      ctx.resume().catch(() => {});
    }

    const hue = identityHue(userId);
    const displayName = participant?.name ?? userId;
    const inits = initials(displayName);
    // Truncate long names
    const shortName = displayName.length > 22 ? displayName.slice(0, 21) + "…" : displayName;

    const draw = () => {
      if (!canvas) return;
      const c = canvas.getContext("2d");
      if (!c) return;

      const W = canvas.width;
      const H = canvas.height;
      c.clearRect(0, 0, W, H);

      // --- background ---
      const bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0a0c14");
      bg.addColorStop(1, "#111320");
      c.fillStyle = bg;
      c.fillRect(0, 0, W, H);

      // --- avatar circle ---
      const avatarR = Math.min(W * 0.14, 38);
      const avatarX = W / 2;
      const avatarY = H * 0.32;
      const grad = c.createRadialGradient(avatarX - avatarR * 0.25, avatarY - avatarR * 0.25, 0, avatarX, avatarY, avatarR);
      grad.addColorStop(0, `hsl(${hue}, 65%, 65%)`);
      grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 65%, 45%)`);
      c.beginPath();
      c.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2);
      c.fillStyle = grad;
      c.fill();

      // initials
      c.fillStyle = "#fff";
      c.font = `600 ${Math.round(avatarR * 0.7)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(inits, avatarX, avatarY);

      // --- waveform bars ---
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
      }

      const waveY = H * 0.72;         // vertical center of the waveform zone
      const maxBarH = H * 0.22;       // max half-height of a bar
      const minBarH = H * 0.022;      // min half-height (resting state)
      const totalW = W * 0.82;
      const barW = (totalW / BAR_COUNT) * 0.55;
      const spacing = totalW / BAR_COUNT;
      const startX = (W - totalW) / 2 + spacing * 0.225;

      for (let i = 0; i < BAR_COUNT; i++) {
        let value = 0;
        if (analyser && dataArray) {
          const binIdx = Math.floor((i / BAR_COUNT) * (dataArray.length * 0.75));
          value = dataArray[binIdx] / 255;
        }

        const halfH = minBarH + value * (maxBarH - minBarH);
        const x = startX + i * spacing;
        const alpha = 0.45 + value * 0.55;

        const barGrad = c.createLinearGradient(x, waveY - halfH, x, waveY + halfH);
        barGrad.addColorStop(0,   `hsla(${hue}, 80%, 72%, ${alpha})`);
        barGrad.addColorStop(0.5, `hsla(${(hue + 160) % 360}, 75%, 62%, ${alpha})`);
        barGrad.addColorStop(1,   `hsla(${hue}, 80%, 72%, ${alpha})`);

        c.fillStyle = barGrad;
        const r = barW / 2;
        c.beginPath();
        c.roundRect(x - r, waveY - halfH, barW, halfH * 2, r);
        c.fill();
      }

      // --- name label ---
      c.fillStyle = "rgba(255,255,255,0.38)";
      c.font = `400 ${Math.round(H * 0.072)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "alphabetic";
      c.fillText(shortName, W / 2, H * 0.95);

      rafRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (source) source.disconnect();
      if (ctx) ctx.close();
    };
  }, [userId, room, audioEpoch]);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={300}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
