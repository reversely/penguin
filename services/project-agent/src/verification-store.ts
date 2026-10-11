// The verification runs of one Huddle (PRD section 7, HuddleAgent storage: `Candidate` and `Check`),
// kept in the SQLite of that Huddle's HuddleAgent (PRD section 5). A run is one set of owners'
// checkpoints to merge onto the Huddle repo's `integration` branch and the commands to run there.
//
// A run is `pending` until the runner reports it, then `done`. A newer checkpoint schedules a new run
// and marks every earlier unfinished run `superseded`; a report for a superseded run never counts.
// The table is live coordination state with no counterpart in the issues repo.
//
// The runner names a run by its ID alone (`POST /verifications/<run id>`), so run IDs are unique
// across the project: the HuddleAgent of Huddle issue N numbers its runs from N * RUNS_PER_HUDDLE + 1,
// and the ProjectAgent finds a run's Huddle from its ID (`huddleIssueOfRun`).

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

/** How many run IDs each Huddle's range holds. */
export const RUNS_PER_HUDDLE = 1_000_000;

/** The first run ID before the range of the Huddle whose issue has this number. */
export function runIdBaseOf(issueId: string): number {
  if (!/^[1-9][0-9]{0,8}$/u.test(issueId)) throw new Error(`no run ID range for issue ${issueId}`);
  return Number(issueId) * RUNS_PER_HUDDLE;
}

/** The Huddle issue whose HuddleAgent numbered run `runId`, or undefined for an ID in no Huddle's range. */
export function huddleIssueOfRun(runId: string): string | undefined {
  if (!/^[0-9]{1,15}$/u.test(runId)) return undefined;
  const issue = Math.floor(Number(runId) / RUNS_PER_HUDDLE);
  return issue === 0 ? undefined : String(issue);
}

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

export interface VerificationStoreOptions {
  readonly now?: () => number;
  /** Run IDs start after this number and stay below it plus RUNS_PER_HUDDLE; see `runIdBaseOf`. */
  readonly runIdBase?: number;
}

export class VerificationStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #runIdBase: number;

  constructor(db: SqlDatabase, options: VerificationStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#runIdBase = options.runIdBase ?? 0;
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
      // Rows are never deleted, so one past the highest ID never reuses one.
      const [last] = this.#db.exec(`SELECT MAX(run_id) AS run_id FROM VerificationRun`);
      const runId = Math.max(Number(last?.["run_id"] ?? 0), this.#runIdBase) + 1;
      if (runId > this.#runIdBase + RUNS_PER_HUDDLE - 1) throw new Error(`the Huddle used every run ID in its range`);
      const [row] = this.#db.exec(
        `INSERT INTO VerificationRun (run_id, trigger_commit, checkpoints, commands, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?) RETURNING *`,
        runId,
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

/**
 * Drops the VerificationRun table a ProjectAgent kept before the runs moved to the HuddleAgents, when
 * it holds no run. A table that still holds runs is kept, so no run is lost, and reported as `kept`.
 */
export function dropProjectVerificationTable(db: SqlDatabase): "dropped" | "absent" | "kept" {
  let rows: number;
  try {
    rows = Number(db.exec(`SELECT COUNT(*) AS n FROM VerificationRun`)[0]?.["n"]);
  } catch {
    return "absent";
  }
  if (rows > 0) return "kept";
  db.exec(`DROP TABLE VerificationRun`);
  return "dropped";
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
