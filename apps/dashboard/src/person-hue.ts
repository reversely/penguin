// Each person's hue (identity plan section 3), derived from owner ids alone. Nothing is stored per
// person, so every page and device shows a person, their badge and their agents' avatars in one hue.
// Pure, so the derivation is tested without a browser (test/penguin-face.test.ts).
//
// The hue values live in app.css as --person-<hue> tokens, which `.person-<hue>` rules apply, because
// the Content Security Policy allows no inline style.

const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of `text`, as an unsigned integer. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
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
