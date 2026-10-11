// The `penguin-bridge runner` command: runner mode, one pass or a pass on every interval. With
// --combined or --repo it also runs the test jobs Penguin schedules in one repository: the combined
// runs it claims (combined-run-pass.ts), the Huddle verification runs it lists (verification-run.ts)
// and the approved branches it records in Huddle repos (approval-run.ts).

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import { approvalPass, ApprovedBranchWriter, formatApprovalPass, type ApprovalPassResult } from "./approval-run.ts";
import type { CliIo } from "./cli.ts";
import { combinedRunPass, forkFetcher, formatCombinedPass, type CombinedPassResult } from "./combined-run-pass.ts";
import { penguinRemote } from "./git-remote.ts";
import { defaultClonePath } from "./issue-cli.ts";
import { IssuesClone } from "./issues-clone.ts";
import type { KeyStore } from "./key-store.ts";
import {
  bridgeRemotes,
  claimCombinedRuns,
  fetchApprovals,
  fetchPendingOperations,
  fetchVerificationRuns,
  openBridge,
  reportApproval,
  reportCombinedRun,
  reportVerification,
  type BridgeRegistration,
  type Fetch,
} from "./penguin-client.ts";
import { formatPass, runnerPass, RunnerLoop } from "./runner.ts";
import { bridgeSpool } from "./spool-cli.ts";
import { TestRunner } from "./test-runner.ts";
import {
  formatVerificationPass,
  verificationPass,
  VerificationRunner,
  type VerificationPassResult,
} from "./verification-run.ts";

export const RUNNER_USAGE = `       penguin-bridge runner [--once] [--interval <ms>] [--branch <name>] [--state-dir <dir>]
                      [--combined] [--repo <path>]
         --combined or --repo also runs Penguin's test jobs in the repository at <path> (default
         <state-dir>/combined): the combined runs it schedules on checkpoints and the Huddle
         verification runs. Each fetches checkpoints there and runs the allowlisted tests in
         throwaway worktrees; verification pushes the Huddle repo's integration branch, and an
         approved Huddle has its approved branch pushed there too. Passing either option is the
         runner operator's consent to those runs and pushes.
`;

const DEFAULT_INTERVAL_MS = 10_000;

/** One pass of the test jobs: each job's result, or why it did not run. */
interface TestJobsResult {
  readonly combined: CombinedPassResult | Error;
  readonly verification: VerificationPassResult | Error;
  readonly approval: ApprovalPassResult | Error;
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
    },
    strict: true,
  });
  const interval = Number(values.interval ?? DEFAULT_INTERVAL_MS);
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
      ? await testJobsPass(registration, bridgeToken, values.repo ?? join(stateDir, "combined"), stateDir, keyStore, fetchImpl)
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
): Promise<() => Promise<TestJobsResult>> {
  const repo = resolve(repoPath);
  if (!existsSync(repo)) {
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await runGit(repo, ["init", "--quiet"]);
  }
  const { server } = registration;
  const runner = new TestRunner({ repoPath: repo, consent: () => true });
  const readRemotes = bridgeRemotes(stateDir, keyStore, fetchImpl, "read");
  const writeRemotes = bridgeRemotes(stateDir, keyStore, fetchImpl, "write");
  const verifier = new VerificationRunner({ repoPath: repo, runner, readRemotes, writeRemotes });
  const approver = new ApprovedBranchWriter({ repoPath: repo, writeRemotes });
  const settle = <T>(job: () => Promise<T>): Promise<T | Error> => job().catch((error: unknown) => error as Error);
  return async () => ({
    combined: await settle(() =>
      combinedRunPass({
        claim: () => claimCombinedRuns(server, bridgeToken, fetchImpl),
        report: (event) => reportCombinedRun(server, bridgeToken, event, fetchImpl),
        fetchForks: forkFetcher(readRemotes, repo),
        repoPath: repo,
        runner,
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
  });
}

/** True when every job ran and nothing in them was refused or stopped. */
function testJobsClean({ combined, verification, approval }: TestJobsResult): boolean {
  if (combined instanceof Error || verification instanceof Error || approval instanceof Error) return false;
  const combinedClean = combined.batches.every((batch) => batch.error === null && batch.refused.length === 0);
  return combinedClean && verification.failed.length === 0 && approval.failed.length === 0;
}

/** The pass's lines; `always` writes a job's summary even when it found no work. */
function formatTestJobs({ combined, verification, approval }: TestJobsResult, always: boolean): string {
  let text = "";
  if (combined instanceof Error) text += `No combined runs were claimed: ${combined.message}\n`;
  else if (always || combined.claimed > 0) text += formatCombinedPass(combined);
  if (verification instanceof Error) text += `The verification pass did not run; the runs stay pending: ${verification.message}\n`;
  else if (always || verification.listed > 0) text += formatVerificationPass(verification);
  if (approval instanceof Error) text += `The approval pass did not run; the approved branches stay listed: ${approval.message}\n`;
  else if (always || approval.listed > 0) text += formatApprovalPass(approval);
  return text;
}
