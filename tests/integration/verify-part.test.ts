// A verify part on the money fixture (#148, PRD 0.5 section 4.2 step 3): an affected place that needs
// no change. Rahul's tax change turns `tax.rates.RATES` into Decimal rates; tax-filing reads RATES for
// the regions it files in, so the impact graph names it as an affected place, and its tests pass on
// the merged tree unchanged. The plan names it with `verify: true` and no fix. The check runner's facts
// run and the part's trial run for real: the trial tree is the checkpoint merged onto main, and the
// trial runs test:tax-filing on it. Penguin approves the part on that trial. A change that drops a
// region tax-filing files in fails the same trial, and the part waits on its author for a fix.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PartTrialRunner, PlanFactsRunner, pythonImpactAnalyzer, TestRunner } from "@penguin/local-bridge";
import { checkPlanFactsReport, type PartTrialRequest, type PlanFactsReport } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { claimPartTrials, PartTrialStore, queueTrials, recordPartTrial, trialStanding } from "../../services/project-agent/src/part-trial.ts";
import { approveCleanParts, PlanRouteStore, routePart, type PlanApprovalDeps } from "../../services/project-agent/src/plan-approval.ts";
import { ReviewStore } from "../../services/project-agent/src/review-submit.ts";
import { PlanProject } from "../../services/project-agent/test/plan-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const RUNNER = { bridgeId: "runner-1", role: "runner" as const };
const AUTHOR = { GIT_AUTHOR_NAME: "Rahul", GIT_AUTHOR_EMAIL: "rahul@example.com", GIT_COMMITTER_NAME: "Rahul", GIT_COMMITTER_EMAIL: "rahul@example.com" };

const DECIMAL_RATES = `"""Sales tax rates by region."""

from decimal import Decimal

RATES = {"NY": Decimal("0.08875"), "NJ": Decimal("0.06625"), "CA": Decimal("0.0725"), "WA": Decimal("0.065")}


def rate_for(region: str) -> float:
    """The sales tax rate of a region."""
    return float(RATES[region])
`;
// Washington leaves the table, though tax-filing files there quarterly.
const WITHOUT_WA = DECIMAL_RATES.replace(`, "WA": Decimal("0.065")`, "");

let root: string;
let repo: string;
let main: string;
let scopeMap: ScopeMap;
let invariants: string;

const git = async (args: string[], env: NodeJS.ProcessEnv = process.env) => (await promisify(execFile)("git", ["-C", repo, ...args], { env })).stdout.trim();

/** A commit on main that replaces tax/rates.py with `text`, made with plumbing so no ref moves. */
async function ratesCommit(text: string, subject: string): Promise<string> {
  const env = { ...process.env, ...AUTHOR, GIT_INDEX_FILE: join(root, `index-${subject.length}`) };
  const hash = await new Promise<string>((resolve, reject) => {
    const child = execFile("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    child.stdin?.end(text);
  });
  await git(["read-tree", main], env);
  await git(["update-index", "--cacheinfo", `100644,${hash},tax/rates.py`], env);
  return git(["commit-tree", await git(["write-tree"], env), "-p", main, "-m", subject], env);
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-verify-part-")));
  repo = join(root, "money");
  await promisify(execFile)(PYTHON, [join(REPO_ROOT, "examples", "money-minor-units", "build.py"), repo], { env: TEST_ENV });
  main = await git(["rev-parse", "main"]);
  scopeMap = parseScopeMap(JSON.parse(await git(["show", `${main}:penguin/scopes.json`])));
  invariants = await git(["show", `${main}:penguin/invariants.json`]);
});

after(() => rm(root, { recursive: true, force: true }));

/**
 * Rahul's feature at `checkpoint`: the facts run, then a plan with a verify part for every affected
 * place, each part's trial run on the check runner, and Penguin's look at the parts.
 */
async function planAndTrials(checkpoint: string, name: string) {
  const scratch = join(root, `${name}-scratch`);
  await mkdir(scratch);
  const project = new PlanProject(scopeMap, repo);
  project.invariants = invariants;
  await project.open(name, "rahul", { scopes: ["tax"] }, { id: "s-rahul", handle: "@rahul/tax" });
  await project.checkpoint(name, checkpoint, main, "@rahul/tax");

  // The first proposal asks for the facts; the check runner runs them for real.
  assert.equal((await project.propose("rahul", "s-rahul", name, [])).status, "missing");
  const [request] = project.facts.pending();
  assert.ok(request);
  const testRunner = new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true });
  const facts = new PlanFactsRunner({ repoPath: repo, runner: testRunner, impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON }) });
  const report = JSON.parse(JSON.stringify(await facts.run(request))) as PlanFactsReport;
  assert.deepEqual(checkPlanFactsReport(report), []);
  assert.equal(project.facts.record(request.runId, "runner-1", report).status, "recorded");

  // Before #148 a place with nothing to fix could only be left out (`no_part`) or given an empty diff
  // (`diff_empty`). Each affected place now takes a verify part.
  const gaps = await project.propose("rahul", "s-rahul", name, []);
  assert.ok(gaps.status === "missing");
  const places = gaps.missing.filter((item) => item.code === "no_part").map((item) => item.place);
  assert.ok(places.some((place) => place?.kind === "scope" && place.scope === "tax-filing"), JSON.stringify(gaps.missing));
  const parts = places.map((place) => ({ place: place?.kind === "scope" ? { scope: place.scope } : { feature: place?.feature }, verify: true }));
  const stored = await project.propose("rahul", "s-rahul", name, parts);
  assert.equal(stored.status, "stored", JSON.stringify(stored).slice(0, 2_000));
  if (stored.status !== "stored") throw new Error("the plan was not stored");

  // Each part's trial on the check runner, reported to Penguin.
  const reviews = new ReviewStore(project.sql);
  const trials = new PartTrialStore(project.sql);
  const routes = new PlanRouteStore(project.sql);
  routes.announce(stored.plan);
  queueTrials({ trials, reviews }, stored.plan);
  const claim = claimPartTrials(trials, RUNNER);
  assert.ok(claim.status === "ok");
  const runner = new PartTrialRunner({ repoPath: repo, runner: testRunner, review: () => Promise.reject(new Error("a verify part carries no form")), scratchDir: scratch });
  const runs = new Map<string, Awaited<ReturnType<PartTrialRunner["run"]>>>();
  for (const trial of claim.trials as PartTrialRequest[]) {
    const ran = await runner.run(trial);
    runs.set(trial.partId, ran);
    assert.equal((await recordPartTrial({ trials, reviews, routeToOwner: () => undefined }, RUNNER, trial.trialId, JSON.parse(JSON.stringify(ran)))).status, "recorded");
  }

  const deps: PlanApprovalDeps = {
    features: project.features,
    routes,
    inbox: project.inbox,
    keeper: () => project.plans,
    delegates: async () => new Map(),
    sign: (draft) => project.sign(draft),
    roundLimit: 3,
    notify: () => undefined,
    checks: { reviews: (id) => reviews.list(id), scopeMap: async () => scopeMap, adminMode: false, trial: (id, part) => trialStanding(trials, reviews, id, part) },
  };
  const approved = await approveCleanParts(deps, name);
  const plan = project.plans.latestPlan(name);
  assert.ok(plan);
  const filing = plan.parts.find((part) => part.place.kind === "scope" && part.place.scope === "tax-filing");
  assert.ok(filing);
  const trial = claim.trials.find((each) => each.partId === filing.partId) as PartTrialRequest;
  const routing = routePart(plan, filing, reviews.list(name), scopeMap, false, trialStanding(trials, reviews, name, filing));
  return { report, plan, filing, trial, ran: runs.get(filing.partId), approved, routing };
}

test("a Decimal rate table leaves tax-filing passing unchanged, so its verify part is approved on its trial", async (t) => {
  const checkpoint = await ratesCommit(DECIMAL_RATES, "Keep tax rates as Decimal");
  const { report, plan, filing, trial, ran, approved, routing } = await planAndTrials(checkpoint, "tax-decimal");
  t.diagnostic(`parts: ${plan.parts.map((part) => `${part.partId} ${part.place.kind === "scope" ? part.place.scope : part.place.feature} ${part.kind} ${part.approvalState}`).join("; ")}`);
  t.diagnostic(`facts run ${report.durationMs} ms; trial ${ran?.durationMs} ms`);
  // The facts: tax-filing reads RATES, which the change touches.
  assert.ok(report.impact?.headUses.some((use) => use.scope === "tax-filing" && use.path === "tax_filing/periods.py"), JSON.stringify(report.impact?.headUses));
  // The part: no fix, nothing to write, the facts run's merged tree as its tree.
  assert.deepEqual([filing.kind, filing.diff.source, filing.diff.files, filing.diff.commit, filing.diff.patch], ["verify", "none", [], null, null]);
  assert.equal(filing.tests?.fixInTree, true);
  // Its trial is the checkpoint merged onto main at the baseline, with no fix and no form.
  assert.deepEqual([trial.target, trial.fix, trial.reviews, trial.commandIds], [{ id: "main", repo: "base", sha: main }, { kind: "none" }, [], ["test:tax-filing"]]);
  assert.deepEqual(ran?.tests.map((test) => [test.commandId, test.status]), [["test:tax-filing", "passed"]]);
  assert.equal(ran?.status, "built");
  assert.deepEqual(await git(["rev-parse", `${ran?.tree}:tax/rates.py`]), await git(["rev-parse", `${checkpoint}:tax/rates.py`]));
  // Penguin approves it: no reason, no review asked for.
  assert.deepEqual(routing.reasons, []);
  const decided = approved.find((part) => part.partId === filing.partId);
  assert.deepEqual([decided?.approvalState, decided?.approvedBy], ["approved", "penguin"]);
});

test("a rate table without a region tax-filing files in fails the trial, so the verify part needs a fix", async () => {
  const checkpoint = await ratesCommit(WITHOUT_WA, "Keep tax rates as Decimal without Washington");
  const { filing, ran, approved, routing } = await planAndTrials(checkpoint, "tax-no-wa");
  assert.equal(filing.kind, "verify");
  assert.deepEqual(ran?.tests.map((test) => [test.commandId, test.status, test.breaks]), [
    ["test:tax-filing", "failed", ["tax_filing/tests/test_periods.py::test_monthly_and_quarterly_regions"]],
  ]);
  assert.equal(approved.some((part) => part.partId === filing.partId), false);
  assert.deepEqual(routing.reasons, [{ kind: "tests", scope: "tax-filing", status: "failed", breaks: 1 }]);
});
