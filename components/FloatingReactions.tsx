"use client";

import { useState, useEffect, useCallback } from "react";
import { useRoomContext } from "@livekit/components-react";

const REACTION_TOPIC = "reaction";
const EMOJIS = ["👏", "❤️", "😂", "🔥", "👍", "😮"];

interface FlyingEmoji {
  id: string;
  emoji: string;
  rightVw: number;  // random horizontal spread (% from right)
  drift: number;    // slight horizontal drift during float
  duration: number; // ms — each emoji gets its own timing so they feel organic
}

export default function FloatingReactions({
  top = null,
  bottom = null,
  right = 74,
}: {
  top?: number | null;
  bottom?: number | null;
  right?: number;
}) {
  const room = useRoomContext();
  const [open, setOpen] = useState(false);
  const [flying, setFlying] = useState<FlyingEmoji[]>([]);

  // Receive reactions from remote participants
  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
      if (topic !== REACTION_TOPIC) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (typeof msg.emoji === "string") spawn(msg.emoji);
      } catch { /* ignore malformed */ }
    };
    room.on("dataReceived", handler);
    return () => { room.off("dataReceived", handler); };
  }, [room]); // eslint-disable-line react-hooks/exhaustive-deps

  const spawn = useCallback((emoji: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Spread emojis across 4–20% from the right so concurrent reactions fan out
    const rightVw = 4 + Math.random() * 16;
    const drift = (Math.random() - 0.5) * 40; // px horizontal drift over the float
    const duration = 2600 + Math.random() * 600;
    setFlying(f => [...f, { id, emoji, rightVw, drift, duration }]);
    setTimeout(() => setFlying(f => f.filter(e => e.id !== id)), duration + 100);
  }, []);

  const sendReaction = useCallback((emoji: string) => {
    setOpen(false);
    spawn(emoji); // local echo — don't wait for the network round-trip
    if (!room) return;
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "reaction", emoji })),
      { reliable: false, topic: REACTION_TOPIC }
    );
  }, [room, spawn]);

  const wrapStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    top:    top    !== null ? top    : undefined,
    bottom: bottom !== null ? bottom : undefined,
    right,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 8,
  };

  return (
    <>
      <style>{`
        @keyframes emoji-float {
          0%   { opacity: 1;   transform: translateY(0px)    scale(1)   rotate(0deg); }
          12%  { opacity: 1;   transform: translateY(-70px)  scale(1.45) rotate(-6deg); }
          100% { opacity: 0;   transform: translateY(-430px) scale(0.65) rotate(10deg); }
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
        @keyframes reaction-picker-in {
          from { opacity: 0; transform: scale(0.8) translateY(8px); }
          to   { opacity: 1; transform: scale(1)   translateY(0); }
        }
        .reaction-picker-in {
          animation: reaction-picker-in 0.18s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        .reaction-emoji-btn {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 24px;
          line-height: 1;
          padding: 6px 8px;
          border-radius: 10px;
          transition: background 0.12s, transform 0.1s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .reaction-emoji-btn:hover {
          background: rgba(255,255,255,0.1);
          transform: scale(1.35);
        }
      `}</style>

      {/* ── Flying emojis (full-viewport overlay) ── */}
      {flying.map(f => (
        <span
          key={f.id}
          className="reaction-fly"
          style={{
            right: `${f.rightVw}vw`,
            animation: `emoji-float ${f.duration}ms cubic-bezier(0.2, 0.8, 0.3, 1) forwards`,
            // horizontal drift baked into a CSS custom property via inline style isn't straightforward,
            // so we set a separate translateX in a wrapper instead
          }}
        >
          {/* inner span handles the horizontal drift so the keyframe Y is clean */}
          <span style={{
            display: "block",
            animation: `none`,
            transform: `translateX(${f.drift}px)`,
            transition: `transform ${f.duration}ms ease-out`,
          }}>
            {f.emoji}
          </span>
        </span>
      ))}

      {/* ── Button + picker ── */}
      <div style={wrapStyle}>
        {/* Emoji picker strip */}
        {open && (
          <div
            className="reaction-picker-in"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              background: "rgba(10,12,18,0.88)",
              backdropFilter: "blur(24px) saturate(180%)",
              WebkitBackdropFilter: "blur(24px) saturate(180%)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 16,
              padding: "6px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.03)",
            }}
          >
            {EMOJIS.map(emoji => (
              <button
                key={emoji}
                className="reaction-emoji-btn"
                onClick={() => sendReaction(emoji)}
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {/* Toggle button */}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            width: 44, height: 44,
            borderRadius: 13,
            border: open
              ? "1px solid rgba(255,200,50,0.5)"
              : "1px solid rgba(255,255,255,0.08)",
            background: open
              ? "rgba(255,200,50,0.15)"
              : "rgba(10,12,18,0.8)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            cursor: "pointer",
            fontSize: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            transition: "all 0.2s",
          }}
          title="Send a reaction"
        >
          🎉
        </button>
      </div>
    </>
  );
}
