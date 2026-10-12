// The `penguin-bridge edits` command: the person's bridge runs their queued edit tasks headless
// (edit-run.ts, PRD 0.5 section 4.4a). One pass, or a pass on every interval until interrupted. An
// interrupt stops every running CLI and reports each task as stopped, so Penguin asks the person at
// once instead of waiting for the claim to run out.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { RUNNER_INTERVAL_MS } from "@penguin/protocol";

import { sendCheckpointReport } from "./checkpoint-report.ts";
import type { CliIo } from "./cli.ts";
import { bridgeConsent } from "./consent-store.ts";
import { EDIT_RUN_TIMEOUT_DEFAULT_MS, EDIT_VENDORS, editPass, formatEditPass, runEditTask, type EditPassResult, type EditVendor } from "./edit-run.ts";
import { penguinRemote } from "./git-remote.ts";
import type { KeyStore } from "./key-store.ts";
import { bridgeRemotes, claimEditTasks, openBridge, reportEditTask, type Fetch } from "./penguin-client.ts";
import { RunnerLoop } from "./runner.ts";
import type { CheckpointReportEntry } from "./spool.ts";

export const EDITS_USAGE = `       penguin-bridge edits [--once] [--interval <ms>] [--vendor claude|codex] [--program <path>]
                      [--model <name>] [--timeout-minutes <n>] [--repo <path>] [--project <id>]
                      [--state-dir <dir>]
         Claims the edit tasks Penguin routed to your steward and builders, at most the project's
         cap at once, and runs each headless in a fresh worktree of its fork: claude -p with file
         tools only, or codex exec in the workspace-write sandbox. Each result is shown before it is
         published, and your yes stands for later results of the same identity on the same fork.
         A review form runs read-only on the part's trial tree with Penguin's MCP server and a
         token for that task alone; the agent submits the form itself.
`;

/** Runs `edits`. Resolves with the exit code. */
export async function runEditsCommand(args: readonly string[], io: CliIo, keyStore: KeyStore, defaultStateDir: string, fetchImpl?: Fetch): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      once: { type: "boolean", default: false },
      interval: { type: "string" },
      vendor: { type: "string", default: "claude" },
      program: { type: "string" },
      model: { type: "string" },
      "timeout-minutes": { type: "string" },
      repo: { type: "string" },
      project: { type: "string", default: "default" },
      "state-dir": { type: "string" },
    },
    strict: true,
  });
  const interval = Number(values.interval ?? RUNNER_INTERVAL_MS);
  const minutes = values["timeout-minutes"] === undefined ? EDIT_RUN_TIMEOUT_DEFAULT_MS / 60_000 : Number(values["timeout-minutes"]);
  if (!Number.isInteger(interval) || interval <= 0 || !Number.isInteger(minutes) || minutes <= 0 || !(EDIT_VENDORS as readonly string[]).includes(values.vendor)) {
    io.write(EDITS_USAGE);
    return 2;
  }
  const stateDir = values["state-dir"] ?? defaultStateDir;
  const { registration, bridgeToken } = await openBridge(stateDir, keyStore);
  const repo = resolve(values.repo ?? join(stateDir, "edits", "repo"));
  if (!existsSync(repo)) {
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await runGit(repo, ["init", "--quiet"]);
  }
  const stop = new AbortController();
  const options = {
    repoPath: repo,
    worktreeRoot: join(stateDir, "edits", "worktrees"),
    vendor: {
      vendor: values.vendor as EditVendor,
      timeoutMs: minutes * 60_000,
      ...(values.program === undefined ? {} : { program: values.program }),
      ...(values.model === undefined ? {} : { model: values.model }),
    },
    consent: bridgeConsent(stateDir),
    confirm: async (preview: string) => /^y(es)?$/iu.test((await io.ask(`${preview}Publish it? [y/N] `)).trim()),
    write: io.write,
    projectId: values.project,
    // A review run's CLI reaches Penguin's MCP server on the same origin the bridge registered with.
    mcpUrl: new URL("/mcp", registration.server).toString(),
    // A review's trial tree reads the target's and the fix's repos with this bridge's read tokens.
    readRemote: bridgeRemotes(stateDir, keyStore, fetchImpl, "read"),
  };
  const pass = (): Promise<EditPassResult> =>
    editPass({
      claim: () => claimEditTasks(registration.server, bridgeToken, fetchImpl),
      run: (claimed, signal) => runEditTask(options, claimed, signal),
      report: (taskId, report) => reportEditTask(registration.server, bridgeToken, taskId, report, fetchImpl),
      // The person's own feature fork records the commit as its checkpoint; Penguin refuses another's.
      checkpoint: (fork, sha) => sendCheckpointReport(registration.server, bridgeToken, { kind: "checkpoint-report", id: `edit-${sha}`, fork: penguinRemote(fork), sha } as CheckpointReportEntry, fetchImpl),
      signal: stop.signal,
    });

  if (values.once) {
    try {
      const result = await pass();
      io.write(formatEditPass(result, registration.owner));
      return result.runs.every((run) => run.error === null && run.report?.status === "done") ? 0 : 1;
    } catch (error) {
      io.write(`No edit tasks were claimed: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const loop = new RunnerLoop<EditPassResult>({
    pass,
    intervalMs: interval,
    onPass: (result) => io.write(formatEditPass(result, registration.owner)),
    onError: (error) => io.write(`No edit tasks were claimed: ${error.message}\n`),
  });
  loop.start();
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  stop.abort();
  await loop.stop();
  return 0;
}
