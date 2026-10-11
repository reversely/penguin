// The shell's right panel (identity plan section 4). From 1100px it is a third pane the reader can
// hide; below 1100px it is a drawer opened from the page header. A page places its details in the
// panel with <DetailsPanel>, which portals them into the pane, so the page keeps its own state and
// the shell keeps the layout. The panel shows only while a page has placed details in it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icon.tsx";

/** The width from which the panel docks beside the centre pane; matches app.css. */
const DOCKED = "(min-width: 1100px)";

export interface Details {
  /** Whether the panel docks as a third pane rather than opening as a drawer. */
  readonly docked: boolean;
  /** Whether a page has placed details in the panel. */
  readonly present: boolean;
  /** Whether the panel is in view now. */
  readonly shown: boolean;
  readonly node: HTMLElement | null;
  readonly setNode: (node: HTMLElement | null) => void;
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
  readonly closeRef: RefObject<HTMLButtonElement | null>;
  open(): void;
  close(): void;
  register(): () => void;
}

const DetailsContext = createContext<Details | null>(null);
export const DetailsProvider = DetailsContext.Provider;

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/**
 * The panel's state, held by the shell. The docked pane starts open and the drawer starts closed.
 * A drawer left open closes when `place` changes, so opening another page never covers it.
 */
export function useDetails(place: string): Details {
  const docked = useMediaQuery(DOCKED);
  const [hidden, setHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [placed, setPlaced] = useState(0);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [lastPlace, setLastPlace] = useState(place);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Opening moves focus into the panel and closing returns it to the toggle (Emil touch rule 7).
  const focusNext = useRef<RefObject<HTMLButtonElement | null> | undefined>(undefined);

  if (lastPlace !== place) {
    setLastPlace(place);
    setDrawerOpen(false);
  }
  const present = placed > 0;
  const shown = present && (docked ? !hidden : drawerOpen);

  useEffect(() => {
    focusNext.current?.current?.focus();
    focusNext.current = undefined;
  }, [shown]);

  // Escape closes the drawer wherever focus sits, including the body after a click on its text.
  const covering = shown && !docked;
  useEffect(() => {
    if (!covering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      focusNext.current = toggleRef;
      setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [covering]);

  const open = useCallback(() => {
    focusNext.current = closeRef;
    if (docked) setHidden(false);
    else setDrawerOpen(true);
  }, [docked]);
  const close = useCallback(() => {
    focusNext.current = toggleRef;
    if (docked) setHidden(true);
    else setDrawerOpen(false);
  }, [docked]);
  const register = useCallback(() => {
    setPlaced((count) => count + 1);
    return () => setPlaced((count) => count - 1);
  }, []);

  return { docked, present, shown, node, setNode, toggleRef, closeRef, open, close, register };
}

/** The pane itself, rendered once by the shell. */
export function DetailsPane({ details }: { details: Details }) {
  const drawer = !details.docked;
  return (
    <>
      {drawer && details.present ? (
        <div className="details-scrim" data-open={details.shown || undefined} aria-hidden="true" onClick={details.close} />
      ) : null}
      <aside
        id="details"
        className="details-pane"
        aria-labelledby="details-heading"
        role={drawer ? "dialog" : undefined}
        aria-modal={drawer ? true : undefined}
        hidden={!details.present}
        data-open={details.shown || undefined}
        inert={!details.shown}
      >
        <div className="details-head">
          <h2 id="details-heading">Details</h2>
          <button
            ref={details.closeRef}
            type="button"
            className="icon-button"
            aria-label={drawer ? "Close details" : "Hide details"}
            onClick={details.close}
          >
            <Icon name={drawer ? "close" : "collapse-panel"} />
          </button>
        </div>
        <div ref={details.setNode} className="details-body" />
      </aside>
    </>
  );
}

/**
 * A page's details, shown in the shell's right panel. A page renders it empty while its data loads,
 * so the docked column holds its place and the centre pane does not reflow when the details arrive.
 */
export function DetailsPanel({ children }: { children?: ReactNode }) {
  const details = useContext(DetailsContext);
  const register = details?.register;
  useLayoutEffect(() => register?.(), [register]);
  const content = <div className="issue-side">{children}</div>;
  if (details === null) return content;
  return details.node === null ? null : createPortal(content, details.node);
}

/** The page header's control that opens the panel; hidden while the docked panel is in view. */
export function DetailsToggle() {
  const details = useContext(DetailsContext);
  if (details === null) return null;
  return (
    <button
      ref={details.toggleRef}
      type="button"
      className="button details-toggle"
      aria-controls="details"
      aria-expanded={details.shown}
      hidden={details.docked && details.shown}
      onClick={details.shown ? details.close : details.open}
    >
      Details
    </button>
  );
}
