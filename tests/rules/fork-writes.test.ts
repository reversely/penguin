// PRD 0.5 section 4.4: writes into one running feature's fork take turns. One write holds the fork at
// a time, in approval order; a write waiting behind another is tried again on the head the other
// moved before it goes in. A failure on a fork whose plan fix is not yet written waits on that fix
// and opens no edit task for the fork's agent (#203).

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { LadderDecision, Plan } from "@penguin/protocol";

import { nextStepSources, unwrittenTargets, type EditWorkDeps } from "../../services/project-agent/src/edit-work.ts";
import { FixGrantStore } from "../../services/project-agent/src/fix-write.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";

function store(now = () => 1_000): FixGrantStore {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  return new FixGrantStore(sql, now);
}

test("the first approved write into a fork goes first; the second waits for it", () => {
  const grants = store();
  const first = grants.open("utc-day-start", "plan-1", { partId: "p1", revision: 1 }, "weekly-report", "agent");
  const second = grants.open("money-type", "plan-2", { partId: "p2", revision: 1 }, "weekly-report", "agent");
  assert.equal(grants.waitsFor(first), null);
  assert.match(grants.waitsFor(second) ?? "", /came first/);
});

test("a write holding the fork blocks every other write into that fork, and only that fork", () => {
  const grants = store();
  const holder = grants.open("utc-day-start", "plan-1", { partId: "p1", revision: 1 }, "weekly-report", "agent");
  grants.grant(holder.id, "a".repeat(40), false, "br-priya", 5_000);
  const behind = grants.open("money-type", "plan-2", { partId: "p2", revision: 1 }, "weekly-report", "agent");
  const elsewhere = grants.open("money-type", "plan-2", { partId: "p3", revision: 1 }, "reminders", "agent");
  assert.match(grants.waitsFor(behind) ?? "", /holds/);
  assert.equal(grants.waitsFor(elsewhere), null);
});

test("once the first write lands, the next waits until it is tried again on the moved head", () => {
  const grants = store();
  const first = grants.open("utc-day-start", "plan-1", { partId: "p1", revision: 1 }, "weekly-report", "agent");
  const second = grants.open("money-type", "plan-2", { partId: "p2", revision: 1 }, "weekly-report", "agent");
  grants.written(first.id, "b".repeat(40), "rec-1");
  grants.retrial(second.id, "b".repeat(40), 9);
  assert.match(grants.waitsFor(grants.byId(second.id)!) ?? "", /tried again/);
  grants.trialled(second.id, "b".repeat(40));
  assert.equal(grants.waitsFor(grants.byId(second.id)!), null);
});

test("an expired hold no longer blocks the fork", () => {
  let now = 1_000;
  const grants = store(() => now);
  const holder = grants.open("utc-day-start", "plan-1", { partId: "p1", revision: 1 }, "weekly-report", "runner");
  grants.grant(holder.id, "a".repeat(40), false, "runner-1", 2_000);
  const behind = grants.open("money-type", "plan-2", { partId: "p2", revision: 1 }, "weekly-report", "agent");
  now = 3_000;
  assert.doesNotMatch(grants.waitsFor(behind) ?? "", /holds/);
  assert.deepEqual(grants.claimable().map((grant) => grant.id), [holder.id], "the runner's expired claim can be taken again");
});

test("a failure on a fork whose plan fix is not written yet opens no edit task; once written, it does", async () => {
  const fix = { partId: "accounts-merge/v1#4", revision: 1, place: { kind: "feature", feature: "weekly-digest" }, kind: "behavioural" };
  const plan = { featureId: "accounts-merge", parts: [fix] } as unknown as Plan;
  let writes: { partId: string; revision: number }[] = [];
  const deps = {
    plan: () => plan,
    fix: { keeper: () => ({ fixWrites: () => writes }) },
    features: { get: () => ({ id: "weekly-digest", personId: "sam", state: "building", area: { scopes: ["messaging"] } }) },
  } as unknown as EditWorkDeps;
  const failed = {
    target: "weekly-digest",
    check: "tests",
    step: 5,
    nextStep: "The agent of the scope's owner adapts",
    reason: "messaging/tests/test_consent.py lies outside the charter",
    evidence: { summary: "1 failing test", findings: [{ path: "messaging/tests/test_consent.py", line: null, code: null, message: "fails: test_unsubscribe_survives" }] },
  } as unknown as LadderDecision;
  const run = { runId: "accounts-merge/1", checkpoint: "a".repeat(40) };
  assert.deepEqual(nextStepSources(deps, "accounts-merge", run, [failed], await unwrittenTargets(deps, "accounts-merge")), []);
  writes = [{ partId: fix.partId, revision: 1 }];
  assert.equal(nextStepSources(deps, "accounts-merge", run, [failed], await unwrittenTargets(deps, "accounts-merge")).length, 1);
});
