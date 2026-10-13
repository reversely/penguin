// The `penguin-bridge runner` command: runner mode, one pass or a pass on every interval. With
// --combined or --repo it also runs the test jobs Penguin schedules in one repository: the combined
// runs it claims (combined-run-pass.ts), the merge-plan facts runs it lists (plan-facts-run.ts), the
// Huddle verification runs it lists (verification-run.ts), the approved branches it records in Huddle
// repos (approval-run.ts), the submitted reviews it claims and runs the review harness on
// (review-run.ts), the trials of each plan part revision it claims (part-trial-run.ts), the agents'
// `impact`, `check` and `apply_fix` requests it claims and runs on feature forks (tool-run.ts), the
// approved mechanical plan parts it writes into affected features' forks (fix-write.ts) and the block
// runs that check a feature merged onto main and every running fork before Penguin promotes it
// (block-run.ts).

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { RUNNER_INTERVAL_MS } from "@penguin/protocol";

import { FixApplier } from "./apply-fix.ts";
import { approvalPass, ApprovedBranchWriter, formatApprovalPass, type ApprovalPassResult } from "./approval-run.ts";
import { BlockChecker, pythonDependencyAnalyzer } from "./block-checks.ts";
import { blockPass, formatBlockPass, type BlockPassResult } from "./block-run.ts";
import { checkTools } from "./check-tools.ts";
import type { CliIo } from "./cli.ts";
import { combinedRunPass, forkFetcher, formatCombinedPass, type CombinedPassResult } from "./combined-run-pass.ts";
import { CombinedRunner } from "./combined-run.ts";
import { fixWritePass, formatFixWritePass, writeFix, type FixWritePassResult } from "./fix-write.ts";
import { penguinRemote, tokenRemote } from "./git-remote.ts";
import { pythonImpactAnalyzer } from "./impact-analysis.ts";
import { formatPartTrialPass, partTrialPass, PartTrialRunner, trialFetcher, type PartTrialPassResult } from "./part-trial-run.ts";
import { factsFetcher, formatPlanFactsPass, planFactsPass, PlanFactsRunner, type PlanFactsPassResult } from "./plan-facts-run.ts";
import { defaultClonePath } from "./issue-cli.ts";
import { IssuesClone } from "./issues-clone.ts";
import type { KeyStore } from "./key-store.ts";
import {
  bridgeRemotes,
  claimBlockRuns,
  claimCombinedRuns,
  claimFixWrites,
  claimPartTrials,
  claimReviews,
  claimToolRuns,
  fetchApprovals,
  fetchPendingOperations,
  fetchPlanFactsRuns,
  fetchVerificationRuns,
  openBridge,
  reportApproval,
  reportBlockRun,
  reportRunFailure,
  reportCombinedRun,
  reportFixWrite,
  reportPartTrial,
  reportPlanFacts,
  reportReview,
  reportToolRun,
  reportVerification,
  type BridgeRegistration,
  type Fetch,
} from "./penguin-client.ts";
import { runReview } from "./review-harness.ts";
import { runSideBySide } from "./side-by-side.ts";
import { formatReviewPass, reviewPass, type ReviewPassResult } from "./review-run.ts";
import type { FailRun } from "./run-failure.ts";
import { fetchRepoBranches } from "./runner-repo.ts";
import { formatPass, runnerPass, RunnerLoop } from "./runner.ts";
import { bridgeSpool } from "./spool-cli.ts";
import { TestRunner } from "./test-runner.ts";
import { formatToolPass, toolPass, type ToolPassResult } from "./tool-run.ts";
import {
  formatVerificationPass,
  verificationPass,
  VerificationRunner,
  type VerificationPassResult,
} from "./verification-run.ts";

export const RUNNER_USAGE = `       penguin-bridge runner [--once] [--interval <ms>] [--branch <name>] [--state-dir <dir>]
                      [--combined] [--repo <path>] [--python <path>] [--ruff <path>]
         --combined or --repo also runs Penguin's test jobs in the repository at <path> (default
         <state-dir>/combined): the combined runs it schedules on checkpoints and the Huddle
         verification runs. Each fetches checkpoints there and runs the allowlisted tests in
         throwaway worktrees; verification pushes the Huddle repo's integration branch, and an
         approved Huddle has its approved branch pushed there too. Passing either option is the
         runner operator's consent to those runs and pushes. Each combined run also runs the
         section 5.1 checks on every merged tree: the impact graph and dependency diff with
         <python> (default python3), lint and format with <ruff> (default ruff on PATH) and the
         type check with the pyright package installed beside the bridge. Each review submitted with
         submit_review is claimed too: the feature's fork is fetched and the review harness runs
         the scope's public functions on the checkpoint's baseline and on the checkpoint. Each
         part trial of a merge plan is claimed too: the part's trial tree is built (the affected
         fork head or main, the patch or fix commit, the feature's checkpoint merged in) and the
         part's scopes' tests and the review harness run on it. A merge
         plan's facts run fetches the feature forks it names, runs the impact graph and each
         listed scope's tests on the feature checkpoint merged onto main and onto each running
         feature.
         Each impact, check and apply_fix an agent called is claimed too: the feature's fork and
         the other running features' forks are fetched, and the tool runs on the checkpoint. A fix
         commit stays in <path> and is not pushed.
         Each approved mechanical part of a merge plan is claimed too, with a write token minted for
         that part on the affected feature's fork: its patch becomes one commit on the fork head,
         pushed as a fast-forward of the fork's main. The runner reports the commit to Penguin.
         Each block run Penguin asks for is claimed too: the base repo and every feature fork it
         names are fetched with read tokens, the feature's checkpoint is merged onto main and onto
         each fork, and the checks and every scope's tests on main run. Penguin moves main itself
         when a land run passes; the runner holds no token on main.
`;

/** One pass of the test jobs: each job's result, or why it did not run. */
interface TestJobsResult {
  readonly combined: CombinedPassResult | Error;
  readonly planFacts: PlanFactsPassResult | Error;
  readonly verification: VerificationPassResult | Error;
  readonly approval: ApprovalPassResult | Error;
  readonly review: ReviewPassResult | Error;
  readonly trials: PartTrialPassResult | Error;
  readonly tools: ToolPassResult | Error;
  readonly fixWrites: FixWritePassResult | Error;
  readonly blocks: BlockPassResult | Error;
}

/**
 * Runs `runner`: with --once a single pass, otherwise a pass on every interval until interrupted.
 * The bridge must be registered with the runner role. Resolves with the exit code.
 */
export async function runRunnerCommand(
  args: readonly string[],
  io: CliIo,
  keyStore: KeyStore,
  defaultStateDir: string,
  fetchImpl?: Fetch,
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      branch: { type: "string", default: "main" },
      "state-dir": { type: "string" },
      combined: { type: "boolean", default: false },
      repo: { type: "string" },
      python: { type: "string" },
      ruff: { type: "string" },
    },
    strict: true,
  });
  const interval = Number(values.interval ?? RUNNER_INTERVAL_MS);
  if (!Number.isInteger(interval) || interval <= 0) {
    io.write(RUNNER_USAGE);
    return 2;
  }
  const stateDir = values["state-dir"] ?? defaultStateDir;
  const { registration, bridgeToken } = await openBridge(stateDir, keyStore);
  if (registration.role !== "runner") {
    io.write(`Bridge ${registration.bridgeId} is registered as ${registration.role}; runner mode needs a runner registration.\n`);
    return 1;
  }

  const remote = penguinRemote("issues");
  // The same clone the issue command line uses, so both share one copy under the spool lock.
  const clone = new IssuesClone({
    remote,
    remotes: bridgeRemotes(stateDir, keyStore, fetchImpl),
    clonePath: defaultClonePath(stateDir, remote),
    branch: values.branch,
    ownerId: registration.owner,
    maxPushAttempts: 5,
  });
  const spool = bridgeSpool(stateDir);
  const pass = () =>
    spool.withLock(() =>
      runnerPass({ list: () => fetchPendingOperations(registration.server, bridgeToken, fetchImpl), clone }),
    );

  const testJobs =
    values.combined || values.repo !== undefined
      ? await testJobsPass(registration, bridgeToken, values.repo ?? join(stateDir, "combined"), stateDir, keyStore, fetchImpl, {
          python: values.python,
          ruff: values.ruff,
        })
      : undefined;

  if (values.once) {
    let code = 0;
    try {
      const result = await pass();
      io.write(formatPass(result));
      if (result.refused.length > 0) code = 1;
    } catch (error) {
      io.write(`The pass did not run; the operations stay pending: ${(error as Error).message}\n`);
      code = 1;
    }
    if (testJobs !== undefined) {
      const result = await testJobs();
      io.write(formatTestJobs(result, true));
      if (!testJobsClean(result)) code = 1;
    }
    return code;
  }

  const loop = new RunnerLoop({
    pass,
    intervalMs: interval,
    onPass: (result) => {
      if (result.listed > 0) io.write(formatPass(result));
    },
    onError: (error) => io.write(`The pass did not run; the operations stay pending: ${error.message}\n`),
  });
  // Test jobs run for minutes, so they loop on their own and never hold the spool lock. One loop runs
  // both kinds in turn, so they never share the repository at the same time.
  const testLoop =
    testJobs === undefined
      ? undefined
      : new RunnerLoop<TestJobsResult>({
          pass: testJobs,
          intervalMs: interval,
          onPass: (result) => {
            const text = formatTestJobs(result, false);
            if (text !== "") io.write(text);
          },
        });
  loop.start();
  testLoop?.start();
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await Promise.all([loop.stop(), testLoop?.stop()]);
  return 0;
}

/**
 * One pass of the test jobs bound to this runner: claims and reports combined runs, then lists,
 * runs and reports verification runs, then records approved branches. Owner forks are fetched with
 * read tokens into `repoPath` (created as an empty repository when missing); the Huddle repo is
 * pushed with the runner's write token. One job failing never stops another.
 */
async function testJobsPass(
  registration: BridgeRegistration,
  bridgeToken: string,
  repoPath: string,
  stateDir: string,
  keyStore: KeyStore,
  fetchImpl: Fetch | undefined,
  programs: { readonly python?: string; readonly ruff?: string },
): Promise<() => Promise<TestJobsResult>> {
  const repo = resolve(repoPath);
  if (!existsSync(repo)) {
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await runGit(repo, ["init", "--quiet"]);
  }
  const { server } = registration;
  const runner = new TestRunner({ repoPath: repo, consent: () => true });
  const impact = pythonImpactAnalyzer({ repoPath: repo, python: programs.python });
  const checks = new BlockChecker({
    repoPath: repo,
    tools: checkTools({ ruff: programs.ruff, python: programs.python }),
    dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: programs.python }),
  });
  const readRemotes = bridgeRemotes(stateDir, keyStore, fetchImpl, "read");
  const writeRemotes = bridgeRemotes(stateDir, keyStore, fetchImpl, "write");
  const verifier = new VerificationRunner({ repoPath: repo, runner, readRemotes, writeRemotes });
  const approver = new ApprovedBranchWriter({ repoPath: repo, writeRemotes });
  const fixes = new FixApplier({ repoPath: repo, ruff: programs.ruff });
  const facts = new PlanFactsRunner({ repoPath: repo, runner, impact, fixes });
  const combined = new CombinedRunner({ repoPath: repo, runner, impact, checks });
  const trials = new PartTrialRunner({
    repoPath: repo,
    runner,
    review: (request) => runReview({ repoPath: repo, python: programs.python, analyzer: impact }, request),
    sideBySide: (request) => runSideBySide({ repoPath: repo, python: programs.python }, request),
  });
  const settle = <T>(job: () => Promise<T>): Promise<T | Error> => job().catch((error: unknown) => error as Error);
  // A run a pass stops on goes back to Penguin with its reason, which frees it for any runner at once.
  const fail: FailRun = (failure) => reportRunFailure(server, bridgeToken, failure, fetchImpl);
  return async () => ({
    combined: await settle(() =>
      combinedRunPass({
        claim: () => claimCombinedRuns(server, bridgeToken, fetchImpl),
        report: (event) => reportCombinedRun(server, bridgeToken, event, fetchImpl),
        fetchForks: forkFetcher(readRemotes, repo),
        repoPath: repo,
        runner,
        impact,
        checks,
        fail,
      }),
    ),
    planFacts: await settle(() =>
      planFactsPass({
        list: () => fetchPlanFactsRuns(server, bridgeToken, fetchImpl),
        fetch: factsFetcher(readRemotes, repo),
        run: (request) => facts.run(request),
        report: (runId, report) => reportPlanFacts(server, bridgeToken, runId, report, fetchImpl),
        fail,
      }),
    ),
    verification: await settle(() =>
      verificationPass({
        list: () => fetchVerificationRuns(server, bridgeToken, fetchImpl),
        run: (spec) => verifier.run(spec),
        report: (runId, report) => reportVerification(server, bridgeToken, runId, report, fetchImpl),
      }),
    ),
    approval: await settle(() =>
      approvalPass({
        list: () => fetchApprovals(server, bridgeToken, fetchImpl),
        write: (spec) => approver.write(spec),
        report: (issueId, report) => reportApproval(server, bridgeToken, issueId, report, fetchImpl),
      }),
    ),
    review: await settle(() =>
      reviewPass({
        claim: () => claimReviews(server, bridgeToken, fetchImpl),
        report: (reviewId, record) => reportReview(server, bridgeToken, reviewId, record, fetchImpl),
        fetchFork: (fork) => fetchRepoBranches(repo, readRemotes, fork),
        review: (request) => runReview({ repoPath: repo, python: programs.python, analyzer: impact }, request),
        repoPath: repo,
        fail,
      }),
    ),
    trials: await settle(() =>
      partTrialPass({
        claim: () => claimPartTrials(server, bridgeToken, fetchImpl),
        fetch: trialFetcher(readRemotes, repo),
        run: (request) => trials.run(request),
        report: (trialId, report) => reportPartTrial(server, bridgeToken, trialId, report, fetchImpl),
        fail,
      }),
    ),
    tools: await settle(() =>
      toolPass({
        claim: () => claimToolRuns(server, bridgeToken, fetchImpl),
        report: (runId, result) => reportToolRun(server, bridgeToken, runId, result, fetchImpl),
        fetchFork: (fork) => fetchRepoBranches(repo, readRemotes, fork),
        impact,
        combined,
        fixes,
        repoPath: repo,
        fail,
      }),
    ),
    fixWrites: await settle(() =>
      fixWritePass({
        claim: () => claimFixWrites(server, bridgeToken, fetchImpl),
        // The token Penguin minted for this part reaches Git only through the push's environment.
        // A write that copies the originating change's modules reads them from the originating fork.
        write: async ({ spec, token }) => {
          if (spec.copy !== undefined) await fetchRepoBranches(repo, readRemotes, `feature-${spec.feature}`);
          return writeFix({ repoPath: repo, remote: tokenRemote(penguinRemote(spec.fork), token) }, spec);
        },
        report: (writeId, commit) => reportFixWrite(server, bridgeToken, writeId, commit, fetchImpl),
        fail,
      }),
    ),
    blocks: await settle(() =>
      blockPass({
        claim: () => claimBlockRuns(server, bridgeToken, fetchImpl),
        report: (report) => reportBlockRun(server, bridgeToken, report, fetchImpl),
        fetchRepo: (name) => fetchRepoBranches(repo, readRemotes, name),
        combined,
        repoPath: repo,
        fail,
      }),
    ),
  });
}

/** True when every job ran and nothing in them was refused or stopped. */
function testJobsClean({ combined, planFacts, verification, approval, review, trials, tools, fixWrites, blocks }: TestJobsResult): boolean {
  if (
    blocks instanceof Error ||
    fixWrites instanceof Error ||
    combined instanceof Error ||
    planFacts instanceof Error ||
    verification instanceof Error ||
    approval instanceof Error ||
    review instanceof Error ||
    trials instanceof Error ||
    tools instanceof Error
  ) {
    return false;
  }
  const combinedClean = combined.batches.every((batch) => batch.error === null && batch.refused.length === 0);
  const reviewClean = review.reviews.every((entry) => entry.error === null);
  const toolsClean = tools.runs.every((entry) => entry.error === null);
  const fixWritesClean = fixWrites.writes.every((entry) => entry.error === null);
  const blocksClean = blocks.runs.every((entry) => entry.error === null);
  return blocksClean && fixWritesClean && combinedClean && reviewClean && trials.failed.length === 0 && toolsClean && planFacts.failed.length === 0 && verification.failed.length === 0 && approval.failed.length === 0;
}

/** The pass's lines; `always` writes a job's summary even when it found no work. */
function formatTestJobs({ combined, planFacts, verification, approval, review, trials, tools, fixWrites, blocks }: TestJobsResult, always: boolean): string {
  let text = "";
  if (combined instanceof Error) text += `No combined runs were claimed: ${combined.message}\n`;
  else if (always || combined.claimed > 0) text += formatCombinedPass(combined);
  if (planFacts instanceof Error) text += `The plan facts pass did not run; the runs stay listed: ${planFacts.message}\n`;
  else if (always || planFacts.listed > 0) text += formatPlanFactsPass(planFacts);
  if (verification instanceof Error) text += `The verification pass did not run; the runs stay pending: ${verification.message}\n`;
  else if (always || verification.listed > 0) text += formatVerificationPass(verification);
  if (approval instanceof Error) text += `The approval pass did not run; the approved branches stay listed: ${approval.message}\n`;
  else if (always || approval.listed > 0) text += formatApprovalPass(approval);
  if (review instanceof Error) text += `No reviews were claimed: ${review.message}\n`;
  else if (always || review.claimed > 0) text += formatReviewPass(review);
  if (trials instanceof Error) text += `No part trials were claimed: ${trials.message}\n`;
  else if (always || trials.claimed > 0) text += formatPartTrialPass(trials);
  if (tools instanceof Error) text += `No tool requests were claimed: ${tools.message}\n`;
  else if (always || tools.claimed > 0) text += formatToolPass(tools);
  if (fixWrites instanceof Error) text += `No fix writes were claimed: ${fixWrites.message}\n`;
  else if (always || fixWrites.claimed > 0) text += formatFixWritePass(fixWrites);
  if (blocks instanceof Error) text += `No block runs were claimed: ${blocks.message}\n`;
  else if (always || blocks.claimed > 0) text += formatBlockPass(blocks);
  return text;
}
