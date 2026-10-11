// The signed-in owner, the live connection tag and Sign out. The sidebar shows them at its foot;
// below 760px they sit behind the phone header's Account button, which opens them as a menu. One
// markup serves both layouts, so app.css switches between them and the keyboard order holds.

import { useEffect, useRef, useState, type FocusEvent } from "react";

import type { Session } from "./api.ts";
import { PersonAvatar } from "./avatar.tsx";
import type { LiveStatus } from "./live-changes.ts";

export function AccountMenu({ session, status }: { session: Session; status: LiveStatus }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  // A press outside the menu closes it. Safari gives a pressed button no focus, so a press is read
  // from the pointer, not from where focus goes. Escape closes it wherever focus sits.
  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Tabbing out of the menu closes it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && next !== null && !event.currentTarget.contains(next)) setOpen(false);
  };

  return (
    <div ref={menuRef} className="account-menu" onBlur={onBlur}>
      <button
        ref={toggleRef}
        type="button"
        className="account-toggle"
        aria-label="Account"
        aria-expanded={open}
        aria-controls="account"
        onClick={() => setOpen((value) => !value)}
      >
        <PersonAvatar id={session.owner} size="row" />
      </button>
      <div id="account" className="account" data-open={open || undefined}>
        <div className="account-owner">
          <PersonAvatar id={session.owner} size="card" />
          <span className="owner" title={`GitHub ${session.login}`}>
            {session.owner}
          </span>
          <LiveTag status={status} />
        </div>
        <form method="post" action="/auth/signout">
          <button ref={firstRef} type="submit" className="button sign-out">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

function LiveTag({ status }: { status: LiveStatus }) {
  return (
    <span className={`tag tag-${status}`} role="status">
      {status}
    </span>
  );
}
