import { useState, useEffect } from "react";

export type VideoCaptureState = {
  deviceId?: string;
  width: number;
  height: number;
  frameRate: number;
  facingMode?: "user" | "environment" | "left" | "right";
};

export type VideoPublishState = {
  simulcast: boolean;
  priority: number;
  degradationPreference: "balanced" | "maintain-resolution" | "maintain-framerate";
};

interface Props {
  onSave: (result: {
    capture: VideoCaptureState;
    publish: VideoPublishState;
  }) => void;
  onClose?: () => void;
  initialCapture: VideoCaptureState;
  initialPublish: VideoPublishState;
}

export default function VideoSettingsPanel({
  onSave,
  onClose,
  initialCapture,
  initialPublish,
}: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [capture, setCapture] = useState(initialCapture);
  const [publish, setPublish] = useState(initialPublish);

  // Nuevo estado para controlar si el panel está abierto
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((list) => {
      setDevices(list.filter((d) => d.kind === "videoinput"));
    });
  }, []);

  const handleSave = () => {
    onSave({ capture, publish });
  };

  // Si el panel está cerrado, no renderizar nada
  if (!isOpen) return null;

  return (
    <div className="panel p-5 bg-gray-800 text-white rounded-xl w-full max-w-[350px] space-y-6 shadow-lg relative">
      {/* Botón de cierre */}
      <button
        onClick={() => onClose?.()}
        className="absolute top-2 right-2 text-white font-bold text-lg hover:text-gray-300"
      >
        ×
      </button>

      <h2 className="text-xl font-bold">Video Settings</h2>

      {/* CAPTURE */}
      <div>
        <h3 className="font-semibold text-lg mb-2">Capture</h3>

        <label className="flex flex-col text-sm mb-2">
          Camera
          <select
            value={capture.deviceId || ""}
            onChange={(e) =>
              setCapture((c) => ({ ...c, deviceId: e.target.value }))
            }
          >
            <option value="">Default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera (${d.deviceId})`}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2 text-sm mb-3">
          <label className="flex flex-col">
            Width
            <input
              type="number"
              value={capture.width}
              onChange={(e) =>
                setCapture((c) => ({ ...c, width: Number(e.target.value) }))
              }
            />
          </label>

          <label className="flex flex-col">
            Height
            <input
              type="number"
              value={capture.height}
              onChange={(e) =>
                setCapture((c) => ({ ...c, height: Number(e.target.value) }))
              }
            />
          </label>
        </div>

        <label className="flex flex-col text-sm mb-3">
          FPS
          <input
            type="number"
            value={capture.frameRate}
            onChange={(e) =>
              setCapture((c) => ({ ...c, frameRate: Number(e.target.value) }))
            }
          />
        </label>

        <label className="flex flex-col text-sm">
          Facing Mode
          <select
            value={capture.facingMode}
            onChange={(e) =>
              setCapture((c) => ({
                ...c,
                facingMode: e.target.value as VideoCaptureState["facingMode"],
              }))
            }
          >
            <option value="user">Front</option>
            <option value="environment">Back</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      </div>

      {/* PUBLISH */}
      <div>
        <h3 className="font-semibold text-lg mb-2">Publishing</h3>

        <label className="flex gap-2 items-center text-sm">
          <input
            type="checkbox"
            checked={publish.simulcast}
            onChange={(e) =>
              setPublish((p) => ({ ...p, simulcast: e.target.checked }))
            }
          />
          Use simulcast
        </label>

        <label className="flex flex-col text-sm mt-2">
          Priority
          <input
            type="number"
            value={publish.priority}
            onChange={(e) =>
              setPublish((p) => ({
                ...p,
                priority: Number(e.target.value),
              }))
            }
          />
        </label>

        <label className="flex flex-col text-sm mt-2">
          Degradation preference
          <select
            value={publish.degradationPreference}
            onChange={(e) =>
              setPublish((p) => ({
                ...p,
                degradationPreference: e.target.value as any,
              }))
            }
          >
            <option value="balanced">Balanced</option>
            <option value="maintain-resolution">Maintain resolution</option>
            <option value="maintain-framerate">Maintain framerate</option>
          </select>
        </label>
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
