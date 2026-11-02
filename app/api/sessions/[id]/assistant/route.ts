import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/auth";
import { prisma } from "../../../../dbbackend/prisma";
import {
  applyAssistantToRoom,
  assistantEnabledForSession,
  canManageSession,
} from "../../../../dbbackend/assistantAgent";

/**
 * The AI assistant (audio analysis) for one session.
 *
 * GET  → { enabled }
 * POST { enabled: boolean } → stores it on the session AND applies it to the
 *      running room now: the agent joins or leaves immediately instead of on
 *      the next join. Hosts of the session (or its space) and admins only.
 *
 * Room names are SessionDomain ids, so the session id is the room.
 */
async function authorise(sessionId: string) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ok = await canManageSession((session as any).uid, (session as any).globalRole, sessionId);
  if (!ok) return NextResponse.json({ error: "Only a host can change this" }, { status: 403 });
  return null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorise(id);
  if (denied) return denied;
  return NextResponse.json({ enabled: await assistantEnabledForSession(id) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorise(id);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const enabled: boolean = body.enabled;

  await prisma.sessionDomain.update({ where: { id }, data: { assistantEnabled: enabled } });
  try {
    await applyAssistantToRoom(id, enabled);
  } catch (e) {
    // Stored either way; the next token request applies it.
    console.warn(`[assistant] could not apply to room "${id}" now:`, e);
    return NextResponse.json({ enabled, applied: false });
  }
  return NextResponse.json({ enabled, applied: true });
}
