// The facts `partRouting` (@penguin/protocol) reads for a part, as the ProjectAgent holds them: each
// stored review as a routing result, the scope map's protected paths and the part revision's trial
// (part-trial.ts). propose-plan.ts reads them for the break limit and plan-approval.ts for Penguin's
// approval and the dashboard, so both apply the same checks (PRD 0.5 sections 4.2 step 4 and 4.3).
//
// A recorded trial of the part's current revision replaces the plan's facts-run tests with the
// trial's tests on the tree that holds the fix, and each review it ran with its run on that tree. A
// trial still running holds each form it carries as pending, so Penguin waits for it instead of
// approving on a review of the originating checkpoint.

import { readOnlyShapes, type PartReviewResult, type PartTrialEvidence, type PlanPart, type ProtectedPathHit } from "@penguin/protocol";
import { protectedPathFor, type ScopeMap } from "@penguin/scope-map";

import type { StoredReview } from "./review-submit.ts";

/** A protected-path lookup over `scopeMap`, naming each covering path's scope and that scope's DRI. */
export function protectedLookup(scopeMap: ScopeMap): (path: string) => ProtectedPathHit | undefined {
  return (path) => {
    let hit;
    try {
      hit = protectedPathFor(scopeMap, path);
    } catch {
      return undefined;
    }
    const owner = hit === undefined ? undefined : scopeMap.scopes.get(hit.scopeId)?.driId;
    return hit === undefined || owner === undefined ? undefined : { scope: hit.scopeId, owner, path: hit.path };
  };
}

/** Where the trial of a part's current revision stands: running with the forms it carries, or recorded. */
export type PartTrialStanding =
  | { readonly state: "running"; readonly reviewIds: readonly number[] }
  | { readonly state: "recorded"; readonly evidence: PartTrialEvidence };

/** The part as the routing reads it: with a recorded trial, the trial's tests in place of the facts run's. */
export function trialPart<T extends Pick<PlanPart, "tests">>(part: T, trial: PartTrialStanding | undefined): T {
  return trial?.state === "recorded" ? { ...part, tests: trial.evidence.tests } : part;
}

/** The feature's review results with each form a trial carries read from that trial. */
export function trialReviews(results: readonly PartReviewResult[], trial: PartTrialStanding | undefined): PartReviewResult[] {
  if (trial === undefined) return [...results];
  if (trial.state === "running") {
    const held = new Set(trial.reviewIds);
    return results.map((result) => (held.has(result.reviewId) ? { ...result, state: "pending", exceptions: [] } : result));
  }
  const ran = new Map(trial.evidence.reviews.map((review) => [review.reviewId, review]));
  return results.map((result) => ran.get(result.reviewId) ?? result);
}

/**
 * A stored review as the routing reads it: its checkpoint, verdict, exceptions, the rows that do not
 * hold and the changed stored shapes its scope only reads.
 */
export function reviewResult(review: StoredReview): PartReviewResult {
  return {
    reviewId: review.id,
    scope: review.scopeId,
    forkSha: review.forkSha,
    state: review.state,
    exceptions: review.exceptions,
    notHolding: review.form.rows.filter((row) => row.verdict !== "holds").map((row) => row.invariant),
    readShapes: review.record === null ? [] : readOnlyShapes(review.record),
  };
}
