// Whose review counts on an issue. PRD section 5 counts a review on a fix from the owner of the fix's
// scope, the owner whose failing test the fix resolves, or either owner's delegate. Both scopes are
// labelled on a fix sub-issue: Penguin labels it with the failing test's scope when it opens it and
// adds the changing scope's label when it sends the fix upstream. So the owners whose review counts
// are the owners of the issue's labelled scopes, and their delegates (PRD section 7,
// `Owner.delegate_owner_id`). A review from anyone else is kept on the issue as a review that does not
// count toward approval (PRD section 14).

import type { Author } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

/** The label prefix that ties an issue to a scope: `scope:<scope id>`. */
export const SCOPE_LABEL_PREFIX = "scope:";

/** Each owner's delegate, by owner id: who reviews in the owner's absence. */
export type Delegates = ReadonlyMap<string, string>;

const NO_DELEGATES: Delegates = new Map();

export type ReviewRight =
  | {
      readonly allowed: true;
      readonly owner: string;
      /** The labelled scopes whose owners the review stands for. */
      readonly scopes: readonly string[];
      /**
       * The owners whose approval the review stands for: the reviewer, when they own a labelled scope,
       * and each labelled scope's owner who names the reviewer as delegate. Sorted.
       */
      readonly countsFor: readonly string[];
    }
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
 * The owners whose review an issue labelled `labels` needs: the owner of each labelled scope in the
 * map, sorted, without duplicates. A label naming a scope missing from the map names no owner.
 */
export function reviewOwners(labels: Iterable<string>, scopeMap: ScopeMap): string[] {
  const owners = new Set<string>();
  for (const id of labelledScopes(labels)) {
    const owner = scopeMap.scopes.get(id)?.ownerId;
    if (owner !== undefined) owners.add(owner);
  }
  return [...owners].sort();
}

/**
 * Decide whether a review by `reviewer` counts on an issue labelled `labels`. A review counts only
 * from a person who owns a labelled scope or is the delegate of such a scope's owner. Identities and
 * Penguin hold no review right, because the PRD grants it to owners. A label naming a scope missing
 * from the map grants nothing.
 */
export function reviewRight(
  reviewer: Author,
  labels: Iterable<string>,
  scopeMap: ScopeMap,
  delegates: Delegates = NO_DELEGATES,
): ReviewRight {
  if (!("person" in reviewer)) {
    const who = "identity" in reviewer ? `identity ${reviewer.identity}` : "Penguin";
    return { allowed: false, message: `${who} cannot review; only the owner of a labelled scope or a delegate can` };
  }
  const person = reviewer.person;
  const scopes = labelledScopes(labels);
  const standsFor = (owner: string): boolean => owner === person || delegates.get(owner) === person;
  const held = scopes.filter((id) => {
    const owner = scopeMap.scopes.get(id)?.ownerId;
    return owner !== undefined && standsFor(owner);
  });
  if (held.length > 0) {
    const countsFor = [...new Set(held.map((id) => scopeMap.scopes.get(id)?.ownerId as string))].sort();
    return { allowed: true, owner: person, scopes: held, countsFor };
  }
  const listed = scopes.length === 0 ? "the issue has no scope labels" : `labelled scopes: ${scopes.join(", ")}`;
  return {
    allowed: false,
    message: `${person} owns no scope labelled on this issue and is no delegate of their owners (${listed})`,
  };
}
