import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPlanFactsReport, PLAN_LIMITS, placeLabel, planId, testNameWords } from "@penguin/protocol";

const result = {
  target: "tax-rounding",
  scopeId: "tax",
  commandId: "test:tax",
  status: "failed",
  merged: "a".repeat(40),
  fingerprint: null,
  breaks: [{ nodeId: "tax/tests/test_r.py::test_x", docstring: null, assertion: "assert 1 == 2", error: null }],
  reason: null,
  durationMs: 3,
};

test("a facts report holds only its fields, within their limits", () => {
  assert.deepEqual(checkPlanFactsReport({ impact: null, impactError: null, results: [result], durationMs: 4 }), []);
  const refused = [
    { impact: null, impactError: null, results: [result], durationMs: 4, log: "raw" },
    { impact: null, impactError: null, results: [{ ...result, commandId: "rm -rf /" }], durationMs: 4 },
    { impact: null, impactError: null, results: [{ ...result, target: "../main" }], durationMs: 4 },
    {
      impact: null,
      impactError: null,
      results: [{ ...result, breaks: [{ ...result.breaks[0], assertion: "x".repeat(PLAN_LIMITS.failureLineLength + 1) }] }],
      durationMs: 4,
    },
    { impact: { schemaVersion: 1 }, impactError: null, results: [], durationMs: 4 },
  ];
  for (const report of refused) assert.notDeepEqual(checkPlanFactsReport(report), [], JSON.stringify(report).slice(0, 200));
});

test("names: a plan's id, a place and a test's name in words", () => {
  assert.equal(planId("tax-rounding", 3), "tax-rounding/v3");
  assert.equal(placeLabel({ kind: "scope", scope: "tax" }), "scope tax");
  assert.equal(placeLabel({ kind: "feature", feature: "tax-rounding" }), "feature tax-rounding");
  assert.equal(testNameWords("a/test_x.py::TestGroup::test_fires_at_the_local_hour[1]"), "fires at the local hour");
});
