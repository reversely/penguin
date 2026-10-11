// The Huddle issues the ProjectAgent opened, one per trigger (PRD sections 6 and 7, `Huddle`). The
// row is written before the first operation, keyed by the trigger commit, and holds the combined-run
// event that opened it. The trigger commit, its baseline and the event never change after the
// insert: they are the Huddle's immutable initiating revision. A second combined run on the same
// trigger finds the row and opens nothing.
//
// HuddleFix maps each failing test to the fix sub-issue opened for it, so an opening interrupted
// part way resumes without opening a sub-issue twice.
//
// Both tables are live coordination state with no counterpart in the issues repo.

import type { CombinedRunEvent } from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const HUDDLE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS Huddle (
    trigger_commit TEXT PRIMARY KEY, trigger_owner TEXT NOT NULL, trigger_sha TEXT NOT NULL,
    baseline_sha TEXT NOT NULL, trigger_scopes TEXT NOT NULL, event TEXT NOT NULL, issue_id TEXT,
    status TEXT NOT NULL, huddle_repo TEXT, opened_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS Huddle_issue ON Huddle (issue_id)`,
  `CREATE TABLE IF NOT EXISTS HuddleFix (
    trigger_commit TEXT NOT NULL, fix_key TEXT NOT NULL, issue_id TEXT NOT NULL,
    PRIMARY KEY (trigger_commit, fix_key))`,
  `CREATE INDEX IF NOT EXISTS HuddleFix_issue ON HuddleFix (issue_id)`,
];

/** `opening` until every operation of the opening is applied, then `open`. */
export type HuddleStatus = "opening" | "open";

export interface Huddle {
  /** The trigger as a commit reference, `owner-<owner id>@<sha>`: the Huddle's key. */
  readonly triggerCommit: string;
  readonly triggerOwner: string;
  readonly triggerSha: string;
  readonly baselineSha: string;
  /** The scopes the trigger changes. */
  readonly triggerScopes: readonly string[];
  /** The combined-run event that opened the Huddle. */
  readonly event: CombinedRunEvent;
  /** The Huddle issue's number, or null before its create is applied. */
  readonly issueId: string | null;
  readonly status: HuddleStatus;
  /** The Huddle repo's Artifacts name, or null until the Worker forks it. */
  readonly huddleRepo: string | null;
  /** When the Huddle was first recorded, as an ISO 8601 time. */
  readonly openedAt: string;
}

/** The commit reference of a checkpoint in an owner's fork, as issue operations write it. */
export function ownerCommit(ownerId: string, sha: string): string {
  return `owner-${ownerId}@${sha}`;
}

export class HuddleStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of HUDDLE_SCHEMA) db.exec(statement);
  }

  get(triggerCommit: string): Huddle | undefined {
    const [row] = this.#db.exec(`SELECT * FROM Huddle WHERE trigger_commit = ?`, triggerCommit);
    return row === undefined ? undefined : huddle(row);
  }

  /** Every Huddle whose opening finished, oldest first. */
  open(): Huddle[] {
    return this.#db.exec(`SELECT * FROM Huddle WHERE status = 'open' ORDER BY opened_at, trigger_commit`).map(huddle);
  }

  /** The Huddle whose issue has this number, or undefined. */
  byIssue(issueId: string): Huddle | undefined {
    const [row] = this.#db.exec(`SELECT * FROM Huddle WHERE issue_id = ?`, issueId);
    return row === undefined ? undefined : huddle(row);
  }

  /** Records a new Huddle in the `opening` state. The caller has checked that none exists for the trigger. */
  begin(event: CombinedRunEvent): Huddle {
    const { ownerId, sha, baselineSha } = event.trigger;
    const triggerCommit = ownerCommit(ownerId, sha);
    this.#db.exec(
      `INSERT INTO Huddle (trigger_commit, trigger_owner, trigger_sha, baseline_sha, trigger_scopes, event, issue_id,
         status, huddle_repo, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'opening', NULL, ?)`,
      triggerCommit,
      ownerId,
      sha,
      baselineSha,
      JSON.stringify(event.changedScopes),
      JSON.stringify(event),
      this.#now(),
    );
    return this.get(triggerCommit) as Huddle;
  }

  setIssue(triggerCommit: string, issueId: string): void {
    this.#db.exec(`UPDATE Huddle SET issue_id = ? WHERE trigger_commit = ?`, issueId, triggerCommit);
  }

  markOpen(triggerCommit: string): void {
    this.#db.exec(`UPDATE Huddle SET status = 'open' WHERE trigger_commit = ?`, triggerCommit);
  }

  /** Records the Huddle repo the Worker forked for the Huddle. */
  setRepo(triggerCommit: string, huddleRepo: string): Huddle | undefined {
    this.#db.exec(`UPDATE Huddle SET huddle_repo = ? WHERE trigger_commit = ?`, huddleRepo, triggerCommit);
    return this.get(triggerCommit);
  }

  /** The fix sub-issue opened for `fixKey`, or undefined. */
  fix(triggerCommit: string, fixKey: string): string | undefined {
    const [row] = this.#db.exec(
      `SELECT issue_id FROM HuddleFix WHERE trigger_commit = ? AND fix_key = ?`,
      triggerCommit,
      fixKey,
    );
    return (row?.["issue_id"] as string | undefined) ?? undefined;
  }

  /** The Huddle and fix key a fix sub-issue was opened for, or undefined for any other issue. */
  fixOf(issueId: string): { readonly huddle: Huddle; readonly fixKey: string } | undefined {
    const [row] = this.#db.exec(
      `SELECT h.*, f.fix_key FROM HuddleFix f JOIN Huddle h ON h.trigger_commit = f.trigger_commit
       WHERE f.issue_id = ? LIMIT 1`,
      issueId,
    );
    return row === undefined ? undefined : { huddle: huddle(row), fixKey: row["fix_key"] as string };
  }

  /** True when the issue is a fix sub-issue of a Huddle. */
  isFix(issueId: string): boolean {
    return this.#db.exec(`SELECT 1 FROM HuddleFix WHERE issue_id = ? LIMIT 1`, issueId).length > 0;
  }

  setFix(triggerCommit: string, fixKey: string, issueId: string): void {
    this.#db.exec(
      `INSERT INTO HuddleFix (trigger_commit, fix_key, issue_id) VALUES (?, ?, ?)`,
      triggerCommit,
      fixKey,
      issueId,
    );
  }
}

function huddle(row: Row): Huddle {
  return {
    triggerCommit: row["trigger_commit"] as string,
    triggerOwner: row["trigger_owner"] as string,
    triggerSha: row["trigger_sha"] as string,
    baselineSha: row["baseline_sha"] as string,
    triggerScopes: JSON.parse(row["trigger_scopes"] as string) as string[],
    event: JSON.parse(row["event"] as string) as CombinedRunEvent,
    issueId: (row["issue_id"] as string | null) ?? null,
    status: row["status"] as HuddleStatus,
    huddleRepo: (row["huddle_repo"] as string | null) ?? null,
    openedAt: new Date(Number(row["opened_at"])).toISOString(),
  };
}
