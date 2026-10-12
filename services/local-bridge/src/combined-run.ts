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

/**
 * One fork the checkpoint is merged onto, besides main. Each running feature's fork is a target of
 * its own, keyed by the feature id, so a person with two running features has two targets
 * (PRD 0.4 section 1). An owner fork, `owner-<id>`, is a target keyed by its person's id.
 */
export interface ForkTarget {
  /** The running feature's id, or the person's id for their owner fork. */
  readonly id: string;
  /** The fork's person, who is routed the target's failures. */
  readonly person: string;
  /** The fork's latest checkpoint, as a full object ID. */
  readonly checkpoint: string;
  /**
   * The scopes whose tests run on the target's merged tree, of those that depend on the change.
   * When absent, the dependent scopes the target's person owns.
   */
  readonly scopes?: readonly string[];
}

/** One owner fork target per entry of `checkpoints`, an owner's checkpoint keyed by owner ID. */
export function ownerForkTargets(checkpoints: Readonly<Record<string, string>>): ForkTarget[] {
  return Object.entries(checkpoints).map(([owner, checkpoint]) => ({ id: owner, person: owner, checkpoint }));
}

// `<owner>=<revision>` names an owner fork; `<person>/<feature>=<revision>` names a feature's fork.
const CHECKPOINT_ARGUMENT = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)\/)?([^=/]+)=(.+)$/u;

/**
 * Parses a command line's `--checkpoint` value: `<owner>=<revision>` for an owner fork, or
 * `<person>/<feature>=<revision>` for one of a person's features. Undefined when malformed.
 */
export function parseCheckpointArgument(text: string): { readonly id: string; readonly person: string; readonly revision: string } | undefined {
  const match = CHECKPOINT_ARGUMENT.exec(text);
  if (match === null) return undefined;
  const id = match[2] as string;
  return { id, person: match[1] ?? id, revision: match[3] as string };
}

export interface CombinedRunRequest {
  /** Full object ID of the changed scope's checkpoint. Its scope map decides the dependents. */
  readonly checkpointSha: string;
  /** Full object ID of the commit the checkpoint was made from; the diff between them is the change. */
  readonly baselineSha: string;
  /** The forks to merge the checkpoint onto, each with its latest checkpoint. Ids are unique. */
  readonly targets: readonly ForkTarget[];
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
  /**
   * Target ids whose tests and type check run whatever the impact graph says: the forks the
   * resolution ladder just fixed. A codemod leaves a fork using the new name, which the graph no longer counts
   * as a use of the change, yet the fix must go back through the checks.
   */
  readonly recheck?: readonly string[];
}

/** One failed test from the runner's log. */
export interface FailingTest {
  /** The pytest node ID, such as `analytics/tests/test_retention.py::test_dau_stable`. */
  readonly nodeId: string;
  /** The PRD's short form: module and test name without `test_`, such as `test_retention::dau_stable`. */
  readonly testId: string;
}

interface DependentTarget {
  /** The fork target's id, or the scope owner's id when no target covers the scope. */
  readonly target: string;
  /** The target's person. */
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
 * The merge was clean but the impact graph shows the target's checkpoint uses nothing the change
 * touches, so the scope's tests did not run. It completes the target's claimed run.
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

/** No target covers the dependent scope: its owner has published no checkpoint to merge with. */
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
  /** One result per dependent scope and target covering it, sorted by scope ID, then target order. */
  readonly results: readonly CombinedResult[];
  /**
   * The impact graph and contract diff of the checkpoint, with each target's checkpoint as a fork;
   * null when no analyzer ran or it failed.
   */
  readonly impact?: ImpactReport | null;
  /** Why the analysis failed, in which case every dependent scope's tests ran; null otherwise. */
  readonly impactError?: string | null;
  /** Dependent scopes the impact graph marks as unaffected; their tests did not run. */
  readonly notAffected?: readonly string[];
  /**
   * The section 5.1 checks on `main` and on every target's merged tree, one target per listed fork,
   * with the tests' results as `tests` checks; absent when the runner has no block checker.
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
   * When given, the impact graph selects which targets' tests run: only a target whose checkpoint
   * imports, calls or references a changed symbol in a dependent scope.
   */
  impact?: ImpactAnalyzer;
  /**
   * When given, the section 5.1 checks run on `main` and on each target's merged tree; the type
   * check only on the targets the impact graph selects.
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
 * owner of the checkpoint that triggered the run. Each result names its target and its person. Only the failing tests and the fingerprints leave
 * the runner (PRD section 14, decision 2).
 */
export function combinedRunEvent(report: CombinedRunReport, triggerOwner: string): CombinedRunEvent {
  return {
    trigger: { ownerId: triggerOwner, sha: report.checkpointSha, baselineSha: report.baselineSha },
    changedScopes: report.changedScopes,
    unmapped: report.unmapped,
    results: report.results.map((result) => {
      const target = { target: result.target, ownerId: result.ownerId, scopeId: result.scopeId, commandId: result.commandId };
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
      target: result.target,
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
 * changes, merges the checkpoint with each target fork's latest checkpoint using
 * `git merge-tree --write-tree`, and runs the dependent scopes' allowlisted tests on each merged
 * commit in a throwaway worktree. Targets are keyed by feature, not by person: each of a person's
 * running features is merged and tested on its own. Every step is a local Git or test command; nothing calls a
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
    const { checkpointSha, baselineSha } = request;
    const wanted = request.commandIds === undefined ? undefined : new Set(request.commandIds);
    const forks = checkedTargets(request.targets);
    const scopeMap = await loadScopeMap(repoPath, checkpointSha);
    const changed = await changedPathsBetween(repoPath, baselineSha, checkpointSha);
    const affected = affectedOwners(scopeMap, changed);

    const targets: (DependentTarget & { readonly ownerCheckpoint: string | undefined })[] = [];
    for (const scopeId of affected.dependentScopes) {
      const owner = scopeMap.scopes.get(scopeId)?.ownerId as string;
      const commandId = testCommandId(scopeId);
      if (wanted !== undefined && !wanted.has(commandId)) continue;
      const covering = forks.filter((fork) => (fork.scopes === undefined ? fork.person === owner : fork.scopes.includes(scopeId)));
      if (covering.length === 0) targets.push({ target: owner, ownerId: owner, scopeId, commandId, ownerCheckpoint: undefined });
      for (const fork of covering) {
        targets.push({ target: fork.id, ownerId: fork.person, scopeId, commandId, ownerCheckpoint: fork.checkpoint });
      }
    }
    const started = performance.now();
    const { impact, impactError, selected } = await this.#impact(baselineSha, checkpointSha, targets);
    for (const id of request.recheck ?? []) selected?.add(id);

    const results: CombinedResult[] = [];
    const notAffected: string[] = [];
    // A target with several dependent scopes is merged once; the merged commit serves each scope.
    // An unaffected target is merged too: a conflict is a fact whatever the impact graph says.
    const merges = new Map<string, MergeOutcome>();
    for (const { ownerCheckpoint, ...target } of targets) {
      const id = target.target;
      if (ownerCheckpoint === undefined) {
        results.push({ ...target, status: "no-checkpoint" });
        continue;
      }
      const merge = merges.get(id) ?? (await this.#merge(checkpointSha, ownerCheckpoint));
      merges.set(id, merge);
      if (merge.kind === "conflict") {
        results.push({ ...target, status: "conflict", ownerCheckpoint, conflictedPaths: merge.conflictedPaths });
        continue;
      }
      if (selected !== undefined && !selected.has(id)) {
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
    for (const [id, merge] of merges) {
      const covered = targets.filter((target) => target.target === id);
      const commit = covered[0]?.ownerCheckpoint as string;
      const scopes = covered.map((target) => target.scopeId);
      const affectedTarget = selected === undefined || selected.has(id);
      blockTargets.push({ id, commit, scopes, affected: affectedTarget, merge: mergeOf(merge), mergeMs: merge.ms });
    }
    // A listed fork that reads no dependent scope is still a target of its own: its overlap, merge,
    // lint, format and dependency diff are facts about the block. Its type check does not run unless
    // the resolution ladder just fixed it.
    for (const fork of forks) {
      if (merges.has(fork.id)) continue;
      const scopes = fork.scopes ?? [...scopeMap.scopes.values()].filter((scope) => scope.ownerId === fork.person).map((scope) => scope.id);
      const affectedTarget = request.recheck?.includes(fork.id) ?? false;
      blockTargets.push({ id: fork.id, commit: fork.checkpoint, scopes: [...scopes], affected: affectedTarget, ...(await this.#timedMerge(checkpointSha, fork.checkpoint)) });
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
   * Runs the impact analysis with one fork per target, searched in the dependent scopes it covers.
   * A failed analysis selects every target, so no test is skipped on a guess.
   */
  async #impact(
    baselineSha: string,
    checkpointSha: string,
    targets: readonly (DependentTarget & { readonly ownerCheckpoint: string | undefined })[],
  ): Promise<{ impact: ImpactReport | null; impactError: string | null; selected: Set<string> | undefined }> {
    const analyzer = this.#options.impact;
    const scopesByTarget = new Map<string, { sha: string; scopes: string[] }>();
    for (const { target, scopeId, ownerCheckpoint } of targets) {
      if (ownerCheckpoint === undefined) continue;
      const fork = scopesByTarget.get(target) ?? { sha: ownerCheckpoint, scopes: [] };
      fork.scopes.push(scopeId);
      scopesByTarget.set(target, fork);
    }
    if (analyzer === undefined || scopesByTarget.size === 0) return { impact: null, impactError: null, selected: undefined };
    const forks = [...scopesByTarget].map(([id, fork]) => ({ id, ...fork }));
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

/**
 * The request's targets, each checkpoint a full object ID and each id listed once.
 *
 * Raises:
 *   Error: when a checkpoint is not a full object ID or an id is listed twice.
 */
function checkedTargets(targets: readonly ForkTarget[]): readonly ForkTarget[] {
  const ids = new Set<string>();
  for (const { id, checkpoint } of targets) {
    if (!isObjectId(checkpoint)) throw new Error(`checkpoint of ${id} must be a full object ID, got ${JSON.stringify(checkpoint)}`);
    if (ids.has(id)) throw new Error(`target ${id} is listed twice`);
    ids.add(id);
  }
  return targets;
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
