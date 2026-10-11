// Layer 1's trigger for combined runs (PRD section 4): when an owner's checkpoint is recorded, find
// the scopes it changes, and schedule one combined run per owner of a scope that declares a
// dependency on one of them. The integration runner claims each run, merges the checkpoint with that
// owner's latest checkpoint and runs the owner's allowlisted tests on the merged tree, then reports
// the result to POST /combined-runs, which opens a Huddle when tests failed (huddle-open.ts).
//
// Everything here reads Git objects through the Artifacts binding and the agent's SQL store; nothing
// calls a model.
//
// The change a checkpoint makes is the diff between the checkpoint and its baseline: the newest
// commit on the checkpoint's first-parent chain that is also on the base repo's first-parent chain.
// A checkpoint made from the base repo's main branch has that branch's commit as its baseline.
//
// A run is keyed by the trigger checkpoint and the dependent owner's checkpoint, so reporting the
// same checkpoint twice schedules nothing new. A run carries command IDs (`test:<scope id>`), never
// shell commands: the runner resolves each ID from the repository's own config.

import { COMMAND_ID_PATTERN, type CombinedRunEvent, type CombinedResultStatus } from "@penguin/protocol";
import { affectedOwners, type ScopeMap } from "@penguin/scope-map";

import { BASE_BRANCH } from "./base-repo.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import type { IssuesRepoReader } from "./push-ingest.ts";

type Row = Record<string, SqlValue>;

export const COMBINED_RUN_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS CombinedRun (
    run_id TEXT PRIMARY KEY, trigger_owner TEXT NOT NULL, trigger_sha TEXT NOT NULL, baseline_sha TEXT NOT NULL,
    owner_id TEXT NOT NULL, owner_checkpoint TEXT NOT NULL, command_ids TEXT NOT NULL, status TEXT NOT NULL,
    claimed_by TEXT, claimed_at INTEGER, completed_at INTEGER, scheduled_at INTEGER NOT NULL,
    UNIQUE (trigger_owner, trigger_sha, owner_id, owner_checkpoint))`,
];

/** How long a claimed run stays with its runner before another claim may take it again. */
export const COMBINED_RUN_LEASE_MS = 30 * 60_000;

/** The most triggers one claim hands out. Every claimable run of a trigger goes out together. */
export const CLAIM_TRIGGER_LIMIT = 8;

/** How far back the baseline search walks each first-parent chain. */
export const BASELINE_SEARCH_LIMIT = 1_000;

/** The most trees one diff reads, so a huge checkpoint cannot hold the agent indefinitely. */
export const MAX_TREE_READS = 5_000;

/** `scheduled` until a runner claims it, `claimed` until its result is reported, then the result. */
export type CombinedRunStatus = "scheduled" | "claimed" | "passed" | "failed" | "conflict";

export interface CombinedRun {
  readonly runId: string;
  /** The checkpoint whose change to a depended-on scope scheduled the run. */
  readonly trigger: { readonly ownerId: string; readonly sha: string; readonly baselineSha: string };
  /** The dependent owner, whose latest checkpoint is merged with the trigger. */
  readonly ownerId: string;
  readonly ownerCheckpoint: string;
  /** The dependent owner's allowlisted test commands, `test:<scope id>`, one per dependent scope. */
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
    for (const statement of COMBINED_RUN_SCHEMA) db.exec(statement);
  }

  get(runId: string): CombinedRun | undefined {
    const [row] = this.#db.exec(`SELECT * FROM CombinedRun WHERE run_id = ?`, runId);
    return row === undefined ? undefined : combinedRun(row);
  }

  /** Every run a checkpoint triggered, by dependent owner. */
  byTrigger(ownerId: string, sha: string): CombinedRun[] {
    return this.#db
      .exec(`SELECT * FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? ORDER BY owner_id`, ownerId, sha)
      .map(combinedRun);
  }

  /**
   * Schedules a run unless one exists for the same trigger and dependent checkpoint. Returns the new
   * run, or undefined when it already existed.
   */
  schedule(run: Pick<CombinedRun, "trigger" | "ownerId" | "ownerCheckpoint" | "commandIds">): CombinedRun | undefined {
    const runId = this.#newId();
    this.#db.exec(
      `INSERT INTO CombinedRun (run_id, trigger_owner, trigger_sha, baseline_sha, owner_id, owner_checkpoint,
         command_ids, status, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
       ON CONFLICT (trigger_owner, trigger_sha, owner_id, owner_checkpoint) DO NOTHING`,
      runId,
      run.trigger.ownerId,
      run.trigger.sha,
      run.trigger.baselineSha,
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
    const claimable = `(status = 'scheduled' OR (status = 'claimed' AND claimed_at <= ?))`;
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
          `SELECT run_id FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? AND ${claimable} ORDER BY owner_id`,
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
   * Records the result of each run the event answers: the run for the event's trigger and each
   * result's owner and checkpoint. An owner with several dependent scopes gets the worst of their
   * results: failed, then conflict, then passed. Returns the runs completed.
   */
  complete(event: CombinedRunEvent): CombinedRun[] {
    const outcomes = new Map<string, { ownerId: string; ownerCheckpoint: string; status: CombinedRunStatus }>();
    for (const result of event.results) {
      const status = runStatus(result.status);
      if (status === undefined || result.ownerCheckpoint === null) continue;
      const key = `${result.ownerId} ${result.ownerCheckpoint}`;
      const known = outcomes.get(key);
      if (known === undefined || SEVERITY[status] > SEVERITY[known.status]) {
        outcomes.set(key, { ownerId: result.ownerId, ownerCheckpoint: result.ownerCheckpoint, status });
      }
    }
    const { ownerId: triggerOwner, sha } = event.trigger;
    const completed: CombinedRun[] = [];
    for (const outcome of outcomes.values()) {
      const [row] = this.#db.exec(
        `SELECT run_id FROM CombinedRun WHERE trigger_owner = ? AND trigger_sha = ? AND owner_id = ?
           AND owner_checkpoint = ? AND status IN ('scheduled', 'claimed')`,
        triggerOwner,
        sha,
        outcome.ownerId,
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
}

const SEVERITY: Record<CombinedRunStatus, number> = { scheduled: 0, claimed: 0, passed: 1, conflict: 2, failed: 3 };

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
  /** An owner's latest recorded checkpoint, or undefined before their first report. */
  latestCheckpoint(ownerId: string): string | undefined;
  readonly runs: CombinedRunStore;
}

export interface ScheduleOutcome {
  /** The commit the checkpoint was made from, or null when no dependency made it worth finding. */
  readonly baselineSha: string | null;
  /** Scopes the checkpoint changes. */
  readonly changedScopes: readonly string[];
  /** Scopes of other owners that depend on a changed scope. */
  readonly dependentScopes: readonly string[];
  /** Runs this call scheduled. */
  readonly scheduled: readonly CombinedRun[];
  /** Dependent owners with no checkpoint to merge with, so no run. */
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
 * Schedules the combined runs that `owner`'s checkpoint `sha` calls for: one per owner of a scope
 * that depends on a scope the checkpoint changes, with that owner's latest checkpoint. The checkpoint
 * owner's own scopes are never merged with themselves. Runs already scheduled for the same pair of
 * checkpoints are kept, not repeated.
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
    const scopeOwner = deps.scopeMap.scopes.get(scopeId)?.ownerId;
    if (scopeOwner === undefined || scopeOwner === owner) continue;
    byOwner.set(scopeOwner, [...(byOwner.get(scopeOwner) ?? []), scopeId]);
  }

  const trigger = { ownerId: owner, sha, baselineSha };
  const scheduled: CombinedRun[] = [];
  const withoutCheckpoint: string[] = [];
  for (const [ownerId, scopes] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
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
    dependentScopes: [...byOwner.values()].flat().sort(),
    scheduled,
    withoutCheckpoint,
  };
}

/** The command ID of a scope's tests, or undefined when the scope ID cannot form a valid one. */
function testCommandId(scopeId: string): string | undefined {
  const id = `test:${scopeId}`;
  return COMMAND_ID.test(id) && id.length <= 64 ? id : undefined;
}

async function findBaseline(
  deps: ScheduleDeps,
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
