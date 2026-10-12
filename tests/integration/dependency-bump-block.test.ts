// Use case 3, the dependency bump (PRD 0.5 section 1), from plan to block on the check runner, without
// the network. Hugo's feature upgrades the shared HTTP client to wire 2.0.0; Ana's order-placed webhook
// is the running feature. The facts run names Ana's payments test as the break. The trial of Ana's part
// (the idempotency keys, sent as a patch against Ana's checkpoint) passes Ana's tests and accepts Ana's
// review form. The block then passes with the fix in Ana's fork: the dependency diff is a fact naming
// where Ana imports the client, not a failure. Without the fix, the block fails on Ana's test alone.
// Every string comes from the fixture's files and the runs.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BlockChecker,
  blockPass,
  checkTools,
  CombinedRunner,
  PartTrialRunner,
  PlanFactsRunner,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  runReview,
  TestRunner,
} from "@penguin/local-bridge";
import {
  blockVerdict,
  MAIN_TARGET,
  parseBlockRunReport,
  parsePartTrialReport,
  type BlockRunReport,
  type BlockRunRequest,
  type PlanFactsReport,
  type ReviewForm,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { PlanProject } from "../../services/project-agent/test/plan-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "dependency-bump");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter), UV_OFFLINE: "1" };

interface FixtureFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: { readonly scopes: string[]; readonly paths: string[]; readonly contracts: string[] };
  readonly commits: readonly { readonly tag?: string }[];
}

let root: string;
let repo: string;
let pins: { branches: Record<string, string>; tags: Record<string, string>; fixes: Record<string, string> };
let origin: FixtureFeature;
let running: FixtureFeature;

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const handle = (feature: FixtureFeature) => `@${feature.owner}/${feature.id}`;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-dependency-bump-")));
  repo = join(root, "fixture");
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo], { env: ENV });
  pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as typeof pins;
  const { features } = JSON.parse(await readFile(join(FIXTURE, "features.json"), "utf8")) as { features: FixtureFeature[] };
  origin = features.find((feature) => feature.role === "originating") as FixtureFeature;
  running = features.find((feature) => feature.role === "running") as FixtureFeature;
});

after(() => rm(root, { recursive: true, force: true }));

/** Ana's part: Ana's own later commit, inside the payments paths, as a patch against Ana's checkpoint. */
function anaPatch(scopePaths: readonly string[]): { base: string; diff: string } {
  const base = pins.tags[running.commits[0]?.tag as string] as string;
  return { base, diff: git("diff", base, pins.branches[running.fork] as string, "--", ...scopePaths) };
}

test("case 3: the plan names Ana's break, Ana's part passes its trial, and the block passes with the fix in Ana's fork", async () => {
  const scopeMap = parseScopeMap(JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "scopes.json"), "utf8")));
  const paymentsPaths = running.area.scopes.flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []);
  const main = pins.branches["main"] as string;
  const hugo = pins.tags[origin.commits[0]?.tag as string] as string;
  const anaCheckpoint = pins.tags[running.commits[0]?.tag as string] as string;
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  const tests = new TestRunner({ repoPath: repo, env: ENV, scratchDir: scratch, consent: () => true });
  const impact = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: ENV });

  // Plan: the facts run on Hugo's checkpoint finds Ana's payments test breaking on the merged tree.
  const project = new PlanProject(scopeMap, repo);
  project.invariants = await readFile(join(FIXTURE, "base", "penguin", "invariants.json"), "utf8");
  await project.open(origin.id, origin.owner, origin.area, { id: "s-origin", handle: handle(origin) });
  await project.checkpoint(origin.id, hugo, main, handle(origin));
  await project.open(running.id, running.owner, running.area);
  await project.checkpoint(running.id, anaCheckpoint, main, handle(running));
  const parts = [{ place: { feature: running.id }, patch: anaPatch(paymentsPaths) }];
  assert.equal((await project.propose(origin.owner, "s-origin", origin.id, parts)).status, "missing");
  const [factsRequest] = project.facts.pending();
  assert.ok(factsRequest);
  const facts = JSON.parse(JSON.stringify(await new PlanFactsRunner({ repoPath: repo, runner: tests, impact }).run(factsRequest))) as PlanFactsReport;
  assert.equal(project.facts.record(factsRequest.runId, "runner-1", facts).status, "recorded");
  const proposed = await project.propose(origin.owner, "s-origin", origin.id, parts);
  assert.equal(proposed.status, "stored", JSON.stringify(proposed).slice(0, 2_000));
  if (proposed.status !== "stored") return;
  const [part] = proposed.plan.parts;
  assert.ok(part);
  assert.deepEqual(part.place, { kind: "feature", feature: running.id });
  const failing = Object.keys(pins.fixes);
  assert.ok(JSON.stringify(facts).includes((failing[0] as string).split("::")[1] as string), "the facts run names Ana's failing test");

  // Advance notice: the trial of Ana's part runs Ana's tests and Ana's review form on the trial tree.
  const form = JSON.parse(await readFile(join(FIXTURE, "reviews", "payments.json"), "utf8")) as ReviewForm;
  const trial = await new PartTrialRunner({
    repoPath: repo,
    runner: tests,
    review: (request) => runReview({ repoPath: repo, python: PYTHON, env: ENV, scratchDir: scratch, analyzer: impact }, request),
    scratchDir: scratch,
  }).run({
    trialId: 1,
    feature: origin.id,
    planId: proposed.plan.planId,
    partId: part.partId,
    revision: 1,
    fork: `feature-${origin.id}`,
    checkpoint: hugo,
    target: { id: running.id, repo: `feature-${running.id}`, sha: anaCheckpoint },
    fix: { kind: "patch", patch: anaPatch(paymentsPaths).diff },
    commandIds: running.area.scopes.map((scope) => `test:${scope}`),
    reviews: [{ reviewId: 1, scope: "payments", form }],
  });
  assert.ok(parsePartTrialReport(JSON.parse(JSON.stringify(trial))).ok);
  assert.equal(trial.status, "built");
  assert.deepEqual(trial.tests.map((each) => [each.commandId, each.status]), [["test:payments", "passed"]]);
  assert.deepEqual(trial.reviews.map((each) => [each.record.state, each.record.exceptions]), [["accepted", []]]);

  // Build: the fix write fast-forwards Ana's fork to the patch applied on Ana's checkpoint, whose
  // payments tree is the fixture's own fix commit.
  const fixed = pins.branches[running.fork] as string;
  for (const path of paymentsPaths) {
    const dir = path.replace(/\/$/u, "");
    assert.equal(git("rev-parse", `${trial.tree}:${dir}`), git("rev-parse", `${fixed}:${dir}`), dir);
  }

  // Land: the block on main and on Ana's fork head, as the runner checks it.
  const land = (anaHead: string): BlockRunRequest => ({
    runId: `${origin.id}/1`,
    feature: origin.id,
    planId: proposed.plan.planId,
    purpose: "land",
    fork: `feature-${origin.id}`,
    checkpoint: hugo,
    main,
    branch: "main",
    targets: [{ feature: running.id, person: running.owner, fork: `feature-${running.id}`, sha: anaHead }],
    charter: { handle: handle(origin), person: origin.owner, scopes: origin.area.scopes, paths: [] },
  });
  const check = async (claimed: BlockRunRequest): Promise<BlockRunReport> => {
    const reported: BlockRunReport[] = [];
    const pass = await blockPass({
      claim: async () => [claimed],
      report: async (report) => {
        reported.push(report);
        return { status: "recorded", runId: report.runId, state: "passed", passed: true, recordId: "r", promotion: null, retried: null };
      },
      fetchRepo: async () => {},
      combined: new CombinedRunner({
        repoPath: repo,
        runner: tests,
        impact,
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: ENV }),
        }),
      }),
      repoPath: repo,
    });
    assert.equal(pass.runs[0]?.error, null, JSON.stringify(pass.runs[0]));
    const report = JSON.parse(JSON.stringify(reported[0])) as BlockRunReport;
    assert.ok(parseBlockRunReport(report, claimed).ok);
    return report;
  };

  const withFix = land(fixed);
  const passing = await check(withFix);
  const verdict = blockVerdict(withFix, passing.checks);
  assert.deepEqual([verdict.passed, verdict.failing.map((each) => `${each.target} ${each.check}`)], [true, []]);
  const dependency = passing.checks.find((each) => each.target === running.id && each.check === "dependencies");
  assert.equal(dependency?.result, "passed");
  assert.match(dependency?.summary ?? "", /shared\.http changed version; order-placed-webhook imports it in \d+ places/u);
  assert.ok(passing.checks.some((each) => each.target === running.id && each.check === "tests" && each.result === "passed"));
  assert.ok(passing.checks.filter((each) => each.target === MAIN_TARGET && each.check === "tests").every((each) => each.result === "passed"));

  // Without the fix the bump still fails, on Ana's affected test and nothing else.
  const withoutFix = land(anaCheckpoint);
  const failingRun = await check(withoutFix);
  const failed = blockVerdict(withoutFix, failingRun.checks);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failing.map((each) => `${each.target} ${each.check}`), [`${running.id} tests`]);
  assert.deepEqual(failed.failing[0]?.findings.map((each) => each.message), [`fails: ${(failing[0] as string).split("::")[1]}`]);
});
