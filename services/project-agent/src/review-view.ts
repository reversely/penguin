// A stored review as the dashboard shows it (PRD section 6): the form's rows beside each invariant's
// statement, the check runner's verdict and the side-by-side run's differing inputs. The approvals
// inbox and the feature page both read reviews through `reviewView`, so one review reads the same on
// each. Arguments and outcomes become JSON text cut at REVIEW_VIEW_LIMITS, so one review with
// thousands of differing inputs stays a small answer; the totals and each set's breakdown still count
// every differing input, and the full table is a separate answer read when a person opens it.

import {
  REVIEW_VIEW_LIMITS,
  type ReviewDifferences,
  type ReviewView,
  type SideBySideBreakdown,
  type SideBySideOutcome,
  type SideBySideRecord,
  type SideBySideSet,
  type SideBySideView,
} from "@penguin/protocol";

import type { StoredReview } from "./review-submit.ts";

const cut = (text: string): string =>
  text.length > REVIEW_VIEW_LIMITS.valueLength ? `${text.slice(0, REVIEW_VIEW_LIMITS.valueLength)}…` : text;

/** An outcome as one line: the returned value as JSON, or the exception raised. */
export function outcomeLine(outcome: SideBySideOutcome): string {
  return cut(outcome.status === "returned" ? (JSON.stringify(outcome.value) ?? "null") : `raised ${outcome.error.type}: ${outcome.error.message}`);
}

/** The key path of the first list in `value`, depth first in key order; a list's items are not searched. */
function firstListPath(value: unknown, path: readonly string[] = []): readonly string[] | undefined {
  if (Array.isArray(value)) return path.length === 0 ? undefined : path;
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = firstListPath(child, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The length of the list at `path` in `args`, or undefined when no list is there. */
function listLength(args: unknown, path: readonly string[]): number | undefined {
  let value = args;
  for (const key of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * Where a set's breakdown list sits in each input's arguments: the first list of the first differing
 * input, kept only when every differing input holds a list there. PRD section 6 states a difference
 * this way ("every case has three or more lines"); the list is found from the arguments, so no
 * contract or fixture is named here.
 */
function breakdownPath(set: SideBySideSet): readonly string[] | undefined {
  const first = set.differing[0];
  const path = first === undefined ? undefined : firstListPath(first.args);
  if (path === undefined) return undefined;
  return set.differing.every((difference) => listLength(difference.args, path) !== undefined) ? path : undefined;
}

/** How a set's differing inputs spread over the length of their shared list, or null; see breakdownPath. */
export function sideBySideBreakdown(set: SideBySideSet): SideBySideBreakdown | null {
  const path = breakdownPath(set);
  if (path === undefined) return null;
  const counts = new Map<number, number>();
  for (const difference of set.differing) {
    const length = listLength(difference.args, path) ?? 0;
    counts.set(length, (counts.get(length) ?? 0) + 1);
  }
  if (counts.size > REVIEW_VIEW_LIMITS.breakdownLengths) return null;
  return {
    list: path.at(-1) ?? "",
    counts: [...counts.entries()].sort(([a], [b]) => a - b).map(([length, inputs]) => ({ length, inputs })),
  };
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
      breakdown: sideBySideBreakdown(set),
    })),
  };
}

/**
 * Every differing input of each set of a review's side-by-side run (GET /api/reviews/<id>/differences),
 * up to REVIEW_VIEW_LIMITS.differencesInTable per set; undefined until the runner attached its record.
 */
export function reviewDifferences(review: StoredReview): ReviewDifferences | undefined {
  if (review.record === null) return undefined;
  return {
    reviewId: review.id,
    sets: review.record.sideBySide.sets.map((set) => {
      const path = breakdownPath(set);
      return {
        contract: set.contract,
        file: set.file,
        list: path?.at(-1) ?? null,
        differing: set.differing.slice(0, REVIEW_VIEW_LIMITS.differencesInTable).map((difference) => ({
          name: difference.name,
          main: outcomeLine(difference.main),
          fork: outcomeLine(difference.fork),
          length: path === undefined ? null : (listLength(difference.args, path) ?? null),
        })),
        omitted: Math.max(0, set.differing.length - REVIEW_VIEW_LIMITS.differencesInTable),
      };
    }),
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
