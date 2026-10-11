// The check runner's claim and result of agent tool requests (#102): the lease, the first report
// winning, a table from before the runner's columns, a fix result held to its request, and delivery to
// the requesting session once.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { boundToolResult, parseToolResult, TOOL_RESULT_LIMITS, type AgentToolResult, type ImpactReport } from "@penguin/protocol";

import { recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore, TOOL_RUN_LEASE_MS, type AgentToolRun } from "../src/agent-tools.ts";
import { sqlite } from "./issues-repo.ts";

const BASE = "a".repeat(40);
const CHECKPOINT = "b".repeat(40);
const FIXED = "c".repeat(40);
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const OTHER_RUNNER = { bridgeId: "br_spare", role: "runner" } as const;

function request(runs: AgentToolStore, tool: "impact" | "check" | "apply_fix", input: Record<string, unknown> = {}, sessionId = "ses_1"): AgentToolRun {
  return runs.insert({
    featureId: "utc-day-start",
    sessionId,
    caller: "@priya/batches",
    tool,
    input: { feature: "utc-day-start", ...input },
    result: "waiting",
    summary: `${tool} waits for the check runner`,
    checkpointSha: CHECKPOINT,
    durationMs: 1,
    identityId: "identity-1",
    baseSha: BASE,
  });
}

function result(tool: AgentToolResult["tool"], fields: Partial<AgentToolResult> = {}): AgentToolResult {
  return {
    schemaVersion: 1,
    tool,
    base: BASE,
    checkpoint: CHECKPOINT,
    result: "found",
    summary: "done",
    impact: null,
    checks: [],
    decisions: [],
    fix: null,
    fixRef: null,
    pushed: false,
    durationMs: 3,
    ...fields,
  };
}

const fixRun = (paths: string[]) => ({
  id: "apply_fix-1",
  tool: "apply_fix" as const,
  caller: "@priya/batches" as const,
  commandId: "fix:ruff-format",
  input: {},
  result: "changed" as const,
  summary: "format: changed 1 file",
  findings: [],
  changed: { before: CHECKPOINT, after: FIXED, paths },
  durationMs: 5,
});

describe("tool requests on the check runner", () => {
  test("a claimed request is handed out again only after its lease, and only to a runner", () => {
    let now = 1_000;
    const runs = new AgentToolStore(sqlite().sql, () => now);
    const run = request(runs, "check");
    runs.insert({ ...run, tool: "whats_near", result: "found", baseSha: null });
    assert.equal(runs.claim({ bridgeId: "br_jun", role: "owner" }).status, "forbidden");
    const first = runs.claim(RUNNER);
    assert.deepEqual(first.status === "ok" ? first.runs.map((claimed) => [claimed.id, claimed.claimedBy]) : [], [[run.id, "br_runner"]]);
    assert.deepEqual(runs.claim(OTHER_RUNNER), { status: "ok", runs: [] });
    now += TOOL_RUN_LEASE_MS;
    const again = runs.claim(OTHER_RUNNER);
    assert.deepEqual(again.status === "ok" ? again.runs.map((claimed) => claimed.claimedBy) : [], ["br_spare"]);
  });

  test("the first report wins, and the result reaches its session once", () => {
    const runs = new AgentToolStore(sqlite().sql);
    const run = request(runs, "check");
    request(runs, "impact", {}, "ses_other");
    assert.equal(recordToolResult(runs, RUNNER, run.id, result("check")).status, "recorded");
    const second = recordToolResult(runs, OTHER_RUNNER, run.id, result("check", { summary: "late" }));
    assert.equal(second.status === "rejected" ? second.reason : second.status, "conflict");
    assert.equal(runs.get(run.id)?.summary, "done");
    assert.deepEqual(runs.deliver("ses_1"), [{ runId: run.id, tool: "check", featureId: "utc-day-start", result: "found", summary: "done" }]);
    assert.deepEqual(runs.deliver("ses_1"), []);
    assert.deepEqual(runs.delivered("ses_1").map((delivered) => delivered.id), [run.id]);
    assert.deepEqual(runs.delivered("ses_other"), [], "a request still waiting is not delivered");
  });

  test("a result must be of the request's tool and commits, and a fix may change only the files it named", () => {
    const runs = new AgentToolStore(sqlite().sql);
    const check = request(runs, "check");
    const reason = (outcome: ReturnType<typeof recordToolResult>) => (outcome.status === "rejected" ? outcome.reason : outcome.status);
    assert.equal(reason(recordToolResult(runs, RUNNER, check.id, result("impact"))), "invalid");
    assert.equal(reason(recordToolResult(runs, RUNNER, check.id, result("check", { checkpoint: FIXED }))), "invalid");
    assert.equal(reason(recordToolResult(runs, { bridgeId: "br_jun", role: "owner" }, check.id, result("check"))), "forbidden");

    const fix = request(runs, "apply_fix", { kind: "format", paths: ["shared/dates.py"] });
    const outside = result("apply_fix", { result: "changed", fix: fixRun(["shared/dates.py", "analytics/weekly.py"]), fixRef: `refs/penguin/fixes/${FIXED}` });
    const refused = recordToolResult(runs, RUNNER, fix.id, outside);
    assert.match(refused.status === "rejected" ? refused.message : "", /changed analytics\/weekly\.py/);
    const pushed = { ...result("apply_fix", { result: "changed", fix: fixRun(["shared/dates.py"]) }), pushed: true };
    assert.equal(reason(recordToolResult(runs, RUNNER, fix.id, pushed)), "invalid");
    const kept = result("apply_fix", { result: "changed", fix: fixRun(["shared/dates.py"]), fixRef: `refs/penguin/fixes/${FIXED}` });
    assert.equal(recordToolResult(runs, RUNNER, fix.id, kept).status, "recorded");
    assert.equal(runs.get(fix.id)?.outcome?.fixRef, `refs/penguin/fixes/${FIXED}`);
  });

  test("a table from before the runner's columns gains them", () => {
    const db = sqlite().sql;
    db.exec(`CREATE TABLE AgentToolRun (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT, session_id TEXT NOT NULL, caller TEXT NOT NULL,
      tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, summary TEXT NOT NULL,
      checkpoint_sha TEXT, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    db.exec(
      `INSERT INTO AgentToolRun (feature_id, session_id, caller, tool, input, result, summary, checkpoint_sha, duration_ms, created_at)
       VALUES ('f', 's', '@p/a', 'check', '{}', 'waiting', 'old', ?, 1, 1)`,
      CHECKPOINT,
    );
    const runs = new AgentToolStore(db);
    const [old] = runs.list("f");
    assert.equal(old?.baseSha, null);
    // A request from before #102 has no baseline, so no runner can run it.
    assert.deepEqual(runs.claim(RUNNER), { status: "ok", runs: [] });
  });

  test("a result over the size limit drops its impact report and says so", () => {
    const impact = {
      schemaVersion: 1,
      tool: "python-impact",
      commandId: "analysis:python-impact",
      base: BASE,
      head: CHECKPOINT,
      changes: [],
      signatures: [],
      removedExports: [],
      dataShapes: [],
      contracts: [],
      headUses: [],
      forks: [],
      unanalysed: Array.from({ length: 2_000 }, (_, index) => `${"x".repeat(1_000)}/${index}.py`),
      errors: [],
      complete: false,
      truncated: false,
      files: { base: 0, head: 0, parsed: 0 },
    } as unknown as ImpactReport;
    const large = result("impact", { impact });
    assert.equal(parseToolResult(large).ok, false);
    const bounded = boundToolResult(large);
    assert.equal(bounded.impact, null);
    assert.match(bounded.summary, new RegExp(`over ${TOOL_RESULT_LIMITS.resultBytes} bytes`));
    assert.equal(parseToolResult(bounded).ok, true);
  });
});
