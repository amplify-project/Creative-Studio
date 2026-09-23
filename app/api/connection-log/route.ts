import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../dbbackend/prisma";

/**
 * Beacon endpoint for client-side LiveKit connection events.
 *
 * Goal: from the host's seat, answer "did this user actually have a
 * connection problem?" later (not just real-time) without asking them for
 * a console screenshot. Persists to Mongo (via Prisma) so events survive
 * `docker compose down` — the mongo volume is mapped to ./data1 on the
 * host.
 *
 * Also mirrors to `console.info` so the operator can still tail live with
 * `docker logs … | grep connlog`.
 *
 * Called via `navigator.sendBeacon`, so it must stay tolerant of arbitrary
 * payloads and never throw (sendBeacon doesn't surface errors anyway).
 */
export async function POST(req: NextRequest) {
  try {
    let payload: any = null;
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json") || ct.includes("text/plain")) {
      const raw = await req.text();
      try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    } else {
      payload = { ct };
    }

    const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? null;
    const ua = req.headers.get("user-agent") ?? null;

    // Known fields go to indexed columns; everything else lands in `extra`
    // so future telemetry (RTT, packet loss, etc.) doesn't need a schema
    // migration to be queryable.
    const { event, identity, sessionId, role, reason, ts, ...extra } = payload ?? {};

    // Mirror to stdout for live tailing.
    console.info("[connlog]", JSON.stringify({
      at: new Date().toISOString(), ip, ua, event, role, identity, sessionId, reason, ts, ...extra,
    }));

    // Persist. Best-effort: a DB blip must not break the room handlers.
    try {
      await prisma.connectionEvent.create({
        data: {
          event: typeof event === "string" ? event : "unknown",
          identity: typeof identity === "string" ? identity : null,
          sessionId: typeof sessionId === "string" ? sessionId : null,
          role: typeof role === "string" ? role : null,
          reason: typeof reason === "string" ? reason : null,
          clientTs: typeof ts === "number" ? new Date(ts) : null,
          ip,
          userAgent: ua,
          extra: Object.keys(extra).length ? (extra as any) : undefined,
        },
      });
    } catch (dbErr) {
      console.warn("[connlog] prisma write failed:", dbErr);
    }
  } catch {
    /* never throw */
  }
  return new NextResponse(null, { status: 204 });
}
