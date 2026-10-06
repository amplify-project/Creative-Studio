"use client";

import { useState, useEffect, useRef } from "react";
import { ToastLane, LANE_ORDER } from "./ui/ToastLane";
import { useControlPanel } from "./ui/ControlPanelContext";
import { usePublishUrl } from "../app/hooks/usePublishUrl";
import {
  useChat,
  useLocalParticipant,
  useRoomContext,
  useRemoteParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { QRCodeSVG } from "qrcode.react";
import {
  Send, Loader2, MessageSquare, QrCode, LogOut, X,
  ChevronRight, ChevronLeft, FileText, AudioLines,
  MonitorUp, Camera as CameraIcon, Music2,
} from "lucide-react";
import NotesTab from "./NotesTab";
import AudioAnalysisTab from "./AudioAnalysisTab";
import { outputNode } from "../app/utils/outputBus";

// Short notification ping via Web Audio API — no audio asset to ship, plays
// only after the page has received a user gesture (browser autoplay policy
// gates AudioContext creation otherwise). Single sine tone, 250 ms.
function playChatPing() {
  try {
    const AudioContextClass =
      typeof window !== "undefined"
        ? window.AudioContext || (window as any).webkitAudioContext
        : null;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(outputNode(ctx));
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    // Close the context after the tone has played so we don't leak
    // hardware audio resources across many messages.
    setTimeout(() => ctx.close().catch(() => {}), 300);
  } catch { /* ignore */ }
}

// Render a chat message string with http(s) URLs as clickable links.
function renderMessageText(text: string) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-indigo-300 hover:text-indigo-200 break-all"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

interface ChatToast {
  id: string;
  from: string;
  message: string;
}

const TOAST_TTL_MS = 5000;
const MAX_VISIBLE_TOASTS = 3;

type Tab = "chat" | "notes" | "audio" | "qr" | "p2g";

// Reactions used to be a tab here. They are one tap on the control bar now
// (components/ui/ReactionsContext.tsx) — a panel that covers most of a phone
// screen is the wrong place for a gesture whose whole point is being quick,
// and whose result flies across the video the panel is sitting on.
//
// `hostOnly` is the tab table's own business: the panel is mounted by both
// pages, and the Audio tab is the analyser's readout, written for whoever is
// running the session.
const ALL_TABS: { id: Tab; label: string; icon: React.ReactNode; hostOnly?: boolean; p2gOnly?: boolean }[] = [
  // Only while the page hands the docked panel something to show there
  // (see `play`): the participant's Play2Gether panel, the host's mixer.
  { id: "p2g",   label: "Play",  icon: <Music2 size={14} />, p2gOnly: true },
  { id: "chat",  label: "Chat",  icon: <MessageSquare size={14} /> },
  { id: "notes", label: "Files", icon: <FileText size={14} /> },
  { id: "audio", label: "Audio", icon: <AudioLines size={14} />, hostOnly: true },
  { id: "qr",    label: "Utils", icon: <QrCode size={14} /> },
];

/**
 * `role` says which page mounted the panel, the same way
 * `AssistantSuggestionsProvider` takes `localRole`. It is not cosmetic: the
 * Audio tab is the analyser's own readout, written for whoever is running the
 * session, and a participant has nothing to do with what it shows.
 */
export default function ParticipantControlPanel({
  role = "participant",
  docked = false,
  play,
}: {
  role?: "host" | "participant";
  /**
   * A column in the page layout (the stage is resized around it) instead of a
   * fixed overlay, and home of the "Play" tab. Both pages mount it this way
   * now, inside their stage row.
   */
  docked?: boolean;
  /**
   * The Play2Gether tab (docked only). The panel stays generic: the page says
   * what goes in it and when it matters.
   *  - `content` is rendered whenever given and only HIDDEN when another tab is
   *    showing — the participant's panel owns the recorder and must never
   *    unmount mid-session, the host's holds the mixer's state.
   *  - `active` shows the tab; turning true opens the column on it, turning
   *    false closes it again if it was showing.
   *  - `urgent` brings it to the front even over the chat.
   *  - `attention` pulses the closed strip.
   *  - `wide` widens the column while the tab is showing (the host's mixer).
   */
  play?: {
    content: React.ReactNode;
    active: boolean;
    urgent?: boolean;
    attention?: boolean;
    wide?: boolean;
  };
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const remotes = useRemoteParticipants();
  const { chatMessages, isSending, send } = useChat();
  const allTracks = useTracks();
  // Group local + secondary + screen feeds by base identity. Convention from
  // PublishClient: secondary cameras and screen shares connect with
  // `<base>-secondary-<rnd>` / `<base>-screen-<rnd>` identities, so the first
  // hyphen-delimited segment identifies the logical user.
  const baseIdentity = (id: string) => id.split("-")[0];
  const myBase = baseIdentity(localParticipant?.identity ?? "");
  // Any video source, not just Camera and ScreenShare: a second camera
  // published from this page carries `Source.Unknown` (see toggleSecondCamera),
  // and it belongs in "Active feeds" like every other stream the user is
  // sending.
  const localVideoTracks = allTracks.filter(
    (t) =>
      myBase !== "" &&
      baseIdentity(t.participant.identity) === myBase &&
      t.publication.kind === Track.Kind.Video
  );

  // Open/close and unread now live in ControlPanelContext so the bottom
  // control bar can drive them; without a provider the hook falls back to its
  // own state and the panel behaves exactly as before.
  const { open, tab, openPanel, closePanel, setTab, unreadChat, setUnreadChat } =
    useControlPanel();
  const setOpen = (v: boolean) => (v ? openPanel() : closePanel());
  const [input, setInput] = useState("");
  const [prevMsgCount, setPrevMsgCount] = useState(0);
  const [chatToasts, setChatToasts] = useState<ChatToast[]>([]);

  // The Play tab, docked panel only: show it, jump to it when there is
  // something to act on in seconds, and let it go when it ends.
  const p2g = {
    active: !!(docked && play?.active),
    urgent: !!(docked && play?.urgent),
    attention: !!(docked && play?.attention),
  };
  const p2gWasActive = useRef(false);
  useEffect(() => {
    if (!docked) return;
    if (p2g.active && !p2gWasActive.current) openPanel("p2g");
    if (!p2g.active && p2gWasActive.current && tab === "p2g") {
      setTab("chat");
      closePanel();
    }
    p2gWasActive.current = p2g.active;
  }, [docked, p2g.active]); // eslint-disable-line
  useEffect(() => {
    if (docked && p2g.urgent) openPanel("p2g");
  }, [docked, p2g.urgent]); // eslint-disable-line

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mobileUrl = usePublishUrl();

  // Auto-scroll + unread counter + notification ping + toast popups
  useEffect(() => {
    if (open && tab === "chat") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      const newMsgs = chatMessages.length - prevMsgCount;
      if (newMsgs > 0) {
        // Only react to messages from others — our own message shouldn't
        // ping or toast us.
        const fromOthers = chatMessages
          .slice(prevMsgCount)
          .filter((m) => m.from?.identity !== localParticipant?.identity);
        if (fromOthers.length > 0) {
          playChatPing();
          // Push toasts; trim to MAX_VISIBLE_TOASTS oldest-first so the
          // stack doesn't grow unbounded during chat bursts.
          fromOthers.forEach((m) => {
            const toast: ChatToast = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              from: m.from?.name || m.from?.identity || "?",
              message: m.message,
            };
            setChatToasts((prev) => [...prev.slice(-(MAX_VISIBLE_TOASTS - 1)), toast]);
            setTimeout(() => {
              setChatToasts((prev) => prev.filter((t) => t.id !== toast.id));
            }, TOAST_TTL_MS);
          });
        }
        setUnreadChat((u) => u + newMsgs);
      }
    }
    setPrevMsgCount(chatMessages.length);
  }, [chatMessages]); // eslint-disable-line

  // Reset unread + focus input when chat tab opens
  useEffect(() => {
    if (open && tab === "chat") {
      setUnreadChat(0);
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open, tab]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    await send(text);
  };

  const formatTime = (date: number | Date) =>
    new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const getInitials = (name: string) =>
    name.split(" ").slice(0, 2).map((n) => n[0]).join("").toUpperCase() || "?";

  const identityHue = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  };

  const totalOnline = remotes.length + 1;

  const TABS = ALL_TABS.filter((t) =>
    (!t.hostOnly || role === "host") && (!t.p2gOnly || p2g.active));

  return (
    <>
      <style>{`
        @keyframes panel-slide-in {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        .ctrl-panel-in { animation: panel-slide-in 0.22s cubic-bezier(0.4,0,0.2,1) both; }
        @keyframes chat-toast-in {
          from { transform: translateX(110%); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        .chat-toast-in { animation: chat-toast-in 0.28s cubic-bezier(0.4,0,0.2,1) both; }
      `}</style>

      {/* Chat toasts — popup notification when the chat tab isn't visible.
          Click any toast to open the panel directly on the chat tab. Auto-
          dismisses after TOAST_TTL_MS.

          Rendered into the page's shared ToastLane so it queues with the
          presence and assistant stacks. The old `right-[19rem]` shift, used
          to clear the open panel, put the toast off the left edge of a phone
          — 19rem of offset on a ~24rem screen. The panel is now simply
          `sm:`-only: below that breakpoint it covers most of the width, and
          the chat it is announcing is already on screen, so a toast about it
          is noise. */}
      {chatToasts.length > 0 && (
        <ToastLane order={LANE_ORDER.chat}>
          <div
            className={`flex flex-col gap-2 pointer-events-none w-full items-end
                        ${open ? `hidden sm:flex ${docked ? "sm:mr-[21rem]" : "sm:mr-[17rem]"}` : ""}`}
          >
          {chatToasts.map((toast) => (
            <button
              key={toast.id}
              onClick={() => {
                setOpen(true);
                setTab("chat");
                setChatToasts([]);
              }}
              className="chat-toast-in pointer-events-auto w-80 max-w-[80vw]
                         flex items-start gap-2 px-3 py-2.5
                         bg-zinc-900/95 backdrop-blur-md border border-white/10
                         rounded-xl shadow-2xl text-left
                         hover:bg-zinc-800/95 hover:border-indigo-500/40 transition-colors"
            >
              <MessageSquare size={14} className="text-indigo-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold text-indigo-300 truncate">{toast.from}</div>
                <div
                  className="text-xs text-zinc-200 break-words"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical" as any,
                    overflow: "hidden",
                  }}
                >
                  {toast.message}
                </div>
              </div>
            </button>
          ))}
          </div>
        </ToastLane>
      )}

      {/* Docked and closed, sm+: a thin strip in the layout, so the way back
          in never sits on top of the stage. It pulses while Play2Gether has
          something happening on a tab the participant has hidden. */}
      {docked && !open && (
        <aside className="hidden sm:flex w-10 shrink-0 flex-col border-l border-white/10 bg-zinc-950">
          <button
            onClick={() => openPanel(p2g.active ? "p2g" : undefined)}
            title="Open panel"
            className="flex flex-col items-center gap-3 py-4 text-zinc-300 hover:bg-white/5 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {p2g.active && (
              <Music2 className={`w-4 h-4 ${p2g.attention ? "text-rose-400 animate-pulse" : "text-teal-400"}`} />
            )}
          </button>
        </aside>
      )}

      {/* Toggle tab — always visible, including over JoinSetup. Docked, it is
          the phone-only way in (the strip above covers sm+). */}
      {!open && (
        <button
          onClick={() => openPanel(docked && p2g.active ? "p2g" : undefined)}
          className={`${docked ? "sm:hidden " : ""}fixed right-0 top-1/2 -translate-y-1/2 z-[100001]
                     flex flex-col items-center justify-center gap-1
                     w-11 h-24 sm:w-8 sm:h-20 rounded-l-xl
                     bg-zinc-800/90 hover:bg-zinc-700 backdrop-blur-sm
                     border border-white/10 border-r-0
                     text-white transition-colors`}
          title="Open panel"
        >
          {/* Wider under `sm`: 32px is below any usable touch target, and this
              is the only way in to the React and Utils tabs now that Chat has
              its own button on the control bar. No unread badge here any more
              — that button carries it, where people are already looking. */}
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}

      {/* Side panel.
          Overlay (host): fixed over the right edge, as it always was.
          Docked (participant): a column in the stage row, so opening it
          resizes the stage instead of covering it — on phones a band under
          the stage. Docked, it stays MOUNTED while closed (just hidden): the
          Play2Gether tab inside owns the recorder and must not unmount. */}
      {(open || docked) && (
        <div className={docked
          ? `${open ? "flex" : "hidden"} shrink-0 flex-col min-h-0 w-full
             ${play?.wide && tab === "p2g" ? "sm:w-[26.25rem]" : "sm:w-80"}
             max-h-[50%] sm:max-h-none border-t sm:border-t-0 sm:border-l border-white/10 bg-zinc-950`
          : `ctrl-panel-in fixed right-0 top-0 h-full w-72 max-w-[85vw] z-[100000]
             flex flex-col pb-safe bg-zinc-900/96 backdrop-blur-xl
             border-l border-white/10 shadow-2xl`}>

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Controls</span>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-lg flex items-center justify-center
                         text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Tab nav */}
          <div className="flex border-b border-white/10 shrink-0">
            {TABS.map(({ id, label, icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative flex-1 flex items-center justify-center gap-1.5
                            py-2.5 text-xs font-semibold transition-colors
                            ${tab === id ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                {icon}
                {label}
                {id === "chat" && unreadChat > 0 && tab !== "chat" && (
                  <span className="absolute top-1 right-2 w-3.5 h-3.5 rounded-full bg-indigo-500
                                   text-[8px] font-bold flex items-center justify-center">
                    {unreadChat}
                  </span>
                )}
                {tab === id && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />
                )}
              </button>
            ))}
          </div>

          {/* ── CHAT TAB ── */}
          {tab === "chat" && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-1.5 text-[10px] text-zinc-500 shrink-0 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {totalOnline} online
              </div>
              <div className="flex-1 overflow-y-auto px-3 flex flex-col gap-2 pb-2 min-h-0
                              scrollbar-thin scrollbar-thumb-white/10">
                {chatMessages.length === 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2
                                  text-zinc-600 text-xs h-full">
                    <MessageSquare size={24} strokeWidth={1.5} />
                    No messages yet
                  </div>
                )}
                {chatMessages.map((m, i) => {
                  const isYou = m.from?.identity === localParticipant?.identity;
                  const name = m.from?.name || m.from?.identity || "?";
                  const hue = identityHue(m.from?.identity ?? "");
                  return (
                    <div key={i} className={`flex gap-2 items-end ${isYou ? "flex-row-reverse" : ""}`}>
                      <div
                        className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold text-white"
                        style={{ background: isYou ? "#6c63ff" : `hsl(${hue}, 55%, 42%)` }}
                      >
                        {getInitials(name)}
                      </div>
                      <div className={`flex flex-col gap-0.5 max-w-[170px] ${isYou ? "items-end" : "items-start"}`}>
                        <span className="text-[9px] text-zinc-500 px-1">{isYou ? "You" : name}</span>
                        <div className={`text-xs px-2.5 py-1.5 rounded-xl leading-relaxed break-words
                                        ${isYou
                                          ? "bg-indigo-600/30 border border-indigo-500/30 text-white"
                                          : "bg-white/5 border border-white/10 text-zinc-200"}`}>
                          {renderMessageText(m.message)}
                        </div>
                        <span className="text-[8px] text-zinc-600 px-1">{formatTime(m.timestamp)}</span>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              <div className="flex gap-2 p-2 border-t border-white/10 shrink-0">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                  placeholder="Write a message…"
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5
                             text-xs text-white placeholder-zinc-600
                             outline-none focus:border-indigo-500/50 transition-colors"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isSending}
                  className="w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500
                             disabled:opacity-30 disabled:cursor-not-allowed
                             flex items-center justify-center transition-colors shrink-0"
                >
                  {isSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                </button>
              </div>
            </div>
          )}

          {/* ── PLAY2GETHER TAB (docked only) ──
              Always rendered while docked, hidden unless selected: see the
              panel's own note — it must never unmount mid-session. */}
          {docked && play?.content && (
            <div className={tab === "p2g" && p2g.active
              ? "flex flex-col flex-1 min-h-0 overflow-y-auto"
              : "hidden"}>
              {play.content}
            </div>
          )}

          {/* ── NOTES TAB ── */}
          {tab === "notes" && <NotesTab />}

          {/* ── AUDIO TAB (host only; see TABS) ── */}
          {tab === "audio" && role === "host" && <AudioAnalysisTab />}

          {/* ── UTILS TAB ── */}
          {tab === "qr" && (
            <div className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto">

              {/* ── Section 1: Active feeds ── */}
              <div className="flex flex-col gap-2">
                <div>
                  <p className="text-xs font-semibold text-zinc-300">Active feeds</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">Your currently published video streams</p>
                </div>
                {localVideoTracks.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {localVideoTracks.map((t) => (
                      <div
                        key={t.publication.trackSid}
                        className="w-full rounded-xl overflow-hidden border border-white/10 bg-black"
                        style={{ aspectRatio: "16/9" }}
                      >
                        <VideoTrack trackRef={t} className="w-full h-full object-cover" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="w-full rounded-xl border border-white/10 bg-zinc-800/50
                                  flex items-center justify-center text-zinc-500 text-xs"
                       style={{ aspectRatio: "16/9" }}>
                    No active feeds
                  </div>
                )}
              </div>

              <div className="w-full border-t border-white/10" />

              {/* ── Section 2: Add a camera from another device ──
                  The publish-from-here buttons moved to the control bar, where
                  they sit next to camera and mic instead of two taps away. The
                  QR stays here as the other-device route, which is the only
                  route on iOS — Safari has no getDisplayMedia and will not
                  hold two cameras open at once. */}
              <div className="flex flex-col items-center gap-3">
                <div className="w-full">
                  <p className="text-xs font-semibold text-zinc-300">Use another device</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">
                    Scan with your phone to add a close-up of your instrument, or
                    to show a document or sheet music.
                  </p>
                </div>
                <div className="bg-white rounded-xl p-3 shadow-lg self-center">
                  {mobileUrl && <QRCodeSVG value={mobileUrl} size={148} />}
                </div>
                {mobileUrl && (
                  <a
                    href={mobileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-400 hover:text-indigo-300 underline"
                  >
                    Open on this device
                  </a>
                )}
              </div>

              <div className="w-full border-t border-white/10 mt-auto" />

              <button
                onClick={() => { window.location.href = "/"; }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                           rounded-xl bg-red-500/20 hover:bg-red-500/30
                           border border-red-500/40 text-red-400 hover:text-red-300
                           text-sm font-medium transition-colors"
              >
                <LogOut size={15} /> Sign Out
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
