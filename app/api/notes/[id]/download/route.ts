import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { findNote, notePath, noteBlobOk } from "../../utils";

/**
 * GET /api/notes/:id/download?sessionId=<id>&disposition=inline|attachment
 *
 * Serves a note file. Open by default (`inline`) so the browser previews
 * PDFs and images directly in a new tab; pass `disposition=attachment` to
 * force a download.
 *
 * Authorization model (intentional pragmatism for an educational tool):
 *   - The file id is a UUID v4 (unguessable in practice).
 *   - We do not require the caller to be the host or an active participant.
 *   - The UI hides pending uploads from non-host viewers (see GET /api/notes
 *     filtering), so a participant won't get a download link to someone
 *     else's pending file in normal flows.
 *
 * If a stricter model is needed later, add a viewerId param + check the
 * file's status against viewer identity (similar to GET /api/notes).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const { file } = await findNote(sessionId, id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (!(await noteBlobOk(sessionId, file))) {
    return NextResponse.json({ error: "File blob missing or corrupt" }, { status: 410 });
  }

  const buffer = await readFile(notePath(sessionId, file));
  const disposition = url.searchParams.get("disposition") === "attachment" ? "attachment" : "inline";

  // Use RFC 5987 to support unicode filenames (cyrillic, accents, etc.).
  // Browsers fall back to the plain `filename=` for the unicode-incapable.
  const asciiFallback = file.fileName.replace(/[^\x20-\x7E]/g, "_");
  const utf8Encoded = encodeURIComponent(file.fileName);
  const contentDisposition = `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

  // Wrap as plain Uint8Array — NextResponse's BodyInit type doesn't accept
  // Node's Buffer<ArrayBufferLike> even though it works at runtime.
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.size),
      "Content-Disposition": contentDisposition,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
