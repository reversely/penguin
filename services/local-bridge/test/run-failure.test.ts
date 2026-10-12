// Each runner pass reports a run it stops on to Penguin with the reason (#120), which releases the run
// for any runner at once; a pass that succeeds sends no failure report. One case per claimed run
// kind: combined, review, tool, plan facts, fix write, block and part trial.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RunKind } from "@penguin/protocol";

import {
  blockPass,
  combinedRunPass,
  failureText,
  fixWritePass,
  formatBlockPass,
  partTrialPass,
  planFactsPass,
  reviewPass,
  toolPass,
  type FailRun,
} from "@penguin/local-bridge";

const SHA = "a".repeat(40);
const REASON = "fetch-pack: protocol error: bad band #78";

/** A `fail` that records each report and answers as Penguin does for a first failure. */
function recorder(): { readonly fail: FailRun; readonly sent: { kind: RunKind; runId: string; reason: string }[] } {
  const sent: { kind: RunKind; runId: string; reason: string }[] = [];
  const fail: FailRun = async (failure) => {
    sent.push({ ...failure });
    return { status: "released", kind: failure.kind, runId: failure.runId, failures: 1, limit: 3 };
  };
  return { fail, sent };
}

const broken = async (): Promise<never> => {
  throw new Error(REASON);
};

describe("a runner pass that stops on a run reports it", () => {
  test("combined: every run of the stopped batch", async () => {
    const { fail, sent } = recorder();
    const runs = ["jun", "sam"].map((owner) => ({
      runId: `run_${owner}`,
      trigger: { ownerId: "priya", sha: SHA, baselineSha: SHA },
      target: owner,
      fork: `owner-${owner}`,
      ownerId: owner,
      ownerCheckpoint: SHA,
      commandIds: ["test:analytics"],
    }));
    const result = await combinedRunPass({ claim: async () => runs as never, report: broken, fetchForks: broken, repoPath: "/nonexistent", runner: {} as never, fail });
    assert.deepEqual(sent, [
      { kind: "combined", runId: "run_jun", reason: REASON },
      { kind: "combined", runId: "run_sam", reason: REASON },
    ]);
    assert.deepEqual(result.batches[0]?.failures.map((each) => each.note?.status), ["released", "released"]);
  });

  test("review: the review whose fork did not fetch, and none when the review is reported", async () => {
    const { fail, sent } = recorder();
    const claim = { reviewId: 7, feature: "utc-day", scope: "analytics", fork: "feature-utc-day", base: SHA, forkSha: SHA, form: {} };
    const stopped = await reviewPass({ claim: async () => [claim] as never, report: broken, fetchFork: broken, review: broken, repoPath: "/nonexistent", fail });
    assert.deepEqual(sent, [{ kind: "review", runId: "7", reason: REASON }]);
    assert.equal(stopped.reviews[0]?.failure?.status, "released");
    assert.equal(sent.length, 1);
  });

  test("tool: the request whose forks did not fetch", async () => {
    const { fail, sent } = recorder();
    const claim = { runId: 12, tool: "check", feature: "utc-day", fork: "feature-utc-day", forks: [], base: SHA, checkpoint: SHA };
    const result = await toolPass({ claim: async () => [claim] as never, report: broken, fetchFork: broken, impact: broken, combined: {} as never, fixes: {} as never, repoPath: "/nonexistent", fail });
    assert.deepEqual(sent, [{ kind: "tool", runId: "12", reason: REASON }]);
    assert.equal(result.runs[0]?.failure?.status, "released");
  });

  test("plan facts: the listed run that did not run, and none for a run that reported", async () => {
    const { fail, sent } = recorder();
    const requests = [{ runId: "3", feature: "utc-day" }, { runId: "4", feature: "weekly" }];
    const result = await planFactsPass({
      list: async () => requests as never,
      fetch: async (request) => {
        if (request.runId === "3") throw new Error(REASON);
      },
      run: async () => ({}) as never,
      report: async () => ({ status: "recorded" }),
      fail,
    });
    assert.deepEqual(sent, [{ kind: "plan-facts", runId: "3", reason: REASON }]);
    assert.deepEqual(result.reported.map((each) => each.runId), ["4"]);
  });

  test("fix write: the write that did not push, and none for a write that reported", async () => {
    const { fail, sent } = recorder();
    const claims = [5, 6].map((writeId) => ({ spec: { writeId, partId: `utc-day/v1#${writeId}`, fork: "feature-weekly" }, token: "t" }));
    const result = await fixWritePass({
      claim: async () => claims as never,
      write: async ({ spec }) => {
        if (spec.writeId === 5) throw new Error(REASON);
        return { status: "written", commit: SHA, durationMs: 1 } as never;
      },
      report: async () => ({ status: "written", commit: SHA, recordId: "rec_1", durationMs: 1 }),
      fail,
    });
    assert.deepEqual(sent, [{ kind: "fix-write", runId: "5", reason: REASON }]);
    assert.deepEqual(result.writes.map((each) => [each.writeId, each.failure?.status ?? null]), [
      [5, "released"],
      [6, null],
    ]);
  });

  test("block: the run whose repos did not fetch", async () => {
    const { fail, sent } = recorder();
    const request = { runId: "utc-day/2", purpose: "land", fork: "feature-utc-day", main: SHA, checkpoint: SHA, targets: [] };
    const result = await blockPass({ claim: async () => [request] as never, report: broken, fetchRepo: broken, combined: {} as never, repoPath: "/nonexistent", fail });
    assert.deepEqual(sent, [{ kind: "block", runId: "utc-day/2", reason: REASON }]);
    assert.match(formatBlockPass(result), /Block run utc-day\/2 \(land\) stopped; Penguin released it for any runner \(failure 1 of 3\): fetch-pack/u);
  });

  test("part trial: the trial that did not run, and none for a trial that reported", async () => {
    const { fail, sent } = recorder();
    const requests = [8, 9].map((trialId) => ({ trialId, partId: "utc-day/v1#1", revision: trialId }));
    const result = await partTrialPass({
      claim: async () => requests as never,
      fetch: async (request) => {
        if (request.trialId === 8) throw new Error(REASON);
      },
      run: async () => ({ status: "conflict", reason: "the patch does not apply" }) as never,
      report: async () => ({ status: "recorded" }),
      fail,
    });
    assert.deepEqual(sent, [{ kind: "part-trial", runId: "8", reason: REASON }]);
    assert.deepEqual(result.reported.map((each) => each.trialId), [9]);
  });

  test("a failure report that cannot reach Penguin leaves the run to its lease", async () => {
    const claim = { reviewId: 7, feature: "utc-day", scope: "analytics", fork: "feature-utc-day", base: SHA, forkSha: SHA, form: {} };
    const result = await reviewPass({ claim: async () => [claim] as never, report: broken, fetchFork: broken, review: broken, repoPath: "/nonexistent", fail: broken });
    const failure = result.reviews[0]?.failure ?? null;
    assert.deepEqual(failure, { status: "unreported", error: REASON });
    assert.equal(failureText(failure), `it runs again after its lease (the failure was not reported: ${REASON})`);
    assert.equal(failureText({ status: "stopped", kind: "review", runId: "7", failures: 3, limit: 3, personId: "priya" }), "Penguin stopped it after 3 failures and routed it to priya");
  });
});
