import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { join } from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { authOptions } from "../../auth/auth";
import {
  Play2GetherSession, readSession, writeSession, withSessionLock, sessionDir,
} from "../utils";

/**
 * Pulse grid of the reference, and where a take sits on it.
 *
 * Read `docs/llm/15-beat-grid.md` first. Two calls:
 *
 *   GET  ?sessionId=…   the reference's beats, for drawing the grid. Computed
 *                       once per reference file (~25 s of one core for five
 *                       minutes on the production image) and cached next to it;
 *                       answers `{ status: "computing" }` until it exists, so
 *                       the mixer polls instead of holding a request open.
 *   POST { sessionId, participantId }   the suggested slider value for one take,
 *                       under a second once the grid exists. Stored under
 *                       `beatGrids[takeKey]`, like `alignments`.
 *
 * Informational, like the DTW next to it: the host applies it with a click and
 * nothing seeds itself from it. Its failure mode is pulse vs off-beat on fast,
 * dense material — which it detects and reports (`clear: false`) rather than
 * hiding.
 */

/** The reference pass is the slow one. Measured on node:24.12-alpine with
 *  py3-onnxruntime: 26 s for 300 s of audio. This ceiling is a runaway
 *  detector for a ~15-minute reference, not a budget. */
const GRID_TIMEOUT_MS = 180_000;

type ScriptResult = { ok: boolean; reason?: string; [k: string]: unknown };

/**
 * One computation per reference file at a time, process-wide. The mixer polls
 * GET every few seconds and the host may press Align on several takes while
 * the grid is still being built; without this each of them would start its
 * own 25-second model run on the same file.
 */
const inFlight = new Map<string, Promise<ScriptResult>>();
/** The last failure per reference file, so a poll can say why instead of
 *  silently starting the same failing run every few seconds. */
const failed = new Map<string, { reason: string; at: number }>();
const RETRY_FAILED_AFTER_MS = 5 * 60_000;

function runScript(args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const proc = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, GRID_TIMEOUT_MS);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: e.code === "ENOENT"
          ? "the pulse analyser needs python3 with numpy and onnxruntime, and this server has " +
            "no python3 on PATH — see the Dockerfile's apk line"
          : `could not start the pulse analyser: ${e.message}`,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") return resolve({ ok: false, reason: "the pulse analysis took too long and was stopped" });
      try {
        resolve(JSON.parse(out.trim()) as ScriptResult);
      } catch {
        // The usual cause on a fresh image: `import onnxruntime` failing.
        resolve({
          ok: false,
          reason: code === 0
            ? "the pulse analyser returned nothing readable"
            : `the pulse analyser failed (${code}): ${err.trim().split("\n").pop()?.slice(0, 200) || "no output"}`,
        });
      }
    });
  });
}

const analyser = () => join(process.cwd(), "scripts", "p2g_beat_grid.py");

function paths(sessionId: string, meta: Play2GetherSession) {
  const dir = sessionDir(sessionId);
  const ref = join(dir, meta.referenceFile!);
  return { dir, ref, cache: `${ref}.beats.json` };
}

/** Start (or join) the reference pass. The script itself answers from the
 *  cache when the cache still matches the file, so this is cheap to call. */
function ensureGrid(ref: string, cache: string): Promise<ScriptResult> {
  let p = inFlight.get(ref);
  if (!p) {
    const started = Date.now();
    p = runScript([analyser(), "grid", ref, "--cache", cache]).then((r) => {
      inFlight.delete(ref);
      if (r.ok) failed.delete(ref);
      else failed.set(ref, { reason: r.reason ?? "unknown", at: Date.now() });
      console.log(`[p2g/beatgrid] grid ${ref} -> ` +
        (r.ok ? `${(r.beats as unknown[]).length} beats, ${r.bpm} BPM${r.cached ? " (cached)" : ""}`
              : `failed: ${r.reason}`) + ` (${Date.now() - started} ms)`);
      return r;
    });
    inFlight.set(ref, p);
  }
  return p;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  let meta: Play2GetherSession;
  try { meta = await readSession(sessionId); } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!meta.referenceFile) return NextResponse.json({ status: "none" });
  if (!existsSync(analyser())) {
    return NextResponse.json({ status: "failed", reason: "scripts/p2g_beat_grid.py is missing from the deployed image" });
  }

  const { ref, cache } = paths(sessionId, meta);
  const lastFail = failed.get(ref);
  if (lastFail && Date.now() - lastFail.at < RETRY_FAILED_AFTER_MS && !inFlight.has(ref)) {
    return NextResponse.json({ status: "failed", reason: lastFail.reason });
  }

  // Answer within a moment if the cache is already good; otherwise leave the
  // run going and tell the poller to come back.
  const p = ensureGrid(ref, cache);
  const r = await Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), 1500))]);
  if (!r) return NextResponse.json({ status: "computing" });
  if (!r.ok) return NextResponse.json({ status: "failed", reason: r.reason });
  return NextResponse.json({
    status: "ready",
    referenceFile: meta.referenceFile,
    beats: r.beats, downbeats: r.downbeats, bpm: r.bpm, regularPct: r.regularPct,
  });
}

/** POST { sessionId, participantId } — place one take on the reference's pulse. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { sessionId, participantId } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }
  let meta: Play2GetherSession;
  try { meta = await readSession(sessionId); } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const participant = meta.participants?.[participantId];
  if (!participant?.file) return NextResponse.json({ error: "No take for that participant" }, { status: 404 });
  if (!meta.referenceFile) {
    return NextResponse.json({ error: "This session has no reference to measure against" }, { status: 400 });
  }
  if (!existsSync(analyser())) {
    return NextResponse.json({ ok: false, reason: "scripts/p2g_beat_grid.py is missing from the deployed image" });
  }

  const { dir, ref, cache } = paths(sessionId, meta);
  // Make sure the grid exists (or join the run building it) before the take
  // pass, so two processes never build the same grid side by side.
  const grid = await ensureGrid(ref, cache);
  if (!grid.ok) return NextResponse.json({ ok: false, reason: grid.reason });

  // Centre on a measurement when there is one — the same sources, in the same
  // order, as the DTW (align/route.ts). Never used as a value.
  const pid = participant.participantId ?? participantId;
  const expectMs = meta.calibOffsets?.[pid]?.latencyMs ?? meta.syncOffsets?.[pid]?.offsetMs ?? 0;

  const started = Date.now();
  const r = await runScript([
    analyser(), "align", ref, join(dir, participant.file), "--cache", cache,
    "--expect", String(Math.round(expectMs)),
    "--capture-delay", String(Math.round(participant.captureDelayMs ?? 0)),
  ]);
  const tookMs = Date.now() - started;
  console.log(`[p2g/beatgrid] ${participantId} expect=${Math.round(expectMs)}ms -> ` +
    (r.ok ? `offset=${r.offsetMs}ms alias=${r.aliasRatio}` : `refused: ${r.reason}`) + ` (${tookMs} ms)`);
  if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason ?? "analysis failed" });

  const stored = {
    name: participant.name,
    offsetMs: r.offsetMs as number,
    lagMs: r.lagMs as number,
    aliasRatio: r.aliasRatio as number,
    clear: r.clear === true,
    candidates: (r.candidates as { offsetMs: number; score: number }[]) ?? [],
    centred: r.centred === true,
    atWindowEdge: r.atWindowEdge === true,
    bpm: (r.bpm as number | null) ?? null,
    takeFile: participant.file,
    measuredAt: Date.now(),
  };
  try {
    await withSessionLock(sessionId, async () => {
      const fresh = await readSession(sessionId);
      fresh.beatGrids = { ...(fresh.beatGrids ?? {}), [participantId]: stored };
      await writeSession(fresh);
    });
  } catch (e) {
    console.error("[p2g/beatgrid] could not store the result:", e);
  }
  return NextResponse.json({ ok: true, ...stored, tookMs });
}
