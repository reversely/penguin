// The runner's local repository: the Git objects of the project's repos fetched in under one
// namespace per repo, so runs merge and test checkpoints without touching any branch the runner
// machine's owner works on. Every runner job that reads owners' forks or a Huddle repo uses these.

import { isObjectId, runGit } from "@penguin/git-analysis";

import { penguinRemote, type RemoteResolver } from "./git-remote.ts";

/** A project repo name a runner may fetch from or push to: an owner fork or a Huddle repo. */
const RUNNER_REPO = /^(?:owner|huddle)-[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function isRunnerRepo(repo: string): boolean {
  return RUNNER_REPO.test(repo);
}

/** The ref namespace a project repo's branches are fetched into. */
export function fetchedRefs(repo: string): string {
  return `refs/penguin/${repo}`;
}

/**
 * Fetches every branch of the project repo `repo` (through `remotes`, as `penguin:<repo>`) into
 * `refs/penguin/<repo>/heads/*` of `repoPath`, replacing what an earlier fetch left there.
 */
export async function fetchRepoBranches(repoPath: string, remotes: RemoteResolver, repo: string): Promise<void> {
  if (!isRunnerRepo(repo)) throw new Error(`${JSON.stringify(repo)} is not an owner fork or a Huddle repo`);
  await remotes(penguinRemote(repo)).git(repoPath, (url) => [
    "fetch",
    "--quiet",
    "--no-tags",
    "--prune",
    "--end-of-options",
    url,
    `+refs/heads/*:${fetchedRefs(repo)}/*`,
  ]);
}

/** The commit `branch` of `repo` pointed at in the last fetch, or null when it had no such branch. */
export async function fetchedBranch(repoPath: string, repo: string, branch: string): Promise<string | null> {
  const output = await runGit(repoPath, ["for-each-ref", "--format=%(objectname)", `${fetchedRefs(repo)}/${branch}`]);
  const sha = output.trim();
  return sha === "" ? null : sha;
}

/** True when `sha` is a full object ID naming a commit in `repoPath`. */
export async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  if (!isObjectId(sha)) return false;
  return runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
}
