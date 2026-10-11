// The scope map the ProjectAgent judges review rights by: `penguin/scopes.json` in the project base
// repo, read through the Artifacts binding.

import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

export const SCOPE_MAP_PATH = "penguin/scopes.json";

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
