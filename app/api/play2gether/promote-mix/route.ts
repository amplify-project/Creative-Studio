import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { copyFile } from "fs/promises";
import { join } from "path";
import { readSession, writeSession, sessionDir, probeDuration, transcodeToWav, type Play2GetherSession } from "../utils";

/**
 * POST /api/play2gether/promote-mix
 * Body: { sessionId: string, sourceFile?: string }
 * Authenticated (host only).
 *
 * Promotes a track to be the new reference for the next recording round.
 * `sourceFile` can be any participant take filename (e.g. "rec_Alice.wav")
 * or omitted to use the current mix result (mix.webm).
 *
 * The source file is copied to a versioned name (reference_v2.wav, …) so
 * all previous references remain on disk.
 *
 * Side-effects on the session:
 *   - referenceFile → new versioned filename
 *   - referenceDuration → probed from the new file
 *   - recordingDuration → ceil(referenceDuration) if detected
 *   - referenceVersion → incremented
 *   - participants → cleared (old takes are baked into the new reference)
 *   - resultFile → null
 *   - status → "preparing" (ready for the next round)
 *
 * Returns: { url: string, referenceDuration: number | null }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId, sourceFile }: { sessionId?: string; sourceFile?: string } = await req.json();
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  let meta: Play2GetherSession;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Determine which file to promote. If sourceFile is provided, validate it
  // belongs to this session (allowlist check prevents path traversal).
  let srcFilename: string;
  if (sourceFile) {
    const allowed = new Set<string>(
      [meta.resultFile, ...Object.values(meta.participants).map((p) => p.file)]
        .filter((f): f is string => !!f)
    );
    if (!allowed.has(sourceFile)) {
      return NextResponse.json({ error: "sourceFile not found in session" }, { status: 400 });
    }
    srcFilename = sourceFile;
  } else {
    if (!meta.resultFile) {
      return NextResponse.json({ error: "No mix result to promote" }, { status: 400 });
    }
    srcFilename = meta.resultFile;
  }

  const dir = sessionDir(sessionId);
  const version = (meta.referenceVersion ?? 1) + 1;
  const dotIdx = srcFilename.lastIndexOf(".");
  const srcExt = dotIdx !== -1 ? srcFilename.slice(dotIdx) : ".webm";
  const srcPath = join(dir, srcFilename);

  // Takes are stored as Opus (see record route), but a promoted take becomes
  // the REFERENCE, and the reference is decoded in the browser with
  // decodeAudioData on the sync-critical path — Safari can't do that with
  // Opus and falls back to el.play(), which costs ~100 ms of unmeasured start
  // delay (docs/llm/01-play2gether.md). So a promoted take is decoded back to
  // WAV here. There is one reference per round, so unlike the takes its size
  // doesn't scale with the number of singers.
  //
  // The mix result (mix.webm) is copied as-is, exactly as before — that path
  // already carried Opus-in-WebM and changing it is a separate decision.
  const isTake = srcFilename !== meta.resultFile;
  const needsDecode = isTake && srcExt === ".ogg";
  const ext = needsDecode ? ".wav" : srcExt;
  const newRefFilename = `reference_v${version}${ext}`;
  const destPath = join(dir, newRefFilename);

  if (needsDecode) {
    if (!(await transcodeToWav(srcPath, destPath))) {
      return NextResponse.json({ error: "Could not prepare the take as a reference" }, { status: 500 });
    }
  } else {
    await copyFile(srcPath, destPath);
  }

  const referenceDuration = await probeDuration(destPath);

  meta.referenceFile = newRefFilename;
  meta.referenceDuration = referenceDuration;
  if (referenceDuration && referenceDuration > 0) {
    meta.recordingDuration = Math.ceil(referenceDuration);
  }
  meta.referenceVersion = version;
  meta.participants = {};
  // `meta.syncOffsets` and `meta.calibOffsets` deliberately survive. Both
  // describe a person's ears and device, not a take, so they stay valid across
  // layers — and re-measuring the whole band on every promote would be the
  // opposite of the point, which is to measure once per session.
  meta.resultFile = null;
  meta.status = "preparing";
  await writeSession(meta);

  const url = `/api/play2gether/file/${sessionId}/${newRefFilename}`;
  return NextResponse.json({ url, referenceDuration });
}
