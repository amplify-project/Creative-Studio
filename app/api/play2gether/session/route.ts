import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import {
  Play2GetherSession,
  sessionDir,
  readSession,
  writeSession,
  ensureSessionDir,
} from "../utils";

/** POST /api/play2gether/session — create a new session */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { roomName, countdownSecs = 5, recordingDuration = 30 } = await req.json();
  if (!roomName) {
    return NextResponse.json({ error: "roomName is required" }, { status: 400 });
  }

  const sessionId = crypto.randomUUID();
  await ensureSessionDir(sessionId);

  const meta: Play2GetherSession = {
    sessionId,
    roomName,
    createdAt: Date.now(),
    countdownSecs,
    recordingDuration,
    referenceFile: null,
    referenceDuration: null,
    lyricsFile: null,
    participants: {},
    ready: {},
    resultFile: null,
    status: "preparing",
  };

  await writeSession(meta);

  return NextResponse.json({ sessionId });
}

/** GET /api/play2gether/session?sessionId=xxx — get session metadata */
export async function GET(req: NextRequest) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const meta = await readSession(sessionId);
    return NextResponse.json(meta);
  } catch {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
}

