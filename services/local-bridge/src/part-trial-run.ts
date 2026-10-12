// Runner mode's part trials (PRD 0.5 sections 4.3 and 6): claim each trial Penguin asks for, build the
// part revision's trial tree (trial-tree.ts), run the part's scopes' tests and the review harness for
// each form the claim carries on it, and report to POST /part-trials/<trial id>.
//
// The runner fetches the originating fork, the target's repo and the fix's repo with read tokens. The
// review harness runs with the target as its base (main at the plan's baseline, or the affected fork's
// head) and the trial tree as the fork, so a form's evidence, the stored data rule's marker and the
// side-by-side run all read the affected code with the part's fix in place, and the scope's invariants
// and examples are those its owner declared at the target. A trial whose commits cannot be fetched stays claimed until its lease
// runs out and is run again. A trial tree that does not build is reported as a conflict, with no test
// and no review run.

import { isObjectId } from "@penguin/git-analysis";
import { boundPartTrialReport, PART_TRIAL_SCHEMA_VERSION, PLAN_LIMITS, type PartTrialReport, type PartTrialRequest, type PartTrialTest, type ReviewRecord } from "@penguin/protocol";

import { parseFailingTests } from "./combined-run.ts";
import { resolveCommand } from "./command-allowlist.ts";
import type { RemoteResolver } from "./git-remote.ts";
import type { ReviewRequest } from "./review-harness.ts";
import { fetchRepoBranches, hasCommit } from "./runner-repo.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";
import type { TestRunner } from "./test-runner.ts";
import { buildTrialTree } from "./trial-tree.ts";

export interface PartTrialRunnerOptions {
  /** The repository that holds the checkpoint, the target and the fix. */
  readonly repoPath: string;
  readonly runner: TestRunner;
  /** Runs the review harness in `repoPath`, such as `runReview` bound to the runner's options. */
  readonly review: (request: ReviewRequest) => Promise<ReviewRecord>;
  readonly scratchDir?: string;
}

const PROJECT_REPO = /^(?:base|feature-[a-z0-9]+(?:[.-][a-z0-9]+)*)$/u;
const TEST_COMMAND = /^test:[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Checks a claimed trial before anything runs: full SHAs, project repos and test command IDs only. */
export function checkTrialRequest(request: PartTrialRequest): void {
  for (const sha of trialCommits(request)) if (!isObjectId(sha)) throw new Error(`${JSON.stringify(sha)} is not a full object ID`);
  for (const repo of [request.fork, request.target.repo, ...(request.fix.kind === "commit" ? [request.fix.repo] : [])]) {
    if (!PROJECT_REPO.test(repo)) throw new Error(`${JSON.stringify(repo)} is not the base repo or a feature fork`);
  }
  for (const id of request.commandIds) if (!TEST_COMMAND.test(id)) throw new Error(`${JSON.stringify(id)} is not a test command ID`);
}

/** The commits a trial reads: the checkpoint, the target and a fix commit with its base. */
function trialCommits(request: PartTrialRequest): string[] {
  return [request.checkpoint, request.target.sha, ...(request.fix.kind === "commit" ? [request.fix.commit, request.fix.base] : [])];
}

/** The repos a trial reads: the originating fork, the target's repo and the fix's repo. */
export function trialRepos(request: PartTrialRequest): string[] {
  return [...new Set([request.fork, request.target.repo, ...(request.fix.kind === "commit" ? [request.fix.repo] : [])])];
}

export class PartTrialRunner {
  readonly #options: PartTrialRunnerOptions;

  constructor(options: PartTrialRunnerOptions) {
    this.#options = options;
  }

  /**
   * Runs one trial and returns its report, each review record bound to fit one stored row.
   *
   * Raises:
   *   Error: when the request is malformed or a commit it names is not in the repository.
   */
  async run(request: PartTrialRequest): Promise<PartTrialReport> {
    checkTrialRequest(request);
    const { repoPath, scratchDir } = this.#options;
    for (const sha of trialCommits(request)) if (!(await hasCommit(repoPath, sha))) throw new Error(`commit ${sha} is not in the runner's repository`);
    const started = performance.now();
    const header = {
      schemaVersion: PART_TRIAL_SCHEMA_VERSION,
      trialId: request.trialId,
      partId: request.partId,
      revision: request.revision,
      checkpoint: request.checkpoint,
      target: request.target.sha,
    } as const;
    const built = await buildTrialTree(repoPath, request, scratchDir);
    if (built.status === "conflict") {
      const tests = request.commandIds.map((commandId) => ({ ...unrun(commandId), status: "conflict" as const, reason: built.reason }));
      return { ...header, status: "conflict", tree: null, reason: built.reason, tests, reviews: [], durationMs: elapsed(started) };
    }
    const tests: PartTrialTest[] = [];
    for (const commandId of request.commandIds) tests.push(await this.#test(commandId, built.tree));
    const reviews = [];
    for (const { reviewId, scope, form } of request.reviews) {
      reviews.push({ reviewId, scope, record: await this.#options.review({ base: request.target.sha, fork: built.tree, scope, form }) });
    }
    return boundPartTrialReport({ ...header, status: "built", tree: built.tree, reason: null, tests, reviews, durationMs: elapsed(started) });
  }

  async #test(commandId: string, tree: string): Promise<PartTrialTest> {
    const { repoPath, runner } = this.#options;
    try {
      await resolveCommand(repoPath, tree, commandId);
    } catch (error) {
      return { ...unrun(commandId), status: "not-run", reason: clip((error as Error).message) };
    }
    const started = performance.now();
    const outcome = await runner.run({ commandId, sha: tree });
    const passed = outcome.exitCode === 0 && outcome.signal === null;
    const breaks = passed ? [] : parseFailingTests(outcome.log).slice(0, PLAN_LIMITS.breaksPerResult).map((test) => test.nodeId.slice(0, 512));
    return { scopeId: scopeOf(commandId), commandId, status: passed ? "passed" : "failed", breaks, reason: null, durationMs: elapsed(started) };
  }
}

const scopeOf = (commandId: string): string => commandId.slice("test:".length);
const unrun = (commandId: string) => ({ scopeId: scopeOf(commandId), commandId, breaks: [] as string[], durationMs: 0 });
const elapsed = (started: number): number => Math.round(performance.now() - started);

function clip(text: string): string {
  const max = PLAN_LIMITS.failureLineLength;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Fetches every repo a trial reads into `repoPath` with read tokens. */
export function trialFetcher(remotes: RemoteResolver, repoPath: string): (request: PartTrialRequest) => Promise<void> {
  return async (request) => {
    checkTrialRequest(request);
    for (const repo of trialRepos(request)) await fetchRepoBranches(repoPath, remotes, repo);
  };
}

export interface PartTrialPassOptions {
  readonly claim: () => Promise<readonly PartTrialRequest[]>;
  readonly fetch: (request: PartTrialRequest) => Promise<void>;
  readonly run: (request: PartTrialRequest) => Promise<PartTrialReport>;
  readonly report: (trialId: number, report: PartTrialReport) => Promise<{ readonly status: string }>;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface PartTrialPassResult {
  readonly claimed: number;
  readonly reported: readonly { readonly trialId: number; readonly partId: string; readonly revision: number; readonly summary: string; readonly status: string }[];
  readonly failed: readonly { readonly trialId: number; readonly error: string; readonly failure: FailureNote | null }[];
  readonly durationMs: number;
}

/** Claims, runs and reports every trial Penguin asks for once. One failing trial never stops another. */
export async function partTrialPass(options: PartTrialPassOptions): Promise<PartTrialPassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const reported: PartTrialPassResult["reported"][number][] = [];
  const failed: PartTrialPassResult["failed"][number][] = [];
  for (const request of claimed) {
    try {
      await options.fetch(request);
      const report = await options.run(request);
      const reply = await options.report(request.trialId, report);
      reported.push({ trialId: request.trialId, partId: request.partId, revision: request.revision, summary: summary(report), status: reply.status });
    } catch (error) {
      const reason = (error as Error).message;
      failed.push({ trialId: request.trialId, error: reason, failure: await noteFailure(options.fail, "part-trial", String(request.trialId), reason) });
    }
  }
  return { claimed: claimed.length, reported, failed, durationMs: elapsed(started) };
}

/** A trial in a few words: the tree, then each test command's status and each review's verdict. */
function summary(report: PartTrialReport): string {
  if (report.status === "conflict") return `no trial tree: ${report.reason}`;
  const tests = report.tests.map((test) => `${test.commandId} ${test.status}`);
  const reviews = report.reviews.map((review) => `review of ${review.scope} ${review.record.state}, ${review.record.sideBySide.totals.differing} inputs differ`);
  return `tree ${report.tree?.slice(0, 12)}: ${[...tests, ...reviews].join(", ") || "nothing to run"}`;
}

export function formatPartTrialPass(result: PartTrialPassResult): string {
  const lines = result.reported.map(({ trialId, partId, revision, summary: text, status }) => `Trial ${trialId} of ${partId} revision ${revision}: ${text} (${status}).`);
  for (const { trialId, error, failure } of result.failed) lines.push(`Trial ${trialId} stopped; ${failureText(failure)}: ${error}`);
  lines.push(`${result.claimed} part trial${result.claimed === 1 ? "" : "s"} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
