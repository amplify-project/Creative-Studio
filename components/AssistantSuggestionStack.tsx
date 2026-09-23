"use client";

/**
 * Visual stack of pending Suggestion toasts. Renders into the page's shared
 * ToastLane (see components/ui/ToastLane.tsx) rather than positioning itself,
 * so it stacks with the chat and presence toasts instead of covering them —
 * which is what happened on a phone, where these cards span most of the
 * width. Last in the lane because they are the tallest.
 *
 * Each toast shows:
 *  - severity-coloured left border (info / suggestion / alert)
 *  - source name in small uppercase (so the host knows which assistant
 *    spoke)
 *  - title
 *  - optional description
 *  - Apply button → calls accept()
 *  - X button → calls dismiss() and starts the per-key cooldown
 *  - bottom progress bar showing remaining TTL
 *
 * The Suggestion logic lives in useAssistantSuggestions; this file is
 * purely presentational so the bus can be reused with a different UI
 * (e.g. inline banner instead of toasts) without rework.
 */

import { useEffect, useState } from "react";
import { Bot, Check, X } from "lucide-react";
import { useSuggestions } from "../app/hooks/useAssistantSuggestions";
import { ToastLane, LANE_ORDER } from "./ui/ToastLane";
import type { SuggestionSeverity } from "../app/skills/types";

const SEVERITY_STYLE: Record<SuggestionSeverity, { border: string; chip: string }> = {
  info:       { border: "border-l-sky-400",     chip: "bg-sky-500/15 text-sky-300" },
  suggestion: { border: "border-l-indigo-400",  chip: "bg-indigo-500/15 text-indigo-300" },
  alert:      { border: "border-l-amber-400",   chip: "bg-amber-500/15 text-amber-300" },
};

export default function AssistantSuggestionStack() {
  const { suggestions, accept, dismiss } = useSuggestions();
  if (suggestions.length === 0) return null;
  return (
    <ToastLane order={LANE_ORDER.assistant}>
      <div className="flex flex-col gap-2 pointer-events-none w-80 max-w-full">
        {suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            source={s.source}
            title={s.title}
            description={s.description}
            severity={s.severity}
            createdAt={s.createdAt}
            ttlMs={s.ttlMs}
            onAccept={() => accept(s.id)}
            onDismiss={() => dismiss(s.id)}
          />
        ))}
      </div>
    </ToastLane>
  );
}

function SuggestionCard({
  source,
  title,
  description,
  severity,
  createdAt,
  ttlMs,
  onAccept,
  onDismiss,
}: {
  source: string;
  title: string;
  description?: string;
  severity: SuggestionSeverity;
  createdAt: number;
  ttlMs: number;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const style = SEVERITY_STYLE[severity];
  // Local tick for the progress bar — keep it cheap (every 100 ms,
  // O(visible suggestions)).
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, ttlMs - (Date.now() - createdAt)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, ttlMs - (Date.now() - createdAt)));
    }, 100);
    return () => clearInterval(id);
  }, [createdAt, ttlMs]);
  const pct = (remaining / ttlMs) * 100;

  return (
    <div
      className={`pointer-events-auto bg-zinc-900/95 backdrop-blur-sm border border-white/10 border-l-4 ${style.border} rounded-xl shadow-2xl overflow-hidden`}
    >
      <div className="p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-zinc-400" />
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${style.chip}`}
            title={`source: ${source}`}
          >
            {source}
          </span>
          <button
            onClick={onDismiss}
            className="ml-auto text-zinc-500 hover:text-zinc-200 transition-colors p-0.5"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-white text-sm leading-snug">{title}</p>
        {description && (
          <p className="text-xs text-zinc-400 leading-snug">{description}</p>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onDismiss}
            className="px-2.5 py-1 text-xs text-zinc-400 hover:text-white transition-colors"
          >
            Ignore
          </button>
          <button
            onClick={onAccept}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            Apply
          </button>
        </div>
      </div>
      {/* TTL countdown — full width bar at the bottom, draining left to
        * right so it reads as "time running out". */}
      <div className="h-0.5 bg-white/5">
        <div
          className="h-full bg-indigo-400/60 transition-[width] duration-100 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
