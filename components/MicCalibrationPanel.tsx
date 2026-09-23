"use client";

/**
 * Mic level calibration — a live meter that helps a user set their input gain.
 *
 * Reads the *already published* mic track instead of opening a fresh
 * getUserMedia: it measures the signal the room actually receives, with the
 * active mode's constraints applied, and a second capture is exactly the
 * duplicate-mic race in docs/llm/08. (Play2GetherCalibration opens its own
 * capture because it needs AEC off for the acoustic loopback — a level meter
 * has the opposite requirement.)
 *
 * This panel measures and guides; it does not fix. Input gain lives in the OS
 * and the `volume` constraint is not honoured by browsers, so once a signal
 * clips at the converter no filter recovers it. The user does the fixing.
 */

import { useEffect, useState } from "react";
import { Track } from "livekit-client";
import { AlertTriangle, CheckCircle2, MicOff, X } from "lucide-react";
import type { MicIssue } from "../app/skills/types";
import { useMicLevel, dbToPercent, FLOOR_DB, SIGNAL_DB, LOW_DB } from "../app/hooks/useMicLevel";


type Props = {
  room: any;
  /** What the analyser flagged, so the guidance matches the problem. The meter
   *  is useful for both — proximity effect and clipping are usually the same
   *  person too close to the mic — but the fix differs: gain vs. distance. */
  issue?: MicIssue;
  onClose: () => void;
};

export default function MicCalibrationPanel({
  room,
  issue = "clipping",
  onClose,
}: Props) {
  const [problem, setProblem] = useState<null | "no-track" | "muted">(null);

  // The published track, not a fresh capture — see the note at the top of the
  // file. Resolved on every render so it picks up a republish (a mode switch,
  // or the retry modal) without needing its own subscription.
  const pub = room?.localParticipant?.getTrackPublication?.(Track.Source.Microphone);
  const mst = pub?.track?.mediaStreamTrack ?? null;
  const muted = pub?.isMuted ?? false;

  useEffect(() => {
    setProblem(!mst ? "no-track" : muted ? "muted" : null);
  }, [mst, muted]);

  const { peakDb, holdDb, clipping, everClipped } = useMicLevel(
    mst && !muted ? mst : null,
  );

  const pct = dbToPercent(peakDb);
  const holdPct = dbToPercent(holdDb);
  const tooHot = peakDb > -3;
  // holdDb is the loudest peak of the last few seconds, so these stay stable
  // through the gaps between notes.
  const noSignal = !(holdDb >= SIGNAL_DB);   // also catches the -Infinity start
  const tooQuiet = !noSignal && holdDb < LOW_DB;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg bg-neutral-900 text-white shadow-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold">Microphone calibration</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {problem ? (
          <div className="flex items-start gap-3 px-4 py-6 text-sm">
            <MicOff className="mt-0.5 h-5 w-5 shrink-0 text-yellow-400" />
            <p className="text-white/80">
              {problem === "muted"
                ? "Your microphone is muted. Unmute it to measure your level."
                : "No microphone is being published right now. Turn your mic on and reopen this panel."}
            </p>
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4">
            <p className="text-sm text-white/70">
              {issue === "bass_boost"
                ? "Your mic is picking up a heavy low end — usually the proximity effect from singing or playing very close to it. Move back a hand's width, or angle the mic slightly off to one side, and watch the meter settle."
                : issue === "low_level"
                  ? "We can hear you, but you're arriving quietly enough to get buried in the mix. Raise the input gain in your system sound settings, or move closer to the mic, until your loudest peaks reach the green band."
                  : "Sing or play at your loudest. Aim for the peaks to sit in the green band, without touching the red."}
            </p>

            <div className="relative h-6 w-full overflow-hidden rounded bg-neutral-800">
              {/* Red zone marker at -3 dBFS. */}
              <div
                className="absolute inset-y-0 z-10 w-px bg-white/40"
                style={{ left: `${dbToPercent(-3)}%` }}
              />
              <div
                className={`h-full transition-[width] duration-75 ${
                  tooHot ? "bg-red-500" : "bg-emerald-500"
                }`}
                style={{ width: `${pct}%` }}
              />
              {/* Peak hold. */}
              <div
                className="absolute inset-y-0 z-10 w-0.5 bg-white"
                style={{ left: `${holdPct}%` }}
              />
            </div>

            <div className="flex justify-between text-xs tabular-nums text-white/50">
              <span>{FLOOR_DB} dB</span>
              <span>
                {Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dBFS` : "silence"}
              </span>
              <span>0 dB</span>
            </div>

            {clipping ? (
              <div className="flex items-start gap-2 rounded bg-red-500/15 px-3 py-2 text-sm text-red-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Clipping right now</p>
                  <p className="text-red-200/80">
                    Lower your input gain in your system sound settings, or move
                    back from the mic.
                  </p>
                </div>
              </div>
            ) : noSignal ? (
              <div className="rounded bg-white/5 px-3 py-2 text-sm text-white/60">
                Not hearing anything yet — sing or play, and the meter will move.
              </div>
            ) : tooQuiet ? (
              <div className="rounded bg-yellow-500/15 px-3 py-2 text-sm text-yellow-200">
                Very quiet — raise your input gain, or move closer to the mic.
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {everClipped
                    ? "No clipping now. Try your loudest passage again to confirm."
                    : "Level looks good."}
                </p>
              </div>
            )}

            <p className="text-xs text-white/40">
              Input gain is a system setting — it can&apos;t be changed from the
              browser. Adjust it in your OS sound settings while watching this
              meter.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
