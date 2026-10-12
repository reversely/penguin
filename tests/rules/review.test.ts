// PRD 0.5 section 6: the review form. Penguin refuses a form with a missing row, evidence that does
// not exist in the fork, or "unknown" without a test behind it.

import assert from "node:assert/strict";
import test from "node:test";

import { validateReviewForm, type ReviewForm } from "@penguin/protocol";

const invariants = [{ id: "tablet-separation", scopeId: "analytics", statement: "patrons on one tablet stay separate people", protected: true }];

const files = new Map<string, string | null>([
  ["analytics/tests/test_retention.py", "def test_tablet_patrons_stay_separate():\n    assert True\n"],
  ["analytics/retention.py", "def daily_active_users():\n    return 0\n"],
]);

function form(rows: ReviewForm["rows"]): ReviewForm {
  return { rows, riskyInputs: [], storedDataMarker: null } as unknown as ReviewForm;
}

const validate = (rows: ReviewForm["rows"]) => validateReviewForm({ form: form(rows), scope: "analytics", invariants, files, storedShapes: null } as Parameters<typeof validateReviewForm>[0]);
const codes = (result: ReturnType<typeof validateReviewForm>) => result.refusals.map((refusal) => refusal.code);

test("a row per invariant with evidence that exists is accepted", () => {
  const result = validate([{ invariant: "tablet-separation", verdict: "holds", evidence: ["analytics/tests/test_retention.py::test_tablet_patrons_stay_separate"], storedData: "none" }] as ReviewForm["rows"]);
  assert.equal(result.accepted, true);
});

test("a form without a row for a declared invariant is refused", () => {
  assert.ok(codes(validate([])).includes("missing_row"));
});

test("evidence naming a test that does not exist is refused", () => {
  const result = validate([{ invariant: "tablet-separation", verdict: "holds", evidence: ["analytics/tests/test_retention.py::test_missing"], storedData: "none" }] as ReviewForm["rows"]);
  assert.ok(codes(result).includes("evidence_not_found"));
});

test("unknown without a test behind it is refused", () => {
  const result = validate([{ invariant: "tablet-separation", verdict: "unknown", evidence: ["analytics/retention.py::daily_active_users"], storedData: "none" }] as ReviewForm["rows"]);
  assert.ok(codes(result).includes("unknown_without_test"));
});
