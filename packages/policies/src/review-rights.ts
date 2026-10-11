// Who may review an issue. PRD section 5 grants a review to the owner of the fix's scope, the owner
// whose failing test the fix resolves, or either owner's delegate. Phase 2 implements the first
// right only: the scopes of a fix are the scope labels on its issue.

import type { Author } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

/** The label prefix that ties an issue to a scope: `scope:<scope id>`. */
export const SCOPE_LABEL_PREFIX = "scope:";

export type ReviewRight =
  | { readonly allowed: true; readonly owner: string; readonly scopes: readonly string[] }
  | { readonly allowed: false; readonly message: string };

/** The scope ids named by an issue's `scope:<id>` labels, in label order, without duplicates. */
export function labelledScopes(labels: Iterable<string>): string[] {
  const scopes = new Set<string>();
  for (const label of labels) {
    if (label.startsWith(SCOPE_LABEL_PREFIX)) scopes.add(label.slice(SCOPE_LABEL_PREFIX.length));
  }
  return [...scopes];
}

/**
 * Decide whether `reviewer` may review an issue labelled `labels`. A review counts only from a
 * person who owns at least one scope labelled on the issue. Identities and Penguin hold no review
 * right, because the PRD grants it to owners. A label naming a scope missing from the map grants
 * nothing.
 */
export function reviewRight(reviewer: Author, labels: Iterable<string>, scopeMap: ScopeMap): ReviewRight {
  if (!("person" in reviewer)) {
    const who = "identity" in reviewer ? `identity ${reviewer.identity}` : "Penguin";
    return { allowed: false, message: `${who} cannot review; only the owner of a labelled scope can` };
  }
  const scopes = labelledScopes(labels);
  const owned = scopes.filter((id) => scopeMap.scopes.get(id)?.ownerId === reviewer.person);
  if (owned.length > 0) return { allowed: true, owner: reviewer.person, scopes: owned };
  const listed = scopes.length === 0 ? "the issue has no scope labels" : `labelled scopes: ${scopes.join(", ")}`;
  return { allowed: false, message: `${reviewer.person} owns no scope labelled on this issue (${listed})` };
}
