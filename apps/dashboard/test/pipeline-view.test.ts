// How the dashboard words and lays out a feature's pipeline (pipeline-view.ts), its diffs
// (diff-view.ts) and its page's summary and folds (page-view.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EditTaskView, FeaturePipeline, JobFact, PipelineBranch, PipelineStage } from "@penguin/protocol";

import { hunkHeader, hunkRows, lineCounts } from "../src/diff-view.ts";
import { foldParents, initialFolds, readByRows, recordKinds, summaryLines, viewOf } from "../src/page-view.ts";
import { branchGroups, branchRows, currentStageText, groupCount, jobText, partAnchor, queueCounts, settledAt, stageCount, taskStage, taskText, taskVia } from "../src/pipeline-view.ts";

const branch = (key: string, stage: PipelineBranch["stage"], settled = false): PipelineBranch => ({
  key,
  stage,
  person: key,
  agent: null,
  label: settled ? "approved" : "needs a person",
  partId: null,
  settled,
});

const stages = (...keys: PipelineStage["key"][]): PipelineStage[] => keys.map((key) => ({ key, status: "waiting", jobs: [] }));

test("every job reads as a bare label and one clause with no comma", () => {
  const facts: JobFact[] = [
    { kind: "start", feature: "retention-dashboard", person: "jun", by: null },
    { kind: "start", feature: "owner:rahul", person: "rahul", by: "rahul" },
    { kind: "facts", state: "pending" },
    { kind: "plan", planId: null, parts: 0, returned: true, inPerson: 31 },
    { kind: "plan", planId: "person-id-merge-rules/v1", parts: 4, returned: false, inPerson: 0 },
    { kind: "part", partId: "p/v1#1", place: { kind: "scope", scope: "analytics" }, owner: "jun", state: "pending", approvedBy: null, review: "refused", reviewer: "@jun/reports" },
    { kind: "part", partId: "p/v1#2", place: { kind: "scope", scope: "messaging" }, owner: "sam", state: "approved", approvedBy: "penguin", review: "accepted", reviewer: null },
    { kind: "part", partId: "p/v1#3", place: { kind: "feature", feature: "retention-dashboard" }, owner: "jun", state: "pending", approvedBy: null, review: "accepted", reviewer: null },
    { kind: "write", partId: "p/v1#3", feature: "retention-dashboard", owner: "jun", state: "queued" },
    { kind: "check", check: "tests", targets: 3, failed: 1, failing: ["main"], findings: [] },
    { kind: "check", check: "lint", targets: 1, failed: 0, failing: [], findings: [] },
    { kind: "check-run" },
    { kind: "block", state: "running" },
    { kind: "promotion", state: "promoted", mainAfter: "d".repeat(40) },
    { kind: "protected", owner: "jun", state: "pending" },
    { kind: "expand", checkpoint: "e".repeat(40), state: "promoted" },
    { kind: "expand", checkpoint: null, state: "waiting" },
    { kind: "group", owner: "rahul", parts: 2, approved: 1, partId: "m/v1#1" },
    { kind: "contract", symbols: 3, state: "waiting" },
    { kind: "stopped", run: "block", runId: "p/4", failures: 3, reason: "commit 0e252bbf is not in the fetched repos" },
  ];
  const lines = facts.map(jobText);
  assert.deepEqual(lines.slice(0, 9), [
    { label: "retention-dashboard", fact: "Waits for jun" },
    { label: "Scopes of rahul", fact: "Approved by rahul" },
    { label: "Facts run", fact: "With the runner" },
    { label: "Plan", fact: "Returned with 31 needing a person" },
    { label: "person-id-merge-rules/v1", fact: "4 parts" },
    { label: "#1 analytics", fact: "Review refused" },
    { label: "#2 messaging", fact: "Approved by Penguin" },
    { label: "#3 retention-dashboard", fact: "Waits for jun" },
    { label: "retention-dashboard", fact: "Queued for the runner" },
  ]);
  assert.deepEqual(lines[9], { label: "tests", fact: "Failed on 1 of 3 targets" });
  assert.deepEqual(lines[10], { label: "lint", fact: "Passed on 1 target" });
  assert.deepEqual(lines[13], { label: "Main", fact: "Moved to dddddddddddd" });
  assert.deepEqual(lines[17], { label: "rahul", fact: "1 of 2 parts approved" });
  assert.deepEqual(lines[19], { label: "Block run", fact: "Stopped after 3 failures" });
  for (const line of lines) {
    assert.doesNotMatch(line.fact, /[,.;]/u, line.fact);
    assert.doesNotMatch(line.label, /[,;]/u, line.label);
  }
});

test("a stage counts its passed jobs and the strip names the current stage with its exception", () => {
  assert.equal(stageCount({ passed: 7, jobs: 10 }), "7 of 10");
  assert.equal(stageCount({ passed: 0, jobs: 0 }), null);
  const strip = { path: "plan" as const, current: 2, stages: [{ key: "open" as const, status: "passed" as const, passed: 0, jobs: 0 }, { key: "plan" as const, status: "passed" as const, passed: 2, jobs: 2 }, { key: "review" as const, status: "person" as const, passed: 2, jobs: 4 }] };
  assert.equal(currentStageText(strip), "Review needs a person");
  assert.equal(currentStageText({ ...strip, stages: strip.stages.map((stage) => ({ ...stage, status: "running" as const })) }), "Review");
});

test("branches hang from the latest stage first, so each rail passes only rows that start to its right", () => {
  const pipeline: Pick<FeaturePipeline, "path" | "stages" | "branches"> = {
    path: "plan",
    stages: stages("open", "plan", "review", "fixes", "checks", "promoted"),
    branches: [branch("jun", "review"), branch("sam", "review", true), branch("hugo", "open"), branch("mei", "review"), branch("lena", "fixes")],
  };
  const rows = branchRows(pipeline);
  // The settled branch rejoined the bar and gets no row.
  assert.deepEqual(
    rows.map((row) => [row.group.person, row.column, row.cells.join(" ")]),
    [
      ["lena", 3, "rail none rail elbow"],
      ["jun", 2, "rail none tee"],
      ["mei", 2, "rail none elbow"],
      ["hugo", 0, "elbow"],
    ],
  );
  assert.deepEqual(settledAt(pipeline, "review"), ["sam"]);
});

const partJob = (n: number, owner: string, status: PipelineStage["status"]) => ({
  key: `part:p/v1#${n}`,
  status,
  fact: { kind: "part" as const, partId: `p/v1#${n}`, place: { kind: "scope" as const, scope: `s${n}` }, owner, state: "pending" as const, approvedBy: null, review: "accepted" as const, reviewer: null },
});

const partBranch = (n: number, person: string, label: PipelineBranch["label"], agent: string | null = null): PipelineBranch => ({
  key: `part:p/v1#${n}`,
  stage: "review",
  person,
  agent,
  label,
  partId: `p/v1#${n}`,
  settled: false,
});

const task = (id: number, overrides: Partial<EditTaskView>): EditTaskView => ({
  id,
  kind: "review",
  feature: "merge-rules",
  target: "merge-rules",
  block: `b${id}`,
  handle: "@jun/steward",
  person: "jun",
  via: "steward",
  state: "queued",
  askReason: null,
  files: [],
  scopes: ["analytics"],
  instructions: "",
  verifier: "",
  outcome: null,
  commit: null,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

test("one branch per person per stage counts the person's items and takes the most urgent tag", () => {
  const pipeline: Pick<FeaturePipeline, "path" | "stages" | "branches"> = {
    path: "plan",
    stages: [{ key: "review", status: "person", jobs: [partJob(1, "jun", "person"), partJob(2, "sam", "running"), partJob(3, "jun", "person"), partJob(4, "mei", "waiting")] }],
    branches: [partBranch(4, "mei", "sent"), partBranch(1, "jun", "needs a person", "@jun/reports"), partBranch(2, "sam", "reviewing", "@sam/inbox"), partBranch(3, "jun", "needs a person", "@jun/reports")],
  };
  const groups = branchGroups(pipeline, "merge-rules");
  // Needs a person, then running, then waiting, whatever order the pipeline listed them in.
  assert.deepEqual(
    groups.map((group) => [group.person, group.label, group.agent, groupCount(group), group.items.map((item) => item.partId)]),
    [
      ["jun", "needs a person", "@jun/reports", "2 parts", ["p/v1#1", "p/v1#3"]],
      ["sam", "reviewing", "@sam/inbox", null, ["p/v1#2"]],
      ["mei", "sent", null, null, ["p/v1#4"]],
    ],
  );
  // The rows keep that order within the stage.
  assert.deepEqual(
    branchRows(pipeline, "merge-rules").map((row) => [row.group.person, row.cells.join(" ")]),
    [
      ["jun", "tee"],
      ["sam", "tee"],
      ["mei", "elbow"],
    ],
  );
});

test("the feature's open edit tasks join their person's branch at the stage they serve", () => {
  const pipeline: Pick<FeaturePipeline, "path" | "stages" | "branches"> = {
    path: "plan",
    stages: stages("open", "plan", "review", "fixes", "checks", "promoted").map((stage) => (stage.key === "review" ? { ...stage, jobs: [partJob(1, "jun", "waiting")] } : stage)),
    branches: [partBranch(1, "jun", "sent")],
  };
  const tasks = [
    task(1, { state: "asked", askReason: "needs_session" }),
    task(2, { kind: "fix", target: "retention-dashboard", handle: "@jun/retention-dashboard", via: "builder", state: "running", scopes: [] }),
    task(3, { kind: "next_step", handle: "@sam/steward", person: "sam", state: "queued", scopes: [], files: ["a.py", "b.py"] }),
    task(4, { state: "done" }),
    // Another feature's task in this fork shows on that feature's timeline.
    task(5, { feature: "other", target: "merge-rules" }),
  ];
  const rows = branchRows(pipeline, "merge-rules", tasks);
  assert.deepEqual(
    rows.map((row) => [row.group.stage, row.group.person, row.group.label, row.group.agent, groupCount(row.group), row.group.items.map((item) => item.label)]),
    [
      ["checks", "sam", "queued", "@sam/steward", null, ["queued"]],
      ["fixes", "jun", "running", "@jun/retention-dashboard", null, ["running"]],
      ["review", "jun", "asked", null, "1 part 1 task", ["asked", "sent"]],
    ],
  );
  // A builder's fix into its own fork names no place: the builder's name already names it.
  assert.deepEqual(tasks.slice(0, 3).map(taskText), ["Review form analytics", "Fix", "Next step 2 files"]);
  assert.equal(taskText(task(6, { kind: "fix", target: "retention-dashboard", scopes: [] })), "Fix retention-dashboard");
  // A steward's name says what it is; a builder's is its feature's, so the item adds `builder`.
  assert.deepEqual(tasks.slice(0, 3).map(taskVia), [null, "builder", null]);
  assert.equal(taskVia(task(7, { handle: null, via: "person", state: "asked" })), null);
  // A split's tasks serve Migrate, except a contract step, which serves Contract.
  assert.equal(taskStage("split", "review"), "migrate");
  assert.equal(taskStage("split", "contract"), "contract");
  assert.equal(taskText(task(8, { kind: "contract", scopes: ["money"] })), "Contract step money");
});

test("a steward's queue reads as bare counts against the cap", () => {
  assert.deepEqual(queueCounts({ running: 1, queued: 0, asked: 2, cap: 2 }).map((count) => count.text), ["1 of 2 running", "2 asked"]);
  assert.deepEqual(queueCounts({ running: 0, queued: 3, asked: 0, cap: 2 }).map((count) => count.text), ["0 of 2 running", "3 queued"]);
});

test("a hunk numbers context and removed lines on the old side and context and added lines on the new", () => {
  const hunk = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" a", "-b", "+c", "+d", " e"] };
  assert.deepEqual(
    hunkRows(hunk).map((row) => [row.kind, row.old, row.new, row.text]),
    [
      ["context", 10, 10, "a"],
      ["remove", 11, null, "b"],
      ["add", null, 11, "c"],
      ["add", null, 12, "d"],
      ["context", 12, 13, "e"],
    ],
  );
  assert.equal(hunkHeader(hunk), "@@ -10,3 +10,4 @@");
  assert.deepEqual(lineCounts([hunk]), { added: 2, removed: 1 });
});

test("the summary sums up the contract, the places, each place needing a person and each failed check", () => {
  const part = (n: number, owner: string, state: "pending" | "approved") => ({
    partId: `p/v1#${n}`,
    revision: 1,
    place: { kind: "scope" as const, scope: `s${n}` },
    owner,
    scopes: [`s${n}`],
    kind: "behavioural" as const,
    kindReason: "",
    state,
    approvedBy: state === "approved" ? "penguin" : null,
    changeRequests: 0,
    changeRequest: null,
    callers: [],
    breaks: [],
    invariants: [],
    note: null,
    files: [{ path: "a.py", scope: `s${n}`, status: "modified" as const, hunks: [], omitted: null }],
  });
  const plan = {
    contractDiff: { complete: true, contracts: [], changes: [{ symbol: "x", kind: "function", change: "modified", path: "a.py", line: 1 }], signatures: [{ symbol: "x", before: "x()", after: "x(a)", breaking: true }], dataShapes: [] },
    parts: [part(1, "jun", "pending"), part(2, "sam", "approved")],
  };
  const job = (n: number, status: "person" | "passed") => ({
    key: `part:p/v1#${n}`,
    status,
    fact: { kind: "part" as const, partId: `p/v1#${n}`, place: { kind: "scope" as const, scope: `s${n}` }, owner: n === 1 ? "jun" : "sam", state: status === "passed" ? ("approved" as const) : ("pending" as const), approvedBy: null, review: "refused" as const, reviewer: null },
  });
  const pipeline = {
    path: "plan" as const,
    current: 2,
    branches: [],
    activity: [],
    stages: [
      { key: "review" as const, status: "person" as const, jobs: [job(1, "person"), job(2, "passed")] },
      { key: "checks" as const, status: "failed" as const, jobs: [{ key: "check:tests", status: "failed" as const, fact: { kind: "check" as const, check: "tests", targets: 2, failed: 2, failing: ["a", "b"], findings: [] } }] },
    ],
  };
  const dependents = [
    { feature: "basket-size", person: "jun", consumerScope: "analytics", providerScope: "money" },
    { feature: "tax-exempt", person: "rahul", consumerScope: "tax", providerScope: "money" },
  ];
  const page = { feature: { person: "priya" } as never, plan: plan as never, contract: null, pipeline, dependents, waitingOn: [] };
  const lines = summaryLines(page);
  // At most three lines: the main change, its reach and the first thing needing a person.
  assert.deepEqual(
    lines.map((line) => [line.label, line.fact, line.target]),
    [
      ["Contract", "1 change 1 breaking", "change-contract"],
      ["2 features", "3 people", "people"],
      ["#1 s1", "Review refused", "part-1"],
    ],
  );
  // A failed check takes the third line when no part needs a person.
  const quiet = { ...pipeline, stages: pipeline.stages.map((stage) => ({ ...stage, jobs: stage.jobs.filter((job) => job.fact.kind !== "part") })) };
  assert.deepEqual(summaryLines({ ...page, pipeline: quiet }).at(-1), { label: "tests", fact: "Failed on 2 of 2 targets", target: "stage-checks", tone: "failure" });
  // Read by: a row per reader, the one whose part needs a person first, each scope in its owner's colour.
  const strips = new Map([
    ["basket-size", { path: "plan" as const, current: 1, stages: [{ key: "open" as const, status: "passed" as const, passed: 0, jobs: 0 }, { key: "plan" as const, status: "waiting" as const, passed: 0, jobs: 1 }] }],
    ["tax-exempt", { path: "plan" as const, current: 0, stages: [{ key: "open" as const, status: "person" as const, passed: 0, jobs: 1 }] }],
  ]);
  const rows = readByRows({ dependents: [...dependents, dependents[0] as never], plan: plan as never }, strips, new Map([["analytics", "jun"], ["money", "ines"]]));
  assert.deepEqual(
    rows.map((row) => [row.feature, row.reads.scope, row.reads.owner, row.from.owner, row.stage?.key, row.stage?.status]),
    [
      ["tax-exempt", "tax", null, "ines", "open", "person"],
      ["basket-size", "analytics", "jun", "ines", "plan", "waiting"],
    ],
  );
  assert.equal(viewOf("part-3-file-1"), "changes");
  assert.equal(viewOf("review-4"), "pipeline");
  assert.equal(viewOf("read-by"), "people");
  assert.deepEqual(recordKinds([{ recordId: "a", type: "open_feature", author: "", createdAt: "", path: "" }, { recordId: "b", type: "approve_plan_part", author: "", createdAt: "", path: "" }, { recordId: "c", type: "approve_plan_part", author: "", createdAt: "", path: "" }]), [
    { type: "open_feature", count: 1 },
    { type: "approve_plan_part", count: 2 },
  ]);
  // Only the part waiting on the viewer opens, with its short list of files.
  assert.deepEqual(initialFolds({ plan: plan as never }, "jun"), ["part-1", "part-1-file-1"]);
  assert.deepEqual(initialFolds({ plan: plan as never }, "priya"), []);
  assert.deepEqual(foldParents("part-1-file-2"), ["part-1"]);
  assert.deepEqual(foldParents("review-4"), ["stage-review", "reviews"]);
  assert.equal(partAnchor("money/v1#12"), "part-12");
});
