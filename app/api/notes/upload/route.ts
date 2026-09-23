import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { writeFile } from "fs/promises";
import { join } from "path";
import { authOptions } from "../../auth/auth";
import {
  ALLOWED_MIMES,
  EXT_TO_MIME,
  MAX_FILE_SIZE,
  NoteFile,
  ensureSessionNotesDir,
  extOf,
  newFileId,
  readNotes,
  sanitizeFileName,
  sessionNotesDir,
  writeNotes,
} from "../utils";

/**
 * POST /api/notes/upload
 *
 * FormData:
 *   sessionId:     string  (the room id — used to scope storage)
 *   file:          File    (the upload, ≤ 40 MB, PDF/image/audio)
 *   uploaderId:    string  (required for participants without a next-auth session)
 *   uploaderName:  string  (optional display name)
 *
 * Authentication model:
 *   - Both host and participant are authenticated via next-auth (the
 *     /participant route also requires sign-in). What distinguishes them is
 *     the `role` field on the form, which the client sends based on which
 *     page rendered the upload UI.
 *   - role === "host"        → status = "approved" (visible to everyone immediately)
 *   - role === "participant" → status = "pending"  (host must approve)
 *   - No next-auth session   → 401 (anti-spam baseline)
 *
 * We trust the client-supplied role. A malicious participant could claim
 * role=host and self-approve; the worst-case is the real host sees an
 * unexpected approved file in the list and can delete it. For a teaching
 * tool we accept this trade-off (same trust posture as the rest of the app).
 * If a stricter model is needed later: look up the session's true host in
 * Mongo and compare against `session.user.email`.
 */
export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const sessionId = formData.get("sessionId") as string | null;
  const file = formData.get("file") as File | null;
  const claimedRole = formData.get("role") as string | null;

  if (!sessionId || !file) {
    return NextResponse.json({ error: "sessionId and file are required" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large (max ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB)` },
      { status: 413 }
    );
  }

  // Normalize MIME: browsers often hand octet-stream for drag-and-drop
  // uploads, so fall back to mapping the extension.
  const ext = extOf(file.name);
  let mimeType = file.type || "";
  if (mimeType === "application/octet-stream" || !mimeType) {
    mimeType = EXT_TO_MIME[ext] ?? mimeType;
  }
  if (!ALLOWED_MIMES.has(mimeType)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${mimeType || ext || "unknown"}` },
      { status: 415 }
    );
  }

  // Pick the canonical extension matching the validated MIME. Prefer the
  // user-supplied extension when it agrees, otherwise look up by mime.
  const canonicalExt =
    ext && EXT_TO_MIME[ext] === mimeType
      ? ext
      : Object.entries(EXT_TO_MIME).find(([, m]) => m === mimeType)?.[0] ?? "bin";

  // Identity / role resolution. Both /host and /participant are next-auth
  // authenticated; the role distinguishes them (trusted from the client).
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const isHost = claimedRole === "host";
  const uploaderId =
    ((session as any)?.uid as string | undefined) ??
    session.user.email ??
    "anonymous";
  const uploaderName =
    session.user.name ??
    session.user.email?.split("@")[0] ??
    "User";

  await ensureSessionNotesDir(sessionId);

  const fileId = newFileId();
  const fileName = sanitizeFileName(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());

  await writeFile(join(sessionNotesDir(sessionId), `${fileId}.${canonicalExt}`), buffer);

  const noteFile: NoteFile = {
    id: fileId,
    fileName,
    mimeType,
    size: file.size,
    ext: canonicalExt,
    uploaderId,
    uploaderName,
    uploaderRole: isHost ? "host" : "participant",
    status: isHost ? "approved" : "pending",
    uploadedAt: Date.now(),
    approvedAt: isHost ? Date.now() : null,
  };

  const notes = await readNotes(sessionId);
  notes.files.push(noteFile);
  await writeNotes(notes);

  return NextResponse.json({ file: noteFile });
}
