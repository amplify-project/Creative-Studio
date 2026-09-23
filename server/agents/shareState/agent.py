#!/usr/bin/env python3
"""
Environment:
  LIVEKIT_URL=...
  LIVEKIT_API_KEY=...
  LIVEKIT_API_SECRET=...
"""

import asyncio, json, logging, time, os
from typing import Any, Dict, List, Optional, Callable

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent, AgentSession, JobContext, WorkerOptions, cli, WorkerPermissions,
    RoomInputOptions, RoomOutputOptions
)

# --------------- Logging & ENV ---------------
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("unified_agent")
load_dotenv(".env.local")

# --------------- Labels / Topics ---------------
STATE_LABEL = "state"
CHAT_LABEL  = "chat"
CMD_LABEL   = "cmd"

AGENT_IDENTITY = "shared-state-agent"

try:
    import jsonpatch  # optional, but preferred
except Exception:
    jsonpatch = None

# --------------- Utilities ---------------
def now_ms() -> int:
    return int(time.time() * 1000)

def now_iso() -> str:
    # Use UTC; include 'Z'
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def parse_role(p: Optional[rtc.Participant]) -> str:
    if not p or not p.metadata:
        return "guest"
    md = p.metadata
    try:
        obj = json.loads(md)
        if isinstance(obj, dict):
            return obj.get("role", "guest")
    except Exception:
        pass
    # fallback to plain string metadata
    return md

# --------------- Errors ---------------
class VersionError(Exception):
    def __init__(self, current: int):
        super().__init__("version_conflict")
        self.current = current

# --------------- State Store ---------------
class StateStore:
    """
    Authoritative room state with optimistic concurrency control (versioned).
    Keeps a minimal JSON structure but flexible enough for layouts/entities.
    """
    def __init__(self):
        self._lock = asyncio.Lock()
        self.state: Dict[str, Any] = {
            "version": 0,
            "ui": {"layout": "grid", "theme": "light", "spotlight": None},
            "entities": {},  # id -> { kind, visible, playback, layout, ... }
            "meta": {"updatedBy": None, "timestamp": None},
        }

    def snapshot(self) -> Dict[str, Any]:
        return json.loads(json.dumps(self.state))

    async def apply_patch(
        self, patch_ops: List[Dict[str, Any]], base_version: int, who: Dict[str, str]
    ) -> Dict[str, Any]:
        async with self._lock:
            cur = self.state
            if base_version != cur.get("version", 0):
                raise VersionError(cur.get("version", 0))

            new_state = json.loads(json.dumps(cur))

            if jsonpatch:
                try:
                    new_state = jsonpatch.apply_patch(new_state, patch_ops, in_place=False)
                except jsonpatch.JsonPatchConflict as e:
                    # 🚨 Parcheo tolerante para removes inválidos
                    safe_ops = []
                    for op in patch_ops:
                        if op.get("op") == "remove":
                            path = (op.get("path") or "").lstrip("/").split("/")
                            ref = new_state
                            exists = True
                            for seg in path:
                                if isinstance(ref, dict) and seg in ref:
                                    ref = ref[seg]
                                else:
                                    exists = False
                                    break
                            if exists:
                                safe_ops.append(op)
                            else:
                                # lo ignoramos silenciosamente
                                continue
                        else:
                            safe_ops.append(op)
                    new_state = jsonpatch.apply_patch(new_state, safe_ops, in_place=False)
            else:
                # Simple fallback sin jsonpatch: soporta add/replace/remove
                for op in patch_ops:
                    k = op.get("op")
                    path = (op.get("path") or "").lstrip("/")
                    segs = [s for s in path.split("/") if s]
                    if not segs:
                        raise ValueError("empty path")
                    ref = new_state
                    for s in segs[:-1]:
                        if s not in ref or not isinstance(ref[s], dict):
                            ref[s] = {}
                        ref = ref[s]
                    leaf = segs[-1]
                    if k in ("add", "replace"):
                        ref[leaf] = op.get("value")
                    elif k == "remove":
                        if leaf in ref:
                            del ref[leaf]
                        # si no existe, lo ignoramos en vez de fallar
                    else:
                        raise ValueError(f"unsupported op '{k}' without jsonpatch")

            new_state["version"] = cur.get("version", 0) + 1
            new_state["meta"] = {"updatedBy": who.get("identity"), "timestamp": now_ms()}
            self.state = new_state

            entry = {
                "fromVersion": cur.get("version", 0),
                "toVersion": new_state["version"],
                "diff": patch_ops,
                "who": who,
                "ts": now_ms(),
            }
            return entry

# --------------- Shared State Agent ---------------
class ShareStateAgent(Agent):
    """
    Handles:
      - state/requestSnapshot  -> unicast a full snapshot
      - state/patch            -> apply patch (if authorized) or refuse
      - broadcast state/change on success
      - unicast state/changeRefused on failure
    """
    def __init__(self):
        super().__init__(instructions="You manage shared classroom state.")
        self.room: Optional[rtc.Room] = None
        self.store = StateStore()

    def attach_room(self, room: rtc.Room):
        self.room = room

    async def _broadcast(self, obj: Dict[str, Any]):
        await self.room.local_participant.publish_data(
            json.dumps(obj).encode(),
            reliable=True,
            topic=STATE_LABEL,
        )

    async def _unicast(self, obj: Dict[str, Any], identity: str):
        await self.room.local_participant.publish_data(
            json.dumps(obj).encode(),
            reliable=True,
            destination_identities=[identity],
            topic=STATE_LABEL,
        )

    async def handle_message(self, msg: Dict[str, Any], sender: Optional[rtc.Participant]):
        mtype = msg.get("type")

        # `sender` is None when the packet came from a hidden participant —
        # every agent in this repo sets hidden=True, so we can't resolve them
        # and have no identity to reply to. They pass `replyTo` (their own
        # local_participant.identity) so we know the return address.
        #
        # `replyTo` is a return address ONLY. It is sender-controlled, so it
        # must never feed authorization: role still comes from parse_role(sender),
        # which returns "guest" for an unresolvable sender and gets refused below.
        reply_to = sender.identity if sender else msg.get("replyTo")

        if mtype == "state/requestSnapshot":
            if not reply_to:
                logger.warning("state/requestSnapshot from unresolvable sender and no replyTo — dropping")
                return
            await self._unicast({"type": "state/snapshot", "state": self.store.snapshot()}, reply_to)
            return

        if mtype == "state/patch":
            patch_ops = msg.get("patch") or []
            base_version = int(msg.get("baseVersion", -1))
            role = parse_role(sender)
            who = {"identity": reply_to or "<unresolved>", "role": role}

            # Basic authorization policy (tune as needed)
            if role not in ("teacher", "assistant"):
                if reply_to:
                    await self._unicast(
                        {"type": "state/changeRefused", "reason": "forbidden"},
                        reply_to,
                    )
                return

            try:
                entry = await self.store.apply_patch(patch_ops, base_version, who)
                await self._broadcast({"type": "state/change", **entry})
            except VersionError as ve:
                await self._unicast(
                    {
                        "type": "state/changeRefused",
                        "reason": "version_conflict",
                        "expectedBaseVersion": base_version,
                        "currentVersion": ve.current,
                    },
                    reply_to,
                )
            except Exception as e:
                logger.exception("patch error")
                await self._unicast(
                    {
                        "type": "state/changeRefused",
                        "reason": "invalid_patch",
                        "error": str(e),
                    },
                    reply_to,
                )

# --------------- Chat Bus ---------------
class ChatBus:
    """
    Append-only chat events relayed to everyone.
    Client posts 'chat/message'; server stamps identity & ts and re-broadcasts.
    """
    def __init__(self, room: rtc.Room):
        self.room = room
        self.log = logging.getLogger("chat_bus")

    async def on_chat_message(self, msg: Dict[str, Any], sender: rtc.Participant):
        if msg.get("type") != "chat/message":
            return
        text = (msg.get("text") or "").strip()
        if not text:
            return

        safe = dict(msg)
        safe.setdefault("id", f"svr-{int(time.time()*1000)}")
        safe["from"] = {"identity": sender.identity, "role": parse_role(sender)}
        safe["ts"] = now_iso()

        await self.room.local_participant.publish_data(
            json.dumps(safe).encode(),
            reliable=True,
            topic=CHAT_LABEL,
        )
        self.log.info("chat <%s>: %s", safe["from"]["identity"], text)

# --------------- Command Bus ---------------
class CommandBus:
    """
    Request/Response command channel.
    Client sends:  {type:"cmd/request", correlationId, name, args?}
    Server replies to SENDER: cmd/ok or cmd/error (same correlationId)
    """
    def __init__(self, room: rtc.Room, state_agent: ShareStateAgent):
        self.room = room
        self.log = logging.getLogger("cmd_bus")
        self.state_agent = state_agent  # if you want to affect shared state
        self.handlers: Dict[str, Callable[[Dict[str, Any], rtc.Participant], Any]] = {
            "ping": self._cmd_ping,
            "zoom": self._cmd_zoom,
            # "muteAll": self._cmd_mute_all,
            # "gotoSlide": self._cmd_goto_slide,
        }

    async def on_cmd_request(self, msg: Dict[str, Any], sender: rtc.Participant):
        if msg.get("type") != "cmd/request":
            return
        corr = msg.get("correlationId")
        if not corr:
            return
        if not sender:
            return
        name = (msg.get("name") or "").strip()
        args = msg.get("args") or {}
        role = parse_role(sender)

        # Simple ACL example
        teacher_only = {"muteAll", "gotoSlide"}
        if name in teacher_only and role != "teacher":
            await self._reply_error(corr, sender.identity, "forbidden", f"role {role} not allowed for {name}")
            return

        handler = self.handlers.get(name)
        if not handler:
            await self._reply_error(corr, sender.identity, "invalid", f"unknown command {name}")
            return

        try:
            result = await handler(args, sender)
            await self._reply_ok(corr, sender.identity, result)
        except asyncio.TimeoutError:
            await self._reply_error(corr, sender.identity, "timeout", "operation timed out")
        except Exception as e:
            self.log.exception("cmd error")
            await self._reply_error(corr, sender.identity, "internal", str(e))

    async def _reply_ok(self, corr: str, dest_identity: str, result: Any = None):
        resp = {
            "type": "cmd/ok",
            "correlationId": corr,
            "ts": now_iso(),
            "result": result,
        }
        await self.room.local_participant.publish_data(
            json.dumps(resp).encode(),
            reliable=True,
            destination_identities=[dest_identity],
            topic=CMD_LABEL,
        )

    async def _reply_error(self, corr: str, dest_identity: str, code: str, message: Optional[str] = None):
        resp = {
            "type": "cmd/error",
            "correlationId": corr,
            "ts": now_iso(),
            "code": code,
            "message": message,
        }
        await self.room.local_participant.publish_data(
            json.dumps(resp).encode(),
            reliable=True,
            destination_identities=[dest_identity],
            topic=CMD_LABEL,
        )

    async def _cmd_zoom(self, args: Dict[str, Any], sender: rtc.Participant):
        track_id = args.get("track_id")
        bbox = args.get("bbox")
        if not track_id or not bbox:
            raise ValueError("faltan args: track_id y bbox requeridos")

        payload = {
            "cmd": "zoom",
            "track_id": track_id,
            "bbox": bbox,
        }

        # broadcast a todos los participantes
        await self.room.local_participant.publish_data(
            json.dumps(payload).encode(),
            reliable=False,
            topic=CMD_LABEL,
        )
        return payload

    async def _cmd_ping(self, args: Dict[str, Any], sender: rtc.Participant):
        return {"pong": True, "at": now_iso(), "you": sender.identity}

    # async def _cmd_mute_all(self, args: Dict[str, Any], sender: rtc.Participant):
    #     # Example: write a patch that flips playback.muted for all entities of kind "participantCam"
    #     # Or call server-side APIs to mute tracks.
    #     return {"muted": "all"}

    # async def _cmd_goto_slide(self, args: Dict[str, Any], sender: rtc.Participant):
    #     # Example: set UI layout or entity slide index via state patch
    #     page = int(args.get("page", 1))
    #     patch = [{"op": "add", "path": "/ui/slidePage", "value": page}]
    #     # Apply patch via state agent with teacher authority
    #     who = {"identity": sender.identity, "role": parse_role(sender)}
    #     entry = await self.state_agent.store.apply_patch(patch, self.state_agent.store.snapshot()["version"], who)
    #     await self.state_agent._broadcast({"type": "state/change", **entry})
    #     return {"page": page}

# --------------- Entrypoint ---------------
async def entrypoint(ctx: JobContext):
    await ctx.connect()
    room = ctx.room

    session = AgentSession()
    state_agent = ShareStateAgent()
    state_agent.attach_room(room)

    chat_bus = ChatBus(room)
    cmd_bus = CommandBus(room, state_agent)

    await session.start(
        agent=state_agent,
        room=room,
        room_input_options=RoomInputOptions(audio_enabled=False, text_enabled=False, close_on_disconnect=False),
        room_output_options=RoomOutputOptions(audio_enabled=False, transcription_enabled=False),
    )

    # ---- Router for all data topics ----
    @room.on("data_received")
    def _on_data(pkt: rtc.DataPacket):
        async def _handle():
            try:
                msg = json.loads(pkt.data.decode())
                topic = pkt.topic or ""
                if topic == STATE_LABEL:
                    await state_agent.handle_message(msg, pkt.participant)
                elif topic == CHAT_LABEL:
                    await chat_bus.on_chat_message(msg, pkt.participant)
                elif topic == CMD_LABEL:
                    await cmd_bus.on_cmd_request(msg, pkt.participant)
                else:
                    # ignore unknown topics
                    pass
            except Exception:
                logger.exception("error processing data packet")
        asyncio.create_task(_handle())

    # ---- On join: unicast snapshot so newcomers are in sync ----
    @room.on("participant_connected")
    def _on_participant(p: rtc.RemoteParticipant):
        async def _handle():
            await asyncio.sleep(0.1)  # let join settle
            try:
                await state_agent._unicast({"type": "state/snapshot", "state": state_agent.store.snapshot()}, p.identity)
            except Exception:
                logger.exception("error sending snapshot")
        asyncio.create_task(_handle())

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

