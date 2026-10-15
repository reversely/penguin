// Layer 1's trigger for combined runs (PRD section 4): when a checkpoint is recorded, find the running
// features it may break and schedule one combined run per target. A target is one running feature's
// fork (PRD 0.4 section 1: a person owns n features, each its own fork), so a person with two running
// features gets two runs, keyed by feature id. The integration runner claims each run, merges the
// checkpoint with the target's latest checkpoint and runs the allowlisted tests on the merged tree,
// then reports the result to POST /combined-runs, which opens a Huddle when an owner fork's tests
// failed (huddle-open.ts).
//
// A feature's checkpoint picks its targets from the caller list (caller-list.ts, #198): the running
// features that call a name the checkpoint modifies, plus those whose area holds a file it changes.
// Its runs are scheduled when the runner reports the checkpoint's list. Without that list, or with
// an incomplete one, the scopes the checkpoint changes pick the targets as for an owner fork's
// checkpoint, which keeps no list: each running feature or owner fork in a scope whose `depends_on`
// names a changed scope. A running feature with no complete list read at its latest checkpoint is
// still picked that way, so a list not reported yet misses nothing.
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
import type { CallerListStore } from "./caller-list.ts";
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
    scheduled_at INTEGER NOT NULL, trigger_fork TEXT, UNIQUE (trigger_owner, trigger_sha, target, owner_checkpoint))`,
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

/**
 * Adds the trigger's fork to a CombinedRun table from before #198, when every trigger was an owner
 * fork's checkpoint: a run with none reads as `owner-<trigger owner>`.
 */
function addTriggerFork(db: SqlDatabase): void {
  const columns = new Set(db.exec(`PRAGMA table_info(CombinedRun)`).map((row) => row["name"]));
  if (!columns.has("trigger_fork")) db.exec(`ALTER TABLE CombinedRun ADD COLUMN trigger_fork TEXT`);
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
  /**
   * The checkpoint whose change scheduled the run, with the fork that holds it, `owner-<id>` or
   * `feature-<id>`, without the deployment's prefix.
   */
  readonly trigger: { readonly ownerId: string; readonly sha: string; readonly baselineSha: string; readonly fork: string };
  /** The running feature's id, or the person's id for their owner fork. */
  readonly target: string;
  /** The target's fork, `feature-<id>` or `owner-<id>`, without the deployment's prefix. */
  readonly fork: string;
  /** The target's person, routed its failures. */
  readonly ownerId: string;
  /** The target's latest checkpoint, merged with the trigger. */
  readonly ownerCheckpoint: string;
  /** The target's allowlisted test commands, `test:<scope id>`, one per scope the run tests. */
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
    addTriggerFork(db);
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
      `INSERT INTO CombinedRun (run_id, trigger_owner, trigger_sha, baseline_sha, trigger_fork, target, fork, owner_id,
         owner_checkpoint, command_ids, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
       ON CONFLICT (trigger_owner, trigger_sha, target, owner_checkpoint) DO NOTHING`,
      runId,
      run.trigger.ownerId,
      run.trigger.sha,
      run.trigger.baselineSha,
      run.trigger.fork,
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
      fork: (row["trigger_fork"] as string | null) ?? `owner-${String(row["trigger_owner"])}`,
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

/**
 * The Artifacts repo that holds checkpoint `sha` of `ownerId`, which a combined run report's Huddle
 * reads its trigger from: the feature's own fork when the runs were scheduled from a feature
 * checkpoint of that person, else `ownerForkRepo`, the owner fork the Worker names.
 */
export function triggerRepo(
  runs: Pick<CombinedRunStore, "byTrigger">,
  features: { get(id: string): Feature | undefined },
  trigger: { readonly ownerId: string; readonly sha: string },
  ownerForkRepo: string,
): string {
  const fork = runs.byTrigger(trigger.ownerId, trigger.sha)[0]?.trigger.fork;
  if (fork === undefined || !fork.startsWith("feature-")) return ownerForkRepo;
  const feature = features.get(fork.slice("feature-".length));
  return feature?.personId === trigger.ownerId && feature.repo !== null ? feature.repo : ownerForkRepo;
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
  /** The caller list, which picks a feature checkpoint's targets once it holds the checkpoint's list. Absent: scope dependencies pick them. */
  readonly callers?: Pick<CallerListStore, "listedAt" | "callersOf" | "completeLists">;
  readonly runs: CombinedRunStore;
}

export interface ScheduleOutcome {
  /** The commit the checkpoint was made from, or null when nothing made it worth finding. */
  readonly baselineSha: string | null;
  /** Scopes the checkpoint changes. */
  readonly changedScopes: readonly string[];
  /** Scopes a run tests, or that depend on a changed scope and whose owner has no checkpoint. */
  readonly testedScopes: readonly string[];
  /** True when the checkpoint's caller list picked the running features; false when scope dependencies did. */
  readonly fromCallerList: boolean;
  /** Runs this call scheduled, one per target. */
  readonly scheduled: readonly CombinedRun[];
  /** Dependent owners with no running feature and no owner fork checkpoint to merge with, so no run. */
  readonly withoutCheckpoint: readonly string[];
}

const NOTHING: ScheduleOutcome = {
  baselineSha: null,
  changedScopes: [],
  testedScopes: [],
  fromCallerList: false,
  scheduled: [],
  withoutCheckpoint: [],
};

/**
 * Schedules the combined runs that `owner`'s checkpoint `sha` calls for, one per target. `feature`
 * names the feature whose fork holds the checkpoint; absent, it is the owner fork's. Each running
 * feature with a checkpoint is a target, tested in the scopes it touches, when:
 *
 * - the caller list holds the complete list of checkpoint `sha` of `feature`, and the feature calls a
 *   name the checkpoint modifies or an area path of its own is a file the checkpoint changes or a
 *   folder that holds one;
 * - otherwise, or when the feature has no complete list read at its latest checkpoint, its person
 *   owns or its area touches a scope that depends on a scope the checkpoint changes, tested in those
 *   scopes. Such a feature reached by the rule above is tested in both sets of scopes.
 *
 * As before the caller list, scope dependencies also pick two more targets:
 *
 * - for a person who owns such a scope and runs no feature the rules above decide, their owner
 *   fork's latest checkpoint, tested in the scopes they own;
 * - for the checkpoint's owner, when they own such a scope, the checkpoint itself, keyed by their
 *   id in the trigger's fork and tested in the scopes they own with no merge.
 *
 * The checkpoint owner's own forks are never merged with the checkpoint. Runs already scheduled for
 * the same trigger, target and target checkpoint are kept, not repeated.
 *
 * Raises:
 *   Error: when the checkpoint is not in the fork, no baseline is found, or the diff is too large.
 */
export async function scheduleCombinedRuns(deps: ScheduleDeps, owner: string, sha: string, feature?: string): Promise<ScheduleOutcome> {
  const listed = feature === undefined ? undefined : deps.callers?.listedAt(feature);
  // The names the checkpoint's change modifies, when its own complete list is stored.
  const reach = listed !== undefined && listed.checkpoint === sha && listed.complete ? listed.changed : undefined;
  // With no list and no declared dependency, nothing picks a target: skip every Git read.
  if (reach === undefined && deps.scopeMap.dependents.size === 0) return NOTHING;
  const { baselineSha, baselineTree, checkpointTree } = await findBaseline(deps, sha);
  const changed = await changedPaths(deps.fork, baselineTree, checkpointTree);
  const affected = affectedOwners(deps.scopeMap, changed);
  const callers = reach === undefined ? undefined : new Set(deps.callers?.callersOf(reach));
  const listedFeatures = reach === undefined ? new Map<string, string>() : (deps.callers?.completeLists() ?? new Map<string, string>());
  const changedFiles = changedFilesAndFolders(changed);

  const byOwner = new Map<string, string[]>();
  for (const scopeId of affected.dependentScopes) {
    const scopeOwner = deps.scopeMap.scopes.get(scopeId)?.driId;
    if (scopeOwner === undefined || scopeOwner === owner) continue;
    byOwner.set(scopeOwner, [...(byOwner.get(scopeOwner) ?? []), scopeId]);
  }

  const trigger = { ownerId: owner, sha, baselineSha, fork: feature === undefined ? `owner-${owner}` : `feature-${feature}` };
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
  for (const other of running) {
    if (other.personId === owner) continue;
    const touched = touchedScopes(other, deps.scopeMap);
    // A feature whose complete list was read at its latest checkpoint is reached or not by the
    // trigger's list. One without such a list may call anything, so scope dependencies also decide it.
    const decided = listedFeatures.get(other.id) === other.latestCheckpointSha;
    // An area path is a file or a folder: `accounts` holds a change to `accounts/shoppers.py`.
    const reached = callers !== undefined && (callers.has(other.id) || other.area.paths.some((path) => changedFiles.has(path.replace(/\/+$/u, ""))));
    if (decided) withFeature.add(other.personId);
    const byDependency = decided ? [] : [...dependents].filter((scopeId) => scopeOwner(scopeId) === other.personId || touched.has(scopeId));
    const scopes = [...new Set([...(reached ? touched : []), ...byDependency])].sort();
    const commandIds = scopes.map(testCommandId).filter((id): id is string => id !== undefined);
    if (commandIds.length === 0) continue;
    withFeature.add(other.personId);
    for (const scopeId of scopes) tested.add(scopeId);
    const ownerCheckpoint = other.latestCheckpointSha as string;
    const target = { target: other.id, fork: `feature-${other.id}`, ownerId: other.personId };
    const run = deps.runs.schedule({ trigger, ...target, ownerCheckpoint, commandIds });
    if (run !== undefined) scheduled.push(run);
  }
  // The checkpoint's own person: their dependent scopes run on the checkpoint itself, which holds
  // their code, so nothing is merged and no other checkpoint is needed.
  const own = affected.dependentScopes.filter((scopeId) => scopeOwner(scopeId) === owner);
  const ownCommands = own.map(testCommandId).filter((id): id is string => id !== undefined);
  if (ownCommands.length > 0) {
    for (const scopeId of own) tested.add(scopeId);
    const run = deps.runs.schedule({ trigger, ownerId: owner, fork: trigger.fork, ownerCheckpoint: sha, commandIds: ownCommands });
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
    testedScopes: [...tested].sort(),
    fromCallerList: callers !== undefined,
    scheduled,
    withoutCheckpoint,
  };
}

/**
 * Every changed file with each folder that holds one, so a feature's area path matches a change by
 * one lookup whether it names the file or a folder above it. The set grows with the change only.
 */
function changedFilesAndFolders(changed: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const path of changed) {
    found.add(path);
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) found.add(path.slice(0, at));
  }
  return found;
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
