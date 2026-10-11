import { isObjectId, runGit, splitNul } from "./git.ts";

/**
 * Lists the tracked paths that differ between `baselineSha` and the working tree of `worktree`
 * (an absolute worktree path). Covers committed, staged and unstaged changes to tracked files;
 * untracked files are excluded because `git diff` against a commit only compares tracked paths.
 * Renames are reported as a deletion plus an addition so both paths appear. Sorted, unique.
 */
export async function changedPaths(baselineSha: string, worktree: string): Promise<string[]> {
  // A full object ID cannot be mistaken for an option; --end-of-options guards it a second time.
  if (!isObjectId(baselineSha)) {
    throw new Error(`baseline must be a full object ID, got ${JSON.stringify(baselineSha)}`);
  }
  const output = await runGit(worktree, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--end-of-options",
    baselineSha,
    "--",
  ]);
  return [...new Set(splitNul(output))].sort();
}
