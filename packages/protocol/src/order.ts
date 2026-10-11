// The coordination order: the one order in which the ProjectAgent applies the operation files of the
// issues repo. The live index and a rebuild from the repo both follow it, so they reach the same state.
//
// 1. Commits in Git first-parent order of the issues repo's main branch, oldest first. A commit
//    contributes the operation files it adds relative to its first parent.
// 2. Within one commit, ascending `base_version`, then ascending path (UTF-16 code units; operation
//    paths are ASCII, so this is byte order).
// 3. Within one commit, a file whose `base_version` cannot be read sorts after every file whose can.
//
// Rule 2 sorts by base version before path because one runner commit can carry a chain of operations
// on one issue: a create by Penguin at version 0 and a comment by jun at version 1. Path order alone
// would put "jun-…" before "penguin-…" and reject the comment as based on an unknown version.

/** One operation file added by one commit. */
export interface OperationFileRef {
  readonly path: string;
  /** The file's `base_version`, or undefined when the file is not JSON or holds no valid one. */
  readonly baseVersion: number | undefined;
}

/** Orders two operation files added by the same commit. */
export function compareWithinCommit(a: OperationFileRef, b: OperationFileRef): number {
  if (a.baseVersion !== b.baseVersion) {
    if (a.baseVersion === undefined) return 1;
    if (b.baseVersion === undefined) return -1;
    return a.baseVersion - b.baseVersion;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Reads `base_version` from an operation file's bytes for ordering only. Returns undefined for a file
 * that is not UTF-8 JSON or whose `base_version` is not a non-negative safe integer; the validator
 * judges such a file when it is applied.
 */
export function readBaseVersion(bytes: Uint8Array): number | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const base = (value as Record<string, unknown>)["base_version"];
    return typeof base === "number" && Number.isSafeInteger(base) && base >= 0 ? base : undefined;
  } catch {
    return undefined;
  }
}

/** One commit of the issues repo with the operation files it adds relative to its first parent. */
export interface OperationCommit<F extends OperationFileRef = OperationFileRef> {
  readonly sha: string;
  readonly files: readonly F[];
}

/**
 * Flattens commits, given in first-parent order oldest first, into coordination order. Each entry
 * keeps the sha of the commit that added it.
 */
export function coordinationOrder<F extends OperationFileRef>(
  commits: readonly OperationCommit<F>[],
): { readonly commit: string; readonly file: F }[] {
  return commits.flatMap((commit) =>
    [...commit.files].sort(compareWithinCommit).map((file) => ({ commit: commit.sha, file })),
  );
}
