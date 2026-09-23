import "server-only";
import Link from "next/link";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { requireAdmin } from "../../dbbackend/rbac";

const REPORTS_FILE = join(process.cwd(), "server", "data1", "bugs", "reports.jsonl");

interface BugReport {
  id: string;
  receivedAt: string;
  description: string;
  participantId: string;
  roomName: string;
  timestamp: string;
  muteEvents?: unknown[];
  lkAudio?: { isSubscribed: boolean; isMuted: boolean; canHear?: boolean }[];
  stageState?: unknown[];
  muteState?: Record<string, boolean>;
  consoleErrors?: unknown[];
  networkInfo?: { effectiveType?: string; downlink?: number; rtt?: number } | null;
  roomSnapshot?: { state?: string; connectionQuality?: string } | null;
  sessionDuration?: number;
  userAgent?: string;
}

function loadReports(): BugReport[] {
  if (!existsSync(REPORTS_FILE)) return [];
  const lines = readFileSync(REPORTS_FILE, "utf8").trim().split("\n").filter(Boolean);
  const reports: BugReport[] = [];
  for (const line of lines) {
    try { reports.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return reports.reverse(); // newest first
}

function audioIssue(r: BugReport): boolean {
  if (!r.lkAudio?.length) return false;
  return r.lkAudio.some((t) => !t.isSubscribed || (t.canHear === false));
}

function qualityBadge(q: string | undefined) {
  if (!q) return null;
  const colors: Record<string, string> = {
    poor: "bg-red-900/60 text-red-300",
    lost: "bg-red-900/80 text-red-200",
    good: "bg-green-900/60 text-green-300",
    excellent: "bg-green-900/60 text-green-300",
  };
  return colors[q.toLowerCase()] ?? "bg-zinc-700 text-zinc-300";
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

export default async function BugsListPage() {
  await requireAdmin();
  const reports = loadReports();

  return (
    // Dark canvas wrapper — see note on /admin/bugs/[id] for why this is
    // required (globals.css sets a light body theme, admin uses dark).
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bug Reports</h1>
          <p className="text-sm text-zinc-400 mt-0.5">{reports.length} report{reports.length !== 1 ? "s" : ""} · newest first</p>
        </div>
        <Link href="/admin" className="btn">← Admin</Link>
      </header>

      {reports.length === 0 && (
        <p className="text-zinc-500 text-sm">No reports yet.</p>
      )}

      <div className="space-y-2">
        {reports.map((r) => {
          const hasAudioIssue = audioIssue(r);
          const errCount = r.consoleErrors?.length ?? 0;
          const quality = r.roomSnapshot?.connectionQuality;
          const network = r.networkInfo?.effectiveType;
          const qColor = qualityBadge(quality);

          return (
            <Link
              key={r.id}
              href={`/admin/bugs/${r.id}`}
              className="block border border-white/10 rounded-xl p-4 hover:bg-white/5 transition-colors group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Timestamp + room */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mb-1">
                    <span>{fmt(r.receivedAt)}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="font-mono text-zinc-400 truncate max-w-[200px]" title={r.roomName}>{r.roomName}</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-300 truncate max-w-[180px]" title={r.participantId}>{r.participantId}</span>
                  </div>

                  {/* Description */}
                  <p className="text-white text-sm leading-snug line-clamp-2">{r.description}</p>
                </div>

                {/* Badges */}
                <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                  {hasAudioIssue && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-900/60 text-red-300">
                      audio issue
                    </span>
                  )}
                  {errCount > 0 && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-900/60 text-orange-300">
                      {errCount} error{errCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {quality && qColor && (
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${qColor}`}>
                      {quality}
                    </span>
                  )}
                  {network && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-300">
                      {network}
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-600 font-mono">{r.id.slice(0, 8)}</span>
                </div>
              </div>

              {/* Quick audio summary */}
              {r.lkAudio && r.lkAudio.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.lkAudio.map((t: any, i: number) => (
                    <span
                      key={i}
                      className={`text-[11px] px-2 py-0.5 rounded font-mono ${
                        t.isSubscribed && !t.isMuted
                          ? "bg-green-900/40 text-green-400"
                          : "bg-red-900/40 text-red-400"
                      }`}
                    >
                      {t.participant ?? `track-${i}`}
                      {!t.isSubscribed ? " [unsub]" : t.isMuted ? " [muted]" : " [ok]"}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
    </div>
  );
}
