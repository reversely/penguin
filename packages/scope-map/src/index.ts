import { enclosingPaths, InvalidPathError, normalizeRepoPath } from "./paths.ts";

export { InvalidPathError, normalizeRepoPath } from "./paths.ts";

export const packageName: string = "@penguin/scope-map";

/** A declared dependency of one scope (the consumer) on another (the provider). */
export interface ScopeDependency {
  readonly consumerScopeId: string;
  readonly providerScopeId: string;
  readonly kind: string;
}

/** A part of the codebase with one human owner. */
export interface Scope {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  /** Normalized path prefixes relative to the repository root, without a trailing slash. */
  readonly paths: readonly string[];
  readonly testCommand: string;
  readonly dependsOn: readonly ScopeDependency[];
}

/** A validated scope map with lookup indexes. Build one with `parseScopeMap`. */
export interface ScopeMap {
  readonly scopes: ReadonlyMap<string, Scope>;
  /** Each normalized scope path mapped to the id of the scope that claims it. */
  readonly pathIndex: ReadonlyMap<string, string>;
  /** Each provider scope id mapped to the ids of the scopes that declare a dependency on it. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

/** One problem found in a scope file, with the JSON field it concerns. */
export interface ScopeMapIssue {
  /** The field's location, such as `scopes[1].depends_on[0].scope`. */
  readonly field: string;
  readonly message: string;
}

/** A scope file that failed validation. `issues` lists every problem found. */
export class ScopeMapError extends Error {
  readonly issues: readonly ScopeMapIssue[];

  constructor(issues: readonly ScopeMapIssue[]) {
    super(
      "invalid penguin/scopes.json:\n" +
        issues.map((issue) => `  ${issue.field}: ${issue.message}`).join("\n"),
    );
    this.name = "ScopeMapError";
    this.issues = issues;
  }
}

/** Options for `parseScopeMap`. */
export interface ParseScopeMapOptions {
  /** Owner ids from `penguin/owners.json`. When given, every scope's owner must be one of them. */
  readonly ownerIds?: Iterable<string>;
}

/** The result of `affectedOwners`. Every list is sorted and holds no duplicates. */
export interface AffectedOwners {
  /** Owners of the scopes that declare a dependency on a changed scope. */
  readonly owners: readonly string[];
  /** Scopes that contain at least one changed path. */
  readonly changedScopes: readonly string[];
  /** Scopes that declare a dependency on a changed scope. */
  readonly dependentScopes: readonly string[];
  /** Changed paths, normalized, that fall in no scope. */
  readonly unmapped: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the parsed contents of `penguin/scopes.json` and build its lookup indexes.
 *
 * Scope paths are directory or file prefixes: `ingestion/` claims `ingestion/ids.py` and
 * everything else under `ingestion`. No path may be claimed by two scopes, either as the same
 * prefix or as one prefix nested inside another, so every repository path has at most one
 * scope.
 *
 * Raises:
 *   ScopeMapError: listing every invalid field, including a missing or unknown owner, an
 *   unknown or duplicate dependency, and a path claimed by two scopes.
 */
export function parseScopeMap(json: unknown, options: ParseScopeMapOptions = {}): ScopeMap {
  const issues: ScopeMapIssue[] = [];
  const report = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  if (!isRecord(json) || !Array.isArray(json.scopes)) {
    report("scopes", "must be an array of scope objects");
    throw new ScopeMapError(issues);
  }
  const knownOwners = options.ownerIds === undefined ? undefined : new Set(options.ownerIds);
  const rawScopes: unknown[] = json.scopes;

  // First pass: collect every scope id, so dependencies can point at scopes listed later.
  const scopeIds = new Set<string>();
  rawScopes.forEach((raw, index) => {
    const id = isRecord(raw) ? raw.id : undefined;
    if (!isNonEmptyString(id)) return;
    if (scopeIds.has(id)) report(`scopes[${index}].id`, `duplicate scope id "${id}"`);
    scopeIds.add(id);
  });

  const scopes = new Map<string, Scope>();
  const pathIndex = new Map<string, string>();
  const pathField = new Map<string, string>();
  const enclosedBy = new Map<string, string>();

  rawScopes.forEach((raw, index) => {
    const at = `scopes[${index}]`;
    if (!isRecord(raw)) {
      report(at, "must be an object");
      return;
    }
    const { id, name, owner, paths, test_command, depends_on } = raw;
    if (!isNonEmptyString(id)) report(`${at}.id`, "is missing or empty");
    if (!isNonEmptyString(name)) report(`${at}.name`, "is missing or empty");
    if (!isNonEmptyString(owner)) {
      report(`${at}.owner`, "is missing or empty");
    } else if (knownOwners !== undefined && !knownOwners.has(owner)) {
      report(`${at}.owner`, `names unknown owner "${owner}"`);
    }
    if (!isNonEmptyString(test_command)) report(`${at}.test_command`, "is missing or empty");

    const scopePaths: string[] = [];
    if (!Array.isArray(paths) || paths.length === 0) {
      report(`${at}.paths`, "must be a non-empty array of path prefixes");
    } else {
      paths.forEach((rawPath: unknown, pathIndexInScope) => {
        const field = `${at}.paths[${pathIndexInScope}]`;
        if (typeof rawPath !== "string") {
          report(field, "must be a string");
          return;
        }
        let path: string;
        try {
          path = normalizeRepoPath(rawPath);
        } catch (error) {
          if (!(error instanceof InvalidPathError)) throw error;
          report(field, error.message);
          return;
        }
        scopePaths.push(path);
        if (isNonEmptyString(id)) claimPath(path, id, field);
      });
    }

    const dependsOn: ScopeDependency[] = [];
    if (!Array.isArray(depends_on)) {
      report(`${at}.depends_on`, "must be an array (empty when the scope has no dependencies)");
    } else {
      const seenProviders = new Set<string>();
      depends_on.forEach((dependency: unknown, depIndex) => {
        const depAt = `${at}.depends_on[${depIndex}]`;
        if (!isRecord(dependency)) {
          report(depAt, "must be an object with 'scope' and 'kind'");
          return;
        }
        const provider = dependency.scope;
        if (!isNonEmptyString(dependency.kind)) report(`${depAt}.kind`, "is missing or empty");
        if (!isNonEmptyString(provider)) {
          report(`${depAt}.scope`, "is missing or empty");
        } else if (!scopeIds.has(provider)) {
          report(`${depAt}.scope`, `names unknown scope "${provider}"`);
        } else if (provider === id) {
          report(`${depAt}.scope`, "a scope cannot depend on itself");
        } else if (seenProviders.has(provider)) {
          report(`${depAt}.scope`, `repeats the dependency on "${provider}"`);
        } else {
          seenProviders.add(provider);
          if (isNonEmptyString(id) && isNonEmptyString(dependency.kind)) {
            dependsOn.push({
              consumerScopeId: id,
              providerScopeId: provider,
              kind: dependency.kind,
            });
          }
        }
      });
    }

    // Any issue reported above makes the whole file fail, so only complete scopes are kept.
    const isComplete =
      isNonEmptyString(id) &&
      isNonEmptyString(name) &&
      isNonEmptyString(owner) &&
      isNonEmptyString(test_command);
    if (isComplete && !scopes.has(id)) {
      scopes.set(id, {
        id,
        name,
        ownerId: owner,
        paths: scopePaths,
        testCommand: test_command,
        dependsOn,
      });
    }
  });

  // A path is claimed twice when it equals, encloses or sits inside an already claimed path.
  // Checking each claimed path's enclosing directories catches the "inside" case; the reverse
  // index of enclosing directories catches the "encloses" case. Both are lookups, not scans.
  function claimPath(path: string, scopeId: string, field: string): void {
    const conflict =
      enclosingPaths(path)
        .map((enclosing) => pathField.get(enclosing))
        .find((existing) => existing !== undefined) ?? enclosedBy.get(path);
    if (conflict !== undefined) {
      report(field, `"${path}" overlaps ${conflict}; a path may belong to only one scope`);
      return;
    }
    pathIndex.set(path, scopeId);
    pathField.set(path, field);
    for (const enclosing of enclosingPaths(path).slice(0, -1)) {
      if (!enclosedBy.has(enclosing)) enclosedBy.set(enclosing, field);
    }
  }

  if (issues.length > 0) throw new ScopeMapError(issues);

  const dependents = new Map<string, string[]>();
  for (const scope of scopes.values()) {
    for (const dependency of scope.dependsOn) {
      const list = dependents.get(dependency.providerScopeId) ?? [];
      list.push(scope.id);
      dependents.set(dependency.providerScopeId, list);
    }
  }
  return { scopes, pathIndex, dependents };
}

/**
 * Return the id of the scope that owns a repository path, or `undefined` when no scope does.
 *
 * Raises:
 *   InvalidPathError: when the path is absolute, empty or contains `..`.
 */
export function scopeForPath(map: ScopeMap, path: string): string | undefined {
  for (const enclosing of enclosingPaths(normalizeRepoPath(path))) {
    const scopeId = map.pathIndex.get(enclosing);
    if (scopeId !== undefined) return scopeId;
  }
  return undefined;
}

/** Return the ids of the scopes that declare a direct dependency on a scope. */
export function dependentsOf(map: ScopeMap, scopeId: string): readonly string[] {
  return map.dependents.get(scopeId) ?? [];
}

/**
 * Find the owners of every scope that directly depends on a scope containing a changed path,
 * plus the changed paths that fall in no scope.
 *
 * Raises:
 *   InvalidPathError: when any changed path is absolute, empty or contains `..`.
 */
export function affectedOwners(map: ScopeMap, changedPaths: Iterable<string>): AffectedOwners {
  const changedScopes = new Set<string>();
  const unmapped = new Set<string>();
  for (const path of changedPaths) {
    const scopeId = scopeForPath(map, path);
    if (scopeId === undefined) unmapped.add(normalizeRepoPath(path));
    else changedScopes.add(scopeId);
  }

  const dependentScopes = new Set<string>();
  const owners = new Set<string>();
  for (const changed of changedScopes) {
    for (const dependent of dependentsOf(map, changed)) {
      dependentScopes.add(dependent);
      const scope = map.scopes.get(dependent);
      if (scope !== undefined) owners.add(scope.ownerId);
    }
  }

  return {
    owners: [...owners].sort(),
    changedScopes: [...changedScopes].sort(),
    dependentScopes: [...dependentScopes].sort(),
    unmapped: [...unmapped].sort(),
  };
}
