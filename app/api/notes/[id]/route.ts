import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { deleteNoteBlob, findNote, writeNotes } from "../utils";

/**
 * DELETE /api/notes/:id?sessionId=<id>
 *
 * Host-only. Removes a file (approved or pending) from the index and
 * deletes its blob. The participant-side "cancel my own pending upload"
 * flow could use this in the future with a different auth model — today
 * the host is the only deleter.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const { index, file } = await findNote(sessionId, id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  index.files = index.files.filter((f) => f.id !== id);
  await writeNotes(index);
  await deleteNoteBlob(sessionId, file);

  return NextResponse.json({ ok: true });
}
