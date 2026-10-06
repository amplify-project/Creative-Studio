import { useEffect, useState } from "react";
import { AudioPresets } from "livekit-client";

export type AudioMode = "music" | "speech";

export type AudioCaptureState = {
  voiceIsolation: boolean;
  sampleSize: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  channelCount: number;
  sampleRate: number;
  deviceId: string;
  latency: number;
};

export type AudioPresetType = typeof AudioPresets[keyof typeof AudioPresets];

export type AudioPublishState = {
  audioPreset: AudioPresetType;
  dtx: boolean;
  red: boolean;
};

/** Pre-configured audio profiles */
export const AUDIO_MODE_PRESETS: Record<
  AudioMode,
  { capture: Omit<AudioCaptureState, "deviceId">; publish: AudioPublishState }
> = {
  music: {
    capture: {
      noiseSuppression: false,
      echoCancellation: false,
      autoGainControl: false,
      voiceIsolation: false,  // ❌ sin procesado de voz
      // Stereo, unless the device turns out to have a dead side — then it is
      // captured mono (app/utils/micCapture.ts, watchForDeadChannel).
      channelCount: 2,
      sampleRate: 48000,
      sampleSize: 24,
      latency: 0.1,
    },
    publish: {
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,             // sin detección de silencio
      red: false,
    },
  },
  speech: {
    capture: {
      noiseSuppression: true,   // ✅
      echoCancellation: true,   // ✅
      // AGC on for speech: without it a laptop mic at arm's length reaches the
      // room raw and quiet. Music keeps it off — it would pump the dynamics.
      autoGainControl: true,    // ✅
      voiceIsolation: true,     // ✅ ahora activado
      // Mono. This said "mono" but asked for 2: echo cancellation processes in
      // mono anyway, so speech gained nothing from it, and an interface with
      // the mic in input 1 put the speaker in one ear only.
      channelCount: 1,
      sampleRate: 48000,
      sampleSize: 16,
      latency: 0.05,
    },
    publish: {
      audioPreset: AudioPresets.music, // music quality with voice processing
      dtx: true,
      red: true,
    },
  },
};

interface Props {
  onSave: (result: {
    capture: AudioCaptureState;
    publish: AudioPublishState;
  }) => void;
  onClose?: () => void;
  initialCapture: AudioCaptureState;
  initialPublish: AudioPublishState;
  initialMode?: AudioMode;
}

export default function AudioSettingsPanel({
  onSave,
  onClose,
  initialCapture,
  initialPublish,
  initialMode = "speech",
}: Props) {
  const [mode, setMode] = useState<AudioMode>(initialMode);
  const [capture, setCapture] = useState(initialCapture);
  const [publish, setPublish] = useState(initialPublish);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const applyMode = (newMode: AudioMode) => {
    setMode(newMode);
    const preset = AUDIO_MODE_PRESETS[newMode];
    setCapture((c) => ({ ...c, ...preset.capture }));
    setPublish(preset.publish);
  };

  const handleSave = () => {
    onSave({ capture, publish });
  };

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((list) => {
      setDevices(list.filter((d) => d.kind === "audioinput"));
    });
  }, []);

  return (
    <div className="panel p-5 bg-gray-800 text-white rounded-xl w-full max-w-[350px] space-y-6 shadow-lg relative z-[999999]">
      {/* Botón de cierre */}
      <button
        onClick={() => onClose?.()}
        className="absolute top-2 right-2 text-white font-bold text-lg hover:text-gray-300"
      >
        ×
      </button>

      <h2 className="text-xl font-bold mb-2">Audio Settings</h2>

      {/* MODE SELECTOR */}
      <div className="flex gap-2">
        <button
          onClick={() => applyMode("music")}
          className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
            mode === "music"
              ? "bg-purple-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          🎵 Music
        </button>
        <button
          onClick={() => applyMode("speech")}
          className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
            mode === "speech"
              ? "bg-blue-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          🎙️ Speech
        </button>
      </div>

      {/* Descripción del modo activo */}
      <div className="text-xs text-gray-400 bg-gray-700/50 rounded-lg px-3 py-2">
        {mode === "music" ? (
          <span>
            <strong className="text-purple-400">Music mode:</strong> maximum quality, stereo, no processing.
            Use headphones to avoid echo.
          </span>
        ) : (
          <span>
            <strong className="text-blue-400">Speech mode:</strong> echo cancellation, noise suppression
            and voice isolation enabled. Mono, optimized for speech.
          </span>
        )}
      </div>

      {/* CAPTURE */}
      <div>
        <h3 className="font-semibold text-lg mb-2">Capture</h3>
        <div className="space-y-2 text-sm">

          <label className="flex flex-col">
            Device
            <select
              value={capture.deviceId}
              onChange={(e) => setCapture((c) => ({ ...c, deviceId: e.target.value }))}
              className="bg-gray-700 p-1 rounded mt-1"
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Unknown device"}
                </option>
              ))}
            </select>
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={capture.noiseSuppression}
              onChange={(e) => setCapture((c) => ({ ...c, noiseSuppression: e.target.checked }))}
            />
            Noise Suppression
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={capture.echoCancellation}
              onChange={(e) => setCapture((c) => ({ ...c, echoCancellation: e.target.checked }))}
            />
            Echo Cancellation
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={capture.autoGainControl}
              onChange={(e) => setCapture((c) => ({ ...c, autoGainControl: e.target.checked }))}
            />
            Auto Gain Control
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={capture.voiceIsolation}
              onChange={(e) => setCapture((c) => ({ ...c, voiceIsolation: e.target.checked }))}
            />
            Voice Isolation
          </label>

          <label className="flex flex-col">
            Channels
            <select
              value={capture.channelCount}
              onChange={(e) => setCapture((c) => ({ ...c, channelCount: Number(e.target.value) }))}
              className="bg-gray-700 p-1 rounded mt-1"
            >
              <option value={1}>Mono (1)</option>
              <option value={2}>Stereo (2)</option>
            </select>
          </label>

          <label className="flex flex-col">
            Sample Rate
            <select
              value={capture.sampleRate}
              onChange={(e) => setCapture((c) => ({ ...c, sampleRate: Number(e.target.value) }))}
              className="bg-gray-700 p-1 rounded mt-1"
            >
              <option value={16000}>16 kHz</option>
              <option value={24000}>24 kHz</option>
              <option value={32000}>32 kHz</option>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={88200}>88.2 kHz</option>
              <option value={96000}>96 kHz</option>
            </select>
          </label>

          <label className="flex flex-col">
            Sample Size
            <select
              value={capture.sampleSize}
              onChange={(e) => setCapture((c) => ({ ...c, sampleSize: Number(e.target.value) }))}
              className="bg-gray-700 p-1 rounded mt-1"
            >
              <option value={16}>16 bit</option>
              <option value={24}>24 bit</option>
              <option value={32}>32 bit</option>
            </select>
          </label>

          <label className="flex flex-col">
            Latency (seconds)
            <input
              type="number"
              step="0.01"
              min="0"
              value={capture.latency}
              onChange={(e) => setCapture((c) => ({ ...c, latency: Number(e.target.value) }))}
              className="bg-gray-700 p-1 rounded mt-1"
            />
          </label>
        </div>
      </div>

      {/* PUBLISH */}
      <div>
        <h3 className="font-semibold text-lg mb-2">Publishing</h3>
        <div className="space-y-2 text-sm">

          <label className="flex flex-col">
            Audio Preset
            <select
              value={JSON.stringify(publish.audioPreset)}
              onChange={(e) => setPublish((p) => ({ ...p, audioPreset: JSON.parse(e.target.value) }))}
              className="bg-gray-700 p-1 rounded mt-1"
            >
              <option value={JSON.stringify(AudioPresets.speech)}>Speech</option>
              <option value={JSON.stringify(AudioPresets.music)}>Music</option>
              <option value={JSON.stringify(AudioPresets.musicHighQuality)}>Music High Quality</option>
              <option value={JSON.stringify(AudioPresets.musicHighQualityStereo)}>Music HQ Stereo</option>
            </select>
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={publish.dtx}
              onChange={(e) => setPublish((p) => ({ ...p, dtx: e.target.checked }))}
            />
            DTX <span className="text-gray-400">(silence detection)</span>
          </label>

          <label className="flex gap-2 items-center">
            <input
              type="checkbox"
              checked={publish.red}
              onChange={(e) => setPublish((p) => ({ ...p, red: e.target.checked }))}
            />
            RED <span className="text-gray-400">(redundancy)</span>
          </label>
        </div>
      </div>

      <button
        onClick={handleSave}
        className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 rounded-xl font-medium"
      >
        Publish
      </button>
    </div>
  );
}