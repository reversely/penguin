// The `penguin-bridge resolve` and `penguin-bridge apply-fix` commands. `resolve` runs the section
// 5.1 checks on local commits, routes each failure through the resolution ladder, applies Penguin's
// fixes for steps 1 to 3 and checks again, then prints every decision and tool run. `apply-fix`
// applies one deterministic fix to one commit.

import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { FIX_KINDS, type CodemodEdit, type FixKind } from "@penguin/protocol";

import { FixApplier } from "./apply-fix.ts";
import { BlockChecker, pythonDependencyAnalyzer } from "./block-checks.ts";
import { checkTools } from "./check-tools.ts";
import type { CliIo } from "./cli.ts";
import { CombinedRunner } from "./combined-run.ts";
import { pythonImpactAnalyzer } from "./impact-analysis.ts";
import { DEFAULT_ROUND_LIMIT, formatResolution, ResolutionLadder } from "./resolution.ts";
import { TestRunner } from "./test-runner.ts";

export const RESOLVE_USAGE = `       penguin-bridge resolve --base <commit> --head <commit> --identity @<owner>/<name>
                      [--checkpoint <owner>=<commit>]... [--main <commit>] [--round-limit <n>] [--repo <path>]
                      [--python <path>] [--ruff <path>] [--uv <path>] [--codemod-python <path>] [--yes] [--write] [--json]
         Checks the head checkpoint merged onto main and onto each owner's checkpoint, routes each failure
         through the resolution ladder, applies Penguin's format, lint, lockfile and codemod fixes, and checks
         again. --write moves each branch named by --head or --checkpoint to its fixed commit.
       penguin-bridge apply-fix --kind format|lint|lockfile|codemod --commit <commit> --allow <path>...
                      [--path <file>]... [--rename <from>=<to>]... [--move <from>=<to>]...
                      [--rename-parameter <function>:<from>=<to>]... [--merge <commit>] [--repo <path>] [--json]
         Applies one deterministic fix to a commit in a throwaway worktree and prints the commit it made.
`;

const PAIR = /^([^=]+)=(.+)$/;
const PARAMETER = /^([^:]+):([^=]+)=(.+)$/;

/** Resolves a revision to a full commit ID; the revision is never read as an option. */
async function commitOf(repo: string, revision: string): Promise<string> {
  return (await runGit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`])).trim();
}

/** The local branch a revision names, or undefined when it names none. */
async function branchOf(repo: string, revision: string): Promise<string | undefined> {
  try {
    await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${revision}`]);
    return `refs/heads/${revision}`;
  } catch {
    return undefined;
  }
}

/** Runs `resolve`. Resolves with 0 when no failure is left, 1 when one is routed to an agent or a person. */
export async function runResolveCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      head: { type: "string" },
      main: { type: "string" },
      identity: { type: "string" },
      checkpoint: { type: "string", multiple: true, default: [] },
      "round-limit": { type: "string", default: String(DEFAULT_ROUND_LIMIT) },
      repo: { type: "string", default: process.cwd() },
      python: { type: "string" },
      ruff: { type: "string" },
      uv: { type: "string" },
      "codemod-python": { type: "string" },
      yes: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const parsed = values.checkpoint.map((text) => PAIR.exec(text));
  const roundLimit = Number(values["round-limit"]);
  if (!values.base || !values.head || !values.identity || parsed.some((match) => match === null) || !Number.isInteger(roundLimit) || roundLimit < 1) {
    io.write(RESOLVE_USAGE);
    return 2;
  }
  const repo = resolvePath(values.repo);
  const named: Record<string, string> = {};
  const latestCheckpoints: Record<string, string> = {};
  for (const match of parsed as RegExpExecArray[]) {
    named[match[1] as string] = match[2] as string;
    latestCheckpoints[match[1] as string] = await commitOf(repo, match[2] as string);
  }
  const baselineSha = await commitOf(repo, values.base);
  const headSha = await commitOf(repo, values.head);
  const runner = new TestRunner({
    repoPath: repo,
    consent: async (request) =>
      values.yes ||
      /^y(es)?$/i.test(
        (await io.ask(`Run ${request.commandId} (${request.command}) on ${request.sha.slice(0, 12)} in a throwaway worktree? [y/N] `)).trim(),
      ),
  });
  const ladder = new ResolutionLadder({
    repoPath: repo,
    combined: new CombinedRunner({
      repoPath: repo,
      runner,
      impact: pythonImpactAnalyzer({ repoPath: repo, python: values.python }),
      checks: new BlockChecker({
        repoPath: repo,
        tools: checkTools({ ruff: values.ruff }),
        dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: values.python }),
      }),
    }),
    fixes: new FixApplier({ repoPath: repo, ruff: values.ruff, uv: values.uv, python: values["codemod-python"] }),
  });
  const result = await ladder.resolve({
    checkpointSha: headSha,
    baselineSha,
    latestCheckpoints,
    mainSha: values.main === undefined ? baselineSha : await commitOf(repo, values.main),
    identity: values.identity,
    roundLimit,
  });
  const moved: string[] = [];
  if (values.write) {
    const updates: [string, string, string][] = [[values.head, headSha, result.checkpointSha]];
    for (const [owner, revision] of Object.entries(named)) {
      updates.push([revision, latestCheckpoints[owner] as string, result.latestCheckpoints[owner] as string]);
    }
    for (const [revision, before, after] of updates) {
      const ref = before === after ? undefined : await branchOf(repo, revision);
      if (ref === undefined) continue;
      // The old value guards the move: a branch that moved meanwhile is left alone.
      await runGit(repo, ["update-ref", "-m", "penguin-bridge resolve", ref, after, before]);
      moved.push(`${ref} ${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
    }
  }
  if (values.json) {
    const { record, checkpointSha, latestCheckpoints: fixed } = result;
    io.write(`${JSON.stringify({ record, checkpointSha, latestCheckpoints: fixed, moved }, null, 2)}\n`);
  } else {
    io.write(formatResolution(result));
    for (const line of moved) io.write(`moved ${line}\n`);
  }
  return result.record.routedToAgents + result.record.routedToPeople === 0 ? 0 : 1;
}

/** Runs `apply-fix`. Resolves with 0 when the fix changed files or had nothing to change, 1 otherwise. */
export async function runApplyFixCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      kind: { type: "string" },
      commit: { type: "string" },
      path: { type: "string", multiple: true, default: [] },
      allow: { type: "string", multiple: true, default: [] },
      rename: { type: "string", multiple: true, default: [] },
      move: { type: "string", multiple: true, default: [] },
      "rename-parameter": { type: "string", multiple: true, default: [] },
      merge: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      ruff: { type: "string" },
      uv: { type: "string" },
      python: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const edits: CodemodEdit[] = [];
  for (const kind of ["rename", "move"] as const) {
    for (const text of values[kind]) {
      const match = PAIR.exec(text);
      if (match === null) return usage(io);
      edits.push({ kind, from: match[1] as string, to: match[2] as string });
    }
  }
  for (const text of values["rename-parameter"]) {
    const match = PARAMETER.exec(text);
    if (match === null) return usage(io);
    edits.push({ kind: "rename-parameter", function: match[1] as string, from: match[2] as string, to: match[3] as string });
  }
  if (!values.kind || !(FIX_KINDS as readonly string[]).includes(values.kind) || !values.commit) return usage(io);
  const repo = resolvePath(values.repo);
  const run = await new FixApplier({ repoPath: repo, ruff: values.ruff, uv: values.uv, python: values.python }).apply({
    kind: values.kind as FixKind,
    commit: await commitOf(repo, values.commit),
    paths: values.path,
    allowed: values.allow,
    ...(edits.length === 0 ? {} : { edits }),
    ...(values.merge === undefined ? {} : { merge: await commitOf(repo, values.merge) }),
  });
  if (values.json) io.write(`${JSON.stringify({ record: run.record, commit: run.commit }, null, 2)}\n`);
  else {
    const { record } = run;
    io.write(`${record.tool} ${record.commandId ?? ""}: ${record.result}, ${record.summary} [${record.durationMs} ms]\n`);
    for (const path of record.changed?.paths ?? []) io.write(`  changed ${path}\n`);
    for (const finding of record.findings) io.write(`  ${finding.path ?? ""} ${finding.code ?? ""} ${finding.message}\n`);
    if (run.commit !== null) io.write(`commit ${run.commit}\n`);
  }
  return run.record.result === "changed" || run.record.result === "unchanged" ? 0 : 1;
}

function usage(io: CliIo): number {
  io.write(RESOLVE_USAGE);
  return 2;
}
