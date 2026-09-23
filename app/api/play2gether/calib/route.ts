import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { Play2GetherSession, readSession, writeSession, withSessionLock } from "../utils";

/**
 * Results of a **calibration round** — the host measures every device at once
 * and each client posts its own number here.
 *
 * Why a route of its own rather than a branch of `record`: nothing is recorded.
 * The measurement happens entirely in the browser (`runCalibrationRun` →
 * `runAcousticTrial`), the audio never leaves the device, and what arrives here
 * is four numbers. Routing it through the upload path would have bought a
 * transcode, a peaks pass and a stagger for a 200-byte body.
 *
 * `withSessionLock` is not optional here even though the body is tiny: a whole
 * band posts within a second or two of each other, and read-modify-write on
 * session.json without the lock loses all but the last writer — the exact bug
 * the lock was introduced for on the upload path.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId, participantId, participantName } = body ?? {};
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }
  const name = (typeof participantName === "string" && participantName.trim()) || participantId;

  try {
    await withSessionLock(sessionId, async () => {
      let meta: Play2GetherSession;
      try {
        meta = await readSession(sessionId);
      } catch {
        throw new Error("not-found");
      }

      if (body.failed) {
        // A refusal goes down the same channel a dropped take does, so the host
        // sees it in the place they already look.
        //
        // It used to DELETE the previous number as well, on the argument that a
        // stale measurement standing in for a failed one is how somebody gets
        // mixed against a figure that no longer describes their device. Field
        // use inverted that on 2026-09-04. In a ROUND the whole band is
        // measured at once, so a single trial fails for reasons that have
        // nothing to do with the device — someone talks over the click, a chair
        // moves, a mic is briefly muted — and deleting a good number from ten
        // minutes earlier leaves that person with NOTHING, which the mixer then
        // fills with the browser's own estimate. That is strictly worse: a
        // measurement a few minutes old still describes the device; the
        // fallback describes nothing, and 2026-08-31 measured it at 61-412 ms
        // on the same people in one session.
        //
        // So the number stays and the failure is reported next to it, naming
        // what was kept. The host still has both facts — this round could not
        // measure them, and this is the number they are being mixed on — and
        // the calibration card's per-person clear is there for a device that
        // really has changed.
        const kept = meta.calibOffsets?.[participantId];
        meta.failures = {
          ...(meta.failures ?? {}),
          [participantId]: {
            name,
            reason: `Calibration round: ${String(body.reason ?? "no measurement").slice(0, 200)}`
              + (kept ? ` — keeping their earlier ${kept.latencyMs} ms` : ""),
            clapAt: null,
            at: Date.now(),
          },
        };
        await writeSession(meta);
        return;
      }

      const latencyMs = Math.round(Number(body.latencyMs));
      if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 5000) {
        throw new Error("bad-latency");
      }
      const spreadRaw = Math.round(Number(body.spreadMs));
      const trials = Array.isArray(body.trialsMs)
        ? body.trialsMs.filter((n: unknown) => Number.isFinite(n)).map((n: number) => Math.round(n)).slice(0, 16)
        : [];

      meta.calibOffsets = {
        ...(meta.calibOffsets ?? {}),
        [participantId]: {
          name,
          latencyMs,
          spreadMs: Number.isFinite(spreadRaw) && spreadRaw >= 0 ? spreadRaw : 0,
          trialsMs: trials,
          unstable: body.unstable === true,
          measuredAt: Date.now(),
        },
      };
      // A measurement that worked clears the reason a previous one didn't.
      if (meta.failures?.[participantId]) delete meta.failures[participantId];
      await writeSession(meta);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "not-found") return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (msg === "bad-latency") return NextResponse.json({ error: "latencyMs out of range" }, { status: 400 });
    console.error("[p2g/calib] write failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, participantId });
}

/** DELETE — drop one person's calibration. The host's escape hatch for a number
 *  they can see is wrong; the take then falls back to their sync round, or to
 *  no correction at all. */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId, participantId } = await req.json();
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }

  try {
    await withSessionLock(sessionId, async () => {
      let meta: Play2GetherSession;
      try {
        meta = await readSession(sessionId);
      } catch {
        throw new Error("not-found");
      }
      if (meta.calibOffsets?.[participantId]) {
        delete meta.calibOffsets[participantId];
        await writeSession(meta);
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "not-found") {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
