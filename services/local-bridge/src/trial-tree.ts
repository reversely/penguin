// The trial tree of a plan part revision (PRD 0.5 section 4.3): the tree the part would land as, built
// from Git objects the runner already holds, with no checkout and no ref.
//
// 1. Start at the target: a running feature's fork head (the head the part's patch was written
//    against), or main at the plan's baseline for a scope on main.
// 2. A patch is applied to that head (patch-tree.ts), which is the commit Penguin writes into the fork
//    once the part is approved.
// 3. The originating checkpoint is merged in with `git merge-tree --write-tree`, as a land merges it.
// 4. A fix commit in the originating fork is applied on top as its own change against its base,
//    with `git merge-tree --merge-base`: a cherry-pick of the fix without the rest of the fork.
//
// Every commit is written with commitMergedTree's fixed identity and dates, so one trial always gives
// one tree commit. A step that does not apply is a conflict, named with its paths.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitMergedTree, isObjectId, runGitWithStatus, simulateMerge, splitNul } from "@penguin/git-analysis";
import { parsePatch, PLAN_LIMITS, type PartTrialRequest } from "@penguin/protocol";

import { patchedTree } from "./patch-tree.ts";

export type TrialTree = { readonly status: "built"; readonly tree: string } | { readonly status: "conflict"; readonly reason: string };

const conflict = (reason: string): TrialTree => ({ status: "conflict", reason: clip(reason) });

/**
 * Builds the trial tree of `request` in `repoPath`, which holds the target, the checkpoint and the fix.
 *
 * Raises:
 *   Error: when a commit is not a full object ID or Git fails for a reason other than a conflict.
 */
export async function buildTrialTree(repoPath: string, request: Pick<PartTrialRequest, "checkpoint" | "target" | "fix">, scratchDir?: string): Promise<TrialTree> {
  const { checkpoint, target, fix } = request;
  for (const sha of [checkpoint, target.sha, ...(fix.kind === "commit" ? [fix.commit, fix.base] : [])]) {
    if (!isObjectId(sha)) throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  let head = target.sha;
  if (fix.kind === "patch") {
    const parsed = parsePatch(fix.patch);
    if (!parsed.ok) return conflict(`the patch does not parse: ${parsed.message}`);
    const scratch = await mkdtemp(join(scratchDir ?? tmpdir(), "penguin-trial-"));
    try {
      const patched = await patchedTree(repoPath, target.sha, parsed.files, scratch);
      if (!patched.ok) return conflict(`the patch does not apply to ${target.sha.slice(0, 12)}: ${patched.message}`);
      head = await commitMergedTree(repoPath, patched.tree, [target.sha]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  const merge = await simulateMerge(repoPath, checkpoint, head);
  if (merge.kind === "conflict") return conflict(`the checkpoint's merge conflicts in ${merge.conflictedPaths.join(", ")}`);
  const merged = await commitMergedTree(repoPath, merge.tree, [checkpoint, head]);
  if (fix.kind === "patch") return { status: "built", tree: merged };
  // Exit 0 is a clean merge and 1 a conflicted one, as in simulateMerge.
  const picked = await runGitWithStatus(
    repoPath,
    ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${fix.base}`, "--end-of-options", merged, fix.commit],
    [0, 1],
  );
  const [tree = "", ...paths] = splitNul(picked.stdout);
  if (!isObjectId(tree)) throw new Error(`git merge-tree of fix ${fix.commit} failed in ${repoPath}: ${picked.stderr.trim() || "no tree ID"}`);
  if (picked.exitCode !== 0) return conflict(`fix ${fix.commit.slice(0, 12)} conflicts in ${[...new Set(paths.filter(Boolean))].sort().join(", ")}`);
  return { status: "built", tree: await commitMergedTree(repoPath, tree, [merged]) };
}

function clip(text: string): string {
  const max = PLAN_LIMITS.failureLineLength;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
