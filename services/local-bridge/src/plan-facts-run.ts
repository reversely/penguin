// The facts of a merge plan that need the code read or run (PRD 0.4 section 4.2 step 2), made on the
// check runner. For one feature checkpoint Penguin lists the targets: main, at the checkpoint's
// baseline, and each running feature that may read what the checkpoint changes, at its latest
// checkpoint. The runner:
//
// 1. runs `analysis:python-impact` on baseline..checkpoint with one fork per running feature, which
//    gives the contract diff, the callers already on main and each feature's uses in the files it
//    changed since its merge base with the baseline;
// 2. merges the checkpoint onto each target with `git merge-tree --write-tree`;
// 3. runs each listed `test:<scope>` command on the merged commit in a throwaway worktree, except on
//    a feature the impact graph shows does not use the change;
// 4. states each failing test as a break: its docstring at the merged commit and the assertion and
//    error lines pytest printed. On a running feature a break is a failing test in a file the feature
//    changed since its merge base with the baseline, or one whose traceback passes through a file
//    holding the feature's own callers. Any other failing test sits in a file the feature carries
//    unchanged from main: it is main's break, counted as `carried`. On a running feature the same
//    command then runs on the fork head without the change, once a test is left; a test that fails
//    there too is the fork's own failure, not a break the change makes, and is not reported;
// 5. when the plan declares rewrite rules, applies them in each listed place with Penguin's codemod,
//    lint autofix and formatter (FixApplier.rewrite), and reports each file they change by its blob
//    before and after, so the Worker can compare the rules' output with each part's proposed fix;
// 6. when the plan declares retiring contracts at an expand written first (`retiring`), searches for
//    them in the same analysis (`symbols`), so the report lists their callers. Those uses choose no
//    target's tests: they are callers of the old shape, which the expand leaves working.
//
// The report carries no log. Every step is a local Git, analysis or test command; nothing calls a model.

import { commitMergedTree, isObjectId, runGit, simulateMerge } from "@penguin/git-analysis";
import {
  PLAN_LIMITS,
  PLAN_MAIN_TARGET,
  isContractName,
  RETIRING_LIMITS,
  rewriteRuleContractPath,
  selectAffectedForks,
  withoutWatched,
  type ImpactReport,
  type PlanBreak,
  type PlanFactsReport,
  type PlanFactsRequest,
  type PlanFactsResult,
  type PlanFactsTarget,
  type PlanRewriteReport,
  type PlanRewriteRequest,
} from "@penguin/protocol";
import { InvalidPathError, normalizeRepoPath } from "@penguin/scope-map";

import type { FixApplier } from "./apply-fix.ts";
import { parseFailingTests, withoutForkFailures } from "./combined-run.ts";
import { resolveCommand } from "./command-allowlist.ts";
import { fingerprint } from "./fingerprint.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import { fetchRepoBranches, hasCommit } from "./runner-repo.ts";
import type { RemoteResolver } from "./git-remote.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";
import { readCommittedFile } from "./side-by-side.ts";
import { failureLines, testDocstring, testFunctionName } from "./test-evidence.ts";
import type { TestRunner } from "./test-runner.ts";

export interface PlanFactsRunnerOptions {
  /** The repository that holds the checkpoint, its baseline and every target's commit. */
  readonly repoPath: string;
  readonly runner: TestRunner;
  readonly impact: ImpactAnalyzer;
  /** Applies a plan's rewrite rules; without it, a request with rules reports each place as not run. */
  readonly fixes?: Pick<FixApplier, "rewrite">;
}

/** A running feature's merge base with the baseline and the files holding its own callers. */
interface OwnChanges {
  readonly mergeBase: string;
  readonly callers: ReadonlySet<string>;
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
  const retiring = request.retiring ?? [];
  if (retiring.length > RETIRING_LIMITS.symbols) throw new Error(`a facts run searches at most ${RETIRING_LIMITS.symbols} retiring contracts`);
  for (const contract of retiring) if (!isContractName(contract)) throw new Error(`${JSON.stringify(contract)} is not a path::name contract`);
  for (const place of request.rewrites?.places ?? []) {
    if (!request.targets.some((target) => target.id === place.target && target.sha === place.sha)) {
      throw new Error(`rewrite place ${JSON.stringify(place.target)} is not a target at its commit`);
    }
    if (place.since !== null && !isObjectId(place.since)) throw new Error(`${JSON.stringify(place.since)} is not a full object ID`);
    for (const prefix of place.paths) {
      try {
        if (normalizeRepoPath(prefix) === "") throw new Error("a rewrite path may not be the repository root");
      } catch (error) {
        if (error instanceof InvalidPathError) throw new Error(`${JSON.stringify(prefix)} is not a repository path`);
        throw error;
      }
    }
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
        // A feature's places are its own changes: a caller in a file it carries unchanged from main
        // is main's, and the feature takes main's fix with main before its block lands.
        forks: features.map(({ id, sha, scopes }) => ({ id, sha, scopes, since: request.baseline })),
        ...((request.retiring ?? []).length === 0 ? {} : { symbols: request.retiring as readonly string[] }),
      });
    } catch (error) {
      impactError = clip((error as Error).message, 4_096);
    }
    // The change's own uses choose the targets; a declared retiring contract's callers do not.
    const change = impact === null ? null : withoutWatched(impact, request.retiring);
    const selected = change === null ? undefined : new Set(selectAffectedForks(change));
    const results: PlanFactsResult[] = [];
    for (const target of request.targets) {
      const affected = target.id === PLAN_MAIN_TARGET || selected === undefined || selected.has(target.id);
      const fork = change?.forks.find((each) => each.id === target.id);
      const own = fork?.mergeBase == null ? null : { mergeBase: fork.mergeBase, callers: new Set(fork.uses.map((use) => use.path)) };
      results.push(...(await this.#target(request.checkpoint, target, affected, own)));
    }
    const rewrites = request.rewrites == null || request.rewrites.rules.length === 0 ? undefined : await this.#rewrites(request.checkpoint, request.rewrites);
    return { impact, impactError, results, durationMs: Math.round(performance.now() - started), ...(rewrites === undefined ? {} : { rewrites }) };
  }

  /** Applies the plan's rules in each place: every Python file under its paths, or the target's own changes. */
  async #rewrites(checkpoint: string, request: PlanRewriteRequest): Promise<PlanRewriteReport> {
    const { repoPath, fixes } = this.#options;
    const contracts: Record<string, string> = {};
    for (const path of new Set(request.rules.map(rewriteRuleContractPath))) {
      const source = await readCommittedFile(repoPath, checkpoint, path).catch(() => null);
      if (source !== null) contracts[path] = source;
    }
    let refused: PlanRewriteReport["refused"] | undefined;
    const places: PlanRewriteReport["places"][number][] = [];
    for (const place of request.places) {
      if (fixes === undefined) {
        places.push({ target: place.target, files: [], error: "this runner applies no rewrite rules" });
        continue;
      }
      const paths = await rewritablePaths(repoPath, place.sha, place.paths, place.since);
      if (paths.length === 0) {
        places.push({ target: place.target, files: [], error: null });
        continue;
      }
      const outcome = await fixes.rewrite({ commit: place.sha, paths, allowed: place.paths, rules: request.rules, contracts });
      if (outcome.error === null) refused ??= outcome.refused;
      places.push({ target: place.target, files: outcome.files, error: outcome.error === null ? null : clip(outcome.error, PLAN_LIMITS.failureLineLength) });
    }
    // With no file to rewrite anywhere, the codemod still checks the rules once.
    if (refused === undefined && fixes !== undefined) {
      const checked = await fixes.rewrite({ commit: checkpoint, paths: [], allowed: [], rules: request.rules, contracts });
      refused = checked.error === null ? checked.refused : request.rules.map((rule) => ({ rule: rule.id, message: clip(`the rules were not checked: ${checked.error}`, PLAN_LIMITS.failureLineLength) }));
    }
    return { refused: refused ?? [], places };
  }

  /**
   * Tests one target. `own` is a running feature's merge base with the baseline and the files holding
   * its own callers, from the impact report; null on main or when the merge base is unknown, so every
   * failing test is a break.
   */
  async #target(checkpoint: string, target: PlanFactsTarget, affected: boolean, own: OwnChanges | null): Promise<PlanFactsResult[]> {
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
    // The files the feature added or changed since its merge base: a local diff of two commits the
    // runner already holds, read once per target and only when a test fails.
    let changed: Promise<Set<string>> | undefined;
    const ownTests =
      own === null ? null : { callers: own.callers, changed: () => (changed ??= changedSince(repoPath, own.mergeBase, target.sha)) };
    const results: PlanFactsResult[] = [];
    for (const commandId of target.commandIds) {
      try {
        await resolveCommand(repoPath, merged, commandId);
      } catch (error) {
        const reason = clip((error as Error).message, PLAN_LIMITS.failureLineLength);
        results.push({ ...base(commandId), status: "not-run", merged, reason });
        continue;
      }
      results.push(await this.#test(target, commandId, merged, ownTests));
    }
    return results;
  }

  async #test(
    { id: target, sha: forkHead }: PlanFactsTarget,
    commandId: string,
    merged: string,
    own: { readonly callers: ReadonlySet<string>; readonly changed: () => Promise<ReadonlySet<string>> } | null,
  ): Promise<PlanFactsResult> {
    const { repoPath, runner } = this.#options;
    const started = performance.now();
    const outcome = await runner.run({ commandId, sha: merged });
    const passed = outcome.exitCode === 0 && outcome.signal === null;
    let failing = passed ? [] : parseFailingTests(outcome.log);
    const lines = failureLines(outcome.log, failing.map((test) => test.nodeId));
    let carried: number | undefined;
    if (own !== null) {
      const changed = failing.length === 0 ? new Set<string>() : await own.changed();
      const owned = failing.filter(({ nodeId }) => changed.has(testFile(nodeId)) || (lines.get(nodeId)?.files ?? []).some((file) => own.callers.has(file)));
      carried = failing.length - owned.length;
      failing = owned;
    }
    if (target !== PLAN_MAIN_TARGET && failing.length > 0) failing = withoutForkFailures(failing, await this.#failingAlone(commandId, forkHead));
    const breaks: PlanBreak[] = [];
    for (const { nodeId } of failing.slice(0, PLAN_LIMITS.breaksPerResult)) {
      const file = testFile(nodeId);
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
      ...(carried === undefined ? {} : { carried }),
      reason: null,
      durationMs: Math.round(performance.now() - started),
    };
  }

  /** The tests `commandId` fails on a running feature's fork head without the change; none when it does not run there. */
  async #failingAlone(commandId: string, forkHead: string): Promise<Set<string>> {
    const { repoPath, runner } = this.#options;
    try {
      await resolveCommand(repoPath, forkHead, commandId);
    } catch {
      return new Set();
    }
    const outcome = await runner.run({ commandId, sha: forkHead });
    const passed = outcome.exitCode === 0 && outcome.signal === null;
    return new Set(passed ? [] : parseFailingTests(outcome.log).map((test) => test.nodeId));
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
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface PlanFactsPassResult {
  readonly listed: number;
  readonly reported: readonly { readonly runId: string; readonly feature: string; readonly status: string }[];
  readonly failed: readonly { readonly runId: string; readonly error: string; readonly failure: FailureNote | null }[];
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
      const reason = (error as Error).message;
      failed.push({ runId: request.runId, error: reason, failure: await noteFailure(options.fail, "plan-facts", request.runId, reason) });
    }
  }
  return { listed: listed.length, reported, failed, durationMs: Math.round(performance.now() - started) };
}

export function formatPlanFactsPass(result: PlanFactsPassResult): string {
  const lines = result.reported.map(({ runId, feature, status }) => `Plan facts ${runId} for ${feature}: ${status}.`);
  for (const { runId, error, failure } of result.failed) {
    lines.push(`Plan facts ${runId} did not run; ${failure === null ? "it stays listed" : failureText(failure)}: ${error}`);
  }
  lines.push(`${result.listed} plan facts run${result.listed === 1 ? "" : "s"} listed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}

/**
 * The Python files under `prefixes` at `sha` that a place's rules may rewrite: every one, or with
 * `since`, those added or changed since the merge base of `since` and `sha`.
 */
async function rewritablePaths(repoPath: string, sha: string, prefixes: readonly string[], since: string | null): Promise<string[]> {
  if (prefixes.length === 0) return [];
  let listed: string;
  if (since === null) {
    listed = await runGit(repoPath, ["ls-tree", "-r", "--name-only", "-z", sha, "--", ...prefixes]);
  } else {
    const base = (await runGit(repoPath, ["merge-base", since, sha])).trim();
    listed = await runGit(repoPath, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", base, sha, "--", ...prefixes]);
  }
  return listed.split("\0").filter((path) => path.endsWith(".py"));
}

/** The paths `sha` added or changed since `base`. */
async function changedSince(repoPath: string, base: string, sha: string): Promise<Set<string>> {
  const listed = await runGit(repoPath, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", base, sha]);
  return new Set(listed.split("\0").filter((path) => path !== ""));
}

/** The test file of a pytest node ID; empty when the ID names no file. */
function testFile(nodeId: string): string {
  const separator = nodeId.indexOf("::");
  return separator < 0 ? "" : nodeId.slice(0, separator);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
