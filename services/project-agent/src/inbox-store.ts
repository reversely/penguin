// Each person's inbox (PRD sections 7 and 8): InboxItem(person_id, issue_id, reason, read). Items are
// derived inside the transaction that applies an operation, from the issue's state before and after:
//
// - "assigned": an assignment to the person, or to an identity the person answers for. A personal
//   identity answers to its owner; a team identity to the owner who assigned it, or to every team
//   owner when Penguin assigned it (the same owners session routing asks).
// - "mentioned": a mention of the person, or of an identity the person owns (every owner of a team
//   identity, since a mention has no assigner).
// - "closed": the issue moved to the closed state; every person with an item for the issue gets one.
// - "start_session": the session router (session-store.ts) asks the person to start a session of an
//   identity for the issue. The item goes away once no such request remains.
// - "review_requested": a Huddle's HuddleAgent asks the person to review a fix sub-issue whose
//   combined tests pass (huddle-reviews.ts). A request for a newer fix commit marks it unread again.
// - "thread": a thread on the issue needs the person (PRD section 4, Layer 2: "When a thread needs a
//   person, ... Add the thread to the person's inbox"). Opening a thread raises it for each person
//   the thread needs; a reply raises it again for every person of the thread (thread-rights.ts),
//   which includes the reviewer whose request for changes opened it.
//
// The person who did the thing gets no "assigned", "mentioned" or "closed" item for it. An identity's
// operation counts as its owner half's doing, as in IssueIndex.assigningOwner.
//
// An item is keyed by person, issue and reason. A later event of the same reason marks it unread
// again and moves it to the top. Assigned and mentioned items stay after an unassign or a deleted
// mention: the inbox records what happened.
//
// InboxItem is live state: read flags and session requests have no counterpart in the issues repo, so
// a rebuild never derives items (rebuild.ts lists the table as live-only).

import { authorSegment, PENGUIN_AUTHOR_SEGMENT, type Author } from "@penguin/protocol";
import { threadPeople, type Assignment, type IssueRecord } from "@penguin/issues";

import type { IdentityStore } from "./identity-store.ts";
import type { IssueChange, SqlDatabase } from "./issue-index.ts";
import { responsibleOwners, type StartRequestListener } from "./session-store.ts";

export const INBOX_REASONS = ["assigned", "mentioned", "closed", "start_session", "review_requested", "thread"] as const;
export type InboxReason = (typeof INBOX_REASONS)[number];

export interface InboxItem {
  readonly personId: string;
  readonly issueId: string;
  readonly reason: InboxReason;
  readonly read: boolean;
  /** When the item was created or last marked unread by a new event, as an ISO 8601 time. */
  readonly raisedAt: string;
}

export type InboxOutcome =
  | { readonly status: "ok"; readonly item: InboxItem }
  | { readonly status: "rejected"; readonly reason: "invalid" | "not_found"; readonly message: string };

export interface InboxStoreOptions {
  readonly now?: () => number;
  /** The owner who assigned an identity to an issue (IssueIndex.assigningOwner). */
  readonly assigningOwner?: (issueId: string, handle: string) => string | undefined;
}

/** `raised_at` orders each person's list; `read` is 0 or 1. */
export const INBOX_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS InboxItem (
    person_id TEXT NOT NULL, issue_id TEXT NOT NULL, reason TEXT NOT NULL, read INTEGER NOT NULL,
    raised_at INTEGER NOT NULL, PRIMARY KEY (person_id, issue_id, reason))`,
  `CREATE INDEX IF NOT EXISTS InboxItem_issue ON InboxItem (issue_id)`,
];

const REASONS: ReadonlySet<string> = new Set(INBOX_REASONS);

export class InboxStore implements StartRequestListener {
  readonly #db: SqlDatabase;
  readonly #identities: IdentityStore;
  readonly #now: () => number;
  readonly #assigningOwner: (issueId: string, handle: string) => string | undefined;

  constructor(db: SqlDatabase, identities: IdentityStore, options: InboxStoreOptions = {}) {
    this.#db = db;
    this.#identities = identities;
    this.#now = options.now ?? Date.now;
    this.#assigningOwner = options.assigningOwner ?? (() => undefined);
    for (const statement of INBOX_SCHEMA) db.exec(statement);
  }

  /** The caller's items, newest first. A person reads only their own inbox. */
  items(caller: string): InboxItem[] {
    if (typeof caller !== "string") return [];
    return this.#db
      .exec(`SELECT * FROM InboxItem WHERE person_id = ? ORDER BY raised_at DESC, rowid DESC`, caller)
      .map(inboxItem);
  }

  /**
   * Every person's items that ask them to act (a review request, a thread or a session to start),
   * oldest first, for the dashboard's team map. Read or unread, an item still asks until it goes.
   */
  actionItems(): InboxItem[] {
    return this.#db
      .exec(
        `SELECT * FROM InboxItem WHERE reason IN ('review_requested', 'thread', 'start_session')
         ORDER BY raised_at, rowid`,
      )
      .map(inboxItem);
  }

  /** Marks one of the caller's items read. Another person's item is never found. */
  markRead(caller: string, issueId: string, reason: InboxReason): InboxOutcome {
    if (typeof caller !== "string" || typeof issueId !== "string" || !REASONS.has(reason)) {
      return { status: "rejected", reason: "invalid", message: `reason must be one of ${INBOX_REASONS.join(", ")}` };
    }
    const [row] = this.#db.exec(
      `UPDATE InboxItem SET read = 1 WHERE person_id = ? AND issue_id = ? AND reason = ? RETURNING *`,
      caller,
      issueId,
      reason,
    );
    if (row === undefined) {
      const message = `no ${reason} item for issue ${issueId} in your inbox`;
      return { status: "rejected", reason: "not_found", message };
    }
    return { status: "ok", item: inboxItem(row) };
  }

  /** Derives the items one applied operation creates. Runs inside the operation's transaction. */
  issueChanged({ issueId, previous, next, author }: IssueChange): void {
    const actor = actingPerson(author);
    const raise = (people: Iterable<string>, reason: InboxReason): void => {
      for (const person of people) if (person !== actor) this.#raise(person, issueId, reason);
    };
    if (previous?.assignments !== next.assignments) {
      for (const [key, assignment] of next.assignments) {
        if (!previous?.assignments.has(key)) raise(this.#assignedPeople(issueId, assignment), "assigned");
      }
    }
    if (previous?.mentions !== next.mentions) {
      for (const [key, { mentionedKind, mentionedId }] of next.mentions) {
        if (previous?.mentions.has(key)) continue;
        raise(this.#people({ assigneeKind: mentionedKind, assigneeId: mentionedId }, undefined), "mentioned");
      }
    }
    if (previous?.threads !== next.threads) {
      for (const [id, thread] of next.threads) {
        const before = previous?.threads.get(id);
        if (before === undefined) raise(thread.needsPersonIds, "thread");
        // The reducer rewrites a thread only to reply to it or resolve it.
        else if (before !== thread && thread.status === "open") raise(threadPeople(thread, reviewerOn(next)), "thread");
      }
    }
    if (next.state === "closed" && previous?.state !== "closed") {
      const rows = this.#db.exec(`SELECT DISTINCT person_id FROM InboxItem WHERE issue_id = ?`, issueId);
      raise(rows.map((row) => row["person_id"] as string), "closed");
    }
  }

  startRequested(ownerId: string, issueId: string): void {
    this.#raise(ownerId, issueId, "start_session");
  }

  /** Asks `ownerId` to review the fix sub-issue `issueId`. */
  reviewRequested(ownerId: string, issueId: string): void {
    this.#raise(ownerId, issueId, "review_requested");
  }

  startWithdrawn(ownerId: string, issueId: string): void {
    this.#db.exec(
      `DELETE FROM InboxItem WHERE person_id = ? AND issue_id = ? AND reason = 'start_session'`,
      ownerId,
      issueId,
    );
  }

  #assignedPeople(issueId: string, assignment: Assignment): string[] {
    return this.#people(assignment, () => this.#assigningOwner(issueId, assignment.assigneeId));
  }

  /**
   * The people a party stands for: the person, or the owners an identity answers to. With no
   * `assigner`, a team identity stands for all its owners. An unknown identity stands for no one.
   */
  #people(party: Assignment, assigner: (() => string | undefined) | undefined): string[] {
    if (party.assigneeKind === "person") return [party.assigneeId];
    const identity = this.#identities.byHandle(party.assigneeId);
    if (identity === undefined) return [];
    return responsibleOwners(identity, assigner ?? (() => undefined));
  }

  /** Creates the item, or marks an existing one unread and raises it to now. */
  #raise(personId: string, issueId: string, reason: InboxReason): void {
    this.#db.exec(
      `INSERT INTO InboxItem (person_id, issue_id, reason, read, raised_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (person_id, issue_id, reason) DO UPDATE SET read = 0, raised_at = excluded.raised_at`,
      personId,
      issueId,
      reason,
      this.#now(),
    );
  }
}

/** The reviewer of a review on the issue, by the review's op_id. */
function reviewerOn(issue: IssueRecord): (reviewOpId: string) => string | undefined {
  return (reviewOpId) => issue.reviews.get(reviewOpId)?.reviewerOwnerId;
}

/** The person behind an operation: a person author, or an identity's owner half; none for Penguin. */
function actingPerson(author: Author): string | undefined {
  const segment = authorSegment(author);
  // An author segment is a person id or "<owner>.<name>"; person ids contain no dots.
  return segment === PENGUIN_AUTHOR_SEGMENT ? undefined : segment.split(".")[0];
}

function inboxItem(row: Record<string, unknown>): InboxItem {
  return {
    personId: row["person_id"] as string,
    issueId: row["issue_id"] as string,
    reason: row["reason"] as InboxReason,
    read: Number(row["read"]) === 1,
    raisedAt: new Date(Number(row["raised_at"])).toISOString(),
  };
}
