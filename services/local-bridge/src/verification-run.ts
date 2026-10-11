// Verification runs in runner mode (PRD sections 4, 6 and 12): for each run Penguin lists, the runner
// fetches the listed owners' checkpoints, merges them onto the run's base with
// `git merge-tree --write-tree`, pushes the result to the Huddle repo's `integration` branch and runs
// each listed command on it in a throwaway worktree. The report holds each command's fingerprint and
// failing tests, never a log. Every step is a local Git or test command, or a fetch or push.

import { commitMergedTree, isObjectId, runGit, simulateMerge } from "@penguin/git-analysis";
import type { VerificationReport, VerificationResult, VerificationRunSpec } from "@penguin/protocol";

import { parseFailingTests } from "./combined-run.ts";
import { fingerprint } from "./fingerprint.ts";
import { penguinRemote, type RemoteResolver } from "./git-remote.ts";
import type { VerificationReply } from "./penguin-client.ts";
import { fetchedBranch, fetchedRefs, fetchRepoBranches, hasCommit, isRunnerRepo } from "./runner-repo.ts";
import type { TestRunner } from "./test-runner.ts";

/** The branch of the Huddle repo that holds the integration result. */
export const INTEGRATION_BRANCH = "integration";

export interface VerificationRunnerOptions {
  /** The runner's repository, which every checkpoint is fetched into. */
  readonly repoPath: string;
  /** Runs each allowlisted command in a throwaway worktree. */
  readonly runner: TestRunner;
  /** Resolves `penguin:owner-<id>` for reading an owner's fork. */
  readonly readRemotes: RemoteResolver;
  /** Resolves `penguin:huddle-<id>` for pushing the integration result. */
  readonly writeRemotes: RemoteResolver;
}

export class VerificationRunner {
  readonly #options: VerificationRunnerOptions;

  constructor(options: VerificationRunnerOptions) {
    this.#options = options;
  }

  /**
   * Runs one verification and returns its report.
   *
   * Raises:
   *   Error: when the listing is malformed, a checkpoint is missing from its fork after the fetch,
   *   or a fetch or the push fails.
   *   ConsentRefusedError: when the runner's owner declines a test run.
   */
  async run(spec: VerificationRunSpec): Promise<VerificationReport> {
    checkSpec(spec);
    const { repoPath, readRemotes } = this.#options;
    for (const repo of new Set(spec.checkpoints.map((checkpoint) => checkpoint.repo))) {
      await fetchRepoBranches(repoPath, readRemotes, repo);
    }
    for (const sha of [spec.baseSha, ...spec.checkpoints.map((checkpoint) => checkpoint.sha)]) {
      if (!(await hasCommit(repoPath, sha))) throw new Error(`commit ${sha} is not in the fetched forks`);
    }

    let merged = spec.baseSha;
    for (const checkpoint of spec.checkpoints) {
      const merge = await simulateMerge(repoPath, merged, checkpoint.sha);
      if (merge.kind === "conflict") {
        return { status: "conflict", ownerId: checkpoint.ownerId, sha: checkpoint.sha, paths: merge.conflictedPaths };
      }
      merged = await commitMergedTree(repoPath, merge.tree, [merged, checkpoint.sha]);
    }
    const revision = await this.#publish(spec.huddleRepo, merged);

    const results: VerificationResult[] = [];
    for (const { commandId } of spec.commands) {
      const outcome = await this.#options.runner.run({ commandId, sha: revision });
      const passed = outcome.exitCode === 0 && outcome.signal === null;
      results.push({
        commandId,
        status: passed ? "passed" : "failed",
        fingerprint: { ...(await fingerprint(repoPath, revision, commandId)) },
        failingTests: passed ? [] : parseFailingTests(outcome.log),
      });
    }
    return { status: "tested", revision, results };
  }

  /**
   * Pushes the integration result to the Huddle repo's `integration` branch and returns the commit
   * the branch then points at. No force: when the branch holds an earlier result, the new commit has
   * that result as its first parent and `merged`'s tree, so the branch only moves forward. A branch
   * that already holds `merged`'s tree on top of `merged` is left as it is, so a retried run pushes
   * nothing twice.
   */
  async #publish(huddleRepo: string, merged: string): Promise<string> {
    const { repoPath, writeRemotes } = this.#options;
    await fetchRepoBranches(repoPath, writeRemotes, huddleRepo);
    const previous = await fetchedBranch(repoPath, huddleRepo, INTEGRATION_BRANCH);
    let revision = merged;
    if (previous !== null && previous !== merged && !(await isAncestor(repoPath, previous, merged))) {
      const tree = (await runGit(repoPath, ["rev-parse", `${merged}^{tree}`])).trim();
      const previousTree = (await runGit(repoPath, ["rev-parse", `${previous}^{tree}`])).trim();
      revision = previousTree === tree && (await isAncestor(repoPath, merged, previous))
        ? previous
        : await commitMergedTree(repoPath, tree, [previous, merged]);
    }
    if (revision !== previous) {
      const ref = `refs/heads/${INTEGRATION_BRANCH}`;
      await writeRemotes(penguinRemote(huddleRepo)).git(repoPath, (url) => [
        "push",
        "--porcelain",
        "--end-of-options",
        url,
        `${revision}:${ref}`,
      ]);
      await runGit(repoPath, ["update-ref", `${fetchedRefs(huddleRepo)}/${INTEGRATION_BRANCH}`, revision]);
    }
    return revision;
  }
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return runGit(repoPath, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]).then(
    () => true,
    () => false,
  );
}

/** Refuses a listing that names something other than full SHAs, owner forks and a Huddle repo. */
function checkSpec(spec: VerificationRunSpec): void {
  const shas = [spec.baseSha, ...spec.checkpoints.map((checkpoint) => checkpoint.sha)];
  const repos = [spec.huddleRepo, ...spec.checkpoints.map((checkpoint) => checkpoint.repo)];
  if (!shas.every((sha) => typeof sha === "string" && isObjectId(sha))) {
    throw new Error(`verification run ${spec.runId} names a commit that is not a full object ID`);
  }
  if (!repos.every((repo) => typeof repo === "string" && isRunnerRepo(repo)) || !spec.huddleRepo.startsWith("huddle-")) {
    throw new Error(`verification run ${spec.runId} names a repo that is not an owner fork or its Huddle repo`);
  }
  if (spec.checkpoints.some((checkpoint) => checkpoint.repo !== `owner-${checkpoint.ownerId}`)) {
    throw new Error(`verification run ${spec.runId} names a checkpoint outside its owner's fork`);
  }
  if (spec.commands.length === 0) throw new Error(`verification run ${spec.runId} lists no command`);
}

export interface VerificationPassResult {
  readonly listed: number;
  /** Each run reported, with Penguin's answer. */
  readonly reported: readonly { readonly runId: string; readonly reply: VerificationReply }[];
  /** Runs that did not run or were not reported. They stay pending and run again next pass. */
  readonly failed: readonly { readonly runId: string; readonly reason: string }[];
  readonly durationMs: number;
}

export interface VerificationPassOptions {
  readonly list: () => Promise<readonly VerificationRunSpec[]>;
  readonly run: (spec: VerificationRunSpec) => Promise<VerificationReport>;
  readonly report: (runId: string, report: VerificationReport) => Promise<VerificationReply>;
}

/** Runs and reports each listed verification run in turn; one run's failure never stops the next. */
export async function verificationPass(options: VerificationPassOptions): Promise<VerificationPassResult> {
  const started = performance.now();
  const specs = await options.list();
  const reported: { runId: string; reply: VerificationReply }[] = [];
  const failed: { runId: string; reason: string }[] = [];
  for (const spec of specs) {
    try {
      reported.push({ runId: spec.runId, reply: await options.report(spec.runId, await options.run(spec)) });
    } catch (error) {
      failed.push({ runId: String(spec.runId), reason: (error as Error).message });
    }
  }
  return { listed: specs.length, reported, failed, durationMs: Math.round(performance.now() - started) };
}

export function formatVerificationPass(result: VerificationPassResult): string {
  const lines = result.reported.map(({ runId, reply }) =>
    reply.status === "recorded"
      ? `Verification run ${runId}: #${reply.issueId} is ${reply.state} after ${reply.commit}.`
      : `Verification run ${runId}: ${reply.status}.`,
  );
  for (const { runId, reason } of result.failed) lines.push(`Verification run ${runId} did not finish: ${reason}`);
  lines.push(`${result.listed} verification runs listed, ${result.reported.length} reported (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
