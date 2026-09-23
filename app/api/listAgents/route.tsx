// app/api/list-agents/route.ts
import { NextResponse } from "next/server";
import { AgentDispatchClient } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL;

export async function POST(req: Request) {
  try {
    if (!LIVEKIT_URL) {
      return NextResponse.json({ error: "LIVEKIT_URL not set" }, { status: 500 });
    }
    console.log(LIVEKIT_URL);
    const { room } = await req.json();
    if (!room) {
      return NextResponse.json({ error: "Room not specified" }, { status: 400 });
    }
   
    const client = new AgentDispatchClient(LIVEKIT_URL);

    // Obtiene todos los despachos activos (agentes en ejecución)
    const allDispatches = await client.listDispatch(room);

    return NextResponse.json({
      success: true,
      room,
      agents: allDispatches,
    });
  } catch (e) {
    console.error("Error in list-agents:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
