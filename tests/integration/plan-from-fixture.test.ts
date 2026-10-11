// A merge plan for the helpful fix (PRD 0.4 section 1, case 2) end to end without the network. The
// fixture's features.json names the features: the originating one at its last commit, which starts
// every day at UTC midnight and adds start_of_local_day, and each running one at its checkpoint. Each
// running feature's own later commit stands in for the fix the originating agent proposes for it. The
// check runner's facts run uses the real impact analysis and the real tests; the ProjectAgent's
// propose_plan reads the commit subject and each part's changed lines through the binding's object
// reads on the same repository. Every string in the plan comes from the fixture's files and the run:
// this test names no symbol, docstring or line of its own.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PlanFactsRunner, pythonImpactAnalyzer, TestRunner } from "@penguin/local-bridge";
import { checkPlanFactsReport, formatPlan } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { PlanProject } from "../../services/project-agent/test/plan-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

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
let pins: { branches: Record<string, string>; tags: Record<string, string> };
let features: FixtureFeature[];

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-plan-fixture-")));
  repo = join(root, "main");
  await mkdir(join(root, "scratch"));
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as typeof pins;
  features = (JSON.parse(await readFile(join(FIXTURE, "features.json"), "utf8")) as { features: FixtureFeature[] }).features;
});

after(() => rm(root, { recursive: true, force: true }));

test("the helpful fix's plan states the change, each break and each part's changed lines from the repo and the run", async (t) => {
  const penguinDir = join(FIXTURE, "base", "penguin");
  const scopeMap = parseScopeMap(JSON.parse(await readFile(join(penguinDir, "scopes.json"), "utf8")));
  const main = pins.branches.main as string;
  const origin = features.find((feature) => feature.role === "originating") as FixtureFeature;
  const running = features.filter((feature) => feature.role === "running");
  const handle = (feature: FixtureFeature) => `@${feature.owner}/${feature.id}`;

  const project = new PlanProject(scopeMap, repo);
  project.invariants = await readFile(join(penguinDir, "invariants.json"), "utf8");
  await project.open(origin.id, origin.owner, origin.area, { id: "s-origin", handle: handle(origin) });
  await project.checkpoint(origin.id, pins.branches[origin.fork] as string, main, handle(origin));
  for (const feature of running) {
    await project.open(feature.id, feature.owner, feature.area);
    await project.checkpoint(feature.id, pins.tags[feature.commits[0]?.tag as string] as string, main, handle(feature));
  }

  // Each running feature's fix is the fixture's own later commit on that feature's fork, sent as a
  // patch against the feature's fork head, as `git diff` prints it for the feature's scopes.
  const parts = [];
  for (const feature of running) {
    const head = pins.tags[feature.commits[0]?.tag as string] as string;
    const paths = feature.area.scopes.flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []);
    const diff = (await promisify(execFile)("git", ["-C", repo, "diff", head, pins.branches[feature.fork] as string, "--", ...paths])).stdout;
    parts.push({ place: { feature: feature.id }, patch: { base: head, diff } });
  }
  const first = await project.propose(origin.owner, "s-origin", origin.id, parts);
  assert.equal(first.status, "missing");

  // The check runner's facts run.
  const [request] = project.facts.pending();
  assert.ok(request);
  const runner = new PlanFactsRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "scratch"), consent: () => true }),
    impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON }),
  });
  const report = JSON.parse(JSON.stringify(await runner.run(request)));
  assert.deepEqual(checkPlanFactsReport(report), []);
  assert.equal(JSON.stringify(report).includes("short test summary"), false);
  assert.equal(project.facts.record(request.runId, "runner-1", report).status, "recorded");

  const outcome = await project.propose(origin.owner, "s-origin", origin.id, parts);
  assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 3_000));
  if (outcome.status !== "stored") return;
  const { plan } = outcome;

  // The change in plain words: the checkpoint commit's subject, read from the repository.
  const subject = (await promisify(execFile)("git", ["-C", repo, "log", "-1", "--format=%s", plan.facts.change.checkpoint])).stdout.trim();
  assert.equal(plan.facts.change.subject, subject);
  assert.equal(plan.facts.change.madeBy, handle(origin));

  // The contract diff covers the originating feature's declared contract.
  const touched = new Set(plan.facts.contractDiff?.changes.flatMap((change) => (change.contract === null ? [] : [change.contract])));
  for (const contract of origin.area.contracts) assert.ok(touched.has(contract), contract);
  assert.deepEqual(
    plan.facts.affectedFeatures.map((each) => [each.feature, each.person]).sort(),
    running.map((feature) => [feature.id, feature.owner]).sort(),
  );

  // One part per running feature, with its callers, its breaks, its scope's invariants and its changed lines.
  assert.deepEqual(
    plan.parts.map((part) => [part.place, part.owner, part.scopes]),
    running.map((feature) => [{ kind: "feature", feature: feature.id }, feature.owner, feature.area.scopes]),
  );
  const invariants = JSON.parse(project.invariants) as { invariants: { scope: string; statement: string }[] };
  for (const part of plan.parts) {
    assert.equal(part.diff.source, "patch");
    assert.ok(part.callers.length > 0, `${part.partId} has callers`);
    assert.ok(part.breaks.length > 0, `${part.partId} has a break`);
    for (const each of part.breaks) assert.ok(each.assertion?.startsWith("assert "), `${part.partId}: ${each.assertion}`);
    assert.deepEqual(
      part.invariants.map((each) => each.statement),
      invariants.invariants.filter((each) => part.scopes.includes(each.scope)).map((each) => each.statement),
    );
    // Each break states what its test protects in the words of an invariant of the part's scopes,
    // read from the failing test's docstring.
    const statements = new Set(part.invariants.map((each) => `${each.statement}.`));
    for (const each of part.breaks) {
      assert.equal(each.statementFrom, "docstring", `${part.partId}: ${each.nodeId}`);
      assert.ok(statements.has(each.statement), `${part.partId}: ${each.statement}`);
    }
    assert.ok(part.diff.files.length > 0 && part.diff.files.every((file) => part.scopes.includes(file.scopeId as string)));
  }
  t.diagnostic(`plan assembled in ${plan.assembledMs} ms; facts run took ${report.durationMs} ms on the runner`);
  t.diagnostic(formatPlan(plan));
});
