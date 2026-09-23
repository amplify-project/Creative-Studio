import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const REPORTS_DIR = join(process.cwd(), "server", "data1", "bugs");
const REPORTS_FILE = join(REPORTS_DIR, "reports.jsonl");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const report = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      ...body,
    };

    // Ensure directory exists and append as newline-delimited JSON
    mkdirSync(REPORTS_DIR, { recursive: true });
    appendFileSync(REPORTS_FILE, JSON.stringify(report) + "\n", "utf8");

    console.info(`[BugReport] ${report.id} from ${report.participantId} in ${report.roomName}`);

    return NextResponse.json({ ok: true, id: report.id });
  } catch (err) {
    console.error("[BugReport] Failed to save report:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
