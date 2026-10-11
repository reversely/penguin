import assert from "node:assert/strict";
import { test } from "node:test";

import { huddleRepoName, parseVerificationReport, validateOperation } from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

function result(commandId: string, status: string, failingTests: unknown[] = []) {
  const fingerprint = { id: "1".repeat(64), commit: sha("a"), lockfileHash: "2".repeat(64), commandId };
  return { commandId, status, fingerprint, failingTests };
}

/** The fields a report is refused for, or none when it parses. */
function refused(value: unknown): string[] {
  const parsed = parseVerificationReport(value);
  return parsed.ok ? [] : parsed.issues.map((issue) => issue.field);
}

test("a tested report carries a revision and each command's result, checked field by field", () => {
  const report = {
    status: "tested",
    revision: sha("a"),
    results: [
      result("test:analytics", "failed", [{ nodeId: "a/test_x.py::test_y", testId: "test_x::y" }]),
      result("test:messaging", "passed"),
    ],
    log: "dropped",
  };
  const parsed = parseVerificationReport(report);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(JSON.stringify(parsed.report).includes("dropped"), false);

  assert.deepEqual(refused({ ...report, revision: "abc" }), ["revision"]);
  assert.deepEqual(refused({ ...report, results: [] }), ["results"]);
  assert.deepEqual(refused({ ...report, results: [result("rm -rf", "passed")] }), ["results[0].commandId", "results[0].fingerprint.commandId"]);
  assert.deepEqual(refused({ ...report, results: [result("test:a", "passed", [{ nodeId: "n", testId: "t" }])] }), [
    "results[0].failingTests",
  ]);
  assert.deepEqual(refused({ status: "flaky" }), ["status"]);
});

test("a conflict report names the checkpoint that did not merge and its paths", () => {
  const conflict = { status: "conflict", ownerId: "priya", sha: sha("b"), paths: ["identity/merge.py"] };
  assert.deepEqual(parseVerificationReport(conflict), { ok: true, report: conflict });
  assert.deepEqual(refused({ ...conflict, paths: [""] }), ["paths"]);
  assert.deepEqual(refused({ ...conflict, ownerId: "../x" }), ["ownerId"]);
});

test("a link may mark checks superseded by their op_ids", () => {
  const link = (payload: Record<string, unknown>) =>
    validateOperation({
      schema_version: 1,
      op_id: "penguin-web-0009",
      issue: 31,
      type: "link_commit",
      author: { penguin: true },
      base_version: 8,
      payload,
      signature: "A".repeat(86),
    }).ok;
  const commit = `owner-priya@${sha("c")}`;
  assert.ok(link({ commit, kind: "fix", supersedes: ["penguin-web-0005"] }));
  assert.equal(link({ commit, supersedes: [] }), false);
  assert.equal(link({ commit, supersedes: ["not an op id"] }), false);
  assert.equal(link({ commit, supersedes: ["penguin-web-0005", "penguin-web-0005"] }), false);
});

test("the Huddle repo of issue #31 is huddle-031", () => {
  assert.equal(huddleRepoName("31"), "huddle-031");
  assert.equal(huddleRepoName("1234"), "huddle-1234");
});
