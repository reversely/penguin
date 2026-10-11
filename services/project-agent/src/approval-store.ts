// Where approval of each Huddle fix sub-issue stands, as its Huddle's HuddleAgent last reported it
// (huddle-reviews.ts), so the issue page can show it beside the fix's reviews. The HuddleAgent
// derives it from the issue index and the scope map; this table keeps the last copy. Beside it, what
// each Huddle issue waits on before it may close, as its HuddleAgent last evaluated it
// (huddle-close.ts). Both are live coordination state with no counterpart in the issues repo.

import type { FixApproval } from "@penguin/issues";

import type { SqlDatabase } from "./issue-index.ts";

export const FIX_APPROVAL_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS FixApproval (issue_id TEXT PRIMARY KEY, approval TEXT NOT NULL)`,
];

export class FixApprovalStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of FIX_APPROVAL_SCHEMA) db.exec(statement);
  }

  get(issueId: string): FixApproval | undefined {
    const [row] = this.#db.exec(`SELECT approval FROM FixApproval WHERE issue_id = ?`, issueId);
    return row === undefined ? undefined : (JSON.parse(row["approval"] as string) as FixApproval);
  }

  /** Records the approval and answers true when it differs from the one recorded before. */
  set(issueId: string, approval: FixApproval): boolean {
    const json = JSON.stringify(approval);
    const [row] = this.#db.exec(`SELECT approval FROM FixApproval WHERE issue_id = ?`, issueId);
    if (row?.["approval"] === json) return false;
    this.#db.exec(`INSERT OR REPLACE INTO FixApproval (issue_id, approval) VALUES (?, ?)`, issueId, json);
    return true;
  }
}

export const CLOSE_OUT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS HuddleCloseOut (issue_id TEXT PRIMARY KEY, waiting_on TEXT NOT NULL)`,
];

/** What each Huddle issue waits on before it may close, one sentence each, by the Huddle issue's number. */
export class CloseOutStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of CLOSE_OUT_SCHEMA) db.exec(statement);
  }

  get(issueId: string): string[] | undefined {
    const [row] = this.#db.exec(`SELECT waiting_on FROM HuddleCloseOut WHERE issue_id = ?`, issueId);
    return row === undefined ? undefined : (JSON.parse(row["waiting_on"] as string) as string[]);
  }

  /** Records what the issue waits on and answers true when it differs from what was recorded before. */
  set(issueId: string, waitingOn: readonly string[]): boolean {
    const json = JSON.stringify(waitingOn);
    const [row] = this.#db.exec(`SELECT waiting_on FROM HuddleCloseOut WHERE issue_id = ?`, issueId);
    if (row?.["waiting_on"] === json) return false;
    this.#db.exec(`INSERT OR REPLACE INTO HuddleCloseOut (issue_id, waiting_on) VALUES (?, ?)`, issueId, json);
    return true;
  }
}
