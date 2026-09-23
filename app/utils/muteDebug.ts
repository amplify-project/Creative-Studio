"use client";

/**
 * muteDebug – ring buffer for audio subscription debugging.
 *
 * Usage (browser DevTools):
 *   window.__muteLog()          → last N events as table
 *   window.__muteDump()         → pretty JSON string (copy-paste)
 *   window.__muteClear()        → clears the log
 *   window.__muteState()        → current subscription snapshot
 *   window.__lkAudio()          → LiveKit subscription state (after registerRoomDebug)
 */

const MAX_EVENTS = 400;
const MAX_ERRORS = 30;

function iso(t: number) {
  return new Date(t).toISOString().slice(11, 23);
}

// ─── Console error ring buffer ────────────────────────────────────────────────

interface ConsoleError {
  t: number;
  iso: string;
  message: string;
  source?: string;
  stack?: string;
}

const consoleErrors: ConsoleError[] = [];

function pushError(message: string, source?: string, stack?: string) {
  const t = Date.now();
  consoleErrors.push({ t, iso: iso(t), message, source, stack });
  if (consoleErrors.length > MAX_ERRORS) consoleErrors.shift();
}

if (typeof window !== "undefined") {
  // Patch console.error
  const _origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    pushError(message);
    _origError(...args);
  };

  // Catch unhandled JS errors
  window.addEventListener("error", (e) => {
    pushError(e.message, e.filename ? `${e.filename}:${e.lineno}` : undefined, e.error?.stack);
  });

  // Catch unhandled promise rejections
  window.addEventListener("unhandledrejection", (e) => {
    const message = e.reason instanceof Error ? e.reason.message : String(e.reason);
    pushError(`UnhandledRejection: ${message}`, undefined, e.reason?.stack);
  });
}

export function getConsoleErrors(): ConsoleError[] {
  return [...consoleErrors];
}

export interface MuteEvent {
  t: number;
  iso: string;
  event: string;
  data: Record<string, unknown>;
}

const events: MuteEvent[] = [];

// Current subscription state per participantId: true=subscribed, false=blocked
const subscriptionState: Record<string, boolean> = {};

export function muteLog(event: string, data: Record<string, unknown> = {}) {
  const t = Date.now();
  events.push({ t, iso: iso(t), event, data });
  if (events.length > MAX_EVENTS) events.shift();
}

export function logSetSubscribed(
  caller: string,
  participantId: string,
  pubSid: string | undefined,
  value: boolean
) {
  const prev = subscriptionState[participantId];
  subscriptionState[participantId] = value;
  muteLog("setSubscribed", {
    caller,
    participantId,
    pubSid: pubSid ?? "?",
    value,
    prevState: prev,
    changed: prev !== value,
  });
}

export function getSubscriptionState() {
  return { ...subscriptionState };
}

// Latest snapshot set by useSharedMainStage on every render cycle
let stageSnapshot: {
  entities: Record<string, any>;
  trackBySidKeys: string[];
  mainStageVideos: { key: string; trackSid: string | undefined }[];
} | null = null;

/** Called on every main effect run in useSharedMainStage */
export function setStageSnapshot(
  entities: Record<string, any>,
  trackBySidKeys: string[],
  mainStageVideos: { key: string; trackSid: string | undefined }[]
) {
  stageSnapshot = { entities, trackBySidKeys, mainStageVideos };
}

/** window.__stage() — cross-reference sharedState entities with actual tracks */
export function registerStageDebug() {
  if (typeof window === "undefined") return;
  (window as any).__stage = () => {
    if (!stageSnapshot) { console.warn("[muteDebug] no stage snapshot yet"); return; }
    const { entities, trackBySidKeys, mainStageVideos } = stageSnapshot;
    console.group("[stage] entities vs tracks");
    console.log("mainStageVideos (rendered):", mainStageVideos.length, mainStageVideos);
    const rows = Object.entries(entities).map(([id, ent]: [string, any]) => ({
      id,
      participantId: ent.participantId,
      trackSid: ent.trackSid ?? id,
      visible: ent.visible,
      muted: ent.playback?.muted,
      trackFound: trackBySidKeys.includes(ent.trackSid ?? id),
      onStage: mainStageVideos.some(v => v.key === id),
    }));
    console.table(rows);
    console.groupEnd();
    return rows;
  };
  console.info("[muteDebug] __stage() registered — cross-references entities with tracks");
}

/** Call once from participant page to enable __lkAudio() console helper */
export function registerRoomDebug(room: any) {
  if (typeof window === "undefined") return;
  (window as any).__room = room;
  (window as any).__lkAudio = () => {
    if (!room) { console.warn("[muteDebug] no room"); return; }
    const rows: Record<string, unknown>[] = [];
    room.remoteParticipants.forEach((p: any) => {
      p.audioTrackPublications.forEach((pub: any) => {
        rows.push({
          participant: p.identity,
          trackSid: pub.trackSid,
          // isSubscribed: our setSubscribed() control — false = we blocked it
          isSubscribed: pub.isSubscribed,
          // publisherMuted: the SENDER muted their own mic (unrelated to our control)
          publisherMuted: pub.isMuted,
          // canHear: true only if both conditions are met
          canHear: pub.isSubscribed && !pub.isMuted,
          subscriptionStatus: pub.subscriptionStatus,
          track: pub.track ? "yes" : "no",
        });
      });
    });
    if (rows.length === 0) console.warn("[muteDebug] no remote audio publications found");
    else console.table(rows);
    return rows;
  };
  console.info("[muteDebug] __lkAudio() registered — shows LiveKit subscription state");
}

if (typeof window !== "undefined") {
  const w = window as any;
  w.__muteLog = () => {
    console.table(events.map(e => ({ time: e.iso, event: e.event, ...e.data })));
    return events;
  };
  w.__muteDump = () => JSON.stringify(events, null, 2);
  w.__muteClear = () => { events.length = 0; console.info("[muteDebug] log cleared"); };
  w.__muteState = () => {
    console.table(subscriptionState);
    return subscriptionState;
  };
  w.__getConsoleErrors = () => getConsoleErrors();
  console.info(
    "[muteDebug] loaded. Commands: __muteLog() | __muteDump() | __muteClear() | __muteState() | __lkAudio() | __getConsoleErrors()"
  );
}
