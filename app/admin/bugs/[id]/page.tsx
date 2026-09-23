import "server-only";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { requireAdmin } from "../../../dbbackend/rbac";

const REPORTS_FILE = join(process.cwd(), "server", "data1", "bugs", "reports.jsonl");

function loadReport(id: string): Record<string, unknown> | null {
  if (!existsSync(REPORTS_FILE)) return null;
  const lines = readFileSync(REPORTS_FILE, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.id === id) return r;
    } catch { /* skip */ }
  }
  return null;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <details className="group border border-white/10 rounded-xl overflow-hidden">
      <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none bg-white/5 hover:bg-white/8 transition-colors">
        <span className="font-medium text-sm">{title}</span>
        {count !== undefined && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-zinc-300">{count}</span>
        )}
      </summary>
      <div className="px-4 py-3 text-sm overflow-x-auto">
        {children}
      </div>
    </details>
  );
}

function Pre({ data }: { data: unknown }) {
  return (
    <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default async function BugDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const r = loadReport(id);
  if (!r) notFound();

  const muteEvents = (r.muteEvents as unknown[]) ?? [];
  const lkAudio = (r.lkAudio as unknown[]) ?? [];
  const stageState = (r.stageState as unknown[]) ?? [];
  const consoleErrors = (r.consoleErrors as unknown[]) ?? [];
  const muteState = r.muteState as Record<string, boolean> | undefined;
  const networkInfo = r.networkInfo as Record<string, unknown> | null | undefined;
  const roomSnapshot = r.roomSnapshot as Record<string, unknown> | null | undefined;
  const remoteParticipants = (r.remoteParticipants as any[]) ?? [];
  const webrtcStats = r.webrtcStats as any;
  const permissions = r.permissions as Record<string, string | null> | undefined;
  const mediaDevices = (r.mediaDevices as any[]) ?? [];
  const activeInputDevices = r.activeInputDevices as {
    microphone: { deviceId: string | null; label: string | null; isMuted: boolean | null; constraints: any } | null;
    camera: { deviceId: string | null; label: string | null; isMuted: boolean | null; constraints: any } | null;
  } | undefined;
  const docHidden = r.docHidden as boolean | null | undefined;
  const memory = r.memory as { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null | undefined;

  const audioProblems = (lkAudio as any[]).filter(t => !t.isSubscribed || t.isMuted);

  // Compute packet loss ratios up front — used in the badge color logic
  // and the rendered cells. 5% is the typical threshold where audio starts
  // to feel choppy; >10% is "you can't have a conversation".
  const lossPct = (lost: number | undefined, recvOrSent: number | undefined) => {
    const total = (lost ?? 0) + (recvOrSent ?? 0);
    return total > 0 ? ((lost ?? 0) / total) * 100 : 0;
  };
  const fmtPct = (n: number) => n.toFixed(2) + "%";
  const fmtBytes = (b: number | undefined) => {
    if (!b) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  };

  return (
    // Admin pages assume dark theme (text-white, border-white/10, …) but the
    // global body uses bg-zinc-50/text-zinc-900 — without this wrapper every
    // `text-white` element ends up invisible (white-on-white). Wrap the whole
    // page in a dark canvas so the existing classes work as designed.
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
    <div className="p-6 space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <header className="flex items-center gap-3">
        <Link href="/admin/bugs" className="btn">← Reports</Link>
        <div>
          <h1 className="text-xl font-semibold">Report detail</h1>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">{r.id as string}</p>
        </div>
      </header>

      {/* Summary card */}
      <div className="border border-white/10 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div className="text-zinc-400">Received</div>
          <div>{fmt(r.receivedAt as string)}</div>
          <div className="text-zinc-400">Client timestamp</div>
          <div>{fmt(r.timestamp as string)}</div>
          <div className="text-zinc-400">Participant</div>
          <div className="font-mono text-xs break-all">{r.participantId as string}</div>
          <div className="text-zinc-400">Room</div>
          <div className="font-mono text-xs break-all">{r.roomName as string}</div>
          {r.sessionDuration !== undefined && (
            <>
              <div className="text-zinc-400">Session duration</div>
              <div>{Math.floor((r.sessionDuration as number) / 60)}m {(r.sessionDuration as number) % 60}s</div>
            </>
          )}
          {r.userAgent && (
            <>
              <div className="text-zinc-400">User agent</div>
              <div className="text-xs text-zinc-300 break-all">{r.userAgent as string}</div>
            </>
          )}
          {/* Tab-hidden flag in the summary card: a "no oigo nada" report
            * with hidden=true is almost certainly the browser suspending
            * audio on background tab, not a bug in the app. */}
          {docHidden !== undefined && docHidden !== null && (
            <>
              <div className="text-zinc-400">Tab visible at submit</div>
              <div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${docHidden ? "bg-amber-900/60 text-amber-300" : "bg-emerald-900/60 text-emerald-300"}`}>
                  {docHidden ? "hidden (backgrounded)" : "visible"}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-white/10 pt-3">
          <div className="text-xs text-zinc-400 mb-1">Description</div>
          {typeof r.description === "string" && r.description.trim() ? (
            // `whitespace-pre-wrap` so newlines the user typed in the dialog
            // survive — the previous `<p>` collapsed them and a multi-line
            // bug ended up looking like a one-liner.
            <p className="text-white font-semibold text-base leading-relaxed whitespace-pre-wrap break-words">
              {(r.description as string).trim()}
            </p>
          ) : (
            <p className="text-zinc-500 italic text-sm">(empty)</p>
          )}
        </div>
      </div>

      {/* Audio diagnosis */}
      {lkAudio.length > 0 && (
        <Section title="Audio tracks (LiveKit)" count={lkAudio.length}>
          {audioProblems.length > 0 && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-xs">
              {audioProblems.length} track{audioProblems.length !== 1 ? "s" : ""} with issues:
              {(audioProblems as any[]).map((t, i) => (
                <span key={i} className="ml-2">
                  <strong>{t.participant}</strong>
                  {!t.isSubscribed ? " — not subscribed" : t.isMuted ? " — publisher muted" : ""}
                </span>
              ))}
            </div>
          )}
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-white/10">
                <th className="py-1 pr-3">Participant</th>
                <th className="py-1 pr-3">Track SID</th>
                <th className="py-1 pr-3">Subscribed</th>
                <th className="py-1 pr-3">Pub. muted</th>
                <th className="py-1 pr-3">Can hear</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {(lkAudio as any[]).map((t, i) => (
                <tr key={i} className={`border-b border-white/5 ${!t.isSubscribed || t.isMuted ? "text-red-400" : "text-green-400"}`}>
                  <td className="py-1 pr-3">{t.participant ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-zinc-400">{t.trackSid}</td>
                  <td className="py-1 pr-3">{t.isSubscribed ? "✓" : "✗"}</td>
                  <td className="py-1 pr-3">{t.isMuted ? "✗" : "✓"}</td>
                  <td className="py-1 pr-3">{t.canHear !== undefined ? (t.canHear ? "✓" : "✗") : (t.isSubscribed && !t.isMuted ? "✓" : "✗")}</td>
                  <td className="py-1">{t.subscriptionStatus ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* WebRTC stats — the single best signal for "was the connection
        * actually bad?". Color the packet loss cells: green <1%, amber 1–5%,
        * red >5% (5% is where audio gets choppy). */}
      {webrtcStats && (webrtcStats.publisher || webrtcStats.subscriber) && (
        <Section title="WebRTC stats (peer connection)">
          {(["publisher", "subscriber"] as const).map((side) => {
            const s = webrtcStats[side];
            if (!s) return null;
            const rtt = s.transport?.currentRoundTripTime;
            const rttMs = typeof rtt === "number" ? Math.round(rtt * 1000) : null;
            const rttColor = rttMs == null ? "" : rttMs > 300 ? "text-red-400" : rttMs > 150 ? "text-amber-400" : "text-emerald-400";
            // outbound packets get "lost from sender's POV" via outboundAudio's
            // packetsLost (Chrome reports it; some versions don't). Inbound is
            // always available and what we usually want.
            const inAudioLossPct = lossPct(s.inboundAudio?.packetsLost, s.inboundAudio?.packetsReceived);
            const inVideoLossPct = lossPct(s.inboundVideo?.packetsLost, s.inboundVideo?.packetsReceived);
            const lossColor = (p: number) => p === 0 ? "text-zinc-300" : p < 1 ? "text-emerald-400" : p < 5 ? "text-amber-400" : "text-red-400";
            return (
              <div key={side} className="mb-3 last:mb-0">
                <div className="text-xs text-zinc-400 font-semibold mb-1 uppercase tracking-wide">{side}</div>
                <div className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
                  <div className="text-zinc-400">RTT</div>
                  <div className={rttColor + " font-mono col-span-2"}>{rttMs != null ? `${rttMs} ms` : "—"}</div>

                  <div className="text-zinc-400">Bytes sent / received</div>
                  <div className="font-mono col-span-2 text-zinc-300">
                    {fmtBytes(s.transport?.bytesSent)} / {fmtBytes(s.transport?.bytesReceived)}
                  </div>

                  {s.outboundAudio && (
                    <>
                      <div className="text-zinc-400">Outbound audio</div>
                      <div className="font-mono col-span-2 text-zinc-300">{s.outboundAudio.packetsSent ?? "—"} pkts · {fmtBytes(s.outboundAudio.bytesSent)}</div>
                      {/* Capture-side level. ≤ 1e-3 sustained while the
                        * track is unmuted = wrong device / silent input
                        * (e.g. virtual mic, OS gain at 0). Red badge
                        * makes "user was publishing silence" jump out. */}
                      {typeof s.outboundAudio.audioLevel === "number" && (() => {
                        const lvl = s.outboundAudio.audioLevel as number;
                        const silent = lvl < 1e-3;
                        const color = silent ? "text-red-400" : lvl < 0.01 ? "text-amber-400" : "text-emerald-400";
                        return (
                          <>
                            <div className="text-zinc-400">Capture level</div>
                            <div className={`font-mono col-span-2 ${color}`}>
                              {lvl.toExponential(2)}
                              {silent && <span className="ml-2 px-1.5 py-0.5 rounded bg-red-900/40 text-[10px] uppercase tracking-wider">silent — wrong mic?</span>}
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                  {s.inboundAudio && (
                    <>
                      <div className="text-zinc-400">Inbound audio</div>
                      <div className={`font-mono col-span-2 ${lossColor(inAudioLossPct)}`}>
                        {s.inboundAudio.packetsReceived ?? "—"} recv · {s.inboundAudio.packetsLost ?? 0} lost ({fmtPct(inAudioLossPct)}) · jitter {(s.inboundAudio.jitter ?? 0).toFixed(3)}s
                      </div>
                    </>
                  )}
                  {s.outboundVideo && (
                    <>
                      <div className="text-zinc-400">Outbound video</div>
                      <div className="font-mono col-span-2 text-zinc-300">
                        {s.outboundVideo.framesEncoded ?? "—"} frames · {s.outboundVideo.framesPerSecond ?? "—"} fps
                        {s.outboundVideo.qualityLimitationReason && s.outboundVideo.qualityLimitationReason !== "none" && (
                          <span className="ml-2 text-amber-400">limited: {s.outboundVideo.qualityLimitationReason}</span>
                        )}
                      </div>
                    </>
                  )}
                  {s.inboundVideo && (
                    <>
                      <div className="text-zinc-400">Inbound video</div>
                      <div className={`font-mono col-span-2 ${lossColor(inVideoLossPct)}`}>
                        {s.inboundVideo.framesDecoded ?? "—"} frames · {s.inboundVideo.framesPerSecond ?? "—"} fps · {s.inboundVideo.packetsLost ?? 0} pkts lost ({fmtPct(inVideoLossPct)})
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {/* Active capture devices — answers "what mic/cam was the page
        * ACTUALLY using when this report was submitted?". A red badge
        * flags virtual / known-silent devices (Microsoft Teams Audio,
        * Loopback, BlackHole, etc.) — the typical "I was very quiet"
        * cause where packets flow but they carry silence. Mic constraints
        * (AGC/AEC/NS) are shown because AGC clamping is the other common
        * cause of "very quiet" reports. */}
      {activeInputDevices && (activeInputDevices.microphone || activeInputDevices.camera) && (
        <Section title="Active capture devices">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {(["microphone", "camera"] as const).map((kind) => {
              const dev = activeInputDevices[kind];
              if (!dev) {
                return (
                  <div key={kind}>
                    <div className="text-zinc-400 uppercase tracking-wider text-[10px] mb-1">{kind}</div>
                    <div className="text-zinc-500 italic">not published</div>
                  </div>
                );
              }
              // Virtual / suspicious device sniffer. Matches the common
              // patterns: Teams/Zoom/Discord virtual driver, OS loopback
              // tools (Loopback, BlackHole, Soundflower). Not exhaustive
              // — false negatives are fine; false positives are annoying.
              const label = dev.label ?? "";
              const suspicious = /microsoft teams|zoom|discord|loopback|blackhole|soundflower|virtual/i.test(label);
              return (
                <div key={kind}>
                  <div className="text-zinc-400 uppercase tracking-wider text-[10px] mb-1">{kind}</div>
                  <div className="font-mono text-zinc-100 break-all">
                    {label || <span className="text-zinc-500 italic">label unknown</span>}
                    {suspicious && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 text-[10px] uppercase tracking-wider">
                        virtual — likely silent
                      </span>
                    )}
                  </div>
                  <div className="text-zinc-500 text-[10px] font-mono mt-0.5">id: {dev.deviceId ?? "—"}</div>
                  {dev.constraints && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.entries(dev.constraints).map(([k, v]) => {
                        if (v === undefined || v === null) return null;
                        // AGC ON + "very quiet" reports = classic clamping
                        // pattern. Flag in amber so it's easy to scan.
                        const flag = (kind === "microphone" && k === "autoGainControl" && v === true) ? "text-amber-400" : "text-zinc-300";
                        return (
                          <span key={k} className={`px-1.5 py-0.5 rounded bg-zinc-800 font-mono text-[10px] ${flag}`}>
                            {k}={String(v)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Permissions + media devices side by side. "no me oyen" is most
        * commonly a denied mic permission that the user has long forgotten. */}
      {(permissions || mediaDevices.length > 0) && (
        <Section title="Permissions & devices">
          {permissions && (
            <div className="flex flex-wrap gap-3 mb-3">
              {Object.entries(permissions).map(([k, v]) => {
                const color = v === "granted" ? "bg-emerald-900/60 text-emerald-300"
                  : v === "denied" ? "bg-red-900/60 text-red-300"
                  : v === "prompt" ? "bg-amber-900/60 text-amber-300"
                  : "bg-zinc-700 text-zinc-300";
                return (
                  <div key={k} className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-400">{k}</span>
                    <span className={`px-2 py-0.5 rounded-full ${color}`}>{v ?? "unknown"}</span>
                  </div>
                );
              })}
            </div>
          )}
          {mediaDevices.length > 0 && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Devices ({mediaDevices.length})</div>
              <ul className="text-xs space-y-0.5">
                {mediaDevices.map((d, i) => (
                  <li key={i} className="font-mono text-zinc-300">
                    <span className="text-zinc-500 mr-2">[{d.kind}]</span>
                    {d.label || <span className="text-zinc-500 italic">no label (permission needed)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {/* Remote participants — each remote's name, quality, and what they
        * publish from this client's perspective. Answers "why couldn't A
        * hear B": you see B's audio pub state as A's client saw it. */}
      {remoteParticipants.length > 0 && (
        <Section title="Remote participants" count={remoteParticipants.length}>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-white/10">
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Identity</th>
                <th className="py-1 pr-3">Quality</th>
                <th className="py-1 pr-3">Speaking</th>
                <th className="py-1 pr-3">Audio pubs</th>
                <th className="py-1 pr-3" title="What this client was actually playing back from each remote audio stream when the report was submitted. Near-zero level while pub is subscribed/unmuted = the remote is publishing silence (e.g. wrong mic device).">Inbound level</th>
                <th className="py-1">Video pubs</th>
              </tr>
            </thead>
            <tbody>
              {remoteParticipants.map((p, i) => {
                const audioBad = p.audioPubs?.some((a: any) => !a.isSubscribed || a.isMuted);
                return (
                  <tr key={i} className={`border-b border-white/5 ${audioBad ? "text-red-400" : "text-zinc-300"}`}>
                    <td className="py-1 pr-3">{p.name ?? "—"}</td>
                    <td className="py-1 pr-3 font-mono text-[10px]">{p.identity?.slice(0, 14)}…</td>
                    <td className="py-1 pr-3">{p.connectionQuality ?? "—"}</td>
                    <td className="py-1 pr-3">{p.isSpeaking ? "✓" : "—"}</td>
                    <td className="py-1 pr-3">
                      {(p.audioPubs ?? []).map((a: any, j: number) => (
                        <span key={j} className={`inline-block mr-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${a.isSubscribed && !a.isMuted ? "bg-emerald-900/40 text-emerald-400" : "bg-red-900/40 text-red-400"}`}>
                          {!a.isSubscribed ? "unsub" : a.isMuted ? "muted" : "ok"}
                        </span>
                      ))}
                      {(!p.audioPubs || p.audioPubs.length === 0) && <span className="text-zinc-500">none</span>}
                    </td>
                    {/* Per-pub inbound playback level. Tells "is this remote
                      * sending real audio to me right now?". Red badge when
                      * the pub is up and the level is ≈ 0 (= remote is
                      * publishing silence — wrong mic, AGC clamped, etc). */}
                    <td className="py-1 pr-3">
                      {(p.audioPubs ?? []).map((a: any, j: number) => {
                        if (typeof a.inboundAudioLevel !== "number") {
                          return <span key={j} className="inline-block mr-1 text-zinc-600 text-[10px]">—</span>;
                        }
                        const lvl = a.inboundAudioLevel as number;
                        const silent = lvl < 1e-3 && a.isSubscribed && !a.isMuted;
                        const color = silent
                          ? "text-red-400"
                          : lvl < 0.01 ? "text-amber-400" : "text-emerald-400";
                        return (
                          <span
                            key={j}
                            className={`inline-block mr-1 font-mono text-[10px] ${color}`}
                            title={`audioLevel=${lvl.toExponential(2)} · packets recv=${a.inboundPacketsReceived ?? "?"} lost=${a.inboundPacketsLost ?? 0}`}
                          >
                            {lvl.toExponential(1)}{silent ? " ⚠" : ""}
                          </span>
                        );
                      })}
                    </td>
                    <td className="py-1">
                      {(p.videoPubs ?? []).map((v: any, j: number) => (
                        <span key={j} className={`inline-block mr-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${v.isSubscribed && !v.isMuted ? "bg-emerald-900/40 text-emerald-400" : "bg-zinc-700 text-zinc-400"}`}>
                          {v.source ?? "video"}{!v.isSubscribed ? " unsub" : v.isMuted ? " muted" : ""}
                        </span>
                      ))}
                      {(!p.videoPubs || p.videoPubs.length === 0) && <span className="text-zinc-500">none</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {/* JS heap usage — Chrome-only. Anticipates OOM tab crashes on long
        * sessions or low-end devices. Bar is red when > 75% of the limit. */}
      {memory && (
        <Section title="Memory (JS heap)">
          {(() => {
            const used = memory.usedJSHeapSize, limit = memory.jsHeapSizeLimit;
            const pct = limit > 0 ? (used / limit) * 100 : 0;
            const barColor = pct > 75 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-emerald-500";
            return (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between text-zinc-400">
                  <span>used / limit</span>
                  <span className="font-mono text-zinc-300">{fmtBytes(used)} / {fmtBytes(limit)} ({pct.toFixed(1)}%)</span>
                </div>
                <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <div className="text-zinc-500">total heap: {fmtBytes(memory.totalJSHeapSize)}</div>
              </div>
            );
          })()}
        </Section>
      )}

      {/* Network + room snapshot */}
      {(networkInfo || roomSnapshot) && (
        <Section title="Connection info">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            {networkInfo && (
              <>
                <div className="text-zinc-400 col-span-2 font-semibold mb-1">Network (navigator.connection)</div>
                {Object.entries(networkInfo).map(([k, v]) => (
                  <><div key={`k-${k}`} className="text-zinc-400">{k}</div><div key={`v-${k}`}>{String(v)}</div></>
                ))}
              </>
            )}
            {roomSnapshot && (
              <>
                <div className="text-zinc-400 col-span-2 font-semibold mt-2 mb-1">LiveKit room snapshot</div>
                {Object.entries(roomSnapshot).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => (
                  <><div key={`k-${k}`} className="text-zinc-400">{k}</div><div key={`v-${k}`}>{String(v)}</div></>
                ))}
                {Array.isArray(roomSnapshot.localTracks) && roomSnapshot.localTracks.length > 0 && (
                  <div className="col-span-2 mt-1">
                    <div className="text-zinc-400 mb-1">Local tracks</div>
                    <Pre data={roomSnapshot.localTracks} />
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}

      {/* Console errors */}
      {consoleErrors.length > 0 && (
        <Section title="Console errors" count={consoleErrors.length}>
          <div className="space-y-2">
            {(consoleErrors as any[]).map((e, i) => (
              <div key={i} className="p-2 bg-red-900/20 border border-red-500/20 rounded text-xs">
                <div className="text-zinc-400">{e.iso ?? e.t}</div>
                <div className="text-red-300 mt-0.5">{e.message}</div>
                {e.source && <div className="text-zinc-500 mt-0.5">{e.source}</div>}
                {e.stack && (
                  <pre className="text-zinc-500 text-[10px] mt-1 whitespace-pre-wrap break-all">{e.stack}</pre>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Stage state */}
      {stageState.length > 0 && (
        <Section title="Stage state (entities vs tracks)" count={stageState.length}>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-white/10">
                <th className="py-1 pr-3">Entity ID</th>
                <th className="py-1 pr-3">Participant</th>
                <th className="py-1 pr-3">Visible</th>
                <th className="py-1 pr-3">Muted</th>
                <th className="py-1 pr-3">Track found</th>
                <th className="py-1">On stage</th>
              </tr>
            </thead>
            <tbody>
              {(stageState as any[]).map((s, i) => (
                <tr key={i} className={`border-b border-white/5 ${!s.trackFound ? "text-red-400" : "text-zinc-300"}`}>
                  <td className="py-1 pr-3 font-mono text-zinc-400 text-[10px]">{s.id?.slice(0, 16)}…</td>
                  <td className="py-1 pr-3 font-mono text-[10px]">{s.participantId?.slice(0, 12)}…</td>
                  <td className="py-1 pr-3">{s.visible ? "✓" : "✗"}</td>
                  <td className="py-1 pr-3">{s.muted ? "✗" : "✓"}</td>
                  <td className="py-1 pr-3">{s.trackFound ? "✓" : "✗"}</td>
                  <td className="py-1">{s.onStage ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Mute state */}
      {muteState && Object.keys(muteState).length > 0 && (
        <Section title="Mute state (subscription cache)" count={Object.keys(muteState).length}>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-white/10">
                <th className="py-1 pr-3">Participant ID</th>
                <th className="py-1">Subscribed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(muteState).map(([pid, sub]) => (
                <tr key={pid} className={`border-b border-white/5 ${!sub ? "text-red-400" : "text-green-400"}`}>
                  <td className="py-1 pr-3 font-mono text-xs">{pid}</td>
                  <td className="py-1">{sub ? "✓ subscribed" : "✗ blocked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Mute event log */}
      <Section title="Audio event log" count={muteEvents.length}>
        {muteEvents.length === 0 ? (
          <p className="text-zinc-500 text-xs">No events recorded.</p>
        ) : (
          <div className="space-y-0.5 max-h-96 overflow-y-auto">
            {(muteEvents as any[]).map((e, i) => (
              <div key={i} className="flex gap-3 text-xs py-0.5 border-b border-white/5">
                <span className="text-zinc-500 font-mono flex-shrink-0 w-24">{e.iso}</span>
                <span className="text-amber-300 flex-shrink-0 w-44">{e.event}</span>
                <span className="text-zinc-400 break-all">
                  {Object.entries(e.data ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Raw JSON */}
      <Section title="Raw JSON">
        <Pre data={r} />
      </Section>
    </div>
    </div>
  );
}
