// Runner mode's block runs (#96, PRD 0.4 section 4.5) on the helpful-fix fixture. Priya's feature,
// `owner-priya` (the UTC start_of_day plus start_of_local_day), lands onto main. Jun's and Sam's
// running features are the other targets: with the switch to start_of_local_day written into their
// forks every check passes and every scope's tests pass on main's merged tree; without it, their tests
// fail and each failure carries one next step.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { blockVerdict, MAIN_TARGET, parseBlockRunReport, type BlockRunReport, type BlockRunRequest } from "@penguin/protocol";

import { BlockChecker, pythonDependencyAnalyzer } from "../src/block-checks.ts";
import { blockPass, formatBlockPass } from "../src/block-run.ts";
import { checkTools } from "../src/check-tools.ts";
import { CombinedRunner } from "../src/combined-run.ts";
import { pythonImpactAnalyzer } from "../src/impact-analysis.ts";
import type { BlockRunReply } from "../src/penguin-client.ts";
import { TestRunner } from "../src/test-runner.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter), UV_OFFLINE: "1" };

describe("a block run on the runner", () => {
  let root: string;
  let repo: string;
  const sha = (ref: string) => execFileSync("git", ["-C", repo, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-block-run-")));
    repo = join(root, "fixture");
    await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  });

  after(() => rm(root, { recursive: true, force: true }));

  const request = (jun: string, sam: string): BlockRunRequest => ({
    runId: "utc-day-start/1",
    feature: "utc-day-start",
    planId: "utc-day-start/v1",
    purpose: "land",
    fork: "feature-utc-day-start",
    checkpoint: sha("owner-priya"),
    main: sha("main"),
    branch: "main",
    targets: [
      { feature: "reminder-scheduling", person: "sam", fork: "feature-reminder-scheduling", sha: sha(sam) },
      { feature: "weekly-report", person: "jun", fork: "feature-weekly-report", sha: sha(jun) },
    ],
    charter: { handle: "@priya/utc-day-start", person: "priya", scopes: ["ingestion", "shared-dates"], paths: [] },
  });

  async function run(claimed: BlockRunRequest): Promise<{ report: BlockRunReport; fetched: string[]; output: string }> {
    const scratch = await mkdtemp(join(root, "scratch-"));
    const reported: BlockRunReport[] = [];
    const fetched: string[] = [];
    const result = await blockPass({
      claim: async () => [claimed],
      report: async (report): Promise<BlockRunReply> => {
        reported.push(report);
        return { status: "recorded", runId: report.runId, state: "passed", passed: true, recordId: "r", promotion: null, retried: null };
      },
      // The fixture repo already holds every fork's commits.
      fetchRepo: async (name) => {
        fetched.push(name);
      },
      combined: new CombinedRunner({
        repoPath: repo,
        runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
        impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: TEST_ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
        }),
      }),
      repoPath: repo,
    });
    assert.equal(result.runs[0]?.error, null, JSON.stringify(result.runs[0]));
    const [report] = reported;
    assert.ok(report);
    return { report: JSON.parse(JSON.stringify(report)) as BlockRunReport, fetched, output: formatBlockPass(result) };
  }

  test("with each fix in its fork, every check passes and every scope's tests pass on main's merged tree", async () => {
    const claimed = request("owner-jun", "owner-sam");
    const { report, fetched, output } = await run(claimed);
    assert.deepEqual(fetched, ["base", "feature-utc-day-start", "feature-reminder-scheduling", "feature-weekly-report"]);
    const parsed = parseBlockRunReport(report, claimed);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const mainTests = report.checks.filter((check) => check.target === MAIN_TARGET && check.check === "tests");
    assert.deepEqual(mainTests.map((check) => [check.tool.commandId, check.result]), [
      ["test:analytics", "passed"],
      ["test:ingestion", "passed"],
      ["test:messaging", "passed"],
      ["test:shared-dates", "passed"],
    ]);
    const verdict = blockVerdict(claimed, report.checks);
    assert.deepEqual([verdict.passed, verdict.unmerged, verdict.failing.map((check) => `${check.target} ${check.check}`)], [true, [], []]);
    assert.deepEqual(report.decisions, []);
    assert.ok(report.checks.every((check) => check.planId === claimed.planId));
    assert.match(output, /Block run utc-day-start\/1 \(land\): passed/u);
  });

  test("without the fixes, Jun's and Sam's tests fail on their merged trees and each failure gets one next step", async () => {
    const claimed = request("owner-jun-checkpoint", "owner-sam-checkpoint");
    const { report } = await run(claimed);
    const verdict = blockVerdict(claimed, report.checks);
    assert.equal(verdict.passed, false);
    const failing = verdict.failing.map((check) => `${check.target} ${check.check}`).sort();
    assert.ok(failing.includes("weekly-report tests"), failing.join(", "));
    assert.ok(failing.includes("reminder-scheduling tests"), failing.join(", "));
    assert.equal(report.decisions.length, verdict.failing.length);
    for (const decision of report.decisions) assert.ok(decision.step >= 1 && decision.step <= 6);
    // Main's own tests still pass: the break is in the running features, not on main.
    assert.ok(report.checks.filter((check) => check.target === MAIN_TARGET && check.check === "tests").every((check) => check.result === "passed"));
  });
});
