"""
The room's authoritative shared state, with optimistic concurrency control.

Kept apart from agent.py so it can be tested without the LiveKit SDK: this is
the part that decides whether a change is accepted, and in what order.
"""
import asyncio
import json
import time
from typing import Any, Dict, List

try:
    import jsonpatch  # optional, but preferred
except Exception:
    jsonpatch = None


def now_ms() -> int:
    return int(time.time() * 1000)


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
