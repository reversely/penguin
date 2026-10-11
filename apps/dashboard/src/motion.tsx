// The dashboard's motion helpers (identity plan section 2.7). The motion itself lives in app.css on
// the tokens; these only say when it may run. Rows that arrive after a live change take a
// data-arrival index, which app.css staggers by --stagger. A list whose items change order slides
// each item from its old place on --ease-in-out. A theme switch holds every transition for a frame.
// Nothing moves on first paint, on a route change or on a theme switch. app.css gives every
// animation a prefers-reduced-motion path with none.

import { Component, createRef, useEffect, useState, type ReactNode } from "react";

import { arrivalsAfter, NO_ARRIVALS, type Arrivals } from "./arrivals.ts";

/**
 * How long a row keeps its data-arrival: longer than --dur-enter plus five --stagger steps. Clearing
 * it then stops a row replaying its arrival when it is shown again, as after a hidden view returns.
 */
const ARRIVAL_SETTLES_MS = 1000;

/** A row's data-arrival value, undefined for a row that did not arrive with the latest change. */
export type Arrival = (key: string) => string | undefined;

/** A list's arrivals, by row key; `keys` is undefined while the list loads. */
export function useArrivals(keys: readonly string[] | undefined, scope = ""): Arrival {
  const [state, setState] = useState<Arrivals | undefined>(undefined);
  let current = state;
  if (keys !== undefined) {
    const next = arrivalsAfter(state, keys, scope);
    // Taken during render, as React's "adjusting state when a prop changes" pattern does, so the
    // rows paint with their index on the frame they first show.
    if (next !== state) {
      setState(next);
      current = next;
    }
  }
  const pending = current !== undefined && current.arrived.size > 0;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setState((value) => (value === undefined ? value : { ...value, arrived: NO_ARRIVALS })), ARRIVAL_SETTLES_MS);
    return () => clearTimeout(timer);
  }, [pending, current?.signature]);
  return (key) => {
    const index = current?.arrived.get(key);
    return index === undefined ? undefined : String(index);
  };
}

interface ReorderProps {
  readonly className: string;
  /** The items' keys in order; each item is an <li data-key>. A change slides the items that moved. */
  readonly order: string;
  readonly children: ReactNode;
}

/**
 * A list whose items slide from their old places when their order changes (FLIP). The places are
 * read just before React updates the list. Each moved item then starts at its old place and
 * transitions to its new one on the `translate` transition app.css gives `.reorder > [data-key]`.
 * With reduced motion that transition is none, so items take their new places at once. React offers
 * the read before an update only to a class component, through getSnapshotBeforeUpdate.
 */
export class Reorder extends Component<ReorderProps> {
  private readonly list = createRef<HTMLUListElement>();

  private items(): HTMLElement[] {
    return [...(this.list.current?.children ?? [])].filter((item): item is HTMLElement => item instanceof HTMLElement && item.dataset.key !== undefined);
  }

  override getSnapshotBeforeUpdate(previous: ReorderProps): ReadonlyMap<string, DOMRect> | null {
    if (previous.order === this.props.order) return null;
    return new Map(this.items().map((item) => [item.dataset.key!, item.getBoundingClientRect()]));
  }

  override componentDidUpdate(_props: ReorderProps, _state: unknown, before: ReadonlyMap<string, DOMRect> | null): void {
    if (before === null) return;
    const items = this.items();
    // A slide still running from an earlier reorder is cancelled first, so each new place is read
    // without its offset.
    for (const item of items) item.style.transition = "none";
    const moved = items.flatMap((item) => {
      const was = before.get(item.dataset.key!);
      if (was === undefined) return [];
      const now = item.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      return dx === 0 && dy === 0 ? [] : [{ item, dx, dy }];
    });
    // Each moved item jumps back to its old place with its transition held, then, after one forced
    // layout, is released to transition to its new place.
    for (const { item, dx, dy } of moved) item.style.translate = `${dx}px ${dy}px`;
    void this.list.current?.offsetWidth;
    for (const item of items) {
      item.style.transition = "";
      item.style.translate = "";
    }
  }

  override render() {
    return (
      <ul ref={this.list} className={`reorder ${this.props.className}`}>
        {this.props.children}
      </ul>
    );
  }
}

/**
 * Holds every transition for the frame the colour scheme changes in, so a theme switch repaints at
 * once rather than fading each control's colours (Emil animations rule 11). app.css matches
 * `data-theme-switch`.
 */
export function holdTransitionsOnThemeSwitch(): void {
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", () => {
    const root = document.documentElement;
    root.dataset.themeSwitch = "";
    requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitch));
  });
}
