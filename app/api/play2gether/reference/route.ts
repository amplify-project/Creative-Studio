import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { readSession, writeSession, sessionDir, probeDuration } from "../utils";

const ALLOWED_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
]);

/** POST /api/play2gether/reference
 * Body: FormData { sessionId: string, audio: File }
 * Only the host (authenticated) can upload the reference track.
 * Returns: { url: string }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const sessionId = formData.get("sessionId") as string | null;
  const audioFile = formData.get("audio") as File | null;
  // Client-provided wall-clock duration in seconds. Used as a fallback when
  // ffprobe can't read it from the container (MediaRecorder WebM has no
  // duration in the EBML header). Sent by handleStopCapture in the host UI.
  const rawDurationHint = formData.get("durationSec");
  const clientDurationHint =
    typeof rawDurationHint === "string" && Number.isFinite(Number(rawDurationHint))
      ? Number(rawDurationHint)
      : null;

  if (!sessionId || !audioFile) {
    return NextResponse.json({ error: "sessionId and audio are required" }, { status: 400 });
  }

  // Basic MIME type check (browser may send application/octet-stream for blobs)
  const mimeType = audioFile.type || "audio/webm";
  const isAudio = mimeType.startsWith("audio/") || ALLOWED_TYPES.has(mimeType);
  if (!isAudio) {
    return NextResponse.json({ error: "File must be an audio type" }, { status: 400 });
  }

  let meta;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Derive file extension from MIME type
  const ext = extFromMime(mimeType);
  const filename = `reference${ext}`;
  const filePath = join(sessionDir(sessionId), filename);

  // A previous reference recorded in a different container (record once in
  // WebM, then upload an MP3) would otherwise sit in the session dir forever,
  // unreferenced and counted against the disk.
  if (meta.referenceFile && meta.referenceFile !== filename) {
    await unlink(join(sessionDir(sessionId), meta.referenceFile)).catch(() => { /* already gone */ });
  }

  const buffer = Buffer.from(await audioFile.arrayBuffer());
  await writeFile(filePath, buffer);

  // Resolve the reference duration. ffprobe first (reliable for mp3/wav/m4a
  // and OK for files that carry duration in the container); fall back to the
  // client's wall-clock hint when ffprobe returns null — that's the
  // MediaRecorder/WebM case where the EBML header has no duration field.
  const probed = await probeDuration(filePath);
  const referenceDuration =
    probed ?? (clientDurationHint && clientDurationHint > 0 ? clientDurationHint : null);

  meta.referenceFile = filename;
  meta.referenceDuration = referenceDuration;
  if (referenceDuration && referenceDuration > 0) {
    // Sync the session's recordingDuration to the reference length on each
    // upload. The host can still override it later via setRecordingDuration.
    meta.recordingDuration = Math.ceil(referenceDuration);
  }
  await writeSession(meta);

  // The filename is STABLE (`reference.webm`), so the URL has to carry the
  // version or nothing downstream can tell one recording from the next. Record
  // a reference, delete it, record another: same mime, same name, same URL, and
  // the host hears the OLD take — from the browser's HTTP cache, from
  // `waveformCache` in the mixer and from `acquireRefPlayer`, all three of which
  // are keyed by URL string. Every take URL in this app is already stamped this
  // way (`?t=${uploadedAt}`); the reference was the one that was not.
  const url = `/api/play2gether/file/${sessionId}/${filename}?t=${Date.now()}`;
  return NextResponse.json({ url, referenceDuration });
}

/** DELETE /api/play2gether/reference?sessionId=xxx — host removes the reference
 *  so they can re-record or upload a different one. Only clears the base
 *  reference; layered/promoted reference versions are managed by promoteMix. */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  let meta;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (meta.referenceFile) {
    const filePath = join(sessionDir(sessionId), meta.referenceFile);
    await unlink(filePath).catch(() => { /* already gone */ });
    meta.referenceFile = null;
    meta.referenceDuration = null;
    await writeSession(meta);
  }

  return NextResponse.json({ ok: true });
}

function extFromMime(mime: string): string {
  // Strip codec params: MediaRecorder reports e.g. "audio/mp4;codecs=mp4a.40.2"
  // or "audio/webm;codecs=opus", and the Blob carries that full string. Without
  // this, an MP4 take (Safari/iPad) would fall through to the .webm default.
  const base = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
  };
  return map[base] ?? ".webm";
}
