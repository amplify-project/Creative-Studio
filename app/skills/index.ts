/**
 * Skill registry — the SINGLE place where the app declares the actions
 * AI assistants are allowed to suggest. Adding a new actionable
 * capability is a one-entry change here; everything else (bus, UI,
 * listener, manifest publisher) stays untouched.
 *
 * Conventions:
 * - Names use `domain.action` form. Stable; renames break agents.
 * - Roles list the roles that should SEE the suggestion. Server-side
 *   enforcement of the underlying mutation still happens in
 *   shared-state-agent.
 * - Handlers should be one-liners that delegate to the shared-state
 *   API. Side effects beyond shared state need a strong justification
 *   because they bypass the agent permissions check.
 */

import type { MicIssue, SkillDefinition, SkillManifestEntry } from "./types";

export const SKILLS: SkillDefinition[] = [
  {
    name: "audio.setMode",
    description:
      "Switch the room audio capture between speech-optimised mode (echo cancellation, noise suppression, AGC) and music-optimised mode (raw stereo, no processing). Use this when the dominant audio signal in the room shifts between conversation and music.",
    params: {
      mode: {
        type: "enum",
        values: ["speech", "music"] as const,
        description: "Target capture mode",
      },
    },
    roles: ["host"],
    handler: async (ctx, params) => {
      await ctx.shared.setAudioMode(params.mode as "speech" | "music");
    },
  },

  {
    name: "audio.calibrateMic",
    description:
      "Open the microphone calibration panel on the affected user's own screen, showing a live input-level meter with a clipping indicator and guidance matched to the reported issue. Suggest this to a participant whose own microphone is distorting — the fix is their system input gain or their distance from the mic, neither of which any skill can set for them. Only ever target the owner of the affected mic.",
    params: {
      participantId: {
        type: "identity",
        description: "LiveKit identity of the participant whose mic is affected",
      },
      issue: {
        type: "enum",
        values: ["clipping", "bass_boost", "low_level"] as const,
        description:
          "What the analyser detected on their mic: 'clipping' (input level too high), 'bass_boost' (too close to the mic, low end overpowering) or 'low_level' (audible but too quiet)",
      },
    },
    // Both: the host sings too, so the host's own mic can clip.
    roles: ["host", "participant"],
    personal: true,
    handler: async (ctx, params) => {
      ctx.ui.openMicCalibration(params.issue as MicIssue);
    },
  },

  {
    name: "stage.pinUser",
    description:
      "Pin a participant's video so it occupies the main stage. Use this when one participant becomes the focus of the session — soloist, presenter, the person being asked a question. The host's other mute / show / hide preferences are NOT changed.",
    params: {
      participantId: {
        type: "identity",
        description: "LiveKit identity of the participant to pin",
      },
    },
    roles: ["host"],
    handler: async (ctx, params) => {
      const targetId = params.participantId as string;
      const entities = ctx.shared.state?.entities ?? {};
      // Find the entity for this participant. Entity ids are the original
      // trackSid (not the live one after recovery), and there can be a
      // "track" or "hand-zoom" kind — we accept either.
      const match = Object.entries(entities).find(
        ([, e]: [string, any]) =>
          e?.participantId === targetId &&
          (e?.kind === "track" || e?.kind === "hand-zoom"),
      );
      if (!match) {
        console.warn(`[skill stage.pinUser] no stage entity for ${targetId}`);
        return;
      }
      const [entityId] = match;
      await ctx.shared.sendChange(
        [
          { op: "replace", path: "/ui/layout", value: "pin" },
          { op: "add", path: "/ui/pinnedVideo", value: entityId },
        ],
        { reason: `skill stage.pinUser ${targetId}` },
      );
    },
  },

  {
    name: "stage.muteAll",
    description:
      "Mute every visible participant's audio. Use sparingly — usually when noise/echo is making the room unusable and the host wants a hard reset.",
    params: {},
    roles: ["host"],
    handler: async (ctx) => {
      const entities = ctx.shared.state?.entities ?? {};
      const changes: Record<string, { muted: boolean }> = {};
      Object.entries(entities).forEach(([id, ent]: [string, any]) => {
        if (ent.visible) changes[id] = { muted: true };
      });
      if (Object.keys(changes).length > 0) {
        await ctx.shared.setMultiplePlayback(changes);
      }
    },
  },

  {
    name: "stage.unmuteAll",
    description:
      "Unmute every visible participant's audio. Use after a muteAll when the room is ready to talk again.",
    params: {},
    roles: ["host"],
    handler: async (ctx) => {
      const entities = ctx.shared.state?.entities ?? {};
      const changes: Record<string, { muted: boolean }> = {};
      Object.entries(entities).forEach(([id, ent]: [string, any]) => {
        if (ent.visible) changes[id] = { muted: false };
      });
      if (Object.keys(changes).length > 0) {
        await ctx.shared.setMultiplePlayback(changes);
      }
    },
  },

  {
    name: "stage.layoutGrid",
    description:
      "Switch the stage layout to grid view. Use when the previous focus is no longer relevant (soloist finished, presentation ended, etc.).",
    params: {},
    roles: ["host"],
    handler: async (ctx) => {
      await ctx.shared.setLayout("grid", null);
    },
  },
];

/** Manifest = registry minus handlers. Published to shared state so
 *  Python agents can read it via shared-state-agent. */
export function buildSkillManifest(): SkillManifestEntry[] {
  return SKILLS.map(({ name, description, params, roles, personal }) => ({
    name, description, params, roles, ...(personal ? { personal } : {}),
  }));
}

/** Look up by name. O(n) but n is tiny — < 50 skills realistically. */
export function findSkill(name: string): SkillDefinition | undefined {
  console.log("SKILLS",SKILLS);
  return SKILLS.find((s) => s.name === name);
}
