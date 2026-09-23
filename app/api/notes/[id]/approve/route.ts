import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/auth";
import { findNote, writeNotes } from "../../utils";

/**
 * POST /api/notes/:id/approve
 *
 * Body: { sessionId: string }
 *
 * Host-only. Flips a pending file's status to "approved". Idempotent: re-
 * approving an already-approved file is a no-op (returns the file as-is).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  let body: { sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sessionId = body?.sessionId;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const { index, file } = await findNote(sessionId, id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  if (file.status !== "approved") {
    file.status = "approved";
    file.approvedAt = Date.now();
    await writeNotes(index);
  }

  return NextResponse.json({ file });
}
