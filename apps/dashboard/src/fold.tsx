// Folds: the feature page's collapsible nodes and sections. A page keeps which folds are open in one
// set, so a link anywhere on it (a summary line, a stage's job, a branch) can open a fold and the
// folds above it, then scroll to it. A fold's body renders only while it is open, so a page with dozens
// of closed parts and files keeps them out of the document.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { Icon } from "./icon.tsx";

interface Folds {
  readonly isOpen: (id: string) => boolean;
  readonly setOpen: (id: string, open: boolean) => void;
}

const FoldContext = createContext<Folds>({ isOpen: () => false, setOpen: () => undefined });

/** The page's open folds and `reveal`, which opens a fold with the folds that hold it and scrolls to it. */
export function useFolds(initial: () => Iterable<string>, parents: (id: string) => readonly string[]) {
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set(initial()));
  const setOpen = useCallback((id: string, value: boolean) => {
    setOpenSet((previous) => {
      if (previous.has(id) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const reveal = useCallback(
    (id: string) => {
      setOpenSet((previous) => new Set([...previous, ...parents(id), id]));
      requestAnimationFrame(() => {
        const element = document.getElementById(id);
        element?.scrollIntoView({ block: "start" });
        element?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
      });
    },
    [parents],
  );
  const value = useMemo<Folds>(() => ({ isOpen: (id) => open.has(id), setOpen }), [open, setOpen]);
  return { value, reveal };
}

export const FoldProvider = FoldContext.Provider;

interface FoldProps {
  readonly id: string;
  readonly className: string;
  readonly summary: ReactNode;
  readonly children: ReactNode;
}

export function Fold({ id, className, summary, children }: FoldProps) {
  const folds = useContext(FoldContext);
  const open = folds.isOpen(id);
  return (
    <details id={id} className={`fold ${className}`} open={open} onToggle={(event) => folds.setOpen(id, event.currentTarget.open)}>
      <summary>
        <span className="disclosure-mark">
          <Icon name="chevron" />
        </span>
        {summary}
      </summary>
      {open ? children : null}
    </details>
  );
}
