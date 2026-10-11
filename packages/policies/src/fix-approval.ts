// Where approval of one fix stands (PRD sections 5 and 6). A fix needs the approval of every owner
// whose review counts on it (review-rights.ts). An owner's standing verdict is their latest counting
// review, or their delegate's, of the fix's head: the commit most recently linked to the fix as a
// `fix`. A review of any other commit was of a superseded revision and does not count. The fix is
// approved when every such owner's standing verdict approves.

import type { ScopeMap } from "@penguin/scope-map";

import { reviewOwners } from "./review-rights.ts";

/** A commit linked to an issue, as the issue index holds it. */
export interface LinkedCommitRecord {
  readonly repo: string;
  readonly sha: string;
  readonly kind: "trigger" | "fix" | "related" | null;
}

/** A review on an issue, as the issue index holds it. */
export interface ReviewRecord {
  readonly opId: string;
  /** The reviewer's person id (author segment). */
  readonly reviewerOwnerId: string;
  readonly verdict: "approve" | "request_changes";
  readonly reason: string | null;
  readonly repo: string;
  readonly sha: string;
  readonly counts: boolean;
  /** The owners whose approval the review stands for (ReviewRight.countsFor). */
  readonly countsFor: readonly string[];
}

/** What a fix's approval is read from: its labels, linked commits and reviews, in apply order. */
export interface FixRecord {
  readonly labels: readonly string[];
  readonly linkedCommits: ReadonlyMap<string, LinkedCommitRecord>;
  readonly reviews: ReadonlyMap<string, ReviewRecord>;
}

export type OwnerApprovalState = "approved" | "changes_requested" | "pending";

export interface OwnerApproval {
  readonly owner: string;
  readonly state: OwnerApprovalState;
  /** Who wrote the standing review: the owner, or the owner's delegate; null while pending. */
  readonly reviewer: string | null;
  /** The op_id of the standing review, or null while pending. */
  readonly reviewOpId: string | null;
  /** The reason the standing review gave, or null. */
  readonly reason: string | null;
}

export interface FixApproval {
  /** The commit under review, `<repo>@<sha>`, or null while no fix commit is linked. */
  readonly head: string | null;
  /** One entry per owner whose review counts, sorted by owner. */
  readonly owners: readonly OwnerApproval[];
  /** True when there is a head, at least one owner, and every owner approved the head. */
  readonly approved: boolean;
}

/** The commit most recently linked to the issue as a `fix`, `<repo>@<sha>`, or null when none is. */
export function fixHead(issue: Pick<FixRecord, "linkedCommits">): string | null {
  let head: string | null = null;
  for (const link of issue.linkedCommits.values()) if (link.kind === "fix") head = `${link.repo}@${link.sha}`;
  return head;
}

/** Where approval of the fix stands, judged by the owners of its labelled scopes in `scopeMap`. */
export function fixApproval(issue: FixRecord, scopeMap: ScopeMap): FixApproval {
  const head = fixHead(issue);
  const standing = new Map<string, ReviewRecord>();
  if (head !== null) {
    for (const review of issue.reviews.values()) {
      if (!review.counts || `${review.repo}@${review.sha}` !== head) continue;
      for (const owner of review.countsFor) standing.set(owner, review);
    }
  }
  const owners = reviewOwners(issue.labels, scopeMap).map((owner): OwnerApproval => {
    const review = standing.get(owner);
    if (review === undefined) return { owner, state: "pending", reviewer: null, reviewOpId: null, reason: null };
    return {
      owner,
      state: review.verdict === "approve" ? "approved" : "changes_requested",
      reviewer: review.reviewerOwnerId,
      reviewOpId: review.opId,
      reason: review.reason,
    };
  });
  const approved = head !== null && owners.length > 0 && owners.every((owner) => owner.state === "approved");
  return { head, owners, approved };
}
