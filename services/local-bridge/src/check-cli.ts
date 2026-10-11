// The `penguin-bridge check` command: runs a combined run with the section 5.1 checks on commits in
// a local repository and prints each check on each merged tree, as text or as JSON.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import { BlockChecker, formatBlockChecks, pythonDependencyAnalyzer } from "./block-checks.ts";
import { checkTools } from "./check-tools.ts";
import type { CliIo } from "./cli.ts";
import { CombinedRunner } from "./combined-run.ts";
import { pythonImpactAnalyzer } from "./impact-analysis.ts";
import { TestRunner } from "./test-runner.ts";

export const CHECK_USAGE = `       penguin-bridge check --base <commit> --head <commit> [--checkpoint <owner>=<commit>]...
                      [--main <commit>] [--repo <path>] [--python <path>] [--ruff <path>] [--yes] [--json]
         Merges the head checkpoint onto main and onto each owner's checkpoint, runs overlap, merge,
         lint, format, dependency diff and type check on every merged tree, and runs the tests of
         each dependent scope the impact graph selects. Asks before each test run unless --yes.
`;

const CHECKPOINT_ARGUMENT = /^([^=]+)=(.+)$/;

/** Resolves a revision to a full commit ID; the revision is never read as an option. */
async function commitOf(repo: string, revision: string): Promise<string> {
  return (await runGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])).trim();
}

/** Runs `check`. Resolves with 0 when every check and test passed or did not apply, 1 otherwise. */
export async function runCheckCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      head: { type: "string" },
      main: { type: "string" },
      checkpoint: { type: "string", multiple: true, default: [] },
      repo: { type: "string", default: process.cwd() },
      python: { type: "string" },
      ruff: { type: "string" },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const parsed = values.checkpoint.map((text) => CHECKPOINT_ARGUMENT.exec(text));
  if (!values.base || !values.head || parsed.some((match) => match === null)) {
    io.write(CHECK_USAGE);
    return 2;
  }
  const repo = resolve(values.repo);
  const latestCheckpoints: Record<string, string> = {};
  for (const match of parsed as RegExpExecArray[]) {
    latestCheckpoints[match[1] as string] = await commitOf(repo, match[2] as string);
  }
  const baselineSha = await commitOf(repo, values.base);
  const runner = new TestRunner({
    repoPath: repo,
    consent: async (request) =>
      values.yes ||
      /^y(es)?$/i.test(
        (await io.ask(`Run ${request.commandId} (${request.command}) on ${request.sha.slice(0, 12)} in a throwaway worktree? [y/N] `)).trim(),
      ),
  });
  const report = await new CombinedRunner({
    repoPath: repo,
    runner,
    impact: pythonImpactAnalyzer({ repoPath: repo, python: values.python }),
    checks: new BlockChecker({
      repoPath: repo,
      tools: checkTools({ ruff: values.ruff }),
      dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: values.python }),
    }),
  }).run({
    checkpointSha: await commitOf(repo, values.head),
    baselineSha,
    latestCheckpoints,
    mainSha: values.main === undefined ? baselineSha : await commitOf(repo, values.main),
  });
  const checks = report.checks ?? [];
  if (values.json) {
    const results = report.results.map((result) => ("log" in result ? { ...result, log: undefined } : result));
    const { notAffected, impactError, dependencies, durationMs } = report;
    io.write(`${JSON.stringify({ results, notAffected, impactError, dependencies, checks, durationMs }, null, 2)}\n`);
  } else {
    io.write(formatBlockChecks(checks));
    if (report.impactError) io.write(`The impact analysis failed, so every dependent scope's tests ran: ${report.impactError}\n`);
    io.write(`${checks.length} checks in ${report.durationMs} ms.\n`);
  }
  return checks.some((check) => check.result === "failed" || check.result === "error") ? 1 : 0;
}
