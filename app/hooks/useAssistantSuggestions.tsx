"use client";

/**
 * Assistant Suggestion bus + listener + manifest publisher.
 *
 * Three responsibilities live here on purpose — they're tightly coupled
 * and splitting them into separate files just adds import noise:
 *
 *  1. SuggestionBus (Context + provider): an in-memory queue of
 *     Suggestion objects with dedup, TTL expiry, and a cooldown after
 *     dismiss to stop the same assistant from re-suggesting the same
 *     thing 5 seconds later.
 *  2. Listener: subscribes to the `assistants/suggestions` LiveKit
 *     data-channel topic, parses incoming SuggestionMessages, resolves
 *     them against the SkillRegistry, and pushes them onto the bus.
 *  3. Manifest publisher: writes `state.skills` once per session so
 *     Python agents can discover what they're allowed to invoke.
 *
 * Adding a new assistant requires zero changes here. Adding a new skill
 * is one entry in [app/skills/index.ts].
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRoomContext } from "@livekit/components-react";
import MicCalibrationPanel from "../../components/MicCalibrationPanel";
import { SKILLS, buildSkillManifest, findSkill } from "../skills";
import type {
  MicIssue,
  Suggestion,
  SuggestionMessage,
  SuggestionSeverity,
} from "../skills/types";
import { useSharedStateContext } from "./useSharedState";

const SUGGESTIONS_TOPIC = "assistants/suggestions";
const DEFAULT_TTL_MS = 15_000;
// Dismissing is an explicit "no", so it has to outlast the server's re-offer
// interval (AUDIO_MODE_RESUGGEST_SEC, 60s) — otherwise the retry that exists to
// rescue *ignored* suggestions would immediately re-ask something the user had
// just refused, which is the nagging the whole design is trying to avoid.
const COOLDOWN_AFTER_DISMISS_MS = 300_000;
const MAX_VISIBLE = 4;          // older suggestions get dropped quietly
                                // so a malicious / chatty agent can't
                                // pile up the UI.

type SuggestionAPI = {
  suggestions: Suggestion[];
  push: (input: {
    source: string;
    title: string;
    description?: string;
    severity?: SuggestionSeverity;
    ttlMs?: number;
    dedupKey?: string;
    skill: string;
    apply: () => Promise<void>;
  }) => void;
  dismiss: (id: string) => void;
  accept: (id: string) => Promise<void>;
};

const Ctx = createContext<SuggestionAPI | null>(null);

export function useSuggestions(): SuggestionAPI {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSuggestions outside AssistantSuggestionsProvider");
  return v;
}

export function AssistantSuggestionsProvider({
  children,
  localRole,
}: {
  children: React.ReactNode;
  localRole: "host" | "participant";
}) {
  const room = useRoomContext();
  const shared = useSharedStateContext();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Local-only UI a skill handler can open on this user's screen. Lives here
  // because this provider is already the skill execution environment and is
  // mounted on both the host and participant pages.
  const [micCalIssue, setMicCalIssue] = useState<MicIssue | null>(null);
  const skillUi = useMemo(
    () => ({
      openMicCalibration: (issue: MicIssue = "clipping") => setMicCalIssue(issue),
    }),
    [],
  );
  // Track recently dismissed dedupKeys so the same suggestion can't
  // come back immediately. Map<dedupKey, expiresAt>.
  const cooldown = useRef<Map<string, number>>(new Map());

  const removeById = useCallback((id: string) => {
    setSuggestions((q) => q.filter((s) => s.id !== id));
  }, []);

  const push = useCallback<SuggestionAPI["push"]>((input) => {
    setSuggestions((q) => {
      const now = Date.now();
      // 1. Cooldown check — if this dedupKey was recently dismissed,
      //    drop silently. Prevents the "music!" spam loop.
      if (input.dedupKey) {
        const cdEnd = cooldown.current.get(input.dedupKey);
        if (cdEnd && cdEnd > now) {
          // Logged, not silent: a dropped suggestion and one that was never
          // sent look identical from the console otherwise, and telling those
          // two apart is most of debugging "why did no toast appear".
          console.info(
            `[suggestion] dropped (cooldown ${Math.round((cdEnd - now) / 1000)}s left) ` +
              `source=${input.source} key=${input.dedupKey}`,
          );
          return q;
        }
      }
      // 2. Dedup — same (source, dedupKey) already queued: drop.
      if (input.dedupKey) {
        const already = q.some(
          (s) => s.source === input.source && s.dedupKey === input.dedupKey,
        );
        if (already) {
          console.info(
            `[suggestion] dropped (already queued) source=${input.source} key=${input.dedupKey}`,
          );
          return q;
        }
      }
      // 3. Cap visible count to avoid UI overflow / abuse.
      let next = q;
      if (next.length >= MAX_VISIBLE) {
        // Drop the oldest one with no dedupKey first; if all have one,
        // just drop the head. Telemetry would be nice but minor.
        const dropIdx = next.findIndex((s) => !s.dedupKey);
        next = dropIdx >= 0 ? next.filter((_, i) => i !== dropIdx) : next.slice(1);
      }
      const entry: Suggestion = {
        id: `${input.source}-${now}-${Math.random().toString(36).slice(2, 6)}`,
        source: input.source,
        title: input.title,
        description: input.description,
        severity: input.severity ?? "suggestion",
        ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
        createdAt: now,
        dedupKey: input.dedupKey,
        skill: input.skill,
        apply: input.apply,
      };
      console.info(`[suggestion] push source=${entry.source} skill=${entry.skill} ttl=${entry.ttlMs}ms`);
      return [...next, entry];
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setSuggestions((q) => {
      const target = q.find((s) => s.id === id);
      if (target?.dedupKey) {
        cooldown.current.set(
          target.dedupKey,
          Date.now() + COOLDOWN_AFTER_DISMISS_MS,
        );
      }
      console.info(`[suggestion] dismissed id=${id} skill=${target?.skill}`);
      return q.filter((s) => s.id !== id);
    });
  }, []);

  const accept = useCallback(
    async (id: string) => {
      const target = suggestions.find((s) => s.id === id);
      if (!target) return;
      console.info(`[suggestion] accepted id=${id} skill=${target.skill}`);
      // Remove first so a slow handler can't be double-clicked.
      removeById(target.id);
      try {
        await target.apply();
      } catch (e) {
        console.error(`[suggestion] handler for ${target.skill} threw:`, e);
      }
    },
    [suggestions, removeById],
  );

  // TTL expiry sweep. Single rAF-cheap interval — N is small (≤ 4).
  //
  // Paused while the calibration panel is open. The panel hides the queue (see
  // `api` below), and a hidden suggestion that quietly runs out its ttl is
  // worse than an interrupting one: the user never got the chance to act on it.
  // Observed in the field — a mode-switch suggestion arrived while the panel
  // was open and expired unseen.
  useEffect(() => {
    if (suggestions.length === 0 || micCalIssue) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setSuggestions((q) => {
        const next = q.filter((s) => now - s.createdAt < s.ttlMs);
        if (next.length !== q.length) {
          q.forEach((s) => {
            if (!next.includes(s)) {
              console.info(`[suggestion] expired id=${s.id} skill=${s.skill}`);
            }
          });
        }
        return next;
      });
    }, 250);
    return () => clearInterval(interval);
  }, [suggestions.length, micCalIssue]);

  // Closing the panel restarts the clock on whatever queued up behind it, so
  // those suggestions get their full ttl on screen instead of being binned by
  // the first sweep after the panel goes away.
  const closeMicCalibration = useCallback(() => {
    setMicCalIssue(null);
    setSuggestions((q) => q.map((s) => ({ ...s, createdAt: Date.now() })));
  }, []);

  // ── Listener: assistants/suggestions topic ──────────────────────────
  useEffect(() => {
    if (!room) return;
    const onData = (
      data: Uint8Array,
      _participant: unknown,
      _kind: unknown,
      topic?: string,
    ) => {
      if (topic !== SUGGESTIONS_TOPIC) return;
      let msg: SuggestionMessage;
      try {
        msg = JSON.parse(new TextDecoder().decode(data));
      } catch (e) {
        console.warn("[suggestion] malformed payload:", e);
        return;
      }
      if (!msg?.invoke?.skill || !msg.title || !msg.source) {
        console.warn("[suggestion] missing required fields:", msg);
        return;
      }
      const skill = findSkill(msg.invoke.skill);
      if (!skill) {
        console.warn(
          `[suggestion] unknown skill "${msg.invoke.skill}" — ignoring`,
        );
        return;
      }
      // Role gate — only show suggestions for skills our role can invoke.
      if (!skill.roles.includes(localRole)) {
        return;
      }
      // Personal gate — a suggestion about someone's own mic must not render
      // on anyone else's screen. Agents target the transport too, so this only
      // fires if one broadcasts by mistake; failing closed on a missing
      // participantId is the safe direction.
      if (skill.personal) {
        const target = (msg.invoke.args as any)?.participantId;
        if (!target || target !== room.localParticipant?.identity) {
          return;
        }
      }
      push({
        source: msg.source,
        title: msg.title,
        description: msg.description,
        severity: msg.severity,
        ttlMs: msg.ttlMs,
        dedupKey: msg.dedupKey,
        skill: skill.name,
        apply: () =>
          Promise.resolve(
            skill.handler(
              { shared, room, localRole, ui: skillUi },
              msg.invoke.args as any,
            ),
          ),
      });
    };
    room.on("dataReceived", onData);
    return () => {
      room.off("dataReceived", onData);
    };
  }, [room, localRole, push, shared, skillUi]);

  // ── Manifest publish: write state.skills once we have shared state ──
  // Only the host writes (shared-state-agent enforces role server-side),
  // but the manifest itself is rendered by both for symmetry.
  const publishedRef = useRef(false);
  useEffect(() => {
    if (localRole !== "host") return;
    if (publishedRef.current) return;
    if (!shared.state) return;     // wait until we have something to merge into
    publishedRef.current = true;
    const manifest = buildSkillManifest();
    shared
      .sendChange(
        [{ op: "add", path: "/skills", value: manifest }],
        { reason: "publish skill manifest" },
      )
      .then((r) => {
        if (r !== "ok") {
          console.warn(`[suggestion] manifest publish refused (${r})`);
          publishedRef.current = false;     // retry next tick
        } else {
          console.info(
            `[suggestion] published ${manifest.length} skills to state.skills`,
          );
        }
      });
  }, [shared, localRole]);

  // While the calibration panel is open the user is doing a focused, physical
  // task — watching a meter while reaching for an OS slider. Toasts stacking
  // over that are pure interruption, and one of them is very likely the same
  // mic problem they are already in the middle of fixing. The queue keeps
  // running underneath, so anything still relevant is there afterwards and
  // anything stale has expired on its own ttl.
  const api = useMemo<SuggestionAPI>(
    () => ({ suggestions: micCalIssue ? [] : suggestions, push, dismiss, accept }),
    [suggestions, micCalIssue, push, dismiss, accept],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {micCalIssue && (
        <MicCalibrationPanel
          room={room}
          issue={micCalIssue}
          onClose={closeMicCalibration}
        />
      )}
    </Ctx.Provider>
  );
}

// Re-export skill count for the doc / debug header — handy for the
// admin to confirm at a glance "8 skills published".
export const SKILL_COUNT = SKILLS.length;
