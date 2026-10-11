import { createHash } from "node:crypto";
import { basename } from "node:path";

import { changedPathsBetween, commitMergedTree, isObjectId, simulateMerge } from "@penguin/git-analysis";
import {
  BLOCK_CHECK_LIMITS,
  MAIN_TARGET,
  selectAffectedForks,
  type BlockCheck,
  type CombinedRunEvent,
  type DependencyReport,
  type ImpactReport,
} from "@penguin/protocol";
import { affectedOwners } from "@penguin/scope-map";

import type { BlockChecker, BlockTarget } from "./block-checks.ts";
import { loadScopeMap, testCommandId } from "./command-allowlist.ts";
import { fingerprint, type ResultFingerprint } from "./fingerprint.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import type { TestRunner } from "./test-runner.ts";

export interface CombinedRunRequest {
  /** Full object ID of the changed scope's checkpoint. Its scope map decides the dependents. */
  readonly checkpointSha: string;
  /** Full object ID of the commit the checkpoint was made from; the diff between them is the change. */
  readonly baselineSha: string;
  /** Each owner's latest checkpoint, as a full object ID keyed by owner ID. */
  readonly latestCheckpoints: Readonly<Record<string, string>>;
  /**
   * When given, only the dependent scopes whose command ID is listed run, and the report holds only
   * them. A scheduled run names the commands Penguin asked for this way.
   */
  readonly commandIds?: readonly string[];
  /**
   * Main's commit, the `main` target of the block checks. Defaults to the baseline. Used only when
   * the runner has a block checker.
   */
  readonly mainSha?: string;
}

/** One failed test from the runner's log. */
export interface FailingTest {
  /** The pytest node ID, such as `analytics/tests/test_retention.py::test_dau_stable`. */
  readonly nodeId: string;
  /** The PRD's short form: module and test name without `test_`, such as `test_retention::dau_stable`. */
  readonly testId: string;
}

interface DependentTarget {
  readonly ownerId: string;
  readonly scopeId: string;
  readonly commandId: string;
}

/** The merge was clean and the dependent scope's tests ran on the merged commit. */
export interface TestedResult extends DependentTarget {
  readonly status: "passed" | "failed";
  readonly ownerCheckpoint: string;
  readonly mergedTree: string;
  readonly mergedCommit: string;
  readonly fingerprint: ResultFingerprint;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Tests the log names as failed; empty for a pass or for a runner whose log has no pytest summary. */
  readonly failingTests: readonly FailingTest[];
  readonly log: string;
  /** Wall time of the test run, from adding its worktree to removing it. */
  readonly durationMs: number;
}

/**
 * The merge was clean but the impact graph shows the owner's checkpoint uses nothing the change
 * touches, so the scope's tests did not run. It completes the owner's claimed run.
 */
export interface NotAffectedResult extends DependentTarget {
  readonly status: "not-affected";
  readonly ownerCheckpoint: string;
  readonly mergedCommit: string;
}

/** The merge conflicted, so no tests ran. A conflict is never reported as a pass. */
export interface ConflictResult extends DependentTarget {
  readonly status: "conflict";
  readonly ownerCheckpoint: string;
  readonly conflictedPaths: readonly string[];
}

/** The dependent owner has published no checkpoint, so there is nothing to merge. */
export interface MissingCheckpointResult extends DependentTarget {
  readonly status: "no-checkpoint";
}

export type CombinedResult = TestedResult | ConflictResult | MissingCheckpointResult | NotAffectedResult;

export interface CombinedRunReport {
  readonly checkpointSha: string;
  readonly baselineSha: string;
  /** Scopes the checkpoint changes, from the scope map at the checkpoint. */
  readonly changedScopes: readonly string[];
  /** Changed paths that fall in no scope. */
  readonly unmapped: readonly string[];
  /** One result per dependent scope, sorted by scope ID. */
  readonly results: readonly CombinedResult[];
  /**
   * The impact graph and contract diff of the checkpoint, with each dependent owner's checkpoint as
   * a fork; null when no analyzer ran or it failed.
   */
  readonly impact?: ImpactReport | null;
  /** Why the analysis failed, in which case every dependent scope's tests ran; null otherwise. */
  readonly impactError?: string | null;
  /** Dependent scopes the impact graph marks as unaffected; their tests did not run. */
  readonly notAffected?: readonly string[];
  /**
   * The section 5.1 checks on `main` and on each dependent owner's merged tree, with the tests'
   * results as `tests` checks; absent when the runner has no block checker.
   */
  readonly checks?: readonly BlockCheck[];
  /** Each check tool's raw output, by the `logRef` its check names. */
  readonly checkLogs?: ReadonlyMap<string, string>;
  /** The dependency diff the checks used, or null when it failed. */
  readonly dependencies?: DependencyReport | null;
  /** Wall time of the whole run: analysis, merges, checks and tests. */
  readonly durationMs?: number;
}

export interface CombinedRunnerOptions {
  /** Any path inside the repository that holds every checkpoint. */
  repoPath: string;
  /** Runs each dependent scope's allowlisted tests in a throwaway worktree, with consent. */
  runner: TestRunner;
  /**
   * When given, the impact graph selects which dependent owners' tests run: only an owner whose
   * checkpoint imports, calls or references a changed symbol in a dependent scope.
   */
  impact?: ImpactAnalyzer;
  /**
   * When given, the section 5.1 checks run on `main` and on each dependent owner's merged tree; the
   * type check only on the owners the impact graph selects.
   */
  checks?: BlockChecker;
}

// pytest's short test summary (on by default through `-r fE`) names each failure on a line of
// the form `FAILED <node ID>` or `FAILED <node ID> - <message>`.
const PYTEST_FAILED = /^FAILED (.+?)(?: - .*)?$/gm;
// An ANSI control sequence (CSI), such as the colour codes pytest writes around `FAILED` and the
// test name when FORCE_COLOR or PY_COLORS is set.
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Lists the failed tests in a pytest log, sorted and unique. ANSI escapes are ignored. */
export function parseFailingTests(log: string): FailingTest[] {
  const plain = log.replace(ANSI_ESCAPE, "");
  const nodeIds = new Set([...plain.matchAll(PYTEST_FAILED)].map((match) => (match[1] as string).trim()));
  return [...nodeIds].sort().map((nodeId) => {
    const separator = nodeId.indexOf("::");
    const module = basename(nodeId.slice(0, separator)).replace(/\.py$/, "");
    const test = nodeId.slice(separator + 2).replace(/^test_/, "");
    return { nodeId, testId: `${module}::${test}` };
  });
}

/**
 * The typed event Penguin opens a Huddle issue from: the report without its test logs, with the
 * owner of the checkpoint that triggered the run. Only the failing tests and the fingerprints leave
 * the runner (PRD section 14, decision 2).
 */
export function combinedRunEvent(report: CombinedRunReport, triggerOwner: string): CombinedRunEvent {
  return {
    trigger: { ownerId: triggerOwner, sha: report.checkpointSha, baselineSha: report.baselineSha },
    changedScopes: report.changedScopes,
    unmapped: report.unmapped,
    results: report.results.map((result) => {
      const target = { ownerId: result.ownerId, scopeId: result.scopeId, commandId: result.commandId };
      if (result.status === "no-checkpoint") {
        return { ...target, status: result.status, ownerCheckpoint: null, fingerprint: null, failingTests: [] };
      }
      if (result.status === "conflict" || result.status === "not-affected") {
        const { ownerCheckpoint } = result;
        return { ...target, status: result.status, ownerCheckpoint, fingerprint: null, failingTests: [] };
      }
      const { status, ownerCheckpoint, fingerprint, failingTests } = result;
      return { ...target, status, ownerCheckpoint, fingerprint: { ...fingerprint }, failingTests };
    }),
    ...(report.checks === undefined ? {} : { checks: report.checks.slice(0, BLOCK_CHECK_LIMITS.checks) }),
  };
}

/** One `tests` check per dependent scope with a checkpoint, from the combined run's results. */
export function testChecks(results: readonly CombinedResult[], origin: string): BlockCheck[] {
  const checks: BlockCheck[] = [];
  for (const result of results) {
    if (result.status === "no-checkpoint") continue;
    const base = {
      planId: null,
      target: result.ownerId,
      check: "tests" as const,
      tool: { name: "test", version: null, commandId: result.commandId },
      input: {
        origin,
        target: result.ownerCheckpoint,
        merged: result.status === "conflict" ? null : result.mergedCommit,
        paths: null,
      },
      fingerprint: null,
      logRef: null,
      durationMs: 0,
    };
    if (result.status === "conflict") {
      checks.push({ ...base, result: "not-run", findings: [], findingCount: 0, summary: "the merge conflicts" });
    } else if (result.status === "not-affected") {
      const summary = "the impact graph shows no use of the change";
      checks.push({ ...base, result: "not-affected", findings: [], findingCount: 0, summary });
    } else {
      const findings = result.failingTests.map((test) => {
        const separator = test.nodeId.indexOf("::");
        return {
          path: separator > 0 ? test.nodeId.slice(0, separator).slice(0, BLOCK_CHECK_LIMITS.pathLength) : null,
          line: null,
          code: null,
          message: `fails: ${test.nodeId.slice(separator + 2)}`.slice(0, BLOCK_CHECK_LIMITS.messageLength),
        };
      });
      const ended = result.exitCode === null ? `ended by ${result.signal}` : `exited with ${result.exitCode}`;
      const failed = result.failingTests.length;
      checks.push({
        ...base,
        result: result.status,
        findings: findings.slice(0, BLOCK_CHECK_LIMITS.findingsPerCheck),
        findingCount: findings.length,
        summary: result.status === "passed" ? "tests pass" : `${failed} failing test${failed === 1 ? "" : "s"}; the command ${ended}`,
        fingerprint: { ...result.fingerprint },
        logRef: `sha256:${createHash("sha256").update(result.log).digest("hex")}`,
        durationMs: Math.round(result.durationMs),
      });
    }
  }
  return checks;
}

/**
 * Layer 1's combined run (PRD section 4): finds the scopes that depend on the scopes a checkpoint
 * changes, merges the checkpoint with each dependent owner's latest checkpoint using
 * `git merge-tree --write-tree`, and runs the dependent scope's allowlisted tests on the merged
 * commit in a throwaway worktree. Every step is a local Git or test command; nothing calls a
 * model or the network.
 */
export class CombinedRunner {
  readonly #options: CombinedRunnerOptions;

  constructor(options: CombinedRunnerOptions) {
    this.#options = options;
  }

  /**
   * Raises:
   *   Error: when a SHA is not a full object ID or names no commit, or the scope map at the
   *   checkpoint is missing or invalid.
   *   ConsentRefusedError: when the owner declines a test run; earlier results are discarded.
   */
  async run(request: CombinedRunRequest): Promise<CombinedRunReport> {
    const { repoPath } = this.#options;
    const { checkpointSha, baselineSha, latestCheckpoints } = request;
    const wanted = request.commandIds === undefined ? undefined : new Set(request.commandIds);
    const scopeMap = await loadScopeMap(repoPath, checkpointSha);
    const changed = await changedPathsBetween(repoPath, baselineSha, checkpointSha);
    const affected = affectedOwners(scopeMap, changed);

    const targets: (DependentTarget & { readonly ownerCheckpoint: string | undefined })[] = [];
    for (const scopeId of affected.dependentScopes) {
      const ownerId = scopeMap.scopes.get(scopeId)?.ownerId as string;
      const commandId = testCommandId(scopeId);
      if (wanted !== undefined && !wanted.has(commandId)) continue;
      const ownerCheckpoint = Object.hasOwn(latestCheckpoints, ownerId) ? latestCheckpoints[ownerId] : undefined;
      if (ownerCheckpoint !== undefined && !isObjectId(ownerCheckpoint)) {
        throw new Error(`checkpoint of ${ownerId} must be a full object ID, got ${JSON.stringify(ownerCheckpoint)}`);
      }
      targets.push({ ownerId, scopeId, commandId, ownerCheckpoint });
    }
    const started = performance.now();
    const { impact, impactError, selected } = await this.#impact(baselineSha, checkpointSha, targets);

    const results: CombinedResult[] = [];
    const notAffected: string[] = [];
    // An owner with several dependent scopes is merged once; the merged commit serves each scope.
    // An unaffected owner is merged too: a conflict is a fact whatever the impact graph says.
    const merges = new Map<string, MergeOutcome>();
    for (const { ownerCheckpoint, ...target } of targets) {
      const { ownerId } = target;
      if (ownerCheckpoint === undefined) {
        results.push({ ...target, status: "no-checkpoint" });
        continue;
      }
      const merge = merges.get(ownerId) ?? (await this.#merge(checkpointSha, ownerCheckpoint));
      merges.set(ownerId, merge);
      if (merge.kind === "conflict") {
        results.push({ ...target, status: "conflict", ownerCheckpoint, conflictedPaths: merge.conflictedPaths });
        continue;
      }
      if (selected !== undefined && !selected.has(ownerId)) {
        notAffected.push(target.scopeId);
        results.push({ ...target, status: "not-affected", ownerCheckpoint, mergedCommit: merge.commit });
        continue;
      }
      results.push(await this.#test(target, ownerCheckpoint, merge));
    }
    const report = {
      checkpointSha,
      baselineSha,
      changedScopes: affected.changedScopes,
      unmapped: affected.unmapped,
      results,
      impact,
      impactError,
      notAffected,
    };
    const checker = this.#options.checks;
    if (checker === undefined) return { ...report, durationMs: Math.round(performance.now() - started) };

    const mainSha = request.mainSha ?? baselineSha;
    if (!isObjectId(mainSha)) throw new Error(`main must be a full object ID, got ${JSON.stringify(mainSha)}`);
    const blockTargets: BlockTarget[] = [
      { id: MAIN_TARGET, commit: mainSha, scopes: [], affected: true, ...(await this.#timedMerge(checkpointSha, mainSha)) },
    ];
    for (const [ownerId, merge] of merges) {
      const owned = targets.filter((target) => target.ownerId === ownerId);
      const commit = owned[0]?.ownerCheckpoint as string;
      const scopes = owned.map((target) => target.scopeId);
      const affectedOwner = selected === undefined || selected.has(ownerId);
      blockTargets.push({ id: ownerId, commit, scopes, affected: affectedOwner, merge: mergeOf(merge), mergeMs: merge.ms });
    }
    const block = await checker.check({ planId: null, origin: checkpointSha, baseline: baselineSha, targets: blockTargets });
    return {
      ...report,
      checks: [...block.checks, ...testChecks(results, checkpointSha)],
      checkLogs: block.logs,
      dependencies: block.dependencies,
      durationMs: Math.round(performance.now() - started),
    };
  }

  async #timedMerge(checkpointSha: string, other: string): Promise<Pick<BlockTarget, "merge" | "mergeMs">> {
    const merge = await this.#merge(checkpointSha, other);
    return { merge: mergeOf(merge), mergeMs: merge.ms };
  }

  /**
   * Runs the impact analysis with one fork per dependent owner that has a checkpoint, searched in
   * that owner's dependent scopes. A failed analysis selects every owner, so no test is skipped on
   * a guess.
   */
  async #impact(
    baselineSha: string,
    checkpointSha: string,
    targets: readonly (DependentTarget & { readonly ownerCheckpoint: string | undefined })[],
  ): Promise<{ impact: ImpactReport | null; impactError: string | null; selected: Set<string> | undefined }> {
    const analyzer = this.#options.impact;
    const scopesByOwner = new Map<string, { sha: string; scopes: string[] }>();
    for (const { ownerId, scopeId, ownerCheckpoint } of targets) {
      if (ownerCheckpoint === undefined) continue;
      const fork = scopesByOwner.get(ownerId) ?? { sha: ownerCheckpoint, scopes: [] };
      fork.scopes.push(scopeId);
      scopesByOwner.set(ownerId, fork);
    }
    if (analyzer === undefined || scopesByOwner.size === 0) return { impact: null, impactError: null, selected: undefined };
    const forks = [...scopesByOwner].map(([id, fork]) => ({ id, ...fork }));
    try {
      const impact = await analyzer({ base: baselineSha, head: checkpointSha, forks });
      return { impact, impactError: null, selected: new Set(selectAffectedForks(impact)) };
    } catch (error) {
      return { impact: null, impactError: (error as Error).message, selected: undefined };
    }
  }

  async #merge(checkpointSha: string, ownerCheckpoint: string): Promise<MergeOutcome> {
    const { repoPath } = this.#options;
    const started = performance.now();
    const merge = await simulateMerge(repoPath, checkpointSha, ownerCheckpoint);
    if (merge.kind === "conflict") {
      return { kind: "conflict", conflictedPaths: merge.conflictedPaths, ms: performance.now() - started };
    }
    const commit = await commitMergedTree(repoPath, merge.tree, [checkpointSha, ownerCheckpoint]);
    return { kind: "clean", tree: merge.tree, commit, ms: performance.now() - started };
  }

  async #test(target: DependentTarget, ownerCheckpoint: string, merge: CleanOutcome): Promise<TestedResult> {
    const { repoPath, runner } = this.#options;
    const started = performance.now();
    const outcome = await runner.run({ commandId: target.commandId, sha: merge.commit });
    const passed = outcome.exitCode === 0 && outcome.signal === null;
    return {
      ...target,
      status: passed ? "passed" : "failed",
      ownerCheckpoint,
      mergedTree: merge.tree,
      mergedCommit: merge.commit,
      fingerprint: await fingerprint(repoPath, merge.commit, target.commandId),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      failingTests: passed ? [] : parseFailingTests(outcome.log),
      log: outcome.log,
      durationMs: performance.now() - started,
    };
  }
}

interface CleanOutcome {
  readonly kind: "clean";
  readonly tree: string;
  readonly commit: string;
  readonly ms: number;
}

type MergeOutcome =
  | CleanOutcome
  | { readonly kind: "conflict"; readonly conflictedPaths: readonly string[]; readonly ms: number };

function mergeOf(merge: MergeOutcome): BlockTarget["merge"] {
  return merge.kind === "conflict"
    ? { kind: "conflict", conflictedPaths: merge.conflictedPaths }
    : { kind: "clean", tree: merge.tree, commit: merge.commit };
}
