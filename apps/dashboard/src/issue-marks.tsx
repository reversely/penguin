// Marks the issue page and the board share: the signal tag, Penguin's mark and its six-state
// indicator, and the byline that names an operation's author beside their avatar (identity plan
// sections 3 and 5). An identity's name links to its agent card. Every value renders as React text.

import type { ReactNode } from "react";

import { IdentityAvatar, PersonAvatar, type AvatarSize } from "./avatar.tsx";
import { EYE } from "./character.ts";
import { authorKind, authorName, SIGNAL_LABEL, type PenguinState, type Signal } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
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

/** Penguin's own mark in the character style: a flat body with flippers, a two-lobed face, the
    characters' eye ovals and a beak, with no outline. */
export function PenguinMark({ className = "penguin-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" focusable="false" aria-hidden="true">
      <path className="penguin-body" d={PENGUIN_BODY} />
      <path className="penguin-face" d={PENGUIN_FACE} />
      <ellipse className="penguin-eye" cx="16" cy="16" rx={EYE.rx} ry={EYE.ry} />
      <ellipse className="penguin-eye" cx="24" cy="16" rx={EYE.rx} ry={EYE.ry} />
      <path className="penguin-beak" d={PENGUIN_BEAK} />
    </svg>
  );
}

const PENGUIN_BODY =
  "M20 2.5C28 2.5 33 10 33.5 19C37 24 37.5 30 35 33C32 37 26 38 20 38C14 38 8 37 5 33C2.5 30 3 24 6.5 19C7 10 12 2.5 20 2.5Z";
const PENGUIN_FACE =
  "M20 13.2C21.3 9.8 24 8.6 26.4 9.6C29.6 11 30.2 15.6 28.4 19.6C30 24 29.6 30 26.6 33.4C24.8 35.4 22.4 36 20 36C17.6 36 15.2 35.4 13.4 33.4C10.4 30 10 24 11.6 19.6C9.8 15.6 10.4 11 13.6 9.6C16 8.6 18.7 9.8 20 13.2Z";
const PENGUIN_BEAK = "M18.2 22.2h3.6a.6.6 0 0 1 .5.9l-1.8 2.6a.6.6 0 0 1-1 0l-1.8-2.6a.6.6 0 0 1 .5-.9Z";

/**
 * What a byline needs beyond the author: each known identity's id and upload, and the router, so an
 * identity's name links to its agent card. An identity not yet read shows its character and no link.
 */
export interface Authors {
  readonly known: KnownIdentities;
  readonly navigate: (path: string) => void;
}

/** An author's avatar: Penguin's mark, an identity's upload or character, or a person's initial. */
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
