// What an agent identity may change. PRD section 5: a session "changes only the scopes and paths in
// its identity's charter", and a team identity "works only within the scopes of the owner who assigns
// it". Section 12 rejects an operation outside the charter.

import type { Operation } from "@penguin/protocol";
import { InvalidPathError, normalizeRepoPath, scopeForPath, type ScopeMap } from "@penguin/scope-map";

import { SCOPE_LABEL_PREFIX } from "./review-rights.ts";

/** The parts of an identity the charter check reads. */
export interface CharterIdentity {
  readonly handle: string;
  /** The one owner of a personal identity, or null for a team identity. */
  readonly ownerId: string | null;
  /** The owners a team identity serves; empty for a personal identity. */
  readonly teamOwners: readonly string[];
  /** Scope ids from the scope map. */
  readonly charterScopes: readonly string[];
  /** Normalized repository path prefixes, without a trailing slash. */
  readonly charterPaths: readonly string[];
}

export type CharterVerdict = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/** The scopes and paths an operation names. */
export interface OperationTargets {
  readonly scopes: readonly string[];
  readonly paths: readonly string[];
}

/**
 * The scopes and paths an issue operation names. Only a scope label (`scope:<id>`) added or removed
 * names a scope. No operation type carries a file path yet: the paths a linked commit changes are an
 * open question in #23, so `paths` stays empty until operations report them.
 */
export function operationTargets(operation: Pick<Operation, "type" | "payload">): OperationTargets {
  if (operation.type !== "add_label" && operation.type !== "remove_label") return { scopes: [], paths: [] };
  const label = operation.payload["label"];
  if (typeof label !== "string" || !label.startsWith(SCOPE_LABEL_PREFIX)) return { scopes: [], paths: [] };
  return { scopes: [label.slice(SCOPE_LABEL_PREFIX.length)], paths: [] };
}

/**
 * Decide whether `identity` may change `scopes` and `paths`. A personal identity may change the
 * scopes in its charter and any path inside them or under a charter path. A team identity has those
 * rights only within the scopes of `assigningOwner`, the owner who assigned it to the issue, and only
 * when that owner is one of the owners it serves. The rejection message names the charter.
 */
export function withinCharter(
  identity: CharterIdentity,
  assigningOwner: string | undefined,
  scopes: Iterable<string>,
  paths: Iterable<string>,
  scopeMap: ScopeMap,
): CharterVerdict {
  const team = identity.ownerId === null;
  const servesAssigner = assigningOwner !== undefined && identity.teamOwners.includes(assigningOwner);
  // A scope or path counts for a team identity only when the assigning owner owns it.
  const inAssignerScope = (scopeId: string | undefined): boolean =>
    !team || (servesAssigner && scopeId !== undefined && scopeMap.scopes.get(scopeId)?.driId === assigningOwner);
  const allowedScopes = new Set(identity.charterScopes.filter(inAssignerScope));

  const outside: string[] = [];
  for (const scope of new Set(scopes)) if (!allowedScopes.has(scope)) outside.push(`scope ${scope}`);
  for (const raw of new Set(paths)) {
    const path = normalizedOrUndefined(raw);
    const scopeId = path === undefined ? undefined : scopeForPath(scopeMap, path);
    const allowed =
      path !== undefined &&
      ((scopeId !== undefined && allowedScopes.has(scopeId)) ||
        (inAssignerScope(scopeId) && identity.charterPaths.some((prefix) => underPrefix(path, prefix))));
    if (!allowed) outside.push(`path ${raw}`);
  }
  if (outside.length === 0) return { allowed: true };

  const charter = `scopes: ${listed(identity.charterScopes)}; paths: ${listed(identity.charterPaths)}`;
  let message = `${identity.handle} acts outside its charter (${charter}): the operation names ${outside.join(", ")}`;
  if (team) {
    const owners = identity.teamOwners.join(", ");
    message += servesAssigner
      ? `; as a team identity assigned by ${assigningOwner}, it works only within ${assigningOwner}'s scopes`
      : assigningOwner === undefined
        ? "; a team identity works only within the scopes of the owner who assigned it, and none of its owners has"
        : `; a team identity works only for its owners (${owners}), and ${assigningOwner} assigned it`;
  }
  return { allowed: false, message };
}

function normalizedOrUndefined(path: string): string | undefined {
  try {
    return normalizeRepoPath(path);
  } catch (error) {
    if (error instanceof InvalidPathError) return undefined;
    throw error;
  }
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
