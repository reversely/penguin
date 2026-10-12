// The files in the project base repo that the ProjectAgent judges review rights and routes by, read
// through the Artifacts binding at main: `penguin/scopes.json`, the scope map; `penguin/teams.json`,
// the teams that own scopes (#135); and `penguin/owners.json`, which names each person's delegate (PRD
// section 7, `Owner.delegate_owner_id`). Team membership comes only from these files at main.

import type { Delegates } from "@penguin/issues";
import { parseScopeMap, parseTeams, TEAMS_PATH, type ScopeMap, type Team } from "@penguin/scope-map";

export const SCOPE_MAP_PATH = "penguin/scopes.json";
export const OWNERS_PATH = "penguin/owners.json";
export { TEAMS_PATH };

/**
 * Parses the scope file's bytes, with the teams file's when the repo has one. A base repo without a
 * scope file has no scopes, so every review is refused for want of a right. A repo without a teams
 * file has only the one-person teams of scopes that name an owner, and a scope naming a team is then
 * refused. An unreadable file throws, so operations wait for a fix instead of being judged against no
 * scopes.
 */
export function parseScopeFile(file: Uint8Array | null, teamsFile: Uint8Array | null = null): ScopeMap {
  const teams = parseTeamsFile(teamsFile);
  if (file === null) return parseScopeMap({ scopes: [] }, { teams });
  try {
    return parseScopeMap(JSON.parse(new TextDecoder().decode(file)), { teams });
  } catch (error) {
    throw new Error(`${SCOPE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The teams in the teams file's bytes; none for a repo without the file. An unreadable file throws. */
export function parseTeamsFile(file: Uint8Array | null): ReadonlyMap<string, Team> {
  if (file === null) return new Map();
  try {
    return parseTeams(JSON.parse(new TextDecoder().decode(file)));
  } catch (error) {
    throw new Error(`${TEAMS_PATH}: ${error instanceof Error ? error.message : String(error)}`);
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
