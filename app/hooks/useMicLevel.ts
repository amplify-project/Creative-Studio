"use client";

/**
 * Live input-level measurement for a single mic track.
 *
 * Extracted from MicCalibrationPanel so the pre-join screen can show the same
 * meter without a second copy of the dBFS maths — the two must agree, or a
 * user who sets their gain before joining finds a different reading after.
 *
 * It measures whatever track it is handed. MicCalibrationPanel passes the
 * *published* track, so the reading is the signal the room actually receives;
 * JoinSetup passes its own pre-join capture, since nothing is published yet.
 * Neither is ever routed to the speakers — connecting a mic to `destination`
 * would feed it straight back into the room.
 */

import { useEffect, useRef, useState } from "react";

/** Below this is silence for our purposes, and the bottom of the meter. */
export const FLOOR_DB = -60;
/** Recent peak under this: they aren't playing yet. */
export const SIGNAL_DB = -40;
/** Present, but quiet enough to get buried in the mix. */
export const LOW_DB = -18;

const CLIP_SAMPLE = 0.99;      // |sample| at or above this is a clipped sample
const CLIP_MEMORY_MS = 1500;   // how long the clip warning stays lit
const UI_INTERVAL_MS = 50;     // ~20 fps: smooth enough, 3x cheaper than rAF

export type MicLevel = {
  /** Instantaneous peak, dBFS. `-Infinity` before the first sample. */
  peakDb: number;
  /**
   * Peak hold with a slow fall. Every piece of advice reads off this, never
   * off `peakDb`: the instantaneous peak dips below any threshold on each
   * breath and pause, which made the panel nag "raise your gain" at people
   * who simply weren't singing yet.
   */
  holdDb: number;
  /** A sample hit full scale within the last CLIP_MEMORY_MS. */
  clipping: boolean;
  /** A sample has hit full scale at any point since measuring began. */
  everClipped: boolean;
};

const IDLE: MicLevel = {
  peakDb: -Infinity,
  holdDb: -Infinity,
  clipping: false,
  everClipped: false,
};

/** Map a dBFS reading onto a 0-100 meter, clamped at the floor. */
export function dbToPercent(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
}

export function useMicLevel(track: MediaStreamTrack | null | undefined): MicLevel {
  const [level, setLevel] = useState<MicLevel>(IDLE);
  const holdRef = useRef(-Infinity);
  const lastClipAt = useRef(0);
  const everClippedRef = useRef(false);

  useEffect(() => {
    if (!track) {
      holdRef.current = -Infinity;
      everClippedRef.current = false;
      setLevel(IDLE);
      return;
    }

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    void audioCtx.resume();

    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);

      let peak = 0;
      let clipped = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        if (a >= CLIP_SAMPLE) clipped++;
      }

      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      holdRef.current = db > holdRef.current
        ? db
        : Math.max(FLOOR_DB, holdRef.current - 0.5);

      const now = Date.now();
      if (clipped > 0) {
        lastClipAt.current = now;
        everClippedRef.current = true;
      }

      setLevel({
        peakDb: db,
        holdDb: holdRef.current,
        clipping: now - lastClipAt.current < CLIP_MEMORY_MS,
        everClipped: everClippedRef.current,
      });
    }, UI_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      try {
        source.disconnect();
        void audioCtx.close();
      } catch {
        /* context already torn down */
      }
    };
  }, [track]);

  return level;
}
