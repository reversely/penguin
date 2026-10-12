// The rules behind the dashboard's team view (dashboard-views.ts): each feature's one-word state, the
// exceptions it highlights, each person's role in the scope map and who reads a plan part's patch.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import type { Plan } from "@penguin/protocol";

import { buildFeaturePlan, featureExceptions, featureState, personRole, type FeatureStateFacts } from "../src/dashboard-views.ts";
import type { Feature, FeatureRecord, FeatureStore } from "../src/feature-store.ts";
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
  // Its block run is checked or moving main, then main holds it.
  assert.equal(featureState(facts({ feature: { state: "landing" }, locks: [{ state: "open" }] })), "promoting");
  assert.equal(featureState(facts({ feature: { state: "landed" }, parts: [{ state: "approved" }] })), "promoted");
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
      { kind: "plan_returned", inPerson: 2, breakLimit: 10 },
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

test("the plan route sends a part's patch only to the feature's person, the part's owner and that owner's delegate", async () => {
  const file = { path: "tax/a.py", status: "modified", hunks: [{ lines: ["-round(x)", "+round_half_even(x)"] }] };
  const part = (partId: string, owner: string) => ({
    partId,
    owner,
    approvalState: "pending",
    diff: { source: "patch", repo: `feature-${owner}`, ref: "r", commit: null, base: "b", patch: "--- a/tax/a.py\n+++ b/tax/a.py\n", files: [file], truncated: false },
  });
  const plan = { planId: "money/v1", person: "ines", parts: [part("money/v1#1", "rahul"), part("money/v1#2", "tomas")] } as unknown as Plan;
  const deps = {
    features: { get: (id: string) => (id === "money" || id === "bare" ? ({ id } as Feature) : undefined) } as unknown as FeatureStore,
    delegates: async () => new Map([["rahul", "lee"]]),
    plan: async (id: string) => (id === "money" ? plan : undefined),
  };
  const readable = async (viewer: string) => {
    const seen = await buildFeaturePlan(deps, "money", viewer);
    assert.ok(seen !== undefined);
    // Everything but the patch and its changed lines reaches every viewer.
    const facts = (parts: readonly { partId: string; owner: string; approvalState: string }[]) => parts.map(({ partId, owner, approvalState }) => [partId, owner, approvalState]);
    assert.deepEqual(facts(seen.parts), facts(plan.parts));
    for (const shown of seen.parts) {
      if (shown.diff.files === null) assert.equal(shown.diff.patch, null, `${shown.partId} as ${viewer}`);
      else assert.deepEqual(shown.diff, plan.parts.find((each) => each.partId === shown.partId)?.diff);
    }
    return seen.parts.filter((shown) => shown.diff.files !== null).map((shown) => shown.partId);
  };
  assert.deepEqual(await readable("ines"), ["money/v1#1", "money/v1#2"], "the feature's person");
  assert.deepEqual(await readable("rahul"), ["money/v1#1"], "the part's owner");
  assert.deepEqual(await readable("lee"), ["money/v1#1"], "the owner's delegate");
  assert.deepEqual(await readable("tomas"), ["money/v1#2"], "the other part's owner");
  assert.deepEqual(await readable("sun"), [], "a signed-in person with no part");
  // The stored plan keeps every patch, and no feature or no plan answers undefined.
  assert.ok(plan.parts.every((each) => each.diff.patch !== null && each.diff.files.length === 1));
  assert.equal(await buildFeaturePlan(deps, "bare", "ines"), undefined);
  assert.equal(await buildFeaturePlan(deps, "ledger", "ines"), undefined);
});
