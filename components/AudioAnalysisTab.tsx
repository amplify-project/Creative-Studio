"use client";

/**
 * Host-facing view of what the audio analyser sees, per participant.
 *
 * Reads the `audio/analysis` events the assistant-host plugin already
 * broadcasts (one per ~960ms window per audio track) — no server round-trip
 * and no polling. The plugin published these from the start and nothing had
 * ever consumed them.
 *
 * This is observation, not action. It deliberately shows the raw state
 * (content class, level, detected issues) rather than only the problems the
 * agent decided were worth interrupting someone about: the analyser's
 * thresholds are still being calibrated, and you cannot calibrate what you
 * cannot see. The suggestion path is gated off server-side meanwhile
 * (ENABLE_DISTORTION_SUGGESTIONS).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRemoteParticipants, useLocalParticipant } from "@livekit/components-react";
import { AlertTriangle, Mic, MicOff } from "lucide-react";
import type { TrackPublication } from "livekit-client";
import { useCommandBus } from "../app/hooks/useCmdBus";

// Events stop arriving when a track goes silent — the analyser drops silent
// windows rather than classifying them — so a reading has to be allowed to go
// stale rather than being treated as current forever.
const STALE_AFTER_MS = 4000;

type AudioAnalysis = {
  track_id: string;
  content_type: string;
  distortion: boolean;
  distortion_type: { type: string; confidence: number } | null;
  duration: number;
  rms_dbfs?: number;
  issues?: string[];
  ts: string;
};

type Reading = AudioAnalysis & { receivedAt: number };

const ISSUE_LABEL: Record<string, string> = {
  clipping: "Clipping",
  bass_boost: "Boomy",
  low_level: "Too quiet",
};

const CONTENT_LABEL: Record<string, string> = {
  singing: "Singing",
  speech: "Speech",
  instrumental: "Instrumental",
  other: "Other",
};

/** Map the -60..0 dBFS range onto a meter width. */
function levelPercent(dbfs: number | undefined): number {
  if (dbfs == null || !Number.isFinite(dbfs)) return 0;
  return Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
}

export default function AudioAnalysisTab() {
  const { subscribe } = useCommandBus();
  const remotes = useRemoteParticipants();
  const { localParticipant } = useLocalParticipant();

  // track sid -> latest reading.
  const [readings, setReadings] = useState<Map<string, Reading>>(new Map());
  // Re-render on a timer so "stale" state appears without a new event.
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const off = subscribe("audio/analysis", (args: AudioAnalysis) => {
      if (!mounted.current || !args?.track_id) return;
      setReadings((prev) => {
        const next = new Map(prev);
        next.set(args.track_id, { ...args, receivedAt: Date.now() });
        return next;
      });
    });
    return () => {
      mounted.current = false;
      off();
    };
  }, [subscribe]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // The event carries a track sid; the panel needs a person. Only the client
  // can join the two, since the plugin never sees display names.
  const rows = useMemo(() => {
    const everyone = [
      ...(localParticipant ? [{ p: localParticipant, isLocal: true }] : []),
      ...remotes.map((p) => ({ p, isLocal: false })),
    ];
    return everyone.map(({ p, isLocal }) => {
      // Local and remote publications are different classes, so the union of
      // their iterators has no common type. Narrowed to the base type both
      // extend — this only ever reads sid and mute state.
      const pubs = Array.from(
        p.audioTrackPublications.values() as Iterable<TrackPublication>,
      );
      const reading = pubs
        .map((pub) => readings.get(pub.trackSid))
        .find((r) => r != null);
      const muted = pubs.length === 0 || pubs.every((pub) => pub.isMuted);
      return {
        key: p.identity,
        name: p.name || p.identity,
        isLocal,
        muted,
        reading,
        stale: reading ? Date.now() - reading.receivedAt > STALE_AFTER_MS : true,
      };
    });
  }, [remotes, localParticipant, readings]);

  const analysing = rows.some((r) => r.reading && !r.stale);

  return (
    <div className="flex-1 flex flex-col gap-3 p-4 overflow-y-auto">
      <div>
        <p className="text-xs font-semibold text-zinc-300">Audio analysis</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">
          What the analyser hears on each mic, updated about once a second.
        </p>
      </div>

      {!analysing && (
        <div className="rounded bg-white/5 px-3 py-2 text-[11px] text-zinc-400">
          No readings yet. The assistant must be enabled for this session, and
          the analyser stays quiet while nobody is making sound.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const r = row.reading;
          const issues = (r?.issues ?? []).filter((i) => !row.stale);
          return (
            <div
              key={row.key}
              className="rounded border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {row.muted ? (
                    <MicOff size={12} className="shrink-0 text-zinc-600" />
                  ) : (
                    <Mic size={12} className="shrink-0 text-zinc-400" />
                  )}
                  <span className="truncate text-[12px] text-zinc-200">
                    {row.name}
                    {row.isLocal && (
                      <span className="text-zinc-500"> (you)</span>
                    )}
                  </span>
                </div>
                <span
                  className={`shrink-0 text-[10px] tabular-nums ${
                    row.stale ? "text-zinc-600" : "text-zinc-400"
                  }`}
                >
                  {r && !row.stale
                    ? CONTENT_LABEL[r.content_type] ?? r.content_type
                    : row.muted
                      ? "muted"
                      : "quiet"}
                </span>
              </div>

              {/* Level meter. Greyed out once the reading goes stale, rather
                  than dropped, so the last known level stays readable. */}
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-neutral-800">
                <div
                  className={`h-full transition-[width] duration-300 ${
                    row.stale
                      ? "bg-zinc-700"
                      : issues.includes("clipping")
                        ? "bg-red-500"
                        : issues.includes("low_level")
                          ? "bg-yellow-500"
                          : "bg-emerald-500"
                  }`}
                  style={{ width: `${levelPercent(r?.rms_dbfs)}%` }}
                />
              </div>

              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {issues.length > 0 ? (
                    issues.map((i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200"
                      >
                        <AlertTriangle size={9} />
                        {ISSUE_LABEL[i] ?? i}
                      </span>
                    ))
                  ) : (
                    <span className="text-[10px] text-zinc-600">
                      {r && !row.stale ? "No issues" : "—"}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
                  {r?.rms_dbfs != null && !row.stale
                    ? `${r.rms_dbfs.toFixed(0)} dBFS`
                    : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
