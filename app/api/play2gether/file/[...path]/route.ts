import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/auth";
import { readFile, stat } from "fs/promises";
import { join, extname } from "path";

const STORAGE_BASE = "/tmp/play2gether";

const MIME_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".ogg":  "audio/ogg",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".aac":  "audio/aac",
  ".flac": "audio/flac",
  ".m4a":  "audio/mp4",
  // Precomputed waveform envelopes (`<take>.peaks.json`) ride the same route
  // as the audio they describe — same auth, same session-scoped path guard.
  ".json": "application/json",
  // High-resolution take envelope for the mixer zoom (`<take>.peaks.bin`):
  // a float64 duration header then one byte per bucket. Same route, same auth,
  // same session-scoped path guard as the audio it describes.
  ".bin":  "application/octet-stream",
};

/** GET /api/play2gether/file/[sessionId]/[filename]
 * Streams an audio file from the session storage directory.
 * Supports Range requests so browsers can seek within the audio.
 * Requires authentication.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await params;

  // Expect exactly [sessionId, filename]
  if (!path || path.length !== 2) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const [sessionId, filename] = path;

  // Path traversal guard: reject any segment containing ".."
  if ([sessionId, filename].some((s) => s.includes(".."))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // The only JSON this route serves is a take's precomputed waveform envelope.
  // `session.json` lives in the same directory and holds participant names and
  // timing metadata — it is reached through /api/play2gether/session, which is
  // where its access rules belong.
  if (filename.endsWith(".json") && !filename.endsWith(".peaks.json")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filePath = join(STORAGE_BASE, sessionId, filename);
  const ext = extname(filename).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  let fileSize: number;
  try {
    const info = await stat(filePath);
    fileSize = info.size;
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const rangeHeader = req.headers.get("range");

  // ── Full response ─────────────────────────────────────────────────────────
  if (!rangeHeader) {
    const buffer = await readFile(filePath);
    const body1 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new NextResponse(body1 as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // ── Range response (browser audio seek) ──────────────────────────────────
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return new NextResponse(null, { status: 416 }); // Range Not Satisfiable
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start > end || end >= fileSize) {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${fileSize}` },
    });
  }

  const chunkSize = end - start + 1;
  const buffer = await readFile(filePath);
  const chunk = buffer.slice(start, end + 1);
  const chunkBody = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  return new NextResponse(chunkBody, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
