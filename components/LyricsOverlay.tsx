"use client";

import { useEffect, useMemo, useState } from "react";
import { usePlay2GetherSession } from "../app/hooks/usePlay2GetherSession";

export interface LyricLine {
  /** Start time in seconds, relative to the reference audio. */
  time: number;
  /** The text to display. Empty strings are stripped during parse. */
  text: string;
}

/**
 * Parse an LRC file. Format:
 *   [mm:ss.xx]Lyric text on this line
 *   [00:12.34][00:24.56]Same text at multiple times    ← also valid
 *   [ti:Song Title]                                    ← metadata, ignored
 *   [ar:Artist]                                        ← metadata, ignored
 *
 * The metadata-style tags ([ti:…], [ar:…], etc.) are skipped because the
 * first character after the colon isn't a digit — keeps the parser dead
 * simple without a full state machine.
 */
export function parseLRC(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const tsRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.replace(tsRe, "").trim();
    if (!stripped) continue;
    const matches = Array.from(raw.matchAll(tsRe));
    if (matches.length === 0) continue;
    for (const m of matches) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // Fractional digits can be 1-3 chars in the wild ([00:12.3], [00:12.34],
      // [00:12.345]). Pad to 3 so we always interpret as milliseconds.
      const fracStr = (m[3] ?? "0").padEnd(3, "0").slice(0, 3);
      const frac = Number(fracStr) / 1000;
      lines.push({ time: min * 60 + sec + frac, text: stripped });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Binary search for the line whose time is the greatest ≤ currentSec. */
function findCurrentLineIdx(lines: LyricLine[], currentSec: number): number {
  if (lines.length === 0 || currentSec < lines[0].time) return -1;
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lines[mid].time <= currentSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Bottom-of-screen lyrics banner. Polls the reference playback position every
 * 100ms (smooth enough for line-level highlights without burning CPU) and shows
 * prev / current / next lines. Renders nothing when the parsed lyrics are
 * empty so a malformed LRC doesn't leave an empty banner on screen.
 *
 * `getTime` rather than an <audio> element: during a take the reference is a
 * buffer scheduled on the AudioContext clock and no element is moving, so the
 * hook is the only thing that knows where playback is.
 */
export function LyricsOverlay({
  lrcText,
  getTime,
}: {
  lrcText: string | null;
  getTime: () => number | null;
}) {
  const lines = useMemo(
    () => (lrcText ? parseLRC(lrcText) : []),
    [lrcText],
  );

  const [currentIdx, setCurrentIdx] = useState(-1);
  useEffect(() => {
    if (lines.length === 0) {
      setCurrentIdx(-1);
      return;
    }
    const tick = () => {
      const t = getTime();
      setCurrentIdx(t == null ? -1 : findCurrentLineIdx(lines, t));
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [getTime, lines]);

  if (lines.length === 0) return null;

  const prev = currentIdx > 0 ? lines[currentIdx - 1] : null;
  const curr = currentIdx >= 0 ? lines[currentIdx] : null;
  const next = currentIdx + 1 < lines.length ? lines[currentIdx + 1] : null;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none
                 flex flex-col items-center justify-center gap-1
                 px-6 py-4 mb-safe bg-gradient-to-t from-black/85 via-black/60 to-transparent"
    >
      {/* `line-clamp`, not `truncate`, on the current line. Truncating is
          fine on a desktop stage, where a line of lyrics almost never reaches
          the width; on a phone in portrait it cut nearly every line, which is
          the one thing the singer actually needs to read. Context lines keep
          one line each — they are orientation, not the words being sung. */}
      <p className="text-xs sm:text-sm text-zinc-400 truncate max-w-3xl w-full text-center">
        {prev?.text ?? " "}
      </p>
      <p className="text-xl sm:text-2xl font-bold text-white max-w-3xl w-full text-center
                    text-balance line-clamp-2
                    drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
        {curr?.text ?? " "}
      </p>
      <p className="text-xs sm:text-sm text-zinc-500 truncate max-w-3xl w-full text-center">
        {next?.text ?? " "}
      </p>
    </div>
  );
}

/**
 * Self-contained banner that pulls lyrics + reference audio from the hook and
 * gates visibility to the phases where the reference is actually playing.
 * Use this from any host/participant container — no props needed, so both the
 * participant overlay and the host page can render it without duplicating the
 * gating logic.
 */
export function Play2GetherLyricsBanner() {
  // This is a SECOND hook instance (the panel is the first). It only needs to
  // read phase + reference audio for lyric timing — it must NOT run the
  // recorder/upload/metronome machinery, or it races the panel for the
  // module-level upload lock and leaves the panel stuck on "Uploading…"
  // (see the `capture` option in usePlay2GetherSession).
  const { p2g, phase, getReferenceTime, lyricsText } = usePlay2GetherSession({ capture: false });
  // Never during a sync round: no reference is playing, so `getReferenceTime`
  // has no clock to follow and the banner would sit on the first line of a song
  // nobody is singing, over an instruction the player actually needs to read.
  const showLyrics = p2g.roundKind !== "sync"
    && (phase === "rehearsal" || phase === "countdown" || phase === "recording");
  if (!showLyrics || !lyricsText) return null;
  return <LyricsOverlay lrcText={lyricsText} getTime={getReferenceTime} />;
}
