// The rules behind the dashboard's team view (dashboard-views.ts): each feature's one-word state, the
// exceptions it highlights, each person's role in the scope map and who reads a plan part's patch.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import type { Plan } from "@penguin/protocol";

import { buildFeaturePlan, featureExceptions, featureState, pageFile, type FeatureStateFacts } from "../src/dashboard-views.ts";
import { personRole, roleIndex } from "../src/scope-edges.ts";
import type { RunFailure } from "../src/run-failures.ts";
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
  // Facts that show a place ask for a plan; facts that show none, or still wait, leave it building.
  assert.equal(featureState(facts({ factsRun: "reported", places: 2 })), "planning");
  assert.equal(featureState(facts({ factsRun: "reported", places: null })), "planning");
  assert.equal(featureState(facts({ factsRun: "reported", places: 0 })), "building");
  assert.equal(featureState(facts({ factsRun: "pending" })), "building");
  // With a plan stored, a new checkpoint's facts run waits for the runner while the plan is remade.
  assert.equal(featureState(facts({ factsRun: "pending", lastPlanRecord: "propose_plan" })), "planning");
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
  // A block Penguin closed with no part left to carry.
  assert.equal(featureState(facts({ feature: { state: "closed" } })), "closed");
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
  // A run the check runner stopped at the failure limit is an exception with its last reason.
  const stopped = { kind: "block", runId: "money/4", failures: 3, reason: "fetch-pack: protocol error: bad band #78" } as RunFailure;
  assert.deepEqual(featureExceptions([], [], [], [stopped]), [{ kind: "run_failed", run: "block", runId: "money/4", failures: 3, reason: "fetch-pack: protocol error: bad band #78" }]);
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
  // A scope that names only an owner reads as that owner's one-person team, with the owner as DRI.
  // Before any derivation each dependency is the declared one, with no call site counted.
  const ref = (id: string, name: string, owner: string, via: string[] = []) => ({
    id,
    name,
    ownerId: owner,
    teamId: `person:${owner}`,
    fallbackIds: [],
    calls: 0,
    uses: 0,
    derived: false,
    declared: true,
    via,
    updatedPromotion: null,
    updatedAt: null,
  });
  const index = roleIndex(scopeMap, { derivation: null, edges: [] });
  assert.deepEqual(personRole(index, "ines"), {
    scopes: [ref("money", "Money", "ines")],
    dependents: [ref("orders", "Orders", "tomas", ["money"]), ref("tax", "Tax", "rahul", ["money"])],
    dependencies: [],
    counts: { owns: 1, reads: 0, readBy: 2 },
    derivation: null,
  });
  assert.deepEqual(personRole(index, "rahul").dependencies, [ref("money", "Money", "ines", ["tax"])]);
  assert.deepEqual(personRole(index, "nobody"), { scopes: [], dependents: [], dependencies: [], counts: { owns: 0, reads: 0, readBy: 0 }, derivation: null });
});

test("the plan route sends a part's patch only to the feature's person, the part's owner and that owner's delegate", async () => {
  const file = { path: "tax/a.py", status: "modified", hunks: [{ lines: ["-round(x)", "+round_half_even(x)"] }] };
  const part = (partId: string, owner: string) => ({
    partId,
    owner,
    scopes: ["tax"],
    approvalState: "pending",
    diff: { source: "patch", repo: `feature-${owner}`, ref: "r", commit: null, base: "b", patch: "--- a/tax/a.py\n+++ b/tax/a.py\n", files: [file], truncated: false },
  });
  const plan = { planId: "money/v1", person: "ines", parts: [part("money/v1#1", "rahul"), part("money/v1#2", "tomas")] } as unknown as Plan;
  const deps = {
    features: { get: (id: string) => (id === "money" || id === "bare" ? ({ id } as Feature) : undefined) } as unknown as FeatureStore,
    delegates: async () => new Map([["rahul", "lee"]]),
    plan: async (id: string) => (id === "money" ? plan : undefined),
    scopeMap: async () => parseScopeMap({ scopes: [] }),
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

test("the feature page carries a file's diff up to the line limit and counts the lines it leaves for the plan route", () => {
  const hunk = (start: number, lines: string[]) => ({ oldStart: start, oldLines: lines.length, newStart: start, newLines: lines.length, lines });
  const file = {
    path: "analytics/models.py",
    scopeId: "analytics",
    status: "modified" as const,
    omitted: null,
    hunks: [hunk(1, [" a", "-b", "+c"]), hunk(20, ["+d", "+e", " f", "-g"]), hunk(40, ["+h"])],
  };
  const cut = pageFile(file, 5);
  // The first hunk whole, two lines of the second, none of the third.
  assert.deepEqual(cut.hunks.map((each) => each.lines), [[" a", "-b", "+c"], ["+d", "+e"]]);
  assert.equal(cut.omittedLines, 3);
  // The counts cover every line, shown or not.
  assert.deepEqual([cut.added, cut.removed], [4, 2]);
  const whole = pageFile(file, 80);
  assert.equal(whole.omittedLines, 0);
  assert.equal(whole.hunks[2], file.hunks[2]);
});
