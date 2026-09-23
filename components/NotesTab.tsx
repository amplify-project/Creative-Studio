"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomContext, useLocalParticipant, useChat } from "@livekit/components-react";
import { usePathname } from "next/navigation";
import {
  FileText, Image as ImageIcon, Music, Upload, Trash2,
  Check, X, Clock, Loader2, Share2,
} from "lucide-react";

// Server-side shape (kept in sync with app/api/notes/utils.ts)
type NoteFile = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  ext: string;
  uploaderId: string;
  uploaderName: string;
  uploaderRole: "host" | "participant";
  status: "approved" | "pending";
  uploadedAt: number;
  approvedAt: number | null;
};

const NOTES_TOPIC = "notes";
const ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav," +
  "application/pdf,image/png,image/jpeg,image/webp,audio/mpeg,audio/wav";

export default function NotesTab() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const { send: sendChat } = useChat();
  const pathname = usePathname();
  // Role comes from which page rendered the panel. The /host route is the
  // teacher; everything else is a participant. The server trusts this label.
  const isHost = !!pathname && pathname.startsWith("/host");

  const [sessionId, setSessionId] = useState("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setSessionId(params.get("sessionId") || "test");
  }, []);

  const [files, setFiles] = useState<NoteFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewerId = localParticipant?.identity ?? "";

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(
        `/api/notes?sessionId=${encodeURIComponent(sessionId)}&viewerId=${encodeURIComponent(viewerId)}`
      );
      const data = await res.json();
      if (Array.isArray(data.files)) setFiles(data.files);
    } catch (e: any) {
      setError(e?.message || "Failed to load files");
    }
  }, [sessionId, viewerId]);

  useEffect(() => { refetch(); }, [refetch]);

  // Sync: refetch whenever anyone in the room broadcasts a notes change.
  // Reliable delivery — we want missed broadcasts to still arrive.
  useEffect(() => {
    if (!room) return;
    const handler = (_p: Uint8Array, _q: unknown, _k: unknown, topic?: string) => {
      if (topic === NOTES_TOPIC) refetch();
    };
    room.on("dataReceived", handler);
    return () => { room.off("dataReceived", handler); };
  }, [room, refetch]);

  const broadcastChange = useCallback(() => {
    if (!room) return;
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "notes/changed" })),
        { reliable: true, topic: NOTES_TOPIC }
      );
    } catch { /* ignore — broadcast failures shouldn't block local UI */ }
  }, [room]);

  const onUpload = async (file: File) => {
    if (!sessionId) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      fd.append("file", file);
      fd.append("role", isHost ? "host" : "participant");
      const res = await fetch("/api/notes/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      await refetch();
      broadcastChange();
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const callHostEndpoint = async (
    path: string,
    init?: RequestInit
  ) => {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    if (res.ok) {
      await refetch();
      broadcastChange();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Action failed");
    }
  };

  const onApprove = (id: string) =>
    callHostEndpoint(`/api/notes/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });

  const onReject = (id: string) =>
    callHostEndpoint(`/api/notes/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });

  const onDelete = (id: string) => {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    callHostEndpoint(
      `/api/notes/${id}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" }
    );
  };

  const onShareInChat = async (file: NoteFile) => {
    // Absolute URL so the link works from any pasted-context (the chat
    // message becomes clickable via renderMessageText in the panel).
    const url = `${window.location.origin}/api/notes/${file.id}/download?sessionId=${encodeURIComponent(sessionId)}`;
    try {
      await sendChat(`📎 ${file.fileName} — ${url}`);
    } catch (e: any) {
      setError(e?.message || "Could not share in chat");
    }
  };

  const approved = files.filter((f) => f.status === "approved");
  const pending = files.filter((f) => f.status === "pending");
  // Participants only see THEIR OWN pending uploads — the server already
  // filters this way, but be defensive in case the API contract changes.
  const visiblePending = isHost ? pending : pending.filter((f) => f.uploaderId === viewerId);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Upload bar */}
      <div className="p-3 border-b border-white/10 shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                     text-white text-xs font-semibold transition-colors"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {uploading ? "Uploading…" : "Upload file"}
        </button>
        <div className="text-[10px] text-zinc-500 mt-1.5 text-center">
          PDF / image / audio · max 40 MB
          {!isHost && <span className="block text-amber-400/80">Host must approve</span>}
        </div>
        {error && (
          <div className="text-[11px] text-red-400 mt-1.5 text-center">{error}</div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3 min-h-0">
        {approved.length === 0 && visiblePending.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-zinc-600 text-xs h-full">
            <FileText size={24} strokeWidth={1.5} />
            No files yet
          </div>
        )}

        {approved.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider px-1">
              Shared ({approved.length})
            </div>
            {approved.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                sessionId={sessionId}
                actions={
                  <div className="flex gap-1">
                    <button
                      onClick={() => onShareInChat(f)}
                      title="Share in chat"
                      className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors"
                    >
                      <Share2 size={12} />
                    </button>
                    {isHost && (
                      <button
                        onClick={() => onDelete(f.id)}
                        title="Delete"
                        className="w-6 h-6 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                }
              />
            ))}
          </div>
        )}

        {visiblePending.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] text-amber-400/80 uppercase tracking-wider px-1">
              {isHost ? `Waiting for review (${visiblePending.length})` : "Your pending"}
            </div>
            {visiblePending.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                sessionId={sessionId}
                actions={
                  isHost ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => onApprove(f.id)}
                        title="Approve"
                        className="w-6 h-6 rounded flex items-center justify-center
                                   bg-green-600/20 text-green-400 hover:bg-green-600 hover:text-white transition-colors"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={() => onReject(f.id)}
                        title="Reject"
                        className="w-6 h-6 rounded flex items-center justify-center
                                   bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                      <Clock size={11} /> Waiting
                    </div>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  sessionId,
  actions,
}: {
  file: NoteFile;
  sessionId: string;
  actions: React.ReactNode;
}) {
  const Icon = file.mimeType.startsWith("image/")
    ? ImageIcon
    : file.mimeType.startsWith("audio/")
      ? Music
      : FileText;
  const previewUrl = `/api/notes/${file.id}/download?sessionId=${encodeURIComponent(sessionId)}`;
  const sizeKB = file.size / 1024;
  const sizeStr = sizeKB < 1024 ? `${sizeKB.toFixed(0)} KB` : `${(sizeKB / 1024).toFixed(1)} MB`;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">
      <Icon size={16} className="text-zinc-400 shrink-0" />
      <a
        href={previewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 min-w-0 flex flex-col"
        title={file.fileName}
      >
        <span className="text-xs text-white truncate">{file.fileName}</span>
        <span className="text-[10px] text-zinc-500 truncate">
          {file.uploaderName} · {sizeStr}
        </span>
      </a>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
