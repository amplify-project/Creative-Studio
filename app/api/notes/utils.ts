import { mkdir, readFile, writeFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// Filesystem layout (mirrors play2gether so deployment ops stay uniform):
//
//   /tmp/notes/<sessionId>/
//     notes.json          ← metadata index
//     <fileId>.<ext>      ← actual file blobs, keyed by random id (not the
//                            user-supplied filename — avoids path traversal
//                            and name collisions)
//
// Files persist per sessionId (recoverable on re-open). No automatic TTL
// today; a sweep can be added later for stale rooms.
export const STORAGE_BASE = "/tmp/notes";

export const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB

// MIME allowlist. Browsers sometimes send `application/octet-stream` for
// drag-and-drop files; the upload route falls back to inspecting the file
// extension when the type is generic.
export const ALLOWED_MIMES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

// Map allowed extensions to a canonical MIME (used when the browser sends
// octet-stream). Keep in sync with ALLOWED_MIMES above.
export const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export type NoteFileStatus = "approved" | "pending";
export type NoteFileRole = "host" | "participant";

export interface NoteFile {
  id: string;
  fileName: string;          // original user-facing name (sanitized)
  mimeType: string;
  size: number;
  ext: string;
  uploaderId: string;
  uploaderName: string;
  uploaderRole: NoteFileRole;
  status: NoteFileStatus;
  uploadedAt: number;
  approvedAt: number | null;
}

export interface NotesIndex {
  sessionId: string;
  files: NoteFile[];
}

export function sessionNotesDir(sessionId: string): string {
  // Strip path separators defensively — sessionId comes from the URL.
  const safe = sessionId.replace(/[^A-Za-z0-9_\-]/g, "_");
  return join(STORAGE_BASE, safe);
}

export async function ensureSessionNotesDir(sessionId: string): Promise<void> {
  await mkdir(sessionNotesDir(sessionId), { recursive: true });
}

export async function readNotes(sessionId: string): Promise<NotesIndex> {
  try {
    const raw = await readFile(join(sessionNotesDir(sessionId), "notes.json"), "utf-8");
    return JSON.parse(raw) as NotesIndex;
  } catch {
    // Missing file or invalid JSON → start fresh
    return { sessionId, files: [] };
  }
}

export async function writeNotes(notes: NotesIndex): Promise<void> {
  await ensureSessionNotesDir(notes.sessionId);
  await writeFile(
    join(sessionNotesDir(notes.sessionId), "notes.json"),
    JSON.stringify(notes, null, 2)
  );
}

/** Locate a note by id, returning both the index and the file entry. */
export async function findNote(
  sessionId: string,
  fileId: string
): Promise<{ index: NotesIndex; file: NoteFile | null }> {
  const index = await readNotes(sessionId);
  const file = index.files.find((f) => f.id === fileId) ?? null;
  return { index, file };
}

/** Resolve the absolute path of a stored file blob. */
export function notePath(sessionId: string, file: NoteFile): string {
  return join(sessionNotesDir(sessionId), `${file.id}.${file.ext}`);
}

/** Best-effort delete of a file blob. Doesn't throw on ENOENT. */
export async function deleteNoteBlob(sessionId: string, file: NoteFile): Promise<void> {
  try {
    await unlink(notePath(sessionId, file));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

/** Verify a stored file blob exists and matches its recorded size. Used
 *  before serving a download so a torn upload can't deliver a partial file. */
export async function noteBlobOk(sessionId: string, file: NoteFile): Promise<boolean> {
  try {
    const st = await stat(notePath(sessionId, file));
    return st.isFile() && st.size === file.size;
  } catch {
    return false;
  }
}

/** Trim a filename to its extension. Returns lowercase, no leading dot. */
export function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** Sanitize a user-supplied filename for display — strip path parts and
 *  control chars; keep the extension so the UI can show it. */
export function sanitizeFileName(name: string): string {
  // Strip directory parts (Windows + Unix)
  const base = name.split(/[\\/]/).pop() ?? "file";
  // Allow letters, digits, dot, dash, underscore, space, parentheses
  const cleaned = base.replace(/[^A-Za-z0-9._\-\s()]/g, "_").trim();
  return cleaned.slice(0, 120) || "file";
}

export function newFileId(): string {
  return randomUUID();
}
