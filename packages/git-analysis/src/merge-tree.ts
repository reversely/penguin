import { isObjectId, runGit, runGitWithStatus, splitNul } from "./git.ts";

/** A merge that Git resolved without conflicts. */
export interface CleanMerge {
  readonly kind: "clean";
  /** The merged tree's object ID. */
  readonly tree: string;
}

/** A merge with at least one conflicted path. The tree holds conflict markers and is never tested. */
export interface ConflictedMerge {
  readonly kind: "conflict";
  readonly tree: string;
  /** Paths Git could not merge, sorted and unique. */
  readonly conflictedPaths: readonly string[];
}

export type MergeSimulation = CleanMerge | ConflictedMerge;

/**
 * Merges two commits with `git merge-tree --write-tree` (Git 2.38 or later). Git writes the
 * merged tree to the object store only: no ref, index, working tree or worktree changes, so the
 * owner's checkouts are never touched. The merge base is the one Git computes from history.
 *
 * Raises:
 *   Error: when either commit is not a full object ID, or Git fails for a reason other than a
 *   conflict (an unknown commit, an unrelated history, a Git older than 2.38).
 */
export async function simulateMerge(
  repoPath: string,
  ours: string,
  theirs: string,
): Promise<MergeSimulation> {
  for (const sha of [ours, theirs]) {
    if (!isObjectId(sha)) throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  // Exit 0 is a clean merge and 1 a conflicted one; anything else is a failure to merge at all.
  // With -z, --name-only and --no-messages the output is the tree ID followed by one
  // NUL-terminated field per conflicted path (a path appears once per conflicted stage).
  // Git also exits 1 for a commit it cannot find, printing no tree ID; that case is an error.
  const { stdout, stderr, exitCode } = await runGitWithStatus(
    repoPath,
    ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", "--end-of-options", ours, theirs],
    [0, 1],
  );
  const [tree = "", ...paths] = splitNul(stdout);
  if (!isObjectId(tree)) {
    throw new Error(`git merge-tree ${ours} ${theirs} failed in ${repoPath}: ${stderr.trim() || "no tree ID"}`);
  }
  if (exitCode === 0) return { kind: "clean", tree };
  return { kind: "conflict", tree, conflictedPaths: [...new Set(paths.filter((p) => p !== ""))].sort() };
}

// Every value Git hashes into a simulated merge commit is fixed, so the same tree and parents
// always give the same commit ID, whoever runs the simulation and whenever.
const MERGE_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Penguin merge simulation",
  GIT_AUTHOR_EMAIL: "merge-simulation@penguin.invalid",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Penguin merge simulation",
  GIT_COMMITTER_EMAIL: "merge-simulation@penguin.invalid",
  GIT_COMMITTER_DATE: "@0 +0000",
};

/**
 * Writes a merge commit for a simulated merge's tree with `git commit-tree`, so the tree can be
 * checked out as a commit. The commit goes to the object store only; no ref points at it. Its
 * author, committer, dates and message are fixed, so the commit ID depends only on the tree and
 * the parents.
 *
 * Raises:
 *   Error: when the tree or a parent is not a full object ID or does not exist.
 */
export async function commitMergedTree(
  repoPath: string,
  tree: string,
  parents: readonly string[],
): Promise<string> {
  for (const sha of [tree, ...parents]) {
    if (!isObjectId(sha)) throw new Error(`object must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  const message = `Penguin merge simulation\n\n${parents.map((parent) => `Parent: ${parent}`).join("\n")}\n`;
  const output = await runGit(
    repoPath,
    [
      "-c",
      "i18n.commitEncoding=UTF-8",
      "commit-tree",
      "--no-gpg-sign",
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
      tree,
    ],
    { env: MERGE_IDENTITY },
  );
  return output.trim();
}
