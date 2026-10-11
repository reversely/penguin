// The runner's side of a merge plan's facts (#89): the listing is checked before anything runs, the
// client lists and reports with the bridge token, and one failing run never stops another. The real
// analysis and test runs on a fixture are in tests/integration/plan-from-fixture.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkFactsRequest,
  fetchPlanFactsRuns,
  planFactsPass,
  RemoteRefusedError,
  reportPlanFacts,
  type Fetch,
} from "@penguin/local-bridge";
import type { PlanFactsReport, PlanFactsRequest } from "@penguin/protocol";

const SERVER = "https://penguin.example";
const SHA = "a".repeat(40);
const REQUEST: PlanFactsRequest = {
  runId: "4",
  feature: "money",
  fork: "feature-money",
  checkpoint: SHA,
  baseline: SHA,
  targets: [{ id: "main", repo: "feature-money", sha: SHA, scopes: [], commandIds: ["test:tax"] }],
};
const REPORT: PlanFactsReport = { impact: null, impactError: null, results: [], durationMs: 1 };

test("a listed run names only feature forks and full SHAs, or nothing runs", () => {
  checkFactsRequest(REQUEST);
  const bad: PlanFactsRequest[] = [
    { ...REQUEST, fork: "owner-jun" },
    { ...REQUEST, checkpoint: "HEAD" },
    { ...REQUEST, targets: [{ ...(REQUEST.targets[0] as PlanFactsRequest["targets"][number]), repo: "--upload-pack=x" }] },
    { ...REQUEST, targets: [{ ...(REQUEST.targets[0] as PlanFactsRequest["targets"][number]), sha: "main" }] },
  ];
  for (const request of bad) assert.throws(() => checkFactsRequest(request), JSON.stringify(request));
});

test("the client lists runs and reports one with the bridge token; a superseded run needs no retry", async () => {
  const requests: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    requests.push({
      url: href,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("Authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (href.endsWith("/plan-facts")) return Response.json({ runs: [REQUEST] });
    if (href.endsWith("/4")) return Response.json({ error: "superseded", message: "a newer checkpoint" }, { status: 409 });
    return Response.json({ error: "invalid", message: "bad" }, { status: 400 });
  }) as Fetch;
  assert.deepEqual(await fetchPlanFactsRuns(SERVER, "bridge-token", fetchStub), [REQUEST]);
  assert.deepEqual(await reportPlanFacts(SERVER, "bridge-token", "4", REPORT, fetchStub), { status: "superseded", message: "a newer checkpoint" });
  await assert.rejects(reportPlanFacts(SERVER, "bridge-token", "5", REPORT, fetchStub), RemoteRefusedError);
  assert.deepEqual(
    requests.map(({ url, method, auth }) => [url, method, auth]),
    [
      [`${SERVER}/plan-facts`, "GET", "Bearer bridge-token"],
      [`${SERVER}/plan-facts/4`, "POST", "Bearer bridge-token"],
      [`${SERVER}/plan-facts/5`, "POST", "Bearer bridge-token"],
    ],
  );
  assert.deepEqual(requests[1]?.body, REPORT);
});

test("a pass reports each run it could make and lists the ones it could not", async () => {
  const reported: string[] = [];
  const result = await planFactsPass({
    list: async () => [REQUEST, { ...REQUEST, runId: "5" }],
    fetch: async (request) => {
      if (request.runId === "4") throw new Error("the fork could not be fetched");
    },
    run: async () => REPORT,
    report: async (runId) => {
      reported.push(runId);
      return { status: "recorded" };
    },
  });
  assert.equal(result.listed, 2);
  assert.deepEqual(result.reported, [{ runId: "5", feature: "money", status: "recorded" }]);
  assert.deepEqual(result.failed, [{ runId: "4", error: "the fork could not be fetched" }]);
  assert.deepEqual(reported, ["5"]);
});
