// The check runner's half of a review (PRD 0.4 sections 4.3 and 6). A form that passed `submit_review`
// waits as `pending` in FeatureReview. The integration runner claims pending reviews under a lease,
// as it claims combined runs: an unreported claim is handed out again after the lease. For each it
// runs the review harness (`penguin-bridge review`) on the feature's fork and reports the record.
//
// The report makes the review accepted or refused with the record attached. The routing of PRD 4.3
// step 4 is derived here from the stored form, the invariants checked at submission and the record's
// side-by-side run, never taken from the runner's own list: a broken invariant in an accepted form, or
// a difference on a protected invariant whatever the form says, goes to the scope's owner in person.

import { parseReviewRecord, reviewExceptions, type ReviewForm } from "@penguin/protocol";

import type { BridgeCaller } from "./issue-index.ts";
import type { ReviewStore, StoredReview } from "./review-submit.ts";

/** One claimed review as the runner receives it. Every value comes from the stored review. */
export interface ClaimedReview {
  readonly reviewId: number;
  readonly feature: string;
  /** The feature's fork as a bridge names it, without the deployment's prefix. */
  readonly fork: string;
  readonly scope: string;
  /** The checkpoint's baseline on main. */
  readonly base: string;
  /** The checkpoint under review. */
  readonly forkSha: string;
  readonly form: ReviewForm;
}

export type ReviewClaim =
  | { readonly status: "ok"; readonly reviews: readonly ClaimedReview[] }
  | { readonly status: "forbidden"; readonly message: string };

/** Claims the pending reviews for a runner bridge; any other role is refused. */
export function claimReviews(reviews: ReviewStore, caller: BridgeCaller): ReviewClaim {
  const listing = reviews.claim(caller);
  if (listing.status === "forbidden") return listing;
  return {
    status: "ok",
    reviews: listing.reviews.map((review) => ({
      reviewId: review.id,
      feature: review.featureId,
      fork: `feature-${review.featureId}`,
      scope: review.scopeId,
      base: review.baseSha as string,
      forkSha: review.forkSha,
      form: review.form,
    })),
  };
}

export type ReviewReportOutcome =
  | {
      readonly status: "recorded";
      readonly review: StoredReview;
      /** The person the review goes to in person, or null when the agent's review stands. */
      readonly routedTo: string | null;
    }
  | {
      readonly status: "rejected";
      readonly reason: "invalid" | "forbidden" | "not_found" | "conflict";
      readonly message: string;
    };

export interface ReviewRecordDeps {
  readonly reviews: ReviewStore;
  /** Puts a review with exceptions before its scope's owner, such as an inbox item. */
  readonly routeToOwner: (ownerId: string, review: StoredReview) => void;
}

const rejected = (reason: Extract<ReviewReportOutcome, { status: "rejected" }>["reason"], message: string): ReviewReportOutcome => ({
  status: "rejected",
  reason,
  message,
});

async function sha256Ref(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Attaches the runner's record to pending review `reviewId`. The record must name the review's own
 * baseline, checkpoint and scope. The first report wins; a later one answers `conflict`.
 */
export async function recordReview(deps: ReviewRecordDeps, caller: BridgeCaller, reviewId: number, body: unknown): Promise<ReviewReportOutcome> {
  if (caller.role !== "runner") return rejected("forbidden", `bridge ${caller.bridgeId} does not hold the runner role`);
  const review = deps.reviews.get(reviewId);
  if (review === undefined) return rejected("not_found", `no review ${reviewId}`);
  if (review.state !== "pending") return rejected("conflict", `review ${reviewId} is already ${review.state}`);
  const parsed = parseReviewRecord(body);
  if (!parsed.ok) return rejected("invalid", parsed.problems.join("; "));
  const { record } = parsed;
  if (record.base !== review.baseSha || record.fork !== review.forkSha || record.scope !== review.scopeId) {
    return rejected("invalid", `the record is not of review ${reviewId}: it must name its baseline, checkpoint and scope`);
  }

  const text = JSON.stringify(record);
  const exceptions = reviewExceptions(record.state === "accepted" ? review.form : null, review.invariants, record.sideBySide);
  const completed = deps.reviews.complete(reviewId, {
    state: record.state,
    refusals: record.refusals,
    record,
    sideBySideRef: await sha256Ref(text),
    exceptions,
  });
  if (completed === undefined) return rejected("conflict", `review ${reviewId} was completed by another report`);
  const routedTo = exceptions.length > 0 ? completed.ownerId : null;
  if (routedTo !== null) deps.routeToOwner(routedTo, completed);
  return { status: "recorded", review: completed, routedTo };
}
