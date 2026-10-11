// Thread tracking on a Huddle (PRD sections 4, Layer 2, 5 and 6). Every operation comes from a
// template; nothing here calls a model.
//
// A review that requests changes on a fix sub-issue, and counts (review-rights.ts), opens a thread on
// that sub-issue. Penguin opens it with the reviewer's reason as its body and `review:<review op_id>`
// as its anchor, so the thread names the review it answers and a repeated collection never opens a
// second one. The thread needs the owners fixing the sub-issue, the owners of its assignees, other
// than the reviewer. The ProjectAgent routes it from there: the thread lands in each needed person's
// inbox (inbox-store.ts) and reaches that person's running sessions at their next safe checkpoint
// and through get_work (session-store.ts).
//
// The thread itself is an operation in the issues repo. The Huddle's HuddleAgent keeps a copy of
// every thread on the Huddle issue and its fix sub-issues in HuddleThread, refreshed each time it
// collects reviews, so it can answer which threads are still open without reading every issue.
// Opening a thread leaves the Huddle issue's state alone: disagreeing reviews keep it IN_REVIEW until
// the thread's people resolve the thread (PRD sections 12 and 14).

import type { IssueRecord, Thread } from "@penguin/issues";
import { anchoredReview, reviewThreadAnchor } from "@penguin/protocol";

import type { Huddle } from "./huddle-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const HUDDLE_THREAD_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS HuddleThread (
    thread_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, review_op_id TEXT, needs TEXT NOT NULL,
    status TEXT NOT NULL, resolved_by TEXT)`,
];

/** One thread on a Huddle issue or one of its fix sub-issues, as the HuddleAgent keeps it. */
export interface HuddleThread {
  /** The op_id of the open_thread operation. */
  readonly threadId: string;
  readonly issueId: string;
  /** The op_id of the review that requested changes, for a thread opened for one; otherwise null. */
  readonly reviewOpId: string | null;
  /** The people the thread needs. */
  readonly needs: readonly string[];
  readonly status: "open" | "resolved";
  /** The author segment of whoever resolved the thread, or null while it is open. */
  readonly resolvedBy: string | null;
}

export class HuddleThreadStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of HUDDLE_THREAD_SCHEMA) db.exec(statement);
  }

  /** Every thread of the Huddle, by issue and then in the order they were first recorded. */
  all(): HuddleThread[] {
    return this.#db.exec(`SELECT * FROM HuddleThread ORDER BY CAST(issue_id AS INTEGER), rowid`).map(huddleThread);
  }

  /** The Huddle's threads that are still open. The Huddle issue can close only once this is empty. */
  unresolved(): HuddleThread[] {
    return this.all().filter((thread) => thread.status === "open");
  }

  /** Records the threads of one issue as the issue index holds them. */
  record(issueId: string, threads: Iterable<Thread>): void {
    this.#db.transaction(() => {
      for (const thread of threads) {
        this.#db.exec(
          `INSERT INTO HuddleThread (thread_id, issue_id, review_op_id, needs, status, resolved_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET status = excluded.status, resolved_by = excluded.resolved_by`,
          thread.id,
          issueId,
          anchoredReview(thread.anchor),
          JSON.stringify(thread.needsPersonIds),
          thread.status,
          thread.resolvedBy,
        );
      }
    });
  }
}

function huddleThread(row: Row): HuddleThread {
  return {
    threadId: row["thread_id"] as string,
    issueId: row["issue_id"] as string,
    reviewOpId: (row["review_op_id"] as string | null) ?? null,
    needs: JSON.parse(row["needs"] as string) as string[],
    status: row["status"] as "open" | "resolved",
    resolvedBy: (row["resolved_by"] as string | null) ?? null,
  };
}

/**
 * The thread step a HuddleAgent answers over RPC for its one Huddle: every thread on the Huddle issue
 * and its fix sub-issues as of the Huddle's last review collection. Closing the Huddle issue as
 * approved needs every one resolved (PRD section 6).
 */
export interface HuddleThreadKeeper {
  threads(huddle: Huddle): HuddleThread[] | Promise<HuddleThread[]>;
}

/** The owner an assignee stands for: a person, or an identity handle's owner half (`@<owner>/<name>`). */
export function assigneeOwner(assignment: { readonly assigneeKind: string; readonly assigneeId: string }): string {
  const { assigneeKind, assigneeId } = assignment;
  return assigneeKind === "person" ? assigneeId : assigneeId.slice(1, assigneeId.indexOf("/"));
}

/** The open_thread operation Penguin writes for a review that requests changes. */
export interface ReviewThreadDraft {
  readonly type: "open_thread";
  readonly payload: { readonly body: string; readonly anchor: string; readonly needs: readonly string[] };
}

/** An open_thread operation for each counting request for changes on the fix that has no thread yet. */
export function reviewThreadsDue(sub: IssueRecord): { readonly reviewOpId: string; readonly operation: ReviewThreadDraft }[] {
  const anchors = new Set([...sub.threads.values()].map((thread) => thread.anchor));
  const fixers = [...new Set([...sub.assignments.values()].map(assigneeOwner))];
  const due: { reviewOpId: string; operation: ReviewThreadDraft }[] = [];
  for (const review of sub.reviews.values()) {
    if (!review.counts || review.verdict !== "request_changes") continue;
    const anchor = reviewThreadAnchor(review.opId);
    if (anchors.has(anchor)) continue;
    const reviewer = review.reviewerOwnerId;
    const body = review.reason ?? `${reviewer} requested changes on ${review.repo}@${review.sha}`;
    const needs = fixers.filter((owner) => owner !== reviewer);
    due.push({ reviewOpId: review.opId, operation: { type: "open_thread", payload: { body, anchor, needs } } });
  }
  return due;
}
