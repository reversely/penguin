// The shell's sidebar list slot (identity plan section 4): the space under the navigation that holds
// the route's list from 760px. The shell owns the slot element and hands it down; a page puts its
// list there with <SidebarList>, so the inbox and the identities list fill it the same way and the
// slot holds one list at a time. Below 760px the sidebar is the phone header and the slot is hidden,
// so SidebarList renders nothing and the page shows its list in the centre instead.

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "./details-pane.tsx";

/** The width from which the sidebar shows its list; matches the shell's breakpoint in app.css. */
export const SIDEBAR_LIST = "(min-width: 760px)";

const SlotContext = createContext<HTMLElement | null>(null);
export const SidebarSlotProvider = SlotContext.Provider;

/** Renders its children in the sidebar's list slot from 760px, and nothing below it. */
export function SidebarList({ children }: { readonly children: ReactNode }) {
  const slot = useContext(SlotContext);
  const shown = useMediaQuery(SIDEBAR_LIST);
  return shown && slot !== null ? createPortal(children, slot) : null;
}
