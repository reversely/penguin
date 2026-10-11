// Where approval of each Huddle fix sub-issue stands, as its Huddle's HuddleAgent last reported it
// (huddle-reviews.ts), so the issue page can show it beside the fix's reviews. The HuddleAgent
// derives it from the issue index and the scope map; this table keeps the last copy. It is live
// coordination state with no counterpart in the issues repo.

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
