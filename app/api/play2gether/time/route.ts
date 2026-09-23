import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";

/** GET /api/play2gether/time
 * Returns the server's current epoch millis. Used by clients to measure their
 * own clock offset against the server (NTP-style: round-trip + midpoint).
 * That offset is then applied to clapAt so the recording starts at the same
 * absolute server-time instant on every client regardless of local clock skew.
 *
 * TWO timestamps, straddling the auth check, because a single one silently
 * charges the client for the server's own work. The midpoint estimate assumes a
 * symmetric round trip, and `getServerSession` sits on the inbound half only —
 * so every millisecond it spends lands in the offset as error, and every
 * millisecond it VARIES lands there as jitter. It is not a small term: on the
 * 2026-09-01 session the host measured rttMin ≈ 47 ms with client and server
 * both on 127.0.0.1, where the network is microseconds. Essentially all of that
 * was this handler.
 *
 * `recv`/`send` let the client subtract it, exactly as NTP's t2/t3 do:
 *
 *   offset = ((recv − t1) + (send − t4)) / 2
 *   rtt    = (t4 − t1) − (send − recv)
 *
 * `now` is kept so the arithmetic degenerates cleanly to the old single-stamp
 * form when either field is missing.
 */
export async function GET() {
  const recv = Date.now();
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const send = Date.now();
  return NextResponse.json({ now: send, recv, send });
}
