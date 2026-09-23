import json
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class AgentData:
    type: str
    name: str
    payload: Dict[str, Any]

    @staticmethod
    def from_json(data: str) -> "AgentData":
        obj = json.loads(data)
        return AgentData(
            type=obj["type"],
            name=obj["name"],
            payload=obj.get("payload", {}),
        )

    def to_event(self) -> Dict[str, Any]:
        """
        Convierte este AgentData en el formato estándar CmdInbound (evento).
        """
        # Solo un ejemplo: mapear agent_type -> nombre del evento
        mapping = {
            "hand_zoom": "zoom",
        }

        #event_name = mapping.get(self.agent_type, self.agent_type)

        return {
            "type": "event",
            "name": self.name,
            "payload": self.payload,
        }

    def to_event_json(self) -> str:
        return json.dumps(self.to_event())
