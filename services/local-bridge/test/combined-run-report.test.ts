import assert from "node:assert/strict";
import { test } from "node:test";

import {
  combinedRunEvent,
  RemoteRefusedError,
  RemoteUnavailableError,
  reportCombinedRun,
  type CombinedRunReport,
} from "@penguin/local-bridge";
import { parseCombinedRunEvent } from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

const REPORT: CombinedRunReport = {
  checkpointSha: sha("a"),
  baselineSha: sha("b"),
  changedScopes: ["identity-map"],
  unmapped: ["scripts/backfill.py"],
  results: [
    {
      ownerId: "jun",
      scopeId: "analytics",
      commandId: "test:analytics",
      status: "failed",
      ownerCheckpoint: sha("c"),
      mergedTree: sha("d"),
      mergedCommit: sha("e"),
      fingerprint: { commit: sha("e"), lockfileHash: "f".repeat(64), commandId: "test:analytics", id: "1".repeat(64) },
      exitCode: 1,
      signal: null,
      failingTests: [{ nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" }],
      log: "FAILED analytics/tests/test_retention.py::test_dau_stable - assert 1 == 2",
      durationMs: 0,
    },
    { ownerId: "sam", scopeId: "messaging", commandId: "test:messaging", status: "conflict", ownerCheckpoint: sha("9"), conflictedPaths: ["x"] },
    { ownerId: "lee", scopeId: "billing", commandId: "test:billing", status: "no-checkpoint" },
  ],
};

test("the combined-run event keeps the failing tests and fingerprints and drops the logs", () => {
  const event = combinedRunEvent(REPORT, "priya");
  assert.deepEqual(event.trigger, { ownerId: "priya", sha: sha("a"), baselineSha: sha("b") });
  assert.equal(JSON.stringify(event).includes("assert 1 == 2"), false);
  assert.deepEqual(
    event.results.map((result) => [result.scopeId, result.status, result.ownerCheckpoint, result.fingerprint?.id ?? null]),
    [
      ["analytics", "failed", sha("c"), "1".repeat(64)],
      ["messaging", "conflict", sha("9"), null],
      ["billing", "no-checkpoint", null, null],
    ],
  );
  const parsed = parseCombinedRunEvent(JSON.parse(JSON.stringify(event)));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.event, event);
});

test("reporting a combined run posts the event with the bridge token and reads Penguin's answer", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let status = 201;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json({ status: "opened", issueId: "31", huddleRepo: "huddle-031", message: "why" }, { status });
  }) as typeof fetch;
  const event = combinedRunEvent(REPORT, "priya");

  assert.deepEqual(await reportCombinedRun("https://penguin.example/", "token-1", event, fetchStub), {
    status: "opened",
    issueId: "31",
    huddleRepo: "huddle-031",
    message: "why",
  });
  assert.equal(requests[0]?.url, "https://penguin.example/combined-runs");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(requests[0]?.init?.headers, { Authorization: "Bearer token-1", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), event);

  status = 422;
  await assert.rejects(reportCombinedRun("https://penguin.example", "token-1", event, fetchStub), RemoteRefusedError);
  status = 502;
  await assert.rejects(reportCombinedRun("https://penguin.example", "token-1", event, fetchStub), RemoteUnavailableError);
});
