// Where a feature's block runs and its promotion are kept (PRD 0.4 section 9, FeatureAgent storage):
// `BlockCheck(plan_id, target, check, result, fingerprint, log_ref)` and `Promotion(plan_id,
// main_before, main_after)`, beside the runs that produced them.
//
// A run is one check of the feature's block: its checkpoint merged onto main and onto every other
// running feature's fork head (block-land.ts). A run moves through these states:
//
//   pending -> claimed -> passed | failed          a plan check stops here
//   passed  -> promoting -> promoted | raced | refused   a land or expand run
//   pending | claimed -> superseded                 a newer run of the feature took its place
//
// `raced`: main moved before the push, so Penguin checks the block again on the new main.
// `refused`: the push failed for another reason, or a promotion was left unfinished.
//
// Like plan-store.ts, the store runs on one SQL database: the FeatureAgent owns one instance per
// feature. Every transition is one statement that names the state it leaves, so two reports or two
// promotions of one run never both land. Nothing here signs: the ProjectAgent signs each record.

import type { BlockCheck, BlockRunPurpose, BlockRunReport, BlockRunRequest, LadderDecision, Promotion } from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const BLOCK_STORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS BlockRun (
    run_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, seq INTEGER NOT NULL, plan_id TEXT, purpose TEXT NOT NULL,
    checkpoint TEXT NOT NULL, main_before TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL,
    requested_by TEXT NOT NULL, claimed_by TEXT, lease_until INTEGER, requested_at INTEGER NOT NULL,
    reported_at INTEGER, runner_ms INTEGER, summary TEXT, decisions TEXT, record_id TEXT, outcome TEXT,
    promoting_since INTEGER, UNIQUE (feature_id, seq))`,
  `CREATE INDEX IF NOT EXISTS BlockRun_state ON BlockRun (feature_id, state)`,
  `CREATE TABLE IF NOT EXISTS BlockCheck (
    run_id TEXT NOT NULL, idx INTEGER NOT NULL, plan_id TEXT, target TEXT NOT NULL, check_name TEXT NOT NULL,
    result TEXT NOT NULL, fingerprint TEXT, log_ref TEXT, detail TEXT NOT NULL, PRIMARY KEY (run_id, idx))`,
  `CREATE TABLE IF NOT EXISTS Promotion (
    run_id TEXT PRIMARY KEY, plan_id TEXT, feature_id TEXT NOT NULL, main_before TEXT NOT NULL,
    main_after TEXT NOT NULL, record_id TEXT NOT NULL, promoted_at INTEGER NOT NULL, promotion TEXT NOT NULL)`,
];

export type BlockRunState = "pending" | "claimed" | "passed" | "failed" | "superseded" | "promoting" | "promoted" | "raced" | "refused";

/** States in which a run still waits on the runner. */
const WAITING: readonly BlockRunState[] = ["pending", "claimed"];
/** States in which a land or expand run still holds the feature: checking, or passed and about to move main. */
const LANDING: readonly BlockRunState[] = ["pending", "claimed", "passed", "promoting"];

/** A promotion still `promoting` after this long was cut off mid-way; the next land request ends it as refused. */
export const PROMOTION_STALE_MS = 15 * 60_000;
/** How long a runner's claim of a run holds before another claim may take it. */
export const BLOCK_RUN_LEASE_MS = 30 * 60_000;

/** One failing check as a run keeps it for the agent: where, which check and what it found. */
export interface FailingCheck {
  readonly target: string;
  readonly check: string;
  readonly result: string;
  readonly summary: string;
}

export interface BlockRun {
  readonly runId: string;
  readonly featureId: string;
  readonly seq: number;
  readonly planId: string | null;
  readonly purpose: BlockRunPurpose;
  readonly checkpoint: string;
  readonly mainBefore: string;
  readonly state: BlockRunState;
  readonly request: BlockRunRequest;
  /** The identity handle that asked to land, or `penguin` for a plan check or a retry. */
  readonly requestedBy: string;
  readonly claimedBy: string | null;
  readonly requestedAt: string;
  readonly reportedAt: string | null;
  /** The runner's own wall time for the run, as it reported it. */
  readonly runnerMs: number | null;
  readonly summary: string | null;
  readonly failing: readonly FailingCheck[];
  readonly decisions: readonly LadderDecision[];
  /** The signed `block_checked` record, once the report is signed. */
  readonly recordId: string | null;
  /** Why a promotion was raced or refused, or null. */
  readonly outcome: string | null;
}

export interface BlockRunInput {
  readonly featureId: string;
  readonly planId: string | null;
  readonly purpose: BlockRunPurpose;
  readonly fork: string;
  readonly checkpoint: string;
  readonly mainBefore: string;
  readonly branch: string;
  readonly targets: BlockRunRequest["targets"];
  readonly charter: BlockRunRequest["charter"];
  readonly requestedBy: string;
}

export type BlockOpenOutcome =
  | { readonly status: "opened"; readonly run: BlockRun; readonly superseded: readonly string[] }
  /** A land run already holds the feature: a second land, or a plan check, waits for it. */
  | { readonly status: "busy"; readonly run: BlockRun };

export type BlockReportOutcome =
  | { readonly status: "recorded"; readonly run: BlockRun }
  | { readonly status: "rejected"; readonly reason: "not_found" | "forbidden" | "superseded" | "conflict"; readonly message: string };

function runOf(row: Row): BlockRun {
  const text = (key: string) => (row[key] === null ? null : (row[key] as string));
  const decisions = text("decisions");
  const outcome = text("outcome");
  const failing = JSON.parse(text("failing_json") ?? "[]") as FailingCheck[];
  return {
    runId: row["run_id"] as string,
    featureId: row["feature_id"] as string,
    seq: Number(row["seq"]),
    planId: text("plan_id"),
    purpose: row["purpose"] as BlockRunPurpose,
    checkpoint: row["checkpoint"] as string,
    mainBefore: row["main_before"] as string,
    state: row["state"] as BlockRunState,
    request: JSON.parse(row["request"] as string) as BlockRunRequest,
    requestedBy: row["requested_by"] as string,
    claimedBy: text("claimed_by"),
    requestedAt: new Date(Number(row["requested_at"])).toISOString(),
    reportedAt: row["reported_at"] === null ? null : new Date(Number(row["reported_at"])).toISOString(),
    runnerMs: row["runner_ms"] === null ? null : Number(row["runner_ms"]),
    summary: text("summary"),
    failing,
    decisions: decisions === null ? [] : (JSON.parse(decisions) as LadderDecision[]),
    recordId: text("record_id"),
    outcome,
  };
}

// A run's failing checks are read from its BlockCheck rows with it.
const RUN_COLUMNS = `run_id, feature_id, seq, plan_id, purpose, checkpoint, main_before, state, request, requested_by,
  claimed_by, requested_at, reported_at, runner_ms, summary, decisions, record_id, outcome,
  (SELECT json_group_array(json_object('target', target, 'check', check_name, 'result', result,
     'summary', json_extract(detail, '$.summary')))
   FROM BlockCheck WHERE BlockCheck.run_id = BlockRun.run_id AND result IN ('failed', 'error')) AS failing_json`;

export class BlockStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of BLOCK_STORE_SCHEMA) db.exec(statement);
  }

  get(runId: string): BlockRun | undefined {
    const [row] = this.#db.exec(`SELECT ${RUN_COLUMNS} FROM BlockRun WHERE run_id = ?`, runId);
    return row === undefined ? undefined : runOf(row);
  }

  /** The feature's newest run, of `purpose` when given. */
  latest(featureId: string, purpose?: BlockRunPurpose): BlockRun | undefined {
    const [row] =
      purpose === undefined
        ? this.#db.exec(`SELECT ${RUN_COLUMNS} FROM BlockRun WHERE feature_id = ? ORDER BY seq DESC LIMIT 1`, featureId)
        : this.#db.exec(`SELECT ${RUN_COLUMNS} FROM BlockRun WHERE feature_id = ? AND purpose = ? ORDER BY seq DESC LIMIT 1`, featureId, purpose);
    return row === undefined ? undefined : runOf(row);
  }

  /** The feature's runs, newest first, at most `limit`. */
  runs(featureId: string, limit = 20): BlockRun[] {
    return this.#db.exec(`SELECT ${RUN_COLUMNS} FROM BlockRun WHERE feature_id = ? ORDER BY seq DESC LIMIT ?`, featureId, limit).map(runOf);
  }

  /** The checks a run's report holds, in the runner's order. */
  checks(runId: string): BlockCheck[] {
    return this.#db.exec(`SELECT detail FROM BlockCheck WHERE run_id = ? ORDER BY idx`, runId).map((row) => JSON.parse(row["detail"] as string) as BlockCheck);
  }

  /**
   * Opens the feature's next run. A run still waiting on the runner is superseded by it, except that a
   * land or expand run in progress is never displaced: a second land or expand answers `busy`, and so
   * does a plan check.
   * A promotion cut off for longer than PROMOTION_STALE_MS is ended as refused first.
   */
  open(input: BlockRunInput): BlockOpenOutcome {
    return this.#db.transaction(() => {
      const now = this.#now();
      this.#db.exec(
        `UPDATE BlockRun SET state = 'refused', outcome = 'the promotion did not finish' WHERE feature_id = ? AND state = 'promoting' AND promoting_since < ?`,
        input.featureId,
        now - PROMOTION_STALE_MS,
      );
      const [active] = this.#db.exec(
        `SELECT ${RUN_COLUMNS} FROM BlockRun WHERE feature_id = ? AND purpose IN ('land', 'expand') AND state IN (${LANDING.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT 1`,
        input.featureId,
        ...LANDING,
      );
      if (active !== undefined) return { status: "busy", run: runOf(active) };
      const superseded = this.#db
        .exec(
          `UPDATE BlockRun SET state = 'superseded' WHERE feature_id = ? AND state IN (${WAITING.map(() => "?").join(", ")}) RETURNING run_id`,
          input.featureId,
          ...WAITING,
        )
        .map((row) => row["run_id"] as string);
      const [last] = this.#db.exec(`SELECT COALESCE(MAX(seq), 0) AS seq FROM BlockRun WHERE feature_id = ?`, input.featureId);
      const seq = Number(last?.["seq"] ?? 0) + 1;
      const runId = `${input.featureId}/${seq}`;
      const request: BlockRunRequest = {
        runId,
        feature: input.featureId,
        planId: input.planId,
        purpose: input.purpose,
        fork: input.fork,
        checkpoint: input.checkpoint,
        main: input.mainBefore,
        branch: input.branch,
        targets: input.targets,
        charter: input.charter,
      };
      this.#db.exec(
        `INSERT INTO BlockRun (run_id, feature_id, seq, plan_id, purpose, checkpoint, main_before, state, request, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        runId,
        input.featureId,
        seq,
        input.planId,
        input.purpose,
        input.checkpoint,
        input.mainBefore,
        JSON.stringify(request),
        input.requestedBy,
        now,
      );
      return { status: "opened", run: this.get(runId) as BlockRun, superseded };
    });
  }

  /** True while a run waits on the runner, pending or claimed. */
  hasWaiting(): boolean {
    return this.#db.exec(`SELECT 1 FROM BlockRun WHERE state IN (${WAITING.map(() => "?").join(", ")}) LIMIT 1`, ...WAITING).length > 0;
  }

  /** Hands `runnerId` the pending runs and the claimed runs whose lease ran out, each held for `leaseMs`. */
  claim(runnerId: string, leaseMs = BLOCK_RUN_LEASE_MS): BlockRunRequest[] {
    const now = this.#now();
    return this.#db
      .exec(
        `UPDATE BlockRun SET state = 'claimed', claimed_by = ?, lease_until = ?
         WHERE state = 'pending' OR (state = 'claimed' AND lease_until < ?) RETURNING request`,
        runnerId,
        now + leaseMs,
        now,
      )
      .map((row) => JSON.parse(row["request"] as string) as BlockRunRequest);
  }

  /**
   * Keeps the report of a run `runnerId` claimed, with each check, and moves it to `passed` or
   * `failed`. A run claimed by another runner, superseded, or already reported is refused.
   */
  report(runId: string, runnerId: string, report: BlockRunReport, passed: boolean): BlockReportOutcome {
    return this.#db.transaction(() => {
      const run = this.get(runId);
      if (run === undefined) return { status: "rejected", reason: "not_found", message: `no block run ${runId}` };
      if (run.state === "superseded") return { status: "rejected", reason: "superseded", message: `run ${runId} was superseded by a newer run` };
      if (run.state !== "claimed") return { status: "rejected", reason: "conflict", message: `run ${runId} is already ${run.state}` };
      if (run.claimedBy !== runnerId) return { status: "rejected", reason: "forbidden", message: `run ${runId} is claimed by another runner` };
      for (const [index, check] of report.checks.entries()) {
        this.#db.exec(
          `INSERT INTO BlockCheck (run_id, idx, plan_id, target, check_name, result, fingerprint, log_ref, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          runId,
          index,
          check.planId,
          check.target,
          check.check,
          check.result,
          check.fingerprint?.id ?? null,
          check.logRef,
          JSON.stringify(check),
        );
      }
      this.#db.exec(
        `UPDATE BlockRun SET state = ?, reported_at = ?, runner_ms = ?, summary = ?, decisions = ? WHERE run_id = ?`,
        passed ? "passed" : "failed",
        this.#now(),
        report.durationMs,
        report.summary,
        JSON.stringify(report.decisions),
        runId,
      );
      return { status: "recorded", run: this.get(runId) as BlockRun };
    });
  }

  setRecord(runId: string, recordId: string): void {
    this.#db.exec(`UPDATE BlockRun SET record_id = ? WHERE run_id = ?`, recordId, runId);
  }

  /** Moves a run from one of `from` to `to`, noting why; false when it stood elsewhere. */
  transition(runId: string, from: readonly BlockRunState[], to: BlockRunState, outcome: string | null = null): boolean {
    const changed = this.#db.exec(
      `UPDATE BlockRun SET state = ?, outcome = COALESCE(?, outcome), promoting_since = CASE WHEN ? = 'promoting' THEN ? ELSE promoting_since END
       WHERE run_id = ? AND state IN (${from.map(() => "?").join(", ")}) RETURNING run_id`,
      to,
      outcome,
      to,
      this.#now(),
      runId,
      ...from,
    );
    return changed.length > 0;
  }

  /** Keeps the promotion of a run and marks the run promoted, in one transaction. */
  keepPromotion(promotion: Promotion): boolean {
    return this.#db.transaction(() => {
      if (!this.transition(promotion.runId, ["promoting"], "promoted")) return false;
      this.#db.exec(
        `INSERT INTO Promotion (run_id, plan_id, feature_id, main_before, main_after, record_id, promoted_at, promotion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        promotion.runId,
        promotion.planId,
        promotion.featureId,
        promotion.mainBefore,
        promotion.mainAfter,
        promotion.recordId,
        Date.parse(promotion.promotedAt),
        JSON.stringify(promotion),
      );
      return true;
    });
  }

  /** The feature's promotion, or undefined before it landed. An expand promotion is not the feature's. */
  promotion(featureId: string): Promotion | undefined {
    const [row] = this.#db.exec(
      `SELECT promotion FROM Promotion WHERE feature_id = ? AND json_extract(promotion, '$.purpose') IS NULL ORDER BY promoted_at DESC LIMIT 1`,
      featureId,
    );
    return row === undefined ? undefined : (JSON.parse(row["promotion"] as string) as Promotion);
  }

  /** The feature's expand checkpoints promoted alone, oldest first. */
  expansions(featureId: string): Promotion[] {
    return this.#db
      .exec(`SELECT promotion FROM Promotion WHERE feature_id = ? AND json_extract(promotion, '$.purpose') = 'expand' ORDER BY promoted_at, run_id`, featureId)
      .map((row) => JSON.parse(row["promotion"] as string) as Promotion);
  }
}
