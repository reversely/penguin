// The Worker's half of edit tasks (#128, PRD 0.5 section 4.4a): a bridge claims its own person's
// tasks, each with a write token minted for that task on its fork alone, for PENGUIN_EDIT_RUN_MINUTES.
// The ProjectAgent's routing, cap and queue are tested in services/project-agent/test/edit-tasks.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EditTaskSpec } from "@penguin/protocol";

import type { BridgeDirectory, BridgeHandlers } from "../src/bridges.ts";
import { handleBridgeRoute } from "../src/bridges.ts";
import type { MintedToken, TokenScope } from "../src/tokens.ts";

const SPEC: EditTaskSpec = {
  taskId: 7,
  kind: "next_step",
  handle: "@jun/weekly-report",
  person: "jun",
  feature: "utc-day",
  fork: "feature-weekly-report",
  branch: "main",
  paths: ["analytics/weekly.py"],
  scopes: ["analytics"],
  allowed: ["analytics", "analytics/weekly.py"],
  instructions: "The tests check failed.",
  verifier: "The block check.",
  evidence: [],
  leaseUntil: "2026-10-12T10:20:00.000Z",
  fixWrite: null,
};

function bridgeHandlers() {
  const mints: { repo: string; scope: TokenScope; ttl: number }[] = [];
  const claims: unknown[] = [];
  const reports: unknown[] = [];
  const directory = {
    authenticateBridge: async (token: string) => (token === "bridge-token" ? { bridgeId: "b-jun", ownerId: "jun", role: "owner" } : undefined),
    claimEditTasks: async (caller: unknown) => {
      claims.push(caller);
      return { status: "ok", tasks: [SPEC], queue: { running: 1, queued: 2, asked: 0, cap: 2 } };
    },
    reportEditTask: async (caller: unknown, taskId: number, body: unknown) => {
      reports.push({ caller, taskId, body });
      return taskId === SPEC.taskId
        ? { status: "ok", task: { id: taskId, state: "done", askReason: null, commit: "e".repeat(40) } }
        : { status: "rejected", reason: "forbidden", message: "not claimed by this bridge" };
    },
  } as unknown as BridgeDirectory;
  const handlers = {
    bridges: () => directory,
    mintToken: async (repo: string, scope: TokenScope, ttl: number): Promise<MintedToken> => {
      mints.push({ repo, scope, ttl });
      return { token: `art_${mints.length}`, remote: `https://artifacts.test/${repo}.git`, scope, expiresAt: "2026-10-12T10:20:00Z" };
    },
    projectRepos: { issues: "t-issues", base: "t-base" },
  } as unknown as BridgeHandlers;
  return { mints, claims, reports, handlers };
}

const post = (path: string, body: unknown, token = "bridge-token") => new Request(`https://penguin.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe("POST /edit-tasks/claim", () => {
  test("hands a bridge its person's tasks, each with a token on its fork alone, and the queue", async () => {
    const { mints, claims, handlers } = bridgeHandlers();
    const request = post("/edit-tasks/claim", { person: "sam" });
    const response = await handleBridgeRoute(request, new URL(request.url), { tokenTtlSeconds: 3_600, editTokenTtlSeconds: 1_200 }, handlers);
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("Cache-Control"), "no-store");
    // The person comes from the bridge token, never from the body.
    assert.deepEqual(claims, [{ bridgeId: "b-jun", ownerId: "jun" }]);
    assert.deepEqual(mints, [{ repo: "feature-weekly-report", scope: "write", ttl: 1_200 }]);
    const body = (await response?.json()) as { tasks: Record<string, unknown>[]; queue: Record<string, number> };
    assert.deepEqual([body.tasks[0]?.["taskId"], body.tasks[0]?.["fork"], (body.tasks[0]?.["token"] as { token: string }).token], [7, "feature-weekly-report", "art_1"]);
    assert.deepEqual(body.queue, { running: 1, queued: 2, asked: 0, cap: 2 });
  });

  test("an unknown bridge gets nothing, and a misconfigured run window mints nothing", async () => {
    const { mints, claims, handlers } = bridgeHandlers();
    const unknown = post("/edit-tasks/claim", {}, "other");
    assert.equal((await handleBridgeRoute(unknown, new URL(unknown.url), { tokenTtlSeconds: 3_600, editTokenTtlSeconds: 1_200 }, handlers))?.status, 401);
    const request = post("/edit-tasks/claim", {});
    assert.equal((await handleBridgeRoute(request, new URL(request.url), { tokenTtlSeconds: 3_600 }, handlers))?.status, 500);
    assert.deepEqual([mints, claims], [[], []]);
  });
});

describe("POST /edit-tasks/<id>", () => {
  test("passes the claiming bridge's report on and answers the task's new state", async () => {
    const { reports, handlers } = bridgeHandlers();
    const body = { status: "done", outcome: "claude -p changed 1 file", commit: "e".repeat(40) };
    const request = post("/edit-tasks/7", body);
    const response = await handleBridgeRoute(request, new URL(request.url), { tokenTtlSeconds: 3_600 }, handlers);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { status: "recorded", taskId: 7, state: "done", askReason: null, commit: "e".repeat(40) });
    assert.deepEqual(reports, [{ caller: { bridgeId: "b-jun", ownerId: "jun" }, taskId: 7, body }]);
    const other = post("/edit-tasks/8", body);
    assert.equal((await handleBridgeRoute(other, new URL(other.url), { tokenTtlSeconds: 3_600 }, handlers))?.status, 403);
  });
});
