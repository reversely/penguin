// PRD 0.5 section 5.2: an agent's `check`, `impact` and `apply_fix` run on the check runner. Only the
// runner reports a result; the first report wins; a result must name the request's tool, baseline and
// checkpoint; and a fix may change only the paths the agent named.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { recordToolResult } from "../../services/project-agent/src/agent-tool-runner.ts";
import { AgentToolStore } from "../../services/project-agent/src/agent-tools.ts";
import { CallerListStore, callsReported, requestCallerList } from "../../services/project-agent/src/caller-list.ts";
import type { Feature } from "../../services/project-agent/src/feature-store.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";

const BASE = "a".repeat(40);
const CHECKPOINT = "c".repeat(40);

function runs(): AgentToolStore {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  return new AgentToolStore(sql);
}

const request = (store: AgentToolStore) =>
  store.insert({ featureId: "utc-day-start", sessionId: "s1", caller: "@priya/utc-day-start", tool: "check", input: {}, result: "waiting", summary: "", checkpointSha: CHECKPOINT, durationMs: 0, baseSha: BASE });

const result = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  tool: "check",
  base: BASE,
  checkpoint: CHECKPOINT,
  result: "unchanged",
  summary: "every check passed",
  impact: null,
  checks: [],
  decisions: [],
  fix: null,
  fixRef: null,
  pushed: false,
  durationMs: 12,
  ...overrides,
});

const runner = { bridgeId: "runner-1", role: "runner" as const };

test("the runner's result is recorded against the request it answers", () => {
  const store = runs();
  const run = request(store);
  assert.equal(recordToolResult(store, runner, run.id, result()).status, "recorded");
});

test("a person's own bridge cannot report a tool result", () => {
  const store = runs();
  const run = request(store);
  assert.equal(recordToolResult(store, { bridgeId: "br-priya", role: "owner" }, run.id, result()).status, "rejected");
});

test("the first report wins; a second is refused", () => {
  const store = runs();
  const run = request(store);
  recordToolResult(store, runner, run.id, result());
  assert.equal(recordToolResult(store, runner, run.id, result({ summary: "again" })).status, "rejected");
});

test("a result for another checkpoint is refused", () => {
  const store = runs();
  const run = request(store);
  assert.equal(recordToolResult(store, runner, run.id, result({ checkpoint: "d".repeat(40) })).status, "rejected");
});

// #195: each checkpoint's caller list, kept so a later change finds the forks it reaches from the rows alone.
test("a checkpoint's caller list puts its feature among a name's callers, and a later checkpoint takes it out", () => {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
  const store = new AgentToolStore(sql);
  const lists = new CallerListStore(sql);
  const feature = { id: "cohort-ltv", repo: "feature-cohort-ltv" } as Feature;
  const report = (checkpoint: string, calls: readonly string[], unanalysed: readonly string[] = []) => {
    const runId = requestCallerList(store, feature, checkpoint, BASE) as number;
    const impact = {
      schemaVersion: 1,
      tool: "python-impact",
      commandId: "analysis:python-impact",
      base: BASE,
      head: checkpoint,
      changes: [],
      signatures: [],
      removedExports: [],
      dataShapes: [],
      contracts: [],
      headUses: [],
      forks: [{ id: feature.id, sha: checkpoint, scopes: [], since: BASE, mergeBase: BASE, carried: 0, uses: [], errors: [], calls }],
      unanalysed,
      errors: [],
      complete: unanalysed.length === 0,
      truncated: false,
      files: { base: 1, head: 1, parsed: 1 },
    };
    const recorded = recordToolResult(store, runner, runId, { ...result({ tool: "impact", checkpoint, result: "found", summary: "", impact }) });
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    if (recorded.status === "recorded") assert.equal(callsReported(lists, recorded.run), true);
  };
  report(CHECKPOINT, ["accounts.shoppers.Event", "accounts.shoppers.ShopperMap.resolve"]);
  assert.deepEqual(lists.callersOf(["accounts.shoppers.ShopperMap.resolve"]), ["cohort-ltv"]);
  assert.deepEqual(lists.callersOf(["accounts.shoppers"]), ["cohort-ltv"], "a changed module matches every use of its names");
  assert.deepEqual(lists.callersOf(["accounts.shopper"]), [], "a name never matches a longer name it only starts");
  report("d".repeat(40), ["accounts.shoppers.Event"]);
  assert.deepEqual(lists.callersOf(["accounts.shoppers.ShopperMap.resolve"]), []);
  // #196: a changed file other than Python reaches forks only by overlap, so the list stays complete.
  report("e".repeat(40), [], ["penguin/scopes.json"]);
  assert.equal(lists.listedAt("cohort-ltv")?.complete, true);
  report("f".repeat(40), [], ["accounts/broken.py"]);
  assert.equal(lists.listedAt("cohort-ltv")?.complete, false, "a Python file the analysis could not read may have callers");
});
