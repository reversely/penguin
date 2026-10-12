// The merge as a pipeline of stages (pipeline.ts), derived from the facts Penguin holds for each path:
// the stage each fact reaches, a failed job stopping the stages after it, a part needing a person, and
// the branches to other people that rejoin the bar once settled.

import assert from "node:assert/strict";
import { test } from "node:test";

import { featurePipeline, pipelineStrip, stageStatus, type BlockCheck, type PipelineFacts, type PipelineRecord } from "../src/index.ts";

const AT = "2026-10-12T09:00:00.000Z";
const record = (type: string, payload: Record<string, unknown> = {}, author = "@priya/merge-rules"): PipelineRecord => ({ type, author, at: AT, payload });

function facts(overrides: Partial<PipelineFacts> = {}): PipelineFacts {
  return {
    person: "priya",
    state: "building",
    records: [record("open_feature", {}, "priya")],
    factsRun: undefined,
    locks: [],
    expandLocks: [],
    parts: [],
    reviews: [],
    writes: new Map(),
    checks: null,
    checkRuns: [],
    protectedChanges: [],
    split: null,
    stopped: [],
    ...overrides,
  };
}

function check(check: string, target: string, result: BlockCheck["result"]): BlockCheck {
  return {
    planId: null,
    target,
    check: check as BlockCheck["check"],
    result,
    tool: { name: "test", version: null, commandId: `test:${target}` },
    input: { origin: "a".repeat(40), target: "b".repeat(40), merged: null, paths: null },
    findings: [],
    findingCount: 0,
    summary: "",
    fingerprint: null,
    logRef: null,
    durationMs: 1,
  };
}

const keys = (pipeline: ReturnType<typeof featurePipeline>) => pipeline.stages.map((stage) => `${stage.key}:${stage.status}`);

/** Identity unification as the preview leaves it: Sam approved both of Sam's parts, Jun's wait on Jun. */
function identityUnification(): PipelineFacts {
  return facts({
    records: [
      record("open_feature", {}, "priya"),
      record("checkpoint_area", { checkpoint: "c".repeat(40) }),
      record("propose_plan", { plan_id: "person-id-merge-rules/v1" }),
      record("approve_plan_part", { part_id: "p/v1#2", revision: 1, approved_by: "sam" }, "sam"),
      record("approve_plan_part", { part_id: "p/v1#4", revision: 1, approved_by: "sam" }, "sam"),
    ],
    factsRun: "reported",
    parts: [
      { partId: "p/v1#1", owner: "jun", place: { kind: "scope", scope: "analytics" }, scopes: ["analytics"], revision: 1, state: "pending" },
      { partId: "p/v1#2", owner: "sam", place: { kind: "scope", scope: "messaging" }, scopes: ["messaging"], revision: 1, state: "approved" },
      { partId: "p/v1#3", owner: "jun", place: { kind: "feature", feature: "retention-dashboard" }, scopes: ["analytics"], revision: 1, state: "pending" },
      { partId: "p/v1#4", owner: "sam", place: { kind: "feature", feature: "reengagement-audience" }, scopes: ["messaging"], revision: 1, state: "approved" },
    ],
    reviews: [
      { reviewId: 1, scope: "analytics", reviewer: "@jun/reports", state: "refused" },
      { reviewId: 2, scope: "messaging", reviewer: "@sam/campaigns", state: "refused" },
    ],
    checks: { checks: [check("tests", "retention-dashboard", "failed"), check("tests", "main", "passed"), check("lint", "main", "passed")], waiting: false, checkpoint: "c".repeat(40) },
    checkRuns: [{ checkpoint: "c".repeat(40), checks: [check("tests", "retention-dashboard", "failed"), check("lint", "main", "passed")] }],
  });
}

test("a feature with no plan waits at Plan, and its facts run runs there", () => {
  const opened = featurePipeline(facts());
  assert.equal(opened.path, "plan");
  assert.deepEqual(keys(opened), ["open:passed", "plan:waiting", "review:waiting", "fixes:waiting", "checks:waiting", "promoted:waiting"]);
  assert.equal(opened.current, 1);
  const asked = featurePipeline(facts({ factsRun: "pending" }));
  assert.equal(asked.stages[1]?.status, "running");
  assert.deepEqual(asked.stages[1]?.jobs.map((job) => job.fact.kind), ["facts"]);
});

test("an overlapping start needs its person at Open and branches to them until approved", () => {
  const waiting = featurePipeline(facts({ locks: [{ feature: "retention-dashboard", person: "jun", state: "open", approvedBy: null }] }));
  assert.equal(waiting.stages[0]?.status, "person");
  assert.equal(waiting.current, 0);
  assert.deepEqual(waiting.branches, [{ key: "start:retention-dashboard", stage: "open", person: "jun", agent: null, label: "needs a person", partId: null, settled: false }]);
  const approved = featurePipeline(facts({ locks: [{ feature: "retention-dashboard", person: "jun", state: "approved", approvedBy: "jun" }] }));
  assert.equal(approved.stages[0]?.status, "passed");
  assert.equal(approved.branches[0]?.settled, true);
  assert.equal(approved.branches[0]?.label, "approved");
});

test("identity unification sits in Review: a part with a submitted review needs a person, an approved part passes", () => {
  const pipeline = featurePipeline(identityUnification());
  assert.deepEqual(keys(pipeline).slice(0, 3), ["open:passed", "plan:passed", "review:person"]);
  assert.equal(pipeline.current, 2);
  const review = pipeline.stages[2]?.jobs ?? [];
  assert.deepEqual(
    review.map((job) => job.status),
    ["person", "passed", "person", "passed"],
  );
  const approved = review[1]?.fact;
  assert.ok(approved?.kind === "part");
  assert.equal(approved.approvedBy, "sam");
  assert.equal(approved.reviewer, "@sam/campaigns");
  // Fixes written: one job per fork, none written yet.
  assert.deepEqual(pipeline.stages[3]?.jobs.map((job) => [job.key, job.status]), [
    ["write:p/v1#3", "waiting"],
    ["write:p/v1#4", "waiting"],
  ]);
  // Block checks: one job per check kind with its targets.
  const checks = pipeline.stages[4]?.jobs.map((job) => job.fact);
  assert.deepEqual(checks, [
    { kind: "check", check: "tests", targets: 2, failed: 1, failing: ["retention-dashboard"], findings: [] },
    { kind: "check", check: "lint", targets: 1, failed: 0, failing: [], findings: [] },
  ]);
  // Jun's two parts branch from Review needing Jun; Sam's settled parts rejoin the bar at Fixes written.
  assert.deepEqual(
    pipeline.branches.map((branch) => [branch.partId, branch.stage, branch.person, branch.agent, branch.label, branch.settled]),
    [
      ["p/v1#1", "review", "jun", "@jun/reports", "needs a person", false],
      ["p/v1#2", "review", "sam", "@sam/campaigns", "approved", true],
      ["p/v1#3", "review", "jun", "@jun/reports", "needs a person", false],
      ["p/v1#4", "fixes", "sam", "@sam/campaigns", "approved", true],
    ],
  );
  // The agent's checkpoint shows with the checks run on it.
  assert.deepEqual(pipeline.activity, [{ agent: "@priya/merge-rules", checkpoint: "c".repeat(40), at: AT, checks: { total: 2, failed: 1 } }]);
});

test("a part sent with no review is waiting, a review the runner holds is running", () => {
  const base = identityUnification();
  const sent = featurePipeline({ ...base, reviews: [] });
  assert.equal(sent.stages[2]?.jobs[0]?.status, "waiting");
  assert.equal(sent.branches[0]?.label, "sent");
  assert.equal(sent.branches[0]?.agent, null);
  const reviewing = featurePipeline({ ...base, reviews: [{ reviewId: 3, scope: "analytics", reviewer: "@jun/reports", state: "pending" }] });
  assert.equal(reviewing.stages[2]?.jobs[0]?.status, "running");
  assert.equal(reviewing.branches[0]?.label, "reviewing");
});

test("a plan returned over the break limit fails Plan and stops every stage after it", () => {
  const pipeline = featurePipeline(
    facts({
      factsRun: "reported",
      records: [record("open_feature", {}, "ines"), record("plan_returned", { break_limit: 10, in_person: ["scope tax", "scope invoicing", "scope ledger"] }, "@ines/money")],
      checks: { checks: [check("tests", "main", "passed")], waiting: false, checkpoint: null },
    }),
  );
  assert.equal(pipeline.stages[1]?.status, "failed");
  assert.deepEqual(pipeline.stages[1]?.jobs.at(-1)?.fact, { kind: "plan", planId: null, parts: 0, returned: true, inPerson: 3 });
  // Block checks ran, but a failed stage stops the stages after it.
  assert.deepEqual(keys(pipeline).slice(2), ["review:waiting", "fixes:waiting", "checks:waiting", "promoted:waiting"]);
  assert.equal(pipeline.current, 1);
});

test("a failed block check fails its stage and leaves Promoted waiting", () => {
  const base = identityUnification();
  const parts = base.parts.map((part) => ({ ...part, state: "approved" as const }));
  const writes = new Map([
    ["p/v1#3", "written" as const],
    ["p/v1#4", "written" as const],
  ]);
  const pipeline = featurePipeline({ ...base, parts, writes });
  assert.deepEqual(keys(pipeline), ["open:passed", "plan:passed", "review:passed", "fixes:passed", "checks:failed", "promoted:waiting"]);
  assert.equal(pipeline.current, 4);
  // Every branch settled: approved scope parts and written fixes rejoin the bar.
  assert.ok(pipeline.branches.every((branch) => branch.settled));
  assert.deepEqual(
    pipeline.branches.filter((branch) => branch.stage === "fixes").map((branch) => branch.label),
    ["fix written", "fix written"],
  );
});

test("a land runs the block, a protected path waits for its person, and the promotion passes the last stage", () => {
  const base = identityUnification();
  const parts = base.parts.map((part) => ({ ...part, state: "approved" as const }));
  const writes = new Map([
    ["p/v1#3", "written" as const],
    ["p/v1#4", "written" as const],
  ]);
  const clean = { checks: [check("tests", "main", "passed")], waiting: false, checkpoint: null };
  const landing = featurePipeline({
    ...base,
    parts,
    writes,
    checks: clean,
    state: "landing",
    records: [...base.records, record("land_requested", { run_id: "r1" }, "priya")],
    protectedChanges: [{ owner: "jun", state: "pending" }],
  });
  assert.deepEqual(keys(landing).slice(4), ["checks:running", "promoted:person"]);
  assert.deepEqual(landing.branches.at(-1), { key: "protected:jun", stage: "promoted", person: "jun", agent: null, label: "needs a person", partId: null, settled: false });
  const landed = featurePipeline({
    ...base,
    parts,
    writes,
    checks: clean,
    state: "landed",
    records: [...base.records, record("land_requested", { run_id: "r1" }), record("block_checked", { run_id: "r1", passed: true }, "penguin"), record("promotion", { run_id: "r1", main_after: "d".repeat(40) }, "penguin")],
    protectedChanges: [{ owner: "jun", state: "confirmed" }],
  });
  assert.deepEqual(keys(landed).slice(4), ["checks:passed", "promoted:passed"]);
  assert.equal(landed.current, 5);
  assert.deepEqual(landed.stages[5]?.jobs.at(-1)?.fact, { kind: "promotion", state: "promoted", mainAfter: "d".repeat(40) });
});

test("a run the check runner stopped fails the stage it served and needs the feature's person", () => {
  const base = identityUnification();
  const parts = base.parts.map((part) => ({ ...part, state: "approved" as const }));
  const writes = new Map([
    ["p/v1#3", "written" as const],
    ["p/v1#4", "written" as const],
  ]);
  const stopped = [{ run: "block" as const, runId: "person-id-merge-rules/4", failures: 3, reason: "commit 0e252bbf is not in the fetched repos" }];
  const pipeline = featurePipeline({ ...base, parts, writes, checks: { checks: [check("tests", "main", "passed")], waiting: false, checkpoint: null }, stopped });
  assert.deepEqual(keys(pipeline).slice(4), ["checks:failed", "promoted:waiting"]);
  assert.deepEqual(pipeline.stages[4]?.jobs.at(-1), {
    key: "stopped:block:person-id-merge-rules/4",
    status: "failed",
    fact: { kind: "stopped", run: "block", runId: "person-id-merge-rules/4", failures: 3, reason: "commit 0e252bbf is not in the fetched repos" },
  });
  assert.deepEqual(pipeline.branches.at(-1), { key: "stopped:block:person-id-merge-rules/4", stage: "checks", person: "priya", agent: null, label: "needs a person", partId: null, settled: false });
  // A stopped plan facts run fails Plan, which holds every stage after it.
  const facts = featurePipeline({ ...base, stopped: [{ run: "plan-facts", runId: "7", failures: 3, reason: "fetch failed" }] });
  assert.equal(facts.stages[1]?.status, "failed");
  assert.equal(facts.current, 1);
});

test("a runner's claimed check run shows as a running job", () => {
  const pipeline = featurePipeline({ ...identityUnification(), checks: { checks: [], waiting: true, checkpoint: null } });
  assert.deepEqual(pipeline.stages[4]?.jobs.map((job) => [job.key, job.status]), [["check-run", "running"]]);
});

test("a split moves through Expand and Migrate with one job per owner group, and Contract waits for every group", () => {
  const records = [
    record("open_feature", {}, "ines"),
    record("expand_requested", { run_id: "x1", checkpoint: "e".repeat(40) }, "@ines/money"),
    record("expand_promotion", { run_id: "x1" }, "penguin"),
    record("retire_symbols", { plan_id: "money/v1", symbols: [{ contract: "shared/money.py::price" }, { contract: "shared/money.py::total" }] }, "@ines/money"),
    record("approve_plan_part", { part_id: "m/v1#1", revision: 1, approved_by: "penguin" }, "penguin"),
  ];
  const parts = [
    { partId: "m/v1#1", owner: "rahul", place: { kind: "scope", scope: "tax" } as const, scopes: ["tax"], revision: 1, state: "approved" as const },
    { partId: "m/v1#2", owner: "rahul", place: { kind: "scope", scope: "tax" } as const, scopes: ["tax"], revision: 1, state: "pending" as const },
    { partId: "m/v1#3", owner: "lena", place: { kind: "scope", scope: "invoicing" } as const, scopes: ["invoicing"], revision: 1, state: "approved" as const },
    { partId: "m/v1#4", owner: "mei", place: { kind: "feature", feature: "promo-codes" } as const, scopes: ["promotions"], revision: 1, state: "pending" as const },
  ];
  const pipeline = featurePipeline(
    facts({
      person: "ines",
      records,
      parts,
      reviews: [{ reviewId: 1, scope: "tax", reviewer: "@rahul/tax", state: "accepted" }],
      expandLocks: [{ feature: "owner:rahul", person: "rahul", state: "approved", approvedBy: "rahul" }],
    }),
  );
  assert.equal(pipeline.path, "split");
  assert.deepEqual(keys(pipeline), ["open:passed", "expand:passed", "migrate:person", "contract:waiting", "done:waiting"]);
  assert.equal(pipeline.current, 2);
  assert.deepEqual(
    pipeline.stages[2]?.jobs.map((job) => job.fact),
    [
      { kind: "group", owner: "rahul", parts: 2, approved: 1, partId: "m/v1#1" },
      { kind: "group", owner: "lena", parts: 1, approved: 1, partId: "m/v1#3" },
      { kind: "group", owner: "mei", parts: 1, approved: 0, partId: "m/v1#4" },
    ],
  );
  assert.deepEqual(pipeline.stages[3]?.jobs[0]?.fact, { kind: "contract", symbols: 2, state: "waiting" });
  assert.deepEqual(
    pipeline.branches.map((branch) => [branch.stage, branch.person, branch.label, branch.settled]),
    [
      ["expand", "rahul", "approved", true],
      ["migrate", "rahul", "needs a person", false],
      ["migrate", "lena", "approved", true],
      ["migrate", "mei", "sent", false],
    ],
  );
  const strip = pipelineStrip(pipeline);
  assert.deepEqual(strip.stages[2], { key: "migrate", status: "person", passed: 1, jobs: 3 });
});

test("a split Penguin recorded waits at Expand for its expand checkpoint, and a landed feature has passed every stage", () => {
  const split = { state: "expand_first" as const, entries: 3, promotion: null, retiring: 0 };
  const waiting = featurePipeline(facts({ person: "ines", split, records: [record("open_feature", {}, "ines"), record("contract_split", {}, "penguin")] }));
  assert.equal(waiting.path, "split");
  assert.deepEqual(keys(waiting), ["open:passed", "expand:waiting", "migrate:waiting", "contract:waiting", "done:waiting"]);
  assert.deepEqual(waiting.stages[1]?.jobs[0]?.fact, { kind: "expand", checkpoint: null, state: "waiting" });
  const promoted = featurePipeline(facts({ person: "ines", split: { ...split, state: "retiring", promotion: "d".repeat(40), retiring: 2 } }));
  assert.equal(promoted.stages[1]?.status, "passed");
  assert.deepEqual(promoted.stages[3]?.jobs[0]?.fact, { kind: "contract", symbols: 2, state: "waiting" });
  // The contract step runs once Penguin approves it and passes once the symbols are removed.
  const promotedSplit = { ...split, state: "retiring" as const, promotion: "d".repeat(40), retiring: 2 };
  const base = [record("open_feature", {}, "ines"), record("expand_promotion", { run_id: "x1" }, "penguin")];
  const proposed = featurePipeline(facts({ person: "ines", split: promotedSplit, records: [...base, record("contract_proposed", {}, "penguin")] }));
  assert.equal(proposed.stages[3]?.jobs[0]?.status, "running");
  const withdrawn = featurePipeline(facts({ person: "ines", split: promotedSplit, records: [...base, record("contract_proposed", {}, "penguin"), record("contract_withdrawn", {}, "penguin")] }));
  assert.equal(withdrawn.stages[3]?.jobs[0]?.status, "waiting");
  const removed = featurePipeline(facts({ person: "ines", split: promotedSplit, records: [...base, record("contract_proposed", {}, "penguin"), record("symbols_removed", {}, "penguin")] }));
  assert.equal(removed.stages[3]?.jobs[0]?.status, "passed");
  const landed = featurePipeline(facts({ person: "ines", split, state: "landed" }));
  assert.ok(landed.stages.every((stage) => stage.status === "passed"));
  assert.equal(landed.current, 4);
});

test("a stage's status: failed over a person over running, passed only when every job passed", () => {
  const job = (status: "waiting" | "running" | "passed" | "failed" | "person") => ({ key: status, status, fact: { kind: "check-run" } as const });
  assert.equal(stageStatus([job("passed"), job("failed"), job("person")]), "failed");
  assert.equal(stageStatus([job("passed"), job("person"), job("running")]), "person");
  assert.equal(stageStatus([job("passed"), job("waiting")]), "running");
  assert.equal(stageStatus([job("passed"), job("passed")]), "passed");
  assert.equal(stageStatus([]), "waiting");
});
