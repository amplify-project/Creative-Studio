import "server-only";
import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "../../dbbackend/prisma";
import { requireAdmin } from "../../dbbackend/rbac";

type SP = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 50;
// Cap LIMIT/OFFSET reads. 5000 entries is plenty for the "newest first
// table" usage pattern; if someone needs older data they can date-filter.
const MAX_PAGE = 100;

function fmt(d: Date | string) {
  return new Date(d).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function eventBadge(ev: string, reason: string | null | undefined, extra: any) {
  // disconnects flagged by reason. CLIENT_INITIATED is benign (user closed
  // the tab or host-leave flow); the rest are signal-level problems.
  if (ev === "disconnected") {
    if (reason === "CLIENT_INITIATED") return "bg-zinc-800 text-zinc-300";
    return "bg-red-900/60 text-red-300";
  }
  if (ev === "reconnecting" || ev === "signal_reconnecting") return "bg-amber-900/60 text-amber-300";
  if (ev === "reconnected" || ev === "connected") return "bg-emerald-900/60 text-emerald-300";
  if (ev === "connect_failed" || ev === "media_devices_error") return "bg-red-900/60 text-red-300";
  // Generic failure convention: any event that reports `ok: false` is a
  // failure, whatever it is. Costs one line and covers every future kind.
  if (extra?.ok === false) return "bg-red-900/60 text-red-300";
  if (ev === "quality") {
    // Colour by direction so degradations pop in the table.
    if (extra?.bad) return "bg-red-900/60 text-red-300";
    if (extra?.direction === "improved") return "bg-emerald-900/60 text-emerald-300";
    return "bg-amber-900/60 text-amber-300";
  }
  return "bg-zinc-800 text-zinc-300";
}

function roleBadge(role: string | null) {
  if (role === "host") return "bg-indigo-900/60 text-indigo-300";
  if (role === "participant") return "bg-sky-900/60 text-sky-300";
  return "bg-zinc-800 text-zinc-500";
}

/**
 * Fields the client's `withNet()` helper attaches to events of ANY kind: a
 * Network Information API sample, not a description of the event. They are
 * rendered last, and — the part that matters — they never count as "this
 * event kind has been recognised".
 *
 * Conflating the two is what used to blank the Details cell: the generic
 * scalar fallback below was guarded on `parts.length === 0`, and on any
 * browser that exposes `navigator.connection` these three pushed first, so
 * every field of every event that carried them was silently dropped from the
 * row. The bug was invisible on Safari (no `navigator.connection`) and total
 * on Chrome, for the same event.
 */
const NET_KEYS = new Set(["netType", "netRttMs", "downlinkMbps", "saveData"]);

function netParts(extra: any): string[] {
  const parts: string[] = [];
  if (extra.netType) parts.push(String(extra.netType));
  if (typeof extra.netRttMs === "number") parts.push(`${extra.netRttMs}ms`);
  if (typeof extra.downlinkMbps === "number") parts.push(`${extra.downlinkMbps}Mbps`);
  if (extra.saveData) parts.push("saveData");
  return parts;
}

/**
 * Bespoke rendering for the event kinds this viewer knows by name. Returns
 * null when nothing claims the event — the signal to fall back to the generic
 * scalar rendering. Deciding that by EVENT KIND, rather than by how many parts
 * happen to have accumulated, is what keeps the fallback reachable no matter
 * what shared context gets attached to an event later.
 */
function knownParts(ev: string, extra: any): string[] | null {
  if (ev === "quality" && extra.quality) {
    const arrow = extra.direction === "degraded" ? "↓" : extra.direction === "improved" ? "↑" : "·";
    return [extra.from ? `${extra.from} ${arrow} ${extra.quality}` : String(extra.quality)];
  }
  if (ev === "visibility") return [extra.hidden ? "hidden" : "visible"];
  if (ev === "media_devices_error" && extra.name) return [String(extra.name)];
  if (ev === "connect_failed" && extra.message) return [String(extra.message)];
  return null;
}

/**
 * Every scalar the event carried, in the order the client wrote them.
 *
 * No cap. A cap drops the tail, and the tail is exactly where a client puts
 * the numbers it added most recently — a five-field limit hid `offsetSpreadMs`
 * and `captureDelayMs`, the two fields their events exist to report. The row
 * is kept to one line by the cell's own width instead, with the full string as
 * its tooltip, so a long payload is folded rather than lost.
 */
function scalarParts(extra: any): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    if (NET_KEYS.has(k)) continue;
    parts.push(`${k}=${typeof v === "number" ? Math.round(v * 100) / 100 : String(v)}`);
  }
  return parts;
}

/**
 * One-line summary of the `extra` Json blob for the table: what the event
 * itself reported, then the network context it was carrying.
 */
function extraSummary(ev: string, extra: any): string {
  if (!extra || typeof extra !== "object") return "";
  return [...(knownParts(ev, extra) ?? scalarParts(extra)), ...netParts(extra)].join(" · ");
}

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const fSession = one(sp.sessionId).trim();
  const fIdentity = one(sp.identity).trim();
  const fEvent = one(sp.event).trim();
  const fRole = one(sp.role).trim();
  const fReason = one(sp.reason).trim();
  const fFrom = one(sp.from).trim();
  const fTo = one(sp.to).trim();
  const fOnlyProblems = one(sp.onlyProblems) === "1";
  const pageRaw = parseInt(one(sp.page) || "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 && pageRaw <= MAX_PAGE ? pageRaw : 1;

  const where: Prisma.ConnectionEventWhereInput = {};
  if (fSession) where.sessionId = fSession;
  if (fIdentity) where.identity = fIdentity;
  if (fEvent) where.event = fEvent;
  if (fRole) where.role = fRole;
  if (fReason) where.reason = fReason;
  if (fOnlyProblems) {
    where.OR = [
      { event: "reconnecting" },
      { event: "disconnected", NOT: { reason: "CLIENT_INITIATED" } },
    ];
  }
  if (fFrom || fTo) {
    const range: Prisma.DateTimeFilter = {};
    if (fFrom) range.gte = new Date(fFrom);
    if (fTo) range.lte = new Date(fTo);
    where.ts = range;
  }

  const [total, rows] = await Promise.all([
    prisma.connectionEvent.count({ where }),
    prisma.connectionEvent.findMany({
      where,
      orderBy: { ts: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // Preserve the current filter state when building pagination links.
  const qs = new URLSearchParams();
  if (fSession) qs.set("sessionId", fSession);
  if (fIdentity) qs.set("identity", fIdentity);
  if (fEvent) qs.set("event", fEvent);
  if (fRole) qs.set("role", fRole);
  if (fReason) qs.set("reason", fReason);
  if (fFrom) qs.set("from", fFrom);
  if (fTo) qs.set("to", fTo);
  if (fOnlyProblems) qs.set("onlyProblems", "1");
  const baseQS = qs.toString();
  const pageLink = (n: number) => `?${baseQS}${baseQS ? "&" : ""}page=${n}`;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    // Dark canvas wrapper — see note on /admin/bugs/[id] for why this is
    // required (globals.css sets a light body theme, admin uses dark).
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Connection events</h1>
          <p className="text-sm text-zinc-400 mt-0.5">
            {total.toLocaleString()} match{total !== 1 ? "es" : ""} ·
            page {page} of {totalPages} · newest first
          </p>
        </div>
        <Link href="/admin" className="btn">← Admin</Link>
      </header>

      {/* Filter bar. GET form so filters land in the URL → bookmarkable +
        * shareable. Empty fields are omitted by the browser on submit. */}
      <form className="grid grid-cols-1 md:grid-cols-3 gap-2 border border-white/10 rounded-xl p-3 text-sm">
        <input
          name="identity"
          defaultValue={fIdentity}
          placeholder="identity (uid)"
          className="input font-mono"
        />
        <input
          name="sessionId"
          defaultValue={fSession}
          placeholder="sessionId"
          className="input font-mono"
        />
        <select name="role" defaultValue={fRole} className="input">
          <option value="">any role</option>
          <option value="host">host</option>
          <option value="participant">participant</option>
        </select>
        {/* Free text with suggestions rather than a closed <select>: the log
            endpoint accepts any `event` string, so a fixed list silently hides
            every event kind added later (feature telemetry, agent events) and
            has to be edited each time. The datalist keeps the common ones one
            click away without making them the only ones reachable. */}
        <input
          name="event"
          defaultValue={fEvent}
          list="event-options"
          placeholder="any event"
          className="input"
        />
        <datalist id="event-options">
          <option value="connected" />
          <option value="connect_failed" />
          <option value="reconnecting" />
          <option value="signal_reconnecting" />
          <option value="reconnected" />
          <option value="disconnected" />
          <option value="quality" />
          <option value="media_devices_error" />
          <option value="visibility" />
          <option value="pagehide" />
          <option value="p2g_clock" />
          <option value="p2g_reference" />
          <option value="p2g_take" />
          <option value="p2g_upload" />
        </datalist>
        <input
          name="reason"
          defaultValue={fReason}
          placeholder="reason (e.g. SIGNAL_DISCONNECTED)"
          className="input font-mono"
        />
        <input
          name="from"
          type="datetime-local"
          defaultValue={fFrom}
          className="input"
          title="from (UTC)"
        />
        <input
          name="to"
          type="datetime-local"
          defaultValue={fTo}
          className="input"
          title="to (UTC)"
        />
        <label className="flex items-center gap-2 text-zinc-300 col-span-1">
          <input
            type="checkbox"
            name="onlyProblems"
            value="1"
            defaultChecked={fOnlyProblems}
          />
          Only problems (drops & non-clean disconnects)
        </label>
        <div className="md:col-span-2 flex gap-2 justify-end">
          <Link href="/admin/connections" className="btn">Reset</Link>
          <button type="submit" className="btn">Apply</button>
        </div>
      </form>

      {/* Table */}
      <div className="border border-white/10 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-zinc-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">When (UTC)</th>
              <th className="text-left px-3 py-2 font-medium">Role</th>
              <th className="text-left px-3 py-2 font-medium">Event</th>
              <th className="text-left px-3 py-2 font-medium">Details</th>
              <th className="text-left px-3 py-2 font-medium">Reason</th>
              <th className="text-left px-3 py-2 font-medium">Identity</th>
              <th className="text-left px-3 py-2 font-medium">Session</th>
              <th className="text-left px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  No events match the current filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-3 py-1.5 whitespace-nowrap text-zinc-300">
                  {fmt(r.ts)}
                </td>
                <td className="px-3 py-1.5">
                  {r.role ? (
                    <Link
                      href={`?role=${encodeURIComponent(r.role)}`}
                      className={`text-[11px] px-2 py-0.5 rounded-full ${roleBadge(r.role)}`}
                      title="filter by this role"
                    >
                      {r.role}
                    </Link>
                  ) : <span className="text-zinc-600 text-xs">—</span>}
                </td>
                <td className="px-3 py-1.5">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${eventBadge(r.event, r.reason, r.extra)}`}>
                    {r.event}
                  </span>
                </td>
                {/* Width-capped and truncated rather than field-capped: the
                  * full summary is always in the tooltip, so a wide payload
                  * costs a hover instead of losing its tail. */}
                <td className="px-3 py-1.5 text-xs text-zinc-400">
                  {/* The clamp lives on an inner block, not the cell: a
                    * `max-width` on a <td> is ignored under the default
                    * `table-layout: auto`, so putting it there would silently
                    * do nothing and let one wide row stretch the table. */}
                  <div className="max-w-[34rem] truncate" title={extraSummary(r.event, r.extra)}>
                    {extraSummary(r.event, r.extra)}
                  </div>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-zinc-300">{r.reason ?? ""}</td>
                <td className="px-3 py-1.5 font-mono text-xs">
                  {r.identity ? (
                    <Link
                      href={`?identity=${encodeURIComponent(r.identity)}`}
                      className="text-indigo-300 hover:underline"
                      title="filter by this identity"
                    >
                      {r.identity}
                    </Link>
                  ) : ""}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">
                  {r.sessionId ? (
                    <Link
                      href={`?sessionId=${encodeURIComponent(r.sessionId)}`}
                      className="text-indigo-300 hover:underline"
                      title="filter by this session"
                    >
                      {r.sessionId}
                    </Link>
                  ) : ""}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-zinc-400">{r.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <div className="text-zinc-500">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
          </div>
          <div className="flex gap-2">
            <Link
              href={page > 1 ? pageLink(page - 1) : "#"}
              className={`btn ${page <= 1 ? "opacity-40 pointer-events-none" : ""}`}
            >
              ← Prev
            </Link>
            <Link
              href={page < totalPages ? pageLink(page + 1) : "#"}
              className={`btn ${page >= totalPages ? "opacity-40 pointer-events-none" : ""}`}
            >
              Next →
            </Link>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
