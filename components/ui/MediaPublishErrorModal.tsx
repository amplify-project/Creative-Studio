"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Mic, Video, RefreshCw, X, CheckCircle } from "lucide-react";

/**
 * Recovery UI for `getUserMedia` / `publishTrack` failures.
 *
 * The case this is built around: on macOS Safari, when a virtual audio
 * device (Microsoft Teams Audio, BlackHole, etc.) is set as the system
 * default input, `getUserMedia({ audio: true })` resolves to that
 * virtual device. If the owning app is running, Safari throws
 * `UnhandledRejection: No CoreAudioCaptureSource device` and the user
 * is left with the UI claiming the mic is "muted" while in fact no
 * track was ever published.
 *
 * Surface area:
 *  - Plain-language explanation of why the mic might have failed.
 *  - Device dropdown populated from `enumerateDevices()`, split into
 *    physical vs likely-virtual sections (label sniff).
 *  - "Try this device" button that re-attempts publish with the chosen
 *    `deviceId: { exact }` constraint — bypasses the broken default.
 *  - "Close other apps" advisory for the AVAudioSession-locked case.
 *
 * Modal stays open across multiple retries until the user explicitly
 * dismisses or a retry succeeds.
 */
const VIRTUAL_DEVICE_RE =
  /microsoft teams|zoom|discord|loopback|blackhole|soundflower|virtual|krisp|vb-audio/i;

type Props = {
  open: boolean;
  kind: "audio" | "video";
  errorMessage: string;
  devices: MediaDeviceInfo[];
  /** Called with the chosen deviceId. Should throw on failure so the
   *  modal can show the inline retry-failed state and keep itself open. */
  onRetry: (deviceId: string) => Promise<void>;
  onClose: () => void;
};

export default function MediaPublishErrorModal({
  open, kind, errorMessage, devices, onRetry, onClose,
}: Props) {
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "trying" | "success" | "failed">("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  // Auto-select first physical device when modal opens so the user can
  // click "Try this device" without touching the dropdown in the common
  // case.
  useEffect(() => {
    if (!open) return;
    const physical = devices.find((d) => !VIRTUAL_DEVICE_RE.test(d.label));
    setSelected(physical?.deviceId ?? devices[0]?.deviceId ?? "");
    setStatus("idle");
    setLastError(null);
  }, [open, devices]);

  if (!open) return null;

  const physical = devices.filter((d) => !VIRTUAL_DEVICE_RE.test(d.label));
  const virtual = devices.filter((d) => VIRTUAL_DEVICE_RE.test(d.label));

  const handleRetry = async () => {
    if (!selected) return;
    setStatus("trying");
    setLastError(null);
    try {
      await onRetry(selected);
      setStatus("success");
      // Close shortly after success so the user sees the confirmation.
      setTimeout(onClose, 900);
    } catch (e: any) {
      setStatus("failed");
      setLastError(e?.message ?? String(e));
    }
  };

  const Icon = kind === "audio" ? Mic : Video;
  const kindLabel = kind === "audio" ? "microphone" : "camera";

  return (
    <div
      className="fixed inset-0 z-[999998] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-zinc-900 border border-amber-500/30 rounded-2xl shadow-2xl flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-white">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <Icon className="w-5 h-5 text-zinc-300" />
            <span className="font-semibold text-base">Can&apos;t start your {kindLabel}</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors rounded-full p-1 hover:bg-white/10"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-gray-300 text-sm leading-relaxed">
          The browser couldn&apos;t open a {kindLabel} input. This usually means
          another app (Teams, Zoom, FaceTime…) is holding the device, or a
          virtual driver was selected as the system default.
        </p>

        {/* Show the raw error in small text so the operator can correlate
            with bug reports / connlog. Hidden by default to keep the
            modal user-friendly. */}
        {errorMessage && (
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Technical details</summary>
            <pre className="mt-1 p-2 bg-black/40 rounded text-zinc-400 break-all whitespace-pre-wrap">
              {errorMessage}
            </pre>
          </details>
        )}

        {devices.length > 0 ? (
          <div className="space-y-2">
            <label className="text-xs text-zinc-400 uppercase tracking-wider">
              Pick a {kindLabel}
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={status === "trying"}
              className="w-full bg-zinc-800 border border-white/10 rounded-lg text-white text-sm px-3 py-2 focus:outline-none focus:border-amber-400/60 disabled:opacity-40"
            >
              {/* <option> can only carry text, not JSX — Icon is rendered
                  separately next to the heading and the group labels make
                  the kind obvious. */}
              {physical.length > 0 && (
                <optgroup label="Physical devices (recommended)">
                  {physical.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || "(unknown device)"}
                    </option>
                  ))}
                </optgroup>
              )}
              {virtual.length > 0 && (
                <optgroup label="Virtual drivers (may not work)">
                  {virtual.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || "(unknown virtual device)"}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        ) : (
          <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
            No {kindLabel}s were found. Check that one is plugged in and that
            the browser has permission to use it.
          </div>
        )}

        {/* Status row — shows the result of the last retry attempt. */}
        {status === "failed" && lastError && (
          <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2">
            Still couldn&apos;t open it: {lastError}
          </div>
        )}
        {status === "success" && (
          <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-2">
            <CheckCircle className="w-4 h-4" />
            Got it! Closing…
          </div>
        )}

        {/* Advisory: close other apps. Plain text, no action — closing
            apps is not something we can do from the browser, but naming
            them often unblocks the user. */}
        <div className="text-xs text-zinc-500 leading-relaxed border-t border-white/10 pt-3">
          <strong className="text-zinc-300">Still failing?</strong> Quit any
          other app using your {kindLabel} (Microsoft Teams, Zoom,
          FaceTime, OBS, GarageBand…) and try again. If that doesn&apos;t work,
          fully close and reopen your browser.
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={handleRetry}
            disabled={!selected || status === "trying" || status === "success"}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black rounded-lg transition-colors"
          >
            {status === "trying" ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Trying…
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                Try this device
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
