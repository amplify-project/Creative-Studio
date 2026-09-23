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
 * Align one take against the reference it was recorded over, with DTW.
 *
 * Read `docs/llm/12-dtw-alignment.md` first. The short version of why this is a
 * route and not part of the upload: it measures THE TAKE, so unlike the
 * calibration and sync rounds it can only run after the take exists — and it is
 * the host who decides a take is worth analysing, which is why nothing calls
 * this automatically.
 *
 * It is informational. The number lands next to the other two in the take's
 * drawer and the host can click it onto the slider; nothing seeds itself from
 * it. That is not timidity — the method's failure mode is a confident answer a
 * beat out on periodic material (see the doc), and the whole reason the other
 * two measurements survive is that they fail visibly instead.
 */

/** Wall-clock ceiling for one analysis. Measured 2026-09-03: a 5-minute pair
 *  takes 2.4 s and 247 MB. A minute is therefore not a budget, it is a
 *  runaway detector — for a process that would otherwise hold a request open
 *  forever if python were missing or a file were unreadable. */
const ANALYSIS_TIMEOUT_MS = 60_000;

type DtwResult = {
  ok: boolean;
  reason?: string;
  offsetMs?: number;
  lagMs?: number;
  madMs?: number;
  drift?: { tSec: number; lagMs: number }[];
  driftRangeMs?: number;
  feature?: string;
  atBandEdge?: boolean;
};

function runAnalysis(args: string[]): Promise<DtwResult> {
  return new Promise((resolve) => {
    // `python3` off PATH on purpose: the box already runs the agents' venvs and
    // this needs nothing but numpy, which every one of them has. A dedicated
    // interpreter path would be one more thing to keep true across deploys.
    const proc = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, ANALYSIS_TIMEOUT_MS);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT here is the deployment, not the take, and the raw message
      // ("spawn python3 ENOENT") sends whoever reads it looking at the audio.
      // It happened on the first real deploy: the webapp image is
      // node:24.12-alpine and had ffmpeg but no python.
      resolve({
        ok: false,
        reason: e.code === "ENOENT"
          ? "the analyser needs python3 with numpy and this server has no python3 " +
            "on PATH. Add `python3 py3-numpy` to the image's apk line (see the " +
            "Dockerfile) and redeploy — nothing is wrong with the take"
          : `could not start the analyser: ${e.message}`,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") {
        return resolve({ ok: false, reason: "the analysis took too long and was stopped" });
      }
      try {
        resolve(JSON.parse(out.trim()) as DtwResult);
      } catch {
        resolve({
          ok: false,
          reason: code === 0
            ? "the analyser returned nothing readable"
            : `the analyser failed (${code}): ${err.trim().slice(0, 200) || "no output"}`,
        });
      }
    });
  });
}

/** POST { sessionId, participantId, feature? } — analyse one take. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { sessionId, participantId, feature } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }
  const feat = feature === "chroma" ? "chroma" : "melflux";

  let meta: Play2GetherSession;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const participant = meta.participants?.[participantId];
  if (!participant?.file) {
    return NextResponse.json({ error: "No take for that participant" }, { status: 404 });
  }
  if (!meta.referenceFile) {
    return NextResponse.json({ error: "This session has no reference to align against" }, { status: 400 });
  }

  const dir = sessionDir(sessionId);
  // The calibration figure CENTRES the search and is never used as a value —
  // the same discipline `searchWindow` follows in syncDetect.ts, and for the
  // same reason: on periodic material a lag and that lag plus one bar explain
  // the audio equally well, and only a band too narrow to hold both makes the
  // answer unique. Measured on a deliberately looped file: +-0.5 s with no
  // centre gave a 186 ms MAD and a wandering drift; +-0.2 s centred on the
  // calibration gave the right answer.
  const pid = participant.participantId ?? participantId;
  const expectMs = meta.calibOffsets?.[pid]?.latencyMs
    ?? meta.syncOffsets?.[pid]?.offsetMs
    ?? 0;
  const bandSec = expectMs > 0 ? 0.25 : 0.5;

  // Named before spawning, so "the script is not in the image" and "python is
  // not in the image" are two different sentences rather than one ENOENT.
  const analyser = join(process.cwd(), "scripts", "p2g_dtw_align.py");
  if (!existsSync(analyser)) {
    console.error(`[p2g/align] analyser missing at ${analyser}`);
    return NextResponse.json({
      ok: false,
      reason: "the analyser script is not on this server — `scripts/p2g_dtw_align.py` " +
              "is missing from the deployed image",
    });
  }

  const started = Date.now();
  const result = await runAnalysis([
    analyser,
    join(dir, meta.referenceFile),
    join(dir, participant.file),
    "--feature", feat,
    "--expect", String(Math.round(expectMs)),
    "--band", String(bandSec),
    "--capture-delay", String(Math.round(participant.captureDelayMs ?? 0)),
  ]);
  const tookMs = Date.now() - started;
  console.log(`[p2g/align] ${participantId} feature=${feat} expect=${Math.round(expectMs)}ms -> ` +
    (result.ok ? `lag=${result.lagMs}ms mad=${result.madMs}ms drift=${result.driftRangeMs}ms`
               : `refused: ${result.reason}`) + ` (${tookMs}ms)`);

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason ?? "analysis failed" });
  }

  // Stored so it survives the host's poll and a panel remount — a number the
  // host has to re-earn every time they scroll is a number they stop using.
  // Keyed by participant like the other two, but stamped with the take it was
  // computed FROM: a re-recorded take invalidates it, and silently keeping it
  // would be describing one performance with another one's measurement.
  try {
    await withSessionLock(sessionId, async () => {
      const fresh = await readSession(sessionId);
      fresh.alignments = {
        ...(fresh.alignments ?? {}),
        [participantId]: {
          name: participant.name,
          offsetMs: result.offsetMs!,
          lagMs: result.lagMs!,
          madMs: result.madMs!,
          driftRangeMs: result.driftRangeMs ?? 0,
          drift: result.drift ?? [],
          feature: feat,
          atBandEdge: result.atBandEdge === true,
          takeFile: participant.file,
          measuredAt: Date.now(),
        },
      };
      await writeSession(fresh);
    });
  } catch (e) {
    console.error("[p2g/align] could not store the result:", e);
    // The number is still returned: failing to write the index is not a reason
    // to throw away a measurement the host is waiting for.
  }

  // Whether the band had a centre to sit on. Measured on the fixtures: with a
  // centre the aligner scores 7 good / 3 fair / 2 bad, blind it scores 4 / 5 / 3.
  // The host should know which of those two they are looking at.
  return NextResponse.json({ ok: true, ...result, centred: expectMs > 0, tookMs });
}
