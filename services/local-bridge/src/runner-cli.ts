// The `penguin-bridge runner` command: runner mode, one pass or a pass on every interval.

import { parseArgs } from "node:util";

import type { CliIo } from "./cli.ts";
import { penguinRemote } from "./git-remote.ts";
import { defaultClonePath } from "./issue-cli.ts";
import { IssuesClone } from "./issues-clone.ts";
import type { KeyStore } from "./key-store.ts";
import { bridgeRemotes, fetchPendingOperations, openBridge, type Fetch } from "./penguin-client.ts";
import { formatPass, runnerPass, RunnerLoop } from "./runner.ts";
import { bridgeSpool } from "./spool-cli.ts";

export const RUNNER_USAGE = `       penguin-bridge runner [--once] [--interval <ms>] [--branch <name>] [--state-dir <dir>]
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

  if (values.once) {
    try {
      const result = await pass();
      io.write(formatPass(result));
      return result.refused.length > 0 ? 1 : 0;
    } catch (error) {
      io.write(`The pass did not run; the operations stay pending: ${(error as Error).message}\n`);
      return 1;
    }
  }

  const loop = new RunnerLoop({
    pass,
    intervalMs: interval,
    onPass: (result) => {
      if (result.listed > 0) io.write(formatPass(result));
    },
    onError: (error) => io.write(`The pass did not run; the operations stay pending: ${error.message}\n`),
  });
  loop.start();
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await loop.stop();
  return 0;
}
