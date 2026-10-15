// PRD 0.5 section 4.3: Penguin approves a part when every check is clean; any other part goes to a
// person. Each test states one condition and checks the routing it produces. The last test checks
// which tree a part's tests and reviews run on: the trial of the originating fork's newest revision.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { needsPerson, partRouting, partWaitsOn, policyInForce, policyRoute, routesToOriginator, type PartEvidence, type Plan, type PlanPart } from "@penguin/protocol";

import { requestPenguinLand, type LandDeps } from "../../services/project-agent/src/block-land.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { PartTrialStore, queueTrials } from "../../services/project-agent/src/part-trial.ts";
import type { ReviewStore } from "../../services/project-agent/src/review-submit.ts";

const CHECKPOINT = "a".repeat(40);

type Part = Parameters<typeof partRouting>[0];

function part(overrides: Partial<Part> = {}): Part {
  return {
    scopes: ["analytics"],
    revision: 1,
    reversal: null,
    breaks: [],
    tests: { target: "jun-retention", runId: "run-1", fixInTree: true, results: [{ scopeId: "analytics", commandId: "test:analytics", status: "passed", breaks: 0 }] },
    diff: {
      source: "patch",
      repo: "feature-jun-retention",
      ref: "main",
      commit: null,
      base: CHECKPOINT,
      patch: "",
      files: [{ path: "analytics/retention.py", scopeId: "analytics", status: "modified", hunks: [], omitted: null }],
      truncated: false,
      outside: [],
    },
    ...overrides,
  } as Part;
}

function evidence(overrides: Partial<PartEvidence> = {}): PartEvidence {
  return {
    checkpoint: CHECKPOINT,
    adminMode: false,
    reviews: [{ reviewId: 1, scope: "analytics", forkSha: CHECKPOINT, state: "accepted", exceptions: [], notHolding: [] }],
    ...overrides,
  };
}

const noProtection = () => undefined;

test("a part whose tests pass, whose review holds and which stays in its place is approved by Penguin", () => {
  assert.deepEqual(partRouting(part(), evidence(), noProtection), { inPerson: false, reasons: [] });
});

test("a failing test on the trial tree sends the part to a person", () => {
  const failing = part({ tests: { target: "jun-retention", runId: "run-1", fixInTree: true, results: [{ scopeId: "analytics", commandId: "test:analytics", status: "failed", breaks: 2 }] } } as Partial<Part>);
  const routing = partRouting(failing, evidence(), noProtection);
  assert.equal(routing.inPerson, true);
  assert.ok(needsPerson(routing));
});

test("a test run that did not include the fix is not evidence: no approval", () => {
  const untried = part({ tests: { target: "jun-retention", runId: "run-1", fixInTree: false, results: [{ scopeId: "analytics", commandId: "test:analytics", status: "passed", breaks: 0 }] } } as Partial<Part>);
  assert.equal(partRouting(untried, evidence(), noProtection).inPerson, true);
});

test("a missing review is waited for, not counted against the break limit", () => {
  const routing = partRouting(part(), evidence({ reviews: [] }), noProtection);
  assert.equal(routing.inPerson, true);
  assert.equal(needsPerson(routing), false);
});

test("a review that reports a broken invariant goes to its author", () => {
  const reviews = [{ reviewId: 2, scope: "analytics", forkSha: CHECKPOINT, state: "accepted" as const, exceptions: [{ kind: "broken_invariant" as const, scope: "analytics", invariant: "tablet-separation" }], notHolding: ["tablet-separation"] }];
  const routing = partRouting(part(), evidence({ reviews }), noProtection);
  assert.ok(routing.reasons.some((reason) => reason.kind === "broken_invariant"));
  assert.ok(needsPerson(routing));
});

test("a review of an older checkpoint is stale and the part waits", () => {
  const reviews = [{ reviewId: 3, scope: "analytics", forkSha: "b".repeat(40), state: "accepted" as const, exceptions: [], notHolding: [] }];
  const routing = partRouting(part(), evidence({ reviews }), noProtection);
  assert.equal(routing.inPerson, true);
  assert.equal(needsPerson(routing), false);
});

test("a fix touching a protected path goes to that path's owner", () => {
  const routing = partRouting(part(), evidence(), () => ({ scope: "analytics", owner: "jun", path: "analytics/" }));
  assert.ok(routing.reasons.some((reason) => reason.kind === "protected_path"));
});

test("a fix that changes a file outside the part's scopes leaves its place", () => {
  const outside = part();
  const routing = partRouting({ ...outside, diff: { ...outside.diff, outside: ["shared/dates.py"] } }, evidence(), noProtection);
  assert.ok(routing.reasons.some((reason) => reason.kind === "outside_place"));
});

test("admin mode asks a person for every part", () => {
  assert.equal(partRouting(part(), evidence({ adminMode: true }), noProtection).inPerson, true);
});

test("an author's reversal of the current revision returns the part to them", () => {
  const routing = partRouting(part({ reversal: { by: "jun", revision: 1, at: "2026-10-12T00:00:00Z" } } as Partial<Part>), evidence(), noProtection);
  assert.ok(routing.reasons.some((reason) => reason.kind === "reversed"));
});

test("a verify part needs no review form: its tests decide it", () => {
  assert.equal(partRouting({ ...part(), kind: "verify" }, evidence({ reviews: [] }), noProtection).inPerson, false);
});

test("a reader of stored data the originating change reshapes goes to the originator when no backfill is declared", () => {
  const reviews = [{ reviewId: 4, scope: "analytics", forkSha: CHECKPOINT, state: "accepted" as const, exceptions: [], notHolding: [], readShapes: [{ symbol: "Profile", path: "ingestion/identity_map.py", scope: "ingestion" }] }];
  const unmarked = partRouting(part(), evidence({ reviews }), noProtection);
  assert.ok(routesToOriginator(unmarked));
  assert.equal(partRouting(part(), evidence({ reviews, storeMarked: true }), noProtection).inPerson, false);
});

test("a part that waits on the originating person for stored data names that person in the route and in a refused land (#202)", async () => {
  const reviews = [{ reviewId: 4, scope: "analytics", forkSha: CHECKPOINT, state: "accepted" as const, exceptions: [], notHolding: [], readShapes: [{ symbol: "Profile", path: "ingestion/identity_map.py", scope: "ingestion" }] }];
  const route = policyRoute(policyInForce(undefined, false), partRouting(part(), evidence({ reviews }), noProtection));
  assert.equal(route.rule, "originator");
  const pending = { ...part(), partId: "accounts-merge/v1#4", owner: "jun", approvalState: "pending" } as unknown as PlanPart;
  const plan = { featureId: "accounts-merge", planId: "accounts-merge/v1", person: "priya", proposedBy: "@priya/accounts-merge", parts: [pending] } as unknown as Plan;
  assert.equal(partWaitsOn(plan, pending, route), "priya", "the originating person, not the part's owner");

  const land = {
    features: { get: () => ({ id: "accounts-merge", personId: "priya", repo: "feature-accounts-merge", state: "building", latestCheckpointSha: CHECKPOINT }) },
    readRepo: async (_repo: string, use: (reader: never) => unknown) => use({ log: async () => [{ hash: "b".repeat(40) }] } as never),
    baseRepo: "base",
    branch: "main",
    agent: () => ({ latestPlan: async () => plan }),
    routeOf: async () => route,
  } as unknown as LandDeps;
  const refused = await requestPenguinLand(land, "accounts-merge", { handle: "@priya/steward", person: "priya", scopes: [], paths: [] });
  assert.equal(refused.status === "rejected" ? refused.reason : refused.status, "plan_not_approved");
  assert.match(refused.status === "rejected" ? refused.message : "", /accounts-merge\/v1#4 \(pending\), waits on priya: Stored data needs a migration or backfill in the originating change/u);
});

test("a part's trial runs on the originating fork's newest revision; the trial of the older revision no longer counts", () => {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  const deps = { trials: new PartTrialStore(sql, () => 1_000), reviews: { list: () => [] } as unknown as ReviewStore };
  const [baseline, revision, forkHead] = ["b", "c", "d"].map((char) => char.repeat(40)) as [string, string, string];
  const onMain = { ...part(), partId: "plan-1#1", place: { kind: "scope", scope: "analytics" }, kind: "behavioural" } as unknown as PlanPart;
  const inFork = { ...part(), partId: "plan-1#2", place: { kind: "feature", feature: "cohort-ltv" }, kind: "behavioural", diff: { ...part().diff, base: forkHead, patch: "diff" } } as unknown as PlanPart;
  const plan = (parts: readonly PlanPart[]) => ({ featureId: "accounts-merge", planId: "plan-1", parts, facts: { change: { checkpoint: CHECKPOINT, baseline } } }) as unknown as Plan;
  const commit = (sha: string) => ({ ...onMain.diff, source: "commit" as const, commit: sha, base: CHECKPOINT, patch: null });

  queueTrials(deps, plan([{ ...onMain, diff: commit("e".repeat(40)) }, inFork]));
  const stale = deps.trials.ofPart("accounts-merge", "plan-1#2");
  assert.equal(stale?.request.checkpoint, CHECKPOINT, "before any revision both trials merge the plan's checkpoint");

  // The originating agent revises the part for code on main with a newer commit of its own fork.
  const revised = plan([{ ...onMain, revision: 2, diff: commit(revision) }, inFork]);
  queueTrials(deps, revised, revised.parts.slice(0, 1));
  for (const partId of ["plan-1#1", "plan-1#2"]) {
    const current = deps.trials.ofPart("accounts-merge", partId);
    assert.equal(current?.request.checkpoint, revision, `${partId} is trialled on the revision`);
    assert.equal(current?.checkpoint, CHECKPOINT, "its forms are still those submitted on the plan's checkpoint");
  }
  assert.equal(deps.trials.get(stale!.id)?.state, "superseded");
});
