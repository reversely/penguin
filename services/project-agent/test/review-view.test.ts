// A review's side-by-side run as the dashboard reads it: each set's breakdown of differing inputs by
// the length of the list they share, and the full table a person opens from a set's summary.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkReviewDifferences, REVIEW_VIEW_LIMITS, type SideBySideDifference, type SideBySideSet } from "@penguin/protocol";

import { reviewDifferences, sideBySideBreakdown, sideBySideView } from "../src/review-view.ts";
import type { StoredReview } from "../src/review-submit.ts";

/** An order input as the money fixture's examples file passes it: the record's lines sit three keys down. */
const order = (name: string, lines: number, main = 36, fork = 35): SideBySideDifference => ({
  name,
  args: { order: { $call: "orders/model.py::Order.from_record", args: { record: { id: name, region: "NY", lines: Array.from({ length: lines }, () => ({ sku: "milk" })) } } } },
  main: { status: "returned", value: main },
  fork: { status: "returned", value: fork },
});

const set = (differing: SideBySideDifference[]): SideBySideSet => ({
  source: "examples",
  file: "tax/examples/invoice_tax.json",
  contract: "tax/invoice.py::invoice_tax_minor",
  invariants: ["tax-per-line"],
  inputs: differing.map((difference) => difference.name),
  differing,
  invalid: [],
  mainMs: 1,
  forkMs: 1,
});

test("the breakdown counts every differing input by the length of the list they all hold, shortest first", () => {
  const differing = [order("o-1", 3), order("o-2", 5), order("o-3", 3), order("o-4", 4), order("o-5", 3), order("o-6", 6), order("o-7", 3)];
  assert.deepEqual(sideBySideBreakdown(set(differing)), {
    list: "lines",
    counts: [
      { length: 3, inputs: 4 },
      { length: 4, inputs: 1 },
      { length: 5, inputs: 1 },
      { length: 6, inputs: 1 },
    ],
  });
  // The summary keeps five examples and still counts all seven in its breakdown.
  const view = sideBySideView({
    schemaVersion: 1,
    tool: "side-by-side",
    commandId: "analysis:side-by-side",
    base: "b".repeat(40),
    fork: "a".repeat(40),
    scope: "tax",
    sets: [set(differing)],
    totals: { inputs: 7, differing: 7, invalid: 0 },
    timings: { mainMs: 1, forkMs: 1, totalMs: 2 },
  } as never);
  assert.equal(view.sets[0]?.differing.length, REVIEW_VIEW_LIMITS.differencesPerSet);
  assert.equal(view.sets[0]?.omitted, 2);
  assert.equal(view.sets[0]?.breakdown?.counts.reduce((sum, count) => sum + count.inputs, 0), 7);
});

test("no breakdown when an input lacks the list, the inputs hold no list, or the lengths spread too wide", () => {
  const scalar = (name: string): SideBySideDifference => ({ name, args: { amount: 3 }, main: { status: "returned", value: 1 }, fork: { status: "returned", value: 2 } });
  assert.equal(sideBySideBreakdown(set([scalar("a"), scalar("b")])), null);
  assert.equal(sideBySideBreakdown(set([order("o-1", 2), scalar("b")])), null);
  assert.equal(sideBySideBreakdown(set([])), null);
  const wide = Array.from({ length: REVIEW_VIEW_LIMITS.breakdownLengths + 1 }, (_, index) => order(`o-${index}`, index));
  assert.equal(sideBySideBreakdown(set(wide)), null);
  assert.equal(sideBySideBreakdown(set(wide.slice(1)))?.counts.length, REVIEW_VIEW_LIMITS.breakdownLengths);
});

test("the full table lists every differing input with each side's outcome and its list's length, without arguments", () => {
  const differing = Array.from({ length: 1_633 }, (_, index) => order(`order-${index}`, 2 + (index % 5)));
  const stored = { id: 4, record: { sideBySide: { sets: [set(differing)] } } } as unknown as StoredReview;
  const table = reviewDifferences(stored);
  assert.ok(table !== undefined);
  assert.deepEqual(checkReviewDifferences(table), []);
  const only = table.sets[0]!;
  assert.equal(only.list, "lines");
  assert.equal(only.differing.length, 1_633);
  assert.equal(only.omitted, 0);
  assert.deepEqual(only.differing[1], { name: "order-1", main: "36", fork: "35", length: 3 });
  assert.equal(JSON.stringify(table).includes("from_record"), false);
  // A review the runner has not reported on has no table.
  assert.equal(reviewDifferences({ id: 5, record: null } as unknown as StoredReview), undefined);
});
