// A runner's report that it failed a run it claimed (#120): the report releases the run at once for
// any runner, only the claiming runner may release it, a run whose runner dies still comes back at
// lease end, and the third failure stops the run and routes it to the feature's person. Each claimed
// run kind is covered: combined, review, tool, plan facts, fix write, block and part trial.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RUN_FAILURE_LIMIT_DEFAULT, RUN_KINDS, type PlanPart, type RunKind } from "@penguin/protocol";

import { AgentToolStore, TOOL_RUN_LEASE_MS } from "../src/agent-tools.ts";
import { BLOCK_RUN_LEASE_MS, BlockStore } from "../src/block-store.ts";
import { COMBINED_RUN_LEASE_MS, CombinedRunStore } from "../src/combined-run-schedule.ts";
import { FIX_WRITE_LEASE_MS, FixGrantStore } from "../src/fix-write.ts";
import type { SqlDatabase } from "../src/issue-index.ts";
import { PART_TRIAL_LEASE_MS, PartTrialStore } from "../src/part-trial.ts";
import { PlanFactsStore } from "../src/plan-facts.ts";
import { REVIEW_LEASE_MS, ReviewStore } from "../src/review-submit.ts";
import { releaseRun, reportRunFailure, RunFailureStore, type RunFailure, type RunStores } from "../src/run-failures.ts";
import { sqlite } from "./issues-repo.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const OTHER = { bridgeId: "br_spare", role: "runner" } as const;
const FEATURE = "utc-day";
const PERSON = "priya";

/** One kind's store with a run in it, and how a runner claims or lists that kind. */
interface Kind {
  readonly runId: string;
  /** The run ids a claim (or a listing) by `runnerId` hands out now. */
  claim(runnerId: string): string[];
  readonly leaseMs: number | null;
  readonly stores: Partial<Omit<RunStores, "personOf">>;
  /** What the ProjectAgent does to the run itself at the limit, besides routing it. */
  readonly stop?: (failure: RunFailure) => void;
  /** The run's own state, where the store keeps one beside the claim. */
  readonly state?: () => string | undefined;
}

function setUp(kind: RunKind, sql: SqlDatabase, now: () => number): Kind {
  switch (kind) {
    case "combined": {
      const store = new CombinedRunStore(sql, { now });
      const run = store.schedule({ trigger: { ownerId: PERSON, sha: SHA, baselineSha: BASE }, ownerId: "jun", ownerCheckpoint: BASE, commandIds: ["test:analytics"] });
      const claim = (runnerId: string) => {
        const listing = store.claim({ bridgeId: runnerId, role: "runner" });
        return listing.status === "ok" ? listing.runs.map((each) => each.runId) : [];
      };
      return { runId: run?.runId as string, claim, leaseMs: COMBINED_RUN_LEASE_MS, stores: { combined: store } };
    }
    case "review": {
      const store = new ReviewStore(sql, now);
      const review = store.insert({
        featureId: FEATURE,
        scopeId: "analytics",
        ownerId: "jun",
        reviewer: "@jun/reports",
        sessionId: "s-jun",
        forkSha: SHA,
        baseSha: BASE,
        form: { rows: [], riskyInputs: [], storedDataMarker: null },
        invariants: [],
        state: "pending",
        refusals: [],
      });
      const claim = (runnerId: string) => {
        const listing = store.claim({ bridgeId: runnerId, role: "runner" });
        return listing.status === "ok" ? listing.reviews.map((each) => String(each.id)) : [];
      };
      return { runId: String(review.id), claim, leaseMs: REVIEW_LEASE_MS, stores: { reviews: store } };
    }
    case "tool": {
      const store = new AgentToolStore(sql, now);
      const run = store.insert({
        featureId: FEATURE,
        sessionId: "s-priya",
        caller: "@priya/batches",
        tool: "check",
        input: { feature: FEATURE },
        result: "waiting",
        summary: "check waits for the check runner",
        checkpointSha: SHA,
        durationMs: 1,
        identityId: "identity-1",
        baseSha: BASE,
      });
      const claim = (runnerId: string) => {
        const listing = store.claim({ bridgeId: runnerId, role: "runner" });
        return listing.status === "ok" ? listing.runs.map((each) => String(each.id)) : [];
      };
      return { runId: String(run.id), claim, leaseMs: TOOL_RUN_LEASE_MS, stores: { tools: store } };
    }
    case "plan-facts": {
      // A facts run is listed to every runner and never claimed, so it has no lease to wait out.
      const store = new PlanFactsStore(sql, now);
      const run = store.schedule({ feature: FEATURE, fork: `feature-${FEATURE}`, checkpoint: SHA, baseline: BASE, targets: [] });
      return { runId: run.runId, claim: () => store.pending().map((each) => each.runId), leaseMs: null, stores: { planFacts: store } };
    }
    case "fix-write": {
      const store = new FixGrantStore(sql, now);
      const grant = store.open(FEATURE, `${FEATURE}/v1`, { partId: `${FEATURE}/v1#1`, revision: 1 } as PlanPart, "weekly-report", "runner");
      // claimRunnerWrites prepares each claimable write and grants it to the runner for the lease.
      const claim = (runnerId: string) =>
        store.claimable().map((each) => {
          store.grant(each.id, BASE, false, runnerId, now() + FIX_WRITE_LEASE_MS);
          return String(each.id);
        });
      return { runId: String(grant.id), claim, leaseMs: FIX_WRITE_LEASE_MS + 1, stores: { fixGrants: store } };
    }
    case "part-trial": {
      const store = new PartTrialStore(sql, now);
      const trial = store.queue(
        {
          feature: FEATURE,
          planId: `${FEATURE}/v1`,
          partId: `${FEATURE}/v1#1`,
          revision: 1,
          fork: `feature-${FEATURE}`,
          checkpoint: SHA,
          target: { id: "main", repo: "base", sha: BASE },
          fix: { kind: "patch", patch: "" },
          commandIds: ["test:analytics"],
          reviews: [],
        },
        ["analytics"],
      );
      const claim = (runnerId: string) => {
        const listing = store.claim({ bridgeId: runnerId, role: "runner" });
        return listing.status === "ok" ? listing.trials.map((each) => String(each.id)) : [];
      };
      return { runId: String(trial.id), claim, leaseMs: PART_TRIAL_LEASE_MS, stores: { trials: store } };
    }
    case "block": {
      const store = new BlockStore(sql, now);
      const opened = store.open({
        featureId: FEATURE,
        planId: null,
        purpose: "land",
        fork: `feature-${FEATURE}`,
        checkpoint: SHA,
        mainBefore: BASE,
        branch: "main",
        targets: [],
        charter: { handle: "@priya/batches", person: PERSON, scopes: [], paths: [] },
        requestedBy: PERSON,
      });
      assert.equal(opened.status, "opened");
      const runId = opened.run.runId;
      const claim = (runnerId: string) => store.claim(runnerId).map((each) => each.runId);
      return {
        runId,
        claim,
        leaseMs: BLOCK_RUN_LEASE_MS + 1,
        stores: { block: (_feature, id, runnerId) => store.release(id, runnerId) },
        // The FeatureAgent fails the run (stopBlockRun), so the feature's land goes back to building.
        stop: (failure) => void store.stop(failure.runId, failure.reason),
        state: () => {
          const found = store.get(runId);
          return found === undefined ? undefined : `${found.state}: ${found.outcome}`;
        },
      };
    }
  }
}

function project(kind: RunKind) {
  let clock = 1_000;
  const now = () => clock;
  const { sql } = sqlite();
  const failures = new RunFailureStore(sql, now);
  const fixture = setUp(kind, sql, now);
  const stopped: RunFailure[] = [];
  const unused = () => {
    throw new Error("another kind's store");
  };
  const stores: RunStores = {
    combined: { release: unused },
    reviews: { release: unused },
    tools: { release: unused },
    planFacts: { release: unused },
    fixGrants: { release: unused },
    trials: { release: unused },
    block: unused,
    personOf: (featureId) => (featureId === FEATURE ? PERSON : undefined),
    ...fixture.stores,
  };
  const deps = {
    failures,
    limit: RUN_FAILURE_LIMIT_DEFAULT,
    release: (k: RunKind, runId: string, runnerId: string) => releaseRun(stores, k, runId, runnerId),
    stopped: (failure: RunFailure) => {
      fixture.stop?.(failure);
      stopped.push(failure);
    },
  };
  const fail = (caller: typeof RUNNER | typeof OTHER, reason = "fetch-pack: protocol error: bad band #78") =>
    reportRunFailure(deps, caller, { kind, runId: fixture.runId, reason });
  return { ...fixture, failures, stopped, fail, advance: (ms: number) => void (clock += ms) };
}

for (const kind of RUN_KINDS) {
  describe(`a failed ${kind} run`, () => {
    test("is released at once for any runner, and only by the runner that claimed it", async () => {
      const run = project(kind);
      assert.deepEqual(run.claim(RUNNER.bridgeId), [run.runId]);
      if (run.leaseMs !== null) assert.deepEqual(run.claim(OTHER.bridgeId), [], "the claim holds until its lease ends");

      if (kind !== "plan-facts") {
        const foreign = await run.fail(OTHER);
        assert.equal(foreign.status === "rejected" ? foreign.reason : foreign.status, "forbidden", "another runner cannot release the claim");
        assert.deepEqual(run.claim(OTHER.bridgeId), []);
      }
      const owner = await run.fail({ bridgeId: "br_jun", role: "owner" } as never);
      assert.equal(owner.status === "rejected" ? owner.reason : owner.status, "forbidden", "an owner bridge reports nothing");

      const released = await run.fail(RUNNER);
      assert.deepEqual(released, { status: "released", kind, runId: run.runId, failures: 1, limit: 3 });
      assert.deepEqual(run.claim(OTHER.bridgeId), [run.runId], "the retry goes to any runner without waiting for the lease");
      assert.equal(run.failures.get(kind, run.runId)?.reason, "fetch-pack: protocol error: bad band #78");
    });

    test("stops after the third failure and goes to the feature's person with the reason", async () => {
      const run = project(kind);
      for (const attempt of [1, 2, 3]) {
        assert.deepEqual(run.claim(RUNNER.bridgeId), [run.runId], `attempt ${attempt} is handed out`);
        const outcome = await run.fail(RUNNER, `the fetch failed on attempt ${attempt}`);
        assert.equal(outcome.status, attempt < 3 ? "released" : "stopped");
      }
      assert.deepEqual(run.claim(RUNNER.bridgeId), [], "a stopped run is not handed out again");
      if (run.leaseMs !== null) {
        run.advance(run.leaseMs);
        assert.deepEqual(run.claim(OTHER.bridgeId), [], "nor after its lease");
      }
      assert.deepEqual(
        run.stopped.map((each) => [each.kind, each.runId, each.failures, each.personId, each.reason]),
        [[kind, run.runId, 3, PERSON, "the fetch failed on attempt 3"]],
      );
      if (run.state !== undefined) assert.equal(run.state(), "failed: the fetch failed on attempt 3");
      const again = await run.fail(RUNNER);
      assert.equal(again.status === "rejected" ? again.reason : again.status, "conflict");
      if (kind !== "combined") assert.deepEqual(run.failures.stopped(FEATURE).map((each) => each.runId), [run.runId]);
    });

    if (kind !== "plan-facts") {
      test("whose runner dies without reporting comes back at lease end, as before", () => {
        const run = project(kind);
        assert.deepEqual(run.claim(RUNNER.bridgeId), [run.runId]);
        run.advance(run.leaseMs as number);
        assert.deepEqual(run.claim(OTHER.bridgeId), [run.runId]);
      });
    }
  });
}

describe("a failure report", () => {
  test("names a known kind, a run id and a reason, and a long reason is cut", async () => {
    const run = project("review");
    const deps = {
      failures: run.failures,
      limit: 3,
      release: () => ({ status: "released" as const, featureId: FEATURE, personId: PERSON }),
      stopped: () => {},
    };
    for (const body of [null, { kind: "lint", runId: "1", reason: "x" }, { kind: "review", runId: "../1", reason: "x" }, { kind: "review", runId: "1", reason: " " }, { kind: "review", runId: "1", reason: "x", token: "t" }]) {
      const outcome = await reportRunFailure(deps, RUNNER, body);
      assert.equal(outcome.status === "rejected" ? outcome.reason : outcome.status, "invalid", JSON.stringify(body));
    }
    await reportRunFailure(deps, RUNNER, { kind: "review", runId: "7", reason: "x".repeat(1_000) });
    assert.equal(run.failures.get("review", "7")?.reason.length, 300);
    const misconfigured = await reportRunFailure({ ...deps, limit: undefined }, RUNNER, { kind: "review", runId: "7", reason: "x" });
    assert.equal(misconfigured.status === "rejected" ? misconfigured.reason : misconfigured.status, "conflict");
  });
});
