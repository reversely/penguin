// Failures a check runner reports for the runs it claimed (POST /runs/failures, run-failure.ts in the
// protocol). Each report releases the run at once, so any runner may take it on its next claim; a
// runner that dies without reporting still loses its claim when the lease ends. Every failure of one
// run is counted in `RunFailure`. At the project's limit (PENGUIN_RUN_FAILURE_LIMIT, 3 by default)
// the run is stopped: each claim or listing leaves it out through `notStopped`, and its feature's
// person gets a `run_failed` inbox item and an exception on the feature with the last reason.
//
// Each store keeps its own claim and releases it only for the runner that holds it: a report from
// any other runner is refused, so one runner can never free another's work.

import { featureOfBlockRun, parseRunFailure, type RunFailureOutcome, type RunKind } from "@penguin/protocol";

import type { BridgeCaller, SqlDatabase } from "./issue-index.ts";

export const RUN_FAILURE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS RunFailure (
    kind TEXT NOT NULL, run_id TEXT NOT NULL, failures INTEGER NOT NULL, reason TEXT NOT NULL, runner_id TEXT NOT NULL,
    feature_id TEXT, person_id TEXT NOT NULL, failed_at INTEGER NOT NULL, stopped_at INTEGER, PRIMARY KEY (kind, run_id))`,
  `CREATE INDEX IF NOT EXISTS RunFailure_feature ON RunFailure (feature_id, stopped_at)`,
];

/**
 * A SQL condition that holds unless the run in `column` is stopped. `kind` is one of RUN_KINDS, a
 * constant of the caller's own, never input.
 */
export function notStopped(kind: RunKind, column: string): string {
  return `NOT EXISTS (SELECT 1 FROM RunFailure WHERE RunFailure.kind = '${kind}' AND RunFailure.run_id = CAST(${column} AS TEXT) AND RunFailure.stopped_at IS NOT NULL)`;
}

/** One run's failures, as the feature page and the team view show a stopped one. */
export interface RunFailure {
  readonly kind: RunKind;
  readonly runId: string;
  readonly failures: number;
  readonly reason: string;
  readonly runnerId: string;
  readonly featureId: string | null;
  readonly personId: string;
  readonly failedAt: string;
  readonly stoppedAt: string | null;
}

type Row = Record<string, unknown>;

function failureOf(row: Row): RunFailure {
  return {
    kind: row["kind"] as RunKind,
    runId: row["run_id"] as string,
    failures: Number(row["failures"]),
    reason: row["reason"] as string,
    runnerId: row["runner_id"] as string,
    featureId: (row["feature_id"] as string | null) ?? null,
    personId: row["person_id"] as string,
    failedAt: new Date(Number(row["failed_at"])).toISOString(),
    stoppedAt: row["stopped_at"] === null ? null : new Date(Number(row["stopped_at"])).toISOString(),
  };
}

export class RunFailureStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of RUN_FAILURE_SCHEMA) db.exec(statement);
  }

  get(kind: RunKind, runId: string): RunFailure | undefined {
    const [row] = this.#db.exec(`SELECT * FROM RunFailure WHERE kind = ? AND run_id = ?`, kind, runId);
    return row === undefined ? undefined : failureOf(row);
  }

  /** Counts one more failure of the run; it is stopped once the count reaches `limit`. */
  record(entry: Omit<RunFailure, "failures" | "failedAt" | "stoppedAt">, limit: number): RunFailure {
    const now = this.#now();
    const [row] = this.#db.exec(
      `INSERT INTO RunFailure (kind, run_id, failures, reason, runner_id, feature_id, person_id, failed_at, stopped_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, CASE WHEN 1 >= ? THEN ? END)
       ON CONFLICT (kind, run_id) DO UPDATE SET failures = failures + 1, reason = excluded.reason, runner_id = excluded.runner_id,
         failed_at = excluded.failed_at, stopped_at = COALESCE(stopped_at, CASE WHEN failures + 1 >= ? THEN ? END)
       RETURNING *`,
      entry.kind,
      entry.runId,
      entry.reason,
      entry.runnerId,
      entry.featureId,
      entry.personId,
      now,
      limit,
      now,
      limit,
      now,
    );
    return failureOf(row as Row);
  }

  /** The feature's stopped runs, oldest first. */
  stopped(featureId: string): RunFailure[] {
    return this.#db.exec(`SELECT * FROM RunFailure WHERE feature_id = ? AND stopped_at IS NOT NULL ORDER BY stopped_at, rowid`, featureId).map(failureOf);
  }
}

/** A store's answer to a release: the run's feature and person, or why it was refused. */
export type ReleaseOutcome =
  | { readonly status: "released"; readonly featureId: string | null; readonly personId: string }
  | { readonly status: "rejected"; readonly reason: "not_found" | "forbidden" | "conflict"; readonly message: string };

/** A store's release of a run that belongs to a feature, whose person the caller looks up. */
export type StoreRelease = { readonly status: "released"; readonly featureId: string } | Extract<ReleaseOutcome, { readonly status: "rejected" }>;

/** The stores that hold each kind of run, each able to release a claim its runner failed. */
export interface RunStores {
  readonly combined: { release(runId: string, runnerId: string): ReleaseOutcome };
  readonly reviews: { release(id: number, runnerId: string): StoreRelease };
  readonly tools: { release(id: number, runnerId: string): StoreRelease };
  readonly planFacts: { release(runId: string): StoreRelease };
  readonly fixGrants: { release(id: number, runnerId: string): StoreRelease };
  readonly trials: { release(id: number, runnerId: string): StoreRelease };
  /** Frees block run `runId` on the FeatureAgent of `featureId`, which keeps the feature's block runs. */
  readonly block: (featureId: string, runId: string, runnerId: string) => StoreRelease | Promise<StoreRelease>;
  /** The person who runs feature `featureId`, or undefined for an unknown feature. */
  readonly personOf: (featureId: string) => string | undefined;
}

/** Releases `runId` of `kind` in the store that holds it, naming the person a stop goes to. */
export async function releaseRun(stores: RunStores, kind: RunKind, runId: string, runnerId: string): Promise<ReleaseOutcome> {
  const number = /^[1-9][0-9]{0,14}$/u.test(runId) ? Number(runId) : 0;
  const withPerson = (released: StoreRelease): ReleaseOutcome => {
    if (released.status === "rejected") return released;
    const personId = stores.personOf(released.featureId);
    if (personId === undefined) return { status: "rejected", reason: "not_found", message: `no feature ${released.featureId}` };
    return { status: "released", featureId: released.featureId, personId };
  };
  switch (kind) {
    case "combined":
      return stores.combined.release(runId, runnerId);
    case "review":
      return withPerson(stores.reviews.release(number, runnerId));
    case "tool":
      return withPerson(stores.tools.release(number, runnerId));
    case "plan-facts":
      return withPerson(stores.planFacts.release(runId));
    case "fix-write":
      return withPerson(stores.fixGrants.release(number, runnerId));
    case "part-trial":
      return withPerson(stores.trials.release(number, runnerId));
    case "block": {
      const featureId = featureOfBlockRun(runId);
      if (featureId === undefined || stores.personOf(featureId) === undefined) return { status: "rejected", reason: "not_found", message: `no block run ${runId}` };
      return withPerson(await stores.block(featureId, runId, runnerId));
    }
  }
}

export interface RunFailureDeps {
  readonly failures: RunFailureStore;
  /** PENGUIN_RUN_FAILURE_LIMIT, parsed; undefined when it is misconfigured. */
  readonly limit: number | undefined;
  /** Releases `runId` of one kind, only when `runnerId` holds its claim. */
  readonly release: (kind: RunKind, runId: string, runnerId: string) => ReleaseOutcome | Promise<ReleaseOutcome>;
  /** Called once when a run reaches the limit, after it is recorded as stopped. */
  readonly stopped: (failure: RunFailure) => void | Promise<void>;
}

/**
 * Handles one failure report: checks it, releases the run for the runner that claimed it, counts the
 * failure and stops the run at the limit. Only a bridge with the runner role may report.
 */
export async function reportRunFailure(deps: RunFailureDeps, caller: BridgeCaller, body: unknown): Promise<RunFailureOutcome> {
  if (caller.role !== "runner") return { status: "rejected", reason: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
  const parsed = parseRunFailure(body);
  if (!parsed.ok) return { status: "rejected", reason: "invalid", message: parsed.problems.join("; ") };
  if (deps.limit === undefined) return { status: "rejected", reason: "conflict", message: "PENGUIN_RUN_FAILURE_LIMIT must be a whole number from 1 to 20" };
  const { kind, runId, reason } = parsed.failure;
  if (deps.failures.get(kind, runId)?.stoppedAt != null) {
    return { status: "rejected", reason: "conflict", message: `${kind} run ${runId} is stopped and waits on its feature's person` };
  }
  const released = await deps.release(kind, runId, caller.bridgeId);
  if (released.status === "rejected") return released;
  const failure = deps.failures.record({ kind, runId, reason, runnerId: caller.bridgeId, featureId: released.featureId, personId: released.personId }, deps.limit);
  const base = { kind, runId, failures: failure.failures, limit: deps.limit };
  if (failure.stoppedAt === null) return { status: "released", ...base };
  await deps.stopped(failure);
  return { status: "stopped", ...base, personId: failure.personId };
}
