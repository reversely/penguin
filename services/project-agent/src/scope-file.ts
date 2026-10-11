// The files in the project base repo that the ProjectAgent judges review rights by, read through the
// Artifacts binding: `penguin/scopes.json`, the scope map, and `penguin/owners.json`, which names each
// owner's delegate (PRD section 7, `Owner.delegate_owner_id`).

import type { Delegates } from "@penguin/issues";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

export const SCOPE_MAP_PATH = "penguin/scopes.json";
export const OWNERS_PATH = "penguin/owners.json";

/**
 * Parses the scope file's bytes. A base repo without one has no scopes, so every review is refused
 * for want of a right. An unreadable file throws, so operations wait for a fix instead of being
 * judged against no scopes.
 */
export function parseScopeFile(file: Uint8Array | null): ScopeMap {
  if (file === null) return parseScopeMap({ scopes: [] });
  try {
    return parseScopeMap(JSON.parse(new TextDecoder().decode(file)));
  } catch (error) {
    throw new Error(`${SCOPE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Each owner's delegate from the owners file's bytes: the `delegate_owner_id` of every owner that
 * names one other than itself. A base repo without the file names no delegate. An unreadable file
 * throws, as an unreadable scope file does, so no review is judged without its delegates.
 */
export function parseOwnersFile(file: Uint8Array | null): Delegates {
  const delegates = new Map<string, string>();
  if (file === null) return delegates;
  const fail = (message: string): never => {
    throw new Error(`${OWNERS_PATH}: ${message}`);
  };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(file));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const owners = (json as { owners?: unknown } | null)?.owners;
  if (!Array.isArray(owners)) return fail("owners must be an array of owner objects");
  owners.forEach((owner: unknown, index) => {
    const { id, delegate_owner_id: delegate } = (owner ?? {}) as { id?: unknown; delegate_owner_id?: unknown };
    if (typeof id !== "string" || id === "") fail(`owners[${index}].id is missing or empty`);
    if (delegate !== undefined && delegate !== null && (typeof delegate !== "string" || delegate === "")) {
      fail(`owners[${index}].delegate_owner_id must be an owner id or null`);
    }
    if (typeof delegate === "string" && delegate !== id) delegates.set(id as string, delegate);
  });
  return delegates;
}
