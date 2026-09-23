export class AgentData {
  agent_id: string;
  agent_type: string;
  command: string;
  payload: Record<string, any>;

  constructor(agent_id: string, agent_type: string, command: string, payload: Record<string, any> = {}) {
    this.agent_id = agent_id;
    this.agent_type = agent_type;
    this.command = command;
    this.payload = payload;
  }

  toJSON() {
   
    return JSON.stringify({
      agent_id: this.agent_id,
      agent_type: this.agent_type,
      payload: this.payload,
    });
  }

  toEvent(): string {
    const mapping: Record<string, string> = {
      "hand_zoom": "zoom",
    };
    this.payload["command"]=this.command
    return JSON.stringify({
      type: "event",
      name: mapping[this.agent_type] ?? this.agent_type,
      payload: this.payload,
    });
  }
}
