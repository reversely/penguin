// #198: a feature checkpoint's combined runs go to the running features that call what it modifies,
// read from the caller list (#195), not to every feature in a scope that depends on the changed one.
// Without the checkpoint's own list the scope dependencies pick them, as before the list.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import { CallerListStore } from "../../services/project-agent/src/caller-list.ts";
import { CombinedRunStore, scheduleCombinedRuns, triggerRepo } from "../../services/project-agent/src/combined-run-schedule.ts";
import { FeatureStore, type Feature, type FeatureRecord } from "../../services/project-agent/src/feature-store.ts";
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
    { id: "loyalty", name: "Loyalty", owner: "sam", paths: ["loyalty/"], test_command: "true", depends_on: [{ scope: "accounts", kind: "imports" }] },
  ],
});

const feature = (id: string, personId: string, scope: string, sha: string, paths: string[] = []): Feature => ({
  id,
  personId,
  repo: `penguin-feature-${id}`,
  area: { scopes: [scope], paths, contracts: [] },
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

function memory(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
}

function stores(): { callers: CallerListStore; runs: CombinedRunStore } {
  const sql = memory();
  const callers = new CallerListStore(sql);
  // Jun's fork calls the function the checkpoint modifies; Sam's calls nothing in accounts.
  callers.listed("cohort-ltv", SHA("d"), 1, ["accounts.shoppers.ShopperMap.resolve"]);
  callers.listed("reminders", SHA("e"), 2, ["messaging.send"]);
  return { callers, runs: new CombinedRunStore(sql) };
}

const schedule = ({ callers, runs }: ReturnType<typeof stores>, running: readonly Feature[] = features) =>
  scheduleCombinedRuns({ scopeMap, fork, base: main, latestCheckpoint: () => undefined, features: () => running, callers, runs }, "ana", CHECKPOINT, "accounts-merge");

// The trigger's own list: it modifies ShopperMap.resolve in accounts/shoppers.py.
const listTrigger = ({ callers }: ReturnType<typeof stores>) =>
  callers.listed("accounts-merge", CHECKPOINT, 9, [], ["accounts.shoppers", "accounts.shoppers.ShopperMap.resolve"]);

test("a checkpoint in a depended-on scope that changes a function one fork calls schedules one run", async () => {
  const both = stores();
  listTrigger(both);
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

// #200: the review findings in the caller list and checkpoint scheduling.
test("a feature checkpoint's Huddle reads its trigger from the feature's own fork", async () => {
  const both = stores();
  listTrigger(both);
  await schedule(both);
  const byId = { get: (id: string) => features.find((each) => each.id === id) };
  assert.equal(triggerRepo(both.runs, byId, { ownerId: "ana", sha: CHECKPOINT }, "penguin-owner-ana"), "penguin-feature-accounts-merge");
});

test("a feature whose list is older than its latest checkpoint is still picked by scope dependencies", async () => {
  const both = stores();
  // Jun's list was read at an older checkpoint that called nothing in accounts.
  both.callers.listed("cohort-ltv", SHA("9"), 4, ["messaging.send"]);
  listTrigger(both);
  const outcome = await schedule(both);
  assert.deepEqual(outcome.scheduled.map((run) => run.target), ["cohort-ltv"]);
});

test("a feature whose declared area folder holds a file the checkpoint changes is scheduled", async () => {
  const both = stores();
  listTrigger(both);
  const running = features.map((each) => (each.id === "reminders" ? feature("reminders", "sam", "messaging", SHA("e"), ["accounts"]) : each));
  const outcome = await schedule(both, running);
  assert.deepEqual(outcome.scheduled.map((run) => run.target), ["cohort-ltv", "reminders"]);
});

test("a reached feature with no list at its latest checkpoint keeps the dependent scopes its person owns", async () => {
  const both = stores();
  // Sam's older list calls the changed function; Sam also owns loyalty, which the feature does not touch.
  both.callers.listed("reminders", SHA("8"), 4, ["accounts.shoppers.ShopperMap.resolve"]);
  listTrigger(both);
  const outcome = await schedule(both);
  assert.deepEqual(outcome.scheduled.find((run) => run.target === "reminders")?.commandIds, ["test:loyalty", "test:messaging"]);
});

test("a feature that lands or stops has its caller list forgotten", () => {
  const sql = memory();
  const callers = new CallerListStore(sql);
  const store = new FeatureStore(sql, Date.now, () => undefined, (id) => callers.forget(id));
  for (const [id, to] of [["cohort-ltv", "landed"], ["reminders", "closed"], ["still-running", "landing"]] as const) {
    const record = { ...store.draftRecord(id, "open_feature", { person: "jun" }, {}), signature: "" } as FeatureRecord;
    store.insert(id, "jun", { scopes: [], paths: [], contracts: [] }, record);
    callers.listed(id, SHA("d"), 1, ["accounts.shoppers.ShopperMap.resolve"]);
    store.setState(id, ["opening"], to);
  }
  assert.deepEqual(callers.callersOf(["accounts.shoppers"]), ["still-running"]);
});
