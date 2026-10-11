// The `penguin-bridge review` command: runs the review harness on commits in a local repository and
// prints the result: the form's verdict with every refusal, the exceptions for the scope's owner and
// the side-by-side run of the scope's public functions on main and on the fork.

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";

import type { CliIo } from "./cli.ts";
import { pythonImpactAnalyzer } from "./impact-analysis.ts";
import { formatReviewResult, runReview } from "./review-harness.ts";

export const REVIEW_USAGE = `       penguin-bridge review --base <commit> --fork <commit> --scope <id> --form <file.json>
                      [--repo <path>] [--python <path>] [--no-diff] [--out <file.json>] [--json]
         Checks a review form, runs the scope's public functions on main and on the fork, and
         prints the verdict. Exits 0 when the form is accepted, 1 when it is refused.
`;

const MAX_FORM_BYTES = 1024 * 1024;

/** Resolves a revision to a full commit ID; the revision is never read as an option. */
async function commitOf(repo: string, revision: string): Promise<string> {
  return (await runGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])).trim();
}

/** Runs `review`. Resolves with the exit code. */
export async function runReviewCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      fork: { type: "string" },
      scope: { type: "string" },
      form: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      python: { type: "string" },
      "no-diff": { type: "boolean", default: false },
      out: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.base || !values.fork || !values.scope || !values.form) {
    io.write(REVIEW_USAGE);
    return 2;
  }
  if ((await stat(values.form)).size > MAX_FORM_BYTES) {
    io.write(`the form is over ${MAX_FORM_BYTES} bytes\n`);
    return 2;
  }
  let form: unknown;
  try {
    form = JSON.parse(await readFile(values.form, "utf8"));
  } catch {
    io.write("the form is not JSON\n");
    return 2;
  }
  const repo = resolve(values.repo);
  const python = values.python;
  const result = await runReview(
    {
      repoPath: repo,
      python,
      analyzer: values["no-diff"] ? undefined : pythonImpactAnalyzer({ repoPath: repo, python }),
    },
    { base: await commitOf(repo, values.base), fork: await commitOf(repo, values.fork), scope: values.scope, form },
  );
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out !== undefined) await writeFile(values.out, json);
  io.write(values.json ? json : formatReviewResult(result));
  return result.state === "accepted" ? 0 : 1;
}
