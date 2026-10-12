// The section 5.1 checks on each merged tree of a block (PRD section 4.5): the originating checkpoint
// merged onto main and onto each affected fork's checkpoint, one target per running feature. Overlap and merge read Git objects;
// lint, format and the type check run ruff and pyright in throwaway worktrees; the dependency diff
// runs the bridge's `analysis:python-dependencies`. Tests are the combined run's own
// (combined-run.ts). Every check is a mechanical fact about code; none calls a model.
//
// Lint, format and type findings are those of the merged tree that the target's own tree does not
// have, so a finding that was already on the target's side is never blamed on the merge.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changedPathsBetween, runGit } from "@penguin/git-analysis";
import {
  BLOCK_CHECK_LIMITS,
  CHECK_COMMAND_IDS,
  checkDependencyReport,
  DEPENDENCY_COMMAND_ID,
  DEPENDENCY_TOOL,
  type BlockCheck,
  type BlockCheckFinding,
  type BlockCheckName,
  type BlockCheckResult,
  type DependencyReport,
} from "@penguin/protocol";

import { newFindings, type CheckTools, type ToolRun } from "./check-tools.ts";
import { fingerprint } from "./fingerprint.ts";
import { runPythonAnalysis, type ImpactRequest, type PythonImpactOptions } from "./impact-analysis.ts";
import { inDetachedWorktree } from "./test-runner.ts";

export type DependencyAnalyzer = (request: ImpactRequest) => Promise<DependencyReport>;

/** An analyzer that runs `analysis:python-dependencies` in `repoPath` and checks its report. */
export function pythonDependencyAnalyzer(options: PythonImpactOptions): DependencyAnalyzer {
  return (request) => runPythonAnalysis<DependencyReport>(DEPENDENCY_COMMAND_ID, checkDependencyReport, options, request);
}

/** How the originating checkpoint merged onto one target. */
export type TargetMerge =
  | { readonly kind: "clean"; readonly tree: string; readonly commit: string }
  | { readonly kind: "conflict"; readonly conflictedPaths: readonly string[] };

/** One merged tree of the block. */
export interface BlockTarget {
  /** `main`, or the affected fork's target id: a running feature's id, or a person's for an owner fork. */
  readonly id: string;
  /** The target's own commit: main's, or the fork's latest checkpoint. */
  readonly commit: string;
  /** The target's scopes, searched for uses of a changed library; empty searches the whole tree. */
  readonly scopes: readonly string[];
  /** Whether the impact graph selects the target; the type check runs only when it does. */
  readonly affected: boolean;
  readonly merge: TargetMerge;
  readonly mergeMs: number;
}

export interface BlockCheckRequest {
  /** The merge plan the block belongs to, or null for a combined run. */
  readonly planId: string | null;
  /** The originating checkpoint. */
  readonly origin: string;
  /** The commit the originating checkpoint was made from. */
  readonly baseline: string;
  readonly targets: readonly BlockTarget[];
}

export interface BlockCheckerOptions {
  readonly repoPath: string;
  readonly tools: CheckTools;
  /** The dependency diff; without one, the check reports an error for every target. */
  readonly dependencies?: DependencyAnalyzer;
  /** Directory that holds the temporary worktrees. Defaults to the OS temp directory. */
  readonly scratchDir?: string;
}

/** The checks of one block, with each tool's raw output kept on the runner by its `logRef`. */
export interface BlockCheckRun {
  readonly checks: readonly BlockCheck[];
  readonly logs: ReadonlyMap<string, string>;
  readonly dependencies: DependencyReport | null;
  readonly dependencyError: string | null;
  readonly durationMs: number;
}

const TOOL_NAMES: Record<Exclude<BlockCheckName, "tests" | "retiring">, string> = {
  overlap: "git diff",
  merge: "git merge-tree",
  lint: "ruff",
  format: "ruff",
  dependencies: DEPENDENCY_TOOL,
  typecheck: "pyright",
};

/** Runs the section 5.1 checks on every merged tree of a block. */
export class BlockChecker {
  readonly #options: BlockCheckerOptions;

  constructor(options: BlockCheckerOptions) {
    this.#options = options;
  }

  async check(request: BlockCheckRequest): Promise<BlockCheckRun> {
    const started = performance.now();
    const logs = new Map<string, string>();
    const { report, error, ms } = await this.#dependencies(request);
    const checks: BlockCheck[] = [];
    for (const target of request.targets) {
      checks.push(...(await this.#checkTarget(request, target, { report, error, ms }, logs)));
    }
    return { checks, logs, dependencies: report, dependencyError: error, durationMs: elapsed(started) };
  }

  async #dependencies(request: BlockCheckRequest) {
    const started = performance.now();
    const analyzer = this.#options.dependencies;
    if (analyzer === undefined) return { report: null, error: "no dependency analysis is configured", ms: 0 };
    try {
      const forks = request.targets.map((target) => ({ id: target.id, sha: target.commit, scopes: target.scopes }));
      const report = await analyzer({ base: request.baseline, head: request.origin, forks });
      return { report, error: null, ms: elapsed(started) };
    } catch (failure) {
      return { report: null, error: (failure as Error).message, ms: elapsed(started) };
    }
  }

  async #checkTarget(
    request: BlockCheckRequest,
    target: BlockTarget,
    dependencies: { report: DependencyReport | null; error: string | null; ms: number },
    logs: Map<string, string>,
  ): Promise<BlockCheck[]> {
    const { repoPath } = this.#options;
    const merged = target.merge.kind === "clean" ? target.merge.commit : null;
    const base = (check: Exclude<BlockCheckName, "tests" | "retiring">, commandId: string): BlockCheckBase => ({
      planId: request.planId,
      target: target.id,
      check,
      tool: { name: TOOL_NAMES[check], version: null, commandId },
      input: { origin: request.origin, target: target.commit, merged, paths: null },
    });
    const checks: BlockCheck[] = [await this.#overlap(base("overlap", CHECK_COMMAND_IDS.overlap), request.origin, target)];

    const mergeBase = base("merge", CHECK_COMMAND_IDS.merge);
    if (target.merge.kind === "conflict") {
      const findings = target.merge.conflictedPaths.map((path) => finding(path, null, null, "conflicts"));
      checks.push(record(mergeBase, "failed", findings, `${findings.length} conflicted path${plural(findings.length)}`, target.mergeMs));
    } else {
      checks.push(record(mergeBase, "passed", [], "merges cleanly", target.mergeMs));
    }
    checks.push(dependencyCheck(base("dependencies", CHECK_COMMAND_IDS.dependencies), target, dependencies));

    const lint = base("lint", CHECK_COMMAND_IDS.lint);
    const format = base("format", CHECK_COMMAND_IDS.format);
    const typecheck = base("typecheck", CHECK_COMMAND_IDS.typecheck);
    if (target.merge.kind === "conflict") {
      for (const check of [lint, format, typecheck]) checks.push(record(check, "not-run", [], "the merge conflicts", 0));
      return checks;
    }
    const mergedCommit = target.merge.commit;
    // The Python files the merge changes on the target's side: the ones lint and format read.
    const paths = (await changedPathsBetween(repoPath, target.commit, mergedCommit)).filter((path) => path.endsWith(".py"));
    const withTools = async (commit: string, run: (worktree: string) => Promise<TreeRuns>) =>
      (await inDetachedWorktree(repoPath, commit, this.#options.scratchDir ?? tmpdir(), run)).value;
    const runTools = (affected: boolean) => async (worktree: string): Promise<TreeRuns> => {
      const present = paths.filter((path) => existsSync(join(worktree, path)));
      return {
        lint: await timed(() => (present.length === 0 ? undefined : this.#options.tools.lint(worktree, present))),
        format: await timed(() => (present.length === 0 ? undefined : this.#options.tools.format(worktree, present))),
        typecheck: await timed(() => (affected ? this.#options.tools.typecheck(worktree) : undefined)),
      };
    };
    const needed = paths.length > 0 || target.affected;
    const mergedRuns = needed ? await withTools(mergedCommit, runTools(target.affected)) : EMPTY_RUNS;
    const targetRuns = needed ? await withTools(target.commit, runTools(target.affected)) : EMPTY_RUNS;

    const toolCheck = async (
      check: BlockCheckBase,
      name: keyof TreeRuns,
      inputPaths: readonly string[] | null,
      skipped: { result: BlockCheckResult; summary: string },
    ): Promise<BlockCheck> => {
      const ours = mergedRuns[name];
      const theirs = targetRuns[name];
      const withPaths = { ...check, input: { ...check.input, paths: inputPaths } };
      if (ours.run === undefined) return record(withPaths, skipped.result, [], skipped.summary, 0);
      const durationMs = ours.ms + theirs.ms;
      const tool = ours.run.tool;
      const fingerprinted = { ...withPaths, tool, fingerprint: await fingerprint(repoPath, mergedCommit, tool.commandId) };
      logs.set(ours.run.logRef, ours.run.log);
      const failure = ours.run.error ?? theirs.run?.error ?? null;
      if (failure !== null) return { ...record(fingerprinted, "error", [], failure, durationMs), logRef: ours.run.logRef };
      const found = newFindings(ours.run.findings, theirs.run?.findings ?? []);
      const before = (theirs.run?.findings.length ?? 0) - (ours.run.findings.length - found.length);
      const summary =
        found.length === 0
          ? `no new ${NOUNS[name][1]}${ours.run.findings.length > 0 ? ` (${ours.run.findings.length} already on ${target.id})` : ""}`
          : `${found.length} new ${NOUNS[name][found.length === 1 ? 0 : 1]}${before > 0 ? `; ${before} fixed by the merge` : ""}`;
      return { ...record(fingerprinted, found.length === 0 ? "passed" : "failed", found, summary, durationMs), logRef: ours.run.logRef };
    };
    const noFiles = { result: "passed" as const, summary: "the merge changes no Python file" };
    checks.push(await toolCheck(lint, "lint", paths, noFiles));
    checks.push(await toolCheck(format, "format", paths, noFiles));
    checks.push(
      await toolCheck(typecheck, "typecheck", null, {
        result: "not-affected",
        summary: "the impact graph shows no use of the change",
      }),
    );
    return checks;
  }

  async #overlap(check: BlockCheckBase, origin: string, target: BlockTarget): Promise<BlockCheck> {
    const started = performance.now();
    const { repoPath } = this.#options;
    try {
      const mergeBase = (await runGit(repoPath, ["merge-base", "--end-of-options", origin, target.commit])).trim();
      const ours = await changedPathsBetween(repoPath, mergeBase, origin);
      const theirs = new Set(await changedPathsBetween(repoPath, mergeBase, target.commit));
      const shared = ours.filter((path) => theirs.has(path));
      const findings: BlockCheckFinding[] = [];
      let sameHunks = 0;
      for (const path of shared) {
        const a = await hunks(repoPath, mergeBase, origin, path);
        const b = await hunks(repoPath, mergeBase, target.commit, path);
        const overlapping = a.filter((x) => b.some((y) => x[0] <= y[1] && y[0] <= x[1]));
        if (overlapping.length > 0) sameHunks += 1;
        const [first] = overlapping;
        findings.push(
          first === undefined
            ? finding(path, null, null, "changed in both, in different hunks")
            : finding(path, first[0], null, `changed in both, in the same hunk at line${lineSpan(first)} of the merge base`),
        );
      }
      const summary =
        shared.length === 0
          ? "no file changed in both"
          : `${shared.length} file${plural(shared.length)} changed in both, ${sameHunks} in the same hunks`;
      return record(check, sameHunks > 0 ? "failed" : "passed", findings, summary, elapsed(started));
    } catch (failure) {
      return record(check, "error", [], (failure as Error).message, elapsed(started));
    }
  }
}

type BlockCheckBase = Pick<BlockCheck, "planId" | "target" | "check" | "tool" | "input">;

interface TimedRun {
  readonly run: ToolRun | undefined;
  readonly ms: number;
}

interface TreeRuns {
  readonly lint: TimedRun;
  readonly format: TimedRun;
  readonly typecheck: TimedRun;
}

const EMPTY_RUNS: TreeRuns = {
  lint: { run: undefined, ms: 0 },
  format: { run: undefined, ms: 0 },
  typecheck: { run: undefined, ms: 0 },
};

const NOUNS: Record<keyof TreeRuns, readonly [string, string]> = {
  lint: ["lint finding", "lint findings"],
  format: ["file to reformat", "files to reformat"],
  typecheck: ["type error", "type errors"],
};

async function timed(run: () => Promise<ToolRun> | undefined): Promise<TimedRun> {
  const started = performance.now();
  const result = await run();
  return { run: result, ms: elapsed(started) };
}

function dependencyCheck(
  check: BlockCheckBase,
  target: BlockTarget,
  { report, error, ms }: { report: DependencyReport | null; error: string | null; ms: number },
): BlockCheck {
  if (report === null) return record(check, "error", [], error ?? "the dependency diff did not run", ms);
  const uses = report.forks.find((fork) => fork.id === target.id)?.uses ?? [];
  const changes = report.changes.map((change) => {
    const from = change.before ?? "absent";
    const to = change.after ?? "absent";
    const origin = change.origin === undefined ? "" : `, from ${change.origin.before} to ${change.origin.after}`;
    return finding(change.path, null, change.source, `${change.library} ${from} -> ${to}${origin}`);
  });
  const used = uses.map((use) => finding(use.path, use.line, null, `imports ${use.module} (${use.library})`));
  if (changes.length === 0) return record(check, "passed", [], "no library changed version", ms);
  const libraries = new Set(uses.map((use) => use.library));
  const summary =
    uses.length === 0
      ? `${changes.length} librar${changes.length === 1 ? "y" : "ies"} changed version; ${target.id} imports none`
      : `${[...libraries].join(", ")} changed version; ${target.id} imports it in ${uses.length} place${plural(uses.length)}`;
  return record(check, uses.length === 0 ? "passed" : "failed", [...changes, ...used], summary, ms);
}

function record(
  check: BlockCheckBase & Partial<Pick<BlockCheck, "fingerprint">>,
  result: BlockCheckResult,
  findings: readonly BlockCheckFinding[],
  summary: string,
  durationMs: number,
): BlockCheck {
  return {
    ...check,
    input: { ...check.input, paths: check.input.paths?.slice(0, 2_000) ?? null },
    result,
    findings: findings.slice(0, BLOCK_CHECK_LIMITS.findingsPerCheck).map(clip),
    findingCount: findings.length,
    summary: truncate(summary),
    fingerprint: check.fingerprint ?? null,
    logRef: null,
    durationMs: Math.round(durationMs),
  };
}

export function finding(path: string | null, line: number | null, code: string | null, message: string): BlockCheckFinding {
  return { path, line, code, message };
}

function clip(item: BlockCheckFinding): BlockCheckFinding {
  return {
    path: item.path === null ? null : item.path.slice(0, BLOCK_CHECK_LIMITS.pathLength),
    line: item.line,
    code: item.code === null ? null : item.code.slice(0, 128),
    message: truncate(item.message),
  };
}

function truncate(text: string): string {
  const limit = BLOCK_CHECK_LIMITS.messageLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

const elapsed = (started: number) => performance.now() - started;
const plural = (count: number) => (count === 1 ? "" : "s");
const lineSpan = ([start, end]: readonly [number, number]) => (start === end ? ` ${start}` : `s ${start}-${end}`);

/**
 * The checks as text for a terminal, a feature page or the walkthrough: per target, each check with
 * its result, the tool and command ID that produced it, its time, and its findings.
 */
export function formatBlockChecks(checks: readonly BlockCheck[]): string {
  const lines: string[] = [];
  const byTarget = new Map<string, BlockCheck[]>();
  for (const check of checks) byTarget.set(check.target, [...(byTarget.get(check.target) ?? []), check]);
  for (const [target, group] of byTarget) {
    const { input } = group[0] as BlockCheck;
    const merged = input.merged === null ? "no merged tree" : `merged ${input.merged.slice(0, 12)}`;
    lines.push(`${input.origin.slice(0, 12)} onto ${target}@${input.target.slice(0, 12)} (${merged})`);
    for (const check of group) lines.push(...formatCheck(check));
  }
  return `${lines.join("\n")}\n`;
}

function formatCheck(check: BlockCheck): string[] {
  const version = check.tool.version === null ? "" : ` ${check.tool.version}`;
  const lines = [
    `  ${check.check} ${check.result}: ${check.summary} [${check.tool.name}${version}, ${check.tool.commandId}, ${check.durationMs} ms]`,
  ];
  for (const item of check.findings) {
    const place = item.path === null ? "" : `${item.path}${item.line === null ? "" : `:${item.line}`} `;
    lines.push(`    ${place}${item.code === null ? "" : `${item.code} `}${item.message}`);
  }
  if (check.findingCount > check.findings.length) lines.push(`    ... ${check.findingCount - check.findings.length} more`);
  return lines;
}

// `@@ -<start>[,<count>] +... @@`: the merge base's side of each hunk.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

/**
 * The line ranges of the merge base that a change to one file touches, from a zero-context diff.
 * A pure insertion is the point after its line. The path is a literal pathspec, never pattern magic.
 */
async function hunks(repoPath: string, from: string, to: string, path: string): Promise<[number, number][]> {
  const diff = await runGit(repoPath, [
    "--literal-pathspecs",
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--end-of-options",
    from,
    to,
    "--",
    path,
  ]);
  return [...diff.matchAll(HUNK)].map((match) => {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return count === 0 ? [start, start] : [start, start + count - 1];
  });
}
