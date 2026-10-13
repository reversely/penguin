// Avatars (identity plan section 3). An identity shows its uploaded image, or else a crop of Penguin's
// logo in its owner's hue (penguin-face.ts). A person shows a round initial and never the logo, so a
// reader tells people from agents at a glance. The vendor of a session never changes the avatar.

import { createContext, useContext } from "react";

import { initial } from "./board-view.ts";
import { FACE_VIEWBOX, LOGO_PATH, penguinFace } from "./penguin-face.ts";
import { personHue, type PersonHue } from "./person-hue.ts";

/** 24px in cards and bylines, 32px in rows, 56px in the identity header. */
export type AvatarSize = "card" | "row" | "header";

interface FaceProps {
  readonly handle: string;
  readonly size: AvatarSize;
  /** The person whose hue the avatar takes, when it differs from the handle's owner half. */
  readonly owner?: string | undefined;
}

/**
 * An identity's logo crop as an inline SVG. The `.penguin-face` rule clips it to a circle in CSS, so
 * the avatars on a page share no SVG id.
 */
export function PenguinFace({ handle, size, owner }: FaceProps) {
  const { hue, ground, figure } = penguinFace(handle, useContext(PersonHues), owner);
  return (
    <svg className={`avatar avatar-${size} penguin-face person-${hue}`} viewBox={FACE_VIEWBOX} focusable="false" aria-hidden="true">
      <rect className={ground} x="110" y="10" width="780" height="780" />
      <path className={figure} d={LOGO_PATH} fillRule="evenodd" />
    </svg>
  );
}

interface IdentityAvatarProps extends FaceProps {
  readonly image: string | null;
}

/** An identity's avatar: its upload when it has one, else its logo crop. */
export function IdentityAvatar({ handle, image, size, owner }: IdentityAvatarProps) {
  // The handle beside the avatar says who it is, so the image itself carries no text.
  return image === null ? (
    <PenguinFace handle={handle} size={size} owner={owner} />
  ) : (
    <img className={`avatar avatar-${size} avatar-image`} src={image} alt="" />
  );
}

// The team's person hues (assignPersonHues in person-hue.ts), which the shell derives from the team
// map's people, so every badge, square, box and agent avatar shows a person in one hue on every page.
// Until the team is read, and for anyone outside it, a person shows the hue their id hashes to.
const PersonHues = createContext<ReadonlyMap<string, PersonHue>>(new Map());
export const PersonHuesProvider = PersonHues.Provider;

/** A person's hue in the team's assignment. */
export function usePersonHue(id: string): PersonHue {
  return personHue(id, useContext(PersonHues));
}

/** A person's avatar: the initial of their id in a round badge filled with their hue. */
export function PersonAvatar({ id, size }: { id: string; size: AvatarSize }) {
  const hue = usePersonHue(id);
  return (
    <span className={`avatar avatar-${size} avatar-initial person-${hue}`} aria-hidden="true">
      {initial(id)}
    </span>
  );
}
