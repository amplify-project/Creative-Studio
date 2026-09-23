"""
creativestudio_assistant — small SDK that lets a developer ship a new
in-room assistant by writing ONE Python file. The runner
(`assistant_host.py`) does the LiveKit plumbing; this module is the
public surface a plugin author touches.

Design notes worth knowing before changing this file:

  * The SDK is intentionally minimal. If something belongs in a plugin
    (model loading, domain logic, business rules) it must NOT live here.
    Keep this module to plumbing + safety rails.

  * Suggestion safety is enforced in THREE layers, in order:
      1. Manifest validation: the skill name must be in the manifest the
         client published on shared state. Unknown skills are dropped at
         the source instead of polluting the data channel.
      2. Per-plugin rate limiter: token bucket + per-dedupKey cooldown.
         Prevents one bad plugin from spamming the host.
      3. Global limiter: shared across plugins. Prevents collective spam
         even if N plugins each stay under their per-plugin budget.
    Failures in any layer are counted toward the circuit breaker, which
    will fully suspend a plugin if it crosses a threshold of issues.

  * Plugin handlers are async. The runner wraps each invocation in
    try/except and feeds the result to the circuit breaker.

  * No state is persisted. Plugins are pure runtime observers; if you
    need durable memory put it in your own plugin code.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, ClassVar, Optional

logger = logging.getLogger("creativestudio_assistant")

SUGGESTIONS_TOPIC = "assistants/suggestions"
STATE_TOPIC = "state"

# Global limiter defaults. These tune the worst case across ALL plugins;
# the per-plugin limiter handles individual misbehaviour.
GLOBAL_CAPACITY = 8
GLOBAL_REFILL_PER_SEC = 1.0 / 10.0  # ~6/min steady, burst of 8

# Per-plugin defaults. A plugin can raise its own ceiling by overriding
# the class variables on its subclass.
DEFAULT_PER_PLUGIN_CAPACITY = 3
DEFAULT_PER_PLUGIN_REFILL_PER_SEC = 1.0 / 15.0  # ~4/min steady
DEFAULT_DEDUP_COOLDOWN_SEC = 30.0

# Circuit breaker — count of "issues" in a rolling window before we
# suspend a plugin. Issues include: handler exceptions, rate-limit drops,
# unknown-skill drops, validation failures.
CB_ISSUE_THRESHOLD = 20
CB_ISSUE_WINDOW_SEC = 60.0
CB_SUSPEND_SEC = 300.0


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


class _TokenBucket:
    """Standard token bucket. Not thread-safe; we're single-event-loop."""

    def __init__(self, capacity: float, refill_per_sec: float):
        self.capacity = float(capacity)
        self.refill_per_sec = float(refill_per_sec)
        self.tokens = float(capacity)
        self.last = time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(
            self.capacity, self.tokens + (now - self.last) * self.refill_per_sec
        )
        self.last = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


@dataclass
class _PluginLimiter:
    capacity: float
    refill_per_sec: float
    dedup_cooldown_sec: float
    bucket: _TokenBucket = field(init=False)
    last_send_by_key: dict[str, float] = field(default_factory=dict)
    dropped_rate: int = 0
    dropped_cooldown: int = 0

    def __post_init__(self):
        self.bucket = _TokenBucket(self.capacity, self.refill_per_sec)

    def check(self, dedup_key: Optional[str]) -> tuple[bool, Optional[str]]:
        if dedup_key:
            last = self.last_send_by_key.get(dedup_key, 0.0)
            if time.monotonic() - last < self.dedup_cooldown_sec:
                self.dropped_cooldown += 1
                return False, "cooldown"
        if not self.bucket.take():
            self.dropped_rate += 1
            return False, "rate-limit"
        if dedup_key:
            self.last_send_by_key[dedup_key] = time.monotonic()
        return True, None


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


@dataclass
class _CircuitBreaker:
    threshold: int = CB_ISSUE_THRESHOLD
    window_sec: float = CB_ISSUE_WINDOW_SEC
    suspend_sec: float = CB_SUSPEND_SEC
    issues: list[float] = field(default_factory=list)
    suspended_until: float = 0.0

    def is_suspended(self) -> bool:
        return time.monotonic() < self.suspended_until

    def record_issue(self, reason: str) -> bool:
        """Returns True if the breaker just tripped on this call."""
        now = time.monotonic()
        cutoff = now - self.window_sec
        self.issues = [t for t in self.issues if t >= cutoff]
        self.issues.append(now)
        if len(self.issues) >= self.threshold and not self.is_suspended():
            self.suspended_until = now + self.suspend_sec
            return True
        return False

    def record_ok(self):
        # Successful sends slowly drain the issue counter so a plugin
        # that recovers gets credit for it.
        if self.issues:
            self.issues.pop(0)


# ---------------------------------------------------------------------------
# Manifest cache — what the client published on state.skills
# ---------------------------------------------------------------------------


class SkillManifest:
    """Caches the latest skill manifest from shared state.

    Plugins use this for early validation; it is also used by the runner
    so plugins can introspect what's currently available without
    duplicating the inventory.
    """

    def __init__(self):
        self._by_name: dict[str, dict[str, Any]] = {}
        self._raw: list[dict[str, Any]] = []

    def update(self, manifest: list[dict[str, Any]]):
        if not isinstance(manifest, list):
            return
        self._raw = manifest
        self._by_name = {
            entry["name"]: entry
            for entry in manifest
            if isinstance(entry, dict) and "name" in entry
        }
        logger.info(
            "manifest updated — %d skill(s) available: %s",
            len(self._by_name),
            ", ".join(sorted(self._by_name.keys())),
        )

    def has(self, skill: str) -> bool:
        return skill in self._by_name

    def get(self, skill: str) -> Optional[dict[str, Any]]:
        return self._by_name.get(skill)

    def all(self) -> list[dict[str, Any]]:
        return list(self._raw)


# ---------------------------------------------------------------------------
# Context handed to each plugin
# ---------------------------------------------------------------------------


@dataclass
class PluginRuntime:
    """Per-plugin runtime state owned by the runner. Plugins read this
    only indirectly through their `self.ctx`."""

    name: str
    limiter: _PluginLimiter
    breaker: _CircuitBreaker
    sent: int = 0
    dropped_manifest: int = 0
    dropped_validation: int = 0
    last_sent_at: float = 0.0


class PluginContext:
    """Surface area a plugin sees. Stable on purpose: extend with care.

    Plugins call `ctx.suggest(...)` and read `ctx.state` / `ctx.skills`.
    Direct LiveKit access (publish_data, room.on(...)) is intentionally
    NOT exposed — that would defeat the rate-limiting layer.
    """

    def __init__(
        self,
        name: str,
        runtime: PluginRuntime,
        global_limiter: _TokenBucket,
        manifest: SkillManifest,
        state_view: Callable[[], dict[str, Any]],
        publish: Callable[[dict[str, Any], Optional[list[str]]], Awaitable[None]],
        publish_event: Optional[Callable[[bytes, str, bool], Awaitable[None]]] = None,
    ):
        self.name = name
        self._runtime = runtime
        self._global = global_limiter
        self._publish = publish
        self._publish_event = publish_event
        self.skills = manifest
        self._state_view = state_view

    @property
    def state(self) -> dict[str, Any]:
        """Current best-known shared state. Read-only by convention."""
        return self._state_view()

    async def publish_data(
        self,
        data: bytes,
        *,
        topic: str = "cmd",
        reliable: bool = False,
    ) -> bool:
        """Publish raw data on a topic. Intended for plugins that produce
        high-frequency events (e.g. audio analysis) rather than suggestions."""
        if self._publish_event is None:
            logger.warning("[%s] publish_data unavailable — no event publisher configured", self.name)
            return False
        try:
            await self._publish_event(data, topic, reliable)
            return True
        except Exception:
            logger.exception("[%s] publish_data failed on topic=%s", self.name, topic)
            return False

    async def suggest(
        self,
        *,
        title: str,
        skill: str,
        args: Optional[dict[str, Any]] = None,
        description: Optional[str] = None,
        severity: str = "suggestion",
        ttl_ms: int = 15000,
        dedup_key: Optional[str] = None,
        to: Optional[list[str]] = None,
    ) -> bool:
        """Publish a suggestion. Returns True iff it actually went out.

        `to` is a list of participant identities. Empty or omitted broadcasts to
        the room. Pass it for anything personal — a suggestion about someone's
        own mic has no business rendering on everyone else's screen.
        """
        if self._runtime.breaker.is_suspended():
            logger.debug("[%s] suppressed (breaker open)", self.name)
            return False

        # Layer 1 — manifest validation. Only enforce when we actually have
        # a manifest. An empty manifest means we haven't received
        # state.skills yet (the snapshot request raced ahead of the host
        # publishing the manifest), and dropping every suggestion in that
        # window is worse than letting the client-side listener do the
        # authoritative validation. Per docs/llm/07-assistant-suggestions.md
        # the manifest is optional discovery, not the security boundary.
        if self.skills.all() and not self.skills.has(skill):
            self._runtime.dropped_manifest += 1
            tripped = self._runtime.breaker.record_issue("unknown-skill")
            logger.warning(
                "[%s] dropped suggestion — unknown skill %r%s",
                self.name,
                skill,
                " (breaker tripped)" if tripped else "",
            )
            return False

        # Light arg-shape sanity check. Full validation is on the host
        # side; we just refuse blatantly wrong types here so a buggy
        # plugin can't flood with garbage.
        if args is not None and not isinstance(args, dict):
            self._runtime.dropped_validation += 1
            self._runtime.breaker.record_issue("bad-args")
            logger.warning("[%s] dropped suggestion — args must be a dict", self.name)
            return False
        if severity not in ("info", "suggestion", "alert"):
            self._runtime.dropped_validation += 1
            self._runtime.breaker.record_issue("bad-severity")
            logger.warning(
                "[%s] dropped suggestion — invalid severity %r", self.name, severity
            )
            return False

        # Layer 2 — per-plugin limiter.
        ok, reason = self._runtime.limiter.check(dedup_key)
        if not ok:
            tripped = self._runtime.breaker.record_issue(reason or "limit")
            logger.info(
                "[%s] suggestion dropped by per-plugin limiter (%s)%s",
                self.name,
                reason,
                " (breaker tripped)" if tripped else "",
            )
            return False

        # Layer 3 — global limiter.
        if not self._global.take():
            self._runtime.breaker.record_issue("global-rate")
            logger.info(
                "[%s] suggestion dropped by global limiter (system saturated)",
                self.name,
            )
            return False

        payload: dict[str, Any] = {
            "source": self.name,
            "title": title,
            "severity": severity,
            "ttlMs": ttl_ms,
            "invoke": {"skill": skill, "args": args or {}},
        }
        if description:
            payload["description"] = description
        if dedup_key:
            payload["dedupKey"] = dedup_key

        try:
            await self._publish(payload, to)
        except Exception:
            self._runtime.breaker.record_issue("publish-failed")
            logger.exception("[%s] publish failed", self.name)
            return False

        self._runtime.sent += 1
        self._runtime.last_sent_at = time.monotonic()
        self._runtime.breaker.record_ok()
        logger.info(
            "[%s] suggested skill=%s args=%s to=%s%s",
            self.name,
            skill,
            args or {},
            ",".join(to) if to else "<room>",
            f" dedup={dedup_key}" if dedup_key else "",
        )
        return True


# ---------------------------------------------------------------------------
# Plugin base class
# ---------------------------------------------------------------------------


class AssistantPlugin:
    """Subclass this once per assistant. The runner discovers subclasses
    in the plugins directory at startup.

    Optional hooks:
        async def on_start(self) -> None
        async def on_state(self, state: dict) -> None
        async def on_data(self, payload: dict, topic: str, sender_identity: str) -> None
        async def on_tick(self) -> None     # called every ~5s

    Tunables (class variables):
        name: str                 # REQUIRED. Used as the suggestion `source`.
        description: str          # Short label for logs / docs.
        max_per_minute: int|None  # Override per-plugin steady-state ceiling.
        burst_capacity: int|None  # Override per-plugin burst.
        dedup_cooldown_sec: float|None
    """

    name: ClassVar[str] = ""
    description: ClassVar[str] = ""
    max_per_minute: ClassVar[Optional[int]] = None
    burst_capacity: ClassVar[Optional[int]] = None
    dedup_cooldown_sec: ClassVar[Optional[float]] = None

    def __init__(self, ctx: PluginContext):
        self.ctx = ctx

    # Default no-ops so plugins only override what they care about.
    async def on_start(self) -> None:  # pragma: no cover - hook
        pass

    async def on_state(self, state: dict[str, Any]) -> None:  # pragma: no cover - hook
        pass

    async def on_data(  # pragma: no cover - hook
        self, payload: dict[str, Any], topic: str, sender_identity: str
    ) -> None:
        pass

    async def on_tick(self) -> None:  # pragma: no cover - hook
        pass

    async def on_track_subscribed(  # pragma: no cover - hook
        self, track: Any, publication: Any, participant: Any
    ) -> None:
        pass

    async def on_track_unsubscribed(  # pragma: no cover - hook
        self, track: Any, publication: Any, participant: Any
    ) -> None:
        pass


# ---------------------------------------------------------------------------
# Factory helpers used by the runner
# ---------------------------------------------------------------------------


def build_runtime(cls: type[AssistantPlugin]) -> PluginRuntime:
    refill = (
        (cls.max_per_minute / 60.0)
        if cls.max_per_minute
        else DEFAULT_PER_PLUGIN_REFILL_PER_SEC
    )
    capacity = float(cls.burst_capacity or DEFAULT_PER_PLUGIN_CAPACITY)
    cooldown = (
        cls.dedup_cooldown_sec
        if cls.dedup_cooldown_sec is not None
        else DEFAULT_DEDUP_COOLDOWN_SEC
    )
    return PluginRuntime(
        name=cls.name,
        limiter=_PluginLimiter(
            capacity=capacity,
            refill_per_sec=refill,
            dedup_cooldown_sec=cooldown,
        ),
        breaker=_CircuitBreaker(),
    )


def encode_suggestion(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def make_global_limiter() -> _TokenBucket:
    return _TokenBucket(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_SEC)


__all__ = [
    "AssistantPlugin",
    "PluginContext",
    "PluginRuntime",
    "SkillManifest",
    "SUGGESTIONS_TOPIC",
    "STATE_TOPIC",
    "build_runtime",
    "encode_suggestion",
    "make_global_limiter",
]
