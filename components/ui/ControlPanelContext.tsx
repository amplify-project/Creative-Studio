"use client";

/**
 * Shared open/close state for the side control panel.
 *
 * The panel used to own this itself, which was fine while it was the only
 * thing that could open it — its edge tab is a child of the panel. The bottom
 * control bar is a sibling, so it needs a way to say "open on Chat" that
 * doesn't involve reaching into another component's `useState`.
 *
 * `unreadChat` travels the other way for the same reason: the panel is what
 * counts unread messages, but the badge now belongs on the bar's chat button,
 * where someone looking at the video will actually see it.
 *
 * Without a provider the hook returns an inert value, so the panel keeps
 * working on a page that has not mounted one (the host still does).
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";

export type PanelTab = "chat" | "notes" | "audio" | "qr";

type ControlPanelValue = {
  open: boolean;
  tab: PanelTab;
  unreadChat: number;
  /** Open the panel, optionally on a specific tab. */
  openPanel: (tab?: PanelTab) => void;
  closePanel: () => void;
  setTab: (tab: PanelTab) => void;
  /** Full setter, updater form included — the panel counts incrementally. */
  setUnreadChat: Dispatch<SetStateAction<number>>;
};

const Ctx = createContext<ControlPanelValue | null>(null);

export function ControlPanelProvider({ children }: { children: ReactNode }) {
  const value = usePanelState();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The actual state. Used by the provider, and as the panel's own fallback. */
function usePanelState(): ControlPanelValue {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("chat");
  const [unreadChat, setUnreadChat] = useState(0);

  return useMemo<ControlPanelValue>(() => ({
    open,
    tab,
    unreadChat,
    openPanel: (next?: PanelTab) => {
      if (next) setTab(next);
      setOpen(true);
    },
    closePanel: () => setOpen(false),
    setTab,
    setUnreadChat,
  }), [open, tab, unreadChat]);
}

/**
 * `null` when there is no provider. Callers that only want to *drive* the
 * panel — the control bar — should hide their control in that case rather
 * than render a button that does nothing.
 */
export function useControlPanelOrNull(): ControlPanelValue | null {
  return useContext(Ctx);
}

/**
 * For the panel itself, which has to work either way. The local state is a
 * real fallback, not a stub: a page that forgets the provider gets a panel
 * that still opens from its own edge tab, just one the bar cannot drive.
 * Both hooks run unconditionally, so this is not a conditional-hook trap.
 */
export function useControlPanel(): ControlPanelValue {
  const ctx = useContext(Ctx);
  const local = usePanelState();
  return ctx ?? local;
}
