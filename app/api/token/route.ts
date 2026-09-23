import { NextResponse } from "next/server";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { prisma } from "../../dbbackend/prisma";

const API_KEY = process.env.LIVEKIT_API_KEY!;
const API_SECRET = process.env.LIVEKIT_API_SECRET!;
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";

// Agents that must run in every room. Names must match `agent_name=` in the
// corresponding Python worker (zoom_agent.py, agent.py, …).
const SHARED_STATE_AGENT = "shared-state-agent";
const ROOM_AGENTS = [SHARED_STATE_AGENT, "zoom-agent", "pose-gaze-agent"];

// Dispatched only when the session opted in. Kept out of ROOM_AGENTS rather
// than filtered out of it so the default is "not dispatched" — forgetting to
// handle a case leaves the expensive agent off, not on.
const ASSISTANT_AGENT = "assistant-host";

/** Room names are SessionDomain ids (see app/host/page.tsx, which reads the
 *  `sessionId` query param). Anything that isn't a real session — the "test"
 *  fallback, an ad-hoc room — has no row and therefore no opt-in. */
async function assistantEnabledForRoom(roomName: string): Promise<boolean> {
  try {
    const session = await prisma.sessionDomain.findUnique({
      where: { id: roomName },
      select: { assistantEnabled: true },
    });
    return session?.assistantEnabled === true;
  } catch {
    // Malformed ObjectId, or the DB is unreachable. Both mean we cannot show
    // the session opted in, and the safe answer for a resource-hungry agent
    // is no.
    return false;
  }
}

// Maps app roles to the roles parse_role() expects in the Python agent.
// Hosts need "teacher" so their state/patch requests are authorized.
const AGENT_ROLE: Record<string, string> = {
  host: "teacher",
  teacher: "teacher",
  assistant: "assistant",
};

export async function GET(req: Request) {
  const url = new URL(req.url);

  const identity = url.searchParams.get("identity") || "anonymous";
  const displayName = url.searchParams.get("name") || undefined;
  const role = url.searchParams.get("role") || "participant";
  const roomName = url.searchParams.get("room_name") || process.env.LIVEKIT_ROOM || "test";

  if (!API_KEY || !API_SECRET) {
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }

  // Embed role in participant metadata so the agent can authorize state/patch.
  const agentRole = AGENT_ROLE[role] ?? "guest";
  const metadata = JSON.stringify({ role: agentRole });

  try {
    const at = new AccessToken(API_KEY, API_SECRET, { identity, name: displayName, metadata });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const token = await at.toJwt();

    // On host refresh the invite/verify flow is skipped, so we re-check here.
    // Fire-and-forget: token is returned immediately regardless of agent status.
    if (agentRole === "teacher" && LIVEKIT_URL) {
      ensureAgentInRoom(roomName).catch((err) =>
        console.warn("[token] ensureAgentInRoom failed:", err)
      );
    }

    return NextResponse.json(
      { token, room: roomName },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * Dispatches every agent in ROOM_AGENTS to the room if it is not already
 * present. Each agent is checked + dispatched independently so one missing
 * agent doesn't block the others. Idempotent: checks participant list and
 * pending dispatches first to avoid duplicates.
 *
 * Previously this only handled shared-state-agent, which left zoom-agent /
 * pose-gaze-agent un-dispatched on the direct-token flow (host refresh,
 * direct join URLs) — they only got dispatched via /api/setupAgent, called
 * from /spaces and /api/invite/verify.
 *
 * Concurrent callers for the same room share one run (see inFlight below).
 * The listDispatch check alone doesn't dedupe: two token requests that both
 * list before either dispatches will each dispatch, and the agent ends up
 * running twice in the room.
 */
const inFlight = new Map<string, Promise<void>>();

function ensureAgentInRoom(roomName: string): Promise<void> {
  const existing = inFlight.get(roomName);
  if (existing) return existing;
  const run = dispatchAgentsToRoom(roomName).finally(() => {
    inFlight.delete(roomName);
  });
  inFlight.set(roomName, run);
  return run;
}

async function dispatchAgentsToRoom(roomName: string): Promise<void> {
  const roomSvc = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
  const dispatchSvc = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);

  // Snapshot participants + dispatches once, then decide per-agent. One
  // round-trip each instead of one per agent.
  let liveIdentities: Set<string> = new Set();
  try {
    const participants = await roomSvc.listParticipants(roomName);
    liveIdentities = new Set(participants.map((p) => p.identity));
  } catch {
    // Room doesn't exist yet — agent dispatch will create it implicitly.
  }

  let pendingAgentNames: Set<string> = new Set();
  try {
    const dispatches = await dispatchSvc.listDispatch(roomName);
    pendingAgentNames = new Set(dispatches.map((d) => d.agentName));
  } catch {
    // If listing fails, proceed with dispatch anyway.
  }

  const wanted = (await assistantEnabledForRoom(roomName))
    ? [...ROOM_AGENTS, ASSISTANT_AGENT]
    : ROOM_AGENTS;

  await Promise.allSettled(
    wanted.map(async (agentName) => {
      if (liveIdentities.has(agentName) || pendingAgentNames.has(agentName)) return;
      try {
        await dispatchSvc.createDispatch(roomName, agentName);
        console.info(`[token] dispatched ${agentName} → room "${roomName}"`);
      } catch (err) {
        console.warn(`[token] failed to dispatch ${agentName} → room "${roomName}":`, err);
      }
    }),
  );
}

