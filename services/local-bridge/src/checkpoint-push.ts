// Pushing one spooled checkpoint to the owner's fork. Safe to repeat: a fork branch that already
// holds the checkpoint acknowledges it without a push.

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { runGit } from "@penguin/git-analysis";

import type { CheckpointEntry } from "./spool.ts";

export type CheckpointPushResult =
  | { readonly status: "pushed" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly reason: string };

export async function pushCheckpoint(entry: CheckpointEntry): Promise<CheckpointPushResult> {
  const { worktree, fork, ref, sha } = entry;
  if (!existsSync(worktree)) return { status: "failed", reason: `the worktree ${worktree} no longer exists` };
  const reach = await reachFork(fork);
  if (reach !== "reachable") return reach;

  const tip = await forkTip(worktree, fork, ref);
  if (tip === null) return { status: "waiting", reason: `the fork ${fork} is unreachable` };
  if (tip === sha || (tip !== "" && (await succeeds(worktree, ["merge-base", "--is-ancestor", "--end-of-options", sha, tip])))) {
    return { status: "pushed" };
  }
  try {
    // No force: a fork branch that moved elsewhere rejects the push instead of being overwritten.
    await runGit(worktree, ["push", "--porcelain", "--end-of-options", fork, `${sha}:${ref}`]);
    return { status: "pushed" };
  } catch (error) {
    const after = await reachFork(fork);
    if (after !== "reachable") return after;
    const detail = (error as Error).message.trim().split("\n").at(-1) ?? "";
    return { status: "failed", reason: `the fork refused the checkpoint: ${detail}` };
  }
}

/** Phase 1 forks are local bare repositories: a missing path is unreachable, a non-bare one is refused. */
async function reachFork(fork: string): Promise<"reachable" | CheckpointPushResult> {
  const path = await realpath(fork).catch(() => null);
  if (path === null) return { status: "waiting", reason: `the fork ${fork} is unreachable` };
  const bare = await runGit(path, ["rev-parse", "--is-bare-repository"]).catch(() => "");
  if (bare.trim() !== "true") return { status: "failed", reason: `the fork ${fork} is not a bare repository` };
  return "reachable";
}

/** The fork branch's commit, "" when the branch does not exist, null when the fork cannot be read. */
async function forkTip(worktree: string, fork: string, ref: string): Promise<string | null> {
  try {
    const output = await runGit(worktree, ["ls-remote", "--end-of-options", fork, ref]);
    const line = output.split("\n").find((candidate) => candidate.endsWith(`\t${ref}`));
    return line?.split("\t")[0] ?? "";
  } catch {
    return null;
  }
}

function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return runGit(cwd, args).then(
    () => true,
    () => false,
  );
}
