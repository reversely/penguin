// A check runner that fails a claimed run frees it at once for any runner, and a run that keeps
// failing stops at the project's limit and goes to its feature's person with the reason
// (PRD 0.5 section 7: "The check runner fails one run past the project's failure limit").

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { reportRunFailure, RunFailureStore, type RunFailure } from "../../services/project-agent/src/run-failures.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";

function database(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
}

function deps(holder: string) {
  const stopped: RunFailure[] = [];
  return {
    stopped,
    deps: {
      failures: new RunFailureStore(database()),
      limit: 3,
      release: (_kind: string, _runId: string, runner: string) =>
        runner === holder
          ? { status: "released" as const, featureId: "utc-day-start", personId: "priya" }
          : { status: "rejected" as const, reason: "forbidden" as const, message: "another runner holds the claim" },
      stopped: (failure: RunFailure) => void stopped.push(failure),
    },
  };
}

const runner = { bridgeId: "runner-1", role: "runner" as const };
const failure = { kind: "block", runId: "block-7", reason: "fetch failed" };

test("a failure report frees the run at once and counts the failure", async () => {
  const { deps: d } = deps("runner-1");
  assert.deepEqual(await reportRunFailure(d, runner, failure), { status: "released", kind: "block", runId: "block-7", failures: 1, limit: 3 });
});

test("a runner cannot free a run another runner holds", async () => {
  const { deps: d } = deps("runner-2");
  assert.equal((await reportRunFailure(d, runner, failure)).status, "rejected");
});

test("a person's own bridge cannot report runner failures", async () => {
  const { deps: d } = deps("runner-1");
  assert.equal((await reportRunFailure(d, { bridgeId: "br-priya", role: "owner" }, failure)).status, "rejected");
});

test("at the limit the run stops and goes to its feature's person, once", async () => {
  const { deps: d, stopped } = deps("runner-1");
  await reportRunFailure(d, runner, failure);
  await reportRunFailure(d, runner, failure);
  const third = await reportRunFailure(d, runner, failure);
  assert.equal(third.status, "stopped");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.personId, "priya");
  assert.equal((await reportRunFailure(d, runner, failure)).status, "rejected", "a stopped run is not handed out again");
});
