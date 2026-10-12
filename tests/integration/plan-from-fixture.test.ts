// Merge plans for use cases 1 and 2 (PRD 0.4 section 1: identity unification and the helpful fix) end
// to end without the network. Each fixture's features.json names the features: the originating one at
// the checkpoint its plan answers, and each running one at its checkpoint. Each running feature's own
// later commit stands in for the fix the originating agent proposes for it. A commit of the
// originating feature marked `fix` holds its fix for another scope's code on main. The check runner's
// facts run uses the real impact analysis and the real tests; the ProjectAgent's propose_plan reads
// the commit subject and each part's changed lines through the binding's object reads on the same
// repository. Every string in the plan comes from the fixture's files and the run: this test names no
// symbol, docstring or line of its own.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PlanFactsRunner, pythonImpactAnalyzer, TestRunner } from "@penguin/local-bridge";
import { checkPlanFactsReport, formatPlan, type Plan, type PlanFactsReport } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { PlanProject } from "../../services/project-agent/test/plan-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

interface FixtureFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: { readonly scopes: string[]; readonly paths: string[]; readonly contracts: string[] };
  readonly commits: readonly { readonly tag?: string; readonly fix?: { readonly scope: string } }[];
}

interface Fixture {
  readonly dir: string;
  readonly repo: string;
  readonly scratch: string;
  readonly pins: { branches: Record<string, string>; tags: Record<string, string> };
  readonly features: FixtureFeature[];
  readonly scopeMap: ScopeMap;
  readonly invariants: string;
}

let root: string;

async function build(name: string): Promise<Fixture> {
  const dir = join(REPO_ROOT, "examples", name);
  const repo = join(root, name);
  const scratch = join(root, `${name}-scratch`);
  await mkdir(scratch);
  await promisify(execFile)(PYTHON, [join(dir, "build.py"), repo]);
  const penguinDir = join(dir, "base", "penguin");
  return {
    dir,
    repo,
    scratch,
    pins: JSON.parse(await readFile(join(dir, "pins.json"), "utf8")) as Fixture["pins"],
    features: (JSON.parse(await readFile(join(dir, "features.json"), "utf8")) as { features: FixtureFeature[] }).features,
    scopeMap: parseScopeMap(JSON.parse(await readFile(join(penguinDir, "scopes.json"), "utf8"))),
    invariants: await readFile(join(penguinDir, "invariants.json"), "utf8"),
  };
}

let helpfulFix: Promise<Fixture>;
let identityUnification: Promise<Fixture>;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-plan-fixture-")));
  helpfulFix = build("helpful-fix");
  identityUnification = build("identity-unification");
  await Promise.all([helpfulFix, identityUnification]);
});

after(() => rm(root, { recursive: true, force: true }));

const handle = (feature: FixtureFeature) => `@${feature.owner}/${feature.id}`;

/**
 * Opens the fixture's features, the originating one at `originCheckpoint`, and proposes its plan with
 * one part per fix the fixture holds: a `fix` commit of the originating feature for code on main, and
 * each running feature's later commit as a patch against its checkpoint. The check runner's facts
 * run answers the first proposal; the second is the outcome.
 */
async function proposeFromFixture(fixture: Fixture, originCheckpoint: string) {
  const { features, pins, repo, scopeMap } = fixture;
  const main = pins.branches.main as string;
  const origin = features.find((feature) => feature.role === "originating") as FixtureFeature;
  const running = features.filter((feature) => feature.role === "running");

  const project = new PlanProject(scopeMap, repo);
  project.invariants = fixture.invariants;
  await project.open(origin.id, origin.owner, origin.area, { id: "s-origin", handle: handle(origin) });
  await project.checkpoint(origin.id, originCheckpoint, main, handle(origin));
  for (const feature of running) {
    await project.open(feature.id, feature.owner, feature.area);
    await project.checkpoint(feature.id, pins.tags[feature.commits[0]?.tag as string] as string, main, handle(feature));
  }

  const scopeParts = origin.commits.flatMap((commit) =>
    commit.fix === undefined ? [] : [{ place: { scope: commit.fix.scope }, diff: { commit: pins.tags[commit.tag as string] as string } }],
  );
  const featureParts = [];
  for (const feature of running) {
    const head = pins.tags[feature.commits[0]?.tag as string] as string;
    const paths = feature.area.scopes.flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []);
    const diff = (await promisify(execFile)("git", ["-C", repo, "diff", head, pins.branches[feature.fork] as string, "--", ...paths])).stdout;
    featureParts.push({ place: { feature: feature.id }, patch: { base: head, diff } });
  }
  const parts = [...scopeParts, ...featureParts];
  const first = await project.propose(origin.owner, "s-origin", origin.id, parts);
  assert.equal(first.status, "missing");

  // The check runner's facts run.
  const [request] = project.facts.pending();
  assert.ok(request);
  const runner = new PlanFactsRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: fixture.scratch, consent: () => true }),
    impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON }),
  });
  const report = JSON.parse(JSON.stringify(await runner.run(request))) as PlanFactsReport;
  assert.deepEqual(checkPlanFactsReport(report), []);
  assert.equal(JSON.stringify(report).includes("short test summary"), false);
  assert.equal(project.facts.record(request.runId, "runner-1", report).status, "recorded");

  const outcome = await project.propose(origin.owner, "s-origin", origin.id, parts);
  assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 3_000));
  if (outcome.status !== "stored") throw new Error("the plan was not stored");
  return { plan: outcome.plan, report, origin, running };
}

/** Each part states its invariants, its breaks in their words and its changed lines inside its scopes. */
function assertPartFacts(plan: Plan, invariantsFile: string): void {
  const invariants = JSON.parse(invariantsFile) as { invariants: { scope: string; statement: string }[] };
  for (const part of plan.parts) {
    assert.ok(part.callers.length > 0, `${part.partId} has callers`);
    for (const each of part.breaks) assert.ok(each.assertion?.startsWith("assert "), `${part.partId}: ${each.assertion}`);
    assert.deepEqual(
      part.invariants.map((each) => each.statement),
      invariants.invariants.filter((each) => part.scopes.includes(each.scope)).map((each) => each.statement),
    );
    assert.ok(part.diff.files.length > 0 && part.diff.files.every((file) => part.scopes.includes(file.scopeId as string)));
  }
}

async function assertChange(fixture: Fixture, plan: Plan, origin: FixtureFeature): Promise<void> {
  // The change in plain words: the checkpoint commit's subject, read from the repository.
  const subject = (await promisify(execFile)("git", ["-C", fixture.repo, "log", "-1", "--format=%s", plan.facts.change.checkpoint])).stdout.trim();
  assert.equal(plan.facts.change.subject, subject);
  assert.equal(plan.facts.change.madeBy, handle(origin));
  // The contract diff covers the originating feature's declared contracts.
  const touched = new Set(plan.facts.contractDiff?.changes.flatMap((change) => (change.contract === null ? [] : [change.contract])));
  for (const contract of origin.area.contracts) assert.ok(touched.has(contract), contract);
}

function diagnose(t: TestContext, plan: Plan, report: PlanFactsReport): void {
  t.diagnostic(`plan assembled in ${plan.assembledMs} ms; facts run took ${report.durationMs} ms on the runner`);
  t.diagnostic(formatPlan(plan));
}

test("the helpful fix's plan states the change, each break and each part's changed lines from the repo and the run", async (t) => {
  const fixture = await helpfulFix;
  const originFeature = fixture.features.find((feature) => feature.role === "originating") as FixtureFeature;
  const { plan, report, origin, running } = await proposeFromFixture(fixture, fixture.pins.branches[originFeature.fork] as string);
  await assertChange(fixture, plan, origin);
  assert.deepEqual(
    plan.facts.affectedFeatures.map((each) => [each.feature, each.person]).sort(),
    running.map((feature) => [feature.id, feature.owner]).sort(),
  );

  // One part per running feature, with its callers, its breaks, its scope's invariants and its changed lines.
  assert.deepEqual(
    plan.parts.map((part) => [part.place, part.owner, part.scopes]),
    running.map((feature) => [{ kind: "feature", feature: feature.id }, feature.owner, feature.area.scopes]),
  );
  assertPartFacts(plan, fixture.invariants);
  for (const part of plan.parts) {
    assert.equal(part.diff.source, "patch");
    assert.ok(part.breaks.length > 0, `${part.partId} has a break`);
    // Each break states what its test protects in the words of an invariant of the part's scopes,
    // read from the failing test's docstring.
    const statements = new Set(part.invariants.map((each) => `${each.statement}.`));
    for (const each of part.breaks) {
      assert.equal(each.statementFrom, "docstring", `${part.partId}: ${each.nodeId}`);
      assert.ok(statements.has(each.statement), `${part.partId}: ${each.statement}`);
    }
  }
  diagnose(t, plan, report);
});

test("identity unification's plan has a part for each scope's code on main and for each running feature, from the fixture", async (t) => {
  const fixture = await identityUnification;
  const originFeature = fixture.features.find((feature) => feature.role === "originating") as FixtureFeature;
  // Priya's agent plans at the checkpoint, before any revision Jun asks for.
  const { plan, report, origin, running } = await proposeFromFixture(fixture, fixture.pins.tags[originFeature.commits[0]?.tag as string] as string);
  await assertChange(fixture, plan, origin);
  assert.deepEqual(
    plan.facts.affectedFeatures.map((each) => [each.feature, each.person]).sort(),
    running.map((feature) => [feature.id, feature.owner]).sort(),
  );

  // The parts for code on main name the originating fork's fix commits; the scope's owner approves each.
  const fixes = origin.commits.flatMap((commit) => (commit.fix === undefined ? [] : [{ scope: commit.fix.scope, commit: fixture.pins.tags[commit.tag as string] }]));
  assert.ok(fixes.length > 0);
  const onMain = plan.parts.filter((part) => part.place.kind === "scope");
  assert.deepEqual(
    onMain.map((part) => [part.place, part.owner, part.scopes, part.diff.source, part.diff.commit]),
    fixes.map((fix) => [{ kind: "scope", scope: fix.scope }, fixture.scopeMap.scopes.get(fix.scope)?.ownerId, [fix.scope], "commit", fix.commit]),
  );
  // Main's callers are the uses on main in that scope; no test of main breaks on the checkpoint alone.
  for (const part of onMain) {
    assert.ok(part.callers.every((use) => use.scope === (part.place.kind === "scope" ? part.place.scope : "")), part.partId);
    assert.deepEqual(part.breaks, []);
  }

  // The running features' parts carry each fork's own fix as a patch, with the fork's breaks.
  const forks = plan.parts.filter((part) => part.place.kind === "feature");
  assert.deepEqual(
    forks.map((part) => [part.place, part.owner, part.scopes, part.diff.source]),
    running.map((feature) => [{ kind: "feature", feature: feature.id }, feature.owner, feature.area.scopes, "patch"]),
  );
  for (const part of forks) assert.ok(part.breaks.length > 0, `${part.partId} has a break`);
  assertPartFacts(plan, fixture.invariants);
  diagnose(t, plan, report);
});
