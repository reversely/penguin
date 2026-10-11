import { isObjectId, runGit, splitNul } from "./git.ts";

/**
 * Lists the tracked paths that differ between `baselineSha` and the working tree of `worktree`
 * (an absolute worktree path). Covers committed, staged and unstaged changes to tracked files;
 * untracked files are excluded because `git diff` against a commit only compares tracked paths.
 * Renames are reported as a deletion plus an addition so both paths appear. Sorted, unique.
 */
export async function changedPaths(baselineSha: string, worktree: string): Promise<string[]> {
  return diffNames(worktree, [baselineSha]);
}

/**
 * Lists the paths that differ between two commits, such as a checkpoint and the baseline it was
 * made from. Reads Git objects only, so any path inside the repository works as `repoPath`.
 * Renames are reported as a deletion plus an addition. Sorted, unique.
 */
export async function changedPathsBetween(
  repoPath: string,
  baselineSha: string,
  headSha: string,
): Promise<string[]> {
  return diffNames(repoPath, [baselineSha, headSha]);
}

async function diffNames(cwd: string, commits: readonly string[]): Promise<string[]> {
  // A full object ID cannot be mistaken for an option; --end-of-options guards it a second time.
  for (const sha of commits) {
    if (!isObjectId(sha)) throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  const output = await runGit(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--end-of-options",
    ...commits,
    "--",
  ]);
  return [...new Set(splitNul(output))].sort();
}
