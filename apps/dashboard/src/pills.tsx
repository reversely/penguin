// Pills: a person in their hue, a scope in its owner's hue, and a status in one fixed colour per tone.
// The person hues are the team's (assignPersonHues in character.ts); the tones reuse the signal hues.

import type { ReactNode } from "react";

import { PersonAvatar, usePersonHue } from "./avatar.tsx";
import { linkHandler } from "./links.ts";
import type { Tone } from "./page-view.ts";
import { personPath } from "./routes.ts";

/** A person as a pill in their hue, linking to their view when `navigate` is given. */
export function PersonPill({ id, navigate }: { readonly id: string; readonly navigate?: (path: string) => void }) {
  const hue = usePersonHue(id);
  const body = (
    <>
      <PersonAvatar id={id} size="card" />
      {id}
    </>
  );
  if (navigate === undefined) return <span className={`pill pill-person person-${hue}`}>{body}</span>;
  const path = personPath(id);
  return (
    <a className={`pill pill-person person-${hue}`} href={path} onClick={linkHandler(navigate, path)}>
      {body}
    </a>
  );
}

/** A scope as a pill in its owner's hue; a scope with no known owner takes the neutral pill. */
export function ScopePill({ name, owner }: { readonly name: string; readonly owner: string | null }) {
  const hue = usePersonHue(owner ?? "");
  return <span className={owner === null ? "pill" : `pill pill-scope person-${hue}`}>{name}</span>;
}

/** A status as a pill in its tone's fixed colour. */
export function TonePill({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`pill pill-tone-${tone}`}>{children}</span>;
}
