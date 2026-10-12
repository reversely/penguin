// Scheduling combined runs from recorded checkpoints (#67), on the identity-unification fixture's
// real checkpoints: the fixture repo stands in for each owner's fork and for the base repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { BlockCheck, CombinedRunEvent } from "@penguin/protocol";

import { changedPaths, CombinedRunStore } from "../src/combined-run-schedule.ts";
import { gitHistory, HuddleProject } from "./huddle-project.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

let root: string;
let repo: string;
let tags: Record<string, string>;
let main: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "penguin-schedule-")));
  repo = join(root, "fixture");
  execFileSync(PYTHON, [join(FIXTURE, "build.py"), repo]);
  const pins = JSON.parse(readFileSync(join(FIXTURE, "pins.json"), "utf8")) as {
    branches: Record<string, string>;
    tags: Record<string, string>;
  };
  tags = pins.tags;
  main = pins.branches.main as string;
});

after(() => rm(root));

function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const checkpoint = (owner: string) => tags[`owner-${owner}-checkpoint`] as string;

/** A failing or passing result for one dependent owner, as the runner reports it. */
function result(ownerId: string, scopeId: string, ownerCheckpoint: string, status: "passed" | "failed") {
  const fingerprint = { id: "1".repeat(64), commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId: `test:${scopeId}` };
  const failingTests =
    status === "failed" ? [{ nodeId: `${scopeId}/tests/test_x.py::test_y`, testId: "test_x::y" }] : [];
  return { target: ownerId, ownerId, scopeId, commandId: `test:${scopeId}`, status, ownerCheckpoint, fingerprint, failingTests };
}

describe("scheduling on a recorded checkpoint", () => {
  test("a checkpoint of a depended-on scope schedules one run per dependent owner, with IDs only", async () => {
    const project = new HuddleProject();
    const history = gitHistory(repo);
    const jun = await project.report("jun", checkpoint("jun"), history);
    const sam = await project.report("sam", checkpoint("sam"), history);
    // Analytics and messaging are depended on by no scope: nothing to run.
    assert.deepEqual(jun.schedule?.scheduled, []);
    assert.deepEqual(jun.schedule?.changedScopes, ["analytics"]);
    assert.deepEqual(sam.schedule?.scheduled, []);

    const priya = await project.report("priya", checkpoint("priya"), history);
    assert.equal(priya.checkpoint.status, "ok");
    assert.equal(priya.schedule?.baselineSha, main);
    assert.deepEqual(priya.schedule?.changedScopes, ["identity-map"]);
    assert.deepEqual(
      priya.schedule?.scheduled.map((run) => [run.ownerId, run.ownerCheckpoint, run.commandIds, run.status]),
      [
        ["jun", checkpoint("jun"), ["test:analytics"], "scheduled"],
        ["sam", checkpoint("sam"), ["test:messaging"], "scheduled"],
      ],
    );
    for (const run of priya.schedule?.scheduled ?? []) {
      assert.deepEqual(run.trigger, { ownerId: "priya", sha: checkpoint("priya"), baselineSha: main });
    }
  });

  test("reporting the same checkpoint twice schedules its runs once", async () => {
    const project = new HuddleProject();
    const history = gitHistory(repo);
    await project.report("jun", checkpoint("jun"), history);
    await project.report("sam", checkpoint("sam"), history);
    const first = await project.report("priya", checkpoint("priya"), history);
    const second = await project.report("priya", checkpoint("priya"), history);
    assert.equal(first.schedule?.scheduled.length, 2);
    assert.deepEqual(second.schedule?.scheduled, []);
    assert.equal(project.runs.byTrigger("priya", checkpoint("priya")).length, 2);
  });

  test("a dependent owner who has published no checkpoint gets no run", async () => {
    const project = new HuddleProject();
    const history = gitHistory(repo);
    await project.report("jun", checkpoint("jun"), history);
    const priya = await project.report("priya", checkpoint("priya"), history);
    assert.deepEqual(priya.schedule?.withoutCheckpoint, ["sam"]);
    assert.deepEqual(priya.schedule?.scheduled.map((run) => run.ownerId), ["jun"]);
  });

  test("a checkpoint missing from the fork is not recorded and schedules nothing", async () => {
    const project = new HuddleProject();
    const outcome = await project.report("priya", "0".repeat(40), gitHistory(repo));
    assert.equal(outcome.checkpoint.status, "rejected");
    assert.equal(outcome.schedule, undefined);
  });

  test("the diff walks only the trees the checkpoint changed", async () => {
    const history = gitHistory(repo);
    const [priya] = await history.log({ ref: checkpoint("priya"), limit: 1, offset: 0 });
    const [base] = await history.log({ ref: main, limit: 1, offset: 0 });
    assert.ok(priya && base);
    const expected = execFileSync("git", ["-C", repo, "diff", "--name-only", main, checkpoint("priya")], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    const reads = history.calls["readTree"] ?? 0;
    assert.deepEqual(await changedPaths(history, base.treeHash, priya.treeHash), expected);
    // At most the root and each directory holding a changed file, on both sides: unchanged
    // directories such as analytics/ and messaging/ are never read.
    const dirs = new Set(
      expected.flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))),
    );
    assert.ok((history.calls["readTree"] ?? 0) - reads <= 2 * (1 + dirs.size));
  });

  test("the diff lists every file of an added or removed directory", async () => {
    const git = new GitRepo();
    git.commit({ "a/one.txt": "1", "a/deep/two.txt": "2", "keep.txt": "k" });
    const before = git.git("rev-parse", "HEAD^{tree}");
    git.git("rm", "-r", "--quiet", "a");
    git.commit({ "b/three.txt": "3" }, "move");
    const after = git.git("rev-parse", "HEAD^{tree}");
    const history = gitHistory(git.dir);
    assert.deepEqual(await changedPaths(history, before, after), ["a/deep/two.txt", "a/one.txt", "b/three.txt"]);
  });
});

describe("claiming and completing runs", () => {
  async function scheduled(project = new HuddleProject()): Promise<HuddleProject> {
    const history = gitHistory(repo);
    await project.report("jun", checkpoint("jun"), history);
    await project.report("sam", checkpoint("sam"), history);
    await project.report("priya", checkpoint("priya"), history);
    return project;
  }

  test("only the runner role can claim, and a claim hands out every run of a trigger once", async () => {
    const project = await scheduled();
    const owner = project.runs.claim({ bridgeId: "bridge-jun", role: "owner" });
    assert.equal(owner.status, "forbidden");
    assert.equal(project.runs.byTrigger("priya", checkpoint("priya")).every((run) => run.status === "scheduled"), true);

    const claim = project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    assert.equal(claim.status, "ok");
    assert.deepEqual(
      claim.status === "ok" ? claim.runs.map((run) => [run.ownerId, run.status, run.claimedBy]) : [],
      [
        ["jun", "claimed", "bridge-runner"],
        ["sam", "claimed", "bridge-runner"],
      ],
    );
    const again = project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    assert.deepEqual(again.status === "ok" ? again.runs : undefined, []);
  });

  test("a claim whose lease ran out without a report is handed out again", () => {
    let now = 1_000;
    const runs = new CombinedRunStore(sqlite().sql, { now: () => now, leaseMs: 60_000 });
    const trigger = { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) };
    runs.schedule({ trigger, ownerId: "jun", ownerCheckpoint: "c".repeat(40), commandIds: ["test:analytics"] });
    const runner = { bridgeId: "bridge-runner", role: "runner" } as const;
    const first = runs.claim(runner);
    assert.equal(first.status === "ok" ? first.runs.length : 0, 1);
    now += 59_999;
    const early = runs.claim(runner);
    assert.deepEqual(early.status === "ok" ? early.runs : undefined, []);
    now += 1;
    const late = runs.claim(runner);
    assert.equal(late.status === "ok" ? late.runs.length : 0, 1);
  });

  test("a report completes the runs it answers: a pass is recorded as passed", async () => {
    const project = await scheduled();
    project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    const event: CombinedRunEvent = {
      trigger: { ownerId: "priya", sha: checkpoint("priya"), baselineSha: main },
      changedScopes: ["identity-map"],
      unmapped: [],
      results: [result("jun", "analytics", checkpoint("jun"), "passed"), result("sam", "messaging", checkpoint("sam"), "passed")],
    };
    const outcome = await project.open(event);
    assert.equal(outcome.status, "no_failures");
    assert.deepEqual(project.huddleIssues(), []);
    assert.deepEqual(
      project.runs.byTrigger("priya", checkpoint("priya")).map((run) => [run.ownerId, run.status, run.completedAt !== null]),
      [
        ["jun", "passed", true],
        ["sam", "passed", true],
      ],
    );
    // A completed run is never handed out again.
    const claim = project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    assert.deepEqual(claim.status === "ok" ? claim.runs : undefined, []);
  });

  test("an owner with several dependent scopes gets the worst result", () => {
    const runs = new CombinedRunStore(sqlite().sql);
    const trigger = { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) };
    const ownerCheckpoint = "c".repeat(40);
    runs.schedule({ trigger, ownerId: "jun", ownerCheckpoint, commandIds: ["test:analytics", "test:reports"] });
    const completed = runs.complete({
      trigger,
      changedScopes: ["identity-map"],
      unmapped: [],
      results: [result("jun", "analytics", ownerCheckpoint, "passed"), result("jun", "reports", ownerCheckpoint, "failed")],
    });
    assert.deepEqual(completed.map((run) => run.status), ["failed"]);
  });

  test("a not-affected result completes the owner's claimed run, and the block checks are kept", async () => {
    const project = await scheduled();
    project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    const notAffected = {
      target: "sam",
      ownerId: "sam",
      scopeId: "messaging",
      commandId: "test:messaging",
      status: "not-affected" as const,
      ownerCheckpoint: checkpoint("sam"),
      fingerprint: null,
      failingTests: [],
    };
    const typecheck: BlockCheck = {
      planId: null,
      target: "sam",
      check: "typecheck",
      result: "not-affected",
      tool: { name: "pyright", version: null, commandId: "check:pyright" },
      input: { origin: checkpoint("priya"), target: checkpoint("sam"), merged: "d".repeat(40), paths: null },
      findings: [],
      findingCount: 0,
      summary: "the impact graph shows no use of the change",
      fingerprint: null,
      logRef: null,
      durationMs: 0,
    };
    const dependencies: BlockCheck = {
      ...typecheck,
      target: "jun",
      check: "dependencies",
      result: "failed",
      tool: { name: "python-dependencies", version: null, commandId: "analysis:python-dependencies" },
      input: { ...typecheck.input, target: checkpoint("jun") },
      findings: [{ path: "requirements.txt", line: null, code: "requirements", message: "wire 1.4.0 -> 2.0.0" }],
      findingCount: 1,
      summary: "wire changed version; jun imports it in 1 place",
    };
    const outcome = await project.open({
      trigger: { ownerId: "priya", sha: checkpoint("priya"), baselineSha: main },
      changedScopes: ["identity-map"],
      unmapped: [],
      results: [result("jun", "analytics", checkpoint("jun"), "passed"), notAffected],
      checks: [typecheck, dependencies],
    });
    assert.equal(outcome.status, "no_failures");
    assert.deepEqual(
      project.runs.byTrigger("priya", checkpoint("priya")).map((run) => [run.ownerId, run.status]),
      [
        ["jun", "passed"],
        ["sam", "not-affected"],
      ],
    );
    const claim = project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
    assert.deepEqual(claim.status === "ok" ? claim.runs : undefined, []);
    assert.deepEqual(project.runs.checks("priya", checkpoint("priya")), [dependencies, typecheck]);

    // An affected scope's result outranks an unaffected scope of the same owner.
    const runs = new CombinedRunStore(sqlite().sql);
    const trigger = { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) };
    const ownerCheckpoint = "c".repeat(40);
    runs.schedule({ trigger, ownerId: "jun", ownerCheckpoint, commandIds: ["test:analytics", "test:reports"] });
    const completed = runs.complete({
      trigger,
      changedScopes: ["identity-map"],
      unmapped: [],
      results: [
        { ...notAffected, target: "jun", ownerId: "jun", scopeId: "reports", commandId: "test:reports", ownerCheckpoint },
        result("jun", "analytics", ownerCheckpoint, "passed"),
      ],
    });
    assert.deepEqual(completed.map((run) => run.status), ["passed"]);
  });

  test("scheduling, claiming and completing make no network call, so no model call", async () => {
    const attempts: string[] = [];
    const connect = net.Socket.prototype.connect;
    const originalFetch = globalThis.fetch;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      attempts.push(`connect ${JSON.stringify(args[0])}`);
      throw new Error("network access while scheduling combined runs");
    } as typeof connect;
    globalThis.fetch = (input) => {
      attempts.push(`fetch ${String(input)}`);
      return Promise.reject(new Error("network access while scheduling combined runs"));
    };
    try {
      const project = await scheduled();
      project.runs.claim({ bridgeId: "bridge-runner", role: "runner" });
      await project.open({
        trigger: { ownerId: "priya", sha: checkpoint("priya"), baselineSha: main },
        changedScopes: ["identity-map"],
        unmapped: [],
        results: [result("jun", "analytics", checkpoint("jun"), "failed"), result("sam", "messaging", checkpoint("sam"), "passed")],
      });
      assert.deepEqual(project.huddleIssues(), ["1"]);
    } finally {
      net.Socket.prototype.connect = connect;
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(attempts, []);
  });
});
