import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { readSession, writeSession, sessionDir } from "../utils";

/** Maximum LRC size — songs rarely exceed a few KB even with metadata tags. */
const MAX_BYTES = 200 * 1024;

/** POST /api/play2gether/lyrics
 *  Body: FormData { sessionId: string, lyrics: File (.lrc) }
 *  Host-only. Stores `lyrics.lrc` alongside the reference and updates
 *  meta.lyricsFile so participants can fetch + render it.
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
  const lyricsFile = formData.get("lyrics") as File | null;

  if (!sessionId || !lyricsFile) {
    return NextResponse.json({ error: "sessionId and lyrics are required" }, { status: 400 });
  }
  if (lyricsFile.size > MAX_BYTES) {
    return NextResponse.json({ error: `Lyrics file too large (max ${MAX_BYTES / 1024} KB)` }, { status: 400 });
  }

  let meta;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const filename = "lyrics.lrc";
  const filePath = join(sessionDir(sessionId), filename);
  const buffer = Buffer.from(await lyricsFile.arrayBuffer());
  await writeFile(filePath, buffer);

  meta.lyricsFile = filename;
  await writeSession(meta);

  // Fixed filename, so the URL carries the version — otherwise re-uploading
  // corrected lyrics shows the old ones from cache.
  const url = `/api/play2gether/file/${sessionId}/${filename}?t=${Date.now()}`;
  return NextResponse.json({ url });
}

/** DELETE /api/play2gether/lyrics?sessionId=xxx — host removes the lyrics. */
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

  if (meta.lyricsFile) {
    const filePath = join(sessionDir(sessionId), meta.lyricsFile);
    await unlink(filePath).catch(() => { /* already gone */ });
    meta.lyricsFile = null;
    await writeSession(meta);
  }

  return NextResponse.json({ ok: true });
}
