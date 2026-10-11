// An identity's character (identity plan section 3): a flat body shape in one of eight hues with two
// eyes in one of three poses, derived from the identity's handle alone. Nothing is stored per
// identity, so a new or duplicated identity gets its own character on first render and keeps it on
// every page and device. Pure, so the derivation is tested without a browser
// (test/character.test.ts).
//
// The hue values live in app.css as --char-<hue> tokens, which `.char-<hue>` rules apply, because
// the Content Security Policy allows no inline style. Each sits at OKLCH L 0.62, the lightest value
// at which every hue reaches 3:1 against every field in both themes.

export const SHAPES = ["circle", "egg", "drop", "triangle", "square", "hexagon", "capsule", "cloud"] as const;
export const HUES = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export const POSES = ["left", "centre", "right"] as const;

export type Shape = (typeof SHAPES)[number];
export type Hue = (typeof HUES)[number];
export type Pose = (typeof POSES)[number];

export interface Character {
  readonly shape: Shape;
  readonly hue: Hue;
  readonly pose: Pose;
}

const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as an unsigned integer. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The character for an identity handle such as "@jun/reports". */
export function characterFor(handle: string): Character {
  const hash = fnv1a(handle);
  return {
    hue: HUES[hash % HUES.length]!,
    shape: SHAPES[(hash >>> 8) % SHAPES.length]!,
    pose: POSES[(hash >>> 16) % POSES.length]!,
  };
}

/**
 * The hues a person takes, in hue order (their --person-<hue> tokens are in app.css). They keep away
 * from the status colours by hue: failure sits at OKLCH hue 27 to 30 and attention and warning at 64
 * to 83, and the person hues run from 130 to 354, so the nearest status colour is 0.137 away in
 * OKLab (pink to the dark failure red). Neighbours are 0.099 or more apart, where #71's green and
 * teal, which two squares side by side could not tell apart, were 0.061.
 */
export const PERSON_HUES = ["lime", "jade", "sky", "blue", "violet", "purple", "magenta", "pink"] as const;

export type PersonHue = (typeof PERSON_HUES)[number];

/** The hue an owner id hashes to, before any other owner is considered. */
function hashedHue(ownerId: string): number {
  return fnv1a(ownerId) % PERSON_HUES.length;
}

/**
 * Each owner's hue across a team, derived with nothing stored. The ids are taken in sorted order, so
 * the list's arrival order never matters. Each takes the hue its id hashes to, or, when an earlier id
 * holds that hue, the next free one round the palette. A team no larger than the palette never shares
 * a hue, and there a new owner whose hashed hue is free leaves every other owner's hue as it was.
 * Past the palette's size the hues repeat: each id takes the next hue held by the fewest owners.
 */
export function assignPersonHues(ownerIds: Iterable<string>): ReadonlyMap<string, PersonHue> {
  const ids = [...new Set(ownerIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const held = PERSON_HUES.map(() => 0);
  const hues = new Map<string, PersonHue>();
  for (const id of ids) {
    const fewest = Math.min(...held);
    let at = hashedHue(id);
    while (held[at] !== fewest) at = (at + 1) % PERSON_HUES.length;
    held[at]! += 1;
    hues.set(id, PERSON_HUES[at]!);
  }
  return hues;
}

/**
 * A person's hue from the team's assignment. An owner outside it, such as one seen only on an issue,
 * takes the hue their id hashes to: it may match a team member's, but it moves no one else's.
 */
export function personHue(ownerId: string, assigned: ReadonlyMap<string, PersonHue>): PersonHue {
  return assigned.get(ownerId) ?? PERSON_HUES[hashedHue(ownerId)]!;
}

/** A body outline in a 40 by 40 box, the point the pair of eyes centres on, and how far of a full
    pose shift the eyes take, so they stay inside a body that narrows towards the top. */
interface Body {
  readonly path: string;
  readonly eyesX: number;
  readonly eyesY: number;
  readonly reach: number;
}

// The eight shapes measured in Grok Bot's agent list. The triangle and hexagon are regular polygons
// with each corner replaced by a circular arc (radius 5 and 4). Eyes sit about 38 percent down a
// round body, lower on a triangle or drop, whose mass sits low.
export const BODIES: Readonly<Record<Shape, Body>> = {
  circle: { path: "M20 4a16 16 0 1 1 0 32a16 16 0 1 1 0-32Z", eyesX: 20, eyesY: 17, reach: 1 },
  egg: { path: "M20 3C28.5 3 34 12.5 34 22C34 31 28 37 20 37C12 37 6 31 6 22C6 12.5 11.5 3 20 3Z", eyesX: 20, eyesY: 18, reach: 1 },
  drop: {
    path: "M18.4 4.6C19.3 3.8 20.7 3.8 21.6 4.6C26.5 9 34 16.5 34 23a14 14 0 0 1-28 0C6 16.5 13.5 9 18.4 4.6Z",
    eyesX: 20,
    eyesY: 23,
    reach: 1,
  },
  triangle: {
    path: "M15.66 11.56A5 5 0 0 1 24.34 11.56L33.2 27.01A5 5 0 0 1 28.87 34.5L11.13 34.5A5 5 0 0 1 6.8 27.01Z",
    eyesX: 20,
    eyesY: 26,
    reach: 0.4,
  },
  square: {
    path: "M10.5 4h19a6.5 6.5 0 0 1 6.5 6.5v19a6.5 6.5 0 0 1-6.5 6.5h-19A6.5 6.5 0 0 1 4 29.5v-19A6.5 6.5 0 0 1 10.5 4Z",
    eyesX: 20,
    eyesY: 17,
    reach: 1,
  },
  hexagon: {
    path: "M18 3.15A4 4 0 0 1 22 3.15L33.59 9.85A4 4 0 0 1 35.59 13.31L35.59 26.69A4 4 0 0 1 33.59 30.15L22 36.85A4 4 0 0 1 18 36.85L6.41 30.15A4 4 0 0 1 4.41 26.69L4.41 13.31A4 4 0 0 1 6.41 9.85Z",
    eyesX: 20,
    eyesY: 18,
    reach: 1,
  },
  capsule: { path: "M14 9h12a11 11 0 0 1 0 22H14a11 11 0 0 1 0-22Z", eyesX: 20, eyesY: 19, reach: 1 },
  cloud: {
    path: "M11 33A6.5 6.5 0 0 1 7.6 21A7 7 0 0 1 14 11.5A8 8 0 0 1 28 11A7 7 0 0 1 33 21.5A6 6 0 0 1 30 33Z",
    eyesX: 20,
    eyesY: 21,
    reach: 1,
  },
};

/** Eye ovals: 9 percent of the body's width and 22 percent of its height, 30 percent apart. */
export const EYE = { rx: 1.8, ry: 4.4, gap: 10 } as const;

/** How far each pose moves the pair of eyes sideways and tilts each eye, in degrees. */
export const POSE_OFFSET: Readonly<Record<Pose, { readonly dx: number; readonly tilt: number }>> = {
  left: { dx: -3.5, tilt: -12 },
  centre: { dx: 0, tilt: 0 },
  right: { dx: 3.5, tilt: 12 },
};

/** Both eye centres and their rotation for a body and a pose. */
export function eyes(shape: Shape, pose: Pose): readonly { readonly cx: number; readonly cy: number; readonly tilt: number }[] {
  const body = BODIES[shape];
  const { dx, tilt } = POSE_OFFSET[pose];
  const centre = body.eyesX + dx * body.reach;
  return [
    { cx: centre - EYE.gap / 2, cy: body.eyesY, tilt },
    { cx: centre + EYE.gap / 2, cy: body.eyesY, tilt },
  ];
}
