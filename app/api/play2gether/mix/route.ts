import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { join } from "path";
import { readSession, writeSession, sessionDir } from "../utils";

/**
 * Master output level. Two jobs the per-track faders could not do at once.
 *
 * `amix` runs with `normalize=0`, so until this existed the ABSOLUTE value of
 * the faders also set the loudness of the render: a host who pulled a dominant
 * take down to let a quiet one through made the whole mix quieter, and could
 * not fix that without undoing the balance they had just set. Measured on the
 * 2026-09-04 session: matching two takes 21.7 dB apart cost 9 dB of output
 * (-24.5 -> -33.4 dBFS) with 14 dB of headroom sitting unused.
 *
 * A master scales every track by the SAME number, so it cannot change the
 * balance — that is arithmetic, not judgement. This is why it is a plain
 * `volume` and not `loudnorm`/`dynaudnorm`/a limiter: those act differently
 * depending on what is playing, which does change the balance and the music.
 *
 * It also closes a silent failure. With `normalize=0` and faders up to 2, a
 * busy round could sum past full scale and clip with nothing reporting it;
 * measuring the peak and scaling to sit under the ceiling fixes that in the
 * same step, because the gain is as free to be negative as positive.
 */
const MASTER_TARGET_PEAK_DB = -2;
/*  Why -2 and not -1. The peak is measured on the UNCOMPRESSED render, but what
 *  ships is Opus, and a lossy codec does not reproduce sample values exactly —
 *  a signal mastered to -1 dBFS decodes above it. Measured on the 2026-09-04
 *  session: a render landed at -1.08 dBFS at its native 48 kHz, and the SAME
 *  file resampled to 16 kHz mono peaked at +1.95 dBFS, because resampling
 *  reconstructs between the samples and the reconstruction overshoots. Any
 *  playback chain that resamples (most of them do) sees that overshoot, and a
 *  16-bit output stage clips it. A decibel of margin costs nothing audible. */
/** Ceiling on the BOOST only. A nearly silent mix must not be lifted 40 dB —
 *  that amplifies the room and the mic hiss with it, and the take that made it
 *  silent is the thing to fix. Attenuation is deliberately unbounded: never
 *  refuse to prevent clipping. */
const MASTER_MAX_BOOST_DB = 12;

/** POST /api/play2gether/mix
 * Body: { sessionId: string }
 * Only the host (authenticated) triggers the mix.
 *
 * Alignment logic (mix as recorded):
 *   The synchronized-clap capture already starts every take at the same
 *   instant, so takes are mixed AS RECORDED (offset 0) by default. The
 *   per-take `clapOffset` (auto/calibrated device latency) is intentionally
 *   NOT applied — see runMix() for why. The host can fine-tune each take
 *   with a bidirectional manual offset (`participantOffsets`).
 *   The reference audio (played from t=0 at the clap signal) is included as-is.
 *
 * Returns: { resultUrl: string }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    sessionId,
    referenceGain = 0.5,
    participantGains = {},
    participantOffsets = {},
  }: {
    sessionId?: string;
    referenceGain?: number;
    participantGains?: Record<string, number>;
    /** Additive fine-tune in ms applied on top of each take's stored clapOffset. */
    participantOffsets?: Record<string, number>;
  } = await req.json();
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  let meta;
  try {
    meta = await readSession(sessionId);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const participants = Object.entries(meta.participants);
  if (participants.length === 0) {
    return NextResponse.json({ error: "No participant recordings to mix" }, { status: 400 });
  }

  const prevStatus = meta.status;
  meta.status = "mixing";
  await writeSession(meta);

  const dir = sessionDir(sessionId);
  const outputFile = "mix.webm";
  const outputPath = join(dir, outputFile);
  // The mix is rendered to an uncompressed intermediate first, so the master
  // gain can be measured and applied without encoding Opus twice. f32 and not
  // s16 on purpose: a sum that goes past full scale has to stay measurable, and
  // s16 would clamp it to exactly 0 dBFS and hide the clipping this is here to
  // catch.
  const tempPath = join(dir, `_tmp_mix_${randomUUID()}.wav`);

  // NB: use an explicit NaN check, NOT `Number(x) || 0.5` — a reference gain of
  // 0 (host muted the reference) is falsy and would wrongly snap back to 0.5,
  // leaving the reference audible after the host silenced it.
  const rgRaw = Number(referenceGain);
  const gain = Math.min(2, Math.max(0, Number.isFinite(rgRaw) ? rgRaw : 0.5));
  const pGains: Record<string, number> = participantGains;
  const pOffsets: Record<string, number> = participantOffsets;

  // Nothing audible to render. This used to reach ffmpeg, fail with "No audio
  // inputs", mark the session errored and hand the host a 500 with a stack in
  // it — for a state they created on purpose with the faders. It is one click
  // away: solo a take whose own fader is at 0, and every input is silent.
  const audible = Object.keys(meta.participants).filter((id) => {
    const g = pGains[id];
    return (typeof g === "number" && Number.isFinite(g) ? g : 1) > 0;
  });
  if (audible.length === 0 && !(meta.referenceFile && gain > 0)) {
    meta.status = prevStatus;
    await writeSession(meta);
    return NextResponse.json({
      error: "Nothing to mix",
      detail: "Every take and the reference are at zero. Unmute something before "
        + "mixing.",
    }, { status: 400 });
  }

  // Diagnostic: shows whether the host's fader values actually reach the mix and
  // whether their keys match the take keys in session.json. If these are all 1
  // (or the keys don't line up), the gain never gets applied by ffmpeg below.
  console.log(
    `[play2gether/mix] ref=${gain} gains=${JSON.stringify(pGains)} ` +
    `takeKeys=${JSON.stringify(Object.keys(meta.participants))}`
  );

  let masterGainDb = 0;
  let mixPeakDb: number | null = null;
  try {
    const { peakDb } = await runMix({
      dir, meta, outputPath: tempPath,
      referenceGain: gain, participantGains: pGains, participantOffsets: pOffsets,
    });
    mixPeakDb = peakDb;
    // No usable peak (astats silent, or a mix of pure silence) means no master:
    // failing to measure is never a reason to fail the render the host is
    // waiting for, and 0 dB leaves the old behaviour exactly as it was.
    masterGainDb = peakDb == null
      ? 0
      : Math.min(MASTER_MAX_BOOST_DB, MASTER_TARGET_PEAK_DB - peakDb);
    await encodeMaster(tempPath, outputPath, masterGainDb);
    console.log(`[play2gether/mix] peak ${peakDb ?? "n/a"} dBFS -> master `
      + `${masterGainDb >= 0 ? "+" : ""}${masterGainDb.toFixed(1)} dB`);
  } catch (err) {
    meta.status = "error";
    await writeSession(meta);
    console.error("[play2gether/mix] ffmpeg error:", err);
    return NextResponse.json({ error: "Mix failed", detail: String(err) }, { status: 500 });
  } finally {
    // The intermediate is worthless the moment the encode is done, and a
    // 5-minute stereo f32 render is ~140 MB of it. Storage retention is the
    // session's last open risk; do not leave these behind.
    await unlink(tempPath).catch(() => { /* never written, or already gone */ });
  }

  meta.resultFile = outputFile;
  meta.masterGainDb = +masterGainDb.toFixed(1);
  meta.mixPeakDb = mixPeakDb == null ? undefined : +mixPeakDb.toFixed(1);
  meta.status = "done";
  await writeSession(meta);

  // Stamped, because `outputFile` is the fixed name `mix.webm` and a host
  // mixes the same session over and over: without a version every re-mix
  // returns a URL the browser, the mixer's waveform cache and the player have
  // all already resolved, and the host judges their new balance by listening to
  // the previous one. Same defect the reference had — see the reference route.
  const resultUrl = `/api/play2gether/file/${sessionId}/${outputFile}?t=${Date.now()}`;
  return NextResponse.json({ resultUrl, masterGainDb: meta.masterGainDb, mixPeakDb: meta.mixPeakDb });
}

/**
 * Encode the rendered intermediate to the delivered file, applying the master.
 *
 * Cheap by construction: the expensive half (decoding every take, aligning and
 * summing them) already happened, so this reads uncompressed audio and encodes
 * Opus once. Doing it as a second measuring pass over the full graph would have
 * decoded every take twice — around 30 s of extra wall clock on an eleven-take
 * five-minute round, with the band waiting.
 */
function encodeMaster(srcPath: string, outputPath: string, gainDb: number): Promise<void> {
  const gain = Math.pow(10, gainDb / 20);
  const args = ["-y", "-i", srcPath];
  // Exactly 1.0 is skipped rather than passed as `volume=1.000`: it keeps the
  // command identical to the pre-master one when there is nothing to correct.
  if (Math.abs(gainDb) > 0.05) args.push("-af", `volume=${gain.toFixed(4)}`);
  args.push("-c:a", "libopus", "-b:a", "128k", outputPath);

  console.log(`[play2gether/mix] master encode: ffmpeg ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg (master) exited ${code}:\n${stderr.slice(-2000)}`)));
    proc.on("error", (err) => reject(new Error(`ffmpeg (master) spawn error: ${err.message}`)));
  });
}

interface MixOptions {
  dir: string;
  meta: Awaited<ReturnType<typeof readSession>>;
  outputPath: string;
  referenceGain: number;
  participantGains: Record<string, number>;
  /** Host fine-tune offsets in ms, added on top of each take's stored clapOffset. */
  participantOffsets: Record<string, number>;
}

/**
 * Builds and runs the ffmpeg command to align and mix all tracks.
 *
 * Strategy:
 *   - Each participant take is shifted by its measured capture-start delay
 *     (`captureDelayMs`) so it lines up with the reference, plus the host's
 *     manual `participantOffsets` fine-tune. Both fold into one bidirectional
 *     front shift (see loop below). The flaky auto `clapOffset` is NOT applied.
 *   - Reference (if present) starts at 0 — it was already playing from the clap.
 *   - amix blends all inputs with equal weight, normalised volume.
 *
 * Writes an uncompressed intermediate and returns the peak of the render, which
 * the caller turns into the master gain (see MASTER_TARGET_PEAK_DB). The peak
 * comes from an `astats` filter spliced onto the end of the graph rather than
 * from a second measuring pass: astats passes audio through untouched, so the
 * number costs nothing on top of a mix that already decodes every take.
 */
function runMix({ dir, meta, outputPath, referenceGain, participantGains, participantOffsets }: MixOptions): Promise<{ peakDb: number | null }> {
  const args: string[] = ["-y"]; // overwrite output without asking

  const filterParts: string[] = [];
  const mixInputs: string[] = [];
  let inputIndex = 0;

  // 1. Reference audio — apply volume gain before mixing. Skip entirely when
  //    the host muted it (gain 0), same as participant tracks below: a
  //    volume=0 input still counts toward `duration=longest` and would pad the
  //    mix with a silent tail (and in layered sessions the reference IS a
  //    voice, so muting it must actually remove it).
  if (meta.referenceFile && referenceGain > 0) {
    const refPath = join(dir, meta.referenceFile);
    args.push("-i", refPath);
    // Apply gain: [0:a]volume=0.5[ref]
    filterParts.push(`[${inputIndex}:a]volume=${referenceGain.toFixed(3)}[ref]`);
    mixInputs.push("[ref]");
    inputIndex++;
  }

  // 2. Participant recordings — align each take, apply individual gain.
  //    Skip tracks with gain=0 entirely so they don't count toward
  //    `duration=longest` (otherwise muting the longest take would leave
  //    silent tail in the mix).
  //
  //    Alignment: each take is padded by its measured `captureDelayMs` (how
  //    late capture actually began relative to the clap), which is what used to
  //    make takes drift AHEAD of the reference by a random per-device amount.
  //    NOTE the flaky auto `clapOffset` (a latency *estimate*) is still NOT
  //    applied — only the deterministic captureDelayMs plus the host's manual
  //    fine-tune. Both combine into one bidirectional front shift (see loop).
  for (const [participantId, participant] of Object.entries(meta.participants)) {
    const pGain = Math.min(2, Math.max(0, participantGains[participantId] ?? 1.0));
    if (pGain === 0) continue;

    const filePath = join(dir, participant.file);

    // Front alignment combines two things into a single bidirectional shift:
    //   autoDelay  = the take's measured capture-start delay (captureDelayMs).
    //                The client prewarms the recorder during the countdown and
    //                start-gates it at the clap, but any residual "started N ms
    //                after the clap" means the take is missing its first N ms and
    //                would sit AHEAD of the reference. Padding the front by N ms
    //                puts it back. Always ≥0.
    //   manualMs   = the host's per-take fine-tune slider. >0 = advance (the
    //                take is late, pull it earlier), <0 = delay further.
    // netDelayMs > 0 → pad the front with silence (adelay)
    // netDelayMs < 0 → trim the silent prologue (-ss)
    const autoDelayMs = Math.max(0, Math.round(Number(participant.captureDelayMs) || 0));
    const manualMs = Math.round(Number(participantOffsets[participantId]) || 0);
    const netDelayMs = autoDelayMs - manualMs;

    if (netDelayMs < 0) {
      args.push("-ss", (-netDelayMs / 1000).toFixed(3), "-i", filePath);
    } else {
      args.push("-i", filePath);
    }

    const label = `p${inputIndex}`;
    const chain = [`volume=${pGain.toFixed(3)}`];
    if (netDelayMs > 0) {
      // `adelay` delays in ms; `all=1` covers every channel (takes are mono,
      // but be explicit so a stereo take would delay both channels).
      chain.push(`adelay=delays=${netDelayMs}:all=1`);
    }
    filterParts.push(`[${inputIndex}:a]${chain.join(",")}[${label}]`);
    mixInputs.push(`[${label}]`);
    inputIndex++;
  }

  if (inputIndex === 0) {
    return Promise.reject(new Error("No audio inputs"));
  }

  // 3. Build filter_complex:
  //    volume filter on reference (if present) + amix all inputs
  const numMix = mixInputs.length;
  const mixFilter =
    numMix === 1
      ? `${mixInputs[0]}acopy[mixed]`
      : `${mixInputs.join("")}amix=inputs=${numMix}:duration=longest:normalize=0[mixed]`;

  filterParts.push(mixFilter);
  // Measurement tap. `metadata=0` keeps it out of the frame metadata (nothing
  // downstream reads it) and `measure_perchannel=none` keeps the log to the one
  // overall block the caller parses.
  filterParts.push(`[mixed]astats=metadata=0:measure_perchannel=none[out]`);
  const filterComplex = filterParts.join(";");

  args.push(
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "pcm_f32le",
    outputPath
  );

  console.log(`[play2gether/mix] ffmpeg ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        // "Peak level dB: -14.352599", or "-inf" on a silent render — which is
        // not an error, it is a mix with nothing in it, and it gets no master.
        const m = stderr.match(/Peak level dB:\s*(-?\d+(?:\.\d+)?)/);
        resolve({ peakDb: m ? Number(m[1]) : null });
      } else {
        reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-2000)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });
  });
}
