// Layer 1's trigger for combined runs (PRD section 4): when an owner's checkpoint is recorded, find
// the scopes it changes, and schedule one combined run per target that may read them. A target is
// one running feature's fork (PRD 0.4 section 1: a person owns n features, each its own fork), so a
// person with two running features gets two runs, keyed by feature id. A person who depends on a
// changed scope and runs no feature with a checkpoint keeps one target: their owner fork. The
// integration runner claims each run, merges the checkpoint with the target's latest checkpoint and
// runs the allowlisted tests on the merged tree, then reports the result to POST /combined-runs,
// which opens a Huddle when an owner fork's tests failed (huddle-open.ts).
//
// Everything here reads Git objects through the Artifacts binding and the agent's SQL store; nothing
// calls a model.
//
// The change a checkpoint makes is the diff between the checkpoint and its baseline: the newest
// commit on the checkpoint's first-parent chain that is also on the base repo's first-parent chain.
// A checkpoint made from the base repo's main branch has that branch's commit as its baseline.
//
// A run is keyed by the trigger checkpoint, the target and the target's checkpoint, so reporting the
// same checkpoint twice schedules nothing new. A run carries command IDs (`test:<scope id>`), never
// shell commands: the runner resolves each ID from the repository's own config.

import {
  COMMAND_ID_PATTERN,
  type BlockCheck,
  type CombinedRunEvent,
  type CombinedResultStatus,
} from "@penguin/protocol";
import { affectedOwners, type ScopeMap } from "@penguin/scope-map";

import { BASE_BRANCH } from "./base-repo.ts";
import type { Feature } from "./feature-store.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import { touchedScopes } from "./plan-facts.ts";
import { notStopped, RUN_FAILURE_SCHEMA, type ReleaseOutcome } from "./run-failures.ts";
import type { IssuesRepoReader } from "./push-ingest.ts";

type Row = Record<string, SqlValue>;

export const COMBINED_RUN_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS CombinedRun (
    run_id TEXT PRIMARY KEY, trigger_owner TEXT NOT NULL, trigger_sha TEXT NOT NULL, baseline_sha TEXT NOT NULL,
    target TEXT NOT NULL, fork TEXT NOT NULL, owner_id TEXT NOT NULL, owner_checkpoint TEXT NOT NULL,
    command_ids TEXT NOT NULL, status TEXT NOT NULL, claimed_by TEXT, claimed_at INTEGER, completed_at INTEGER,
    scheduled_at INTEGER NOT NULL, UNIQUE (trigger_owner, trigger_sha, target, owner_checkpoint))`,
  // One row per section 5.1 check on one merged tree of a trigger. A later report of the same check
  // on the same target commit replaces it.
  `CREATE TABLE IF NOT EXISTS BlockCheck (
    trigger_owner TEXT NOT NULL, trigger_sha TEXT NOT NULL, plan_id TEXT, target TEXT NOT NULL,
    target_commit TEXT NOT NULL, check_name TEXT NOT NULL, command_id TEXT NOT NULL, result TEXT NOT NULL,
    fingerprint TEXT, log_ref TEXT, record TEXT NOT NULL, recorded_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_owner, trigger_sha, target, target_commit, check_name, command_id))`,
];

/**
 * Moves a CombinedRun table from before #104, keyed by owner, to the one keyed by target. Each old
 * run was an owner fork's, so its target is its owner and its fork `owner-<owner>`.
 */
function migrateToTargets(db: SqlDatabase): void {
  const columns = new Set(db.exec(`PRAGMA table_info(CombinedRun)`).map((row) => row["name"]));
  if (columns.size === 0 || columns.has("target")) return;
  db.transaction(() => {
    db.exec(`ALTER TABLE CombinedRun RENAME TO CombinedRunByOwner`);
    db.exec(COMBINED_RUN_SCHEMA[0] as string);
    db.exec(
      `INSERT INTO CombinedRun (run_id, trigger_owner, trigger_sha, baseline_sha, target, fork, owner_id, owner_checkpoint,
         command_ids, status, claimed_by, claimed_at, completed_at, scheduled_at)
       SELECT run_id, trigger_owner, trigger_sha, baseline_sha, owner_id, 'owner-' || owner_id, owner_id, owner_checkpoint,
         command_ids, status, claimed_by, claimed_at, completed_at, scheduled_at FROM CombinedRunByOwner`,
    );
    db.exec(`DROP TABLE CombinedRunByOwner`);
  });
}

/** How long a claimed run stays with its runner before another claim may take it again. */
export const COMBINED_RUN_LEASE_MS = 30 * 60_000;

/** The most triggers one claim hands out. Every claimable run of a trigger goes out together. */
export const CLAIM_TRIGGER_LIMIT = 8;

/** How far back the baseline search walks each first-parent chain. */
export const BASELINE_SEARCH_LIMIT = 1_000;

/** The most trees one diff reads, so a huge checkpoint cannot hold the agent indefinitely. */
export const MAX_TREE_READS = 5_000;

/**
 * `scheduled` until a runner claims it, `claimed` until its result is reported, then the result.
 * `not-affected`: the impact graph showed the owner's checkpoint uses nothing the change touches,
 * so the runner skipped the owner's tests; the run is complete.
 */
export type CombinedRunStatus = "scheduled" | "claimed" | "passed" | "failed" | "conflict" | "not-affected";

export interface CombinedRun {
  readonly runId: string;
  /** The checkpoint whose change to a depended-on scope scheduled the run. */
  readonly trigger: { readonly ownerId: string; readonly sha: string; readonly baselineSha: string };
  /** The running feature's id, or the person's id for their owner fork. */
  readonly target: string;
  /** The target's fork, `feature-<id>` or `owner-<id>`, without the deployment's prefix. */
  readonly fork: string;
  /** The target's person, routed its failures. */
  readonly ownerId: string;
  /** The target's latest checkpoint, merged with the trigger. */
  readonly ownerCheckpoint: string;
  /** The target's allowlisted test commands, `test:<scope id>`, one per dependent scope. */
  readonly commandIds: readonly string[];
  readonly status: CombinedRunStatus;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  readonly scheduledAt: string;
}

export type ClaimListing =
  | { readonly status: "ok"; readonly runs: readonly CombinedRun[] }
  | { readonly status: "forbidden"; readonly message: string };

export interface CombinedRunStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly leaseMs?: number;
}

const COMMAND_ID = new RegExp(`^${COMMAND_ID_PATTERN}$`, "u");

export class CombinedRunStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #leaseMs: number;

  constructor(db: SqlDatabase, options: CombinedRunStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => `run_${crypto.randomUUID()}`);
    this.#leaseMs = options.leaseMs ?? COMBINED_RUN_LEASE_MS;
    migrateToTargets(db);
    for (const statement of [...COMBINED_RUN_SCHEMA, ...RUN_FAILURE_SCHEMA]) db.exec(statement);
  }

  get(runId: string): CombinedRun | undefined {
    const [row] = this.#db.exec(`SELECT * FROM CombinedRun WHERE run_id = ?`, runId);
    return row === undefined ? undefined : combinedRun(row);
  }

  /** Every run a checkpoint triggered, by person, then target. */
  byTrigger(ownerId: string, sha: string): CombinedRun[] {
    return this.#db
      .exec(`SELECT * FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? ORDER BY owner_id, target`, ownerId, sha)
      .map(combinedRun);
  }

  /**
   * Schedules a run unless one exists for the same trigger, target and target checkpoint. Without a
   * `target`, the run is `ownerId`'s owner fork. Returns the new run, or undefined when it existed.
   */
  schedule(
    run: Pick<CombinedRun, "trigger" | "ownerId" | "ownerCheckpoint" | "commandIds"> & Partial<Pick<CombinedRun, "target" | "fork">>,
  ): CombinedRun | undefined {
    const runId = this.#newId();
    this.#db.exec(
      `INSERT INTO CombinedRun (run_id, trigger_owner, trigger_sha, baseline_sha, target, fork, owner_id, owner_checkpoint,
         command_ids, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
       ON CONFLICT (trigger_owner, trigger_sha, target, owner_checkpoint) DO NOTHING`,
      runId,
      run.trigger.ownerId,
      run.trigger.sha,
      run.trigger.baselineSha,
      run.target ?? run.ownerId,
      run.fork ?? `owner-${run.ownerId}`,
      run.ownerId,
      run.ownerCheckpoint,
      JSON.stringify(run.commandIds),
      this.#now(),
    );
    return this.get(runId);
  }

  /**
   * Hands the runner every claimable run of up to CLAIM_TRIGGER_LIMIT triggers, oldest first, and
   * marks them claimed by `caller`. A run is claimable when scheduled, or when its claim's lease ran
   * out without a report. Only a bridge with the runner role may claim.
   */
  claim(caller: BridgeCaller): ClaimListing {
    if (caller.role !== "runner") {
      return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    }
    const now = this.#now();
    const expired = now - this.#leaseMs;
    const claimable = `(status = 'scheduled' OR (status = 'claimed' AND claimed_at <= ?)) AND ${notStopped("combined", "run_id")}`;
    return this.#db.transaction((): ClaimListing => {
      const triggers = this.#db.exec(
        `SELECT trigger_owner, trigger_sha FROM CombinedRun WHERE ${claimable}
         GROUP BY trigger_owner, trigger_sha ORDER BY MIN(scheduled_at), MIN(rowid) LIMIT ?`,
        expired,
        CLAIM_TRIGGER_LIMIT,
      );
      const runs: CombinedRun[] = [];
      for (const trigger of triggers) {
        const rows = this.#db.exec(
          `SELECT run_id FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? AND ${claimable} ORDER BY owner_id, target`,
          trigger["trigger_owner"] as string,
          trigger["trigger_sha"] as string,
          expired,
        );
        for (const row of rows) {
          const runId = row["run_id"] as string;
          this.#db.exec(
            `UPDATE CombinedRun SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE run_id = ?`,
            caller.bridgeId,
            now,
            runId,
          );
          runs.push(this.get(runId) as CombinedRun);
        }
      }
      return { status: "ok", runs };
    });
  }

  /**
   * Hands claimed run `runId` back to the schedule when `runnerId` holds its claim, so the next claim
   * of any runner takes it (run-failures.ts). The trigger's person is routed a stopped run.
   */
  release(runId: string, runnerId: string): ReleaseOutcome {
    const run = this.get(runId);
    if (run === undefined) return { status: "rejected", reason: "not_found", message: `no combined run ${runId}` };
    if (run.status !== "claimed") return { status: "rejected", reason: "conflict", message: `combined run ${runId} is ${run.status}, not claimed` };
    if (run.claimedBy !== runnerId) return { status: "rejected", reason: "forbidden", message: `combined run ${runId} is claimed by another runner` };
    this.#db.exec(`UPDATE CombinedRun SET status = 'scheduled', claimed_by = NULL, claimed_at = NULL WHERE run_id = ?`, runId);
    return { status: "released", featureId: null, personId: run.trigger.ownerId };
  }

  /**
   * Records the result of each run the event answers: the run for the event's trigger and each
   * result's target and checkpoint. A target with several dependent scopes gets the worst of its
   * results: failed, then conflict, then passed, then not affected. The event's block checks are
   * recorded with the trigger. Returns the runs completed.
   */
  complete(event: CombinedRunEvent): CombinedRun[] {
    this.#recordChecks(event);
    const outcomes = new Map<string, { target: string; ownerCheckpoint: string; status: CombinedRunStatus }>();
    for (const result of event.results) {
      const status = runStatus(result.status);
      if (status === undefined || result.ownerCheckpoint === null) continue;
      const key = `${result.target} ${result.ownerCheckpoint}`;
      const known = outcomes.get(key);
      if (known === undefined || SEVERITY[status] > SEVERITY[known.status]) {
        outcomes.set(key, { target: result.target, ownerCheckpoint: result.ownerCheckpoint, status });
      }
    }
    const { ownerId: triggerOwner, sha } = event.trigger;
    const completed: CombinedRun[] = [];
    for (const outcome of outcomes.values()) {
      const [row] = this.#db.exec(
        `SELECT run_id FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? AND target = ?
           AND owner_checkpoint = ? AND status IN ('scheduled', 'claimed')`,
        triggerOwner,
        sha,
        outcome.target,
        outcome.ownerCheckpoint,
      );
      if (row === undefined) continue;
      const runId = row["run_id"] as string;
      this.#db.exec(
        `UPDATE CombinedRun SET status = ?, completed_at = ? WHERE run_id = ?`,
        outcome.status,
        this.#now(),
        runId,
      );
      completed.push(this.get(runId) as CombinedRun);
    }
    return completed;
  }

  /**
   * The event without the results of runs on a feature's fork. A Huddle is opened on owner forks
   * only (huddle-open.ts); a feature's failures stay with its block checks and its run's status.
   * A result no scheduled run names is kept.
   */
  ownerForkResults(event: CombinedRunEvent): CombinedRunEvent {
    const featureRuns = new Set(
      this.byTrigger(event.trigger.ownerId, event.trigger.sha)
        .filter((run) => run.fork.startsWith("feature-"))
        .map((run) => `${run.target} ${run.ownerCheckpoint}`),
    );
    if (featureRuns.size === 0) return event;
    const results = event.results.filter((result) => !featureRuns.has(`${result.target} ${result.ownerCheckpoint}`));
    return { ...event, results };
  }

  /** The block checks recorded for a trigger, by target, then in the order the runner sent them. */
  checks(ownerId: string, sha: string): BlockCheck[] {
    return this.#db
      .exec(
        `SELECT record FROM BlockCheck WHERE trigger_owner = ? AND trigger_sha = ? ORDER BY target, rowid`,
        ownerId,
        sha,
      )
      .map((row) => JSON.parse(row["record"] as string) as BlockCheck);
  }

  #recordChecks(event: CombinedRunEvent): void {
    const { ownerId, sha } = event.trigger;
    for (const check of event.checks ?? []) {
      this.#db.exec(
        `INSERT OR REPLACE INTO BlockCheck (trigger_owner, trigger_sha, plan_id, target, target_commit, check_name,
           command_id, result, fingerprint, log_ref, record, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ownerId,
        sha,
        check.planId,
        check.target,
        check.input.target,
        check.check,
        check.tool.commandId,
        check.result,
        check.fingerprint?.id ?? null,
        check.logRef,
        JSON.stringify(check),
        this.#now(),
      );
    }
  }
}

// A target with one affected and one unaffected scope completes with the affected scope's result.
const SEVERITY: Record<CombinedRunStatus, number> = {
  scheduled: 0,
  claimed: 0,
  "not-affected": 1,
  passed: 2,
  conflict: 3,
  failed: 4,
};

function runStatus(status: CombinedResultStatus): CombinedRunStatus | undefined {
  return status === "no-checkpoint" ? undefined : status;
}

function combinedRun(row: Row): CombinedRun {
  return {
    runId: row["run_id"] as string,
    trigger: {
      ownerId: row["trigger_owner"] as string,
      sha: row["trigger_sha"] as string,
      baselineSha: row["baseline_sha"] as string,
    },
    target: row["target"] as string,
    fork: row["fork"] as string,
    ownerId: row["owner_id"] as string,
    ownerCheckpoint: row["owner_checkpoint"] as string,
    commandIds: JSON.parse(row["command_ids"] as string) as string[],
    status: row["status"] as CombinedRunStatus,
    claimedBy: (row["claimed_by"] as string | null) ?? null,
    claimedAt: isoTime(row["claimed_at"]),
    completedAt: isoTime(row["completed_at"]),
    scheduledAt: isoTime(row["scheduled_at"]) as string,
  };
}

function isoTime(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : new Date(Number(value)).toISOString();
}

/** The binding methods the detection reads: a repo's first-parent log and its trees. */
export type RepoHistoryReader = Pick<IssuesRepoReader, "log" | "readTree">;

export interface ScheduleDeps {
  /** The project's scope map, whose `depends_on` entries decide who depends on a changed scope. */
  readonly scopeMap: ScopeMap;
  /** The trigger owner's fork, which holds the checkpoint. */
  readonly fork: RepoHistoryReader;
  /** The project base repo; its branch's first-parent chain holds the checkpoint's baseline. */
  readonly base: Pick<IssuesRepoReader, "log">;
  /** An owner fork's latest recorded checkpoint, or undefined before the owner's first report. */
  latestCheckpoint(ownerId: string): string | undefined;
  /** Every feature; the running ones with a checkpoint are targets. Absent: owner forks only. */
  readonly features?: () => readonly Feature[];
  readonly runs: CombinedRunStore;
}

export interface ScheduleOutcome {
  /** The commit the checkpoint was made from, or null when no dependency made it worth finding. */
  readonly baselineSha: string | null;
  /** Scopes the checkpoint changes. */
  readonly changedScopes: readonly string[];
  /** Scopes that depend on a changed scope and that a run tests, or whose owner has no checkpoint. */
  readonly dependentScopes: readonly string[];
  /** Runs this call scheduled, one per target. */
  readonly scheduled: readonly CombinedRun[];
  /** Dependent owners with no running feature and no owner fork checkpoint to merge with, so no run. */
  readonly withoutCheckpoint: readonly string[];
}

const NOTHING: ScheduleOutcome = {
  baselineSha: null,
  changedScopes: [],
  dependentScopes: [],
  scheduled: [],
  withoutCheckpoint: [],
};

/**
 * Schedules the combined runs that `owner`'s checkpoint `sha` calls for, one per target:
 *
 * - each running feature with a checkpoint whose person owns, or whose area touches, a scope that
 *   depends on a scope the checkpoint changes, tested in those scopes;
 * - for a person who owns such a scope and runs no such feature, their owner fork's latest
 *   checkpoint, tested in the scopes they own.
 *
 * The checkpoint owner's own forks are never merged with the checkpoint. Runs already scheduled for
 * the same trigger, target and target checkpoint are kept, not repeated.
 *
 * Raises:
 *   Error: when the checkpoint is not in the fork, no baseline is found, or the diff is too large.
 */
export async function scheduleCombinedRuns(deps: ScheduleDeps, owner: string, sha: string): Promise<ScheduleOutcome> {
  // A project with no declared dependency has nothing to run: skip every Git read.
  if (deps.scopeMap.dependents.size === 0) return NOTHING;
  const { baselineSha, baselineTree, checkpointTree } = await findBaseline(deps, sha);
  const changed = await changedPaths(deps.fork, baselineTree, checkpointTree);
  const affected = affectedOwners(deps.scopeMap, changed);

  const byOwner = new Map<string, string[]>();
  for (const scopeId of affected.dependentScopes) {
    const scopeOwner = deps.scopeMap.scopes.get(scopeId)?.driId;
    if (scopeOwner === undefined || scopeOwner === owner) continue;
    byOwner.set(scopeOwner, [...(byOwner.get(scopeOwner) ?? []), scopeId]);
  }

  const trigger = { ownerId: owner, sha, baselineSha };
  const scheduled: CombinedRun[] = [];
  const withoutCheckpoint: string[] = [];
  const tested = new Set<string>();
  const dependents = new Set(affected.dependentScopes);
  const scopeOwner = (scopeId: string) => deps.scopeMap.scopes.get(scopeId)?.driId;
  // Each running feature is a target of its own, so one person's features are merged one by one.
  const running = (deps.features?.() ?? [])
    .filter((feature) => RUNNING_STATES.has(feature.state) && feature.repo !== null && feature.latestCheckpointSha !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const withFeature = new Set<string>();
  for (const feature of running) {
    if (feature.personId === owner) continue;
    const touched = touchedScopes(feature, deps.scopeMap);
    const scopes = [...dependents].filter((scopeId) => scopeOwner(scopeId) === feature.personId || touched.has(scopeId));
    const commandIds = scopes.map(testCommandId).filter((id): id is string => id !== undefined);
    if (commandIds.length === 0) continue;
    withFeature.add(feature.personId);
    for (const scopeId of scopes) tested.add(scopeId);
    const ownerCheckpoint = feature.latestCheckpointSha as string;
    const target = { target: feature.id, fork: `feature-${feature.id}`, ownerId: feature.personId };
    const run = deps.runs.schedule({ trigger, ...target, ownerCheckpoint, commandIds });
    if (run !== undefined) scheduled.push(run);
  }
  for (const [ownerId, scopes] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
    for (const scopeId of scopes) tested.add(scopeId);
    if (withFeature.has(ownerId)) continue;
    const ownerCheckpoint = deps.latestCheckpoint(ownerId);
    if (ownerCheckpoint === undefined) {
      withoutCheckpoint.push(ownerId);
      continue;
    }
    const commandIds = scopes.map(testCommandId).filter((id): id is string => id !== undefined);
    if (commandIds.length === 0) continue;
    const run = deps.runs.schedule({ trigger, ownerId, ownerCheckpoint, commandIds });
    if (run !== undefined) scheduled.push(run);
  }
  return {
    baselineSha,
    changedScopes: affected.changedScopes,
    dependentScopes: [...tested].sort(),
    scheduled,
    withoutCheckpoint,
  };
}

/** The command ID of a scope's tests, or undefined when the scope ID cannot form a valid one. */
function testCommandId(scopeId: string): string | undefined {
  const id = `test:${scopeId}`;
  return COMMAND_ID.test(id) && id.length <= 64 ? id : undefined;
}

/**
 * The files checkpoint `sha` in `fork` changes against its baseline, and that baseline. A feature's
 * checkpoint updates the feature's declared area from these paths (feature-open.ts).
 *
 * Raises:
 *   Error: when the checkpoint is not in the fork, no baseline is found, or the diff is too large.
 */
export async function checkpointChange(
  fork: RepoHistoryReader,
  base: Pick<IssuesRepoReader, "log">,
  sha: string,
): Promise<{ readonly baselineSha: string; readonly paths: string[] }> {
  const { baselineSha, baselineTree, checkpointTree } = await findBaseline({ fork, base }, sha);
  return { baselineSha, paths: await changedPaths(fork, baselineTree, checkpointTree) };
}

/**
 * The baseline of checkpoint `sha` in `fork`: the newest commit on its first-parent chain that is
 * also on main's. A review's side-by-side run compares the checkpoint with it (review-record.ts).
 *
 * Raises:
 *   Error: when the checkpoint is not in the fork or no baseline is found.
 */
export async function checkpointBaseline(fork: Pick<IssuesRepoReader, "log">, base: Pick<IssuesRepoReader, "log">, sha: string): Promise<string> {
  return (await findBaseline({ fork, base }, sha)).baselineSha;
}

async function findBaseline(
  deps: { readonly fork: Pick<IssuesRepoReader, "log">; readonly base: Pick<IssuesRepoReader, "log"> },
  sha: string,
): Promise<{ baselineSha: string; baselineTree: string; checkpointTree: string }> {
  const chain = await deps.fork.log({ ref: sha, limit: BASELINE_SEARCH_LIMIT, offset: 0 });
  const [head] = chain;
  if (head?.hash !== sha) throw new Error(`checkpoint ${sha} is not in the owner's fork`);
  const main = new Set((await deps.base.log({ ref: BASE_BRANCH, limit: BASELINE_SEARCH_LIMIT, offset: 0 })).map((c) => c.hash));
  const baseline = chain.find((commit) => main.has(commit.hash));
  if (baseline === undefined) {
    throw new Error(`no commit of the base repo's main branch is within ${BASELINE_SEARCH_LIMIT} first parents of ${sha}`);
  }
  return { baselineSha: baseline.hash, baselineTree: baseline.treeHash, checkpointTree: head.treeHash };
}

/**
 * The paths of files that differ between two trees: added, removed or changed. Subtrees with equal
 * hashes are skipped, so the cost follows the size of the change, not of the repository.
 */
export async function changedPaths(repo: Pick<IssuesRepoReader, "readTree">, from: string, to: string): Promise<string[]> {
  const paths: string[] = [];
  let reads = 0;
  const read = async (hash: string | undefined) => {
    if (hash === undefined) return new Map<string, { hash: string; type: string }>();
    if (++reads > MAX_TREE_READS) throw new Error(`the checkpoint's diff reads more than ${MAX_TREE_READS} trees`);
    const entries = await repo.readTree(hash);
    if (entries === null) throw new Error(`tree ${hash} is missing`);
    return new Map(entries.map((entry) => [entry.name, entry]));
  };
  const walk = async (a: string | undefined, b: string | undefined, prefix: string): Promise<void> => {
    if (a === b) return;
    const [left, right] = await Promise.all([read(a), read(b)]);
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(name);
      const r = right.get(name);
      if (l?.hash === r?.hash && l?.type === r?.type) continue;
      const path = `${prefix}${name}`;
      const lTree = l?.type === "tree" ? l.hash : undefined;
      const rTree = r?.type === "tree" ? r.hash : undefined;
      // A file on either side is a changed path; a tree on either side is walked for its files.
      if ((l !== undefined && lTree === undefined) || (r !== undefined && rTree === undefined)) paths.push(path);
      if (lTree !== undefined || rTree !== undefined) await walk(lTree, rTree, `${path}/`);
    }
  };
  await walk(from, to, "");
  return paths.sort();
}
