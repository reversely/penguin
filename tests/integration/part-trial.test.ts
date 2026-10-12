// Part trials on the fixtures (PRD 0.5 sections 4.3 and 6): a review of a part reads the affected
// fork with the part's fix applied and the originating checkpoint merged, not the originating fork.
// Each running feature's own later commit stands in for the fix the originating agent proposes for
// it, sent as a patch against the feature's checkpoint, as tests/integration/plan-from-fixture.test.ts
// sends it. The trial tree, the tests and the review harness run for real on the built repository.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildTrialTree, PartTrialRunner, pythonImpactAnalyzer, runReview, TestRunner } from "@penguin/local-bridge";
import { parsePartTrialReport, type PartTrialRequest, type ReviewForm } from "@penguin/protocol";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

interface Pins {
  readonly branches: Record<string, string>;
  readonly tags: Record<string, string>;
}

interface Built {
  readonly repo: string;
  readonly pins: Pins;
  readonly git: (...args: string[]) => string;
}

let root: string;
let identity: Built;
let helpful: Built;

async function build(name: string): Promise<Built> {
  const repo = join(root, name);
  await promisify(execFile)(PYTHON, [join(REPO_ROOT, "examples", name, "build.py"), repo], { env: ENV });
  const pins = JSON.parse(await readFile(join(REPO_ROOT, "examples", name, "pins.json"), "utf8")) as Pins;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { repo, pins, git };
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-part-trial-")));
  [identity, helpful] = await Promise.all([build("identity-unification"), build("helpful-fix")]);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A running feature's part: its own fix as a patch against its checkpoint, inside `paths`. */
function featureTrial(fixture: Built, feature: string, scope: string, paths: readonly string[], overrides: Partial<PartTrialRequest> = {}): PartTrialRequest {
  const head = fixture.pins.tags[`owner-${feature}-checkpoint`] as string;
  const patch = fixture.git("diff", head, fixture.pins.branches[`owner-${feature}`] as string, "--", ...paths);
  return {
    trialId: 1,
    feature: "origin",
    planId: "origin/v1",
    partId: "origin/v1#1",
    revision: 1,
    fork: "feature-origin",
    checkpoint: fixture.pins.tags["owner-priya-checkpoint"] as string,
    target: { id: feature, repo: `feature-${feature}`, sha: head },
    fix: { kind: "patch", patch },
    commandIds: [`test:${scope}`],
    reviews: [],
    ...overrides,
  };
}

const reviewOptions = (fixture: Built) => ({
  repoPath: fixture.repo,
  python: PYTHON,
  env: ENV,
  scratchDir: root,
  analyzer: pythonImpactAnalyzer({ repoPath: fixture.repo, python: PYTHON, env: ENV }),
});

test("a patch part's trial tree is the fork head with the patch applied and the checkpoint merged", async () => {
  const request = featureTrial(identity, "jun", "analytics", ["analytics"]);
  const built = await buildTrialTree(identity.repo, request, root);
  assert.equal(built.status, "built");
  const tree = built.status === "built" ? built.tree : "";
  // The patch's file is the fork's fixed file, and the checkpoint's own change is in the tree.
  const fixed = identity.pins.branches["owner-jun"] as string;
  assert.equal(identity.git("rev-parse", `${tree}:analytics/retention.py`), identity.git("rev-parse", `${fixed}:analytics/retention.py`));
  const checkpoint = request.checkpoint;
  assert.equal(identity.git("rev-parse", `${tree}:ingestion/identity_map.py`), identity.git("rev-parse", `${checkpoint}:ingestion/identity_map.py`));
  // The same request builds the same commit.
  assert.deepEqual(await buildTrialTree(identity.repo, request, root), built);
});

test("a fix commit for a scope on main is applied on main merged with the checkpoint", async () => {
  const fix = identity.pins.tags["owner-priya-fix-analytics"] as string;
  const base = identity.git("rev-parse", `${fix}^`).trim();
  const built = await buildTrialTree(identity.repo, {
    checkpoint: identity.pins.tags["owner-priya-checkpoint"] as string,
    target: { id: "main", repo: "base", sha: identity.pins.branches["main"] as string },
    fix: { kind: "commit", repo: "feature-origin", commit: fix, base },
  }, root);
  assert.equal(built.status, "built");
  const tree = built.status === "built" ? built.tree : "";
  const changed = identity.git("diff", "--name-only", base, fix).trim().split("\n");
  for (const path of changed) assert.equal(identity.git("rev-parse", `${tree}:${path}`), identity.git("rev-parse", `${fix}:${path}`), path);
});

test("a patch that does not apply to the fork head is a conflict, with no tree", async () => {
  const request = featureTrial(identity, "jun", "analytics", ["analytics"]);
  const built = await buildTrialTree(identity.repo, { ...request, target: { ...request.target, sha: identity.pins.branches["main"] as string } }, root);
  assert.equal(built.status, "conflict");
  assert.match(built.status === "conflict" ? built.reason : "", /does not apply/u);
});

test("the review of a running feature's part finds its evidence and its stored data marker in the affected fork", async () => {
  // Jun's form cites a test and the cutover marker that exist only in Jun's fork with its fix.
  const form: ReviewForm = {
    rows: [
      { invariant: "tablet-patrons-separate", verdict: "holds", evidence: ["analytics/tests/test_identity.py::test_shared_device_split"], storedData: "" },
      { invariant: "published-day-counts-stable", verdict: "holds", evidence: ["analytics/retention.py::person_id_cutover"], storedData: "" },
    ],
    riskyInputs: [],
    storedDataMarker: { kind: "cutover", evidence: "analytics/retention.py::person_id_cutover" },
  };
  const request = featureTrial(identity, "jun", "analytics", ["analytics"]);
  const options = reviewOptions(identity);
  const onOrigin = await runReview(options, { base: identity.pins.branches["main"] as string, fork: request.checkpoint, scope: "analytics", form });
  assert.deepEqual(
    [...new Set(onOrigin.refusals.map((refusal) => refusal.code))].sort(),
    ["evidence_not_found"],
    "the originating fork has neither the test nor the marker",
  );
  const built = await buildTrialTree(identity.repo, request, root);
  const tree = built.status === "built" ? built.tree : "";
  const onTrial = await runReview(options, { base: request.target.sha, fork: tree, scope: "analytics", form });
  assert.deepEqual(onTrial.refusals, []);
  assert.equal(onTrial.state, "accepted");
  assert.ok((onTrial.storedShapes ?? []).length > 0, "the contract diff shows a stored data shape, so the marker is needed");
});

test("the side-by-side run of a running feature's part runs the examples its scope declares in that fork", async () => {
  // Jun declares weekly_report's recorded examples in his own fork; main has none for analytics.
  const request = featureTrial(helpful, "jun", "analytics", ["analytics"]);
  const form = JSON.parse(helpful.git("show", `${request.target.sha}:penguin/invariants.json`)) as { invariants: { id: string; scope: string }[] };
  const review: ReviewForm = {
    rows: form.invariants
      .filter((invariant) => invariant.scope === "analytics")
      .map((invariant) => ({ invariant: invariant.id, verdict: "holds" as const, evidence: ["analytics/weekly.py::weekly_report"], storedData: "" })),
    riskyInputs: [],
    storedDataMarker: null,
  };
  const options = reviewOptions(helpful);
  const onOrigin = await runReview(options, { base: helpful.pins.branches["main"] as string, fork: request.checkpoint, scope: "analytics", form: review });
  assert.equal(onOrigin.sideBySide.totals.inputs, 0);
  const built = await buildTrialTree(helpful.repo, request, root);
  const tree = built.status === "built" ? built.tree : "";
  const onTrial = await runReview(options, { base: request.target.sha, fork: tree, scope: "analytics", form: review });
  const examples = JSON.parse(helpful.git("show", `${request.target.sha}:analytics/examples/weekly_report.json`)) as { cases: unknown[] };
  assert.equal(onTrial.sideBySide.totals.inputs, examples.cases.length);
  assert.ok(examples.cases.length > 0);
});

test("a trial runs the part's tests and each form on its tree, and its report is one Penguin takes", async () => {
  const scratch = await mkdtemp(join(root, "runner-"));
  const runner = new PartTrialRunner({
    repoPath: identity.repo,
    runner: new TestRunner({ repoPath: identity.repo, env: ENV, scratchDir: scratch, consent: () => true }),
    review: (request) => runReview(reviewOptions(identity), request),
    scratchDir: scratch,
  });
  const form = JSON.parse(await readFile(join(REPO_ROOT, "examples", "identity-unification", "reviews", "messaging.json"), "utf8")) as ReviewForm;
  const request = featureTrial(identity, "sam", "messaging", ["messaging"], { reviews: [{ reviewId: 7, scope: "messaging", form }] });
  const report = await runner.run(request);
  const parsed = parsePartTrialReport(JSON.parse(JSON.stringify(report)));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(report.status, "built");
  assert.deepEqual(report.tests.map((each) => [each.commandId, each.status]), [["test:messaging", "passed"]]);
  assert.deepEqual(report.reviews.map((each) => [each.reviewId, each.record.base, each.record.fork]), [[7, request.target.sha, report.tree]]);
});

test("on the fixture's own forms the stored data rule asks only a scope that reads the changed shape for a marker", async () => {
  // Jun's patch adds the cutover field to RetentionDashboard, which analytics reads, and Jun's form
  // names the cutover marker the patch adds. Sam's audience reads Priya's reshaped Profile, and Sam's
  // form names no marker, so the rule still asks Sam's agent for one.
  const options = reviewOptions(identity);
  const formOf = async (scope: string) => JSON.parse(await readFile(join(REPO_ROOT, "examples", "identity-unification", "reviews", `${scope}.json`), "utf8")) as ReviewForm;
  const trial = async (feature: string, scope: string) => {
    const request = featureTrial(identity, feature, scope, [scope]);
    const built = await buildTrialTree(identity.repo, request, root);
    assert.equal(built.status, "built");
    return runReview(options, { base: request.target.sha, fork: built.status === "built" ? built.tree : "", scope, form: await formOf(scope) });
  };
  const jun = await trial("jun", "analytics");
  assert.deepEqual(jun.storedShapes?.map((shape) => shape.symbol), ["analytics.retention.RetentionDashboard"]);
  assert.equal(jun.state, "accepted", JSON.stringify(jun.refusals));
  // The tablet invariant the form reports broken still reaches Jun.
  assert.deepEqual(jun.exceptions.map((exception) => exception.kind).sort(), ["broken_invariant", "protected_difference"]);
  const sam = await trial("sam", "messaging");
  assert.deepEqual(sam.storedShapes?.map((shape) => shape.symbol), ["ingestion.identity_map.Profile"]);
  assert.deepEqual(sam.refusals.map((refusal) => refusal.code), ["stored_data_without_marker"]);
});
