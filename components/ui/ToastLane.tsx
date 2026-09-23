"use client";

/**
 * A single shared column for every transient overlay on a session page.
 *
 * Before this, each stack positioned itself independently at `top-4` with its
 * own `right-*`: join/leave toasts, chat toasts and assistant suggestions.
 * On a desktop window they happened to miss each other; on a phone the
 * assistant stack is `max-w-[90vw]`, so it covered the other two outright.
 * Fixed vertical offsets don't fix that — the stacks have dynamic heights, so
 * any offset that clears two toasts is wrong for three.
 *
 * So the stacks stop positioning themselves. `ToastLaneProvider` owns one
 * fixed column and hands out the element; `ToastLane` portals its children
 * into it, and normal flex layout keeps them from overlapping whatever their
 * height. The lane knows nothing about chat, presence or the assistant — a
 * consumer only declares a relative `order`.
 */

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const LaneContext = createContext<HTMLElement | null>(null);

/**
 * `pushed` shifts the column clear of the full-width connection banners the
 * session pages render at `top-0`. The page owns both, so it is the right
 * place to know one is showing.
 */
export function ToastLaneProvider({
  pushed = false,
  children,
}: {
  pushed?: boolean;
  children: ReactNode;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <LaneContext.Provider value={el}>
      {children}
      {/* `items-end` right-aligns every toast whatever its own width, so a
          narrow presence toast and a full-width suggestion card still share
          one edge. `overflow-hidden` keeps a flood from running off-screen
          instead of pushing the page taller. */}
      <div
        ref={setEl}
        className={`fixed inset-x-0 top-0 z-[100002] flex flex-col items-end gap-2
                    px-4 pb-4 max-h-viewport overflow-hidden pointer-events-none
                    ${pushed ? "pt-14" : "pt-4"}
                    sm:left-auto sm:w-auto`}
      />
    </LaneContext.Provider>
  );
}

/**
 * Renders `children` into the page's lane. `order` is the stack's position in
 * the column relative to its siblings — lower is nearer the top.
 *
 * Without a provider it falls back to its own top-right column, so a page
 * that hasn't adopted the lane keeps working unchanged.
 */
export function ToastLane({
  order = 0,
  children,
}: {
  order?: number;
  children: ReactNode;
}) {
  const el = useContext(LaneContext);

  const stack = (
    <div style={{ order }} className="flex flex-col items-end gap-2 w-full">
      {children}
    </div>
  );

  if (!el) {
    return (
      <div className="fixed top-4 right-4 z-[100002] flex flex-col items-end gap-2 pointer-events-none">
        {stack}
      </div>
    );
  }
  return createPortal(stack, el);
}

/** Lane order for the three session stacks, in one place so they stay sorted. */
export const LANE_ORDER = {
  /** Actionable and short — stays nearest the top. */
  chat: 0,
  /** Informational, auto-dismissing. */
  presence: 1,
  /** Largest cards; pushed down so they never bury the other two. */
  assistant: 2,
} as const;
