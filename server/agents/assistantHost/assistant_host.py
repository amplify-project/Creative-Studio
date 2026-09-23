#!/usr/bin/env python3
"""
assistant-host — one LiveKit worker that runs N suggestion plugins.

This is the runtime side of the assistant-suggestions system documented
in `docs/llm/07-assistant-suggestions.md`. Plugins live in `plugins/`
and are discovered at startup. Adding a new assistant capability is one
new file in `plugins/`, no edits anywhere else.

What this file does, in order:

  1. Connects to the room and requests a state snapshot so we know what
     skills are available before any plugin starts.
  2. Walks `plugins/` and imports every `*.py` that defines a subclass of
     `AssistantPlugin`. Each subclass is instantiated once with its own
     PluginContext and runtime (rate limiter, circuit breaker).
  3. Routes data packets and state updates to every interested plugin,
     wrapping each call in try/except so one bad plugin can't kill the
     loop.
  4. Periodically logs aggregate counters (sent / dropped per plugin)
     and the current state of every circuit breaker. This is the
     dashboard a dev uses to spot a plugin that's misbehaving.

Why a single worker instead of one per assistant: each new plugin used
to mean a new agent, new Dockerfile, new entry in ROOM_AGENTS. That
made experimenting with assistants expensive. With this host the cost
is one file. The tradeoff — a misbehaving plugin can disturb the
process — is mitigated by the rate-limit + circuit-breaker layers in
the SDK.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import logging
import multiprocessing
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    RoomOutputOptions,
    WorkerOptions,
    WorkerPermissions,
    cli,
)

from creativestudio_assistant import (
    STATE_TOPIC,
    SUGGESTIONS_TOPIC,
    AssistantPlugin,
    PluginContext,
    PluginRuntime,
    SkillManifest,
    build_runtime,
    encode_suggestion,
    make_global_limiter,
)

# ---------------------------------------------------------------------------
# Logging & env
# ---------------------------------------------------------------------------

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# Only the worker process prints. LiveKit runs every job in a child process
# (named "job_proc") that re-imports this module, and that child already
# forwards its records to the worker, which prints them. Adding a handler here
# too made every job line print twice — once locally in the child, once in the
# worker.
#
# The child still needs the level: without it the root logger falls back to
# WARNING and INFO records would be dropped before they reach the worker. Set
# the level there, just not a handler. Keep this split when touching logging.
if multiprocessing.current_process().name == "MainProcess":
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )
else:
    logging.getLogger().setLevel(LOG_LEVEL)

logger = logging.getLogger("assistant_host")
load_dotenv(".env.local")

AGENT_IDENTITY = "assistant-host"
PLUGINS_DIR = Path(__file__).parent / "plugins"
TICK_INTERVAL_SEC = 5.0
HEALTH_LOG_INTERVAL_SEC = 60.0


# ---------------------------------------------------------------------------
# Plugin discovery
# ---------------------------------------------------------------------------


def discover_plugins() -> list[type[AssistantPlugin]]:
    """Import every `*.py` in plugins/ and return AssistantPlugin subclasses.

    Errors in one file MUST NOT abort startup — that would make a typo in
    a brand-new plugin take down all the others. We log and skip.
    """
    if not PLUGINS_DIR.exists():
        logger.warning("plugins/ directory missing at %s", PLUGINS_DIR)
        return []

    classes: list[type[AssistantPlugin]] = []
    for path in sorted(PLUGINS_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        mod_name = f"plugins.{path.stem}"
        try:
            spec = importlib.util.spec_from_file_location(mod_name, path)
            if spec is None or spec.loader is None:
                logger.warning("could not build spec for %s", path)
                continue
            module = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = module
            spec.loader.exec_module(module)
        except Exception:
            logger.exception("failed to import plugin %s", path.name)
            continue

        for _, obj in inspect.getmembers(module, inspect.isclass):
            if (
                issubclass(obj, AssistantPlugin)
                and obj is not AssistantPlugin
                and obj.__module__ == mod_name
            ):
                if not obj.name:
                    logger.warning(
                        "plugin class %s.%s has empty `name`, skipping",
                        path.name,
                        obj.__name__,
                    )
                    continue
                classes.append(obj)
                logger.info("discovered plugin %s (%s)", obj.name, path.name)

    return classes


# ---------------------------------------------------------------------------
# State mirror
# ---------------------------------------------------------------------------


class StateMirror:
    """Local copy of shared state so plugins don't have to re-implement
    snapshot + patch handling. Updated as state messages arrive.

    Patch application uses a small built-in applier (add/replace/remove
    only) instead of the `jsonpatch` library — we don't need full RFC
    6902 here and pulling jsonpatch + jsonpointer into the container was
    causing silent import failures under `pip install --no-deps`.
    """

    def __init__(self):
        self._state: dict[str, Any] = {}

    def view(self) -> dict[str, Any]:
        return self._state

    def apply_snapshot(self, snapshot: dict[str, Any]):
        if isinstance(snapshot, dict):
            self._state = snapshot

    def apply_layout_snapshot(self, payload: dict[str, Any]):
        """Merge a flat layout_snapshot payload into the mirror.

        Besides the formal state/snapshot + state/change protocol of the
        shared-state-agent, the host page also publishes condensed
        `{type:"event", name:"layout_snapshot", payload:{...}}`
        messages with `layout` and `entities` at the root. We normalise
        them into the same shape plugins already see (`ui.layout`,
        `entities`) so plugin authors only learn one schema.

        We DON'T replace the whole state here — formal snapshot data
        (notably `skills` from the manifest) must survive.
        """
        if not isinstance(payload, dict):
            return
        ui = self._state.setdefault("ui", {})
        if "layout" in payload:
            ui["layout"] = payload["layout"]
        if "pinnedVideo" in payload:
            ui["pinnedVideo"] = payload["pinnedVideo"]
        if "spotlight" in payload:
            ui["spotlight"] = payload["spotlight"]
        if isinstance(payload.get("entities"), dict):
            self._state["entities"] = payload["entities"]
        if "version" in payload:
            self._state["version"] = payload["version"]

    def apply_change(self, diff: list[dict[str, Any]]):
        if not isinstance(diff, list) or not diff:
            return
        new_state = json.loads(json.dumps(self._state))  # cheap deep-copy
        try:
            for op in diff:
                self._apply_op(new_state, op)
        except Exception:
            logger.warning(
                "state patch failed — will re-sync on next snapshot (op=%r)",
                diff,
            )
            return
        self._state = new_state

    @staticmethod
    def _apply_op(target: Any, op: dict[str, Any]) -> None:
        kind = op.get("op")
        if kind not in ("add", "replace", "remove"):
            return  # unsupported op — ignore silently, we're a read mirror
        path = (op.get("path") or "").lstrip("/")
        segs = [s for s in path.split("/") if s]
        if not segs:
            return
        ref = target
        for s in segs[:-1]:
            if isinstance(ref, list):
                ref = ref[int(s)]
                continue
            if not isinstance(ref, dict) or s not in ref:
                if kind == "remove":
                    return  # nothing to remove on a missing path
                ref[s] = {}
            ref = ref[s]
        leaf = segs[-1]
        if kind in ("add", "replace"):
            if isinstance(ref, list):
                if leaf == "-":
                    ref.append(op.get("value"))
                else:
                    idx = int(leaf)
                    if kind == "add":
                        ref.insert(idx, op.get("value"))
                    else:
                        ref[idx] = op.get("value")
            else:
                ref[leaf] = op.get("value")
        elif kind == "remove":
            if isinstance(ref, list):
                try:
                    del ref[int(leaf)]
                except (ValueError, IndexError):
                    pass
            elif isinstance(ref, dict) and leaf in ref:
                del ref[leaf]


# ---------------------------------------------------------------------------
# Host orchestration
# ---------------------------------------------------------------------------


class AssistantHost:
    def __init__(self, room: rtc.Room):
        self.room = room
        self.state = StateMirror()
        self.manifest = SkillManifest()
        # Starts empty on purpose. The manifest is owned by the client
        # (`state.skills`) and arrives via the snapshot the tick loop keeps
        # re-requesting while it's empty. Seeding it here would make
        # `manifest.all()` truthy, which both silences that retry and turns
        # layer-1 validation on against an inventory we made up.
        self.global_limiter = make_global_limiter()
        self.plugins: list[tuple[AssistantPlugin, PluginRuntime]] = []

    async def load_plugins(self):
        classes = discover_plugins()
        for cls in classes:
            runtime = build_runtime(cls)
            ctx = PluginContext(
                name=cls.name,
                runtime=runtime,
                global_limiter=self.global_limiter,
                manifest=self.manifest,
                state_view=self.state.view,
                publish=self._publish_suggestion,
                publish_event=self._publish_event,
            )
            try:
                plugin = cls(ctx)
            except Exception:
                logger.exception("failed to instantiate plugin %s", cls.name)
                continue
            self.plugins.append((plugin, runtime))

        logger.info("loaded %d plugin(s)", len(self.plugins))
        for plugin, runtime in self.plugins:
            await self._invoke(plugin, runtime, "on_start")

    async def _publish_suggestion(self, payload: dict[str, Any], to: list[str] | None = None):
        # An empty list is LiveKit's own broadcast default; None is NOT accepted
        # — publish_data calls .extend() on this and raises TypeError.
        await self.room.local_participant.publish_data(
            encode_suggestion(payload),
            reliable=True,
            topic=SUGGESTIONS_TOPIC,
            destination_identities=to or [],
        )

    async def _publish_event(self, data: bytes, topic: str, reliable: bool):
        await self.room.local_participant.publish_data(
            data,
            reliable=reliable,
            topic=topic,
        )

    async def request_snapshot(self):
        """Ask shared-state-agent for a full snapshot on the STATE topic.

        The reply (`state/snapshot`) carries the skill manifest, so this is
        how we (re)hydrate `self.manifest`. We re-issue it from the tick
        loop while the manifest is still empty: the first request at startup
        usually lands before the host has published `state.skills`, and
        `layout_snapshot` events don't carry the manifest — so without a
        retry the manifest could stay empty for the whole session and every
        suggestion would be dropped as an unknown skill.

        `replyTo` is required because we join hidden: shared-state-agent sees
        `pkt.participant is None` for our packets and would otherwise have no
        identity to unicast the snapshot back to.
        """
        await self.room.local_participant.publish_data(
            json.dumps(
                {
                    "type": "state/requestSnapshot",
                    "correlationId": f"assist-host-{uuid.uuid4().hex[:8]}",
                    "replyTo": self.room.local_participant.identity,
                }
            ).encode(),
            reliable=True,
            topic=STATE_TOPIC,
        )

    async def _invoke(
        self,
        plugin: AssistantPlugin,
        runtime: PluginRuntime,
        hook: str,
        *args,
    ):
        if runtime.breaker.is_suspended():
            return
        fn = getattr(plugin, hook, None)
        if fn is None:
            return
        try:
            await fn(*args)
        except Exception:
            tripped = runtime.breaker.record_issue(f"hook:{hook}")
            logger.exception(
                "plugin %s raised in %s%s",
                runtime.name,
                hook,
                " — circuit breaker tripped" if tripped else "",
            )

    # ---- Routing entry points (called from JobContext callbacks) ----

    async def on_state_message(self, msg: dict[str, Any]):
        logger.info("ENTRANDO A on_state_message -> TIPO RECIBIDO: %s | MSG COMPLETO: %s", msg.get("type"), msg)
        mtype = msg.get("type")
        mname = msg.get("name") # Conseguimos el nombre del evento
        
        if mtype == "state/snapshot":
            self.state.apply_snapshot(msg.get("state") or {})
            self._refresh_manifest()
        elif mtype == "state/change":
            self.state.apply_change(msg.get("diff") or [])
            self._refresh_manifest()
        elif mtype == "event" and msg.get("name") == "layout_snapshot":
            # Condensed live snapshot from the host page. Doesn't carry
            # the manifest, so no _refresh_manifest call.
            self.state.apply_layout_snapshot(msg.get("payload") or {})
        else:
            return

        snapshot = self.state.view()
        for plugin, runtime in self.plugins:
            asyncio.create_task(self._invoke(plugin, runtime, "on_state", snapshot))
    def _refresh_manifest(self):
        skills = self.state.view().get("skills")
        if isinstance(skills, list):
            self.manifest.update(skills)

    async def on_data_message(
        self, payload: dict[str, Any], topic: str, sender_identity: str
    ):
        # Don't feed our own suggestions back to plugins.
        if topic == SUGGESTIONS_TOPIC:
            return
        for plugin, runtime in self.plugins:
            asyncio.create_task(
                self._invoke(plugin, runtime, "on_data", payload, topic, sender_identity)
            )

    async def on_track_subscribed(self, track, publication, participant):
        for plugin, runtime in self.plugins:
            asyncio.create_task(
                self._invoke(plugin, runtime, "on_track_subscribed", track, publication, participant)
            )

    async def on_track_unsubscribed(self, track, publication, participant):
        for plugin, runtime in self.plugins:
            asyncio.create_task(
                self._invoke(plugin, runtime, "on_track_unsubscribed", track, publication, participant)
            )

    async def tick_loop(self):
        last_health = time.monotonic()
        while True:
            await asyncio.sleep(TICK_INTERVAL_SEC)
            # Keep asking for a snapshot until the manifest is populated.
            # The initial request usually races ahead of the host publishing
            # state.skills, and layout_snapshot events don't refresh the
            # manifest — without this it can stay empty all session.
            if not self.manifest.all():
                asyncio.create_task(self.request_snapshot())
            for plugin, runtime in self.plugins:
                asyncio.create_task(self._invoke(plugin, runtime, "on_tick"))
            if time.monotonic() - last_health >= HEALTH_LOG_INTERVAL_SEC:
                self._log_health()
                last_health = time.monotonic()

    def _log_health(self):
        if not self.plugins:
            return
        lines = ["assistant-host health:"]
        for _, runtime in self.plugins:
            status = "OPEN" if runtime.breaker.is_suspended() else "ok"
            lines.append(
                "  %-24s %s  sent=%d  drop[rate=%d cooldown=%d manifest=%d val=%d]"
                % (
                    runtime.name,
                    status,
                    runtime.sent,
                    runtime.limiter.dropped_rate,
                    runtime.limiter.dropped_cooldown,
                    runtime.dropped_manifest,
                    runtime.dropped_validation,
                )
            )
        logger.info("\n".join(lines))


# ---------------------------------------------------------------------------
# LiveKit entrypoint
# ---------------------------------------------------------------------------


class _Stub(Agent):
    """Minimal Agent because livekit-agents AgentSession.start requires one,
    but we don't need any LLM/STT behaviour — we're a pure observer."""

    def __init__(self):
        super().__init__(instructions="Observe room and route to plugins.")


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    room = ctx.room
    session = AgentSession()
    await session.start(
        agent=_Stub(),
        room=room,
        room_input_options=RoomInputOptions(
            audio_enabled=True, text_enabled=False, close_on_disconnect=False
        ),
        room_output_options=RoomOutputOptions(
            audio_enabled=False, transcription_enabled=False
        ),
    )

    host = AssistantHost(room)
    await host.load_plugins()

    @room.on("data_received")
    def _on_data(pkt: rtc.DataPacket):
        async def _handle():
            try:
                msg = json.loads(pkt.data.decode())
            except Exception:
                return
            topic = pkt.topic or ""
            sender_identity = (
                pkt.participant.identity if pkt.participant else "<unknown>"
            )
            try:
                # State updates can arrive either on the formal STATE topic
                # (state/snapshot, state/change from shared-state-agent) or
                # as `event` messages with `name: "layout_snapshot"` from
                # the host page on other topics. Route both to the state
                # handler regardless of topic.
                is_state_event = (
                    msg.get("type") == "event"
                    and msg.get("name") == "layout_snapshot"
                )
                if topic == STATE_TOPIC or is_state_event:
                    await host.on_state_message(msg)
                else:
                    await host.on_data_message(msg, topic, sender_identity)
            except Exception:
                logger.exception("routing error on topic=%s", topic)

        asyncio.create_task(_handle())

    @room.on("track_subscribed")
    def _on_track_subscribed(track: rtc.Track, publication, participant):
        logger.info("track_subscribed event: kind=%s sid=%s participant=%s", track.kind, publication.sid, participant.identity)
        asyncio.create_task(host.on_track_subscribed(track, publication, participant))

    @room.on("track_unsubscribed")
    def _on_track_unsubscribed(track: rtc.Track, publication, participant):
        asyncio.create_task(host.on_track_unsubscribed(track, publication, participant))

    # Pick up tracks that were already published before we joined.
    for participant in room.remote_participants.values():
        for publication in participant.track_publications.values():
            if publication.track is not None:
                logger.info("existing track found: kind=%s sid=%s participant=%s", publication.track.kind, publication.sid, participant.identity)
                asyncio.create_task(host.on_track_subscribed(publication.track, publication, participant))

    # Ask for an initial snapshot so the manifest is hot before any
    # plugin tries to suggest. The shared-state-agent will reply on the
    # STATE topic and our handler will populate the mirror. If this request
    # races ahead of the host's manifest publish, the tick loop keeps
    # re-requesting until state.skills arrives.
    async def _initial_snapshot():
        await asyncio.sleep(0.5)  # let join settle on the wire
        await host.request_snapshot()

    asyncio.create_task(_initial_snapshot())
    asyncio.create_task(host.tick_loop())


if __name__ == "__main__":
    opts = WorkerOptions(entrypoint_fnc=entrypoint, permissions=WorkerPermissions(
        can_publish=True,
        can_subscribe=True,
        hidden=True,),agent_name=AGENT_IDENTITY)
    opts.port = 0
    cli.run_app(opts)
