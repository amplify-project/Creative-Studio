"use client";

/**
 * Sending and showing emoji reactions, owned in one place.
 *
 * All of this used to live inside `ParticipantControlPanel`: the data-channel
 * listener, the flying overlay and a whole tab whose only content was six
 * buttons. A reaction is a one-tap thing — burying it two taps deep in a side
 * panel, next to chat and file notes, is the wrong shape for it, and the
 * panel covering most of a phone screen meant you could not see the reaction
 * you had just sent.
 *
 * So the trigger moves to the control bar and the machinery moves here. The
 * provider owns the *only* subscription and the *only* overlay — mount it
 * twice and every reaction is spawned twice — while consumers get `send` and
 * the emoji set. Same shape as `ToastLaneProvider` and `ControlPanelProvider`
 * above it: a page-level provider, and an `OrNull` hook so a control that
 * cannot work hides instead of doing nothing.
 *
 * The lane knows nothing about who is sending; the host page and the
 * participant page mount it identically.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRoomContext } from "@livekit/components-react";

const REACTION_TOPIC = "reaction";

/** The palette. Order is the order they appear in the picker. */
export const REACTION_EMOJIS = ["👏", "❤️", "😂", "🔥", "👍", "😮", "🍀"];

interface FlyingEmoji {
  id: string;
  emoji: string;
  // Signed offset from viewport horizontal centre (vw). Positive = right of
  // centre. It was once `rightVw`, which placed every emoji squarely inside
  // the area the side panel occupies — covered when open, visibly off-centre
  // when closed.
  centerOffsetVw: number;
  drift: number;
  duration: number;
}

type ReactionsValue = {
  emojis: string[];
  /** Show it here and tell everyone else. */
  send: (emoji: string) => void;
};

const Ctx = createContext<ReactionsValue | null>(null);

export function ReactionsProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  const [flying, setFlying] = useState<FlyingEmoji[]>([]);

  const spawn = useCallback((emoji: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Fan out ±20vw around the centre so a burst of them is legible, without
    // reaching the side panel (≈ the rightmost 15vw on a desktop).
    const centerOffsetVw = (Math.random() - 0.5) * 40;
    const drift = (Math.random() - 0.5) * 40;
    const duration = 2600 + Math.random() * 600;
    setFlying((f) => [...f, { id, emoji, centerOffsetVw, drift, duration }]);
    setTimeout(() => setFlying((f) => f.filter((e) => e.id !== id)), duration + 100);
  }, []);

  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic !== REACTION_TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (typeof msg.emoji === "string") spawn(msg.emoji);
      } catch { /* malformed payload from an older client — ignore */ }
    };
    room.on("dataReceived", handler);
    return () => { room.off("dataReceived", handler); };
  }, [room, spawn]);

  const send = useCallback((emoji: string) => {
    spawn(emoji);
    if (!room) return;
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "reaction", emoji })),
      { reliable: false, topic: REACTION_TOPIC },
    );
  }, [room, spawn]);

  const value = useMemo<ReactionsValue>(
    () => ({ emojis: REACTION_EMOJIS, send }),
    [send],
  );

  return (
    <Ctx.Provider value={value}>
      <style>{`
        @keyframes emoji-float {
          0%   { opacity: 1; transform: translateY(0px) scale(1); }
          12%  { opacity: 1; transform: translateY(-70px) scale(1.45); }
          100% { opacity: 0; transform: translateY(-430px) scale(0.65); }
        }
        .reaction-fly {
          position: fixed;
          bottom: 90px;
          pointer-events: none;
          user-select: none;
          font-size: 42px;
          line-height: 1;
          z-index: 99997;
          filter: drop-shadow(0 3px 10px rgba(0,0,0,0.45));
        }
      `}</style>

      {/* The outer span owns the vertical animation (translateY from the
        * keyframes), the inner one the horizontal centring plus drift.
        * Splitting them across two nodes is what stops the keyframes from
        * overwriting the centring transform on every tick. */}
      {flying.map((f) => (
        <div
          key={f.id}
          className="reaction-fly"
          style={{
            left: `calc(50vw + ${f.centerOffsetVw}vw)`,
            animation: `emoji-float ${f.duration}ms cubic-bezier(0.2,0.8,0.3,1) forwards`,
          }}
        >
          <div
            style={{
              display: "block",
              transform: `translateX(calc(-50% + ${f.drift}px))`,
              transition: `transform ${f.duration}ms ease-out`,
            }}
          >
            {f.emoji}
          </div>
        </div>
      ))}

      {children}
    </Ctx.Provider>
  );
}

/**
 * `null` where no provider is mounted. A control that only *sends* should
 * render nothing in that case rather than a button that goes nowhere.
 */
export function useReactionsOrNull(): ReactionsValue | null {
  return useContext(Ctx);
}
