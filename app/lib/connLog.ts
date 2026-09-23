import { ConnectionQuality } from "livekit-client";

/**
 * Shared client-side helpers for connection telemetry (`/api/connection-log`).
 *
 * Used by both the host (`app/host/page.tsx`) and participant
 * (`app/participant/page.tsx`) pages so their events share a schema and the
 * admin viewer can render them uniformly. Every event carries a `role` so we
 * can tell host-side problems apart from participant-side ones — previously
 * only participants were logged, which hid the (more impactful) case of the
 * host's own connection degrading.
 */

/**
 * Network Information API snapshot. Cheap ISP-level context attached to
 * `connected` and `quality` events so the operator can distinguish "their
 * WiFi is bad" (high netRttMs / 3g / saveData) from "our SFU had a blip".
 * Not exposed by Firefox/Safari → returns {} there (never throws).
 */
export function netInfo(): Record<string, unknown> {
  const c = (navigator as any)?.connection;
  if (!c) return {};
  const out: Record<string, unknown> = {};
  if (typeof c.effectiveType === "string") out.netType = c.effectiveType; // "4g" | "3g" | "2g" | "slow-2g"
  if (typeof c.downlink === "number") out.downlinkMbps = c.downlink;       // estimated, Mbps
  if (typeof c.rtt === "number") out.netRttMs = c.rtt;                     // estimated, ms (rounded to 25ms by the browser)
  if (typeof c.saveData === "boolean") out.saveData = c.saveData;          // user asked for reduced data
  return out;
}

/**
 * Ordinal rank for a LiveKit ConnectionQuality so a change can be classified
 * as an improvement or a degradation. Higher = better. Unknown sorts below
 * Lost — we genuinely don't know, so treat it as "not good".
 */
export function qualityRank(q: ConnectionQuality | string): number {
  switch (q) {
    case ConnectionQuality.Excellent: return 3;
    case ConnectionQuality.Good:      return 2;
    case ConnectionQuality.Poor:      return 1;
    case ConnectionQuality.Lost:      return 0;
    default:                          return -1; // Unknown
  }
}

export function isBadQuality(q: ConnectionQuality): boolean {
  return q === ConnectionQuality.Poor || q === ConnectionQuality.Lost;
}

export type ConnLogger = (event: string, extra?: Record<string, unknown>) => void;

/**
 * Build a fire-and-forget logger bound to a role + identity. Posts to
 * `/api/connection-log` via `navigator.sendBeacon` (survives tab unload, so
 * disconnect-on-close still gets recorded), with a keepalive `fetch`
 * fallback. Never throws — telemetry must never break the room handlers.
 */
export function makeConnLogger(role: "host" | "participant", identity: string): ConnLogger {
  return (event, extra = {}) => {
    try {
      const params = new URLSearchParams(window.location.search);
      const body = JSON.stringify({
        event,
        role,
        identity,
        sessionId: params.get("sessionId"),
        ts: Date.now(),
        ...extra,
      });
      const ok = navigator.sendBeacon?.("/api/connection-log", body);
      if (!ok) {
        fetch("/api/connection-log", { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      /* never block the room handlers on telemetry */
    }
  };
}

/** Mutable holder for the last seen quality, so direction can be computed. */
export type QualityTracker = { last: ConnectionQuality | null };

/**
 * Log a connection-quality transition with direction. Answers the operator's
 * question "did it get better or worse?" directly via `direction`, and keeps
 * the previous level in `from`. No-ops when the level is unchanged (LiveKit
 * can re-emit the same value). Attaches a `netInfo()` snapshot for context.
 */
export function logQualityChange(
  log: ConnLogger,
  tracker: QualityTracker,
  quality: ConnectionQuality,
): void {
  const prev = tracker.last;
  tracker.last = quality;
  if (prev === quality) return; // unchanged — nothing worth recording
  const rankNow = qualityRank(quality);
  const direction =
    prev === null
      ? "initial"
      : rankNow > qualityRank(prev)
        ? "improved"
        : "degraded";
  log("quality", {
    quality,            // "excellent" | "good" | "poor" | "lost"
    from: prev,         // previous level, or null on first reading
    direction,          // "improved" | "degraded" | "initial"
    bad: isBadQuality(quality),
    ...netInfo(),
  });
}
