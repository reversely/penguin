// Marks the issue page and the board share: the signal tag, Penguin's mark and its six-state
// indicator, and the byline that names an operation's author beside their avatar (identity plan
// sections 3 and 5). An identity's name links to its agent card. Every value renders as React text.

import type { ReactNode } from "react";

import { IdentityAvatar, PersonAvatar, type AvatarSize } from "./avatar.tsx";
import { authorKind, authorName, SIGNAL_LABEL, type PenguinState, type Signal } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { LOGO_PATH, LOGO_VIEWBOX } from "./penguin-face.ts";
import type { KnownIdentities } from "./use-identity-handles.ts";

export function SignalTag({ signal, children }: { signal: Signal; children?: string }) {
  return <span className={`tag signal signal-${signal}`}>{children ?? SIGNAL_LABEL[signal]}</span>;
}

export function PenguinIndicator({ state }: { state: PenguinState }) {
  const slug = state.replaceAll(" ", "-");
  return (
    <span className={`penguin penguin-${slug}`} role="status">
      <PenguinMark />
      <span>Penguin {state}</span>
    </span>
  );
}

/** Penguin's own mark: the full logo in ink, its belly and eye showing the surface beneath. */
export function PenguinMark({ className = "penguin-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox={LOGO_VIEWBOX} focusable="false" aria-hidden="true">
      <path className="penguin-body" d={LOGO_PATH} fillRule="evenodd" />
    </svg>
  );
}

/**
 * What a byline needs beyond the author: each known identity's id and upload, and the router, so an
 * identity's name links to its agent card. An identity not yet read shows its logo crop and no link.
 */
export interface Authors {
  readonly known: KnownIdentities;
  readonly navigate: (path: string) => void;
}

/** An author's avatar: Penguin's mark, an identity's upload or logo crop, or a person's initial. */
export function AuthorAvatar({ segment, authors, size = "card" }: { segment: string | null; authors: Authors; size?: AvatarSize }) {
  const name = authorName(segment);
  switch (authorKind(segment)) {
    case "penguin":
      return <PenguinMark className={`avatar avatar-${size} penguin-avatar`} />;
    case "identity":
      return <IdentityAvatar handle={name} image={authors.known.get(name)?.avatar ?? null} size={size} />;
    case "person":
      return <PersonAvatar id={name} size={size} />;
    case "unknown":
      // An operation whose author could not be read keeps the avatar's place with an empty ring.
      return <span className={`avatar avatar-${size} avatar-unknown`} aria-hidden="true" />;
  }
}

/** The agent card of an identity, as the identities page routes it. */
export function identityCardPath(id: string): string {
  return `/identities?identity=${encodeURIComponent(id)}`;
}

/** An author's name: a known identity's handle links to its agent card; anyone else is plain text. */
export function AuthorName({ segment, authors, className }: { segment: string | null; authors: Authors; className: string }) {
  const name = authorName(segment);
  const id = authorKind(segment) === "identity" ? authors.known.get(name)?.id : undefined;
  if (id === undefined) return <span className={className}>{name}</span>;
  const path = identityCardPath(id);
  return (
    <a className={`${className} author-link`} href={path} onClick={linkHandler(authors.navigate, path)}>
      {name}
    </a>
  );
}

/** An author's avatar at 24px and their name: a handle for an identity, an id for a person. */
export function Byline({ segment, authors, children }: { segment: string | null; authors: Authors; children?: ReactNode }) {
  return (
    <div className="byline">
      <AuthorAvatar segment={segment} authors={authors} />
      <AuthorName segment={segment} authors={authors} className="byline-name" />
      {children}
    </div>
  );
}
