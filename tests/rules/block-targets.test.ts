// #196: a land checks the change on main and only on the running forks it reaches: the features that
// call what it modifies, by the caller lists (caller-list.ts), and those that change the same files.
// A change no fork reaches is checked on main alone and promotes in one push. When the lists cannot
// answer, every running fork is a target, so nothing is missed.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BlockQueueStore, reportBlockRun, requestLand, type BlockProjectPort, type LandDeps } from "../../services/project-agent/src/block-land.ts";
import { BlockStore } from "../../services/project-agent/src/block-store.ts";
import { CallerListStore } from "../../services/project-agent/src/caller-list.ts";
import { FeatureStore, signFeatureRecord } from "../../services/project-agent/src/feature-store.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";

const SHA = (digit: string) => digit.repeat(40);
const MAIN = SHA("a");
const RUNNER = { bridgeId: "runner-1", role: "runner" as const };

/**
 * Priya's `shopper-map` is ready to land on main. Jun's running `cohort-ltv` calls
 * `accounts.shoppers.ShopperMap.resolve`; Lena's running `weekly-report` calls only report code. Each
 * feature's area holds the one file its checkpoint changed.
 */
async function world(landing: { readonly path: string }) {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  const features = new FeatureStore(sql);
  const sign = (draft: Parameters<typeof signFeatureRecord>[0]) => signFeatureRecord(draft, keys.privateKey);
  const forks: Record<string, { person: string; checkpoint: string; path: string }> = {
    "shopper-map": { person: "priya", checkpoint: SHA("c"), path: landing.path },
    "cohort-ltv": { person: "jun", checkpoint: SHA("d"), path: "analytics/cohort.py" },
    "weekly-report": { person: "lena", checkpoint: SHA("e"), path: "reports/weekly.py" },
  };
  for (const [id, fork] of Object.entries(forks)) {
    features.insert(id, fork.person, { scopes: [], paths: [], contracts: [] }, await sign(features.draftRecord(id, "open_feature", { person: fork.person }, {})));
    features.setRepo(id, `feature-${id}`);
    features.setArea(id, { scopes: [], paths: [fork.path], contracts: [] }, await sign(features.draftRecord(id, "checkpoint_area", { penguin: true }, {})), fork.checkpoint);
  }
  features.join("shopper-map", "session-1");
  const lists = new CallerListStore(sql);
  lists.listed("cohort-ltv", SHA("d"), 1, ["accounts.shoppers.ShopperMap.resolve"]);
  lists.listed("weekly-report", SHA("e"), 2, ["reports.money.total"]);
  const blocks = new BlockStore(sql);
  const land: LandDeps = {
    features,
    heartbeat: (_caller, sessionId) => ({ status: "ok", session: { id: sessionId, handle: "@priya/shopper-map" } }) as never,
    charter: () => ({ handle: "@priya/shopper-map", person: "priya", scopes: [], paths: [] }),
    agent: () => ({ latestPlan: async () => undefined, fixWrites: async () => [], openBlockRun: (input) => blocks.open(input), claimBlockRuns: () => ({ runs: [], waiting: false }) }),
    // Main is one commit; each checkpoint sits on it, and each fork's head is its checkpoint.
    readRepo: async (repo, use) =>
      use({
        log: async () => [{ hash: repo === "base" ? MAIN : (forks[repo.replace(/^feature-/u, "")]?.checkpoint as string) }],
        readCommit: async (hash: string) => ({ parents: hash === MAIN ? [] : [MAIN] }),
      } as never),
    baseRepo: "base",
    branch: "main",
    queue: new BlockQueueStore(sql),
    callerLists: lists,
    sign,
    notify: () => {},
  };
  return { features, lists, blocks, land, landNow: () => requestLand(land, "priya", "session-1", { feature: "shopper-map" }) };
}

const targetsOf = (outcome: Awaited<ReturnType<typeof requestLand>>) => (outcome.status === "checking" ? outcome.run.request.targets.map((target) => target.feature) : outcome);

test("a land of a change one running fork calls opens a block run with that one target", async () => {
  const w = await world({ path: "accounts/shoppers.py" });
  w.lists.listed("shopper-map", SHA("c"), 3, [], ["accounts.shoppers", "accounts.shoppers.ShopperMap.resolve"]);
  assert.deepEqual(targetsOf(await w.landNow()), ["cohort-ltv"]);
});

test("a land of a change no running fork calls opens a block run with no targets, checked on main alone, and promotes in one push", async () => {
  const w = await world({ path: "accounts/export.py" });
  w.lists.listed("shopper-map", SHA("c"), 3, [], ["accounts.export", "accounts.export.to_csv"]);
  const asked = await w.landNow();
  assert.deepEqual(targetsOf(asked), []);
  const requested = w.features.records("shopper-map").map((stored) => JSON.parse(stored.file) as { type: string; payload: Record<string, unknown> }).find((record) => record.type === "land_requested");
  assert.deepEqual(requested?.payload["reach"], { kind: "none", why: "no running feature calls what the change modifies or changes the same files" });

  const [run] = w.blocks.claim(RUNNER.bridgeId);
  const check = (name: "merge" | "tests") => ({
    planId: null,
    target: "main",
    check: name,
    result: "passed",
    tool: { name: name === "merge" ? "git merge-tree" : "pytest", version: null, commandId: name === "merge" ? "git:merge-tree" : "test:accounts" },
    input: { origin: SHA("c"), target: MAIN, merged: SHA("f"), paths: null },
    findings: [],
    findingCount: 0,
    summary: "passed",
    fingerprint: null,
    logRef: null,
    durationMs: 1,
  });
  let pushes = 0;
  const port = {
    signBlockRecord: async (_feature: string, type: string) => type,
    acquirePromotion: async () => true,
    releasePromotion: async () => {},
    featureLanded: async () => {},
    landFailed: async () => assert.fail("the land does not fail"),
  } as unknown as BlockProjectPort;
  const reported = await reportBlockRun(
    {
      store: w.blocks,
      fixWrites: () => [],
      port,
      push: async () => ((pushes += 1), { status: "pushed", packBytes: 1, durationMs: 1 }),
      seal: async () => 0,
    },
    RUNNER,
    run?.runId as string,
    { schemaVersion: 1, runId: run?.runId, checkpoint: SHA("c"), main: MAIN, checks: [check("merge"), check("tests")], decisions: [], summary: "main passed", durationMs: 2 },
  );
  assert.equal(reported.status === "recorded" ? reported.state : reported.message, "promoted");
  assert.equal(pushes, 1);
});

test("a land whose own checkpoint has no caller list yet targets every running fork", async () => {
  const w = await world({ path: "accounts/shoppers.py" });
  assert.deepEqual(targetsOf(await w.landNow()), ["cohort-ltv", "weekly-report"]);
});

test("a land whose fork head cannot be read fails naming the fork and logs the read, never checking fewer forks", async (t) => {
  const w = await world({ path: "accounts/shoppers.py" });
  const logged = t.mock.method(console, "error", () => {});
  const land: LandDeps = {
    ...w.land,
    readRepo: (repo, use) => (repo === "feature-weekly-report" ? Promise.reject(new Error("internal error; reference = x")) : w.land.readRepo(repo, use)),
  };
  await assert.rejects(requestLand(land, "priya", "session-1", { feature: "shopper-map" }), /could not read the head of 1 of 2 forks: feature-weekly-report \(Error: internal error; reference = x\)/u);
  assert.deepEqual(
    logged.mock.calls.map((call) => JSON.parse(call.arguments[0] as string)),
    [{ event: "fork_read_failed", call: "log main", repo: "feature-weekly-report", error: "Error: internal error; reference = x" }],
  );
});
