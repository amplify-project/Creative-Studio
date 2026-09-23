# AI assistant suggestions — protocol and architecture

How AI agents (LiveKit Python workers, periodic client-side analysers,
anything that observes the room and wants to propose an action) get a
human-confirmable button into the UI without anyone editing core files.

## The shape of the system

```
┌──────────────────────────────┐
│  Python LiveKit agent        │
│  detects a condition         │
└────────────┬─────────────────┘
             │ data channel topic: "assistants/suggestions"
             │ payload: SuggestionMessage JSON
             ▼
┌──────────────────────────────┐
│  AssistantSuggestionsProvider│
│  ─ parses message            │
│  ─ resolves invoke.skill     │
│  ─ enforces role gate        │
│  ─ dedupes + cooldown        │
│  ─ pushes to internal queue  │
└────────────┬─────────────────┘
             │
             ▼
┌──────────────────────────────┐
│  AssistantSuggestionStack    │
│  ─ top-right toast stack     │
│  ─ TTL progress bar          │
│  ─ Apply / Ignore buttons    │
└────────────┬─────────────────┘
             │  user clicks Apply
             ▼
┌──────────────────────────────┐
│  SKILLS[i].handler(ctx, args)│
│  → SharedStateAPI mutation   │
└──────────────────────────────┘
```

## Adding a new agent — two ways in

The protocol is just a JSON payload on the `assistants/suggestions`
data-channel topic. Anything that can publish to a LiveKit data channel
can participate. In practice you'll use one of two paths:

### Path A — plugin in the assistant-host runner (recommended)

The repo ships an `assistant-host` worker
([`server/agents/assistantHost/`](../../server/agents/assistantHost/))
that loads every `*.py` in its `plugins/` directory at startup and
gives each one a fully wired suggestion API. Adding a new assistant is
**one file**:

```python
# server/agents/assistantHost/plugins/audio_classifier.py
from creativestudio_assistant import AssistantPlugin

class AudioClassifier(AssistantPlugin):
    name = "audio-classifier"
    description = "Detects music vs speech and offers mode-switch."
    max_per_minute = 4   # optional tuning

    async def on_state(self, state):
        if state.get("ui", {}).get("audioMode") == "speech":
            await self.ctx.suggest(
                title="Music detected — switch to music mode?",
                skill="audio.setMode",
                args={"mode": "music"},
                dedup_key="audio-mode-music",
                ttl_ms=15000,
            )
```

No edits to core, no entry in `ROOM_AGENTS`, no extra Dockerfile. The
runner enforces a multi-layer rate limit + circuit breaker around every
plugin so a misbehaving file can't take down the others. See
[`server/agents/assistantHost/README.md`](../../server/agents/assistantHost/README.md)
for the full plugin contract, hook list, and saturation-protection
defaults.

### Path B — raw agent publishing the JSON itself

For agents that aren't Python or that for other reasons can't live in
the assistant-host process, the contract is just the payload on the
topic:

```python
import json
room.local_participant.publish_data(
    json.dumps({
        "source": "audio-classifier",
        "title": "Music detected — switch to music mode for better quality?",
        "ttlMs": 15000,
        "severity": "suggestion",
        "dedupKey": "audio-mode-music",
        "invoke": {
            "skill": "audio.setMode",
            "args": { "mode": "music" }
        }
    }).encode("utf-8"),
    topic="assistants/suggestions",
    reliable=True
)
```

Path B agents are responsible for their own rate limiting and
manifest-awareness — they bypass the protections built into the host
runner. Use Path A unless you have a reason not to.

### Required fields

| Field | Notes |
|---|---|
| `source` | Free-form id of the assistant. Used for telemetry and as the chip label on the toast. Keep it short. |
| `title` | One-line plain English. Shown verbatim. |
| `invoke.skill` | Must match a `name` in [`app/skills/index.ts`](../../app/skills/index.ts). Unknown skills are logged and dropped. |
| `invoke.args` | Object matching the skill's `params` schema. |

### Optional fields

| Field | Default | Use case |
|---|---|---|
| `description` | none | Second line under the title for extra context. |
| `severity` | `"suggestion"` | `"info"` / `"suggestion"` / `"alert"`. Drives the left-border colour and the source chip tint. |
| `ttlMs` | `15000` | How long the toast lingers before auto-expiring. Cap is sane; values > 60 s feel like nagging. |
| `dedupKey` | none | Coalesce repeated suggestions of the same kind. If the assistant fires every 5 s during a music passage, only one toast appears. Also enables the per-key cooldown after dismiss. |

## Adding a new skill

ONE entry in [`app/skills/index.ts`](../../app/skills/index.ts):

```ts
{
  name: "stage.muteParticipant",
  description: "Mute a single participant's audio without affecting others.",
  params: {
    participantId: { type: "identity", description: "LiveKit identity to mute" },
  },
  roles: ["host"],
  handler: async (ctx, { participantId }) => {
    const ent = Object.entries(ctx.shared.state?.entities ?? {})
      .find(([, e]: any) => e?.participantId === participantId);
    if (!ent) return;
    await ctx.shared.setEntityPlayback(ent[0], { muted: true });
  },
}
```

The manifest republish happens automatically when the host reloads — no
config change anywhere else.

## Skills currently published

See [`app/skills/index.ts`](../../app/skills/index.ts) for the source of
truth. Inventory at time of writing:

| Skill | Roles | What it does |
|---|---|---|
| `audio.setMode` | host | Switch capture between `speech` and `music`. |
| `stage.pinUser` | host | Pin a participant's video as the main stage. |
| `stage.muteAll` | host | Mute every visible participant. |
| `stage.unmuteAll` | host | Inverse of `muteAll`. |
| `stage.layoutGrid` | host | Return to grid view. |

## The manifest at `state.skills`

On host first mount the provider writes the skill manifest into
`state.skills`. Python agents that listen to shared state (via
`shared-state-agent`) can read it to know what skills are available
without hard-coding the inventory. Format:

```ts
SkillManifestEntry[] = [
  {
    name: "audio.setMode",
    description: "…",
    params: {
      mode: { type: "enum", values: ["speech", "music"], description: "…" }
    },
    roles: ["host"]
  },
  …
]
```

Agents that don't care about discovery can ignore the manifest and
hard-code the skill names they use; the listener will warn but not
crash if an unknown skill is invoked.

## Anti-spam and safety

| Concern | Mitigation |
|---|---|
| Agent fires the same suggestion every 5 s | `dedupKey` coalesces while a suggestion with the same `(source, dedupKey)` is queued. |
| User dismisses, agent re-fires immediately | 60 s cooldown per `dedupKey` after dismiss. Telemetry-only — logs `[suggestion] dismissed`. |
| Suggestion queue grows unboundedly | Hard cap at 4 visible toasts. Oldest non-keyed dropped first. |
| Malicious agent triggers privileged action | User confirmation is the gate. Agents propose; users decide. Skills tagged with `roles` are also filtered client-side so participants never see host-only suggestions. |
| Server-side enforcement of the mutation | Same as the rest of the app — `shared-state-agent` checks the participant role on the JSON-patch path. The skill `roles` field is a UX hint, not a security boundary. |
| One plugin floods the data channel | The `assistant-host` runner gives each plugin a token bucket (burst 3, ~4/min) **and** a per-`dedupKey` cooldown (30 s). All plugins share a global bucket (burst 8, ~6/min) so they can't collude past the cap. |
| One plugin keeps crashing or keeps hitting limits | Circuit breaker per plugin in the host: 20 issues in 60 s → plugin suspended for 5 minutes. Logged with `OPEN` in the per-minute health line. |

## File map

| File | Role |
|---|---|
| [`app/skills/types.ts`](../../app/skills/types.ts) | Public types: `SkillDefinition`, `SuggestionMessage`, etc. |
| [`app/skills/index.ts`](../../app/skills/index.ts) | The `SKILLS` array — single place to add new actions. |
| [`app/hooks/useAssistantSuggestions.tsx`](../../app/hooks/useAssistantSuggestions.tsx) | Bus + listener + manifest publisher in one provider. |
| [`components/AssistantSuggestionStack.tsx`](../../components/AssistantSuggestionStack.tsx) | Top-right toast stack rendering the queue. |
| [`app/host/page.tsx`](../../app/host/page.tsx) | Mounts the provider with `localRole="host"`. |
| [`app/participant/page.tsx`](../../app/participant/page.tsx) | Mounts the provider with `localRole="participant"`. |
| [`server/agents/assistantHost/`](../../server/agents/assistantHost/) | Python worker that loads suggestion plugins. One process for all plugins. |
| [`server/agents/assistantHost/creativestudio_assistant/__init__.py`](../../server/agents/assistantHost/creativestudio_assistant/__init__.py) | Plugin SDK: `AssistantPlugin` base, rate limiter, circuit breaker, manifest cache. |
| [`server/agents/assistantHost/plugins/`](../../server/agents/assistantHost/plugins/) | Drop a `*.py` here to add an assistant. |

## Things we explicitly DON'T do

### Don't let the agent execute the skill directly

The agent SUGGESTS; the user CONFIRMS. Even for "obvious" cases —
the asymmetry is what makes the system safe to extend. An agent that
auto-fires `stage.muteAll` because of one detection burst would be a
disaster. Keep the human in the loop.

### Don't expose handlers in the manifest

`state.skills` is stripped of `handler` fields. The Python side only
ever sees JSON-serialisable metadata. Avoids accidental closure
captures and makes the manifest safe to log.

### Don't let suggestions persist across page reloads

The bus is purely in-memory. Reload = empty queue. This matches the
"suggestions are time-sensitive" intuition — a suggestion that was
still relevant in 12 hours wasn't a suggestion, it was a TODO.

### Don't add an "always apply this kind of suggestion" auto-accept

Tempting feature ("yes, always switch to music mode"). Avoided
because it inverts the safety property of the system and lets an
agent silently mutate room state without confirmation. If a class of
suggestion becomes that obvious, it's a feature, not a suggestion —
implement it directly.

### Don't grow the skill list reactively per agent

The list grows for capabilities, not for assistants. Three agents that
all use `stage.pinUser` add zero skills. An agent that needs a new
action adds exactly one. This is how the cost stays low.
