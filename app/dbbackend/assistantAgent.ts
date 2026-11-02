import "server-only";
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { prisma } from "./prisma";

/** Must match `agent_name=` in server/agents/assistantHost/assistant_host.py. */
export const ASSISTANT_AGENT = "assistant-host";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";

/**
 * Whether a session wants the assistant. On by default: a session with no
 * value (created before the field existed, or by code that does not set it)
 * gets it; only an explicit `false` turns it off. Anything that is not a real
 * session — the "test" fallback room, an ad-hoc room, a malformed id — has no
 * row and gets no assistant.
 */
export async function assistantEnabledForSession(sessionId: string): Promise<boolean> {
  try {
    const session = await prisma.sessionDomain.findUnique({
      where: { id: sessionId },
      select: { assistantEnabled: true },
    });
    if (!session) return false;
    return session.assistantEnabled !== false;
  } catch {
    return false;
  }
}

/** Admin, a host of the session, or a host of its space. */
export async function canManageSession(
  uid: string | undefined,
  globalRole: string | undefined,
  sessionId: string,
): Promise<boolean> {
  if (!uid) return false;
  if (globalRole === "admin") return true;
  try {
    const role = await prisma.sessionRole.findUnique({
      where: { sessionId_userId: { sessionId, userId: uid } },
      select: { role: true },
    });
    if (role?.role === "host") return true;
    const session = await prisma.sessionDomain.findUnique({
      where: { id: sessionId },
      select: { spaceId: true },
    });
    if (!session) return false;
    const member = await prisma.spaceMember.findFirst({
      where: { spaceId: session.spaceId, userId: uid, role: "host" },
      select: { id: true },
    });
    return !!member;
  } catch {
    return false;
  }
}

/**
 * Bring the running room in line with the setting, now rather than on the
 * next join.
 *
 * On: dispatch the agent unless a dispatch already exists.
 * Off: delete its dispatches (so the next token request does not bring it
 * back) and remove the agent participant those dispatches started, so it
 * leaves the room immediately and frees its CPU.
 *
 * A room that does not exist yet is not an error: the setting is stored and
 * /api/token applies it when the room is created.
 */
export async function applyAssistantToRoom(roomName: string, enabled: boolean): Promise<void> {
  const dispatchSvc = new AgentDispatchClient(LIVEKIT_URL, API_KEY, API_SECRET);
  let dispatches: Awaited<ReturnType<AgentDispatchClient["listDispatch"]>> = [];
  try {
    dispatches = (await dispatchSvc.listDispatch(roomName)).filter(
      (d) => d.agentName === ASSISTANT_AGENT,
    );
  } catch {
    // No such room yet. Nothing to apply now — and dispatching would create an
    // empty room just to put the agent in it. /api/token applies the stored
    // setting when the first person joins.
    return;
  }

  if (enabled) {
    if (dispatches.length > 0) return;
    await dispatchSvc.createDispatch(roomName, ASSISTANT_AGENT);
    console.info(`[assistant] dispatched ${ASSISTANT_AGENT} → room "${roomName}"`);
    return;
  }

  // The identity the agent joined with is on the job state; the agents SDK
  // default is `agent-<job id>`, kept as a fallback.
  const identities = new Set<string>();
  for (const d of dispatches) {
    for (const job of d.state?.jobs ?? []) {
      const ident = (job as any).state?.participantIdentity as string | undefined;
      identities.add(ident || `agent-${job.id}`);
    }
  }
  await Promise.allSettled(dispatches.map((d) => dispatchSvc.deleteDispatch(d.id, roomName)));
  const roomSvc = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
  await Promise.allSettled(
    [...identities].map((identity) => roomSvc.removeParticipant(roomName, identity)),
  );
  console.info(
    `[assistant] removed ${ASSISTANT_AGENT} from room "${roomName}" ` +
      `(${dispatches.length} dispatch(es), identities: ${[...identities].join(", ") || "none"})`,
  );
}
