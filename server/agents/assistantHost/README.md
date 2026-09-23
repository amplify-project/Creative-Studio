# assistant-host

One LiveKit worker that loads every Python plugin in `plugins/` and
turns them into in-room AI assistants that can suggest actions to the
host via the suggestion bus.

Adding a new assistant = adding **one file** in `plugins/`. No edits to
core, no changes to `ROOM_AGENTS`, no extra Dockerfile.

## How to add a plugin

1. Copy `plugins/example_layout_helper.py` to a new file.
2. Rename the class. Set `name` (used as `source` on the toast) and
   `description`.
3. Implement any of these hooks (all optional, all async):

   ```python
   async def on_start(self) -> None: ...
   async def on_state(self, state: dict) -> None: ...
   async def on_data(self, payload: dict, topic: str, sender_identity: str) -> None: ...
   async def on_tick(self) -> None: ...  # every 5 s
   ```

4. To propose an action, call:

   ```python
   await self.ctx.suggest(
       title="Music detected — switch to music mode?",
       skill="audio.setMode",
       args={"mode": "music"},
       dedup_key="music-mode-switch",
       ttl_ms=15000,
       severity="suggestion",  # or "info" / "alert"
   )
   ```

5. Restart the host (`docker compose restart assistant-host` or local
   `python3 assistant_host.py dev`). The plugin is now live.

## Reading shared state

`self.ctx.state` returns the current best-known shared state mirror.
`self.ctx.skills.all()` returns the published skills manifest. The host
asks for an initial snapshot on connect, then keeps the mirror updated
from `state/change` patches.

## Saturation protection (why your suggestion might not appear)

`ctx.suggest()` enforces, in order:

| Layer | What it blocks | Default |
|---|---|---|
| Manifest | Unknown skill names. Drops at the source instead of polluting the data channel. | — |
| Per-dedup-key cooldown | Re-fires of the same `dedup_key` within the cooldown window. | 30 s |
| Per-plugin token bucket | Sustained spam from one plugin. | burst 3, ~4/min |
| Global token bucket | All plugins together. | burst 8, ~6/min |
| Circuit breaker | A plugin that keeps tripping limits or crashing. After 20 issues in 60 s, the plugin is suspended for 5 minutes. | — |

Override the per-plugin ceiling on the subclass:

```python
class MyAlerter(AssistantPlugin):
    name = "my-alerter"
    max_per_minute = 6     # raise per-plugin steady-state
    burst_capacity = 4     # raise burst
    dedup_cooldown_sec = 60.0
```

Every minute the host logs a health line per plugin:

```
my-alerter ok  sent=12  drop[rate=0 cooldown=3 manifest=0 val=0]
```

`OPEN` instead of `ok` means the circuit breaker has tripped.

## What plugins MUST NOT do

- Don't touch `room.local_participant.publish_data` directly. Go
  through `ctx.suggest`; otherwise you bypass the rate limit and the
  global limiter loses sight of you.
- Don't `await asyncio.sleep(...)` in `on_state` / `on_data`. Those are
  hot paths called once per message. Long-running work goes in
  `on_tick` or a task you spawn from `on_start`.
- Don't catch and silently swallow exceptions in your own logic. Let
  them propagate — the host wraps every hook in try/except and counts
  the exception toward the breaker, which is the signal a dev needs to
  see when something is wrong.

## Local dev

```bash
cd server/agents/assistantHost
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 assistant_host.py dev
```

The LiveKit dispatcher will start this worker once `app/api/token/route.ts`
includes `assistant-host` in `ROOM_AGENTS`.
