#!/usr/bin/env python3
"""
engagement-bridge-agent — relays the Physiological-Signals Redis feed into a
LiveKit room as data messages. Data only: subscribes to no tracks.

Redis channels consumed (published by the Physiological-Signals pipeline):
  engagement_score                 crowd average, plain float string, ~1 Hz
  device:{serial}:engagement       per-person engagement (JSON)
  device:{serial}:physio_metrics   per-wearer session-z physiology (JSON)
  device:{serial}:valence_cont     {"valence": float}
  device:{serial}:arousal_cont     {"arousal": float}

The key per person is the EmotiBit serial. The host binds a serial to a room
participant (`engagement/bind`); bindings live in memory for the job's
lifetime, i.e. for one session. Nothing is persisted.

Topic "engagement":
  agent -> room   engagement/update    {ts, crowd, people: [entry...]}
                  engagement/bindings  {bindings: {serial: identity}}
  client -> agent engagement/requestSnapshot  {}            (anyone)
                  engagement/bind      {serial, identity|null}  (host only)
  agent -> client engagement/snapshot  {ts, crowd, people, bindings}
                  engagement/bindRefused {reason, serial?}

Audience (ENGAGEMENT_AUDIENCE):
  hosts (default)  hosts get every entry; a bound participant gets only their
                   own entry; everyone gets the crowd average
  all              everyone gets every entry

Environment:
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
  REDIS_URL            default redis://localhost:6379/0
  ENGAGEMENT_AUDIENCE  hosts | all   (default hosts)
  PUBLISH_INTERVAL_S   default 1.0
  STALE_AFTER_S        entry marked stale after this many seconds (default 10)
  DROP_AFTER_S         entry dropped after this many seconds (default 60)
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import redis.asyncio as aioredis
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, WorkerPermissions, cli

from viz import VizPublisher

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("engagement_bridge")
load_dotenv(".env.local")

AGENT_IDENTITY = "engagement-bridge-agent"
TOPIC = "engagement"
HOST_ROLES = ("teacher", "assistant")

REDIS_URL = os.getenv("REDIS_URL") or "redis://localhost:6379/0"  # empty (compose default) = unset
AUDIENCE = os.getenv("ENGAGEMENT_AUDIENCE", "hosts").strip().lower()
PUBLISH_INTERVAL_S = float(os.getenv("PUBLISH_INTERVAL_S", "1.0"))
STALE_AFTER_S = float(os.getenv("STALE_AFTER_S", "10"))
DROP_AFTER_S = float(os.getenv("DROP_AFTER_S", "60"))

CROWD_CHANNEL = "engagement_score"
DEVICE_PATTERNS = (
    "device:*:engagement",
    "device:*:physio_metrics",
    "device:*:valence_cont",
    "device:*:arousal_cont",
)


def parse_role(p: Optional[rtc.Participant]) -> str:
    """Same contract as shareState/agent.py: role lives in metadata JSON."""
    if not p or not p.metadata:
        return "guest"
    try:
        obj = json.loads(p.metadata)
        if isinstance(obj, dict):
            return obj.get("role", "guest")
    except Exception:
        pass
    return p.metadata


# --------------- State ---------------
class EngagementState:
    """Latest value per serial, plus the session's serial -> identity bindings."""

    def __init__(self) -> None:
        self.crowd: Optional[float] = None
        self.crowd_at: float = 0.0
        self.devices: Dict[str, Dict[str, Any]] = {}
        self.bindings: Dict[str, str] = {}
        self.dirty = False

    def _device(self, serial: str) -> Dict[str, Any]:
        return self.devices.setdefault(serial, {"serial": serial})

    def ingest(self, channel: str, data: str) -> None:
        now = time.time()
        if channel == CROWD_CHANNEL:
            try:
                self.crowd = round(float(data), 4)
            except ValueError:
                return
            self.crowd_at = now
            self.dirty = True
            return

        parts = channel.split(":")
        if len(parts) < 3 or parts[0] != "device":
            return
        serial, kind = ":".join(parts[1:-1]), parts[-1]
        try:
            payload = json.loads(data)
        except ValueError:
            return
        if not isinstance(payload, dict):
            return

        dev = self._device(serial)
        if kind == "engagement":
            dev["engagement"] = payload.get("engagement")
            dev["confirmed"] = payload.get("confirmed")
            dev["confidence"] = payload.get("confidence")
            dev["source"] = payload.get("source")
        elif kind == "physio_metrics":
            dev["physio"] = {k: v for k, v in payload.items() if k not in ("device", "timestamp")}
        elif kind == "valence_cont":
            dev["valence"] = payload.get("valence")
        elif kind == "arousal_cont":
            dev["arousal"] = payload.get("arousal")
        else:
            return
        dev["updatedAt"] = now
        self.dirty = True

    def prune(self) -> None:
        now = time.time()
        for serial in [s for s, d in self.devices.items() if now - d.get("updatedAt", 0) > DROP_AFTER_S]:
            del self.devices[serial]
            self.dirty = True
        if self.crowd is not None and now - self.crowd_at > DROP_AFTER_S:
            self.crowd = None
            self.dirty = True

    def entries(self) -> List[Dict[str, Any]]:
        now = time.time()
        out = []
        for serial, dev in self.devices.items():
            e = dict(dev)
            e["identity"] = self.bindings.get(serial)
            e["stale"] = now - dev.get("updatedAt", 0) > STALE_AFTER_S
            e["updatedAt"] = round(dev.get("updatedAt", 0), 3)
            out.append(e)
        return out

    def crowd_value(self) -> Optional[float]:
        if self.crowd is None or time.time() - self.crowd_at > STALE_AFTER_S:
            return None
        return self.crowd


# --------------- Bridge ---------------
class EngagementBridge:
    def __init__(self, room: rtc.Room) -> None:
        self.room = room
        self.state = EngagementState()

    # ---- sending ----
    async def _send(self, obj: Dict[str, Any], identities: Optional[List[str]] = None) -> None:
        kwargs: Dict[str, Any] = {"reliable": True, "topic": TOPIC}
        if identities is not None:
            if not identities:
                return
            kwargs["destination_identities"] = identities
        await self.room.local_participant.publish_data(json.dumps(obj).encode(), **kwargs)

    def _hosts(self) -> List[str]:
        return [p.identity for p in self.room.remote_participants.values() if parse_role(p) in HOST_ROLES]

    async def publish_update(self) -> None:
        msg_type = "engagement/update"
        crowd = self.state.crowd_value()
        people = self.state.entries()
        ts = round(time.time(), 3)

        if AUDIENCE == "all":
            await self._send({"type": msg_type, "ts": ts, "crowd": crowd, "people": people})
            return

        hosts = set(self._hosts())
        await self._send({"type": msg_type, "ts": ts, "crowd": crowd, "people": people}, sorted(hosts))

        by_identity = {e["identity"]: e for e in people if e["identity"]}
        for p in self.room.remote_participants.values():
            if p.identity in hosts:
                continue
            own = by_identity.get(p.identity)
            await self._send(
                {"type": msg_type, "ts": ts, "crowd": crowd, "people": [own] if own else []},
                [p.identity],
            )

    async def send_snapshot(self, participant: rtc.Participant) -> None:
        is_host = AUDIENCE == "all" or parse_role(participant) in HOST_ROLES
        people = self.state.entries()
        if not is_host:
            people = [e for e in people if e["identity"] == participant.identity]
        await self._send(
            {
                "type": "engagement/snapshot",
                "ts": round(time.time(), 3),
                "crowd": self.state.crowd_value(),
                "people": people,
                "bindings": self.state.bindings if is_host else {},
            },
            [participant.identity],
        )

    # ---- receiving ----
    async def on_message(self, msg: Dict[str, Any], sender: Optional[rtc.Participant]) -> None:
        mtype = msg.get("type")
        if not sender:
            # Hidden participants (other agents) can't be resolved or authorized.
            return

        if mtype == "engagement/requestSnapshot":
            await self.send_snapshot(sender)
            return

        if mtype == "engagement/bind":
            if parse_role(sender) not in HOST_ROLES:
                await self._send({"type": "engagement/bindRefused", "reason": "forbidden"}, [sender.identity])
                return
            serial = (msg.get("serial") or "").strip()
            identity = msg.get("identity")
            if not serial:
                await self._send({"type": "engagement/bindRefused", "reason": "missing_serial"}, [sender.identity])
                return
            if identity:
                # One serial per participant: drop any older binding to this identity.
                for s in [s for s, i in self.state.bindings.items() if i == identity]:
                    del self.state.bindings[s]
                self.state.bindings[serial] = identity
                logger.info("bind %s -> %s (by %s)", serial, identity, sender.identity)
            else:
                self.state.bindings.pop(serial, None)
                logger.info("unbind %s (by %s)", serial, sender.identity)
            self.state.dirty = True
            await self._send({"type": "engagement/bindings", "bindings": self.state.bindings}, self._hosts())

    # ---- loops ----
    async def redis_loop(self) -> None:
        backoff = 1.0
        while True:
            client = aioredis.from_url(REDIS_URL, decode_responses=True)
            pubsub = client.pubsub()
            try:
                await pubsub.subscribe(CROWD_CHANNEL)
                await pubsub.psubscribe(*DEVICE_PATTERNS)
                logger.info("subscribed to Redis at %s", REDIS_URL)
                backoff = 1.0
                async for m in pubsub.listen():
                    if m.get("type") in ("message", "pmessage"):
                        self.state.ingest(m["channel"], m["data"])
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Redis connection lost (%s); retrying in %.0fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
            finally:
                try:
                    await pubsub.aclose()
                    await client.aclose()
                except Exception:
                    pass

    async def simulate_loop(self) -> None:
        """ENGAGEMENT_SIMULATE=true: generate fake data in-process instead of reading Redis."""
        import simulate

        logger.info("SIMULATION mode: generating fake data for %s (no Redis)", [d[0] for d in simulate.DEVICES])
        t0 = time.time()
        while True:
            for channel, payload in simulate.messages(time.time() - t0):
                self.state.ingest(channel, payload)
            await asyncio.sleep(1)

    async def publish_loop(self) -> None:
        while True:
            await asyncio.sleep(PUBLISH_INTERVAL_S)
            self.state.prune()
            if not self.state.dirty:
                continue
            self.state.dirty = False
            try:
                await self.publish_update()
            except Exception:
                logger.exception("publish failed")


# --------------- Entrypoint ---------------
async def entrypoint(ctx: JobContext):
    # Data only: a subscribed track is decoded even if unread.
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    room = ctx.room
    bridge = EngagementBridge(room)

    @room.on("data_received")
    def _on_data(pkt: rtc.DataPacket):
        if (pkt.topic or "") != TOPIC:
            return

        async def _handle():
            try:
                await bridge.on_message(json.loads(pkt.data.decode()), pkt.participant)
            except Exception:
                logger.exception("error processing data packet")

        asyncio.create_task(_handle())

    @room.on("participant_connected")
    def _on_participant(p: rtc.RemoteParticipant):
        async def _handle():
            await asyncio.sleep(0.1)  # let join settle
            try:
                await bridge.send_snapshot(p)
            except Exception:
                logger.exception("error sending snapshot")

        asyncio.create_task(_handle())

    simulate_mode = os.getenv("ENGAGEMENT_SIMULATE", "false").lower() == "true"
    source = bridge.simulate_loop() if simulate_mode else bridge.redis_loop()
    tasks = [asyncio.create_task(source), asyncio.create_task(bridge.publish_loop())]

    viz: Optional[VizPublisher] = None
    if os.getenv("ENGAGEMENT_VIZ", "true").lower() == "true":
        viz = VizPublisher(room, bridge.state)
        tasks.append(asyncio.create_task(viz.run()))

    async def _shutdown():
        for t in tasks:
            t.cancel()
        if viz:
            await viz.close()

    ctx.add_shutdown_callback(_shutdown)
    logger.info("engagement bridge running in room %s (audience=%s)", room.name, AUDIENCE)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            permissions=WorkerPermissions(
                can_publish=False,
                can_publish_data=True,
                can_subscribe=True,
                hidden=True,
            ),
            agent_name=AGENT_IDENTITY,
        )
    )
