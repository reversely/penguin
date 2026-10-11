// The `penguin-bridge runner` command: runner mode, one pass or a pass on every interval. With
// --combined it also claims and runs the combined runs Penguin scheduled (combined-run-pass.ts).

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import type { CliIo } from "./cli.ts";
import { combinedRunPass, forkFetcher, formatCombinedPass, type CombinedPassResult } from "./combined-run-pass.ts";
import { penguinRemote } from "./git-remote.ts";
import { defaultClonePath } from "./issue-cli.ts";
import { IssuesClone } from "./issues-clone.ts";
import type { KeyStore } from "./key-store.ts";
import {
  bridgeRemotes,
  claimCombinedRuns,
  fetchPendingOperations,
  openBridge,
  reportCombinedRun,
  type BridgeRegistration,
  type Fetch,
} from "./penguin-client.ts";
import { formatPass, runnerPass, RunnerLoop } from "./runner.ts";
import { bridgeSpool } from "./spool-cli.ts";
import { TestRunner } from "./test-runner.ts";

export const RUNNER_USAGE = `       penguin-bridge runner [--once] [--interval <ms>] [--branch <name>] [--state-dir <dir>]
                      [--combined [--repo <path>]]
`;

const DEFAULT_INTERVAL_MS = 10_000;

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

  const combined = values.combined
    ? await combinedPass(registration, bridgeToken, values.repo ?? join(stateDir, "combined"), stateDir, keyStore, fetchImpl)
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
    if (combined !== undefined) {
      try {
        const result = await combined();
        io.write(formatCombinedPass(result));
        if (result.batches.some((batch) => batch.error !== null || batch.refused.length > 0)) code = 1;
      } catch (error) {
        io.write(`No combined runs were claimed: ${(error as Error).message}\n`);
        code = 1;
      }
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
  // Combined runs run tests for minutes, so they loop on their own and never hold the spool lock.
  const combinedLoop =
    combined === undefined
      ? undefined
      : new RunnerLoop<CombinedPassResult>({
          pass: combined,
          intervalMs: interval,
          onPass: (result) => {
            if (result.claimed > 0) io.write(formatCombinedPass(result));
          },
          onError: (error) => io.write(`No combined runs were claimed: ${error.message}\n`),
        });
  loop.start();
  combinedLoop?.start();
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await Promise.all([loop.stop(), combinedLoop?.stop()]);
  return 0;
}

/**
 * One combined-run pass bound to this runner: claims and reports through Penguin, fetches owner
 * forks with read tokens into `repoPath` (created as an empty repository when missing), and runs
 * each allowlisted test command in a throwaway worktree there. Passing --combined is the operator's
 * consent to run the repository's allowlisted test commands unattended.
 */
async function combinedPass(
  registration: BridgeRegistration,
  bridgeToken: string,
  repoPath: string,
  stateDir: string,
  keyStore: KeyStore,
  fetchImpl: Fetch | undefined,
): Promise<() => Promise<CombinedPassResult>> {
  const repo = resolve(repoPath);
  if (!existsSync(repo)) {
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await runGit(repo, ["init", "--quiet"]);
  }
  const runner = new TestRunner({ repoPath: repo, consent: () => true });
  return () =>
    combinedRunPass({
      claim: () => claimCombinedRuns(registration.server, bridgeToken, fetchImpl),
      report: (event) => reportCombinedRun(registration.server, bridgeToken, event, fetchImpl),
      fetchForks: forkFetcher(bridgeRemotes(stateDir, keyStore, fetchImpl, "read"), repo),
      repoPath: repo,
      runner,
    });
}
