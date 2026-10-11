// The facts of a merge plan that need the code read or run (PRD 0.4 section 4.2 step 2), made on the
// check runner. For one feature checkpoint Penguin lists the targets: main, at the checkpoint's
// baseline, and each running feature that may read what the checkpoint changes, at its latest
// checkpoint. The runner:
//
// 1. runs `analysis:python-impact` on baseline..checkpoint with one fork per running feature, which
//    gives the contract diff, the callers already on main and each feature's uses;
// 2. merges the checkpoint onto each target with `git merge-tree --write-tree`;
// 3. runs each listed `test:<scope>` command on the merged commit in a throwaway worktree, except on
//    a feature the impact graph shows does not use the change;
// 4. states each failing test as a break: its docstring at the merged commit and the assertion and
//    error lines pytest printed.
//
// The report carries no log. Every step is a local Git, analysis or test command; nothing calls a model.

import { commitMergedTree, isObjectId, simulateMerge } from "@penguin/git-analysis";
import {
  PLAN_LIMITS,
  PLAN_MAIN_TARGET,
  selectAffectedForks,
  type ImpactReport,
  type PlanBreak,
  type PlanFactsReport,
  type PlanFactsRequest,
  type PlanFactsResult,
  type PlanFactsTarget,
} from "@penguin/protocol";

import { parseFailingTests } from "./combined-run.ts";
import { resolveCommand } from "./command-allowlist.ts";
import { fingerprint } from "./fingerprint.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import { fetchRepoBranches, hasCommit } from "./runner-repo.ts";
import type { RemoteResolver } from "./git-remote.ts";
import { readCommittedFile } from "./side-by-side.ts";
import { failureLines, testDocstring, testFunctionName } from "./test-evidence.ts";
import type { TestRunner } from "./test-runner.ts";

export interface PlanFactsRunnerOptions {
  /** The repository that holds the checkpoint, its baseline and every target's commit. */
  readonly repoPath: string;
  readonly runner: TestRunner;
  readonly impact: ImpactAnalyzer;
}

/** The repo a facts run fetches: the originating fork and each running feature's fork. */
const FEATURE_REPO = /^feature-[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

/** Checks a listed request before anything runs: full SHAs, feature forks and test command IDs only. */
export function checkFactsRequest(request: PlanFactsRequest): void {
  const shas = [request.checkpoint, request.baseline, ...request.targets.map((target) => target.sha)];
  for (const sha of shas) if (!isObjectId(sha)) throw new Error(`${JSON.stringify(sha)} is not a full object ID`);
  for (const repo of [request.fork, ...request.targets.map((target) => target.repo)]) {
    if (!FEATURE_REPO.test(repo)) throw new Error(`${JSON.stringify(repo)} is not a feature fork`);
  }
  if (request.targets.length > PLAN_LIMITS.targets) throw new Error(`a facts run lists at most ${PLAN_LIMITS.targets} targets`);
  for (const target of request.targets) {
    if (target.commandIds.length > PLAN_LIMITS.commandsPerTarget) throw new Error(`target ${target.id} lists too many commands`);
  }
}

export class PlanFactsRunner {
  readonly #options: PlanFactsRunnerOptions;

  constructor(options: PlanFactsRunnerOptions) {
    this.#options = options;
  }

  /**
   * Makes the facts of one request. A failed analysis is reported as `impactError`, and then every
   * target's tests run, since no feature can be shown to be unaffected.
   *
   * Raises:
   *   Error: when the request is malformed or a commit it names is not in the repository.
   */
  async run(request: PlanFactsRequest): Promise<PlanFactsReport> {
    checkFactsRequest(request);
    const { repoPath } = this.#options;
    for (const sha of [request.checkpoint, request.baseline, ...request.targets.map((target) => target.sha)]) {
      if (!(await hasCommit(repoPath, sha))) throw new Error(`commit ${sha} is not in the runner's repository`);
    }
    const started = performance.now();
    const features = request.targets.filter((target) => target.id !== PLAN_MAIN_TARGET);
    let impact: ImpactReport | null = null;
    let impactError: string | null = null;
    try {
      impact = await this.#options.impact({
        base: request.baseline,
        head: request.checkpoint,
        forks: features.map(({ id, sha, scopes }) => ({ id, sha, scopes })),
      });
    } catch (error) {
      impactError = clip((error as Error).message, 4_096);
    }
    const selected = impact === null ? undefined : new Set(selectAffectedForks(impact));
    const results: PlanFactsResult[] = [];
    for (const target of request.targets) {
      const affected = target.id === PLAN_MAIN_TARGET || selected === undefined || selected.has(target.id);
      results.push(...(await this.#target(request.checkpoint, target, affected)));
    }
    return { impact, impactError, results, durationMs: Math.round(performance.now() - started) };
  }

  async #target(checkpoint: string, target: PlanFactsTarget, affected: boolean): Promise<PlanFactsResult[]> {
    const { repoPath } = this.#options;
    const base = (commandId: string) => ({
      target: target.id,
      scopeId: commandId.slice("test:".length),
      commandId,
      fingerprint: null,
      breaks: [],
      durationMs: 0,
    });
    const merge = await simulateMerge(repoPath, checkpoint, target.sha);
    if (merge.kind === "conflict") {
      const reason = clip(`the merge conflicts in ${merge.conflictedPaths.join(", ")}`, PLAN_LIMITS.failureLineLength);
      return target.commandIds.map((id) => ({ ...base(id), status: "conflict", merged: null, reason }));
    }
    const merged = await commitMergedTree(repoPath, merge.tree, [checkpoint, target.sha]);
    if (!affected) {
      return target.commandIds.map((id) => ({ ...base(id), status: "not-affected", merged, reason: null }));
    }
    const results: PlanFactsResult[] = [];
    for (const commandId of target.commandIds) {
      try {
        await resolveCommand(repoPath, merged, commandId);
      } catch (error) {
        const reason = clip((error as Error).message, PLAN_LIMITS.failureLineLength);
        results.push({ ...base(commandId), status: "not-run", merged, reason });
        continue;
      }
      results.push(await this.#test(target.id, commandId, merged));
    }
    return results;
  }

  async #test(target: string, commandId: string, merged: string): Promise<PlanFactsResult> {
    const { repoPath, runner } = this.#options;
    const started = performance.now();
    const outcome = await runner.run({ commandId, sha: merged });
    const passed = outcome.exitCode === 0 && outcome.signal === null;
    const failing = passed ? [] : parseFailingTests(outcome.log).slice(0, PLAN_LIMITS.breaksPerResult);
    const lines = failureLines(outcome.log, failing.map((test) => test.nodeId));
    const breaks: PlanBreak[] = [];
    for (const { nodeId } of failing) {
      const file = nodeId.slice(0, nodeId.indexOf("::"));
      const source = file === "" ? null : await readCommittedFile(repoPath, merged, file).catch(() => null);
      const found = lines.get(nodeId);
      breaks.push({
        nodeId: clip(nodeId, 512),
        docstring: source === null ? null : (testDocstring(source, testFunctionName(nodeId)) ?? null),
        assertion: found?.assertion ?? null,
        error: found?.error ?? null,
      });
    }
    return {
      target,
      scopeId: commandId.slice("test:".length),
      commandId,
      status: passed ? "passed" : "failed",
      merged,
      fingerprint: { ...(await fingerprint(repoPath, merged, commandId)) },
      breaks,
      reason: null,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** Fetches the originating fork and every target's fork into `repoPath` with read tokens. */
export function factsFetcher(remotes: RemoteResolver, repoPath: string): (request: PlanFactsRequest) => Promise<void> {
  return async (request) => {
    checkFactsRequest(request);
    for (const repo of new Set([request.fork, ...request.targets.map((target) => target.repo)])) {
      await fetchRepoBranches(repoPath, remotes, repo);
    }
  };
}

export interface PlanFactsPassOptions {
  readonly list: () => Promise<readonly PlanFactsRequest[]>;
  readonly fetch: (request: PlanFactsRequest) => Promise<void>;
  readonly run: (request: PlanFactsRequest) => Promise<PlanFactsReport>;
  readonly report: (runId: string, report: PlanFactsReport) => Promise<{ readonly status: string }>;
}

export interface PlanFactsPassResult {
  readonly listed: number;
  readonly reported: readonly { readonly runId: string; readonly feature: string; readonly status: string }[];
  readonly failed: readonly { readonly runId: string; readonly error: string }[];
  readonly durationMs: number;
}

/** Lists, runs and reports every facts run Penguin waits for. One failing run never stops another. */
export async function planFactsPass(options: PlanFactsPassOptions): Promise<PlanFactsPassResult> {
  const started = performance.now();
  const listed = await options.list();
  const reported: PlanFactsPassResult["reported"][number][] = [];
  const failed: PlanFactsPassResult["failed"][number][] = [];
  for (const request of listed) {
    try {
      await options.fetch(request);
      const reply = await options.report(request.runId, await options.run(request));
      reported.push({ runId: request.runId, feature: request.feature, status: reply.status });
    } catch (error) {
      failed.push({ runId: request.runId, error: (error as Error).message });
    }
  }
  return { listed: listed.length, reported, failed, durationMs: Math.round(performance.now() - started) };
}

export function formatPlanFactsPass(result: PlanFactsPassResult): string {
  const lines = result.reported.map(({ runId, feature, status }) => `Plan facts ${runId} for ${feature}: ${status}.`);
  for (const { runId, error } of result.failed) lines.push(`Plan facts ${runId} did not run; it stays listed: ${error}`);
  lines.push(`${result.listed} plan facts run${result.listed === 1 ? "" : "s"} listed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
