// The runner's failure route (#120): POST /runs/failures takes a runner bridge's report of a run it
// failed and answers the ProjectAgent's outcome. The release, the count and the stop are tested in
// services/project-agent/test/run-failures.test.ts; here the route is checked for who may call it
// and how each answer maps to HTTP.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RunFailureOutcome } from "@penguin/protocol";

import type { BridgeDirectory, BridgeHandlers } from "../src/bridges.ts";
import { handleBridgeRoute } from "../src/bridges.ts";

function handlers(role: "owner" | "runner", answer: RunFailureOutcome) {
  const reports: { caller: unknown; body: unknown }[] = [];
  const directory = {
    authenticateBridge: async (token: string) => (token === "bridge-token" ? { bridgeId: "b1", ownerId: "runner", role } : undefined),
    reportRunFailure: async (caller: unknown, body: unknown) => {
      reports.push({ caller, body });
      return answer;
    },
  } as unknown as BridgeDirectory;
  return { handlers: { bridges: () => directory, projectRepos: { issues: "t-issues", base: "t-base" } } as unknown as BridgeHandlers, reports };
}

const post = (body: unknown, routeHandlers: BridgeHandlers, token = "bridge-token", method = "POST") => {
  const request = new Request("https://penguin.test/runs/failures", {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return handleBridgeRoute(request, new URL(request.url), { tokenTtlSeconds: 3_600 }, routeHandlers);
};

const FAILURE = { kind: "block", runId: "utc-day/2", reason: "fetch-pack: protocol error: bad band #78" };

describe("POST /runs/failures", () => {
  test("a runner's report reaches the ProjectAgent with its bridge and returns the release", async () => {
    const released: RunFailureOutcome = { status: "released", kind: "block", runId: "utc-day/2", failures: 1, limit: 3 };
    const { handlers: routeHandlers, reports } = handlers("runner", released);
    const response = await post(FAILURE, routeHandlers);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), released);
    assert.deepEqual(reports, [{ caller: { bridgeId: "b1", role: "runner" }, body: FAILURE }]);
  });

  test("an owner bridge, a missing token and a GET report nothing", async () => {
    const { handlers: owner, reports } = handlers("owner", { status: "released", kind: "block", runId: "utc-day/2", failures: 1, limit: 3 });
    assert.equal((await post(FAILURE, owner))?.status, 403);
    assert.equal((await post(FAILURE, owner, "wrong"))?.status, 401);
    const { handlers: runner, reports: runnerReports } = handlers("runner", { status: "released", kind: "block", runId: "utc-day/2", failures: 1, limit: 3 });
    assert.equal((await post(FAILURE, runner, "bridge-token", "GET"))?.status, 405);
    assert.deepEqual([...reports, ...runnerReports], []);
  });

  test("each refusal keeps its reason and its status", async () => {
    const statuses = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 } as const;
    for (const [reason, status] of Object.entries(statuses)) {
      const { handlers: routeHandlers } = handlers("runner", { status: "rejected", reason: reason as keyof typeof statuses, message: "refused" });
      const response = await post(FAILURE, routeHandlers);
      assert.equal(response?.status, status, reason);
      assert.deepEqual(await response?.json(), { error: reason, message: "refused" });
    }
  });
});
