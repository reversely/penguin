// Which rows of a list arrive with motion (identity plan section 2.7): the rows a live change adds,
// never the rows of a first paint or of a route or filter change. Pure, so the rule is tested without
// a browser (test/motion.test.ts); motion.tsx holds it in a hook.

/** The last arrival index app.css staggers; later rows arrive with it. */
export const LAST_STAGGER = 5;

export interface Arrivals {
  /** The route or filter the list shows; a change is a new baseline. */
  readonly scope: string;
  /** The keys, in order, the arrivals were taken from. */
  readonly signature: string;
  readonly seen: ReadonlySet<string>;
  /** Each arrived key and its stagger index. */
  readonly arrived: ReadonlyMap<string, number>;
}

export const NO_ARRIVALS: ReadonlyMap<string, number> = new Map();

/**
 * The arrivals after a list shows `keys`: the keys it did not show before, in list order. The first
 * keys a list shows are its baseline and arrive with no motion. So are the keys after its scope
 * changes. Unchanged keys return `previous` itself.
 */
export function arrivalsAfter(previous: Arrivals | undefined, keys: readonly string[], scope: string): Arrivals {
  const signature = keys.join("\u0000");
  if (previous !== undefined && previous.scope === scope && previous.signature === signature) return previous;
  const seen = new Set(keys);
  if (previous === undefined || previous.scope !== scope) return { scope, signature, seen, arrived: NO_ARRIVALS };
  // Rows still rising from the change before keep their index, so their animation runs on unbroken.
  const arrived = new Map([...previous.arrived].filter(([key]) => seen.has(key)));
  let next = 0;
  for (const key of keys) {
    if (!previous.seen.has(key)) arrived.set(key, Math.min(next++, LAST_STAGGER));
  }
  return { scope, signature, seen, arrived };
}
