// Which issues the live feed has announced as changed, so each page reads its data again only when an
// issue it shows changed. Pure, so it is tested without a socket (test/live-reads.test.ts).

export type LiveStatus = "connecting" | "live" | "offline";

export interface LiveChanges {
  /** Counts the bursts of live messages that changed the index since the page loaded. */
  readonly revision: number;
  /** For each issue changed since the page loaded, the revision of its latest change. */
  readonly changed: ReadonlyMap<string, number>;
}

export interface LiveRevisions extends LiveChanges {
  /** Counts bursts with an inbox change that changed no issue, such as an item marked read. */
  readonly inboxRevision: number;
  /** Counts bursts in which identities were created, edited or duplicated. */
  readonly identitiesRevision: number;
  /** Counts bursts with a change to any feature, merge plan, part decision or review. */
  readonly featuresRevision: number;
}

/** One live message, as the dashboard reads it. */
export type LiveMessage =
  | { readonly kind: "index"; readonly issues: readonly string[] }
  | { readonly kind: "inbox" }
  | { readonly kind: "identities" }
  | { readonly kind: "features" };

export const FIRST_REVISIONS: LiveRevisions = { revision: 0, changed: new Map(), inboxRevision: 0, identitiesRevision: 0, featuresRevision: 0 };

/** The revisions after one burst of `messages`: each kind present moves its revision by one. */
export function applyMessages(previous: LiveRevisions, messages: readonly LiveMessage[]): LiveRevisions {
  const has = (kind: LiveMessage["kind"]) => messages.some((message) => message.kind === kind);
  const step = (count: number, kind: LiveMessage["kind"]) => (has(kind) ? count + 1 : count);
  const revision = step(previous.revision, "index");
  let changed = previous.changed;
  if (revision !== previous.revision) {
    const next = new Map(previous.changed);
    for (const message of messages) if (message.kind === "index") for (const issue of message.issues) next.set(issue, revision);
    changed = next;
  }
  return {
    revision,
    changed,
    inboxRevision: step(previous.inboxRevision, "inbox"),
    identitiesRevision: step(previous.identitiesRevision, "identities"),
    featuresRevision: step(previous.featuresRevision, "features"),
  };
}

/** The revision of the latest change to any of `issues`, or 0 when none changed. */
export function latestChange(changes: LiveChanges, issues: readonly string[]): number {
  return Math.max(0, ...issues.map((issue) => changes.changed.get(issue) ?? 0));
}
