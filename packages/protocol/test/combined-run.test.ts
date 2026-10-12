import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCombinedRunEvent, validateOperation } from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

function attachCheck(payload: Record<string, unknown>) {
  return validateOperation({
    schema_version: 1,
    op_id: "penguin-web-0005",
    issue: 31,
    type: "attach_check",
    author: { penguin: true },
    base_version: 4,
    payload,
    signature: "A".repeat(86),
  });
}

test("a check names an allowlisted test:<scope> command and may carry its fingerprint", () => {
  const check = { command_id: "test:analytics", commit: `owner-priya@${sha("a")}`, test: "test_retention::dau_stable", result: "fail" };
  assert.ok(attachCheck(check).ok);
  assert.ok(attachCheck({ ...check, fingerprint: "1".repeat(64) }).ok);
  assert.equal(attachCheck({ ...check, fingerprint: "1".repeat(63) }).ok, false);
  assert.equal(attachCheck({ ...check, command_id: "test::analytics" }).ok, false);
  assert.equal(attachCheck({ ...check, command_id: "rm -rf" }).ok, false);
});

test("a combined-run result names its target, a feature id, and keeps the person for routing", () => {
  const result = {
    target: "weekly-report",
    ownerId: "jun",
    scopeId: "analytics",
    commandId: "test:analytics",
    status: "not-affected",
    ownerCheckpoint: sha("c"),
    fingerprint: null,
    failingTests: [],
  };
  const event = { trigger: { ownerId: "priya", sha: sha("a"), baselineSha: sha("b") }, changedScopes: [], unmapped: [], results: [result] };
  const parsed = parseCombinedRunEvent(event);
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.event.results[0]?.target, parsed.event.results[0]?.ownerId], ["weekly-report", "jun"]);
  // A runner from before #104 sends no target: the result is the person's owner fork.
  const { target: _target, ...untargeted } = result;
  const legacy = parseCombinedRunEvent({ ...event, results: [untargeted] });
  assert.ok(legacy.ok);
  assert.equal(legacy.event.results[0]?.target, "jun");
  for (const target of ["Weekly", "../x", "a".repeat(64), 7]) {
    assert.equal(parseCombinedRunEvent({ ...event, results: [{ ...result, target }] }).ok, false, String(target));
  }
});

test("a combined-run event is checked field by field", () => {
  const event = {
    trigger: { ownerId: "priya", sha: sha("a"), baselineSha: sha("b") },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [
      {
        ownerId: "jun",
        scopeId: "analytics",
        commandId: "test:analytics",
        status: "failed",
        ownerCheckpoint: sha("c"),
        fingerprint: { id: "1".repeat(64), commit: sha("e"), lockfileHash: "f".repeat(64), commandId: "test:analytics" },
        failingTests: [{ nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" }],
        log: "dropped",
      },
    ],
  };
  const parsed = parseCombinedRunEvent(event);
  assert.ok(parsed.ok);
  assert.equal("log" in (parsed.event.results[0] as object), false);

  const fields = (value: unknown) => {
    const result = parseCombinedRunEvent(value);
    return result.ok ? [] : result.issues.map((issue) => issue.field);
  };
  assert.deepEqual(fields(null), [""]);
  assert.deepEqual(fields({ ...event, trigger: { ownerId: "Priya", sha: "7c41e2", baselineSha: sha("b") } }), [
    "trigger.ownerId",
    "trigger.sha",
  ]);
  const [result] = event.results;
  assert.deepEqual(fields({ ...event, results: [{ ...result, fingerprint: null }] }), ["results[0]"]);
  assert.deepEqual(fields({ ...event, results: [{ ...result, status: "passed" }] }), ["results[0].failingTests"]);
  assert.deepEqual(fields({ ...event, results: [{ ...result, commandId: "python -m pytest" }] }), ["results[0].commandId"]);
  assert.deepEqual(fields({ ...event, unmapped: [""] }), ["unmapped[0]"]);
});

test("a not-affected result carries its checkpoint and no fingerprint, and checks are validated", () => {
  const notAffected = {
    ownerId: "sam",
    scopeId: "messaging",
    commandId: "test:messaging",
    status: "not-affected",
    ownerCheckpoint: sha("d"),
    fingerprint: null,
    failingTests: [],
  };
  const check = {
    planId: null,
    target: "sam",
    check: "typecheck",
    result: "not-affected",
    tool: { name: "pyright", version: "1.1.414", commandId: "check:pyright" },
    input: { origin: sha("a"), target: sha("d"), merged: sha("e"), paths: null },
    findings: [],
    findingCount: 0,
    summary: "the impact graph shows no use of the change",
    fingerprint: null,
    logRef: null,
    durationMs: 0,
  };
  const event = {
    trigger: { ownerId: "priya", sha: sha("a"), baselineSha: sha("b") },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [notAffected],
    checks: [check],
  };
  const parsed = parseCombinedRunEvent(event);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.event.checks, [check]);
  const withoutChecks = parseCombinedRunEvent({ ...event, checks: undefined });
  assert.equal(withoutChecks.ok && "checks" in withoutChecks.event, false);

  const fields = (value: unknown) => {
    const result = parseCombinedRunEvent(value);
    return result.ok ? [] : result.issues.map((issue) => issue.field);
  };
  assert.deepEqual(fields({ ...event, results: [{ ...notAffected, ownerCheckpoint: null }] }), ["results[0]"]);
  assert.deepEqual(fields({ ...event, checks: [{ ...check, check: "vibes" }] }), ["checks[0].check"]);
  assert.deepEqual(fields({ ...event, checks: [{ ...check, tool: { ...check.tool, commandId: "rm -rf /" } }] }), [
    "checks[0].tool.commandId",
  ]);
  assert.deepEqual(fields({ ...event, checks: [{ ...check, log: "raw output" }] }), ["checks[0].log"]);
  assert.deepEqual(fields({ ...event, checks: "all good" }), ["checks"]);
});
