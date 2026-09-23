import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import {
  readSession, writeSession, withSessionLock,
  Play2GetherSession,
} from "../utils";

/** POST /api/play2gether/report
 *
 * Body: { sessionId, participantId, participantName, reason, clapAt? }
 *
 * A participant (or the host acting as a singer) reports that their take
 * failed to record or upload this round. Recorded under `meta.failures` so the
 * host poll can surface "Alice — recording failed" instead of silently waiting
 * for a take that will never arrive. Serialized under the per-session lock so
 * it doesn't clobber concurrent take uploads writing the same session.json.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    sessionId?: string;
    participantId?: string;
    participantName?: string;
    reason?: string;
    clapAt?: number | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { sessionId, participantId, participantName, reason, clapAt } = body;
  if (!sessionId || !participantId) {
    return NextResponse.json(
      { error: "sessionId and participantId are required" },
      { status: 400 }
    );
  }

  const name = (participantName && participantName.trim()) || participantId;
  const safeReason = (reason && String(reason).trim().slice(0, 300)) || "Recording failed";

  try {
    const result = await withSessionLock(sessionId, async () => {
      let meta: Play2GetherSession;
      try {
        meta = await readSession(sessionId);
      } catch {
        return { error: "Session not found" as const, status: 404 };
      }
      if (!meta.failures) meta.failures = {};
      meta.failures[participantId] = {
        name,
        reason: safeReason,
        clapAt: typeof clapAt === "number" ? clapAt : null,
        at: Date.now(),
      };
      await writeSession(meta);
      return { ok: true as const };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[p2g/report] failed:", e);
    return NextResponse.json({ error: "Internal error recording failure" }, { status: 500 });
  }
}

/** DELETE /api/play2gether/report
 * Body: { sessionId, participantId }
 * Clears a participant's failure entry (e.g. host dismisses it, or a manual
 * reset). Successful uploads clear it automatically in the record route.
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sessionId?: string; participantId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { sessionId, participantId } = body;
  if (!sessionId || !participantId) {
    return NextResponse.json({ error: "sessionId and participantId are required" }, { status: 400 });
  }

  try {
    await withSessionLock(sessionId, async () => {
      let meta: Play2GetherSession;
      try {
        meta = await readSession(sessionId);
      } catch {
        return;
      }
      if (meta.failures && meta.failures[participantId]) {
        delete meta.failures[participantId];
        await writeSession(meta);
      }
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[p2g/report] delete failed:", e);
    return NextResponse.json({ error: "Internal error clearing failure" }, { status: 500 });
  }
}
