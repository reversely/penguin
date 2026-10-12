// The rules behind the dashboard's team view (dashboard-views.ts): each feature's one-word state, the
// exceptions it highlights and each person's role in the scope map.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import { featureExceptions, featureState, personRole, type FeatureStateFacts } from "../src/dashboard-views.ts";
import type { FeatureRecord } from "../src/feature-store.ts";
import type { StoredReview } from "../src/review-submit.ts";

const facts = (changes: Partial<FeatureStateFacts>): FeatureStateFacts => ({
  feature: { state: "building" },
  locks: [],
  parts: [],
  factsRun: undefined,
  lastPlanRecord: undefined,
  ...changes,
});

test("a feature's state is the latest step its facts show", () => {
  assert.equal(featureState(facts({})), "building");
  assert.equal(featureState(facts({ feature: { state: "opening" } })), "building");
  // Its agent asked for a plan: the facts run waits, or answered and no plan is stored yet.
  assert.equal(featureState(facts({ factsRun: "pending" })), "planning");
  assert.equal(featureState(facts({ factsRun: "reported" })), "planning");
  assert.equal(featureState(facts({ lastPlanRecord: "plan_returned" })), "planning");
  assert.equal(featureState(facts({ parts: [{ state: "change_requested" }, { state: "approved" }] })), "planning");
  // A start or a part waiting on a person.
  assert.equal(featureState(facts({ locks: [{ state: "open" }] })), "waiting on approvals");
  assert.equal(featureState(facts({ locks: [{ state: "approved" }] })), "building");
  assert.equal(featureState(facts({ factsRun: "reported", parts: [{ state: "pending" }, { state: "approved" }] })), "waiting on approvals");
  assert.equal(featureState(facts({ parts: [{ state: "round_limit" }] })), "waiting on approvals");
  // Every part approved: the block goes to its checks.
  assert.equal(featureState(facts({ parts: [{ state: "approved" }, { state: "approved" }] })), "promoting");
});

test("a feature highlights a part past the round limit, a returned plan and its newest reviews' exceptions", () => {
  const record = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload }) as unknown as FeatureRecord;
  const review = (id: number, scopeId: string, exceptions: StoredReview["exceptions"]) => ({ id, scopeId, exceptions }) as StoredReview;
  const parts = [
    { partId: "money/v1#1", state: "round_limit" },
    { partId: "money/v1#2", state: "pending" },
  ] as never;
  const broken = { kind: "broken_invariant" as const, invariant: "tax-per-line", scope: "tax" };
  assert.deepEqual(
    featureExceptions(parts, [review(1, "tax", [broken]), review(2, "analytics", [])], [record("plan_returned", { break_limit: 10, behavioural: ["scope tax", "scope payouts"] })]),
    [
      { kind: "round_limit", partId: "money/v1#1" },
      { kind: "plan_returned", behavioural: 2, breakLimit: 10 },
      broken,
    ],
  );
  // A plan proposed after the return replaces it, and a newer review of a scope replaces its older one.
  assert.deepEqual(featureExceptions([], [review(1, "tax", [broken]), review(3, "tax", [])], [record("plan_returned", { break_limit: 10, behavioural: [] }), record("propose_plan")]), []);
});

test("a person's role names their scopes, the other scopes that read them and the scopes theirs read", () => {
  const scopeMap = parseScopeMap({
    scopes: [
      { id: "money", name: "Money", owner: "ines", paths: ["shared/money/"], test_command: "true", depends_on: [] },
      { id: "tax", name: "Tax", owner: "rahul", paths: ["tax/"], test_command: "true", depends_on: [{ scope: "money", kind: "imports" }] },
      { id: "orders", name: "Orders", owner: "tomas", paths: ["orders/"], test_command: "true", depends_on: [{ scope: "money", kind: "imports" }] },
    ],
  });
  assert.deepEqual(personRole(scopeMap, "ines"), {
    scopes: [{ id: "money", name: "Money", ownerId: "ines" }],
    dependents: [
      { id: "orders", name: "Orders", ownerId: "tomas" },
      { id: "tax", name: "Tax", ownerId: "rahul" },
    ],
    dependencies: [],
  });
  assert.deepEqual(personRole(scopeMap, "rahul").dependencies, [{ id: "money", name: "Money", ownerId: "ines" }]);
  assert.deepEqual(personRole(scopeMap, "nobody"), { scopes: [], dependents: [], dependencies: [] });
});
