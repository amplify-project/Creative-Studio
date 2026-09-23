import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/auth";
import { readNotes } from "./utils";

/**
 * GET /api/notes?sessionId=<id>&viewerId=<liveKitIdentity>
 *
 * Returns the list of files for a session, filtered by viewer role:
 *   - Host (authenticated)        → all files (approved + pending from everyone)
 *   - Participant (anonymous)     → approved files + their own pending uploads
 *
 * `viewerId` is needed to surface a participant's own pending uploads back
 * to them ("Waiting for host"). It's client-supplied and not verified — the
 * worst case is a participant impersonating another and seeing the latter's
 * pending file names, which is metadata only (the actual blob requires
 * approval to download). Same trust model as /api/notes/upload.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const viewerId = url.searchParams.get("viewerId") ?? "";
  const session = await getServerSession(authOptions);
  const isHost = !!session?.user;

  const notes = await readNotes(sessionId);
  let files = notes.files;
  if (!isHost) {
    files = files.filter((f) => f.status === "approved" || f.uploaderId === viewerId);
  }

  return NextResponse.json({ files, isHost });
}
