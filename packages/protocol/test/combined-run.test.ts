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
