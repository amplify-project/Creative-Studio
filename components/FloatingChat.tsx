"use client";

import { useState, useEffect, useRef } from "react";
import {
  useChat,
  useLocalParticipant,
  useRemoteParticipants,
} from "@livekit/components-react";
import { Send, Loader2, MessageSquare, X } from "lucide-react";

export default function FloatingChat({
  top = null,
  left = null,
  bottom = 20,
  right = 20,
}: {
  top?: number | null;
  left?: number | null;
  bottom?: number | null;
  right?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [unread, setUnread] = useState(0);
  const [prevMessageCount, setPrevMessageCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { chatMessages, isSending, send } = useChat();
  const { localParticipant } = useLocalParticipant();
  const remotes = useRemoteParticipants();

  const totalOnline = remotes.length + 1;

  /* ── Auto-scroll & unread counter ── */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });

    if (!open) {
      const newMessages = chatMessages.length - prevMessageCount;
      if (newMessages > 0) {
        setUnread((u) => u + newMessages);

        if (buttonRef.current) {
          buttonRef.current.classList.add("chat-shake");
          setTimeout(() => buttonRef.current?.classList.remove("chat-shake"), 500);
        }

        try {
          const audio = new Audio("https://actions.google.com/sounds/v1/cartoon/pop.ogg");
          audio.volume = 0.4;
          audio.play();
        } catch {}
      }
    }

    setPrevMessageCount(chatMessages.length);
  }, [chatMessages, open, prevMessageCount]);

  /* ── Reset unread on open, focus input ── */
  useEffect(() => {
    if (open) {
      setUnread(0);
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open]);

  /* ── Send ── */
  const handleSend = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    await send(text);
  };

  /* ── Helpers ── */
  const formatTime = (date: number | Date) =>
    new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const getInitials = (name: string) =>
    name
      .split(" ")
      .slice(0, 2)
      .map((n) => n[0])
      .join("")
      .toUpperCase() || "?";

  /* Stable hue per identity so each person gets a consistent color */
  const identityHue = (identity: string) => {
    let h = 0;
    for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) % 360;
    return h;
  };

  /* ── Position style for the whole wrapper ── */
  const wrapStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    top: top !== null ? top : undefined,
    left: left !== null ? left : undefined,
    bottom: bottom !== null ? bottom : undefined,
    right: right !== null ? right : undefined,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "10px",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  };

  return (
    <>
      {/* ── Keyframes ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

        @keyframes chat-shake {
          0%,100% { transform: translateX(0); }
          25%      { transform: translateX(-4px); }
          75%      { transform: translateX(4px); }
        }
        .chat-shake { animation: chat-shake 0.45s ease; }

        @keyframes chat-fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .chat-msg-in { animation: chat-fadeUp 0.22s ease both; }

        @keyframes chat-panel-in {
          from { opacity: 0; transform: translateY(10px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .chat-panel-in { animation: chat-panel-in 0.2s ease both; }

        @keyframes chat-bounce {
          0%,80%,100% { transform: translateY(0); opacity: 0.4; }
          40%          { transform: translateY(-4px); opacity: 1; }
        }
        .chat-typing-dot { animation: chat-bounce 1.2s infinite; }
        .chat-typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .chat-typing-dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes chat-pulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.35; }
        }
        .chat-online-dot { animation: chat-pulse 2s infinite; }

        .chat-scrollbar::-webkit-scrollbar       { width: 3px; }
        .chat-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }
      `}</style>

      <div style={wrapStyle}>

        {/* ── Chat panel ── */}
        {open && (
          <div
            className="chat-panel-in"
            style={{
              width: 300,
              height: 440,
              background: "rgba(10, 12, 18, 0.88)",
              backdropFilter: "blur(24px) saturate(180%)",
              WebkitBackdropFilter: "blur(24px) saturate(180%)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 18,
              boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              color: "#eef0f5",
            }}
          >
            {/* Header */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 16px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
              flexShrink: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.06em", textTransform: "uppercase", color: "#eef0f5",
                }}>
                  Chat
                </span>
                <div style={{
                  display: "flex", alignItems: "center", gap: 5,
                  background: "rgba(34,217,122,0.1)",
                  border: "1px solid rgba(34,217,122,0.25)",
                  borderRadius: 20, padding: "2px 8px",
                  fontSize: 10, color: "#22d97a", fontWeight: 500,
                  fontFamily: "'DM Mono', monospace",
                }}>
                  <div className="chat-online-dot" style={{
                    width: 5, height: 5, borderRadius: "50%",
                    background: "#22d97a",
                    boxShadow: "0 0 6px #22d97a",
                  }} />
                  {totalOnline} online
                </div>
              </div>

              <button
                onClick={() => setOpen(false)}
                style={{
                  width: 26, height: 26, borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.04)",
                  color: "#666e85", fontSize: 13,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all .15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.1)";
                  (e.currentTarget as HTMLElement).style.color = "#eef0f5";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                  (e.currentTarget as HTMLElement).style.color = "#666e85";
                }}
              >
                <X size={13} strokeWidth={2.5} />
              </button>
            </div>

            {/* Messages */}
            <div
              className="chat-scrollbar"
              style={{
                flex: 1, overflowY: "auto",
                padding: "12px 14px 6px",
                display: "flex", flexDirection: "column", gap: 10,
                scrollbarWidth: "thin",
                scrollbarColor: "rgba(255,255,255,0.07) transparent",
              }}
            >
              {chatMessages.length === 0 && (
                <div style={{
                  flex: 1, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  gap: 8, color: "#444c60", paddingBottom: 20,
                }}>
                  <MessageSquare size={28} strokeWidth={1.5} />
                  <span style={{ fontSize: 12 }}>No messages yet</span>
                </div>
              )}

              {chatMessages.map((m, i) => {
                const isYou = m.from?.identity === localParticipant.identity;
                const name = m.from?.name || m.from?.identity || "?";
                const initials = getInitials(name);
                const hue = identityHue(m.from?.identity ?? "");

                return (
                  <div
                    key={i}
                    className="chat-msg-in"
                    style={{
                      display: "flex",
                      flexDirection: isYou ? "row-reverse" : "row",
                      gap: 8,
                      alignItems: "flex-end",
                      animationDelay: `${Math.min(i * 0.03, 0.15)}s`,
                    }}
                  >
                    {/* Avatar */}
                    <div style={{
                      width: 26, height: 26, borderRadius: "50%",
                      flexShrink: 0,
                      background: isYou
                        ? "linear-gradient(135deg, #6c63ff, #a78bfa)"
                        : `hsl(${hue}, 55%, 42%)`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 700, color: "#fff",
                    }}>
                      {initials}
                    </div>

                    {/* Bubble */}
                    <div style={{
                      maxWidth: 200,
                      display: "flex", flexDirection: "column", gap: 2,
                      alignItems: isYou ? "flex-end" : "flex-start",
                    }}>
                      <span style={{
                        fontSize: 10, color: "#555e75", fontWeight: 500,
                        padding: "0 4px",
                      }}>
                        {isYou ? "You" : name}
                      </span>
                      <div style={{
                        padding: "8px 11px",
                        borderRadius: 13,
                        borderBottomRightRadius: isYou ? 3 : 13,
                        borderBottomLeftRadius: isYou ? 13 : 3,
                        background: isYou
                          ? "rgba(108,99,255,0.2)"
                          : "rgba(255,255,255,0.05)",
                        border: isYou
                          ? "1px solid rgba(108,99,255,0.4)"
                          : "1px solid rgba(255,255,255,0.09)",
                        fontSize: 13, lineHeight: 1.5, color: "#eef0f5",
                        wordBreak: "break-word",
                        textAlign: isYou ? "right" : "left",
                      }}>
                        {m.message}
                      </div>
                      <span style={{
                        fontSize: 9, color: "#444c60",
                        padding: "0 4px",
                        fontFamily: "'DM Mono', monospace",
                      }}>
                        {formatTime(m.timestamp)}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Typing indicator */}
              {isSending && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%",
                    background: "rgba(255,255,255,0.06)",
                    flexShrink: 0,
                  }} />
                  <div style={{
                    display: "flex", gap: 3, alignItems: "center",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.09)",
                    borderRadius: 12, padding: "8px 12px",
                  }}>
                    {[0, 1, 2].map((n) => (
                      <div key={n} className="chat-typing-dot" style={{
                        width: 5, height: 5, borderRadius: "50%",
                        background: "#555e75",
                      }} />
                    ))}
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div style={{
              padding: "10px 14px 14px",
              borderTop: "1px solid rgba(255,255,255,0.07)",
              display: "flex", alignItems: "center", gap: 8,
              flexShrink: 0,
            }}>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Write a message..."
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 11,
                  padding: "8px 12px",
                  color: "#eef0f5",
                  fontFamily: "'DM Sans', system-ui, sans-serif",
                  fontSize: 13,
                  outline: "none",
                  transition: "border-color .2s",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "rgba(108,99,255,0.5)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)")}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isSending}
                style={{
                  width: 34, height: 34, borderRadius: 10,
                  border: "none",
                  background: input.trim() ? "#6c63ff" : "rgba(108,99,255,0.2)",
                  color: "#fff", cursor: input.trim() ? "pointer" : "default",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: input.trim() ? "0 0 16px rgba(108,99,255,0.4)" : "none",
                  transition: "all .15s",
                  flexShrink: 0,
                }}
              >
                {isSending
                  ? <Loader2 size={15} className="animate-spin" />
                  : <Send size={15} strokeWidth={2.5} />
                }
              </button>
            </div>
          </div>
        )}

        {/* ── Toggle button ── */}
        <button
          ref={buttonRef}
          onClick={() => setOpen((o) => !o)}
          style={{
            width: 44, height: 44,
            borderRadius: 13,
            border: open
              ? "1px solid rgba(108,99,255,0.45)"
              : "1px solid rgba(255,255,255,0.08)",
            background: open
              ? "rgba(108,99,255,0.2)"
              : "rgba(10,12,18,0.8)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            color: open ? "#a78bfa" : "#eef0f5",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            transition: "all .2s",
            position: "relative",
          }}
          title={open ? "Close chat" : "Open chat"}
        >
          {open ? <X size={18} strokeWidth={2} /> : <MessageSquare size={18} strokeWidth={1.8} />}

          {/* Unread badge */}
          {!open && unread > 0 && (
            <div style={{
              position: "absolute", top: -5, right: -5,
              minWidth: 18, height: 18,
              background: "#6c63ff",
              borderRadius: 9,
              border: "2px solid rgba(10,12,18,0.9)",
              fontSize: 10, fontWeight: 700, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "0 4px",
              boxShadow: "0 0 10px rgba(108,99,255,0.6)",
            }}>
              {unread > 9 ? "9+" : unread}
            </div>
          )}
        </button>

      </div>
    </>
  );
}