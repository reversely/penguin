// Review collection on a Huddle's fix sub-issues (PRD sections 5, 6 and 11 Phase 4). Every operation
// comes from a template; nothing here calls a model.
//
// Review requests start when the combined tests pass and the Huddle issue moves to IN_REVIEW
// (huddle-verify.ts). Penguin then links, on each fix sub-issue, the checkpoint of the fixing owner
// that the passing run merged, as a `fix` commit: that commit is the fix's head, the revision the
// reviewers approve. It asks each owner whose review counts on the fix (the owner of each labelled
// scope: the fix's scope and the failing test's) to review that head, through a `review_requested`
// inbox item. A newer head asks again, because a review of an older commit no longer counts.
//
// Whose review counts, and how a delegate's counts, is decided when the review is applied
// (packages/policies/src/review-rights.ts); where each owner stands on the head is derived from the
// fix's reviews (packages/policies/src/fix-approval.ts). Each Huddle's HuddleAgent keeps that standing
// per fix and owner in its own SQLite (FixReview), and hands each fix's approval to the ProjectAgent,
// whose issue page shows it (approval-store.ts).

import { fixApproval, fixHead, type FixApproval, type IssueRecord, type OwnerApprovalState } from "@penguin/issues";
import type { ScopeMap } from "@penguin/scope-map";

import type { Huddle } from "./huddle-store.ts";
import { ownerCommit } from "./huddle-store.ts";
import type { HuddleProjectPort } from "./huddle-verify.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { VerificationStore } from "./verification-store.ts";

type Row = Record<string, SqlValue>;

/** What a HuddleAgent's review steps read and write through the ProjectAgent, beyond verification's port. */
export interface HuddleReviewPort extends HuddleProjectPort {
  /** The scope map review rights are judged by. */
  scopeMap(): ScopeMap | Promise<ScopeMap>;
  /** Asks `ownerId` to review the fix sub-issue `issueId`, in the owner's inbox. */
  requestReview(ownerId: string, issueId: string): void | Promise<void>;
  /** Hands the ProjectAgent where approval of the fix sub-issue `issueId` stands. */
  recordApproval(issueId: string, approval: FixApproval): void | Promise<void>;
}

/** One Huddle's review state and runs, kept by its HuddleAgent, and the ProjectAgent's side. */
export interface HuddleReviewDeps extends HuddleReviewPort {
  readonly reviews: FixReviewStore;
  readonly runs: Pick<VerificationStore, "latest">;
}

/** The review step a HuddleAgent answers over RPC for its one Huddle. */
export interface HuddleReviewer {
  collectReviews(huddle: Huddle, project: HuddleReviewPort): Promise<ReviewCollection | undefined>;
}

export interface ReviewCollection {
  readonly issueId: string;
  /** Each fix sub-issue and where its approval stands, in sub-issue order. */
  readonly fixes: readonly { readonly issueId: string; readonly approval: FixApproval }[];
  /** The review requests this step sent, as `<owner> #<sub-issue>`. */
  readonly requested: readonly string[];
}

export const FIX_REVIEW_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS FixReview (
    issue_id TEXT NOT NULL, owner_id TEXT NOT NULL, head TEXT, state TEXT NOT NULL, reviewer TEXT,
    review_op_id TEXT, requested_head TEXT, requested_at INTEGER, PRIMARY KEY (issue_id, owner_id))`,
];

/** Where one owner stands on one fix, as the HuddleAgent keeps it. */
export interface FixReview {
  readonly issueId: string;
  readonly ownerId: string;
  /** The fix's head when the standing was recorded, or null while no fix commit is linked. */
  readonly head: string | null;
  readonly state: OwnerApprovalState;
  readonly reviewer: string | null;
  readonly reviewOpId: string | null;
  /** The head the owner was last asked to review, or null before the first request. */
  readonly requestedHead: string | null;
}

/** How many times Penguin writes a head link when another writer moved the sub-issue first. */
const LINK_ATTEMPTS = 5;

/**
 * Each fix sub-issue's review standing per owner (PRD section 7, HuddleAgent storage). It is live
 * coordination state: the reviews themselves are operations in the issues repo.
 */
export class FixReviewStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of FIX_REVIEW_SCHEMA) db.exec(statement);
  }

  /** The standing of every owner on the fix, by owner id. */
  of(issueId: string): FixReview[] {
    return this.#db.exec(`SELECT * FROM FixReview WHERE issue_id = ? ORDER BY owner_id`, issueId).map(fixReview);
  }

  /**
   * Records the fix's approval and answers the owners to ask for a review: each owner still pending
   * on a head they were not yet asked to review. With `request` false nobody is asked, as while the
   * combined tests have not passed. An owner no longer needed is dropped.
   */
  record(issueId: string, approval: FixApproval, request: boolean): string[] {
    return this.#db.transaction(() => {
      const before = new Map(this.of(issueId).map((review) => [review.ownerId, review]));
      const ask: string[] = [];
      for (const owner of approval.owners) {
        const asked = before.get(owner.owner)?.requestedHead ?? null;
        const due = request && approval.head !== null && owner.state === "pending" && asked !== approval.head;
        if (due) ask.push(owner.owner);
        // A request's head and time stay until the next request replaces them.
        this.#db.exec(
          `INSERT INTO FixReview (issue_id, owner_id, head, state, reviewer, review_op_id, requested_head, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (issue_id, owner_id) DO UPDATE SET head = excluded.head, state = excluded.state,
             reviewer = excluded.reviewer, review_op_id = excluded.review_op_id,
             requested_head = COALESCE(excluded.requested_head, requested_head),
             requested_at = COALESCE(excluded.requested_at, requested_at)`,
          issueId,
          owner.owner,
          approval.head,
          owner.state,
          owner.reviewer,
          owner.reviewOpId,
          due ? approval.head : null,
          due ? this.#now() : null,
        );
        before.delete(owner.owner);
      }
      for (const gone of before.keys()) {
        this.#db.exec(`DELETE FROM FixReview WHERE issue_id = ? AND owner_id = ?`, issueId, gone);
      }
      return ask;
    });
  }
}

function fixReview(row: Row): FixReview {
  const text = (column: string): string | null => (row[column] as string | null) ?? null;
  return {
    issueId: row["issue_id"] as string,
    ownerId: row["owner_id"] as string,
    head: text("head"),
    state: row["state"] as OwnerApprovalState,
    reviewer: text("reviewer"),
    reviewOpId: text("review_op_id"),
    requestedHead: text("requested_head"),
  };
}

/**
 * Collects the reviews of the Huddle's fixes: records where each fix's approval stands, and, while the
 * Huddle issue is IN_REVIEW, links each fix's head and asks the owners who still owe a review of it.
 * Undefined when the Huddle's issue is still opening, missing or closed. Safe to repeat: a head
 * already linked is not linked again, and an owner already asked about a head is not asked again.
 */
export async function collectReviews(deps: HuddleReviewDeps, huddle: Huddle): Promise<ReviewCollection | undefined> {
  const issueId = huddle.issueId;
  const issue = issueId === null ? undefined : await deps.issue(issueId);
  if (issueId === null || issue === undefined || issue.state === "closed") return undefined;
  const inReview = issue.state === "in_review";
  const heads = inReview ? passedCheckpoints(deps, huddle) : new Map<string, string>();
  const scopeMap = await deps.scopeMap();
  const fixes: { issueId: string; approval: FixApproval }[] = [];
  const requested: string[] = [];
  for (const subId of issue.subIssues.keys()) {
    let sub = await deps.issue(subId);
    if (sub === undefined) continue;
    const head = fixingCheckpoint(sub, heads);
    if (head !== undefined && fixHead(sub) !== head) sub = await linkHead(deps, subId, head);
    const approval = fixApproval(sub, scopeMap);
    for (const owner of deps.reviews.record(subId, approval, inReview)) {
      await deps.requestReview(owner, subId);
      requested.push(`${owner} #${subId}`);
    }
    await deps.recordApproval(subId, approval);
    fixes.push({ issueId: subId, approval });
  }
  return { issueId, fixes, requested };
}

/**
 * Each owner's checkpoint, `owner-<id>@<sha>`, in the Huddle's latest run when that run passed, by
 * owner id; empty otherwise.
 */
function passedCheckpoints(deps: Pick<HuddleReviewDeps, "runs">, huddle: Huddle): Map<string, string> {
  const run = deps.runs.latest(huddle.triggerCommit);
  const report = run?.status === "done" ? run.report : null;
  if (run === undefined || report?.status !== "tested" || !report.results.every((r) => r.status === "passed")) {
    return new Map();
  }
  return new Map(run.checkpoints.map((checkpoint) => [checkpoint.ownerId, ownerCommit(checkpoint.ownerId, checkpoint.sha)]));
}

/**
 * The passing checkpoint of the owner fixing the sub-issue: the owner of its first assignee, in
 * assignment order, with a checkpoint in `heads`. An identity's owner is its handle's owner half.
 */
function fixingCheckpoint(sub: IssueRecord, heads: ReadonlyMap<string, string>): string | undefined {
  for (const { assigneeKind, assigneeId } of sub.assignments.values()) {
    const owner = assigneeKind === "person" ? assigneeId : assigneeId.slice(1, assigneeId.indexOf("/"));
    const head = heads.get(owner);
    if (head !== undefined) return head;
  }
  return undefined;
}

/** Links `commit` to the sub-issue as its fix and answers the sub-issue after the link. */
async function linkHead(deps: HuddleReviewPort, subId: string, commit: string): Promise<IssueRecord> {
  for (let attempt = 1; ; attempt += 1) {
    const sub = await deps.issue(subId);
    if (sub === undefined) throw new Error(`issue ${subId} is missing from the index`);
    if (fixHead(sub) === commit) return sub;
    const outcome = await deps.submit({
      issue: Number(subId),
      type: "link_commit",
      base_version: sub.version,
      payload: { commit, kind: "fix" },
    });
    // Another writer moved the sub-issue between the read and the write: read it again.
    if (outcome.status === "rejected" && (outcome.reason !== "superseded_version" || attempt === LINK_ATTEMPTS)) {
      throw new Error(`link_commit on #${subId} was rejected: ${outcome.reason}: ${outcome.message}`);
    }
  }
}
