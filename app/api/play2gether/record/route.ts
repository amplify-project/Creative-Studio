import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { rename, unlink, stat, writeFile } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  readSession, writeSession, sessionDir, ensureSessionDir, withSessionLock,
  transcodeToOpus, computeEnvelopes,
  Play2GetherSession,
} from "../utils";
import { detectSyncOffset } from "../syncDetect";
import { SYNC_BPM } from "../../../lib/p2gSync";

// Hard cap on payload size. nginx enforces 50M at its edge — set in
// server/nginx/templates/nginx.conf.template, NOT in the generated
// nginx.conf. This is a server-side defence in depth and stays above it.
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** POST /api/play2gether/record
 *
 * Streaming raw-body upload. Metadata travels in URL query params:
 *   ?sessionId=…&participantId=…&participantName=…&clapOffset=…
 * Body: raw WAV bytes (no multipart). Client sets `Content-Type: audio/wav`.
 *
 * Previous implementation used `await req.formData()`, which buffers the
 * ENTIRE multipart body in RAM before returning. With four 5.7 MB uploads
 * arriving simultaneously, that's ~50–70 MB of transient JS heap pressure
 * (FormData double-buffers); the Next.js process swaps or stalls, the
 * event loop can't service polls or other requests, and every client gets
 * stuck on "Uploading…". This route streams the body directly to a temp
 * file on disk — memory cost per upload is O(chunk_size), ~64 KB, so 4
 * concurrent uploads peak around 256 KB transient instead of tens of MB.
 *
 * Flow:
 *   1. Pre-check session exists (fast 404 instead of wasted upload).
 *   2. Stream body to a UUID-named temp file in the session dir.
 *      OUTSIDE the lock — different participants' uploads run in parallel.
 *   3. Under the per-session lock: read meta, compute take slot, rename the
 *      temp file to its final name, update session.json.
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  console.log(`[p2g/record ${reqId}] START`);

  const session = await getServerSession(authOptions);
  if (!session) {
    console.warn(`[p2g/record ${reqId}] 401 unauthorized after ${Date.now() - t0}ms`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const participantId = url.searchParams.get("participantId");
  const participantNameRaw = url.searchParams.get("participantName");
  const clapOffsetRaw = url.searchParams.get("clapOffset");
  // Whether clapOffset came from acoustic calibration (trusted) vs browser
  // auto-detection (unreliable). Informational — surfaced in the mixer UI.
  const calibrated = url.searchParams.get("calibrated") === "1";
  // Deterministic residual capture-start delay (ms) after prewarm+gate. The
  // mixer pads the take by this much so it doesn't run ahead of the reference.
  const captureDelayRaw = url.searchParams.get("captureDelayMs");
  // "sync" = a sync-round take: a click-only recording of the participant
  // playing quarter notes, uploaded to be MEASURED rather than mixed. It never
  // enters `meta.participants` — see the sync branch below.
  const kind = url.searchParams.get("kind") === "sync" ? "sync" : "take";
  // Present only on a test take (a file sent instead of the mic, delayed by
  // this much — see app/lib/p2gTestTrack.ts). Stored so the mixer can show the
  // right answer next to every measurement. Clamped like captureDelayMs.
  const simulatedRaw = url.searchParams.get("simulatedLatencyMs");
  const simulatedParsed = simulatedRaw != null ? parseInt(simulatedRaw, 10) : NaN;
  const simulatedLatencyMs = Number.isFinite(simulatedParsed)
    ? Math.min(2000, Math.max(0, simulatedParsed))
    : undefined;

  if (!sessionId || !participantId) {
    return NextResponse.json(
      { error: "sessionId and participantId are required (as query params)" },
      { status: 400 }
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: "request body is empty" }, { status: 400 });
  }

  const clapOffset = clapOffsetRaw ? parseInt(clapOffsetRaw, 10) : 0;
  if (isNaN(clapOffset) || clapOffset < 0) {
    return NextResponse.json({ error: "clapOffset must be a non-negative integer (ms)" }, { status: 400 });
  }

  // Clamp defensively — a garbage/huge value must not shove a take seconds late.
  const captureDelayParsed = captureDelayRaw ? parseInt(captureDelayRaw, 10) : 0;
  const captureDelayMs = Number.isFinite(captureDelayParsed)
    ? Math.min(2000, Math.max(0, captureDelayParsed))
    : 0;

  // Defensive size check via Content-Length. nginx's body-size limit fires
  // first, but if the client somehow lies about length we'll cut off at
  // MAX_UPLOAD_BYTES while streaming below.
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  // Fail fast if the session doesn't exist (avoid wasting a multi-MB upload).
  try {
    await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Stream body → temp file. UUID-named so concurrent uploads from different
  // participants don't collide. NOT under the lock — disk writes parallelize.
  await ensureSessionDir(sessionId);
  const tempName = `_tmp_${randomUUID()}.wav`;
  const tempPath = join(sessionDir(sessionId), tempName);
  console.log(`[p2g/record ${reqId}] streaming to temp (+${Date.now() - t0}ms, content-length=${contentLength})`);

  try {
    const nodeReadable = Readable.fromWeb(req.body as any);
    await pipeline(nodeReadable, createWriteStream(tempPath));
  } catch (e) {
    console.error(`[p2g/record ${reqId}] streaming failed after ${Date.now() - t0}ms:`, e);
    try { await unlink(tempPath); } catch { /* noop */ }
    return NextResponse.json({ error: "Upload stream failed" }, { status: 500 });
  }

  let actualSize = 0;
  try {
    const st = await stat(tempPath);
    actualSize = st.size;
  } catch {
    return NextResponse.json({ error: "Temp file vanished" }, { status: 500 });
  }
  if (actualSize > MAX_UPLOAD_BYTES) {
    try { await unlink(tempPath); } catch { /* noop */ }
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  if (actualSize === 0) {
    try { await unlink(tempPath); } catch { /* noop */ }
    return NextResponse.json({ error: "empty audio" }, { status: 400 });
  }
  // Time from handler entry to the body being fully on disk. This is the only
  // honest measure of the client's UPLINK: the client's own fetch wall-clock
  // includes everything below (transcode, peaks, lock, session.json), so using
  // it as a bandwidth figure understates a good link on a busy server. Returned
  // to the client so its telemetry can report transfer and processing apart.
  const recvMs = Date.now() - t0;
  console.log(`[p2g/record ${reqId}] streamed ${(actualSize / 1048576).toFixed(2)}MB (+${recvMs}ms)`);

  // ── Sync round: measure, don't store a take ───────────────────────────────
  //
  // A sync round produces a number, not a track. The audio is kept (small, and
  // the host may want to hear why a result looks odd) but it lives outside
  // `meta.participants` so it can never be swept into a mix, and it is keyed by
  // participantId rather than by take, because what it measures belongs to the
  // person: their device round trip plus where they place a beat.
  //
  // Detection runs on the WAV that just landed, BEFORE the Opus transcode
  // below. The transcode is almost certainly transparent to an attack time, but
  // "almost certainly" is not a thing to spend on a measurement whose whole job
  // is to be trusted to a few milliseconds when the raw bytes are already here.
  if (kind === "sync") {
    // The tempo is NOT a request parameter. Freedom from beat-aliasing is an
    // arithmetic property of SYNC_BPM against the detector's lag range (doc 11),
    // so letting a client name the tempo would let it name a tempo at which the
    // answer is a whole beat out. Both sides import the same constant.
    const participantName = (participantNameRaw && participantNameRaw.trim()) || participantId;

    // `clapOffset` is handed over to CENTRE the lag search, not to correct
    // anything with. Doc 11 removed it as a mixing number and that stands — it
    // is far too unstable to be one. Choosing between candidate lags a whole
    // beat apart is a much coarser question than mixing, and it is the only
    // question it gets asked. See `searchWindow()` in syncDetect.ts.
    const seedRaw = parseInt(url.searchParams.get("syncSeed") ?? "0", 10);
    const jitterRaw = parseInt(url.searchParams.get("syncJitterMs") ?? "0", 10);
    const detected = await detectSyncOffset(tempPath, {
      bpm: SYNC_BPM,
      captureDelayMs,
      deviceLatencyMs: clapOffset,
      // The grid the client actually played. Absent (an older client, or a
      // plain round) means the ideal grid, which is what these default to.
      seed: Number.isFinite(seedRaw) ? seedRaw : 0,
      jitterMs: Number.isFinite(jitterRaw) && jitterRaw > 0 ? jitterRaw : 0,
    });
    const measured = detected.ok ? detected.result : null;
    console.log(
      `[p2g/record ${reqId}] sync detect: ` +
      (measured
        ? `offset=${measured.offsetMs}ms spread=${measured.spreadMs}ms ` +
          `hits=${measured.hits}/${measured.expected}` +
          (measured.atSearchEdge ? " AT-SEARCH-EDGE" : "")
        : `refused: ${detected.reason}`) +
      ` (+${Date.now() - t0}ms)`
    );

    // Keep the audio in whichever format survives; a failed transcode is not a
    // reason to lose the evidence behind a number the host is going to trust.
    let syncPath = tempPath;
    let syncExt = ".wav";
    const tmpOgg = join(sessionDir(sessionId), `_tmp_${randomUUID()}.ogg`);
    if (await transcodeToOpus(tempPath, tmpOgg)) {
      let size = 0;
      try { size = (await stat(tmpOgg)).size; } catch { /* handled below */ }
      if (size > 0) {
        syncPath = tmpOgg;
        syncExt = ".ogg";
        await unlink(tempPath).catch(() => { /* noop */ });
      } else {
        await unlink(tmpOgg).catch(() => { /* noop */ });
      }
    } else {
      await unlink(tmpOgg).catch(() => { /* noop */ });
    }

    const safeSyncId = participantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
    const syncFile = `sync_${safeSyncId}${syncExt}`;

    try {
      await withSessionLock(sessionId, async () => {
        let meta: Play2GetherSession;
        try {
          meta = await readSession(sessionId);
        } catch {
          return;
        }
        // One sync take per person: re-running replaces the previous file and
        // the previous number, which is what "run it again" has to mean.
        const prev = meta.syncOffsets?.[participantId]?.file;
        if (prev && prev !== syncFile) {
          await unlink(join(sessionDir(sessionId), prev)).catch(() => { /* noop */ });
        }
        await rename(syncPath, join(sessionDir(sessionId), syncFile));

        if (measured) {
          meta.syncOffsets = {
            ...(meta.syncOffsets ?? {}),
            [participantId]: {
              ...measured,
              name: participantName,
              measuredAt: Date.now(),
              file: syncFile,
            },
          };
          // A measurement that worked clears the reason it previously didn't.
          if (meta.failures?.[participantId]) delete meta.failures[participantId];
        } else {
          // Reuse the failure channel the host panel already renders, so a
          // refused measurement is as visible as a dropped take — the whole
          // point of the round is that nobody discovers this in the mix.
          meta.failures = {
            ...(meta.failures ?? {}),
            [participantId]: {
              name: participantName,
              reason: `Sync round: ${detected.reason}`,
              clapAt: null,
              at: Date.now(),
            },
          };
          // A refused re-run must not leave the old number standing as if it
          // still described this person.
          if (meta.syncOffsets?.[participantId]) delete meta.syncOffsets[participantId];
        }
        await writeSession(meta);
      });
    } catch (e) {
      console.error(`[p2g/record ${reqId}] sync write failed:`, e);
      try { await unlink(syncPath); } catch { /* noop */ }
      return NextResponse.json({ error: "Internal error writing sync result" }, { status: 500 });
    }

    console.log(`[p2g/record ${reqId}] DONE (sync) in ${Date.now() - t0}ms`);
    return NextResponse.json({
      ok: true, kind: "sync", participantId,
      ...(measured ? { sync: measured } : { syncRefused: detected.reason }),
      recvMs, serverMs: Date.now() - t0,
    });
  }

  // ── Transcode WAV → Opus, and precompute the waveform envelope ────────────
  // Both run OUTSIDE the session lock: they are the CPU-heavy part of this
  // request and they only touch this upload's own temp files, so several
  // participants finishing at once still process in parallel.
  //
  // The client captures to WAV because that is what an AudioWorklet can emit
  // without a muxer, but WAV is the one thing in a session whose size scales
  // with the number of singers (768 kbps each). Storing Opus cuts disk and
  // every later download by 8x. If ffmpeg is missing or fails we simply keep
  // the WAV — a working take in the wrong format beats a lost take.
  let uploadPath = tempPath;
  let ext = ".wav";
  const tempOpusPath = join(sessionDir(sessionId), `_tmp_${randomUUID()}.ogg`);
  if (await transcodeToOpus(tempPath, tempOpusPath)) {
    let opusSize = 0;
    try { opusSize = (await stat(tempOpusPath)).size; } catch { /* handled below */ }
    if (opusSize > 0) {
      uploadPath = tempOpusPath;
      ext = ".ogg";
      await unlink(tempPath).catch(() => { /* noop */ });
      console.log(
        `[p2g/record ${reqId}] transcoded to opus ${(opusSize / 1048576).toFixed(2)}MB ` +
        `(${(actualSize / opusSize).toFixed(1)}x smaller, +${Date.now() - t0}ms)`
      );
    } else {
      await unlink(tempOpusPath).catch(() => { /* noop */ });
    }
  } else {
    await unlink(tempOpusPath).catch(() => { /* noop */ });
    console.warn(`[p2g/record ${reqId}] opus transcode failed — keeping WAV`);
  }

  const envelopes = await computeEnvelopes(uploadPath);
  const peaks = envelopes?.peaks ?? null;
  console.log(
    `[p2g/record ${reqId}] peaks ${peaks ? "computed" : "unavailable"}` +
    (envelopes?.detail ? ` (+detail ${(envelopes.detail.length / 1024).toFixed(0)}KB)` : "") +
    ` (+${Date.now() - t0}ms)`
  );

  const participantName = (participantNameRaw && participantNameRaw.trim()) || participantId;
  const safeName = participantName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 48)
    || participantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);

  try {
    const result = await withSessionLock(sessionId, async () => {
      console.log(`[p2g/record ${reqId}] lock acquired (+${Date.now() - t0}ms)`);
      let meta: Play2GetherSession;
      try {
        meta = await readSession(sessionId);
      } catch {
        return { error: "Session not found" as const, status: 404 };
      }

      // Find an available take slot. Take 1 keeps the identity as its key
      // (back-compat). Take N>1 gets `${identity}_N` so previous takes stay
      // intact for the host to delete via the mixer UI.
      let takeNum = 1;
      let takeKey = participantId;
      while (meta.participants[takeKey]) {
        takeNum++;
        takeKey = `${participantId}_${takeNum}`;
      }

      let filename = takeNum === 1
        ? `rec_${safeName}${ext}`
        : `rec_${safeName}_${takeNum}${ext}`;
      // Disambiguate if a DIFFERENT participant already owns this filename
      // (two people with the same display name in one session).
      const collides = Object.entries(meta.participants).some(
        ([id, p]) => id !== takeKey && p.file === filename
      );
      if (collides) {
        const safeId = participantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 6);
        filename = takeNum === 1
          ? `rec_${safeName}_${safeId}${ext}`
          : `rec_${safeName}_${safeId}_${takeNum}${ext}`;
      }

      // Promote the temp file to its final name. `rename` is atomic on the
      // same filesystem (no half-written final state visible to readers).
      const finalPath = join(sessionDir(sessionId), filename);
      await rename(uploadPath, finalPath);
      console.log(`[p2g/record ${reqId}] renamed → ${filename} (+${Date.now() - t0}ms)`);

      // Sidecar envelope, named off the take so it's obvious what it belongs
      // to and so deleting a take can delete it too.
      const stem = filename.slice(0, filename.lastIndexOf("."));
      let peaksFile: string | undefined;
      if (peaks) {
        peaksFile = `${stem}.peaks.json`;
        try {
          await writeFile(join(sessionDir(sessionId), peaksFile), JSON.stringify(peaks));
        } catch (e) {
          console.warn(`[p2g/record ${reqId}] peaks write failed:`, e);
          peaksFile = undefined; // client falls back to decoding the audio
        }
      }
      // High-resolution envelope for the mixer's zoom. Independent of the JSON
      // above: losing one must not cost the other, since they serve different
      // zoom levels and either alone is still useful.
      let peaksBinFile: string | undefined;
      if (envelopes?.detail) {
        peaksBinFile = `${stem}.peaks.bin`;
        try {
          await writeFile(join(sessionDir(sessionId), peaksBinFile), envelopes.detail);
        } catch (e) {
          console.warn(`[p2g/record ${reqId}] detail peaks write failed:`, e);
          peaksBinFile = undefined;
        }
      }

      meta.participants[takeKey] = {
        file: filename,
        peaksFile,
        peaksBinFile,
        name: participantName,
        participantId,
        takeNum,
        clapOffset,
        calibrated,
        captureDelayMs,
        simulatedLatencyMs,
        // How loud this take is, from the same decode the envelopes came from.
        // `undefined` rather than null when the measurement failed, so it reads
        // the same as a take recorded before this existed and the mixer has one
        // case to handle instead of two.
        levelDb: envelopes?.levelDb ?? undefined,
        peakDb: envelopes?.peakDb ?? undefined,
        uploadedAt: Date.now(),
      };
      // A successful take clears any earlier failure report for this
      // participant so the host stops seeing a stale "recording failed".
      if (meta.failures && meta.failures[participantId]) {
        delete meta.failures[participantId];
      }
      // …and whatever DTW alignment was stored for this SLOT. Take keys are
      // reused: delete take 1 and the next upload is `participantId` again with
      // the same `rec_<name>.ogg` filename, so the client's "does the stored
      // takeFile still match" staleness check cannot see that the performance
      // changed. It then showed a number measured from a take that no longer
      // exists, and — because the row only offers the Align button when there
      // is nothing to show — no way to measure the new one.
      if (meta.alignments && meta.alignments[takeKey]) {
        delete meta.alignments[takeKey];
      }
      await writeSession(meta);
      console.log(`[p2g/record ${reqId}] session.json updated (+${Date.now() - t0}ms, participants=${Object.keys(meta.participants).length})`);

      return { ok: true as const, takeKey, takeNum };
    });

    if ("error" in result) {
      try { await unlink(uploadPath); } catch { /* might already be gone */ }
      console.warn(`[p2g/record ${reqId}] ${result.status} ${result.error} after ${Date.now() - t0}ms`);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    console.log(`[p2g/record ${reqId}] DONE in ${Date.now() - t0}ms`);
    return NextResponse.json({
      ok: true, participantId, takeKey: result.takeKey, takeNum: result.takeNum,
      // Server-side timings for client telemetry (see `recvMs` above).
      recvMs, serverMs: Date.now() - t0,
    });
  } catch (e) {
    try { await unlink(uploadPath); } catch { /* noop */ }
    console.error(`[p2g/record ${reqId}] unexpected error after ${Date.now() - t0}ms:`, e);
    return NextResponse.json({ error: "Internal error writing take" }, { status: 500 });
  }
}

/** DELETE /api/play2gether/record
 * Body: { sessionId: string, participantId: string }
 * Host removes a participant's recording from the session (unlinks the file
 * and drops the entry from session.json). Used to discard old takes before
 * mixing.
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId, participantId } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }

  let meta: Play2GetherSession;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const participant = meta.participants[participantId];
  if (participant) {
    try {
      await unlink(join(sessionDir(sessionId), participant.file));
    } catch { /* file may already be gone — proceed with metadata cleanup */ }
    if (participant.peaksFile) {
      // Sidecar envelope. Orphaned peaks are harmless but they'd accumulate.
      await unlink(join(sessionDir(sessionId), participant.peaksFile)).catch(() => { /* noop */ });
    }
    if (participant.peaksBinFile) {
      await unlink(join(sessionDir(sessionId), participant.peaksBinFile)).catch(() => { /* noop */ });
    }
    delete meta.participants[participantId];
    // The alignment describes THIS performance and nothing else. Leaving it
    // behind is how a re-recorded take inherits the previous one's number (see
    // the note in POST).
    if (meta.alignments?.[participantId]) delete meta.alignments[participantId];
    await writeSession(meta);
  }

  return NextResponse.json({ ok: true });
}
