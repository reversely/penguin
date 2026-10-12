// PRD 0.5 section 4.3: Penguin approves a part when every check is clean; any other part goes to a
// person. Each test states one condition and checks the routing it produces.

import assert from "node:assert/strict";
import test from "node:test";

import { needsPerson, partRouting, routesToOriginator, type PartEvidence } from "@penguin/protocol";

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
