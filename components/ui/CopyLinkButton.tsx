"use client";

import { useState } from "react";

/**
 * Copy a URL to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` only exists on HTTPS and localhost. This app is
 * routinely run over plain HTTP on the LAN (`npm run startdev`, the host on one
 * machine and participants on another), where the API is simply absent — not
 * failing, undefined — so a button that only used it would do nothing at all on
 * exactly the setup where someone is trying to send a link to the next room.
 * The textarea + execCommand path is deprecated and still the only thing that
 * works there.
 */
export default function CopyLinkButton({
  url,
  label = "🔗 Copy link",
  title,
}: {
  url: string;
  label?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        // Off-screen rather than hidden: `display:none` is not selectable, so
        // execCommand("copy") silently copies nothing.
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      className="btn"
      type="button"
      onClick={copy}
      title={title ?? url}
      aria-live="polite"
    >
      {state === "ok" ? "✓ Copied" : state === "fail" ? "⚠️ Copy failed" : label}
    </button>
  );
}
