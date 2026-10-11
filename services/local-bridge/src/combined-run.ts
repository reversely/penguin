import { basename } from "node:path";

import { changedPathsBetween, commitMergedTree, isObjectId, simulateMerge } from "@penguin/git-analysis";
import type { CombinedRunEvent } from "@penguin/protocol";
import { affectedOwners } from "@penguin/scope-map";

import { loadScopeMap, testCommandId } from "./command-allowlist.ts";
import { fingerprint, type ResultFingerprint } from "./fingerprint.ts";
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

export type CombinedResult = TestedResult | ConflictResult | MissingCheckpointResult;

export interface CombinedRunReport {
  readonly checkpointSha: string;
  readonly baselineSha: string;
  /** Scopes the checkpoint changes, from the scope map at the checkpoint. */
  readonly changedScopes: readonly string[];
  /** Changed paths that fall in no scope. */
  readonly unmapped: readonly string[];
  /** One result per dependent scope, sorted by scope ID. */
  readonly results: readonly CombinedResult[];
}

export interface CombinedRunnerOptions {
  /** Any path inside the repository that holds every checkpoint. */
  repoPath: string;
  /** Runs each dependent scope's allowlisted tests in a throwaway worktree, with consent. */
  runner: TestRunner;
}

// pytest's short test summary (on by default through `-r fE`) names each failure on a line of
// the form `FAILED <node ID>` or `FAILED <node ID> - <message>`.
const PYTEST_FAILED = /^FAILED (.+?)(?: - .*)?$/gm;

/** Lists the failed tests in a pytest log, sorted and unique. */
export function parseFailingTests(log: string): FailingTest[] {
  const nodeIds = new Set([...log.matchAll(PYTEST_FAILED)].map((match) => (match[1] as string).trim()));
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
      if (result.status === "conflict") {
        const { ownerCheckpoint } = result;
        return { ...target, status: result.status, ownerCheckpoint, fingerprint: null, failingTests: [] };
      }
      const { status, ownerCheckpoint, fingerprint, failingTests } = result;
      return { ...target, status, ownerCheckpoint, fingerprint: { ...fingerprint }, failingTests };
    }),
  };
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

    const results: CombinedResult[] = [];
    // An owner with several dependent scopes is merged once; the merged commit serves each scope.
    const merges = new Map<string, MergeOutcome>();
    for (const scopeId of affected.dependentScopes) {
      const ownerId = scopeMap.scopes.get(scopeId)?.ownerId as string;
      const target = { ownerId, scopeId, commandId: testCommandId(scopeId) };
      if (wanted !== undefined && !wanted.has(target.commandId)) continue;
      const ownerCheckpoint = Object.hasOwn(latestCheckpoints, ownerId) ? latestCheckpoints[ownerId] : undefined;
      if (ownerCheckpoint === undefined) {
        results.push({ ...target, status: "no-checkpoint" });
        continue;
      }
      if (!isObjectId(ownerCheckpoint)) {
        throw new Error(`checkpoint of ${ownerId} must be a full object ID, got ${JSON.stringify(ownerCheckpoint)}`);
      }
      const merge = merges.get(ownerId) ?? (await this.#merge(checkpointSha, ownerCheckpoint));
      merges.set(ownerId, merge);
      if (merge.kind === "conflict") {
        results.push({ ...target, status: "conflict", ownerCheckpoint, conflictedPaths: merge.conflictedPaths });
        continue;
      }
      results.push(await this.#test(target, ownerCheckpoint, merge));
    }
    return {
      checkpointSha,
      baselineSha,
      changedScopes: affected.changedScopes,
      unmapped: affected.unmapped,
      results,
    };
  }

  async #merge(checkpointSha: string, ownerCheckpoint: string): Promise<MergeOutcome> {
    const { repoPath } = this.#options;
    const merge = await simulateMerge(repoPath, checkpointSha, ownerCheckpoint);
    if (merge.kind === "conflict") return merge;
    const commit = await commitMergedTree(repoPath, merge.tree, [checkpointSha, ownerCheckpoint]);
    return { kind: "clean", tree: merge.tree, commit };
  }

  async #test(target: DependentTarget, ownerCheckpoint: string, merge: CleanOutcome): Promise<TestedResult> {
    const { repoPath, runner } = this.#options;
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
    };
  }
}

interface CleanOutcome {
  readonly kind: "clean";
  readonly tree: string;
  readonly commit: string;
}

type MergeOutcome = CleanOutcome | { readonly kind: "conflict"; readonly conflictedPaths: readonly string[] };
