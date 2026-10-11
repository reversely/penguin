// The verification runs of each Huddle (PRD section 7, HuddleAgent storage: `Candidate` and `Check`),
// kept beside the Huddle record in the ProjectAgent, which holds the issue index and the owner forks
// a run is planned from. A run is one set of owners' checkpoints to merge onto the Huddle repo's
// `integration` branch and the commands to run there.
//
// A run is `pending` until the runner reports it, then `done`. A newer checkpoint schedules a new run
// and marks every earlier unfinished run `superseded`; a report for a superseded run never counts.
// The table is live coordination state with no counterpart in the issues repo.

import type { VerificationCheckpoint, VerificationCommand, VerificationReport } from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const VERIFICATION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS VerificationRun (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_commit TEXT NOT NULL, checkpoints TEXT NOT NULL,
    commands TEXT NOT NULL, status TEXT NOT NULL, runner_id TEXT, report TEXT, created_at INTEGER NOT NULL,
    finished_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS VerificationRun_trigger ON VerificationRun (trigger_commit, run_id)`,
  `CREATE INDEX IF NOT EXISTS VerificationRun_status ON VerificationRun (status, run_id)`,
];

export type VerificationStatus = "pending" | "done" | "superseded";

export interface VerificationRun {
  readonly runId: string;
  /** The Huddle's key, its trigger commit. */
  readonly triggerCommit: string;
  /** The owners' checkpoints to merge, in merge order. */
  readonly checkpoints: readonly VerificationCheckpoint[];
  readonly commands: readonly VerificationCommand[];
  readonly status: VerificationStatus;
  /** The runner bridge that reported the run, or null before the report. */
  readonly runnerId: string | null;
  /** The runner's report, kept with each result's lockfile hash, or null before it. */
  readonly report: VerificationReport | null;
  readonly createdAt: string;
}

export class VerificationStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of VERIFICATION_SCHEMA) db.exec(statement);
  }

  get(runId: string): VerificationRun | undefined {
    const [row] = this.#db.exec(`SELECT * FROM VerificationRun WHERE run_id = ?`, Number(runId));
    return row === undefined ? undefined : run(row);
  }

  /** The Huddle's newest run that was not superseded, or undefined. */
  latest(triggerCommit: string): VerificationRun | undefined {
    const [row] = this.#db.exec(
      `SELECT * FROM VerificationRun WHERE trigger_commit = ? AND status != 'superseded'
       ORDER BY run_id DESC LIMIT 1`,
      triggerCommit,
    );
    return row === undefined ? undefined : run(row);
  }

  /** Every pending run, oldest first. */
  pending(): VerificationRun[] {
    return this.#db.exec(`SELECT * FROM VerificationRun WHERE status = 'pending' ORDER BY run_id`).map(run);
  }

  /**
   * Schedules a run for the Huddle and supersedes the Huddle's earlier pending runs, in one
   * transaction, so the Huddle never has two pending runs.
   */
  schedule(
    triggerCommit: string,
    checkpoints: readonly VerificationCheckpoint[],
    commands: readonly VerificationCommand[],
  ): VerificationRun {
    return this.#db.transaction(() => {
      this.#db.exec(
        `UPDATE VerificationRun SET status = 'superseded', finished_at = ?
         WHERE trigger_commit = ? AND status = 'pending'`,
        this.#now(),
        triggerCommit,
      );
      const [row] = this.#db.exec(
        `INSERT INTO VerificationRun (trigger_commit, checkpoints, commands, status, created_at)
         VALUES (?, ?, ?, 'pending', ?) RETURNING *`,
        triggerCommit,
        JSON.stringify(checkpoints),
        JSON.stringify(commands),
        this.#now(),
      );
      return run(row as Row);
    });
  }

  /** Records the runner's report and marks the run done. */
  finish(runId: string, runnerId: string, report: VerificationReport): void {
    this.#db.exec(
      `UPDATE VerificationRun SET status = 'done', runner_id = ?, report = ?, finished_at = ? WHERE run_id = ?`,
      runnerId,
      JSON.stringify(report),
      this.#now(),
      Number(runId),
    );
  }
}

/** True when two runs merge the same checkpoints in the same order. */
export function sameCheckpoints(
  left: readonly VerificationCheckpoint[],
  right: readonly VerificationCheckpoint[],
): boolean {
  return left.length === right.length && left.every((checkpoint, i) => {
    const other = right[i];
    return other !== undefined && checkpoint.ownerId === other.ownerId && checkpoint.sha === other.sha;
  });
}

function run(row: Row): VerificationRun {
  const report = row["report"] as string | null;
  return {
    runId: String(row["run_id"]),
    triggerCommit: row["trigger_commit"] as string,
    checkpoints: JSON.parse(row["checkpoints"] as string) as VerificationCheckpoint[],
    commands: JSON.parse(row["commands"] as string) as VerificationCommand[],
    status: row["status"] as VerificationStatus,
    runnerId: (row["runner_id"] as string | null) ?? null,
    report: report === null ? null : (JSON.parse(report) as VerificationReport),
    createdAt: new Date(Number(row["created_at"])).toISOString(),
  };
}
