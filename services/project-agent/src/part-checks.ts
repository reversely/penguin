// The facts `partRouting` (@penguin/protocol) reads for a part, as the ProjectAgent holds them: each
// stored review as a routing result and the scope map's protected paths. propose-plan.ts reads them for
// the break limit and plan-approval.ts for Penguin's approval and the dashboard, so both apply the same
// checks (PRD 0.5 sections 4.2 step 4 and 4.3).

import type { PartReviewResult, ProtectedPathHit } from "@penguin/protocol";
import { protectedPathFor, type ScopeMap } from "@penguin/scope-map";

import type { StoredReview } from "./review-submit.ts";

/** A protected-path lookup over `scopeMap`, naming each covering path's scope and that scope's owner. */
export function protectedLookup(scopeMap: ScopeMap): (path: string) => ProtectedPathHit | undefined {
  return (path) => {
    let hit;
    try {
      hit = protectedPathFor(scopeMap, path);
    } catch {
      return undefined;
    }
    const owner = hit === undefined ? undefined : scopeMap.scopes.get(hit.scopeId)?.ownerId;
    return hit === undefined || owner === undefined ? undefined : { scope: hit.scopeId, owner, path: hit.path };
  };
}

/** A stored review as the routing reads it: its checkpoint, verdict, exceptions and the rows that do not hold. */
export function reviewResult(review: StoredReview): PartReviewResult {
  return {
    reviewId: review.id,
    scope: review.scopeId,
    forkSha: review.forkSha,
    state: review.state,
    exceptions: review.exceptions,
    notHolding: review.form.rows.filter((row) => row.verdict !== "holds").map((row) => row.invariant),
  };
}
