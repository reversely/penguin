// PRD 0.5 section 5.2: an agent's `check`, `impact` and `apply_fix` run on the check runner. Only the
// runner reports a result; the first report wins; a result must name the request's tool, baseline and
// checkpoint; and a fix may change only the paths the agent named.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { recordToolResult } from "../../services/project-agent/src/agent-tool-runner.ts";
import { AgentToolStore } from "../../services/project-agent/src/agent-tools.ts";
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
