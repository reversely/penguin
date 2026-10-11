// The `penguin-bridge impact` command: runs the allowlisted `analysis:python-impact` on commits in
// a local repository and prints the impact graph and contract diff, as text or as the JSON report.

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { selectAffectedForks } from "@penguin/protocol";

import type { CliIo } from "./cli.ts";
import { formatImpactReport, pythonImpactAnalyzer, type ImpactForkRequest } from "./impact-analysis.ts";

export const IMPACT_USAGE = `       penguin-bridge impact --base <commit> --head <commit> [--fork <id>=<commit>[:<scope>,...]]...
                      [--repo <path>] [--python <path>] [--json]
         Prints the change's impact graph and contract diff, and each fork's uses of changed symbols.
`;

const FORK_ARGUMENT = /^([^=]+)=([^:]+)(?::(.*))?$/;

/** Resolves a revision to a full commit ID; the revision is never read as an option. */
async function commitOf(repo: string, revision: string): Promise<string> {
  return (await runGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])).trim();
}

/** Runs `impact`. Resolves with the exit code. */
export async function runImpactCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      head: { type: "string" },
      fork: { type: "string", multiple: true, default: [] },
      repo: { type: "string", default: process.cwd() },
      python: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const parsedForks = values.fork.map((text) => FORK_ARGUMENT.exec(text));
  if (!values.base || !values.head || parsedForks.some((match) => match === null)) {
    io.write(IMPACT_USAGE);
    return 2;
  }
  const repo = resolve(values.repo);
  const forks: ImpactForkRequest[] = [];
  for (const match of parsedForks as RegExpExecArray[]) {
    const scopes = (match[3] ?? "").split(",").filter((scope) => scope !== "");
    forks.push({ id: match[1] as string, sha: await commitOf(repo, match[2] as string), scopes });
  }
  const analyze = pythonImpactAnalyzer({ repoPath: repo, python: values.python });
  const report = await analyze({ base: await commitOf(repo, values.base), head: await commitOf(repo, values.head), forks });
  io.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatImpactReport(report, selectAffectedForks(report)));
  return 0;
}
