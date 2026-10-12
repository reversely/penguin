// A native <details> whose body is rendered only while it is open, so a page with dozens of closed
// parts or files keeps them out of the document until a reader opens one.

import { useState, type ReactNode } from "react";

import { Icon } from "./icon.tsx";

interface Props {
  readonly className: string;
  readonly summary: ReactNode;
  readonly initiallyOpen?: boolean;
  readonly children: ReactNode;
}

export function Disclosure({ className, summary, initiallyOpen = false, children }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
