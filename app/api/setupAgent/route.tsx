// app/api/setup-agent/route.ts
import { NextResponse } from "next/server";
import { AgentDispatchClient } from "livekit-server-sdk";

const LIVEKIT_URL = "http://127.0.0.1:7880"
const AGENTS = ["zoom-agent", "shared-state-agent","pose-gaze-agent"];

export async function POST(req: Request) {
  try {
    if (!LIVEKIT_URL) {
      return NextResponse.json({ error: "LIVEKIT_URL not set" }, { status: 500 });
    }

    const { room } = await req.json();
    if (!room) {
      return NextResponse.json({ error: "Room not specified" }, { status: 400 });
    }

    const client = new AgentDispatchClient(LIVEKIT_URL);

    const results = [];

    for (const agentName of AGENTS) {
      try {
        const dispatch = await client.createDispatch(room, agentName, {
          metadata: JSON.stringify({ room }),
        });
        console.log("time",agentName)
        results.push({ agent: agentName, success: true, dispatch });
      } catch (err) {
        console.error(`Error dispatching agent ${agentName}:`, err);
        results.push({ agent: agentName, success: false, error: String(err) });
      }
    }

    return NextResponse.json({
      success: true,
      room,
      agents: results,
    });
  } catch (e) {
    console.error("Error in setup-agent:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
