"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { Track, type Room } from "livekit-client";
import { useSharedStateContext } from "./useSharedState";
import { p2gLog, withNet, median, type ClockStats } from "../lib/p2gTelemetry";
import { SYNC_BPM, SYNC_JITTER_MS, syncBeatMs, syncRoundDurationSec } from "../lib/p2gSync";
// The acoustic measurement itself. Imported from the component module because
// that is where it has always lived and where the self-serve button still calls
// it — one definition of the measurement, two ways to start it. The dependency
// only points this way: the calibration module knows nothing about this hook.
import {
  runCalibrationRun, IDLE_CALIB_ROUND, type CalibRoundState,
} from "../../components/Play2GetherCalibration";

// ─── Types ────────────────────────────────────────────────────────────────────

export type P2GPhase =
  | "idle"
  | "preparing"
  | "rehearsal"
  | "countdown"
  | "recording"
  | "uploading"
  | "mixing"
  | "done";

/** What a sync round measured for one player. Mirrors the server's
 *  `Play2GetherSyncOffset` minus the bookkeeping fields. */
export type SyncRoundResult = {
  offsetMs: number;
  spreadMs: number;
  hits: number;
  expected: number;
  bpm: number;
  deviationsMs: number[];
  atSearchEdge?: boolean;
};

/** Slice stored under shared_state.play2gether */
export type P2GSharedState = {
  sessionId: string | null;
  referenceUrl: string | null;
  /** Auto-detected duration of the reference in seconds (ffprobe on upload).
   * When set, drives `recordingDuration` automatically so the host doesn't
   * need to type the song length. */
  referenceDuration: number | null;
  countdownSecs: number;
  recordingDuration: number;
  /** Epoch ms at which recording begins (clap signal). null = not yet fired. */
  clapAt: number | null;
  /** Randomised-click parameters for a sync round. The seed rides the shared
   *  state so every client schedules the SAME irregular grid and the detector
   *  can reconstruct it; 0 amplitude is a plain round. See `p2gSync.ts`. */
  syncSeed?: number;
  syncJitterMs?: number;
  resultUrl: string | null;
  status: "idle" | "preparing" | "rehearsal" | "active" | "mixing" | "done";
  /** Host plays reference audio to participants during rehearsal */
  playRehearsal: boolean;
  /** Host-controlled: broadcast result playback to all participants */
  playResult: boolean;
  /** Volume multiplier for the reference track in the mix (0.0 – 2.0) */
  referenceGain: number;
  /**
   * If set, only this participant identity records their mic during the
   * current round. Other clients show a passive "X is recording…" overlay.
   * null = everyone records (default).
   */
  targetParticipantId: string | null;
  /** Host opens download to participants. False by default (host-only download). */
  allowDownload: boolean;
  /** Optional LRC lyrics file URL synced to the reference. Null when none uploaded. */
  lyricsUrl: string | null;
  /** Metronome tempo in BPM. 0 = off. When >0, clicks are played phase-locked to
   *  the clap (count-in during the countdown, then through the take) on each
   *  recording client. Not injected into the recording — an audible cue only. */
  metronomeBpm: number;
  /**
   * What this round is FOR.
   *
   * "take" — the normal thing: record over the reference, mix the result.
   * "sync" — a measurement. Click only, no reference, four bars of quarter
   *          notes; the upload is analysed for where this player puts a beat
   *          and then never appears in the mixer. See `app/lib/p2gSync.ts`.
   *
   * A round kind rather than a new `status`: everything a round already does —
   * phase derivation, prewarm, the start gate, the stagger, the failure
   * reporting — is identical for both, and a second status would have had to
   * re-derive all of it.
   */
  roundKind: "take" | "sync";
  /**
   * Server-clock instant at which a CALIBRATION ROUND's clicks start on every
   * client at once. null = no round has been run.
   *
   * A field of its own rather than a third `roundKind`, and that is the whole
   * design: a calibration round records nothing, uploads nothing and produces
   * no take. It must not touch `clapAt` or `status`, because everything those
   * two drive — the prewarm, the start gate, the reference schedule, the
   * stagger, the phase machine — would arm itself for a round that is never
   * going to happen. The session stays exactly where it was; a ten-second
   * measurement runs on top of it.
   */
  calibRoundAt?: number | null;
  /**
   * The `clapAt` of a round the host ABANDONED before its scheduled end, or
   * null. Clearing `clapAt` is what actually stops everything — see
   * `cancelRound` — so this field carries no mechanism; it exists to answer
   * "why did my screen just change?".
   *
   * Without it a cancel is indistinguishable from a crash: the participant is
   * recording, and a frame later they are back at "get ready" with no
   * explanation. It also lets a client still sitting in the staggered upload
   * queue drop its take instead of sending one nobody wants.
   *
   * Keyed by clapAt rather than a boolean so it survives the next round
   * starting: round N+1 sets a new clapAt and the stale value stops matching
   * on its own, with nothing to reset.
   */
  cancelledClapAt?: number | null;
};

export type UsePlay2GetherReturn = {
  p2g: P2GSharedState;
  phase: P2GPhase;
  /** Seconds the CURRENT round records for. Not `p2g.recordingDuration`: a sync
   *  round is four bars at a fixed tempo, so any UI reading the raw field shows
   *  the song length while a 13 s measurement is running. */
  roundDuration: number;
  countdown: number;
  recordingProgress: number;
  uploading: boolean;
  uploadDone: boolean;
  /** Set while this client is holding its take, waiting for its turn in the
   *  staggered upload queue. 1-based `slot` of `total`. Null once sending. */
  uploadSlot: { slot: number; total: number } | null;
  uploadError: string | null;
  /**
   * What kind of failure `uploadError` describes:
   *  - "capture" — nothing was recorded (mic unavailable, worklet failed).
   *    Re-uploading can't help; the round has to be re-run by the host.
   *  - "upload"  — a take WAS captured but the network upload failed.
   *    `retryUpload` can re-send it.
   * null when there's no error.
   */
  uploadErrorKind: "capture" | "upload" | null;
  retryUpload: () => void;
  /**
   * True while this client is sitting out a round it arrived too late to join.
   * Not an error state: nothing is wrong with them, they simply were not here
   * when it started, and the panel says that instead of showing a recording UI
   * they cannot act on.
   */
  missedRound: boolean;
  /** Live AnalyserNode connected to the local mic — active only during rehearsal */
  micAnalyser: AnalyserNode | null;
  /** Live AnalyserNode on the reference playback — active when referenceUrl is set */
  refAnalyser: AnalyserNode | null;
  /**
   * Reference playback position in seconds, or null when it isn't playing.
   * Safe to call from a RAF loop. Replaces the old `refAudioEl` export: during
   * a take the reference is a scheduled AudioBuffer and no media element is
   * moving, so an element's currentTime is no longer the playback clock.
   */
  getReferenceTime: () => number | null;
  /**
   * True when this client should record their mic this round (target is null
   * or matches the local identity). False = passive observer.
   */
  isLocalTarget: boolean;
  /** Display name of the current target participant, or null if everyone records */
  targetName: string | null;
  /**
   * Per-client calibrated audio latency (ms). When set, overrides the
   * auto-detected `baseLatency + outputLatency + micLatency` sum used as
   * `clapOffset`. Optional — null falls back to auto detection.
   */
  calibratedLatencyMs: number | null;
  setCalibratedLatency: (ms: number | null) => void;
  /**
   * Store a calibration on the SERVER, where the mixer can seed from it.
   *
   * `setCalibratedLatency` is this client's own localStorage and nothing else.
   * Since calibration seeds the mixer, a measurement that stays local is a
   * number the host cannot see and cannot use — which is precisely the shape of
   * the 2026-08-31 failure, arrived at from the other end. The calibration
   * round calls this itself; the self-serve button's panels call it on save.
   */
  publishCalibration: (result: {
    latencyMs: number; spreadMs: number; unstable: boolean; trials: number[];
  }) => void;
  /** Remove this client's calibration from the server as well as from
   *  localStorage. Clearing only the local copy would leave the mixer seeding
   *  every take from a number the person has explicitly disowned. */
  clearPublishedCalibration: () => void;
  /**
   * What the host's calibration round is doing on THIS client: the lead-in
   * countdown, the trials, and the number (or the refusal) at the end. Both
   * panels render it — the participant is the only person who can act on
   * "your mic never heard the click".
   */
  calibRound: CalibRoundState;
  /** This client's own result from the last sync round it recorded, or null.
   *  Shown to the player: a refusal is nearly always something only they can
   *  act on. */
  syncResult: SyncRoundResult | null;
  /** Why the last sync round could not be measured, in words for the player. */
  syncRefused: string | null;
  /** Raw LRC text, or null when no lyrics file is uploaded. Fetched once per URL. */
  lyricsText: string | null;
  /** Participant marks themselves ready during rehearsal */
  markReady: () => Promise<void>;
  host: {
    openSession: (opts?: { countdownSecs?: number; recordingDuration?: number }) => Promise<void>;
    closeSession: () => Promise<void>;
    /** Upload a reference track. `durationSec` is a wall-clock hint (used by
     * the server when ffprobe can't read the container duration — common
     * with MediaRecorder-generated WebM). */
    uploadReference: (file: File | Blob, mimeType?: string, durationSec?: number) => Promise<string>;
    /** Remove the current reference track so the host can re-record or upload
     * a different one. Deletes the file server-side and clears shared state. */
    clearReference: () => Promise<void>;
    /** Upload an optional LRC file synced to the reference. Returns the URL. */
    uploadLyrics: (file: File) => Promise<string>;
    /** Remove the uploaded lyrics for the current session. */
    clearLyrics: () => Promise<void>;
    startRehearsal: () => Promise<void>;
    endRehearsal: () => Promise<void>;
    setPlayRehearsal: (playing: boolean) => Promise<"ok" | "refused">;
    /** target = null → everyone records. target = identity → only that one. */
    startCountdown: (target?: string | null) => Promise<void>;
    /** Run a sync round — click only, four bars, everyone at once. Measures
     *  where each player puts a beat; produces no take and no mix input. */
    /** `jitterMs > 0` randomises the click so it cannot be played from memory.
     *  0 (the default) is the plain grid. See `p2gSync.ts`. */
    startSyncRound: (opts?: { jitterMs?: number }) => Promise<void>;
    /**
     * Run a calibration round: every device measures its own acoustic round
     * trip at the same moment, after a shared lead-in that tells everybody to
     * take their headphones off. Nothing is recorded and nothing is uploaded.
     */
    startCalibRound: () => Promise<void>;
    /**
     * Abandon the round in progress — countdown or recording. DESTRUCTIVE: the
     * take is discarded on every client and cannot be recovered, so the UI must
     * confirm before calling this. No-op when no round is running.
     */
    cancelRound: () => Promise<void>;
    triggerMix: (
      participantGains: Record<string, number>,
      participantOffsets?: Record<string, number>,
      referenceGain?: number,
    ) => Promise<string>;
    setPlayResult: (playing: boolean) => Promise<"ok" | "refused">;
    setReferenceGain: (gain: number) => Promise<"ok" | "refused">;
    /** Change max recording duration in seconds (clamped 5–MAX_RECORDING_DURATION_SEC). Affects next round only. */
    setRecordingDuration: (secs: number) => Promise<"ok" | "refused">;
    /** Change countdown seconds. Affects the NEXT call to startCountdown only. */
    setCountdownSecs: (secs: number) => Promise<"ok" | "refused">;
    /** Allow / forbid participants downloading the result mix. */
    setAllowDownload: (allow: boolean) => Promise<"ok" | "refused">;
    /** Set the metronome tempo (BPM). 0 = off (default). Clamped 0–240. */
    setMetronomeBpm: (bpm: number) => Promise<"ok" | "refused">;
    /**
     * Promotes the current mix result to be the new reference track (layered
     * recording). Copies mix.webm → reference_vN.webm on the server, clears
     * participant takes (they're baked into the new reference), and resets
     * the session to "preparing" for the next round.
     * Returns the new versioned reference URL.
     */
    /** If `sourceFile` is omitted, promotes the current mix result.
     *  Pass a participant filename (e.g. "rec_Alice.wav") to use that take
     *  directly as the next reference without mixing first. */
    promoteMix: (sourceFile?: string) => Promise<string>;
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_P2G: P2GSharedState = {
  sessionId: null,
  referenceUrl: null,
  referenceDuration: null,
  countdownSecs: 5,
  recordingDuration: 30,
  clapAt: null,
  syncSeed: 0,
  syncJitterMs: 0,
  calibRoundAt: null,
  cancelledClapAt: null,
  resultUrl: null,
  status: "idle",
  playRehearsal: false,
  playResult: false,
  referenceGain: 0.5,
  targetParticipantId: null,
  allowDownload: false,
  lyricsUrl: null,
  metronomeBpm: 0, // off by default — host opts in
  roundKind: "take",
};

/**
 * How long the CURRENT round records for.
 *
 * A sync round's length is set by the measurement (a fixed number of bars at a
 * fixed tempo), not by the host's song duration — and every place that decides
 * when recording stops has to agree, or the take is cut before the last beat.
 * Reading `p2g.recordingDuration` directly anywhere below is a bug.
 */
function roundDurationSec(p2g: P2GSharedState): number {
  return p2g.roundKind === "sync" ? syncRoundDurationSec() : p2g.recordingDuration;
}

const CLAP_BUFFER_MS = 800;

/**
 * Longest take the system can actually carry, in seconds. Exported because
 * the host panel's input must agree with it — two literals drift.
 *
 * This is NOT an arbitrary UX choice: it is the smallest link in a chain, and
 * every link has to be raised together or the take dies at whichever one was
 * missed. A take is uncompressed mono 48 kHz 16-bit on the way up, i.e.
 * 96 KB per second:
 *
 *   360 s × 96 KB/s = 33 MiB per singer
 *     ↳ nginx  `client_max_body_size`  50M   (nginx.conf.TEMPLATE, see below)
 *     ↳ route  MAX_UPLOAD_BYTES        60MB  (api/play2gether/record)
 *     ↳ client upload timeout                (uploadTimeoutMs below, scales)
 *
 * 50M is the real ceiling on take length: 50 MiB / 96 KB/s = 546 s (9:06).
 * Going past it gives a 413 at the edge that never reaches the app logs.
 *
 * The nginx limit lives in `server/nginx/templates/nginx.conf.template`.
 * `server/nginx/nginx.conf` is GENERATED from it by gomplate in the nginx
 * container's entrypoint on every start — editing that file changes nothing
 * and is silently reverted at the next boot.
 */
export const MAX_RECORDING_DURATION_SEC = 360;
const CALIBRATED_LATENCY_KEY = "play2gether:calibratedLatencyMs";
const OFFSET_SAMPLES = 5;

async function measureServerClockOffset(
  onStats?: (s: ClockStats) => void,
): Promise<number> {
  const results: { offset: number; rtt: number; status?: number; error?: string }[] = [];
  for (let i = 0; i < OFFSET_SAMPLES; i++) {
    try {
      const t1 = Date.now();
      const res = await fetch("/api/play2gether/time", { cache: "no-store" });
      if (!res.ok) {
        results.push({ offset: NaN, rtt: NaN, status: res.status });
        continue;
      }
      const body = await res.json();
      const t4 = Date.now();
      // NTP's four timestamps. `recv`/`send` straddle the server's own work, so
      // subtracting them takes the handler (auth, session lookup) out of both
      // the offset and the RTT — see the route for why that dominates here.
      // A server that sends neither degenerates to the old single-stamp form:
      // with recv = send = now, rtt = t4 − t1 and offset = now − (t1 + rtt/2).
      const serverRecv = typeof body.recv === "number" ? body.recv : body.now;
      const serverSend = typeof body.send === "number" ? body.send : body.now;
      const rtt = (t4 - t1) - (serverSend - serverRecv);
      const offset = ((serverRecv - t1) + (serverSend - t4)) / 2;
      results.push({ offset, rtt, status: res.status });
    } catch (e) {
      results.push({ offset: NaN, rtt: NaN, error: String(e) });
    }
  }
  console.log("[play2gether/sync] offset samples:", results);
  const valid = results.filter((r) => Number.isFinite(r.offset));
  if (valid.length === 0) {
    console.warn("[play2gether/sync] all samples failed — falling back to offset=0");
    return 0;
  }
  valid.sort((a, b) => a.rtt - b.rtt);
  const bestHalf = valid.slice(0, Math.ceil(valid.length / 2));
  bestHalf.sort((a, b) => a.offset - b.offset);
  const chosen = bestHalf[Math.floor(bestHalf.length / 2)].offset;
  console.log(`[play2gether/sync] selected offset=${chosen}ms (from ${valid.length} valid samples)`);
  // Hand the caller the shape of the measurement, not just its verdict. The
  // chosen offset alone can't tell you whether the probes agreed, and on a
  // high-jitter or path-asymmetric link (satellite, rural 4G) disagreement is
  // exactly the failure that shifts this singer's take in the mix.
  if (onStats) {
    try {
      const rtts = valid.map((r) => r.rtt);
      const offsets = valid.map((r) => r.offset);
      onStats({
        offsetMs: Math.round(chosen),
        validSamples: valid.length,
        rttMinMs: Math.round(Math.min(...rtts)),
        rttMedMs: Math.round(median(rtts)),
        rttMaxMs: Math.round(Math.max(...rtts)),
        offsetSpreadMs: Math.round(Math.max(...offsets) - Math.min(...offsets)),
      });
    } catch { /* never let telemetry break the sync path */ }
  }
  return chosen;
}

/**
 * ONE clock measurement per tab, shared by every hook instance.
 *
 * `offset` used to be `useState` inside the hook, and the hook is mounted more
 * than once per client (panel + LyricsBanner — see P2GRefPlayer for the same
 * problem in the reference player). So each instance ran its own five probes
 * and kept its own answer. Two independent draws from a jittery link are not
 * the same number: the 2026-09-01 session logged two `p2g_clock` rows one
 * second apart from the same participant, and on that link `offsetSpreadMs`
 * reached 46 ms.
 *
 * That difference does NOT cancel, which is the whole point. A clock error
 * cancels only because the reference, the metronome, the capture gate and
 * `captureDelayMs` are all derived from the same `localClapAt`. But the
 * reference is claimed by whichever instance reaches `scheduleReference` first
 * and the recorder by whichever reaches `P2G_ARMED_LOCKS` first — different
 * locks, so they can be different instances, and then the take is mixed against
 * a reference that started at a different instant than the one its
 * `captureDelayMs` was measured from. The gap goes straight into the mix.
 *
 * One promise, memoised, replayed to everyone. Also removes the duplicate five
 * probes and the duplicate beacon.
 */
let clockOffsetPromise: Promise<number> | null = null;
let sharedClockStats: ClockStats | null = null;
/** Module-level, not a ref: one `p2g_clock` row per tab, not one per instance. */
let clockBeaconSent = false;

function getSharedClockOffset(): Promise<number> {
  if (!clockOffsetPromise) {
    clockOffsetPromise = measureServerClockOffset((s) => { sharedClockStats = s; });
  }
  return clockOffsetPromise;
}

function derivePhase(p2g: P2GSharedState, now: number, offset: number): P2GPhase {
  switch (p2g.status) {
    case "idle":      return "idle";
    case "preparing": return "preparing";
    case "rehearsal": return "rehearsal";
    case "mixing":    return "mixing";
    case "done":      return "done";
    case "active": {
      const { clapAt } = p2g;
      if (!clapAt)                                          return "preparing";
      const localClapAt = clapAt - offset;
      const durationSec = roundDurationSec(p2g);
      if (now < localClapAt)                                return "countdown";
      if (now < localClapAt + durationSec * 1000)           return "recording";
      return "uploading";
    }
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

// Module-level locks shared across ALL hook instances in the same tab.
// usePlay2GetherSession gets instantiated multiple times in practice — once
// by Play2GetherClientPanel / Play2GetherHostPanel and a second time by
// Play2GetherLyricsBanner (which is rendered as a sibling and uses the hook
// just to read phase + refAudioEl). Each instance has its own per-clapAt
// ref, so the in-hook idempotency guard only dedups WITHIN one instance —
// across instances both would arm a MediaRecorder on the same mic and both
// would upload, producing two takes per participant (`<id>` and `<id>_2`).
//
// Keying by `${sessionId}:${clapAt}` makes the first instance to reach the
// guard claim the round; subsequent instances bail early. The locks live
// for the lifetime of the tab — bounded by takes-per-session, no cleanup
// needed in practice. Across separate tabs there's no contention because
// each tab is its own JS context (correctly — different tabs = different
// participants).
const P2G_ARMED_LOCKS = new Set<string>();
const P2G_UPLOADED_LOCKS = new Set<string>();
function p2gLockKey(sessionId: string | null | undefined, clapAt: number | null | undefined): string {
  return `${sessionId ?? "no-session"}:${clapAt ?? 0}`;
}

// ─── Calibration round ───────────────────────────────────────────────────────

/**
 * Warning the band gets before the clicks start.
 *
 * Not padding. Every participant has been told all session to wear headphones
 * — correctly, since that is the only way a sync round or a take can measure
 * them — and an acoustic calibration needs the exact opposite: the mic has to
 * hear the speakers. The round is over in ten seconds, so there is no reacting
 * to it once it has begun; this is the only window in which anyone can get
 * their headphones off. Long enough to read a sentence and move, short enough
 * that a host running it three times does not lose the rehearsal to it.
 */
export const CALIB_ROUND_LEAD_MS = 6000;

/**
 * How late a client may still join the round.
 *
 * `calibRoundAt` sits in shared state indefinitely, so without a window a
 * participant joining an hour later — or any panel that remounts — would start
 * clicking to themselves in the middle of a take. Seconds, not minutes: joining
 * late is harmless (each device measures only itself) but joining an hour late
 * is not a round, it is a surprise.
 */
const CALIB_ROUND_JOIN_WINDOW_MS = 4000;

/**
 * Mute every REMOTE participant's audio for the duration of a calibration
 * round, and put it back afterwards.
 *
 * This is the one thing in the feature where every device plays a click out of
 * its own speakers at the same instant — and music mode publishes with echo
 * cancellation OFF (AUDIO_MODE_PRESETS), so each of those clicks is broadcast
 * to everyone else and comes back out of their speakers, into the mic that is
 * at that moment hunting for its OWN click. Eleven players is ten extra clicks
 * per trial, arriving at whatever the network felt like.
 *
 * That is a systematic contaminant, which is precisely the failure mode doc 10
 * says the five trials do NOT protect against: it would hit every trial, they
 * would agree with each other, the spread check would pass, and the host would
 * get a confident wrong number with a green tick.
 *
 * Playback only. The mic is never touched — publishing is serialized behind
 * `runAudioOp` in MediaControls for reasons that cost a field session to learn
 * (see CLAUDE.md), and a measurement has no business reaching into it.
 */
function silenceRemoteAudio(room: Room | null | undefined): () => void {
  const restore: Array<() => void> = [];
  try {
    room?.remoteParticipants.forEach((p) => {
      try {
        const before = p.getVolume() ?? 1;
        p.setVolume(0);
        restore.push(() => { try { p.setVolume(before); } catch { /* gone */ } });
      } catch { /* one participant failing must not skip the rest */ }
    });
  } catch { /* no room, or an older client library — measure anyway */ }
  let done = false;
  return () => {
    if (done) return;        // idempotent: called from both then and catch
    done = true;
    restore.forEach((f) => f());
  };
}

/**
 * Fire-and-forget post of this client's calibration to session.json. Never
 * throws: a failed report must not turn a good measurement into an exception in
 * the middle of a round. The player still sees their own number either way, and
 * a missing row is visible to the host as a person who did not come back.
 */
function postCalibResult(
  sessionId: string | null | undefined,
  participantId: string,
  participantName: string,
  body: Record<string, unknown>,
) {
  if (!sessionId) return;
  try {
    void fetch("/api/play2gether/calib", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, participantId, participantName, ...body }),
    }).catch(() => {});
  } catch { /* noop */ }
}

// ─── Reference playback engine ───────────────────────────────────────────────
//
// ONE player per tab, shared by every hook instance, and the take is played
// from a decoded AudioBuffer scheduled on the audio clock instead of from the
// <audio> element.
//
// Why a module-level singleton:
//   The hook is mounted more than once per client (panel + LyricsBanner) and
//   each instance used to build its own <audio> element AND schedule its own
//   play() at the clap — so the reference was played twice, a few ms apart.
//   That is an audible comb filter, and it gives two different "reference
//   started" instants for something the mix pins at a single t=0. There is also
//   no fixed instance to hand the job to: the host panel is mounted
//   conditionally (HostContent renders it only while the panel is open) while
//   the banner is always mounted, so *which* instance exists depends on UI
//   state. Electing the first caller to schedule a given clapAt is the only
//   rule that survives that.
//
// Why an AudioBuffer instead of the element:
//   el.play() is asynchronous and starts the media pipeline whenever it gets
//   round to it — tens to ~100 ms, unmeasured and device-dependent. That delay
//   lands on everything the singer hears, so the take is recorded that much late
//   against a reference the mix places at t=0, and no calibration finds it: the
//   acoustic calibration measures a click through a plain AudioContext, a path
//   the element is not part of. Measured on a real session (2026-07-21): takes
//   ~240 ms late while calibration reported ~120 ms, and the host dialled the
//   ~100 ms difference in by hand every single round.
//   source.start(when) is sample-accurate against ctx.currentTime, so the only
//   remaining output-side term is ctx.outputLatency — which the browser reports
//   and which the acoustic calibration already measures.
//
// The element stays for rehearsal (looped, host-driven, not timing-critical)
// and as the fallback engine when decodeAudioData cannot handle the container.
// Safari with Opus-in-WebM is the case that matters: falling back to the old
// behaviour is worse alignment, but it is still playback.
type P2GRefPlayer = {
  url: string;
  ctx: AudioContext;
  analyser: AnalyserNode;
  el: HTMLAudioElement;
  /** Kept only so it can be disconnected on teardown. Closing the context used
   *  to do that for us; the context is shared now and outlives the player, so
   *  every node this player added to it has to be taken back off by hand or a
   *  session that promotes several mixes leaves a dead source per reference
   *  still wired to the destination. */
  elSource: MediaElementAudioSourceNode;
  /** Decoded reference. Null until decode resolves, or forever if it failed —
   *  both mean "use the element". */
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  /** ctx.currentTime the reference's t=0 maps to, so the playback position is
   *  always `ctx.currentTime - startedAt` even when we started mid-buffer on a
   *  late join. Null when nothing is playing. */
  startedAt: number | null;
  /** Round this player is already scheduled for — makes scheduling idempotent
   *  across hook instances. */
  scheduledClapAt: number | null;
  playTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
};

let refPlayer: P2GRefPlayer | null = null;

/** Told how the reference load went: the fetch is the other take-sized
 *  transfer in a round, and a failed decode silently downgrades playback to
 *  `el.play()`, which costs ~100 ms of unmeasured start delay — a SYNC
 *  regression, not just a slow load. Both are worth a row. */
export type RefLoadInfo = {
  ok: boolean;
  bytes: number | null;
  fetchMs: number;
  decodeMs: number | null;
  durationSec: number | null;
  sampleRate: number | null;
  /** True when decode failed and playback falls back to `el.play()`. */
  fallback: boolean;
  error?: string;
};

/**
 * The ONE AudioContext everything the player monitors goes through — the
 * reference and the click alike.
 *
 * They used to be separate: the reference on the player's own long-lived
 * context, the click on a `new AudioContext()` created and closed per round.
 * Nothing makes two contexts agree on their output latency, and on 2026-09-02
 * they measurably did not. Recording both paths back through the room, with the
 * player removed from the loop entirely (`scripts/p2g_monitor_latency.py`):
 *
 *     click     +99.8 ms  (±0.4 — it is a machine, so this is exact)
 *     reference +124.4 ms
 *     ------------------
 *     bias       +24.6 ms
 *
 * That difference is invisible to everything. A sync round measures a player
 * against the click and the mixer applies the number to a take monitored on the
 * reference, so those 25 ms are a pure systematic error in the transfer — no
 * scatter, no edge flag, no refusal, nothing to see. The only reason it was
 * ever found is that someone said the mixer needed more than the round measured
 * and the difference was chased with a microphone.
 *
 * One context makes the quantity stop existing rather than making it small: it
 * is not that the two latencies now agree, it is that there are no longer two.
 *
 * It is never closed while the tab lives — a reference change tears down the
 * nodes but keeps the context, because a new context is a new latency, and a
 * sync round measured before it would silently stop describing the player.
 */
let monitorCtx: AudioContext | null = null;

function getMonitorCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!monitorCtx || monitorCtx.state === "closed") monitorCtx = new AC();
  monitorCtx.resume().catch(() => { /* resumed again at the next user gesture */ });
  return monitorCtx;
}

function acquireRefPlayer(
  url: string,
  onLoad?: (info: RefLoadInfo) => void,
): P2GRefPlayer | null {
  if (typeof window === "undefined") return null;
  if (refPlayer && refPlayer.url !== url) destroyRefPlayer();
  if (!refPlayer) {
    const el = new Audio(url);
    el.preload = "auto";
    const ctx = getMonitorCtx();
    if (!ctx) return null;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    const elSource = ctx.createMediaElementSource(el);
    elSource.connect(analyser);
    elSource.connect(ctx.destination);

    const player: P2GRefPlayer = {
      url, ctx, analyser, el, elSource,
      buffer: null, source: null, startedAt: null, scheduledClapAt: null,
      playTimer: null, stopTimer: null, refCount: 0,
    };
    refPlayer = player;

    // Decode now, long before any round — decodeAudioData on a multi-MB file is
    // not something to be doing during a countdown.
    const t0 = Date.now();
    let fetchMs = 0;
    let bytes: number | null = null;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((ab) => {
        fetchMs = Date.now() - t0;
        bytes = ab.byteLength;
        return player.ctx.decodeAudioData(ab);
      })
      .then((buf) => {
        if (refPlayer !== player) return;
        player.buffer = buf;
        console.log(`[play2gether/sync] reference decoded (${buf.duration.toFixed(2)}s, ${buf.sampleRate}Hz) — scheduled playback armed`);
        try {
          onLoad?.({
            ok: true, bytes, fetchMs,
            decodeMs: Date.now() - t0 - fetchMs,
            durationSec: Math.round(buf.duration * 100) / 100,
            sampleRate: buf.sampleRate,
            fallback: false,
          });
        } catch { /* telemetry never breaks playback arming */ }
      })
      .catch((err) => {
        console.warn("[play2gether/sync] reference decode failed — falling back to <audio> playback (alignment will be worse):", err);
        try {
          onLoad?.({
            ok: false, bytes,
            fetchMs: fetchMs || Date.now() - t0,
            decodeMs: null, durationSec: null, sampleRate: null,
            fallback: true,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch { /* as above */ }
      });
  }
  refPlayer.refCount++;
  return refPlayer;
}

/** Takes the player the caller acquired: a release left over from a previous
 *  reference URL must not decrement the one that replaced it. */
function releaseRefPlayer(player: P2GRefPlayer | null): void {
  if (!player || refPlayer !== player) return;
  player.refCount--;
  if (player.refCount <= 0) destroyRefPlayer();
}

function destroyRefPlayer(): void {
  const p = refPlayer;
  if (!p) return;
  stopReference();
  p.el.src = "";
  try { p.elSource.disconnect(); } catch { /* already detached */ }
  try { p.analyser.disconnect(); } catch { /* already detached */ }
  // The context is deliberately NOT closed: it is shared with the metronome and
  // outlives any one reference. Closing it here would hand the next round a new
  // output latency, which is exactly the class of error this context exists to
  // remove — and would silently invalidate any sync offset measured before it.
  refPlayer = null;
}

/** Stops whichever engine is running and clears the pending schedule. */
function stopReference(): void {
  const p = refPlayer;
  if (!p) return;
  if (p.playTimer) { clearTimeout(p.playTimer); p.playTimer = null; }
  if (p.stopTimer) { clearTimeout(p.stopTimer); p.stopTimer = null; }
  if (p.source) {
    p.source.onended = null;
    try { p.source.stop(); } catch { /* never started */ }
    p.source.disconnect();
    p.source = null;
  }
  p.startedAt = null;
  if (!p.el.paused) p.el.pause();
}

/**
 * Start the reference so that its t=0 lands exactly on the clap. Idempotent per
 * round: whichever hook instance gets here first owns the schedule.
 *
 * Re-scheduling the same round is allowed only while the clap is still in the
 * future — the measured clock `offset` can settle during the countdown, the
 * same reason the capture start gate reschedules — and never once playback has
 * begun, which would restart the song under the singer.
 */
function scheduleReference(clapAt: number, localClapAt: number, durationSec: number): void {
  const p = refPlayer;
  if (!p) return;

  const sinceClapSec = (Date.now() - localClapAt) / 1000;
  if (sinceClapSec >= durationSec) return;                       // round is over
  if (p.scheduledClapAt === clapAt && sinceClapSec >= 0) return; // already running

  stopReference();
  p.scheduledClapAt = clapAt;
  p.ctx.resume().catch(() => {});

  if (p.buffer) {
    const src = p.ctx.createBufferSource();
    src.buffer = p.buffer;
    src.connect(p.analyser);
    src.connect(p.ctx.destination);
    // A late joiner starts mid-buffer rather than from the top, so their
    // reference is at the same place in the song as everyone else's.
    const offsetIntoBuffer = Math.max(0, sinceClapSec);
    const when = p.ctx.currentTime + Math.max(0, -sinceClapSec);
    src.start(when, offsetIntoBuffer);
    src.stop(when + Math.max(0, durationSec - offsetIntoBuffer));
    src.onended = () => {
      if (p.source !== src) return;
      p.source = null;
      p.startedAt = null;
    };
    p.source = src;
    p.startedAt = when - offsetIntoBuffer;

    const ctx = p.ctx as AudioContext & { baseLatency?: number; outputLatency?: number };
    console.log(
      `[play2gether/sync] reference scheduled on the audio clock in ` +
      `${((when - p.ctx.currentTime) * 1000).toFixed(1)}ms (offset ${(offsetIntoBuffer * 1000).toFixed(0)}ms into the buffer, ` +
      `base=${((ctx.baseLatency ?? 0) * 1000).toFixed(1)}ms out=${((ctx.outputLatency ?? 0) * 1000).toFixed(1)}ms)`,
    );
    return;
  }

  // Fallback engine: the old element path, start delay and all.
  const el = p.el;
  el.loop = false;
  try { el.currentTime = Math.max(0, sinceClapSec); } catch { /* metadata not in yet */ }
  const delayMs = Math.max(0, localClapAt - Date.now());
  p.playTimer = setTimeout(() => {
    p.playTimer = null;
    el.play().catch(() => {});
  }, delayMs);
  p.stopTimer = setTimeout(() => {
    p.stopTimer = null;
    el.pause();
  }, delayMs + Math.max(0, (durationSec - Math.max(0, sinceClapSec)) * 1000));
  console.warn("[play2gether/sync] reference playing via <audio> fallback — start delay is unmeasured");
}

/** Reference playback position in seconds, whichever engine is driving, or
 *  null when it isn't playing. The take engine's clock is the AudioContext, so
 *  this stays right even though the element never moves during a round. */
function referencePositionSec(): number | null {
  const p = refPlayer;
  if (!p) return null;
  if (p.source && p.startedAt != null) {
    return Math.max(0, p.ctx.currentTime - p.startedAt);
  }
  if (!p.el.paused) return p.el.currentTime;
  return null;
}

/** Output-side latency of the playback path, in ms. Meaningful now that the
 *  reference is scheduled rather than `play()`ed: this is the whole remaining
 *  delay between the scheduled instant and the sound leaving the speakers. */
/**
 * What the browser says the monitoring path costs, right now.
 *
 * Reported separately from `clapOffset` because `clapOffset` prefers a stored
 * acoustic calibration when there is one (`calibratedLatencyMs ?? …`), so on a
 * calibrated client it is a frozen constant — 133 ms all afternoon on
 * 2026-09-02 — and hides the live figure at exactly the moment the live figure
 * is the thing being questioned.
 *
 * The open question this exists to settle: a sync round measures a player
 * against the click, but a player who can predict a steady click ANTICIPATES it
 * and thereby cancels their own monitoring latency, so the number converges away
 * from the physical path the more they practise (doc 11's own four runs:
 * +118 → +130 → +101 → +87). If the browser's own figure agrees with where the
 * click physically lands — measured at +99.8 ms ±0.4 on 2026-09-02 by
 * `scripts/p2g_monitor_latency.py` — then the device half of the offset can be
 * read for free on every take, and it tracks drift (65 → 87 ms on a laptop,
 * 280 → ~1000 ms on a phone) that a once-per-session round cannot.
 */
function monitorLatencyMs(): { baseMs: number; outMs: number } {
  const ctx = monitorCtx as (AudioContext & { baseLatency?: number; outputLatency?: number }) | null;
  return {
    baseMs: Math.round((ctx?.baseLatency ?? 0) * 10000) / 10,
    outMs: Math.round((ctx?.outputLatency ?? 0) * 10000) / 10,
  };
}

function referenceOutputLatencyMs(): number {
  const p = refPlayer;
  if (!p) return 0;
  const ctx = p.ctx as AudioContext & { baseLatency?: number; outputLatency?: number };
  return ((ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0)) * 1000;
}

// ─── Result playback (the host's broadcast of the finished mix) ──────────────
//
// Shared for the same reason as the reference player: the hook is mounted twice
// per client (panel + LyricsBanner), so a per-instance `new Audio(resultUrl)`
// meant the mix was played by TWO elements. They start in the same tick but each
// pays its own `el.play()` start delay — tens of ms, independently — so the
// broadcast came out flanged, echoed and at double level. Note the banner
// returning `null` from render does NOT unmount it: its hook keeps running, so
// the second element existed even in sessions with no lyrics at all.
//
// One shared element makes play/pause idempotent: both instances calling it hit
// the same object. No refcount — it holds no hardware, and the browser drops it
// with the tab.
let resultAudio: { url: string; el: HTMLAudioElement } | null = null;

function getResultAudio(url: string): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (resultAudio && resultAudio.url !== url) {
    resultAudio.el.pause();
    resultAudio = null;
  }
  if (!resultAudio) resultAudio = { url, el: new Audio(url) };
  return resultAudio.el;
}

/**
 * @param options.capture When false, this instance does NOT run the
 *   recorder/upload/metronome machinery — it only reads shared state, phase
 *   and the reference audio element. The hook is instantiated TWICE per client
 *   (once by the panel, once by the LyricsBanner); if both instances captured
 *   and uploaded, the module-level upload lock let only ONE of them actually
 *   run doUpload — and since `uploading`/`uploadDone` are per-instance state,
 *   the panel (the one rendering the UI) could be the loser and stay stuck on
 *   the "Uploading…" spinner forever, never showing the "uploaded / waiting
 *   for host" confirmation. Also stops the metronome from double-triggering.
 *   The banner passes `{ capture: false }`; panels use the default.
 */
export function usePlay2GetherSession(
  options?: { capture?: boolean },
): UsePlay2GetherReturn {
  const capture = options?.capture ?? true;
  const room = useRoomContext();
  const { state, sendChange } = useSharedStateContext();

  const p2g: P2GSharedState = useMemo(
    () => ((state as any)?.play2gether as P2GSharedState) ?? DEFAULT_P2G,
    [state]
  );

  // null until the shared measurement resolves — distinct from a measured 0.
  const [measuredOffset, setMeasuredOffset] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSharedClockOffset().then((o) => { if (!cancelled) setMeasuredOffset(o); });
    return () => { cancelled = true; };
  }, []);

  /**
   * The offset this round is conducted with, pinned to its `clapAt`.
   *
   * Freshness is not the property that matters here — a stale offset cancels
   * exactly as well as a fresh one, because every instant in a round is derived
   * from the same `localClapAt`. What must never happen is the number MOVING
   * between one consumer reading it and another: the reference is scheduled
   * once and refuses to restart under a singer mid-take, while the capture gate
   * and `captureDelayMs` would happily follow a new value. So the round takes a
   * snapshot and lives with it.
   *
   * The snapshot is deliberately NOT taken before there is something to
   * snapshot: while the measurement is still in flight this returns 0 and pins
   * nothing, so a client that joins during a countdown still gets the settle
   * that `scheduleReference` and the start gate are written to expect. Pinning
   * an unmeasured 0 for the life of a round would be worse than not pinning.
   *
   * This is also why re-measuring during the countdown is the wrong fix for
   * clock drift (host machine, 2026-09-01: a clean 80 ppm, 384 → 106 ms over an
   * hour). Drift is harmless — it cancels. A clock STEP is not, and the answer
   * to that is a background re-measure between rounds, never inside one.
   */
  const roundOffsetRef = useRef<{ clapAt: number | null; offset: number }>({ clapAt: null, offset: 0 });
  const offset = useMemo(() => {
    if (measuredOffset == null) return 0;
    const clapAt = p2g.clapAt;
    if (clapAt == null) return measuredOffset;
    if (roundOffsetRef.current.clapAt !== clapAt) {
      roundOffsetRef.current = { clapAt, offset: measuredOffset };
    }
    return roundOffsetRef.current.offset;
  }, [measuredOffset, p2g.clapAt]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const phase = derivePhase(p2g, Date.now(), offset);
    if (phase !== "countdown" && phase !== "recording") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [p2g.status, p2g.clapAt, offset]);

  const phase = useMemo(() => derivePhase(p2g, now, offset), [p2g, now, offset]);

  const localIdentity = room?.localParticipant.identity ?? null;

  // One beacon per mount, as soon as there is an identity to attach it to.
  // Emitted here rather than inside the measurement so a slow room connect
  // doesn't produce an anonymous row. See `lib/p2gTelemetry.ts` for why this
  // rides the connection-log pipeline instead of an endpoint of its own.
  useEffect(() => {
    if (clockBeaconSent) return;
    if (!sharedClockStats || !localIdentity) return;
    clockBeaconSent = true;
    p2gLog(room, "p2g_clock", withNet({ ...sharedClockStats }));
  }, [localIdentity, room, measuredOffset]);
  const isLocalTarget = useMemo(() => {
    const t = p2g.targetParticipantId;
    if (!t) return true;
    return t === localIdentity;
  }, [p2g.targetParticipantId, localIdentity]);

  const targetName = useMemo(() => {
    const t = p2g.targetParticipantId;
    if (!t) return null;
    if (t === localIdentity) return room?.localParticipant.name || t;
    return room?.getParticipantByIdentity(t)?.name || t;
  }, [p2g.targetParticipantId, localIdentity, room]);

  const countdown = useMemo(() => {
    if (phase !== "countdown" || !p2g.clapAt) return 0;
    const localClapAt = p2g.clapAt - offset;
    return Math.max(0, Math.ceil((localClapAt - now) / 1000));
  }, [phase, p2g.clapAt, offset, now]);

  const recordingProgress = useMemo(() => {
    if (phase !== "recording" || !p2g.clapAt) return 0;
    const localClapAt = p2g.clapAt - offset;
    return Math.min(1, (now - localClapAt) / (roundDurationSec(p2g) * 1000));
  }, [phase, p2g.clapAt, offset, p2g.recordingDuration, p2g.roundKind, now]);

  // The player itself is shared across hook instances (see P2GRefPlayer); each
  // instance only holds a reference to it and reads its analyser.
  const [refAnalyser, setRefAnalyser] = useState<AnalyserNode | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !p2g.referenceUrl) { setRefAnalyser(null); return; }
    const player = acquireRefPlayer(p2g.referenceUrl, (info) =>
      p2gLog(room, "p2g_reference", withNet({ ...info })));
    setRefAnalyser(player?.analyser ?? null);
    return () => {
      setRefAnalyser(null);
      releaseRefPlayer(player);
    };
  }, [p2g.referenceUrl]);

  // Arm the round's reference playback. Every instance calls this; the first
  // one to reach it for a given clapAt owns the schedule and the rest no-op, so
  // it doesn't matter which instances happen to be mounted.
  //
  // No cleanup on purpose: this effect re-runs whenever the clock offset
  // settles or the duration is edited, and tearing playback down on every one
  // of those would cut the reference mid-take. Stopping is driven by the phase
  // effect below and by the stop the schedule itself carries.
  useEffect(() => {
    if (!p2g.clapAt || p2g.status !== "active" || !p2g.referenceUrl) return;
    // A sync round is click-only. The reference must not play: the detector
    // needs each hit standing alone in the take, and the player needs to be
    // locking to the click rather than to a mix that is already late in their
    // ears by the very amount being measured.
    if (p2g.roundKind === "sync") return;
    scheduleReference(p2g.clapAt, p2g.clapAt - offset, p2g.recordingDuration);
  }, [p2g.clapAt, p2g.status, p2g.referenceUrl, p2g.recordingDuration, p2g.roundKind, offset]);

  /** Reference playback position in seconds — lyrics and the visualiser read
   *  this instead of an element's currentTime, since the take is played from a
   *  scheduled buffer and no element moves during a round. */
  const getReferenceTime = useCallback(() => referencePositionSec(), []);

  // Rehearsal keeps using the element: it loops, the host drives it by hand and
  // nothing is being recorded against it, so its start delay costs nothing.
  // This also covers stopping a take that was abandoned before its scheduled
  // end (host closed the session mid-round).
  useEffect(() => {
    const player = refPlayer;
    if (!player) return;

    if (phase === "rehearsal" && p2g.playRehearsal) {
      player.ctx.resume().catch(() => {});
      player.el.currentTime = 0;
      player.el.loop = true;
      player.el.play().catch(() => {});
    } else if (phase !== "countdown" && phase !== "recording" && phase !== "uploading") {
      // `countdown` is excluded because the round's playback is already ARMED by
      // then — the buffer source is scheduled to start at the clap, and
      // stopReference() would cancel it before it ever sounded. (The old element
      // path tolerated a pause() here only because its play() was still sitting
      // in a setTimeout.)
      player.el.loop = false;
      stopReference();
    }
  }, [phase, p2g.playRehearsal, refAnalyser]);

  // Result playback goes through the shared element (see getResultAudio): both
  // hook instances drive the same object, so the second one is a no-op instead
  // of a second copy of the mix.
  useEffect(() => {
    if (!p2g.resultUrl) return;
    const audio = getResultAudio(p2g.resultUrl);
    if (!audio) return;
    if (p2g.playResult) {
      // Only rewind when it isn't already running: the other instance may have
      // started it a tick ago, and restarting would make the broadcast stutter
      // back to zero.
      if (audio.paused) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
    } else {
      audio.pause();
    }
  }, [p2g.playResult, p2g.resultUrl]);

  // ── Modificaciones del Grabador (Candados Síncronos) ───────────────────────
  const recorderRef   = useRef<AudioWorkletNode | null>(null);
  const recCtxRef     = useRef<AudioContext | null>(null);
  const chunksRef     = useRef<Float32Array[]>([]);
  const startedAtRef  = useRef<number>(0);

  // Robust-sync refs. The recorder graph is now PREWARMED during the countdown
  // (create AudioContext + load worklet + connect mic) and only START-gated at
  // the clap, so the capture-start delay is ~1 quantum instead of a
  // device-variable tens-to-hundreds of ms. `captureDelayMsRef` records the
  // residual `startedAt - localClapAt` so the mixer can compensate it as a
  // last-resort adelay (see doUpload → record route → mix).
  const captureDelayMsRef = useRef<number>(0);
  /** The mic's own reported input latency, kept apart from `clapOffset` so the
   *  beacon can report the live path even on a calibrated client. */
  const micLatencyMsRef = useRef<number>(0);
  // What the server made of this client's last sync round. Shown to the player
  // themselves: a refusal is almost always something only they can fix (play on
  // every click, get off Bluetooth), so it has to reach them and not just the
  // host's panel.
  const [syncResult, setSyncResult] = useState<SyncRoundResult | null>(null);
  const [syncRefused, setSyncRefused] = useState<string | null>(null);
  /**
   * The clapAt this client actually TOOK PART IN — set the moment prewarm
   * commits to arming, before anything can go wrong with the mic.
   *
   * The distinction it exists to draw is between "we tried and the capture
   * failed", which is a real failure the host must see, and "we were not here",
   * which is not a failure at all. Without it a participant who joined the room
   * mid-take reached `doUpload`, found no chunks, and was told their microphone
   * had failed — while a failure row went to the host's panel under their name.
   * On an eleven-person session that is exactly the noise that hides the
   * dropped takes that did happen.
   */
  const roundJoinedRef    = useRef<number | null>(null);

  /**
   * This client is nominally recording a round it was not present for.
   *
   * Read from a ref during render on purpose: `roundJoinedRef` is settled
   * during the countdown (prewarm either commits or declines on the staleness
   * guard), and every phase transition re-renders, so by the time this is
   * consulted it cannot be mid-flight.
   *
   * `isLocalTarget` is not enough on its own and that is the whole bug: an
   * everyone-round has no target, so anybody who walks into the room during a
   * take is "the target" of a round they were never in.
   */
  const missedRound =
    (phase === "recording" || phase === "uploading") &&
    isLocalTarget &&
    p2g.clapAt != null &&
    roundJoinedRef.current !== p2g.clapAt;

  // Guards: prewarm runs once per clapAt; start fires once per clapAt.
  const prewarmingRef     = useRef<boolean>(false);
  const startedForClapRef = useRef<number | null>(null);
  // Set to the clapAt once its recorder graph is prewarmed and armed — this is
  // the signal that lets the separate "schedule start" effect run.
  const [prewarmedClapAt, setPrewarmedClapAt] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    fetch("/play2gether-capture-worklet.js", { method: "GET", cache: "force-cache" }).catch(() => {});
  }, []);

  const playbackLatencyMsRef = useRef<number>(0);
  const captureSampleRateRef = useRef<number>(48000);
  const [calibratedLatencyMs, setCalibratedLatencyMs] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(CALIBRATED_LATENCY_KEY);
    if (stored == null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  });
  const [uploading,   setUploading]   = useState(false);
  const [uploadDone,  setUploadDone]  = useState(false);
  // Position in the staggered upload queue while waiting for this client's
  // turn: `{ slot, total }`, 1-based, or null when not waiting. Surfaced so the
  // participant sees "waiting for your turn" instead of a screen that looks
  // finished — closing the tab here loses the take, it's still only in memory.
  const [uploadSlot, setUploadSlot] = useState<{ slot: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadErrorKind, setUploadErrorKind] = useState<"capture" | "upload" | null>(null);
  // Per-round upload idempotency. The upload useEffect can re-fire when an
  // unrelated dep changes during the same uploading phase (e.g. a refresh
  // of `room` or shared-state revisions arriving after recording ended).
  // Without this guard the second invocation reads the same chunksRef and
  // uploads a duplicate of the take — which the server then keys with `_2`
  // because the original identity already exists. Reset on every new clapAt.
  const uploadedClapAtRef = useRef<number | null>(null);

  // Mirror of `cancelledClapAt` readable from inside the staggered upload's
  // closure. `run()` fires from a setTimeout scheduled seconds earlier, so it
  // closes over the state as it was when the round ENDED — which is before the
  // host pressed cancel. A ref is the only thing that sees the current value.
  const cancelledClapAtRef = useRef<number | null>(null);
  useEffect(() => {
    cancelledClapAtRef.current = p2g.cancelledClapAt ?? null;
  }, [p2g.cancelledClapAt]);

  // Prewarm the recorder graph during the countdown. Paying the AudioContext +
  // worklet-module setup here (seconds before the clap) is the core of the
  // robust-sync fix: at the clap we only flip the worklet's start gate, so
  // capture begins within one render quantum on every device instead of after
  // a variable async delay that used to leave takes running ahead.
  useEffect(() => {
    if (!capture) return;
    if (p2g.status !== "active" || !p2g.clapAt || !isLocalTarget) return;
    const clapAt = p2g.clapAt;

    if (prewarmingRef.current || recorderRef.current) return;
    // Cross-instance dedup: another hook instance in this tab (e.g. the
    // LyricsBanner) must not also arm a recorder on the same mic.
    const lockKey = p2gLockKey(p2g.sessionId, clapAt);
    if (P2G_ARMED_LOCKS.has(lockKey)) return;

    // Don't prewarm for a clap already well in the past (stale snapshot on a
    // late join).
    //
    // `clapAt` is SERVER time, so it has to be converted before it can be
    // compared to a local clock. This used to subtract nothing, on the
    // reasoning that prewarm timing isn't critical — true for precision, false
    // for this comparison: the error is the full clock skew, and once that
    // exceeds the window every client silently declines to record. With the
    // host's own skew baked into `clapAt`, the round dies with no log line, no
    // error, and doUpload later blaming a microphone that was fine.
    //
    // The old form tolerated skew only up to countdownSecs + CLAP_BUFFER_MS +
    // 5 s (~10.8 s at the defaults) — which is why a server drifting under
    // 10 s looked harmless for so long.
    const localClapAtGuard = clapAt - offset;
    if (localClapAtGuard - Date.now() < -5000) {
      console.warn(
        `[play2gether/sync] prewarm skipped: clap is ${Math.round((Date.now() - localClapAtGuard) / 1000)}s in the past ` +
        `(clapAt=${clapAt}, offset=${Math.round(offset)}ms). Stale round, or the server clock moved.`,
      );
      return;
    }

    P2G_ARMED_LOCKS.add(lockKey);
    // Past the staleness guard above, so this round is ours: anything that goes
    // wrong from here IS a failure worth reporting.
    roundJoinedRef.current = clapAt;
    prewarmingRef.current = true;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Give-up deadline: once the take window is over there's nothing to capture.
    // Same clock conversion as above — `clapAt` is server time and this is
    // compared against local `Date.now()`, so an uncorrected skew moves the
    // deadline by its full magnitude and can retire the mic-retry loop before
    // the take has even started.
    const deadline = clapAt - offset + roundDurationSec(p2g) * 1000 + 2000;

    const releaseLock = () => {
      prewarmingRef.current = false;
      P2G_ARMED_LOCKS.delete(lockKey);
    };

    const arm = async (rawTrack: MediaStreamTrack) => {
      const recCtx = new AudioContext();
      recCtx.resume().catch(() => {});
      try {
        await recCtx.audioWorklet.addModule("/play2gether-capture-worklet.js");
      } catch (err) {
        console.error("[play2gether/sync] AudioWorklet module failed to load:", err);
        recCtx.close().catch(() => {});
        releaseLock();
        setUploadError("Recording engine failed to start — nothing was recorded. Ask the host to run the round again.");
        setUploadErrorKind("capture");
        reportP2GFailure(
          p2g.sessionId,
          room?.localParticipant.identity ?? "unknown",
          room?.localParticipant.name || (room?.localParticipant.identity ?? "unknown"),
          "Recording engine failed to start (AudioWorklet load error)",
          clapAt,
        );
        return;
      }
      if (cancelled) {
        // Torn down while the module was loading. The graph was never built,
        // so nothing here owns the lock any more — the cleanup below released
        // it, and a remount may already have armed its own context. Close only
        // OUR context; the refs were never assigned at this point.
        console.warn("[play2gether/sync] prewarm cancelled during worklet load — a remount will re-arm");
        recCtx.close().catch(() => {});
        return;
      }

      const micSource = recCtx.createMediaStreamSource(new MediaStream([rawTrack]));
      const workletNode = new AudioWorkletNode(recCtx, "p2g-capture");
      micSource.connect(workletNode);

      const silentSink = recCtx.createGain();
      silentSink.gain.value = 0;
      workletNode.connect(silentSink);
      silentSink.connect(recCtx.destination);

      recCtxRef.current = recCtx;
      captureSampleRateRef.current = recCtx.sampleRate;

      chunksRef.current = [];
      workletNode.port.onmessage = (e) => {
        if (e.data instanceof Float32Array) {
          chunksRef.current.push(e.data);
        }
      };

      // Round-trip estimate reported as this take's `clapOffset` when the user
      // hasn't calibrated. The OUTPUT half is read off the reference player's
      // context, not the recorder's: the singer follows the reference, so the
      // delay that matters is the one on the path the reference actually takes
      // to their ears. That is only a fair estimate now that the reference is
      // scheduled on the audio clock — while it was `el.play()`ed, this number
      // was missing the element's start delay entirely, which is exactly what
      // left ~100 ms uncorrectable in the mixer.
      const micLat = (rawTrack.getSettings() as MediaTrackSettings & { latency?: number }).latency ?? 0;
      micLatencyMsRef.current = Math.round(micLat * 10000) / 10;
      playbackLatencyMsRef.current = Math.round(referenceOutputLatencyMs() + micLat * 1000);

      recorderRef.current = workletNode;
      // Signal the "schedule start" effect that the graph is armed.
      setPrewarmedClapAt(clapAt);
      console.log(`[play2gether/sync] recorder prewarmed for clapAt=${clapAt} (sr=${recCtx.sampleRate})`);
    };

    // The mic publish is serialized (runAudioOp) and may still be in flight when
    // the round starts, so the track often isn't there on the first look. Retry
    // until it appears rather than bailing permanently (the old bail left the
    // participant with an empty take → "No audio was recorded", and the host
    // with a silent no-op). Surface a clear error if it never shows up.
    const attempt = () => {
      if (cancelled) return;
      const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      const rawTrack = pub?.track?.mediaStreamTrack;
      if (rawTrack && rawTrack.readyState !== "ended") {
        // `arm` is async and only its addModule step has a try/catch, so
        // anything that throws after it — `new AudioWorkletNode` when the
        // module loaded but registered no processor, a mic track that dies
        // between the readyState check and createMediaStreamSource — used to
        // become an unhandled rejection: no message, no log, the lock never
        // released, and a round that fails with "mic track missing" while the
        // mic was fine. Never fire an async setup without catching it.
        arm(rawTrack).catch((err) => {
          console.error("[play2gether/sync] recorder setup failed after module load:", err);
          releaseLock();
          setUploadError("Recording engine failed to start — nothing was recorded. Ask the host to run the round again.");
          setUploadErrorKind("capture");
          reportP2GFailure(
            p2g.sessionId,
            room?.localParticipant.identity ?? "unknown",
            room?.localParticipant.name || (room?.localParticipant.identity ?? "unknown"),
            `Recorder setup failed: ${err instanceof Error ? err.message : String(err)}`,
            clapAt,
          );
        });
        return;
      }
      if (Date.now() > deadline) {
        console.warn("[play2gether] mic never became available — nothing recorded");
        releaseLock();
        const reason = "No microphone available — nothing was recorded. Turn your mic on and ask the host to run the round again.";
        setUploadError(reason);
        setUploadErrorKind("capture");
        reportP2GFailure(
          p2g.sessionId,
          room?.localParticipant.identity ?? "unknown",
          room?.localParticipant.name || (room?.localParticipant.identity ?? "unknown"),
          "No microphone available — nothing recorded",
          clapAt,
        );
        return;
      }
      retryTimer = setTimeout(attempt, 150);
    };
    attempt();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Hand the lock back if this run never got as far as building the graph.
      //
      // Without this the round dies silently: `arm()` awaits
      // `audioWorklet.addModule`, and a teardown during that await returns
      // early WITHOUT releasing — while `prewarmingRef` stays true and the
      // lock stays held, so the remount bails at the guard and nobody ever
      // arms. No error, no log, zero chunks, and doUpload reports "mic track
      // missing" for a mic that was there all along. Worse, `prewarmingRef`
      // latches: every LATER round in the tab fails the same way until reload.
      //
      // React StrictMode makes it certain rather than merely possible —
      // mount → cleanup → mount always lands inside that await — which is why
      // this bites every round in dev and only a raced dep change in prod.
      //
      // Guarded on `recorderRef`: once the graph exists the teardown effect
      // owns it, and releasing here would let a second context arm the mic.
      if (!recorderRef.current) releaseLock();
    };
    // `offset` is a real dependency now: it decides the guard above, and it
    // settles asynchronously after mount. Without it a first run against
    // offset=0 can decline the round and never reconsider. Re-running once it
    // settles is safe — an armed graph short-circuits at the guards, and the
    // cleanup only hands back the lock when nothing was armed.
  }, [capture, p2g.status, p2g.clapAt, isLocalTarget, p2g.sessionId, room, offset]);

  // Fire the start gate at the clap. Separate from prewarm so it can reschedule
  // cleanly if the measured clock `offset` settles after the graph is armed,
  // without re-paying the setup cost. Records the residual capture-start delay.
  useEffect(() => {
    if (!capture) return;
    if (prewarmedClapAt == null || prewarmedClapAt !== p2g.clapAt) return;
    const node = recorderRef.current;
    if (!node) return;
    if (startedForClapRef.current === prewarmedClapAt) return;

    const localClapAt = prewarmedClapAt - offset;
    const fire = () => {
      if (startedForClapRef.current === prewarmedClapAt) return;
      startedForClapRef.current = prewarmedClapAt;
      const startedAt = Date.now();
      startedAtRef.current = startedAt;
      captureDelayMsRef.current = Math.max(0, Math.round(startedAt - localClapAt));
      node.port.postMessage({ cmd: "start" });
      console.log(`[play2gether/sync] capture start gated at +${startedAt - localClapAt}ms from clap (Δcap)`);
      // Not during a sync round. On speakers this burst lands in the take as a
      // loud broadband transient one output-latency after t=0 — precisely the
      // shape the onset detector is hunting for, and competing with the player
      // for the vote. The metronome downbeat already marks the same instant.
      if (p2g.roundKind !== "sync") playClapSound();
    };

    const remaining = localClapAt - Date.now();
    if (remaining <= 0) { fire(); return; }
    const timer = setTimeout(fire, remaining);
    return () => clearTimeout(timer);
  }, [capture, prewarmedClapAt, p2g.clapAt, p2g.roundKind, offset]);

  useEffect(() => {
    if (phase === "countdown" || phase === "recording") return;
    const node = recorderRef.current;
    if (!node) return;
    // Stop the gate first (so a late quantum can't append past the take), then
    // tear the graph down. Reset the per-round guards so the next clapAt
    // prewarms afresh.
    node.port.postMessage({ cmd: "stop" });
    node.port.onmessage = null;
    node.disconnect();
    recorderRef.current = null;
    recCtxRef.current?.close().catch(() => {});
    recCtxRef.current = null;
    prewarmingRef.current = false;
    setPrewarmedClapAt(null);
  }, [phase]);

  // Metronome — optional, OFF unless the host sets a BPM (> 0). Clicks are
  // phase-locked to the clap: tick k=0 is the downbeat ON the clap, negative k
  // are the count-in during the countdown, positive k run through the take.
  // Audible cue only — never injected into the recording. Plays on clients that
  // record this round (isLocalTarget).
  useEffect(() => {
    // A sync round IS the click: it runs at the fixed measurement tempo whatever
    // the host set for the song, because the detector's freedom from beat-alias
    // is an arithmetic property of that tempo. See `app/lib/p2gSync.ts`.
    const bpm = p2g.roundKind === "sync" ? SYNC_BPM : p2g.metronomeBpm;
    if (!capture) return;
    if (p2g.status !== "active" || !p2g.clapAt || !isLocalTarget || !(bpm > 0)) return;
    const beatMs = 60000 / bpm;
    if (!Number.isFinite(beatMs) || beatMs <= 0) return;
    // The SAME context the reference plays on. Not a context of its own — see
    // `getMonitorCtx`, and doc 11's "the two paths" section: a click and a
    // reference on two contexts had a measured 24.6 ms of latency between them,
    // and a sync round exists precisely to carry a number from the one to the
    // other.
    //
    // A second, quieter benefit: this context has been running since the
    // reference was loaded, so `currentTime` is a clock that is actually
    // ticking. The per-round context was brand new, and the wall-to-audio
    // mapping taken from a context that has not started rendering is not
    // obviously sound — which was the standing doubt about the previous fix
    // here. It stops mattering once the context is warm.
    const ctx = getMonitorCtx();
    if (!ctx) return;

    // A sync round plays no reference, so it never printed the one line that
    // says what the monitoring path costs — which is the line you need most,
    // because a sync round is the measurement being questioned.
    {
      const { baseMs, outMs } = monitorLatencyMs();
      console.log(
        `[play2gether/sync] metronome on the shared monitor context ` +
        `(base=${baseMs}ms out=${outMs}ms, kind=${p2g.roundKind ?? "take"})`,
      );
    }

    const localClapAt = p2g.clapAt - offset;
    const endMs = localClapAt + roundDurationSec(p2g) * 1000;

    // Schedule every tick from now → end up front (≤ ~a few hundred ticks).
    const beatsPerBar = 4;
    // Anchor the audio clock against the wall clock ONCE, and map every tick
    // through that same pair. There is deliberately NO lead added here.
    //
    // This read `ctx.currentTime + 0.06`, commented "small lead so the first
    // tick isn't dropped" — but the 0.06 was added to every tick, not to the
    // first, so the whole click grid sounded 60 ms after the instants it was
    // supposed to mark. `scheduleReference` and the capture gate carry no such
    // lead, so the click was the only displaced thing in the round; and a sync
    // round is click-only (the reference is deliberately silenced), so the
    // player has nothing else to lock to. Their measured offset therefore came
    // back 60 ms too large — every round, for everyone, indistinguishable from
    // a band that drags — and the mixer pulled every take that much too far
    // forward. Field session 2026-09-01: "la mayoría adelantadas".
    //
    // Dropping a tick already in the past is what the `continue` below is for,
    // and for one tick that is the correct answer: you cannot sound an instant
    // that has gone. Do NOT re-add a lead to save it.
    //
    // Anchoring once also fixes a second, much smaller error: `Date.now()` was
    // re-read per iteration, so each tick was early by however long the loop
    // had been running.
    const clockAnchor = ctx.currentTime;
    const wallAnchor = Date.now();
    const scheduled: OscillatorNode[] = [];
    // A sync round may be randomised. `syncBeatMs` is the single definition of
    // where beat k falls, shared with the detector — see p2gSync.ts. Jitter is
    // only ever applied to a sync round: a take round's metronome is a musical
    // aid, and an irregular one would be sabotage.
    const isSync = p2g.roundKind === "sync";
    const seed = isSync ? (p2g.syncSeed ?? 0) : 0;
    const jitterMs = isSync ? (p2g.syncJitterMs ?? 0) : 0;
    const beatAt = (i: number) => syncBeatMs(i, bpm, seed, jitterMs);

    // `k` steps a beat at a time and jitter can only move a tick by a fraction
    // of a beat, so stepping from the plain grid stays correct.
    let k = Math.ceil((Date.now() - localClapAt) / beatMs); // first tick not already past
    for (; ; k++) {
      const tickMs = localClapAt + beatAt(k);
      if (tickMs > endMs + SYNC_JITTER_MS) break;
      const when = clockAnchor + (tickMs - wallAnchor) / 1000;
      if (when < ctx.currentTime) continue;
      const isDownbeat = (((k % beatsPerBar) + beatsPerBar) % beatsPerBar) === 0;
      const osc = scheduleMetronomeClick(ctx, when, isDownbeat);
      if (osc) scheduled.push(osc);
    }

    // Cancel this round's remaining ticks. Closing the context is no longer an
    // option — it is the reference's context too, and closing it would silence
    // the take and hand the next round a fresh output latency. `stop()` on an
    // oscillator whose start is still in the future means it never sounds.
    return () => {
      for (const osc of scheduled) {
        try { osc.stop(); } catch { /* already finished */ }
        try { osc.disconnect(); } catch { /* already detached */ }
      }
    };
  }, [capture, p2g.status, p2g.clapAt, p2g.metronomeBpm, p2g.recordingDuration, p2g.roundKind,
      p2g.syncSeed, p2g.syncJitterMs, isLocalTarget, offset]);

  const doUpload = useCallback(() => {
    if (!p2g.sessionId) return;
    const identity   = room?.localParticipant.identity ?? "unknown";
    const displayName = room?.localParticipant.name || identity;
    const chunks = chunksRef.current;
    if (chunks.length === 0) {
      // Capture produced nothing — re-uploading can't fix it, the round has to
      // be re-run. Mark it "capture" so the UI hides the useless retry button,
      // and tell the host so a dropped take isn't mistaken for a slow one.
      setUploadError("No audio was recorded (mic track missing). Ask the host to run the round again.");
      setUploadErrorKind("capture");
      reportP2GFailure(p2g.sessionId, identity, displayName, "No audio was recorded (mic track missing)", p2g.clapAt);
      return;
    }
    const sampleRate = captureSampleRateRef.current;
    const blob       = encodeWAV(chunks, sampleRate);
    const clapOffset = calibratedLatencyMs ?? playbackLatencyMsRef.current;
    // Distinguish a trusted acoustic-calibration value from the flaky browser
    // auto-detection, so the mixer can surface it and let the host decide.
    const calibrated = calibratedLatencyMs != null;
    // Residual capture-start delay after prewarm+gate. Deterministic (unlike
    // clapOffset) — the mixer compensates it automatically so takes stop
    // running ahead of the reference. Should now be ~a few ms, not tens.
    const captureDelayMs = captureDelayMsRef.current;

    setUploadError(null);
    setUploadErrorKind(null);
    setUploadDone(false);
    setUploading(true);

    // Stagger the upload. Every client finishes recording at the same instant
    // (same clapAt + same duration), so without this a 10-singer round fires
    // ten ~17 MB uploads simultaneously. Four concurrent uploads were already
    // enough to stall the server once (see the streaming-upload rewrite in the
    // record route), and each arrival now also spawns transcode + peaks work.
    //
    // On a shared link this costs nothing: the same bytes cross the same pipe
    // either way, they just arrive in order instead of ten TCP streams fighting
    // and timing out together. It only costs wall-clock time when there was
    // spare bandwidth — i.e. when there was no problem to begin with.
    const { slot, total, delayMs } = uploadStagger(room, p2g.targetParticipantId);

    // What we captured, recorded BEFORE the bytes leave. Two things depend on
    // this row existing: the shortfall (a take shorter than the round means
    // capture stopped early — the failure that once ate 45 % of every take),
    // and the fact that a `p2g_take` with no matching `p2g_upload` is a take
    // that died in memory. The upload wait is the one window where a take
    // exists nowhere else and has no retry, so its absence has to be visible.
    const takeBytes = blob.size;
    const capturedSamples = chunks.reduce((sum, c) => sum + c.length, 0);
    const capturedMs = Math.round((capturedSamples / sampleRate) * 1000);
    const isSyncRound = p2g.roundKind === "sync";
    const monLat = monitorLatencyMs();
    const expectedMs = Math.round(roundDurationSec(p2g) * 1000);
    p2gLog(room, "p2g_take", withNet({
      clapAt: p2g.clapAt,
      bytes: takeBytes,
      sampleRate,
      capturedMs,
      expectedMs,
      shortfallMs: expectedMs - capturedMs,
      captureDelayMs,
      clapOffsetMs: clapOffset,
      calibrated,
      // The LIVE monitoring path, which `clapOffsetMs` hides whenever a stored
      // calibration exists. Three fields rather than a sum so a device that
      // reports one and not the other is legible: `outMs` is 0 on a context
      // that has not rendered yet, and absent entirely in some browsers.
      monBaseMs: monLat.baseMs,
      monOutMs: monLat.outMs,
      micLatMs: micLatencyMsRef.current,
      slot: slot + 1,
      total,
      staggerDelayMs: delayMs,
      kind: p2g.roundKind,
    }));

    // The clapAt these bytes belong to, captured now: by the time the staggered
    // `run()` fires, a cancel has already set `p2g.clapAt` to null.
    const roundClapAt = p2g.clapAt;
    let dropped = false;

    const run = () => {
      setUploadSlot(null);
      // The host abandoned this round while we sat in the stagger queue. Send
      // nothing: the take is for a round that no longer exists, and uploading
      // it only puts a file the host has to recognise and delete next to the
      // real ones. Checked here rather than at the top of `doUpload` because
      // the wait is exactly the window in which a cancel arrives.
      //
      // Resolves rather than returning undefined: `waited` is `run()` itself
      // when there is no stagger delay, and the chain below calls `.then` on it.
      if (cancelledClapAtRef.current != null && cancelledClapAtRef.current === roundClapAt) {
        console.log(`[play2gether/sync] upload dropped — round ${roundClapAt} was cancelled by the host`);
        dropped = true;
        return Promise.resolve();
      }
      // Wall-clock of the transfer itself, so `kbps` is this client's real
      // uplink for a take-sized body — the number that decides whether a
      // simultaneous round is viable on a given link at a given take length.
      const startedAt = Date.now();
      const finish = (
        ok: boolean,
        timings: ServerUploadTimings = { recvMs: null, serverMs: null },
        error?: string,
      ) => {
        const uploadMs = Date.now() - startedAt;
        // The record route responds only after transcode + peaks + lock +
        // session.json, so the client's wall-clock is transfer AND server work
        // combined. Using it as a bandwidth figure understates a good link on
        // a busy server — which is the wrong way to be wrong when this number
        // decides whether a simultaneous round is viable. Prefer the server's
        // own receive time, and say which one was used.
        const transferMs = timings.recvMs ?? uploadMs;
        p2gLog(room, "p2g_upload", withNet({
          clapAt: p2g.clapAt,
          ok,
          bytes: takeBytes,
          waitMs: delayMs,
          uploadMs,
          recvMs: timings.recvMs,
          serverMs: timings.serverMs,
          // bytes*8/ms is bits per ms, i.e. kbit/s exactly.
          kbps: transferMs > 0 ? Math.round((takeBytes * 8) / transferMs) : null,
          kbpsSource: timings.recvMs != null ? "server" : "wall",
          ...(error ? { error } : {}),
        }));
      };
      return uploadRecording(p2g.sessionId!, identity, displayName, blob, clapOffset, calibrated,
                             captureDelayMs, isSyncRound,
                             isSyncRound ? (p2g.syncSeed ?? 0) : 0,
                             isSyncRound ? (p2g.syncJitterMs ?? 0) : 0)
        .then(
          (timings) => {
            finish(true, timings);
            if (isSyncRound) {
              setSyncResult(timings.sync ?? null);
              setSyncRefused(timings.sync ? null : (timings.syncRefused ?? "the sync round could not be measured"));
            }
          },
          (err) => {
            finish(false, undefined, err instanceof Error ? err.message : String(err));
            throw err; // the existing .catch owns the user-visible handling
          },
        );
    };
    const waited = delayMs > 0
      ? (setUploadSlot({ slot: slot + 1, total }),
         new Promise<void>((r) => setTimeout(r, delayMs)).then(run))
      : run();

    waited
      .then(() => { if (!dropped) setUploadDone(true); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[play2gether] upload failed:", msg);
        // The take is still in chunksRef — this is a recoverable network/server
        // failure, so keep it "upload" (retry button re-sends the same bytes).
        setUploadError(msg);
        setUploadErrorKind("upload");
        if (p2g.sessionId) {
          reportP2GFailure(p2g.sessionId, identity, displayName, `Upload failed: ${msg}`, p2g.clapAt);
        }
      })
      .finally(() => { setUploading(false); setUploadSlot(null); });
    // `roundKind` and `recordingDuration` are here because this function now
    // reads both (through `roundDurationSec`). In practice they always change
    // together with `clapAt`, so the closure was already fresh — but relying on
    // that is how a stale read gets introduced later. Refreshing the closure
    // cannot re-fire an upload: the effect that calls this has its own dep list
    // and is guarded by both P2G_UPLOADED_LOCKS and `uploadedClapAtRef`.
  }, [p2g.sessionId, p2g.clapAt, p2g.targetParticipantId, p2g.roundKind,
      p2g.recordingDuration, room, calibratedLatencyMs]);

  // A new round's countdown clears the previous round's verdict, so a player
  // never reads last round's "+180 ms, steady" while recording the next one.
  useEffect(() => {
    if (phase === "countdown") { setSyncResult(null); setSyncRefused(null); }
  }, [phase, p2g.clapAt]);

  const setCalibratedLatency = useCallback((ms: number | null) => {
    const value = ms == null ? null : Math.max(0, Math.round(ms));
    setCalibratedLatencyMs(value);
    if (typeof window !== "undefined") {
      if (value == null) window.localStorage.removeItem(CALIBRATED_LATENCY_KEY);
      else window.localStorage.setItem(CALIBRATED_LATENCY_KEY, String(value));
    }
  }, []);

  const publishCalibration = useCallback((result: {
    latencyMs: number; spreadMs: number; unstable: boolean; trials: number[];
  }) => {
    const identity = room?.localParticipant.identity ?? "unknown";
    postCalibResult(p2g.sessionId, identity, room?.localParticipant.name || identity, {
      latencyMs: result.latencyMs,
      spreadMs: result.spreadMs,
      unstable: result.unstable,
      trialsMs: result.trials,
    });
  }, [room, p2g.sessionId]);

  const clearPublishedCalibration = useCallback(() => {
    if (!p2g.sessionId) return;
    const identity = room?.localParticipant.identity ?? "unknown";
    try {
      void fetch("/api/play2gether/calib", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: p2g.sessionId, participantId: identity }),
      }).catch(() => {});
    } catch { /* noop */ }
  }, [room, p2g.sessionId]);

  // ── Calibration round ──────────────────────────────────────────────────────
  //
  // The host presses once and every device measures its own acoustic round trip
  // at the same moment. Everyone at once is safe for the same reason a sync
  // round is: participants are remote, so each mic hears only its own room —
  // with the one exception of the clicks arriving back over LiveKit, which
  // `silenceRemoteAudio` removes for the duration.
  const [calibRound, setCalibRound] = useState<CalibRoundState>(IDLE_CALIB_ROUND);

  // Everything the runner needs that is NOT the trigger, held in a ref so the
  // effect below can depend on `calibRoundAt` alone. The clock offset settles
  // asynchronously and the room object is re-created on reconnect; either one
  // in the dep list would tear a run down halfway and start it again, and the
  // player would hear ten more clicks with no idea why.
  const calibCtxRef = useRef({ offset, room, sessionId: p2g.sessionId, phase });
  calibCtxRef.current = { offset, room, sessionId: p2g.sessionId, phase };

  useEffect(() => {
    // One run per client, not one per hook instance: the panel and the
    // LyricsBanner both mount this hook, and two overlapping runs would each
    // open their own getUserMedia and click over the other's measurement. The
    // same gate the recorder uses.
    if (!capture) return;
    const at = p2g.calibRoundAt;
    if (!at) return;

    const { offset: off, room: rm, sessionId, phase: livePhase } = calibCtxRef.current;
    // Never over a take: the mic is about to be captured, or is being captured,
    // for something that matters more than a measurement.
    //
    // Gated on the PHASE and not on `status === "active"`, which looks like the
    // same test and is not: a sync round leaves the status at "active" for as
    // long as the session lives (doc 11, "Running two in a row"), so a status
    // test would silently refuse every calibration round run after a sync
    // round — which is exactly the order a host would run them in.
    if (livePhase === "countdown" || livePhase === "recording") return;

    const startsAt = at - off;                       // server clock → this one
    const waitMs = startsAt - Date.now();
    if (waitMs < -CALIB_ROUND_JOIN_WINDOW_MS) return;

    let cancelled = false;
    setCalibRound({ ...IDLE_CALIB_ROUND, status: "waiting", startsAt });

    const timer = setTimeout(() => {
      if (cancelled) return;
      setCalibRound((prev) => ({ ...prev, status: "running" }));
      const restoreAudio = silenceRemoteAudio(rm);
      const identity = rm?.localParticipant.identity ?? "unknown";
      const name = rm?.localParticipant.name || identity;

      void runCalibrationRun(rm, {
        cancelled: () => cancelled,
        onProgress: ({ trialIdx, results, failed }) =>
          setCalibRound((prev) => ({ ...prev, trialIdx, trials: results, failed })),
      })
        .then((outcome) => {
          restoreAudio();
          if (cancelled) return;
          if (outcome.ok) {
            // Also stored LOCALLY, exactly as if they had pressed the button
            // themselves: from here on it rides `clapOffset` on every take,
            // which is what centres the sync detector's search window and what
            // the `p2g_take` beacon reports.
            setCalibratedLatency(outcome.latencyMs);
            setCalibRound({
              status: "done", startsAt, trialIdx: outcome.trials.length, trials: outcome.trials,
              failed: 0, latencyMs: outcome.latencyMs, spreadMs: outcome.spreadMs,
              unstable: outcome.unstable, error: null,
            });
            postCalibResult(sessionId, identity, name, {
              latencyMs: outcome.latencyMs,
              spreadMs: outcome.spreadMs,
              unstable: outcome.unstable,
              trialsMs: outcome.trials,
            });
          } else {
            // The old number is NOT kept. A calibration that just failed cannot
            // be allowed to stand as if it still described this device — that
            // is the same rule a refused sync round follows, and for the same
            // reason: a stale confident number is worse than a visible gap.
            setCalibratedLatency(null);
            setCalibRound({
              ...IDLE_CALIB_ROUND, status: "failed", startsAt,
              trials: outcome.trials, error: outcome.error,
            });
            postCalibResult(sessionId, identity, name, {
              failed: true, reason: outcome.error,
            });
          }
        })
        .catch((err) => {
          restoreAudio();
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setCalibRound({ ...IDLE_CALIB_ROUND, status: "failed", startsAt, error: msg });
          postCalibResult(sessionId, identity, name, { failed: true, reason: msg });
        });
    }, Math.max(0, waitMs));

    return () => { cancelled = true; clearTimeout(timer); };
    // `calibRoundAt` and `capture` only — see calibCtxRef above.
  }, [p2g.calibRoundAt, capture, setCalibratedLatency]);

  // The verdict is a message, not a mode: clear it so the participant gets
  // their panel back. The host's card keeps the number permanently, so nothing
  // is lost by letting this go.
  useEffect(() => {
    if (calibRound.status !== "done" && calibRound.status !== "failed") return;
    const ms = calibRound.status === "done" ? 6000 : 15000;
    const t = setTimeout(() => setCalibRound(IDLE_CALIB_ROUND), ms);
    return () => clearTimeout(t);
  }, [calibRound.status]);

  useEffect(() => {
    if (!capture) return;
    if (phase !== "uploading") return;
    if (!isLocalTarget) return;
    if (uploading) return;
    // Were we even here? A client that joined the room after the clap never
    // armed a recorder — the prewarm's staleness guard declined, correctly —
    // but nothing downstream knew that, so it uploaded nothing, blamed the
    // participant's microphone, and filed a failure against their name.
    //
    // `isLocalTarget` cannot answer this: an everyone-round has no target, so
    // anybody who walks in during a take is "the target" of a round they were
    // not in.
    if (roundJoinedRef.current !== p2g.clapAt) return;
    // Cross-instance dedup first — without this the second hook instance
    // (LyricsBanner) reaches doUpload with its own null ref and uploads
    // a parallel take, producing `<id>` and `<id>_2` on the server.
    const lockKey = p2gLockKey(p2g.sessionId, p2g.clapAt);
    if (P2G_UPLOADED_LOCKS.has(lockKey)) return;
    // Per-instance per-clapAt guard — protects against stray re-fires of
    // this effect within the same hook instance (e.g. dep changes after the
    // upload has already completed and `uploading` is false again).
    if (uploadedClapAtRef.current === p2g.clapAt) return;
    P2G_UPLOADED_LOCKS.add(lockKey);
    uploadedClapAtRef.current = p2g.clapAt;
    doUpload();
  }, [capture, phase, p2g.sessionId, p2g.clapAt, room, isLocalTarget]);

  const retryUpload = useCallback(() => {
    if (uploading) return;
    doUpload();
  }, [uploading, doUpload]);

  useEffect(() => {
    setUploadDone(false);
    setUploadError(null);
    setUploadErrorKind(null);
    // New round → new upload slot. Without this, the per-clapAt guard above
    // would block round 2's upload because the ref still holds round 1's
    // clapAt — but that's only true on a hot mount; explicit reset is safer.
    uploadedClapAtRef.current = null;
    // New round → new capture-start bookkeeping so a prewarm can arm again.
    startedForClapRef.current = null;
    captureDelayMsRef.current = 0;
  }, [p2g.clapAt]);

  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);

  useEffect(() => {
    if (!capture) return;          // banner instance: no mic AudioContext
    if (phase !== "rehearsal") {
      setMicAnalyser(null);
      return;
    }
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const rawTrack = pub?.track?.mediaStreamTrack;
    if (!rawTrack) return;

    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    setMicAnalyser(analyser);

    return () => {
      ctx.close();
      setMicAnalyser(null);
    };
  }, [capture, phase, room]);

  const markReady = useCallback(async () => {
    if (!p2g.sessionId) return;
    const participantId = room?.localParticipant.identity ?? "unknown";
    const participantName = room?.localParticipant.name || participantId;
    await fetch("/api/play2gether/ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p2g.sessionId, participantId, participantName }),
    });
  }, [p2g.sessionId, room]);

  const patchP2G = useCallback(
    (partial: Partial<P2GSharedState>) => {
      const current: P2GSharedState = (state as any)?.play2gether ?? DEFAULT_P2G;
      return sendChange([{ op: "add", path: "/play2gether", value: { ...current, ...partial } }]);
    },
    [state, sendChange]
  );

  const openSession = useCallback(
    async ({ countdownSecs = 5, recordingDuration = 30 } = {}) => {
      const roomName = room?.name ?? "unknown";
      const res = await fetch("/api/play2gether/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, countdownSecs, recordingDuration }),
      });
      if (!res.ok) throw new Error(`session create failed: ${res.status}`);
      const { sessionId } = await res.json();
      await patchP2G({
        sessionId, countdownSecs, recordingDuration,
        status: "preparing", clapAt: null, referenceUrl: null,
        referenceDuration: null,
        resultUrl: null, playRehearsal: false, playResult: false,
        targetParticipantId: null, lyricsUrl: null, metronomeBpm: 0,
      });
    },
    [room, patchP2G]
  );

  const closeSession = useCallback(async () => {
    await patchP2G({ ...DEFAULT_P2G });
  }, [patchP2G]);

  const uploadReference = useCallback(
    async (fileOrBlob: File | Blob, mimeType?: string, durationSec?: number) => {
      if (!p2g.sessionId) throw new Error("No active session");
      const file = fileOrBlob instanceof File
        ? fileOrBlob
        : new File([fileOrBlob], "reference.webm", { type: mimeType ?? "audio/webm" });
      const form = new FormData();
      form.append("sessionId", p2g.sessionId);
      form.append("audio", file);
      if (typeof durationSec === "number" && durationSec > 0) {
        form.append("durationSec", String(durationSec));
      }
      const res = await fetch("/api/play2gether/reference", { method: "POST", body: form });
      if (!res.ok) throw new Error(`reference upload failed: ${res.status}`);
      const { url, referenceDuration } = await res.json();
      const patch: Partial<P2GSharedState> = { referenceUrl: url };
      if (typeof referenceDuration === "number" && referenceDuration > 0) {
        patch.referenceDuration = referenceDuration;
        patch.recordingDuration = Math.ceil(referenceDuration);
      }
      await patchP2G(patch);
      return url as string;
    },
    [p2g.sessionId, patchP2G]
  );

  const clearReference = useCallback(async () => {
    if (!p2g.sessionId) return;
    await fetch(`/api/play2gether/reference?sessionId=${p2g.sessionId}`, { method: "DELETE" });
    await patchP2G({ referenceUrl: null, referenceDuration: null });
  }, [p2g.sessionId, patchP2G]);

  const startRehearsal = useCallback(async () => {
    if (!p2g.sessionId) throw new Error("No active session");
    await patchP2G({ status: "rehearsal", playRehearsal: false });
  }, [p2g.sessionId, patchP2G]);

  const endRehearsal = useCallback(async () => {
    if (p2g.sessionId) {
      await fetch(`/api/play2gether/session?sessionId=${p2g.sessionId}`)
        .then((r) => r.json())
        .then(async (data) => {
          const ids = Object.keys(data.ready ?? {});
          await Promise.all(ids.map((participantId) =>
            fetch("/api/play2gether/ready", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: p2g.sessionId, participantId }),
            })
          ));
        })
        .catch(() => {});
    }
    await patchP2G({ status: "preparing", playRehearsal: false });
  }, [p2g.sessionId, patchP2G]);

  const setPlayRehearsal = useCallback(
    (playing: boolean) => patchP2G({ playRehearsal: playing }),
    [patchP2G]
  );

  const startCountdown = useCallback(async (target?: string | null) => {
    if (!p2g.sessionId) throw new Error("No active session");
    const serverNow = Date.now() + offset;
    const clapAt = serverNow + p2g.countdownSecs * 1000 + CLAP_BUFFER_MS;
    console.log(`[play2gether/sync] host.startCountdown: clapAt=${clapAt}`);
    await patchP2G({
      status: "active",
      clapAt,
      playRehearsal: false,
      playResult: false,
      targetParticipantId: target ?? null,
      // Explicit: a normal round after a sync round must not inherit "sync",
      // which would silence the reference and cut the take to four bars.
      roundKind: "take",
    });
  }, [p2g.sessionId, p2g.countdownSecs, offset, patchP2G]);

  /**
   * Abandon the round in progress. Host only, and destructive: the take is
   * discarded everywhere and cannot be recovered.
   *
   * There is no new stop machinery here, and there deliberately isn't any.
   * `derivePhase` is a pure function of the shared state whose first line is
   * `if (!clapAt) return "preparing"`, and every teardown in this hook hangs off
   * the phase rather than off a timer:
   *
   *   - the recorder graph is torn down whenever the phase is not
   *     countdown/recording;
   *   - the metronome effect is guarded on `status === "active" && clapAt`, and
   *     its cleanup stops the oscillators already scheduled;
   *   - `stopReference()` runs whenever the phase is not
   *     countdown/recording/uploading — the path that already covered a host
   *     closing the session mid-round;
   *   - the upload only fires in phase `uploading`, which requires `clapAt`.
   *     No clapAt, no upload: the take is dropped rather than sent and deleted.
   *
   * So clearing `clapAt` stops the round on every client at once, and the only
   * thing worth adding is `cancelledClapAt` so people are told why.
   *
   * ONE RACE REMAINS, and it is narrow rather than absent. A client whose clock
   * had already passed the end may have started its upload before this patch
   * reached it, and bytes in flight cannot be recalled — that take lands and the
   * host re-runs the round. The staggered queue shrinks the window a lot (most
   * clients are still waiting their turn, and `doUpload` checks this field
   * before sending), but it does not close it. Closing it properly means the
   * record route rejecting a cancelled `clapAt`, which puts a new failure mode
   * in the path of EVERY upload — not a trade worth making for this.
   */
  const cancelRound = useCallback(async () => {
    if (!p2g.sessionId) throw new Error("No active session");
    if (!p2g.clapAt) return;                    // nothing running
    console.log(`[play2gether/sync] host.cancelRound: abandoning clapAt=${p2g.clapAt}`);
    await patchP2G({
      cancelledClapAt: p2g.clapAt,
      clapAt: null,
      status: "preparing",
      targetParticipantId: null,
      playRehearsal: false,
      playResult: false,
    });
  }, [p2g.sessionId, p2g.clapAt, patchP2G]);

  /**
   * Run a sync round: everyone at once, click only, four bars of quarter notes.
   *
   * Everyone at once is not a shortcut — participants are remote, so each mic
   * hears only its own player and there is no crosstalk to serialise around.
   * The whole band is measured in about fifteen seconds.
   */
  const startSyncRound = useCallback(async (opts?: { jitterMs?: number }) => {
    if (!p2g.sessionId) throw new Error("No active session");
    const serverNow = Date.now() + offset;
    const clapAt = serverNow + p2g.countdownSecs * 1000 + CLAP_BUFFER_MS;
    // A NEW seed every round, so running it twice gives a different irregular
    // pattern rather than the same one — a player would learn a repeated
    // pattern, and learning the pattern is precisely what randomising exists to
    // prevent. `| 1` keeps it non-zero, which is how "plain round" is spelled.
    const jitterMs = Math.max(0, Math.round(opts?.jitterMs ?? 0));
    const syncSeed = jitterMs > 0 ? ((Math.floor(Math.random() * 0x7fffffff) | 1) >>> 0) : 0;
    console.log(
      `[play2gether/sync] host.startSyncRound: clapAt=${clapAt} bpm=${SYNC_BPM} ` +
      `jitter=${jitterMs}ms seed=${syncSeed}`,
    );
    await patchP2G({
      status: "active",
      clapAt,
      syncSeed,
      syncJitterMs: jitterMs,
      playRehearsal: false,
      playResult: false,
      targetParticipantId: null,
      roundKind: "sync",
    });
  }, [p2g.sessionId, p2g.countdownSecs, offset, patchP2G]);

  /**
   * Run a calibration round: every device measures its own acoustic round trip
   * at the same moment, after a lead-in that tells the band to take their
   * headphones off.
   *
   * Note what this does NOT set: no `clapAt`, no `status: "active"`, no
   * `roundKind`. Nothing records, so nothing about the recording machinery
   * should wake up. The session stays in whatever phase it was in and a ten
   * second measurement happens on top of it.
   */
  const startCalibRound = useCallback(async () => {
    if (!p2g.sessionId) throw new Error("No active session");
    const serverNow = Date.now() + offset;
    const calibRoundAt = serverNow + CALIB_ROUND_LEAD_MS;
    console.log(`[play2gether/sync] host.startCalibRound: calibRoundAt=${calibRoundAt}`);
    await patchP2G({
      calibRoundAt,
      // Ten seconds of the reference or the mix playing into everyone's mic is
      // ten seconds of something louder than the click to measure by mistake.
      playRehearsal: false,
      playResult: false,
    });
  }, [p2g.sessionId, offset, patchP2G]);

  const triggerMix = useCallback(
    async (
      participantGains: Record<string, number>,
      participantOffsets: Record<string, number> = {},
      referenceGain?: number,
    ) => {
      if (!p2g.sessionId) throw new Error("No active session");
      // Prefer the caller's explicit value. The reference-gain slider is
      // debounced and its value round-trips through shared state before landing
      // in `p2g.referenceGain`; reading that here races the click, so a host who
      // moves the slider and mixes quickly would mix with the STALE gain (the
      // "reference volume does nothing" bug). The host panel passes its
      // immediate local `refGain` instead.
      const refGain = typeof referenceGain === "number" ? referenceGain : p2g.referenceGain;
      // Where to go back to if the mix fails. Without this the room is left in
      // "mixing" for good: the status is patched BEFORE the request, the throw
      // skips the patch that would clear it, and `derivePhase` has no way out
      // of "mixing" — the panel shows "Mixing tracks with ffmpeg…" over a
      // mixer it will not render again, on every client, until the session is
      // closed. Reported from the field as "the session is left broken", and
      // it is the failure of ANY mix, not of any particular one.
      const prevStatus = p2g.status;
      await patchP2G({ status: "mixing" });
      let res: Response;
      try {
        res = await fetch("/api/play2gether/mix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: p2g.sessionId,
            referenceGain: refGain,
            participantGains,
            participantOffsets,
          }),
        });
      } catch (e) {
        await patchP2G({ status: prevStatus });
        throw e;
      }
      if (!res.ok) {
        await patchP2G({ status: prevStatus });
        // The route puts the reason in `detail` (for a render failure, the tail
        // of ffmpeg's own stderr). Dropping it and reporting "mix failed: 500"
        // is how a fixable mix failure becomes an unexplainable one.
        let detail = "";
        try { detail = (await res.json())?.detail || (await res.json())?.error || ""; }
        catch { /* not JSON — the status code is all there is */ }
        throw new Error(`mix failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
      }
      const { resultUrl } = await res.json();
      // The route stamps its own version now (a fixed filename needs one — see
      // docs/llm/04). Only stamp here if it did not, or the URL ends up
      // carrying two of them.
      const versionedUrl = resultUrl.includes("?") ? resultUrl : `${resultUrl}?t=${Date.now()}`;
      await patchP2G({ status: "done", resultUrl: versionedUrl, playResult: false });
      return versionedUrl;
    },
    [p2g.sessionId, p2g.referenceGain, p2g.status, patchP2G]
  );

  const setPlayResult = useCallback(
    (playing: boolean) => patchP2G({ playResult: playing }),
    [patchP2G]
  );

  // When the host refreshes the page mid-session, the play2gether shared
  // state survives (it lives on the LiveKit server via shared-state-agent)
  // — including transient playback flags like playResult/playRehearsal. On
  // the host's fresh client mount those flags re-arrive in the snapshot as
  // `true`, the resultAudio/refAudio useEffects up above honour them, and
  // the song starts playing without the host doing anything. We reset the
  // playback flags ONCE per (sessionId, tab) on the host's first valid
  // snapshot so refresh = paused playback. Other state (uploaded reference,
  // takes, mixer gains) is preserved so the host can continue where they
  // left off if they want.
  const playbackResetForSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!p2g.sessionId) return;
    if (playbackResetForSessionRef.current === p2g.sessionId) return;

    let isHost = false;
    try {
      const meta = room?.localParticipant?.metadata;
      if (meta) isHost = JSON.parse(meta)?.role === "teacher";
    } catch { /* malformed metadata — treat as non-host */ }
    if (!isHost) return;

    playbackResetForSessionRef.current = p2g.sessionId;
    if (p2g.playResult) patchP2G({ playResult: false });
    if (p2g.playRehearsal) patchP2G({ playRehearsal: false });
  }, [p2g.sessionId, p2g.playResult, p2g.playRehearsal, room, patchP2G]);

  const setReferenceGain = useCallback(
    (gain: number) => patchP2G({ referenceGain: Math.min(2, Math.max(0, gain)) }),
    [patchP2G]
  );

  const setCountdownSecs = useCallback(
    (secs: number) => patchP2G({ countdownSecs: Math.min(30, Math.max(1, Math.round(secs))) }),
    [patchP2G]
  );

  const setRecordingDuration = useCallback(
    (secs: number) => patchP2G({ recordingDuration: Math.min(MAX_RECORDING_DURATION_SEC, Math.max(5, Math.round(secs))) }),
    [patchP2G]
  );

  const setAllowDownload = useCallback(
    (allow: boolean) => patchP2G({ allowDownload: allow }),
    [patchP2G]
  );

  const setMetronomeBpm = useCallback(
    (bpm: number) => patchP2G({ metronomeBpm: Math.min(240, Math.max(0, Math.round(bpm) || 0)) }),
    [patchP2G]
  );

  const promoteMix = useCallback(async (sourceFile?: string) => {
    if (!p2g.sessionId) throw new Error("No active session");
    const res = await fetch("/api/play2gether/promote-mix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p2g.sessionId, ...(sourceFile ? { sourceFile } : {}) }),
    });
    if (!res.ok) throw new Error(`promote-mix failed: ${res.status}`);
    const { url, referenceDuration } = await res.json();
    const versionedUrl = `${url}?t=${Date.now()}`;
    const patch: Partial<P2GSharedState> = {
      referenceUrl: versionedUrl,
      status: "preparing",
      resultUrl: null,
      clapAt: null,
      playResult: false,
      playRehearsal: false,
    };
    if (typeof referenceDuration === "number" && referenceDuration > 0) {
      patch.referenceDuration = referenceDuration;
      patch.recordingDuration = Math.ceil(referenceDuration);
    }
    await patchP2G(patch);
    return versionedUrl;
  }, [p2g.sessionId, patchP2G]);

  const uploadLyrics = useCallback(
    async (file: File) => {
      if (!p2g.sessionId) throw new Error("No active session");
      const form = new FormData();
      form.append("sessionId", p2g.sessionId);
      form.append("lyrics", file);
      const res = await fetch("/api/play2gether/lyrics", { method: "POST", body: form });
      if (!res.ok) throw new Error(`lyrics upload failed: ${res.status}`);
      const { url } = await res.json();
      const versionedUrl = `${url}?t=${Date.now()}`;
      await patchP2G({ lyricsUrl: versionedUrl });
      return versionedUrl as string;
    },
    [p2g.sessionId, patchP2G]
  );

  const clearLyrics = useCallback(async () => {
    if (!p2g.sessionId) return;
    await fetch(`/api/play2gether/lyrics?sessionId=${p2g.sessionId}`, { method: "DELETE" });
    await patchP2G({ lyricsUrl: null });
  }, [p2g.sessionId, patchP2G]);

  const [lyricsText, setLyricsText] = useState<string | null>(null);
  useEffect(() => {
    if (!p2g.lyricsUrl) { setLyricsText(null); return; }
    let cancelled = false;
    fetch(p2g.lyricsUrl)
      .then((r) => r.ok ? r.text() : null)
      .then((text) => { if (!cancelled) setLyricsText(text); })
      .catch(() => { if (!cancelled) setLyricsText(null); });
    return () => { cancelled = true; };
  }, [p2g.lyricsUrl]);

  return {
    p2g, phase, roundDuration: roundDurationSec(p2g), countdown, recordingProgress,
    uploading, uploadDone, uploadSlot, uploadError, uploadErrorKind, retryUpload,
    missedRound,
    micAnalyser, refAnalyser, getReferenceTime,
    isLocalTarget, targetName,
    calibratedLatencyMs, setCalibratedLatency, publishCalibration,
    clearPublishedCalibration,
    calibRound,
    syncResult, syncRefused,
    lyricsText,
    markReady,
    host: {
      openSession, closeSession, uploadReference, clearReference,
      uploadLyrics, clearLyrics,
      startRehearsal, endRehearsal, setPlayRehearsal,
      startCountdown, startSyncRound, startCalibRound, cancelRound, triggerMix,
      setPlayResult, setReferenceGain, setRecordingDuration, setCountdownSecs,
      setAllowDownload, setMetronomeBpm, promoteMix,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Hard ceiling for a single record upload. Without an explicit timeout
// `await fetch(...)` waits indefinitely if the server stalls or the
// connection silently breaks mid-transfer, and the UI gets stuck at
// "Uploading…" forever — `.then`/`.catch`/`.finally` never run, so
// uploading state never resets. Set generously — it covers a slow client
// uplink plus a busy server.
//
// nginx's 300 s (client_body_timeout / proxy_send_timeout / proxy_read_timeout,
// in nginx.conf.template) are INACTIVITY timeouts, not budgets for the whole
// request: a slow but steady upload never trips them however long it runs.
// So this ceiling is not required to sit below 300 s — the two measure
// different things. What must stay under 300 s is the server's own silence:
// the record route replies only after ffmpeg, peaks and the session lock, and
// if that stretches past 300 s nginx returns a 504 no client timeout can
// pre-empt.
const UPLOAD_MIN_TIMEOUT_MS = 120_000;
/** Slowest uplink we're willing to keep waiting for: 64 KiB/s (512 kbps).
 *  Below this a take was never going to arrive inside a useful window. */
const UPLOAD_ASSUMED_MIN_BPS = 64 * 1024;
/** Absolute ceiling, so a dead link fails instead of hanging forever. Sized
 *  from the work, not from nginx: the largest take at the assumed floor rate
 *  is 33 MiB / 64 KiB/s ≈ 528 s, so 540 s covers the full range without
 *  aborting an upload that was still making progress. */
const UPLOAD_MAX_TIMEOUT_MS = 540_000;

/**
 * A FIXED upload timeout is wrong for a payload whose size is a host-set
 * parameter: 120 s fits a 30 s take on almost anything and aborts a 5-minute
 * take on a rural link that would have finished. An abort is recoverable —
 * the take stays in `chunksRef` and the retry button re-sends it — but it
 * burns the window and reads to the player as data loss. Scale with the body.
 */
function uploadTimeoutMs(bytes: number): number {
  const needed = Math.ceil(bytes / UPLOAD_ASSUMED_MIN_BPS) * 1000;
  return Math.min(UPLOAD_MAX_TIMEOUT_MS, Math.max(UPLOAD_MIN_TIMEOUT_MS, needed));
}

/**
 * Fire-and-forget report to the host that this client's take failed this round.
 * Written to session.json under `failures[participantId]`; the host poll shows
 * it so a dropped take doesn't look like the participant is simply slow. Never
 * throws — a failed failure-report must not mask the original error.
 */
function reportP2GFailure(
  sessionId: string | null | undefined,
  participantId: string,
  participantName: string,
  reason: string,
  clapAt: number | null,
) {
  if (!sessionId) return;
  try {
    void fetch("/api/play2gether/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, participantId, participantName, reason, clapAt }),
    }).catch(() => {});
  } catch { /* noop */ }
}

/** What the record route reports about its own half of the request, so the
 *  client can tell transfer time from server processing time. Null when the
 *  server is older than this field or the body didn't parse. */
type ServerUploadTimings = {
  recvMs: number | null;
  serverMs: number | null;
  /** Sync rounds only: what the server measured, or why it refused to. */
  sync?: SyncRoundResult | null;
  syncRefused?: string | null;
};

async function uploadRecording(
  sessionId: string,
  participantId: string,
  participantName: string,
  blob: Blob,
  clapOffset: number,
  calibrated: boolean,
  captureDelayMs: number,
  isSyncRound = false,
  syncSeed = 0,
  syncJitterMs = 0,
): Promise<ServerUploadTimings> {
  // Send the WAV as raw body (not multipart). The server now streams the
  // body directly to disk instead of buffering with req.formData(), so
  // memory pressure under concurrent uploads goes from O(file_size) per
  // request to ~64 KB per request — fixes the "all clients stuck on
  // Uploading…" symptom when multiple participants finish a take at the
  // same time. Metadata travels as URL query params (encoded).
  const params = new URLSearchParams({
    sessionId,
    participantId,
    participantName,
    clapOffset: String(Math.round(clapOffset)),
    calibrated: calibrated ? "1" : "0",
    captureDelayMs: String(Math.max(0, Math.round(captureDelayMs))),
    syncSeed: String(Math.round(syncSeed)),
    syncJitterMs: String(Math.max(0, Math.round(syncJitterMs))),
    ...(isSyncRound ? { kind: "sync" } : {}),
  });

  const controller = new AbortController();
  const timeoutMs = uploadTimeoutMs(blob.size);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/play2gether/record?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`record upload failed: ${res.status} ${res.statusText}`);
    }
    // Timings only — a body that doesn't parse must not fail an upload that
    // the server already accepted.
    try {
      const body = await res.json();
      return {
        recvMs: typeof body?.recvMs === "number" ? body.recvMs : null,
        serverMs: typeof body?.serverMs === "number" ? body.serverMs : null,
        sync: body?.sync ?? null,
        syncRefused: typeof body?.syncRefused === "string" ? body.syncRefused : null,
      };
    } catch {
      return { recvMs: null, serverMs: null };
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`upload timed out after ${Math.round(timeoutMs / 1000)}s — the server may be overloaded. Retry?`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function encodeWAV(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  const dataBytes = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buf], { type: "audio/wav" });
}

/** Nominal gap between consecutive uploads. Sized so that with an upload
 *  lasting ~5 s roughly three are in flight at any moment — enough to keep the
 *  link busy, few enough that they don't trample each other. */
const UPLOAD_STAGGER_MS = 1500;
/** The last client never waits longer than this, however many are in the room.
 *  The wait is the one window where a take exists ONLY in memory: close the tab
 *  here and it's gone, with no retry possible. Bounded on purpose. */
const UPLOAD_STAGGER_MAX_MS = 12_000;

/**
 * Work out this client's turn in the staggered upload queue.
 *
 * The slot is DERIVED, not random: every client sorts the same roster of
 * identities and takes its own index, so the schedule is collision-free with no
 * coordination and no extra round-trip. Random jitter would still collide —
 * with ten clients drawing from the same range, pairs land together often.
 *
 * If the rosters momentarily disagree (someone joining as the round ends), two
 * clients can pick the same slot. That degrades to two simultaneous uploads,
 * which is exactly what happens today, so it fails soft.
 *
 * A single-target round has one uploader and therefore no delay.
 */
function uploadStagger(
  room: Room | null | undefined,
  targetParticipantId: string | null,
): { slot: number; total: number; delayMs: number } {
  const self = room?.localParticipant.identity;
  if (!room || !self || targetParticipantId) return { slot: 0, total: 1, delayMs: 0 };

  const identities = [
    self,
    ...Array.from(room.remoteParticipants.values()).map((p) => p.identity),
  ].sort();
  const total = identities.length;
  const slot = Math.max(0, identities.indexOf(self));
  if (slot === 0 || total < 2) return { slot, total, delayMs: 0 };

  // Compress the gap rather than the queue when the room is big, so the tail
  // stays inside UPLOAD_STAGGER_MAX_MS instead of growing without bound.
  const gap = Math.min(UPLOAD_STAGGER_MS, UPLOAD_STAGGER_MAX_MS / (total - 1));
  return { slot, total, delayMs: Math.round(slot * gap) };
}

// One metronome tick scheduled at AudioContext time `when`. Downbeats are higher
// and louder so the singer can feel the bar. Short exponential decay = a clean
// "tick", not a tone.
//
// Exported because the host panel schedules its own ticks while capturing the
// reference from the mic (a free-running click, not phase-locked to any clap),
// and both places must sound identical — a different-sounding click reads as a
// different feature.
/** Returns the oscillator so a caller on a SHARED context can cancel a tick it
 *  scheduled — closing the context is no longer an option (see getMonitorCtx). */
export function scheduleMetronomeClick(
  ctx: AudioContext,
  when: number,
  accent: boolean,
): OscillatorNode | null {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1000;
    const peak = accent ? 0.5 : 0.32;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
    return osc;
  } catch { /* non-critical */ }
  return null;
}

function playClapSound(): void {
  try {
    const ctx = new AudioContext();
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.floor(sampleRate * 0.08), sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sampleRate) * 100);
    }
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close();
  } catch { /* non-critical */ }
}

