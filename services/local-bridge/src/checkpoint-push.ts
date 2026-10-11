// Pushing one spooled checkpoint to the owner's fork. Safe to repeat: a fork branch that already
// holds the checkpoint acknowledges it without a push.

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";

import { runGit } from "@penguin/git-analysis";

import { RemoteRefusedError, unregisteredRemotes, type GitRemote, type RemoteResolver } from "./git-remote.ts";
import type { CheckpointEntry } from "./spool.ts";

export type CheckpointPushResult =
  | { readonly status: "pushed" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly reason: string };

export async function pushCheckpoint(
  entry: CheckpointEntry,
  remotes: RemoteResolver = unregisteredRemotes,
): Promise<CheckpointPushResult> {
  const { worktree, fork, ref, sha } = entry;
  if (!existsSync(worktree)) return { status: "failed", reason: `the worktree ${worktree} no longer exists` };
  const remote = remotes(fork);
  const reach = await reachFork(remote);
  if (reach !== "reachable") return reach;

  const tip = await forkTip(worktree, remote, ref);
  if (typeof tip !== "string") return tip;
  if (tip === sha || (tip !== "" && (await succeeds(worktree, ["merge-base", "--is-ancestor", "--end-of-options", sha, tip])))) {
    return { status: "pushed" };
  }
  try {
    // No force: a fork branch that moved elsewhere rejects the push instead of being overwritten.
    await remote.git(worktree, (url) => ["push", "--porcelain", "--end-of-options", url, `${sha}:${ref}`]);
    return { status: "pushed" };
  } catch (error) {
    const after = await reachFork(remote);
    if (after !== "reachable") return after;
    const again = await forkTip(worktree, remote, ref);
    if (typeof again !== "string") return again;
    const detail = (error as Error).message.trim().split("\n").at(-1) ?? "";
    return { status: "failed", reason: `the fork refused the checkpoint: ${detail}` };
  }
}

/**
 * A local fork must be a bare repository: a missing path is unreachable, a non-bare one is
 * refused. An Artifacts fork is checked by listing its branches.
 */
async function reachFork(remote: GitRemote): Promise<"reachable" | CheckpointPushResult> {
  if (remote.artifacts) return "reachable";
  const path = await realpath(remote.name).catch(() => null);
  if (path === null) return { status: "waiting", reason: `the fork ${remote.name} is unreachable` };
  const bare = await runGit(path, ["rev-parse", "--is-bare-repository"]).catch(() => "");
  if (bare.trim() !== "true") return { status: "failed", reason: `the fork ${remote.name} is not a bare repository` };
  return "reachable";
}

/** The fork branch's commit, "" when the branch does not exist, or why the fork cannot be read. */
async function forkTip(worktree: string, remote: GitRemote, ref: string): Promise<string | CheckpointPushResult> {
  try {
    const output = await remote.git(worktree, (url) => ["ls-remote", "--end-of-options", url, ref]);
    const line = output.split("\n").find((candidate) => candidate.endsWith(`\t${ref}`));
    return line?.split("\t")[0] ?? "";
  } catch (error) {
    if (error instanceof RemoteRefusedError) return { status: "failed", reason: error.message };
    const detail = (error as Error).message.trim().split("\n").at(-1) ?? "";
    return { status: "waiting", reason: `the fork ${remote.name} is unreachable: ${detail}` };
  }
}

function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return runGit(cwd, args).then(
    () => true,
    () => false,
  );
}
