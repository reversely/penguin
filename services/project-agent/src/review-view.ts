// A stored review as the dashboard shows it (PRD section 6): the form's rows beside each invariant's
// statement, the check runner's verdict and the side-by-side run's differing inputs. The approvals
// inbox and the feature page both read reviews through `reviewView`, so one review reads the same on
// each. Arguments and outcomes become JSON text cut at REVIEW_VIEW_LIMITS, so one review with
// thousands of differing inputs stays a small answer; the totals still count every input.

import { REVIEW_VIEW_LIMITS, type ReviewView, type SideBySideOutcome, type SideBySideRecord, type SideBySideView } from "@penguin/protocol";

import type { StoredReview } from "./review-submit.ts";

const cut = (text: string): string =>
  text.length > REVIEW_VIEW_LIMITS.valueLength ? `${text.slice(0, REVIEW_VIEW_LIMITS.valueLength)}…` : text;

/** An outcome as one line: the returned value as JSON, or the exception raised. */
export function outcomeLine(outcome: SideBySideOutcome): string {
  return cut(outcome.status === "returned" ? (JSON.stringify(outcome.value) ?? "null") : `raised ${outcome.error.type}: ${outcome.error.message}`);
}

export function sideBySideView(record: SideBySideRecord): SideBySideView {
  return {
    tool: record.tool,
    commandId: record.commandId,
    base: record.base,
    fork: record.fork,
    totals: record.totals,
    sets: record.sets.map((set) => ({
      source: set.source,
      file: set.file,
      contract: set.contract,
      invariants: set.invariants,
      inputs: set.inputs.length,
      differing: set.differing.slice(0, REVIEW_VIEW_LIMITS.differencesPerSet).map((difference) => ({
        name: difference.name,
        args: cut(JSON.stringify(difference.args)),
        main: outcomeLine(difference.main),
        fork: outcomeLine(difference.fork),
      })),
      omitted: Math.max(0, set.differing.length - REVIEW_VIEW_LIMITS.differencesPerSet),
      invalid: set.invalid.length,
    })),
  };
}

export function reviewView(review: StoredReview): ReviewView {
  const invariants = new Map((review.record?.invariants ?? review.invariants).map((invariant) => [invariant.id, invariant]));
  return {
    reviewId: review.id,
    feature: review.featureId,
    scope: review.scopeId,
    reviewer: review.reviewer,
    state: review.state === "accepted" || review.state === "refused" ? review.state : "pending",
    checkpoint: review.forkSha,
    rows: review.form.rows.map((row) => ({
      invariant: row.invariant,
      statement: invariants.get(row.invariant)?.statement ?? "",
      protected: invariants.get(row.invariant)?.protected ?? false,
      verdict: row.verdict,
      evidence: row.evidence,
      storedData: row.storedData,
    })),
    storedDataMarker: review.form.storedDataMarker,
    riskyInputs: review.form.riskyInputs.map(({ name, contract }) => ({ name, contract })),
    refusals: (review.record?.refusals ?? review.refusals).map(({ code, message }) => ({ code, message })),
    sideBySide: review.record === null ? null : sideBySideView(review.record.sideBySide),
    exceptions: review.exceptions,
  };
}
