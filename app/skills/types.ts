/**
 * Skill / Suggestion types.
 *
 * A "skill" is an action the app exposes to AI assistants. Each skill
 * declares its name, description, parameter schema and handler. The list
 * of skills is published to shared state (`state.skills`) so any agent
 * connected to the room can discover what it's allowed to suggest.
 *
 * A "suggestion" is what an agent emits over the data channel
 * (`assistants/suggestions` topic) to ask the user to invoke a skill.
 * The user sees the suggestion as a dismissable toast with countdown.
 * If they accept, the matching skill's handler runs with the agent's
 * proposed args. If they ignore for `ttlMs`, the suggestion expires.
 *
 * The intent is that adding a new agent costs zero core changes as long
 * as it uses existing skills; new actionable capability adds one entry
 * to `app/skills/index.ts`.
 */

import type { SharedStateAPI } from "../hooks/useSharedState";

/** Mic problems the calibration panel has copy for. Mirrors
 *  ACTIONABLE_DISTORTIONS in the assistant host's audio_analysis plugin. */
export type MicIssue = "clipping" | "bass_boost" | "low_level";

/** The slice of the app API exposed to skill handlers. Currently the
 *  full SharedStateAPI plus a room reference; expand as needed.
 *  Centralised so handlers don't reach into random hooks. */
export interface SkillContext {
  shared: SharedStateAPI;
  room: any;          // LiveKit Room — kept loose so skills can reach
                      // localParticipant etc. without importing the SDK
                      // type here (avoids circular import noise).
  localRole: "host" | "participant";
  /** Local-only UI a skill may open on the invoking user's own screen.
   *  Deliberately narrow: these mutate nothing shared, so there is nothing
   *  for the agent permission model to guard — the alternative was handlers
   *  reaching into random hooks or firing window events, which is what the
   *  registry's "no side effects beyond shared state" rule exists to stop. */
  ui: {
    openMicCalibration: (issue?: MicIssue) => void;
  };
}

export type ParamSchema =
  | { type: "string"; description?: string }
  | { type: "number"; description?: string; min?: number; max?: number }
  | { type: "boolean"; description?: string }
  | { type: "enum"; values: readonly string[]; description?: string }
  | { type: "identity"; description?: string };   // participant identity

export interface SkillDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable name in `domain.action` form. Agents reference this in
   *  `invoke.skill`. Renaming is a breaking change for any deployed
   *  agent — treat the name as a versioned API. */
  name: string;
  description: string;
  /** Loose schema — runtime validation is done in the listener with
   *  these descriptors. Designed to be JSON-serialisable so the manifest
   *  can travel as shared state to Python agents that don't have access
   *  to TypeScript types. */
  params: Record<string, ParamSchema>;
  /** Roles that can have this skill SHOWN to them. Server-side
   *  enforcement (via shared-state-agent) is still the source of truth
   *  for state-mutating actions; this is a client-side hint. */
  roles: ("host" | "participant")[];
  /** True when the suggestion is ABOUT the recipient rather than about
   *  someone else — "your mic is clipping" vs "pin that participant".
   *  The listener then shows it only to the identity in
   *  `args.participantId`. Agents are expected to target the transport
   *  too (`to=[identity]`); this is the local check that keeps a plugin
   *  which forgets from announcing someone's mic problem to the room. */
  personal?: boolean;
  /** What runs when the user accepts the suggestion. Should be
   *  idempotent / safe to call again — the suggestion bus dedupes by
   *  key but a delayed click on a stale toast could still hit twice. */
  handler: (ctx: SkillContext, params: P) => Promise<void> | void;
}

/** Manifest published to shared state. Stripped of handlers — the
 *  Python side only sees the metadata it needs to know what to invoke. */
export interface SkillManifestEntry {
  name: string;
  description: string;
  params: Record<string, ParamSchema>;
  roles: ("host" | "participant")[];
  /** Present and true when the agent must address the suggestion to the
   *  identity in `args.participantId` instead of broadcasting it. */
  personal?: boolean;
}

/** Severity drives badge color and (optionally) toast position. `info`
 *  is the default; `alert` is used by assistants that need attention
 *  (e.g. "a participant raised their hand and you didn't notice"). */
export type SuggestionSeverity = "info" | "suggestion" | "alert";

/** What an agent emits over the data channel. Strict-ish so a malformed
 *  message can be rejected cleanly by the listener. */
export interface SuggestionMessage {
  /** Free-form identifier of the assistant. Used for telemetry,
   *  dedup-by-source, and to filter spam. */
  source: string;
  title: string;
  description?: string;
  severity?: SuggestionSeverity;
  ttlMs?: number;
  /** When set, a new suggestion with the same (source, dedupKey) while
   *  one is already queued is silently dropped. Also drives the
   *  per-key cooldown after dismiss. */
  dedupKey?: string;
  invoke: {
    skill: string;
    args: Record<string, unknown>;
  };
}

/** Internal queue entry. Includes runtime metadata the message itself
 *  doesn't have. */
export interface Suggestion {
  id: string;
  source: string;
  title: string;
  description?: string;
  severity: SuggestionSeverity;
  ttlMs: number;
  createdAt: number;     // Date.now() at push time
  dedupKey?: string;
  apply: () => Promise<void>;
  /** Set when the suggestion was created from a SuggestionMessage so
   *  the UI can show the skill name in a tooltip (debugging) and the
   *  bus can log a coherent telemetry line. */
  skill: string;
}
