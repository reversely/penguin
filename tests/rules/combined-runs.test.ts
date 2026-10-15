// #198: a feature checkpoint's combined runs go to the running features that call what it modifies,
// read from the caller list (#195), not to every feature in a scope that depends on the changed one.
// Without the checkpoint's own list the scope dependencies pick them, as before the list.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import { CallerListStore } from "../../services/project-agent/src/caller-list.ts";
import { CombinedRunStore, scheduleCombinedRuns } from "../../services/project-agent/src/combined-run-schedule.ts";
import type { Feature } from "../../services/project-agent/src/feature-store.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";

const SHA = (c: string) => c.repeat(40);
const BASE = SHA("b");
const CHECKPOINT = SHA("c");

// Ana's accounts scope; Jun's analytics and Sam's messaging both depend on it.
const scopeMap = parseScopeMap({
  scopes: [
    { id: "accounts", name: "Accounts", owner: "ana", paths: ["accounts/"], test_command: "true", depends_on: [] },
    { id: "analytics", name: "Analytics", owner: "jun", paths: ["analytics/"], test_command: "true", depends_on: [{ scope: "accounts", kind: "imports" }] },
    { id: "messaging", name: "Messaging", owner: "sam", paths: ["messaging/"], test_command: "true", depends_on: [{ scope: "accounts", kind: "imports" }] },
  ],
});

const feature = (id: string, personId: string, scope: string, sha: string): Feature => ({
  id,
  personId,
  repo: `feature-${id}`,
  area: { scopes: [scope], paths: [], contracts: [] },
  state: "building",
  openedAt: "2026-10-14T09:00:00.000Z",
  latestCheckpointSha: sha,
  updatedAt: "2026-10-14T09:00:00.000Z",
});
const features = [feature("accounts-merge", "ana", "accounts", CHECKPOINT), feature("cohort-ltv", "jun", "analytics", SHA("d")), feature("reminders", "sam", "messaging", SHA("e"))];

// The checkpoint changes accounts/shoppers.py against its baseline on main.
const trees: Record<string, { name: string; hash: string; type: string }[]> = {
  base: [{ name: "accounts", hash: "accounts-base", type: "tree" }],
  "accounts-base": [{ name: "shoppers.py", hash: "old", type: "blob" }],
  head: [{ name: "accounts", hash: "accounts-head", type: "tree" }],
  "accounts-head": [{ name: "shoppers.py", hash: "new", type: "blob" }],
};
const fork = {
  log: async () => [{ hash: CHECKPOINT, treeHash: "head" }, { hash: BASE, treeHash: "base" }],
  readTree: async (hash: string) => trees[hash] ?? null,
};
const main = { log: async () => [{ hash: BASE, treeHash: "base" }] };

function stores(): { callers: CallerListStore; runs: CombinedRunStore } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  const callers = new CallerListStore(sql);
  // Jun's fork calls the function the checkpoint modifies; Sam's calls nothing in accounts.
  callers.listed("cohort-ltv", SHA("d"), 1, ["accounts.shoppers.ShopperMap.resolve"]);
  callers.listed("reminders", SHA("e"), 2, ["messaging.send"]);
  return { callers, runs: new CombinedRunStore(sql) };
}

const schedule = ({ callers, runs }: ReturnType<typeof stores>) =>
  scheduleCombinedRuns({ scopeMap, fork, base: main, latestCheckpoint: () => undefined, features: () => features, callers, runs }, "ana", CHECKPOINT, "accounts-merge");

test("a checkpoint in a depended-on scope that changes a function one fork calls schedules one run", async () => {
  const both = stores();
  both.callers.listed("accounts-merge", CHECKPOINT, 3, [], ["accounts.shoppers", "accounts.shoppers.ShopperMap.resolve"]);
  const outcome = await schedule(both);
  assert.deepEqual(
    outcome.scheduled.map((run) => [run.target, run.commandIds]),
    [["cohort-ltv", ["test:analytics"]]],
  );
});

test("with no list of the checkpoint stored, every feature in a dependent scope is scheduled as before", async () => {
  const outcome = await schedule(stores());
  assert.equal(outcome.fromCallerList, false);
  assert.deepEqual(outcome.scheduled.map((run) => run.target), ["cohort-ltv", "reminders"]);
});
