// The routing of PRD 0.5 section 4.3 (#90, #114): Penguin approves a part only when each of its five
// checks is clean, and one failing or absent check sends it to a person. The fixtures are the tax
// review of docs/case-study-money.md, whose side-by-side run differs on the protected per-line
// invariant, and Jun's protected `analytics/revenue_report.py`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkPlanInbox,
  checkReviewDifferences,
  needsPerson,
  partRouting,
  reviewExceptions,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  REVIEW_SCHEMA_VERSION,
  type InvariantView,
  type PartEvidence,
  type PartReviewResult,
  type PlanPart,
  type ReviewForm,
  type SideBySideRecord,
} from "@penguin/protocol";

const PER_LINE: InvariantView = { id: "tax-per-line", scopeId: "tax", statement: "Tax is rounded per line item", protected: true };
const BASE = "a".repeat(40);
const FORK = "b".repeat(40);
const CHECKPOINT = "c".repeat(40);

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

const form = (verdict: "holds" | "breaks" | "unknown"): ReviewForm => ({
  rows: [{ invariant: PER_LINE.id, verdict, evidence: ["tax/tests/test_invoice.py::test_per_line"], storedData: "None" }],
  riskyInputs: [],
  storedDataMarker: null,
});

/** A recorded review result as the ProjectAgent keeps it: the exceptions derived from the form and the run. */
const recorded = (reviewId: number, scope: string, accepted: ReviewForm | null, differing: number, forkSha = CHECKPOINT): PartReviewResult => ({
  reviewId,
  scope,
  forkSha,
  state: accepted === null ? "refused" : "accepted",
  exceptions: reviewExceptions(accepted, [PER_LINE], sideBySide(differing)),
  notHolding: (accepted?.rows ?? []).filter((row) => row.verdict !== "holds").map((row) => row.invariant),
});

type RoutedPart = Parameters<typeof partRouting>[0];

/**
 * A part for code on main in `scopes` whose fix is under the plan's checkpoint, whose tests passed there
 * and whose files each hold a caller of the changed contract: every check but the review is clean.
 */
const part = (paths: string[], scopes = ["tax"], overrides: Partial<RoutedPart> = {}): RoutedPart => ({
  scopes,
  revision: 1,
  reversal: null,
  callers: paths.map((path) => ({ path, line: 3, kind: "call" as const, symbol: "shared.money.price", name: "price", scope: scopes[0] ?? null })),
  breaks: [],
  tests: {
    target: "main",
    runId: "facts-1",
    fixInTree: true,
    results: scopes.map((scopeId) => ({ scopeId, commandId: `test:${scopeId}`, status: "passed" as const, breaks: 0 })),
  },
  diff: {
    source: "commit",
    repo: "feature-money",
    ref: `feature-money@${FORK}`,
    commit: FORK,
    base: BASE,
    patch: null,
    files: paths.map((path) => ({ path, scopeId: scopes[0] ?? null, status: "modified" as const, hunks: [], omitted: null })),
    truncated: false,
    outside: [],
  },
  ...overrides,
});

const PROTECTED = new Map([["analytics/revenue_report.py", { scope: "analytics", owner: "jun", path: "analytics/revenue_report.py" }]]);
const protectedFor = (path: string) => PROTECTED.get(path);
const evidence = (reviews: PartReviewResult[], adminMode = false): PartEvidence => ({ reviews, checkpoint: CHECKPOINT, adminMode });
const HOLDS = recorded(1, "tax", form("holds"), 0);

test("a part whose five checks are clean needs nobody, so Penguin approves it", () => {
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), evidence([HOLDS]), protectedFor), { inPerson: false, reasons: [] });
  // A review of a scope outside the part does not count.
  assert.equal(partRouting(part(["tax/invoice.py"]), evidence([HOLDS, recorded(3, "orders", form("breaks"), 9)]), protectedFor).inPerson, false);
});

test("tests: a failing, missing or untested result sends the part to a person", () => {
  const failing = part(["tax/invoice.py"], ["tax"], {
    tests: { target: "main", runId: "facts-1", fixInTree: true, results: [{ scopeId: "tax", commandId: "test:tax", status: "failed", breaks: 2 }] },
  });
  assert.deepEqual(partRouting(failing, evidence([HOLDS]), protectedFor).reasons, [{ kind: "tests", scope: "tax", status: "failed", breaks: 2 }]);
  const unrun = part(["tax/invoice.py"], ["tax"], { tests: { target: "main", runId: "facts-1", fixInTree: true, results: [] } });
  assert.deepEqual(partRouting(unrun, evidence([HOLDS]), protectedFor).reasons, [{ kind: "tests", scope: "tax", status: "missing", breaks: 0 }]);
  // The tree the run tested does not hold the fix: a pass there says nothing about the fix.
  const clean = part(["tax/invoice.py"]);
  const outsideTree = part(["tax/invoice.py"], ["tax"], { tests: { ...(clean.tests as NonNullable<RoutedPart["tests"]>), fixInTree: false } });
  assert.deepEqual(partRouting(outsideTree, evidence([HOLDS]), protectedFor).reasons, [{ kind: "tests", scope: null, status: "fix_not_run", breaks: 0 }]);
  // A part kept before #114 carries no test evidence; an absent result never counts as clean.
  for (const tests of [undefined, null]) {
    const routing = partRouting(part(["tax/invoice.py"], ["tax"], { tests }), evidence([HOLDS]), protectedFor);
    assert.deepEqual(routing.reasons, [{ kind: "tests", scope: "tax", status: "missing", breaks: 0 }]);
    assert.equal(needsPerson(routing), true);
  }
});

test("review: Penguin waits for a missing, pending or older review and refuses a refused or unsure one", () => {
  const route = (reviews: PartReviewResult[]) => partRouting(part(["tax/invoice.py"]), evidence(reviews), protectedFor);
  const pending: PartReviewResult = { reviewId: 2, scope: "tax", forkSha: CHECKPOINT, state: "pending", exceptions: [], notHolding: [] };
  const waits = [
    [route([]), { kind: "review", scope: "tax", state: "missing", reviewId: null, invariant: null }],
    [route([pending]), { kind: "review", scope: "tax", state: "pending", reviewId: 2, invariant: null }],
    [route([recorded(3, "tax", form("holds"), 0, FORK)]), { kind: "review", scope: "tax", state: "stale", reviewId: 3, invariant: null }],
  ] as const;
  for (const [routing, reason] of waits) {
    assert.deepEqual(routing.reasons, [reason]);
    // Not approved, yet not counted against the break limit: the author's agent has still to review.
    assert.equal(routing.inPerson, true);
    assert.equal(needsPerson(routing), false);
  }
  const refused = route([recorded(4, "tax", null, 0)]);
  assert.deepEqual(refused.reasons, [{ kind: "review", scope: "tax", state: "refused", reviewId: 4, invariant: null }]);
  assert.equal(needsPerson(refused), true);
  const unsure = route([recorded(5, "tax", form("unknown"), 0)]);
  assert.deepEqual(unsure.reasons, [{ kind: "review", scope: "tax", state: "not_holding", reviewId: 5, invariant: "tax-per-line" }]);
});

test("side by side: a difference on a protected invariant routes to the author whatever the form says", () => {
  // Rahul's tax review: 1,633 of 5,000 sample orders differ on the per-line invariant.
  const routing = partRouting(part(["tax/invoice.py"]), evidence([recorded(4, "tax", form("holds"), 1_633)]), protectedFor);
  assert.deepEqual(routing.reasons, [
    { kind: "protected_difference", scope: "tax", invariant: "tax-per-line", contract: "tax/invoice.py::invoice_tax", differing: 1_633, reviewId: 4 },
  ]);
  assert.equal(needsPerson(routing), true);
});

test("a broken invariant routes to the author; only the newest review of each scope counts", () => {
  const broken = recorded(5, "tax", form("breaks"), 0);
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), evidence([broken]), protectedFor).reasons, [
    { kind: "broken_invariant", scope: "tax", invariant: "tax-per-line", reviewId: 5 },
  ]);
  // The revision's review holds and matches main: the older review no longer routes.
  const revised = recorded(6, "tax", form("holds"), 0);
  assert.deepEqual(partRouting(part(["tax/invoice.py"]), evidence([revised, broken]), protectedFor), { inPerson: false, reasons: [] });
});

test("protected paths: a part that writes one routes to the path's owner", () => {
  const review = recorded(7, "analytics", { rows: [], riskyInputs: [], storedDataMarker: null }, 0);
  const routing = partRouting(part(["analytics/revenue_report.py", "analytics/weekly.py"], ["analytics"]), evidence([review]), protectedFor);
  assert.deepEqual(routing, {
    inPerson: true,
    reasons: [{ kind: "protected_path", scope: "analytics", owner: "jun", path: "analytics/revenue_report.py", file: "analytics/revenue_report.py" }],
  });
});

test("place: a file outside the part's scopes or its callers and breaks sends the part to a person", () => {
  const clean = part(["tax/invoice.py"]);
  const outside = part(["tax/invoice.py"], ["tax"], { diff: { ...clean.diff, outside: ["checkout/cart.py"] } });
  assert.deepEqual(partRouting(outside, evidence([HOLDS]), protectedFor).reasons, [{ kind: "outside_place", file: "checkout/cart.py" }]);
  // A test file the change does not break and that calls nothing changed is outside the place.
  const extra = { ...clean.diff, files: [...clean.diff.files, { path: "tax/tests/test_rates.py", scopeId: "tax", status: "modified" as const, hunks: [], omitted: null }] };
  assert.deepEqual(partRouting(part(["tax/invoice.py"], ["tax"], { diff: extra }), evidence([HOLDS]), protectedFor).reasons, [
    { kind: "outside_place", file: "tax/tests/test_rates.py" },
  ]);
  // The same file is inside when one of its tests is a break of the part.
  const broken = part(["tax/invoice.py"], ["tax"], {
    diff: extra,
    breaks: [{ target: "main", scopeId: "tax", commandId: "test:tax", nodeId: "tax/tests/test_rates.py::test_rate", statement: "rate", statementFrom: "test_name", assertion: null, error: null, fingerprint: null }],
  });
  assert.deepEqual(partRouting(broken, evidence([HOLDS]), protectedFor).reasons, []);
  // A part kept before #114 names no files outside its scopes, so Penguin cannot tell.
  const { outside: _unrecorded, ...older } = clean.diff;
  assert.deepEqual(partRouting(part(["tax/invoice.py"], ["tax"], { diff: older }), evidence([HOLDS]), protectedFor).reasons, [{ kind: "outside_place", file: null }]);
});

test("admin mode and a reversal of the current revision send a clean part to a person", () => {
  const admin = partRouting(part(["tax/invoice.py"]), evidence([HOLDS], true), protectedFor);
  assert.deepEqual(admin.reasons, [{ kind: "admin_mode" }]);
  assert.equal(needsPerson(admin), true);
  const reversal = { by: "rahul", revision: 1, at: "2026-10-11T09:00:00.000Z", recordId: "r1" };
  assert.deepEqual(partRouting(part(["tax/invoice.py"], ["tax"], { reversal }), evidence([HOLDS]), protectedFor).reasons, [{ kind: "reversed", by: "rahul" }]);
  // A reversal of an older revision leaves the revision after it to the checks.
  assert.deepEqual(partRouting(part(["tax/invoice.py"], ["tax"], { reversal, revision: 2 }), evidence([HOLDS]), protectedFor).reasons, []);
});

test("the dashboard answer schema takes a part with its routing and refuses markup in a person id", () => {
  const routing = partRouting(part(["analytics/revenue_report.py"], ["analytics"]), evidence([], true), protectedFor);
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
    approvedBy: null,
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
  // A part Penguin approved names it as its approver; a routing reason outside the list is refused.
  assert.deepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, ask: "penguin_approved", state: "approved", approvedBy: "penguin", routing: { inPerson: false, reasons: [] } }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, routing: { inPerson: true, reasons: [{ kind: "trust_me" }] } }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, approvedBy: "<i>penguin</i>" }] }), []);
  // A review must carry its form's verdicts as one of the three and its run's commits as SHAs.
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [{ ...REVIEW, rows: [{ ...REVIEW.rows[0], verdict: "fine" }] }] }] }), []);
  assert.notDeepEqual(checkPlanInbox({ ...empty, parts: [{ ...item, reviews: [{ ...REVIEW, checkpoint: "main" }] }] }), []);
  const exception = { feature: "money-minor", scope: "tax", reviewId: 4, state: "accepted", exceptions: REVIEW.exceptions, review: REVIEW, read: false, raisedAt: "2026-10-11T09:00:00.000Z" };
  const returned = { feature: "money-minor", breakLimit: 10, inPerson: ["scope tax", "feature tax-exempt"], read: true, raisedAt: "2026-10-11T09:00:00.000Z" };
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
