import type { Room } from "livekit-client";
import { makeConnLogger, netInfo } from "./connLog";

/**
 * Field telemetry for Play2Gether rounds.
 *
 * Rides the existing `/api/connection-log` beacon pipeline instead of adding
 * an endpoint. That route already treats `event` as a free-form string and
 * drops every unknown field into the `extra` Json column, so these events are
 * pure *data* to it: no schema migration, no edit to shared infrastructure,
 * and no line of connection-log code that knows what "play2gether" means.
 * They also land in `/admin/connections` right next to the reconnect/quality
 * events they have to be read against — a slow upload and a `reconnecting`
 * thirty seconds earlier are the same story.
 *
 * Budget: THREE beacons per participant per round, a few hundred bytes each,
 * all emitted at round boundaries — one at mount, two after the recording has
 * already stopped. Nothing runs in the audio path, nothing polls, and nothing
 * is emitted during countdown or capture. Against a ~17 MB take upload the
 * telemetry is ~0.005 % of the bytes.
 *
 * Everything here is best-effort and swallows its own errors: a round must
 * never fail because a measurement did.
 */

/** What a clock-offset measurement looked like, beyond the number it chose. */
export type ClockStats = {
  /** The offset actually adopted (median of the low-RTT half). */
  offsetMs: number;
  /** How many of the OFFSET_SAMPLES probes came back usable. */
  validSamples: number;
  rttMinMs: number;
  rttMedMs: number;
  rttMaxMs: number;
  /**
   * Spread between the best and worst offset estimate across samples. A
   * healthy wired link lands within a few ms. A large spread means the
   * probes disagreed, so the adopted offset is a guess — and since every
   * take is aligned by `clapAt - offset`, that guess shifts this singer in
   * the mix. This is the number to look at first when one take is late and
   * nobody can explain why.
   */
  offsetSpreadMs: number;
};

function roleOf(room: Room | null | undefined): "host" | "participant" {
  try {
    const meta = room?.localParticipant?.metadata;
    if (meta && JSON.parse(meta)?.role === "teacher") return "host";
  } catch {
    /* malformed metadata — treat as participant, same as the rest of the app */
  }
  return "participant";
}

/**
 * Fire-and-forget P2G event. Identity and role are resolved at emit time
 * rather than captured up front, because the earliest event (`p2g_clock`)
 * can be measured before the room has finished connecting.
 */
export function p2gLog(
  room: Room | null | undefined,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    const identity = room?.localParticipant?.identity || "unknown";
    makeConnLogger(roleOf(room), identity)(event, extra);
  } catch {
    /* telemetry must never break a round */
  }
}

/** Attach the cheap ISP-level context (4g/3g, estimated downlink, RTT). */
export function withNet(extra: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, ...netInfo() };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
