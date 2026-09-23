import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/auth";
import { deleteNoteBlob, findNote, writeNotes } from "../../utils";

/**
 * POST /api/notes/:id/reject
 *
 * Body: { sessionId: string }
 *
 * Host-only. Removes a pending file from the index and deletes its blob.
 * Approved files should be deleted via DELETE /api/notes/:id instead — the
 * UX intent is different (rejecting is "this never should have been here"
 * vs. deleting is "we're done with this").
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
  if (file.status !== "pending") {
    return NextResponse.json(
      { error: "Only pending files can be rejected. Use DELETE for approved files." },
      { status: 400 }
    );
  }

  index.files = index.files.filter((f) => f.id !== id);
  await writeNotes(index);
  await deleteNoteBlob(sessionId, file);

  return NextResponse.json({ ok: true });
}
