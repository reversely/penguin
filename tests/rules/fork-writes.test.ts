// PRD 0.5 section 4.4: writes into one running feature's fork take turns. One write holds the fork at
// a time, in approval order; a write waiting behind another is tried again on the head the other
// moved before it goes in.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
