// `penguin/invariants.json`, beside `penguin/scopes.json` in the base repo (PRD 0.4 section 6 and
// open decision 5): each scope owner's declared invariants, and the files of recorded examples the
// review harness runs the scope's public functions on.
//
// {
//   "invariants": [
//     { "id": "tablet-patrons-separate", "scope": "analytics",
//       "statement": "Patrons who log in on one library tablet stay separate people", "protected": true }
//   ],
//   "examples": [
//     { "scope": "analytics", "file": "analytics/examples/daily_active_users.json",
//       "invariants": ["tablet-patrons-separate"] }
//   ]
// }
//
// An invariant's id is unique in the file, its scope is a scope in `penguin/scopes.json` and its
// statement is plain text. An examples file lies inside its scope's paths, so only the scope's owner
// writes the data its functions are run on, and it names only that scope's invariants.

import type { ScopeMap, ScopeMapIssue } from "./index.ts";
import { InvalidPathError, normalizeRepoPath } from "./paths.ts";

export const INVARIANTS_PATH = "penguin/invariants.json";

export const INVARIANT_LIMITS = {
  invariants: 1_000,
  examples: 1_000,
  idLength: 64,
  statementLength: 500,
  pathLength: 512,
} as const;

/** An invariant id: lowercase letters and digits joined by '.', '_' or '-'. */
const INVARIANT_ID = /^[a-z0-9][a-z0-9._-]*$/u;
// A statement is one line of plain text: no control characters, newlines included.
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** `Invariant(id, scope_id, statement, protected)` (PRD section 9). */
export interface Invariant {
  readonly id: string;
  readonly scopeId: string;
  readonly statement: string;
  /** A side-by-side difference on a protected invariant goes to the scope's owner in person. */
  readonly protected: boolean;
}

/** A file of recorded examples for one of a scope's public functions. */
export interface ExampleSource {
  readonly scopeId: string;
  /** The file's normalized path in the repo, inside the scope's paths. */
  readonly file: string;
  /** Ids of the scope's invariants the examples bear on. */
  readonly invariants: readonly string[];
}

export interface InvariantsFile {
  readonly invariants: readonly Invariant[];
  readonly examples: readonly ExampleSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insideScope(map: ScopeMap, scopeId: string, path: string): boolean {
  const scope = map.scopes.get(scopeId);
  return scope !== undefined && scope.paths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Validates the parsed contents of `penguin/invariants.json` against the scope map.
 *
 * Raises:
 *   InvariantsFileError: listing every invalid field: an unknown key, a repeated or malformed id, a scope
 *   not in the scope map, an empty or overlong statement, an examples file outside its scope or an
 *   example naming another scope's invariant.
 */
export function parseInvariantsFile(json: unknown, map: ScopeMap): InvariantsFile {
  const issues: ScopeMapIssue[] = [];
  const report = (field: string, message: string): void => {
    issues.push({ field, message });
  };
  if (!isRecord(json)) throw new InvariantsFileError([{ field: "", message: "must be a JSON object" }]);
  for (const key of Object.keys(json)) {
    if (!["$comment", "invariants", "examples"].includes(key)) report(key, "is not a field of the invariants file");
  }
  const rawInvariants = json.invariants;
  const rawExamples = json.examples ?? [];
  if (!Array.isArray(rawInvariants)) report("invariants", "must be an array of invariants");
  if (!Array.isArray(rawExamples)) report("examples", "must be an array of example files when present");

  const invariants: Invariant[] = [];
  const scopeOf = new Map<string, string>();
  const list = Array.isArray(rawInvariants) ? rawInvariants : [];
  if (list.length > INVARIANT_LIMITS.invariants) report("invariants", `must hold at most ${INVARIANT_LIMITS.invariants}`);
  list.slice(0, INVARIANT_LIMITS.invariants).forEach((raw: unknown, index) => {
    const at = `invariants[${index}]`;
    if (!isRecord(raw)) return report(at, "must be an object");
    for (const key of Object.keys(raw)) {
      if (!["id", "scope", "statement", "protected"].includes(key)) report(`${at}.${key}`, "is not a field of an invariant");
    }
    const { id, scope, statement } = raw;
    const isProtected = raw.protected ?? false;
    let ok = true;
    if (typeof id !== "string" || id.length > INVARIANT_LIMITS.idLength || !INVARIANT_ID.test(id)) {
      report(`${at}.id`, `must be lowercase letters and digits joined by '.', '_' or '-', at most ${INVARIANT_LIMITS.idLength} characters`);
      ok = false;
    } else if (scopeOf.has(id)) {
      report(`${at}.id`, `repeats "${id}"`);
      ok = false;
    }
    if (typeof scope !== "string" || !map.scopes.has(scope)) {
      report(`${at}.scope`, "must be a scope id from penguin/scopes.json");
      ok = false;
    }
    if (
      typeof statement !== "string" ||
      statement.trim() === "" ||
      [...statement].length > INVARIANT_LIMITS.statementLength ||
      CONTROL.test(statement)
    ) {
      report(`${at}.statement`, `must be one line of text, at most ${INVARIANT_LIMITS.statementLength} characters`);
      ok = false;
    }
    if (typeof isProtected !== "boolean") {
      report(`${at}.protected`, "must be true or false when present");
      ok = false;
    }
    if (!ok) return;
    scopeOf.set(id as string, scope as string);
    invariants.push({ id: id as string, scopeId: scope as string, statement: statement as string, protected: isProtected as boolean });
  });

  const examples: ExampleSource[] = [];
  const files = new Set<string>();
  const sources = Array.isArray(rawExamples) ? rawExamples : [];
  if (sources.length > INVARIANT_LIMITS.examples) report("examples", `must hold at most ${INVARIANT_LIMITS.examples}`);
  sources.slice(0, INVARIANT_LIMITS.examples).forEach((raw: unknown, index) => {
    const at = `examples[${index}]`;
    if (!isRecord(raw)) return report(at, "must be an object");
    for (const key of Object.keys(raw)) {
      if (!["scope", "file", "invariants"].includes(key)) report(`${at}.${key}`, "is not a field of an examples entry");
    }
    const { scope, file } = raw;
    const named = raw.invariants ?? [];
    if (typeof scope !== "string" || !map.scopes.has(scope)) return report(`${at}.scope`, "must be a scope id from penguin/scopes.json");
    let path: string;
    try {
      if (typeof file !== "string" || file.length > INVARIANT_LIMITS.pathLength) throw new InvalidPathError(String(file), "not a path");
      path = normalizeRepoPath(file);
    } catch {
      return report(`${at}.file`, `must be a path relative to the repository root, at most ${INVARIANT_LIMITS.pathLength} characters`);
    }
    if (!insideScope(map, scope, path)) return report(`${at}.file`, `must lie inside the paths of scope ${scope}`);
    if (files.has(path)) return report(`${at}.file`, `repeats "${path}"`);
    if (!Array.isArray(named) || named.some((id) => typeof id !== "string" || scopeOf.get(id) !== scope)) {
      return report(`${at}.invariants`, `must list ids of scope ${scope}'s invariants`);
    }
    files.add(path);
    examples.push({ scopeId: scope, file: path, invariants: [...new Set(named as string[])] });
  });

  if (issues.length > 0) throw new InvariantsFileError(issues);
  return { invariants, examples };
}

/** An invariants file that failed validation. `issues` lists every problem found. */
export class InvariantsFileError extends Error {
  readonly issues: readonly ScopeMapIssue[];

  constructor(issues: readonly ScopeMapIssue[]) {
    super(`invalid ${INVARIANTS_PATH}:\n${issues.map((issue) => `  ${issue.field}: ${issue.message}`).join("\n")}`);
    this.name = "InvariantsFileError";
    this.issues = issues;
  }
}

/** Parses the file's bytes; a base repo without the file declares no invariants. */
export function parseInvariantsBytes(file: Uint8Array | string | null, map: ScopeMap): InvariantsFile {
  if (file === null) return { invariants: [], examples: [] };
  let json: unknown;
  try {
    json = JSON.parse(typeof file === "string" ? file : new TextDecoder().decode(file));
  } catch (error) {
    throw new InvariantsFileError([{ field: "", message: `is not JSON: ${error instanceof Error ? error.message : String(error)}` }]);
  }
  return parseInvariantsFile(json, map);
}
