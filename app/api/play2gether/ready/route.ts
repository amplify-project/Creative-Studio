import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { Play2GetherSession, readSession, writeSession } from "../utils";

/** POST /api/play2gether/ready
 * Body: { sessionId: string, participantId: string, participantName?: string }
 * Any authenticated participant marks themselves ready during rehearsal.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId, participantId, participantName } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }

  let meta: Play2GetherSession;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const name = (typeof participantName === "string" && participantName.trim()) || participantId;
  meta.ready[participantId] = { name };
  await writeSession(meta);

  return NextResponse.json({ ok: true, participantId });
}

/** DELETE /api/play2gether/ready
 * Body: { sessionId: string, participantId: string }
 * Participant un-marks themselves (e.g. when rehearsal resets).
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId, participantId } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }

  let meta: Play2GetherSession;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  delete meta.ready[participantId];
  await writeSession(meta);

  return NextResponse.json({ ok: true });
}