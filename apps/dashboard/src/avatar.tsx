// Avatars (identity plan section 3). An identity shows its uploaded image, or else the character its
// handle derives. A person shows a round initial and never a character, so a reader tells people
// from agents at a glance. The vendor of a session never changes the character.

import { initial } from "./board-view.ts";
import { BODIES, characterFor, EYE, eyes, personHue } from "./character.ts";

/** 24px in cards and bylines, 32px in rows, 56px in the identity header. */
export type AvatarSize = "card" | "row" | "header";

interface CharacterProps {
  readonly handle: string;
  readonly size: AvatarSize;
  /** Set where the character stands alone, with no visible handle beside it. */
  readonly label?: string;
}

/** An identity's character as an inline SVG; colour comes from a `.char-<hue>` class. */
export function Character({ handle, size, label }: CharacterProps) {
  const { shape, hue, pose } = characterFor(handle);
  const a11y = label === undefined ? ({ "aria-hidden": true } as const) : ({ role: "img", "aria-label": label } as const);
  return (
    <svg className={`avatar avatar-${size} character char-${hue}`} viewBox="0 0 40 40" focusable="false" {...a11y}>
      <path className="character-body" d={BODIES[shape].path} />
      {eyes(shape, pose).map(({ cx, cy, tilt }) => (
        <ellipse
          key={cx}
          className="character-eye"
          cx={cx}
          cy={cy}
          rx={EYE.rx}
          ry={EYE.ry}
          transform={tilt === 0 ? undefined : `rotate(${tilt} ${cx} ${cy})`}
        />
      ))}
    </svg>
  );
}

/** An identity's avatar: its upload when it has one, else its character. */
export function IdentityAvatar({ handle, image, size }: { handle: string; image: string | null; size: AvatarSize }) {
  // The handle beside the avatar says who it is, so the image itself carries no text.
  return image === null ? (
    <Character handle={handle} size={size} />
  ) : (
    <img className={`avatar avatar-${size} avatar-image`} src={image} alt="" />
  );
}

/** A person's avatar: the initial of their id in a round badge filled with their hue. */
export function PersonAvatar({ id, size }: { id: string; size: AvatarSize }) {
  return (
    <span className={`avatar avatar-${size} avatar-initial person-${personHue(id)}`} aria-hidden="true">
      {initial(id)}
    </span>
  );
}
