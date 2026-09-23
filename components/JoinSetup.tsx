"use client";

import { useEffect, useRef, useState } from "react";
import { createLocalAudioTrack, createLocalVideoTrack, ConnectionQuality, RoomEvent } from "livekit-client";
import { AUDIO_MODE_PRESETS, type AudioMode } from "./audioSelector";
import { Mic, Video, Loader2, VideoOff, WifiOff, Wifi, Volume2, Play } from "lucide-react";
import { useMicLevel, dbToPercent, SIGNAL_DB, LOW_DB } from "../app/hooks/useMicLevel";
import {
  readStoredVolume,
  writeStoredVolume,
  readStoredOutputDevice,
  writeStoredOutputDevice,
  canChooseOutputDevice,
} from "../app/hooks/useOutputVolume";
import { testToneUrl } from "../app/utils/testTone";

interface JoinSetupProps {
  room: any;
  audioMode?: AudioMode;
  onJoined: () => void;
}

export default function JoinSetup({ room, audioMode = "speech", onJoined }: JoinSetupProps) {
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState("");
  const [selectedAudioDevice, setSelectedAudioDevice] = useState("");
  const [audioOnly, setAudioOnly] = useState(false);
  const [joining, setJoining] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [connQuality, setConnQuality] = useState<ConnectionQuality | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pre-join audio check. The mic preview is a capture of its own: nothing is
  // published yet, so there is no room track to measure. It is torn down
  // before handleJoin opens the real one — on iOS a second capture while the
  // first is live comes back with different constraints, or not at all.
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDevice, setSelectedOutputDevice] = useState("");
  const [outputVolume, setOutputVolume] = useState(1);
  const [testing, setTesting] = useState(false);
  // The enumeration pass below opens its own probe capture to unlock device
  // labels. The mic preview waits for it to finish and release: two
  // overlapping getUserMedia calls at mount is exactly the iOS case this
  // screen is trying to be careful about.
  const [devicesReady, setDevicesReady] = useState(false);
  const toneRef = useRef<HTMLAudioElement | null>(null);
  const canPickOutput = canChooseOutputDevice();

  const { holdDb, peakDb, clipping } = useMicLevel(micStream?.getAudioTracks()[0] ?? null);

  // Enumerate devices
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        // Stop tracks after permission granted
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((list) => {
        setVideoDevices(list.filter((d) => d.kind === "videoinput"));
        setAudioDevices(list.filter((d) => d.kind === "audioinput"));
        setOutputDevices(list.filter((d) => d.kind === "audiooutput"));
      })
      .catch(() => {})
      // Ready either way: without permission there are no labels and no
      // preview, but the screen must still offer the Join button.
      .finally(() => setDevicesReady(true));
  }, []);

  // Speaker preference from a previous visit. Read once on mount rather than
  // used as initial state so the server render and the first client render
  // agree — localStorage does not exist during SSR.
  useEffect(() => {
    setOutputVolume(readStoredVolume());
    setSelectedOutputDevice(readStoredOutputDevice());
  }, []);

  // Mic preview, for the level meter. Uses the same capture constraints the
  // join will publish with, so the reading is what the room will actually
  // receive rather than the browser's default processing chain.
  useEffect(() => {
    if (!devicesReady) return;
    let active = true;
    let opened: MediaStream | null = null;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...AUDIO_MODE_PRESETS[audioMode].capture,
            ...(selectedAudioDevice ? { deviceId: { exact: selectedAudioDevice } } : {}),
          },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        opened = stream;
        setMicStream(stream);
      } catch {
        setMicStream(null);
      }
    })();
    return () => {
      active = false;
      opened?.getTracks().forEach((t) => t.stop());
    };
  }, [selectedAudioDevice, audioMode, devicesReady]);

  // Connection quality
  useEffect(() => {
    if (!room) return;
    setConnQuality(room.localParticipant?.connectionQuality ?? null);
    const onQuality = (quality: ConnectionQuality, participant: any) => {
      if (participant.identity === room.localParticipant?.identity) {
        setConnQuality(quality);
      }
    };
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    return () => { room.off(RoomEvent.ConnectionQualityChanged, onQuality); };
  }, [room]);

  // Camera preview
  useEffect(() => {
    if (audioOnly) {
      previewStream?.getTracks().forEach((t) => t.stop());
      setPreviewStream(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }
    let active = true;
    const startPreview = async () => {
      try {
        if (previewStream) {
          previewStream.getTracks().forEach((t) => t.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedVideoDevice ? { deviceId: { exact: selectedVideoDevice } } : true,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setPreviewStream(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch {}
    };
    startPreview();
    return () => {
      active = false;
    };
  }, [selectedVideoDevice, audioOnly]);

  // Cleanup preview on unmount
  useEffect(() => {
    return () => {
      previewStream?.getTracks().forEach((t) => t.stop());
    };
  }, [previewStream]);

  /** Play the tone through the chosen speaker at the chosen volume. */
  const playTestTone = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const el = toneRef.current ?? new Audio(testToneUrl());
      toneRef.current = el;
      el.volume = outputVolume;
      // Chromium-only; on Safari the picker is hidden and this is skipped.
      if (canPickOutput && selectedOutputDevice) {
        await (el as any).setSinkId(selectedOutputDevice).catch(() => {});
      }
      el.currentTime = 0;
      await el.play();
      // The tone is a fixed length, so a timer is enough — `ended` does not
      // fire if the user changes device mid-play.
      setTimeout(() => setTesting(false), 800);
    } catch {
      setTesting(false);
    }
  };

  const handleJoin = async (withVideo = !audioOnly) => {
    if (!room || joining) return;
    setJoining(true);

    try {
      // Stop both previews before publishing anything. The mic one matters:
      // holding a capture open while createLocalAudioTrack opens another is
      // the duplicate-capture case docs/llm/08 was written about, and on iOS
      // the second one can come back silent.
      previewStream?.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      setMicStream(null);

      // Persist the speaker choice before publishing — useOutputVolume reads
      // it back to set every remote participant, including ones who join
      // later, and switchActiveDevice routes the room's audio elements.
      writeStoredVolume(outputVolume);
      writeStoredOutputDevice(selectedOutputDevice);
      if (canPickOutput && selectedOutputDevice) {
        await room.switchActiveDevice("audiooutput", selectedOutputDevice).catch(() => {});
      }

      const preset = AUDIO_MODE_PRESETS[audioMode];

      if (withVideo) {
        const videoTrack = await createLocalVideoTrack({
          resolution: { width: 1280, height: 720 },
          deviceId: selectedVideoDevice || undefined,
        });
        await room.localParticipant.publishTrack(videoTrack, { name: "primary" });
      }

      // Publish audio with mode preset
      const audioTrack = await createLocalAudioTrack({
        ...preset.capture,
        deviceId: selectedAudioDevice || "default",
      });
      await room.localParticipant.publishTrack(audioTrack, { ...preset.publish });

      onJoined();
    } catch (err) {
      console.error("Join failed:", err);
      setJoining(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md max-h-viewport overflow-y-auto p-6 space-y-4">
        <h2 className="text-xl font-bold text-white text-center">Join Session</h2>

        {/* Camera preview */}
        <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden">
          {audioOnly ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-500">
              <VideoOff className="w-8 h-8" />
              <span className="text-sm">Camera off</span>
            </div>
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: "scaleX(-1)" }}
            />
          )}
        </div>

        {/* Audio-only toggle */}
        <label className="flex items-center gap-3 cursor-pointer select-none text-sm text-gray-300">
          <div
            onClick={() => setAudioOnly((v) => !v)}
            className={`relative w-10 h-6 rounded-full transition-colors ${audioOnly ? "bg-indigo-600" : "bg-zinc-600"}`}
          >
            <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${audioOnly ? "translate-x-4" : ""}`} />
          </div>
          <span>Join without camera</span>
        </label>

        {/* Video device (hidden when audio-only) */}
        {!audioOnly && (
        <label className="flex flex-col text-sm text-gray-300 gap-1">
          <span className="flex items-center gap-1.5">
            <Video className="w-4 h-4" /> Camera
          </span>
          <select
            value={selectedVideoDevice}
            onChange={(e) => setSelectedVideoDevice(e.target.value)}
            className="bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Default</option>
            {videoDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera (${d.deviceId.slice(0, 8)})`}
              </option>
            ))}
          </select>
        </label>
        )}

        {/* Audio device */}
        <label className="flex flex-col text-sm text-gray-300 gap-1">
          <span className="flex items-center gap-1.5">
            <Mic className="w-4 h-4" /> Microphone
          </span>
          <select
            value={selectedAudioDevice}
            onChange={(e) => setSelectedAudioDevice(e.target.value)}
            className="bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Default</option>
            {audioDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Mic (${d.deviceId.slice(0, 8)})`}
              </option>
            ))}
          </select>
        </label>

        {/* Live input meter. It measures, it does not fix: input gain is an OS
            setting and the `volume` capture constraint is not honoured by any
            browser, so the only thing this screen can honestly do is show the
            user what the room will hear. Same reading as MicCalibrationPanel
            — they share useMicLevel, or a level set here would not match the
            one seen in session. */}
        <div className="flex flex-col gap-1.5">
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width] duration-75 ${
                clipping ? "bg-red-500" : holdDb >= LOW_DB ? "bg-emerald-500" : "bg-amber-500"
              }`}
              style={{ width: `${dbToPercent(peakDb)}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {!micStream
              ? "No microphone detected — check the selection above."
              : clipping
              ? "Too loud — it is distorting. Lower the input gain in your system sound settings, or move back from the mic."
              : !(holdDb >= SIGNAL_DB)
              ? "Say something — the bar should move."
              : holdDb < LOW_DB
              ? "We can hear you, but quietly. Raise the input gain in your system sound settings, or move closer."
              : "Level looks good."}
          </p>
        </div>

        {/* Speaker. Before joining there is nobody to hear, so the slider
            needs the tone to mean anything. The value is stored and applied
            to every remote participant after joining — see useOutputVolume. */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-sm text-gray-300">
            <Volume2 className="w-4 h-4" /> Speaker
          </span>

          {/* setSinkId is Chromium-only; on Safari there is no way to choose
              an output, so showing a picker that silently does nothing would
              be worse than not showing one. */}
          {canPickOutput && outputDevices.length > 0 && (
            <select
              value={selectedOutputDevice}
              onChange={(e) => setSelectedOutputDevice(e.target.value)}
              className="bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Default</option>
              {outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker (${d.deviceId.slice(0, 8)})`}
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(outputVolume * 100)}
              onChange={(e) => setOutputVolume(Number(e.target.value) / 100)}
              aria-label="Speaker volume"
              className="flex-1 accent-indigo-500"
            />
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-gray-400">
              {Math.round(outputVolume * 100)}%
            </span>
            <button
              type="button"
              onClick={playTestTone}
              disabled={testing}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2
                         text-xs font-medium text-gray-200 transition-colors
                         hover:bg-zinc-700 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {testing ? "Playing" : "Test"}
            </button>
          </div>
        </div>

        {/* Audio mode indicator */}
        <p className="text-xs text-gray-500 text-center">
          Audio mode: <span className="font-medium text-gray-300">{audioMode === "music" ? "Music (high quality)" : "Speech (noise suppression)"}</span>
        </p>

        {/* Connection quality banner */}
        {connQuality === ConnectionQuality.Poor || connQuality === ConnectionQuality.Lost ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/15 border border-orange-500/40 text-orange-300 text-xs">
            <WifiOff className="w-4 h-4 shrink-0" />
            <span>Poor connection detected — audio quality may be affected. Consider joining without camera.</span>
          </div>
        ) : connQuality === ConnectionQuality.Good || connQuality === ConnectionQuality.Excellent ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-xs">
            <Wifi className="w-4 h-4 shrink-0" />
            <span>Good connection</span>
          </div>
        ) : null}

        {/* Join button */}
        <button
          onClick={() => handleJoin()}
          disabled={joining}
          className="w-full py-3 rounded-xl font-semibold text-white text-base transition-colors flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {joining ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" /> Connecting...
            </>
          ) : audioOnly ? (
            <>
              <Mic className="w-5 h-5" /> Join with Audio Only
            </>
          ) : (
            <>
              <Video className="w-5 h-5" /> Join with Audio & Video
            </>
          )}
        </button>
      </div>
    </div>
  );
}
