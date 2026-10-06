"use client";

/**
 * Play2Gether — Participant Overlay
 *
 * Shown over the participant view whenever a play2gether session is active
 * (phase !== "idle"). Audio playback (reference, result) is managed by the
 * hook; this component only handles UI state.
 */

import { useEffect, useRef, useState } from "react";
import { usePlay2GetherSession } from "../app/hooks/usePlay2GetherSession";
import { Loader2, Mic, Music2, CheckCircle2, AlertTriangle, RefreshCw, Download, X } from "lucide-react";
import { CalibrationFlow, CalibrationButton, CalibRoundPanel } from "./Play2GetherCalibration";
import {
  SYNC_BARS, SYNC_SPREAD_GOOD_MS, SYNC_SPREAD_FAIR_MS,
  SYNC_FIRST_PLAYED_BEAT, syncCountInSec,
} from "../app/lib/p2gSync";

function fmtTime(sec: number) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Waveform + dual VU meter (mic + reference) + playback time. All drawing via RAF — no React state per frame.
function MicVisualizer({ micAnalyser, refAnalyser, getRefTime, refDuration }: {
  micAnalyser: AnalyserNode;
  refAnalyser: AnalyserNode | null;
  /** Reference playback position (s), or null when it isn't playing. Not an
   *  element's currentTime: during a take the reference is a scheduled buffer. */
  getRefTime: () => number | null;
  refDuration: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const micData = new Uint8Array(micAnalyser.frequencyBinCount);
    const refData = refAnalyser ? new Uint8Array(refAnalyser.frequencyBinCount) : null;
    let animId: number;

    const drawTime = (W: number) => {
      const t = getRefTime();
      if (t == null || !refDuration || isNaN(refDuration)) return;
      const timeStr = `${fmtTime(t)} / ${fmtTime(refDuration)}`;
      ctx.font = "bold 9px monospace";
      const tw = ctx.measureText(timeStr).width;
      const px = W - tw - 6;
      const py = 3;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(px - 3, py, tw + 6, 13);
      ctx.fillStyle = "#a1a1aa";
      ctx.textBaseline = "top";
      ctx.fillText(timeStr, px, py + 2);
    };

    // Layout constants (px, at canvas resolution)
    const WAVE_H  = 44;
    const BAR_H   = 10;
    const LBL_W   = 24; // left margin for "MIC" / "REF" labels
    const BAR_Y1  = WAVE_H + 7;           // mic VU bar top
    const BAR_Y2  = BAR_Y1 + BAR_H + 6;  // ref VU bar top

    const drawVu = (y: number, level: number) => {
      const W = canvas.width;
      const bx = LBL_W;
      const bw = W - bx;
      ctx.fillStyle = "#27272a";
      ctx.fillRect(bx, y, bw, BAR_H);

      if (level > 0) {
        // Green 0–60 %
        const gW = Math.min(level, 0.6) / 0.6 * bw * 0.6;
        if (gW > 0) { ctx.fillStyle = "#22c55e"; ctx.fillRect(bx, y, gW, BAR_H); }
        // Yellow 60–85 %
        const yW = Math.max(0, Math.min(level - 0.6, 0.25) / 0.25) * bw * 0.25;
        if (yW > 0) { ctx.fillStyle = "#eab308"; ctx.fillRect(bx + bw * 0.6, y, yW, BAR_H); }
        // Red 85–100 %
        const rW = Math.max(0, Math.min(level - 0.85, 0.15) / 0.15) * bw * 0.15;
        if (rW > 0) { ctx.fillStyle = "#ef4444"; ctx.fillRect(bx + bw * 0.85, y, rW, BAR_H); }
      }

      // Zone dividers
      ctx.fillStyle = "#09090b";
      ctx.fillRect(bx + Math.floor(bw * 0.6),  y, 1, BAR_H);
      ctx.fillRect(bx + Math.floor(bw * 0.85), y, 1, BAR_H);
    };

    const rms = (buf: Uint8Array) => {
      let s = 0;
      for (const v of buf) { const n = (v - 128) / 128; s += n * n; }
      return Math.sqrt(s / buf.length);
    };

    const draw = () => {
      micAnalyser.getByteTimeDomainData(micData);
      const W = canvas.width;

      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, W, canvas.height);

      // ── Filled waveform ──────────────────────────────────────────────────
      const micRms   = rms(micData);
      const waveColor = micRms < 0.1 ? "#22c55e" : micRms < 0.35 ? "#eab308" : "#ef4444";
      const mid = WAVE_H / 2;

      ctx.fillStyle = waveColor + "28";
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i < micData.length; i++) {
        const x = (i / (micData.length - 1)) * W;
        const y = ((micData[i] - 128) / 128) * (mid - 2) + mid;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, mid); ctx.closePath(); ctx.fill();

      ctx.strokeStyle = waveColor; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < micData.length; i++) {
        const x = (i / (micData.length - 1)) * W;
        const y = ((micData[i] - 128) / 128) * (mid - 2) + mid;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // ── Playback time overlay (top-right of waveform) ────────────────────
      drawTime(W);

      // ── Labels ───────────────────────────────────────────────────────────
      ctx.font = "bold 8px monospace";
      ctx.textBaseline = "middle";

      ctx.fillStyle = "#71717a";
      ctx.fillText("MIC", 0, BAR_Y1 + BAR_H / 2);
      drawVu(BAR_Y1, Math.min(1, micRms * 4.5));

      if (refData && refAnalyser) {
        refAnalyser.getByteTimeDomainData(refData);
        ctx.fillStyle = "#6366f1";
        ctx.fillText("REF", 0, BAR_Y2 + BAR_H / 2);
        drawVu(BAR_Y2, Math.min(1, rms(refData) * 4.5));
      }

      animId = requestAnimationFrame(draw);
    };
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [micAnalyser, refAnalyser, getRefTime, refDuration]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={refAnalyser ? 82 : 62}
      className="w-full rounded-lg border border-zinc-800"
    />
  );
}


/**
 * One collapsible paragraph answering "what IS this", for somebody who arrived
 * after it started.
 *
 * Every other screen in this panel names a STATE — recording, uploading,
 * mixing — and each of those is legible only to someone who watched the
 * previous one. A participant who joins in the middle has none of that context,
 * so the first word they read is a verb about a process they have never heard
 * of. Closed by default: it is dead weight for the nine people who were here
 * from the start.
 */
function WhatIsThis() {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {open ? "Hide" : "What is this?"}
      </button>
      {open && (
        <div className="text-[11px] leading-relaxed text-zinc-400 mt-2 flex flex-col gap-1.5
                        border border-dashed border-zinc-700 rounded-lg p-2.5">
          <p>
            Everyone in this room records at the same time, each on their own
            microphone, while listening to the same backing track. The host then
            puts all the recordings together into one mix.
          </p>
          <p>
            <span className="text-zinc-200">Wear headphones.</span> On speakers your
            microphone picks up the backing track as well as you, and it ends up
            twice in the mix.
          </p>
          <p>
            You do not have to start or stop anything. The host runs each round;
            this panel tells you when it is your turn to play and when to keep
            quiet.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * ── How every screen below is worded ─────────────────────────────────────────
 *
 * The headline says WHAT TO DO. The state name, if it appears at all, goes
 * underneath in small text.
 *
 * These screens used to be titled "Recording", "Uploading recording",
 * "Mixing tracks" — the name of the phase the system is in. That reads fine to
 * somebody who watched the previous five screens and cannot be read at all by
 * somebody who just arrived, which is most of the audience for the ones that
 * matter: a participant does not need to know the session is "mixing", they
 * need to know there is nothing for them to do. Raised from the field, 2026-09-03.
 *
 * Keep it that way when adding a screen. The test is whether the first line
 * answers "what do I do right now" for a person who has never seen this panel.
 */
/**
 * The panel's content box. The panel itself no longer decides where it sits:
 * on the participant page it is the "Play2Gether" tab of the right-hand
 * column (ParticipantControlPanel, docked), next to the chat, with the stage
 * resized around the column rather than covered (field report 2026-09-28: the
 * old centred card sat on the videos and could not be moved).
 */
function Body({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-5 px-5 py-6">{children}</div>;
}

/** What the column needs to know without rendering the panel. */
export type P2GPanelStatus = {
  /** There is something to show: a session is running or a calibration round is on. */
  active: boolean;
  /** Something to act on in seconds — the column switches to this tab. */
  urgent: boolean;
  /** Worth a pulse on a hidden tab: a countdown, a take, a calibration round. */
  attention: boolean;
};

/**
 * Must stay MOUNTED for the whole session, whichever tab is showing: its hook
 * instance is the one with `capture` on — it owns the recorder, the upload
 * and the metronome. Hide it with CSS, never unmount it.
 */
export default function Play2GetherClientPanel({
  onStatus,
}: {
  onStatus?: (s: P2GPanelStatus) => void;
}) {
  const {
    p2g, phase, countdown, recordingProgress,
    uploading, uploadDone, uploadSlot, uploadError, uploadErrorKind, retryUpload, markReady,
    roundDuration, syncResult, syncRefused, missedRound,
    micAnalyser, refAnalyser, getReferenceTime,
    isLocalTarget, targetName,
    calibratedLatencyMs, setCalibratedLatency, publishCalibration, clearPublishedCalibration, calibRound,
  } = usePlay2GetherSession();

  const [isReady, setIsReady] = useState(false);
  const [calibrating, setCalibrating] = useState(false);

  useEffect(() => {
    if (phase !== "rehearsal") setIsReady(false);
  }, [phase]);

  // A host-driven calibration round takes over the panel wherever it finds it.
  // It is the only thing here with a deadline the participant has to act on —
  // six seconds to get their headphones off — so it outranks every screen
  // below, including the passive "someone else is recording" one.
  const calibRoundActive = calibRound.status !== "idle";

  // Things with a deadline measured in seconds bring this tab to the front,
  // even over the chat: the countdown and the take (for the person
  // recording), and a calibration round (six seconds to get the headphones
  // off). Everything else leaves the column where the participant put it.
  const urgent =
    calibRoundActive ||
    (isLocalTarget && (phase === "countdown" || phase === "recording"));
  const active = !(phase === "idle" && !calibRoundActive);
  const attention = phase === "countdown" || phase === "recording" || calibRoundActive;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    onStatusRef.current?.({ active, urgent, attention });
  }, [active, urgent, attention]);

  // Do not render anything when idle
  if (phase === "idle" && !calibRoundActive) return null;

  // A sync round is a measurement, not a performance: no reference, no lyrics,
  // four bars of clicks. Every screen below that mentions the song has to say
  // something different during one.
  const isSyncRound = p2g.roundKind === "sync";
  // Where in a sync round we are: the count-in is silent for the player, and
  // the screen has to say so AT THE MOMENT it is true. A single "play on every
  // click" through the whole round is what taught people to start on the first
  // one, which is the failure the count-in exists to remove.
  const inCountIn =
    isSyncRound && recordingProgress * roundDuration < syncCountInSec();

  // The lyrics banner is not rendered here any more: it belongs over the
  // stage, and this panel is now a column beside it. MainStageParticipant
  // mounts it inside the stage; it gates itself on phase + lyrics.

  // Single-participant round: non-targets see a passive "X is recording…"
  // overlay during the active phases. Rehearsal/preparing/done still apply
  // to everyone, so they fall through to the normal branches below.
  const showPassive =
    !calibRoundActive &&
    !isLocalTarget &&
    (phase === "countdown" || phase === "recording" || phase === "uploading" || phase === "mixing");

  if (showPassive) {
    const who = targetName ?? "Someone";
    return (
      <>
        <Body>
            <div className="relative flex items-center justify-center">
              <span className="absolute w-16 h-16 rounded-full bg-rose-500/20 animate-ping" />
              <div className="w-14 h-14 rounded-full bg-rose-600 flex items-center justify-center">
                <Mic className="w-7 h-7 text-white" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-white">
                {phase === "mixing" ? "Nothing to do right now" : "Keep quiet"}
              </p>
              <p className="text-sm text-zinc-400 mt-1">
                {phase === "countdown" && `${who} is about to record — their microphone will pick you up too.`}
                {phase === "recording" && `${who} is recording. Anything you make now lands in their take.`}
                {phase === "uploading" && `${who} has finished. Their recording is being sent.`}
                {phase === "mixing" && "The host is combining everyone's recordings into one mix."}
              </p>
            </div>
            <WhatIsThis />
        </Body>
      </>
    );
  }

  // Someone who walked in during a take. Before this they were shown the full
  // recording UI — pulsing mic, progress bar — for a take their microphone was
  // never armed for, and then a red "Recording failed / your mic is missing"
  // once it ended. Nothing is wrong with them; they were not here.
  if (missedRound) {
    return (
      <Body>
          <Music2 className="w-10 h-10 text-zinc-500" />
          <div className="text-center">
            <p className="text-lg font-semibold text-white">You joined mid-take</p>
            <p className="text-sm text-zinc-400 mt-1.5 leading-relaxed">
              A recording was already running when you arrived, so you are sitting
              this one out. Nothing is wrong — the host will start another.
            </p>
            <p className="text-xs text-zinc-500 mt-3 leading-relaxed">
              While you wait: put your headphones on, and keep quiet until the
              others have finished.
            </p>
          </div>
          <WhatIsThis />
      </Body>
    );
  }

  if (calibRoundActive) {
    return (
      <Body>
          <CalibRoundPanel state={calibRound} />
      </Body>
    );
  }

  return (
    <>
      <Body>

        {/* Calibration takes over the panel while it runs — it needs the room
            quiet and the person's attention, and it is over in ~10 s. */}
        {calibrating && (phase === "preparing" || phase === "rehearsal") ? (
          <CalibrationFlow
            onComplete={(ms, meta) => {
              setCalibratedLatency(ms);
              // Same destination as a calibration round's result: the mixer
              // seeds from the server copy, so a measurement that only reached
              // localStorage would be invisible to the host.
              publishCalibration({ latencyMs: ms, ...meta });
              setCalibrating(false);
            }}
            onCancel={() => setCalibrating(false)}
          />
        ) : (<>

        {/* ── Preparing ─────────────────────────────────────────────────── */}
        {phase === "preparing" && (
          <>
            <Music2 className="w-10 h-10 text-teal-400" />
            <div className="text-center">
              <p className="text-lg font-semibold text-white">Get your headphones on</p>
              <p className="text-sm text-zinc-400 mt-1">
                The host is setting up a recording session. Nothing to do yet —
                this panel will tell you when.
              </p>
            </div>
            {/* A cancelled round lands here, and without a word it reads as a
                crash: you were recording, and now you are back at "get ready".
                Says what happened and, per the wording rule above, what that
                means for the person reading — that they do nothing and wait,
                not that they failed at something. */}
            {p2g.cancelledClapAt != null && (
              <div className="w-full flex items-start gap-2 rounded-lg bg-zinc-800/70
                              border border-zinc-700 px-3 py-2 text-left">
                <X className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-zinc-300">
                  The host stopped the last round, so that recording was
                  discarded. Nothing went wrong on your side — wait here and
                  they will start it again.
                </p>
              </div>
            )}
            {/* Timing is measured by the host's rounds — one for everyone,
                nothing for a participant to remember to press — so the only
                thing worth telling them here is the setup choice that decides
                whether those rounds can measure them at all. It is the same
                choice both ways round: headphones to PLAY, headphones off for
                the ten seconds of a calibration round, and their own screen
                tells them when. */}
            <p className="text-[11px] text-amber-200/70 text-center leading-relaxed">
              Use headphones while you play. For the host&apos;s ten-second latency
              check you keep them on and just hold one earcup against your mic;
              your screen will say when.
            </p>

            {/* Optional, and deliberately not urgent: the host's calibration
                round measures this same thing for everybody at once, and its
                result lands here too. Left in place because a participant
                debugging their own setup — "why is my take always late?" —
                should not have to wait for the host to run a round for the
                whole band. Same measurement either way (`runCalibrationRun`),
                so the two cannot disagree. */}
            <CalibrationButton
              calibratedLatencyMs={calibratedLatencyMs}
              onOpen={() => setCalibrating(true)}
              onClear={() => { setCalibratedLatency(null); clearPublishedCalibration(); }}
            />
            <WhatIsThis />
          </>
        )}

        {/* ── Rehearsal ─────────────────────────────────────────────────── */}
        {phase === "rehearsal" && (
          <>
            <Music2 className="w-10 h-10 text-amber-400" />
            <div className="text-center">
              <p className="text-lg font-semibold text-white">
                {p2g.playRehearsal ? "Play along and check your level" : "Get ready to play"}
              </p>
              <p className="text-sm text-zinc-400 mt-1">
                {p2g.playRehearsal
                  ? "This is a rehearsal — nothing is being recorded. Watch the bar below: it should move when you play, without pinning to the top."
                  : "The host is about to play the backing track so you can set your level. Nothing is recorded yet."}
              </p>
            </div>

            {/* Live mic + reference visualiser */}
            {micAnalyser
              ? <MicVisualizer micAnalyser={micAnalyser} refAnalyser={refAnalyser}
                               getRefTime={getReferenceTime} refDuration={p2g.referenceDuration} />
              : <div className="w-full h-14 rounded-lg border border-zinc-800 bg-zinc-950
                                flex items-center justify-center text-xs text-zinc-600">
                  mic unavailable
                </div>
            }

            {isReady ? (
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-800/50 border border-emerald-600">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-300">You're ready!</span>
              </div>
            ) : (
              <button
                onClick={() => {
                  markReady().catch(() => {});
                  setIsReady(true);
                }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-teal-600
                           hover:bg-teal-500 text-sm font-semibold transition-colors"
              >
                <CheckCircle2 className="w-4 h-4" />
                I'm ready
              </button>
            )}
          </>
        )}

        {/* ── Countdown ─────────────────────────────────────────────────── */}
        {phase === "countdown" && (
          <>
            <p className="text-sm font-medium text-amber-400 uppercase tracking-widest">
              Get ready
            </p>
            <span className="text-8xl font-bold text-white tabular-nums leading-none">
              {countdown}
            </span>
            <p className="text-xs text-zinc-400">
              {isSyncRound
                ? `Listen to ${SYNC_FIRST_PLAYED_BEAT} clicks, then come in`
                : "Start playing on the clap. Your microphone is recording from that instant."}
            </p>

            {isSyncRound ? (
              <div className="text-center flex flex-col gap-1.5 max-w-[19rem]">
                <p className="text-sm font-semibold text-teal-300">
                  Count {SYNC_FIRST_PLAYED_BEAT} in, then one note per click — {SYNC_BARS} bars
                </p>
                {/* A NOTE, and the emphasis is field-earned: "según qué nota del
                    piano va mejor, con palmadas va mal". A clap is the least
                    steady thing a hand can do and it is broadband exactly like
                    the click, so on a laptop it competes with the metronome's
                    own bleed. This screen used to offer a clap as an equal
                    option. */}
                <p className="text-xs text-zinc-400 leading-relaxed">
                  <span className="text-zinc-200">Play a note, not a clap.</span>{" "}
                  One note per beat on your instrument — a key, a plucked string,
                  a hard staccato. No song, no backing track. Clap only if your
                  instrument has no attack at all.
                </p>
                <p className="text-[11px] text-amber-200/70">
                  The first {SYNC_FIRST_PLAYED_BEAT} clicks are your count-in — don&apos;t play
                  on them. You come in on the next <span className="font-semibold">accented</span>{" "}
                  click, and then on every one after it.
                </p>
                <p className="text-[11px] text-amber-200/70">
                  Headphones, not speakers — otherwise the click is measured
                  instead of you.
                </p>
              </div>
            ) : p2g.referenceUrl && (
              <p className="text-xs text-teal-300 flex items-center gap-1">
                <Music2 className="w-3.5 h-3.5" />
                Reference audio will play automatically
              </p>
            )}
          </>
        )}

        {/* ── Recording ─────────────────────────────────────────────────── */}
        {phase === "recording" && (
          <>
            {/* Pulsing mic indicator */}
            <div className="relative flex items-center justify-center">
              <span className="absolute w-20 h-20 rounded-full bg-rose-500/20 animate-ping" />
              <div className="w-16 h-16 rounded-full bg-rose-600 flex items-center justify-center">
                <Mic className="w-8 h-8 text-white" />
              </div>
            </div>

            <div className="w-full flex flex-col items-center gap-2">
              <p className="text-sm font-semibold text-rose-400">
                {isSyncRound ? (inCountIn ? "Listen — count 4 in" : "Play on every click") : "Play now"}
              </p>
              {/* Progress bar */}
              <div className="w-full bg-zinc-700 rounded-full h-2">
                <div
                  className="bg-rose-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${recordingProgress * 100}%` }}
                />
              </div>
              <p className="text-xs text-zinc-400">
                {Math.round(recordingProgress * roundDuration)}s
                {" / "}
                {Math.round(roundDuration)}s
              </p>
            </div>
          </>
        )}

        {/* ── Uploading ─────────────────────────────────────────────────── */}
        {phase === "uploading" && !uploadDone && !uploadError && (
          <>
            <Loader2 className="w-10 h-10 text-amber-400 animate-spin" />
            <div className="text-center">
              <p className="text-sm font-semibold text-amber-300">
                You can stop playing — leave this tab open
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {uploadSlot
                  ? `Your recording is queued to be sent: turn ${uploadSlot.slot} of ${uploadSlot.total}. They go one after another so nobody's upload fails.`
                  : "Sending your recording…"}
              </p>
              {/* The take only exists in memory until it's sent. Say so, or a
                  screen that looks idle invites closing the tab. */}
              {uploadSlot && (
                <p className="text-[11px] text-amber-200/70 mt-1.5">
                  Keep this tab open — your recording hasn&apos;t been sent yet.
                </p>
              )}
            </div>
          </>
        )}

        {/* ── Upload done — waiting for host to mix ─────────────────────── */}
        {phase === "uploading" && uploadDone && !uploadError && !isSyncRound && (
          <>
            <CheckCircle2 className="w-10 h-10 text-emerald-400" />
            <div className="text-center">
              <p className="text-sm font-semibold text-emerald-300">You&apos;re done — nothing more to do</p>
              <p className="text-xs text-zinc-400 mt-1">
                Your recording is safely on the server. The host will combine
                everyone&apos;s once the last one arrives.
              </p>
            </div>
          </>
        )}

        {/* ── Sync round verdict ─────────────────────────────────────────────
            The player sees their own number, because every way this can fail is
            something only they can fix — play on every click, get off Bluetooth,
            hit harder. Routing that to the host and leaving the musician looking
            at a green tick is how the last session ended up with three people
            unmeasured and nobody knowing until the mix. */}
        {phase === "uploading" && uploadDone && !uploadError && isSyncRound && (
          <>
            {syncResult ? (
              <>
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
                <div className="text-center flex flex-col gap-1">
                  <p className="text-sm font-semibold text-emerald-300">Measured — nothing more to do</p>
                  <p className="text-2xl font-bold text-white tabular-nums leading-none">
                    {syncResult.offsetMs > 0 ? "+" : ""}{syncResult.offsetMs} ms
                  </p>
                  <p className="text-xs text-zinc-400">
                    {syncResult.spreadMs <= SYNC_SPREAD_GOOD_MS
                      ? `Steady — ±${syncResult.spreadMs} ms across ${syncResult.hits} beats.`
                      : syncResult.spreadMs <= SYNC_SPREAD_FAIR_MS
                      ? `A little loose — ±${syncResult.spreadMs} ms. Good enough, but a steadier run would place you better.`
                      : `Unsteady — ±${syncResult.spreadMs} ms. Worth running again: with this much scatter there is no single right offset for your takes.`}
                  </p>
                  {syncResult.atSearchEdge && (
                    <p className="text-[11px] text-amber-200/70 mt-1">
                      Your delay is near the top of what this can measure — if you
                      are on Bluetooth audio, switching to wired will help a lot.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <AlertTriangle className="w-10 h-10 text-amber-400" />
                <div className="text-center flex flex-col gap-1 max-w-[19rem]">
                  <p className="text-sm font-semibold text-amber-300">That one didn&apos;t measure</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    {syncRefused ?? "The sync round could not be measured."}
                  </p>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Ask the host to run the sync round again.
                  </p>
                </div>
              </>
            )}
          </>
        )}

        {/* ── Recording / upload error ──────────────────────────────────────
            Two kinds:
            - "capture": nothing was recorded. Re-uploading can't help, so we
              don't show a retry button — the host has to run the round again
              (the host has already been notified via the failure report).
            - "upload": a take exists but the network upload failed — a retry
              re-sends the same bytes, so we keep the retry button. */}
        {uploadError && (
          <>
            <AlertTriangle className="w-10 h-10 text-rose-400" />
            <div className="text-center w-full">
              <p className="text-sm font-semibold text-rose-300">
                {uploadErrorKind === "capture"
                  ? "Your recording was lost — wait for the next round"
                  : "Your recording hasn't been sent yet"}
              </p>
              <p className="text-xs text-zinc-400 mt-1 break-words bg-zinc-800 rounded px-2 py-1">
                {uploadError}
              </p>
              {uploadErrorKind === "capture" && (
                <p className="text-[11px] text-zinc-500 mt-1">
                  The host has been notified. Please wait for the next round.
                </p>
              )}
            </div>
            {uploadErrorKind !== "capture" && (
              <button
                onClick={retryUpload}
                disabled={uploading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700
                           hover:bg-teal-600 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Retry upload
              </button>
            )}
          </>
        )}

        {/* ── Mixing ────────────────────────────────────────────────────── */}
        {phase === "mixing" && (
          <>
            <Loader2 className="w-10 h-10 text-teal-400 animate-spin" />
            <div className="text-center">
              {/* The instruction leads, the state name follows. "Mixing tracks"
                  is a word about a process a participant has no part in, and it
                  is the first thing somebody who just arrived reads. */}
              <p className="text-sm font-semibold text-teal-300">Nothing to do right now</p>
              <p className="text-xs text-zinc-400 mt-1">
                The host is combining everyone&apos;s recordings into one mix.
                It takes a few seconds.
              </p>
            </div>
            <WhatIsThis />
          </>
        )}

        {/* ── Done / result ─────────────────────────────────────────────── */}
        {phase === "done" && (
          <>
            <CheckCircle2 className="w-10 h-10 text-emerald-400" />
            <div className="text-center">
              <p className="text-sm font-semibold text-emerald-300">
                {p2g.playResult ? "Listen 🎧" : "Nothing to do right now"}
              </p>
              {p2g.playResult
                ? <p className="text-xs text-zinc-400 mt-1">The finished mix is playing for everyone.</p>
                : <p className="text-xs text-zinc-400 mt-1">The mix is ready — the host will play it for everyone.</p>
              }
            </div>
            {p2g.allowDownload && p2g.resultUrl && (
              <a
                href={p2g.resultUrl}
                download="play2gether-mix.webm"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600
                           hover:bg-teal-500 text-sm font-medium transition-colors"
              >
                <Download className="w-4 h-4" />
                Download mix
              </a>
            )}
          </>
        )}
        </>)}
      </Body>
    </>
  );
}

