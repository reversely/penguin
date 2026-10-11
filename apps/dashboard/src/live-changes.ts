// Which issues the live feed has announced as changed, so each page reads its data again only when an
// issue it shows changed. Pure, so it is tested without a socket (test/issue-view.test.ts).

export type LiveStatus = "connecting" | "live" | "offline";

export interface LiveChanges {
  /** Counts index changes since the page loaded. */
  readonly revision: number;
  /** For each issue changed since the page loaded, the revision of its latest change. */
  readonly changed: ReadonlyMap<string, number>;
}

/** The changes after one index-changed message naming `issues`. */
export function recordChange(previous: LiveChanges, issues: readonly string[]): LiveChanges {
  const revision = previous.revision + 1;
  const changed = new Map(previous.changed);
  for (const issue of issues) changed.set(issue, revision);
  return { revision, changed };
}

/** The revision of the latest change to any of `issues`, or 0 when none changed. */
export function latestChange(changes: LiveChanges, issues: readonly string[]): number {
  return Math.max(0, ...issues.map((issue) => changes.changed.get(issue) ?? 0));
}
