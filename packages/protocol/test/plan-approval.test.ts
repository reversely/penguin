// The routing of PRD 0.4 section 4.3 step 4 (#90), fed with recorded review results: the tax review
// of docs/case-study-money.md, whose side-by-side run differs on the protected per-line invariant, and
// Jun's protected `analytics/revenue_report.py`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkPlanInbox,
  checkReviewDifferences,
  partRouting,
  reviewExceptions,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  REVIEW_SCHEMA_VERSION,
  type InvariantView,
  type PartReviewResult,
  type PlanPart,
  type ReviewForm,
  type SideBySideRecord,
} from "@penguin/protocol";

const PER_LINE: InvariantView = { id: "tax-per-line", scopeId: "tax", statement: "Tax is rounded per line item", protected: true };
const BASE = "a".repeat(40);
const FORK = "b".repeat(40);

function sideBySide(differing: number): SideBySideRecord {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    tool: SIDE_BY_SIDE_TOOL,
    commandId: SIDE_BY_SIDE_COMMAND_ID,
    base: BASE,
    fork: FORK,
    scope: "tax",
    sets: [
      {
        source: "examples",
        file: "tax/examples/orders.json",
        contract: "tax/invoice.py::invoice_tax",
        invariants: [PER_LINE.id],
        inputs: Array.from({ length: Math.max(differing, 1) }, (_, index) => `order ${index}`),
        differing: Array.from({ length: differing }, (_, index) => ({
          name: `order ${index}`,
          args: {},
          main: { status: "returned" as const, value: 3 },
          fork: { status: "returned" as const, value: 4 },
        })),
        invalid: [],
        mainMs: 1,
        forkMs: 1,
      },
    ],
    totals: { inputs: Math.max(differing, 1), differing, invalid: 0 },
    timings: { mainMs: 1, forkMs: 1, totalMs: 2 },
  };
}

const form = (verdict: "holds" | "breaks"): ReviewForm => ({
  rows: [{ invariant: PER_LINE.id, verdict, evidence: ["tax/tests/test_invoice.py::test_per_line"], storedData: "None" }],
  riskyInputs: [],
  storedDataMarker: null,
});

/** A recorded review result as the ProjectAgent keeps it: the exceptions derived from the form and the run. */
const recorded = (reviewId: number, scope: string, accepted: ReviewForm | null, differing: number): PartReviewResult => ({
  reviewId,
  scope,
  state: accepted === null ? "refused" : "accepted",
  exceptions: reviewExceptions(accepted, [PER_LINE], sideBySide(differing)),
});

const part = (paths: string[], scopes = ["tax"]): Pick<PlanPart, "scopes" | "diff"> => ({
  scopes,
  diff: {
    source: "commit",
    repo: "feature-money",
    ref: `feature-money@${FORK}`,
    commit: FORK,
    base: BASE,
    patch: null,
    files: paths.map((path) => ({ path, scopeId: null, status: "modified" as const, hunks: [], omitted: null })),
    truncated: false,
  },
});

const PROTECTED = new Map([["analytics/revenue_report.py", { scope: "analytics", owner: "jun", path: "analytics/revenue_report.py" }]]);
const protectedFor = (path: string) => PROTECTED.get(path);

test("a part with no routing condition needs nobody in person", () => {
  const routing = partRouting(part(["tax/invoice.py"]), [recorded(1, "tax", form("holds"), 0)], protectedFor);
  assert.deepEqual(routing, { inPerson: false, reasons: [] });
  // A pending review raises nothing yet, and neither does a review of a scope outside the part.
  const pending: PartReviewResult = { reviewId: 2, scope: "tax", state: "pending", exceptions: [] };
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), [pending, recorded(3, "orders", form("breaks"), 9)], protectedFor).inPerson, false);
});

test("a difference on a protected invariant routes to the author whatever the form says", () => {
  // Rahul's tax review: 1,633 of 5,000 sample orders differ on the per-line invariant.
  for (const accepted of [form("holds"), null]) {
    const routing = partRouting(part(["tax/invoice.py"]), [recorded(4, "tax", accepted, 1_633)], protectedFor);
    assert.deepEqual(routing.reasons, [
      { kind: "protected_difference", scope: "tax", invariant: "tax-per-line", contract: "tax/invoice.py::invoice_tax", differing: 1_633, reviewId: 4 },
    ]);
    assert.equal(routing.inPerson, true);
  }
});

test("a broken invariant routes to the author; only the newest review of each scope counts", () => {
  const broken = recorded(5, "tax", form("breaks"), 0);
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), [broken], protectedFor).reasons, [
    { kind: "broken_invariant", scope: "tax", invariant: "tax-per-line", reviewId: 5 },
  ]);
  // The revision's review holds and matches main: the older review no longer routes.
  const revised = recorded(6, "tax", form("holds"), 0);
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), [revised, broken], protectedFor), { inPerson: false, reasons: [] });
});

test("a part that writes a protected path routes to the path's owner", () => {
  const routing = partRouting(part(["analytics/revenue_report.py", "analytics/weekly.py"], ["analytics"]), [], protectedFor);
  assert.deepEqual(routing, {
    inPerson: true,
    reasons: [{ kind: "protected_path", scope: "analytics", owner: "jun", path: "analytics/revenue_report.py", file: "analytics/revenue_report.py" }],
  });
});

test("the dashboard answer schema takes a part with its routing and refuses markup in a person id", () => {
  const routing = partRouting(part(["analytics/revenue_report.py"], ["analytics"]), [], protectedFor);
  const item = {
    ask: "approve",
    feature: "money-minor",
    person: "ines",
    partId: "money-minor/v1#3",
    revision: 1,
    place: { kind: "scope", scope: "analytics" },
    owner: "jun",
    kind: "behavioural",
    kindReason: "analytics/revenue_report.py:4 changes more than a codemod edit swaps",
    state: "pending",
    changeRequests: 0,
    roundLimit: 3,
    files: [{ path: "analytics/revenue_report.py", status: "modified", lines: ["-a", "+b"] }],
    breaks: [{ target: "main", statement: "Revenue in different currencies is never added together.", nodeId: "analytics/tests/test_revenue.py::test_currencies", assertion: "assert x", error: null }],
    reviews: [REVIEW],
    routing,
    changeRequest: null,
    read: false,
    raisedAt: "2026-10-11T09:00:00.000Z",
  };
  const empty = { parts: [], protectedChanges: [], reviewExceptions: [], returnedPlans: [] };
  assert.deepEqual(checkPlanInbox({ ...empty, parts: [item] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, owner: "<b>jun</b>" }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, state: "merged" }] }), []);
  // A review must carry its form's verdicts as one of the three and its run's commits as SHAs.
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [{ ...REVIEW, rows: [{ ...REVIEW.rows[0], verdict: "fine" }] }] }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [{ ...REVIEW, checkpoint: "main" }] }] }), []);
  const exception = { feature: "money-minor", scope: "tax", reviewId: 4, state: "accepted", exceptions: REVIEW.exceptions, review: REVIEW, read: false, raisedAt: "2026-10-11T09:00:00.000Z" };
  const returned = { feature: "money-minor", breakLimit: 10, behavioural: ["scope tax", "feature tax-exempt"], read: true, raisedAt: "2026-10-11T09:00:00.000Z" };
  assert.deepEqual(checkPlanInbox({ ...empty, reviewExceptions: [exception], returnedPlans: [returned] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, returnedPlans: [{ ...returned, feature: "../main" }] }), []);
  assert.notDeepEqual(checkPlanInbox({ parts: [], reviewExceptions: [] }), []);
  // A feature's own protected lines: a SHA checkpoint, a known state, and lines or null for a viewer the line rule leaves out.
  const change = {
    feature: "money-analytics",
    person: "ines",
    owner: "jun",
    checkpoint: "a".repeat(40),
    mergeBase: "b".repeat(40),
    state: "pending",
    confirmedBy: null,
    files: [{ path: "analytics/revenue_report.py", status: "modified", scope: "analytics", protectedPath: "analytics/revenue_report.py", lines: ["-a", "+b"] }],
    read: false,
    raisedAt: "2026-10-11T09:00:00.000Z",
  };
  assert.deepEqual(checkPlanInbox({ ...empty, protectedChanges: [change, { ...change, state: "confirmed", confirmedBy: "jun", files: [{ ...change.files[0], lines: null }] }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, protectedChanges: [{ ...change, checkpoint: "main" }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, protectedChanges: [{ ...change, state: "approved" }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, protectedChanges: [{ ...change, owner: "<b>jun</b>" }] }), []);
  // A breakdown names its list and counts at most REVIEW_VIEW_LIMITS.breakdownLengths lengths.
  const set = REVIEW.sideBySide.sets[0]!;
  const withBreakdown = (breakdown: unknown) => ({ ...REVIEW, sideBySide: { ...REVIEW.sideBySide, sets: [{ ...set, breakdown }] } });
  assert.deepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [withBreakdown(null)] }] }), []);
  const wide = { list: "lines", counts: Array.from({ length: 33 }, (_, length) => ({ length, inputs: 1 })) };
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [withBreakdown(wide)] }] }), []);
});

test("the full table answer takes each differing input with its length and refuses arguments", () => {
  const row = { name: "order-0003", main: "36", fork: "35", length: 3 };
  const answer = { reviewId: 4, sets: [{ contract: "tax/invoice.py::invoice_tax_minor", file: "tax/examples/invoice_tax.json", list: "lines", differing: [row], omitted: 0 }] };
  assert.deepEqual(checkReviewDifferences(answer), []);
  assert.deepEqual(checkReviewDifferences({ reviewId: 4, sets: [{ ...answer.sets[0], list: null, differing: [{ ...row, length: null }] }] }), []);
  assert.notDeepEqual(checkReviewDifferences({ reviewId: 4, sets: [{ ...answer.sets[0], differing: [{ ...row, args: "{}" }] }] }), []);
  assert.notDeepEqual(checkReviewDifferences({ reviewId: 4, sets: [{ ...answer.sets[0], differing: [{ ...row, main: "x".repeat(400) }] }] }), []);
});

/** A review as the dashboard shows it: the form's rows, the runner's verdict and its side-by-side run. */
const REVIEW = {
  reviewId: 4,
  feature: "money-minor",
  scope: "tax",
  reviewer: "@rahul/deposits",
  state: "accepted",
  checkpoint: "a".repeat(40),
  rows: [{ invariant: "tax-per-line", statement: "Tax is rounded per line item", protected: false, verdict: "breaks", evidence: ["tax/invoice.py::invoice_tax"], storedData: "" }],
  storedDataMarker: { kind: "migration", evidence: "orders/model.py::Order::from_record" },
  riskyInputs: [],
  refusals: [],
  sideBySide: {
    tool: "side-by-side",
    commandId: "analysis:side-by-side",
    base: "b".repeat(40),
    fork: "a".repeat(40),
    totals: { inputs: 5000, differing: 1633, invalid: 0 },
    sets: [
      {
        source: "examples",
        file: "tax/examples/invoice_tax.json",
        contract: "tax/invoice.py::invoice_tax_minor",
        invariants: ["tax-per-line"],
        inputs: 5000,
        differing: [{ name: "order-0003", args: '{"order":1}', main: "36", fork: "35" }],
        omitted: 1632,
        invalid: 0,
        breakdown: { list: "lines", counts: [{ length: 2, inputs: 400 }, { length: 3, inputs: 1233 }] },
      },
    ],
  },
  exceptions: [{ kind: "broken_invariant", invariant: "tax-per-line", scope: "tax" }],
};
