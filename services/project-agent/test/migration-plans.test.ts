// The migration plans of a split (#131, PRD 0.5 section 4.2 step 2, Migrate): after a count of the
// remaining callers, each owner group of the originating feature becomes one plan with one part per
// place; the runner writes the parts the declared rules rewrite whole and every other part is an edit
// task for the place's builder or the steward of its scope's DRI; a later caller joins its owner's open
// plan or, once that plan landed, opens the next; and when the originating feature no longer runs, the
// contract step is carried by a feature Penguin opens from main for the defining scope's DRI.
//
// The rules of #139: a rule-written part needs no form and is approved when its trial's tests pass and
// its formless side-by-side run shows no protected difference; a failing trial is an edit task with the
// failing check, and a person only once that task fails; a plan of running features closes when every
// fix is written; and a feature Penguin opens goes through the overlap lock.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  REVIEW_SCHEMA_VERSION,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  type AgentToolResult,
  type ImpactFork,
  type ImpactReport,
  type ImpactUse,
  type MigrationRewritePlace,
  type Plan,
  type RewriteRule,
  type SideBySideRecord,
} from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore } from "../src/agent-tools.ts";
import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore } from "../src/edit-tasks.ts";
import { claimEditTasks, editRouting, reportEditTask, writeWaitsFor, type EditWorkDeps } from "../src/edit-work.ts";
import { retrialReported, retryWaitingWrites } from "../src/fix-retrial.ts";
import { claimRunnerWrites, FixGrantStore, runnerFixReport, taskWriteKey, type FixWriteDeps } from "../src/fix-write.ts";
import { IdentityStore } from "../src/identity-store.ts";
import {
  carryContract,
  migrationBlockLanded,
  migrationsChecked,
  migrationsCounted,
  migrationTasksSettled,
  migrationTrialReported,
  migrationWrites,
  MigrationStore,
  rewritesReported,
  type MigrationDeps,
} from "../src/migration-plans.ts";
import { approveOverlap, checkOverlap } from "../src/overlap-lock.ts";
import { PartTrialStore, type StoredPartTrial } from "../src/part-trial.ts";
import { closeRemoved, countReported, PENGUIN_SESSION, requestRetiringCount, type RetiringCountDeps } from "../src/retiring-count.ts";
import { PlanRouteStore } from "../src/plan-approval.ts";
import { ReviewStore } from "../src/review-submit.ts";
import { gitReader } from "./git-reader.ts";
import { GitRepo } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts, depends_on: [] });
const SCOPES = [
  scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price"]),
  scope("orders", "tomas", ["orders/"], ["orders/model.py::line_total"]),
  scope("billing", "bea", ["billing/"], ["billing/api.py::fee"]),
];
const scopeMap = parseScopeMap({ scopes: SCOPES });
/** Billing declares that fees round per line, protected: a side-by-side difference on it fails a trial. */
const INVARIANTS = [{ id: "fee-rounding", scopeId: "billing", statement: "fees round per line", protected: true }];

const BASE = "a".repeat(40);
const EXPAND = "b".repeat(40);
const FEES = "c".repeat(40);
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const PRICE = { contract: "shared/money/api.py::price", replacement: "shared/money/api.py::Money" };
const LINE = { contract: "orders/model.py::line_total", replacement: "orders/model.py::line_total_minor" };
const FEE = { contract: "billing/api.py::fee", replacement: "billing/api.py::fee_minor" };
const PRICE_RULE: RewriteRule = { id: "price-times", contract: PRICE.contract, kind: "expression", pattern: "api.price($a * $b)", replacement: "$a.times($b)", imports: [] };
const FEE_RULE: RewriteRule = { id: "fee-minor", contract: FEE.contract, kind: "expression", pattern: "api.fee($a)", replacement: "api.fee_minor($a)", imports: [] };
const PATCH = "--- a/billing/fees.py\n+++ b/billing/fees.py\n@@ -1 +1 @@\n-x = api.price(a * b)\n+x = a.times(b)\n";

const sha = (n: number) => n.toString(16).padStart(40, "d");
const use = (path: string, symbol: string, scopeId: string | null): ImpactUse => ({ path, line: 3, kind: "call", symbol, name: symbol.slice(symbol.lastIndexOf(".") + 1), scope: scopeId });
const priceUse = (path: string, scopeId: string | null) => use(path, "shared.money.api.price", scopeId);
const lineUse = (path: string) => use(path, "orders.model.line_total", "orders");
const feeUse = (path: string) => use(path, "billing.api.fee", "billing");
const fork = (id: string, uses: ImpactUse[], since: string): ImpactFork => ({ id, sha: FEES, scopes: [], since, mergeBase: BASE, carried: 0, uses, errors: [] });

function impact(head: string, fields: Partial<ImpactReport>): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: head,
    head,
    changes: [],
    signatures: [],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 2, head: 2, parsed: 2 },
    ...fields,
  };
}

/** Billing's side-by-side run over its declared fee examples, `differing` of its two inputs differing. */
function sideBySideRecord(base: string, fork: string, differing: number): SideBySideRecord {
  const changed = { name: "small", args: { amount: 1 }, main: { status: "returned" as const, value: 1 }, fork: { status: "returned" as const, value: 2 } };
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    tool: SIDE_BY_SIDE_TOOL,
    commandId: SIDE_BY_SIDE_COMMAND_ID,
    base,
    fork,
    scope: "billing",
    sets: [{ source: "examples", file: "billing/examples/fee.json", contract: FEE.contract, invariants: ["fee-rounding"], inputs: ["small", "large"], differing: differing > 0 ? [changed] : [], invalid: [], mainMs: 1, forkMs: 1 }],
    totals: { inputs: 2, differing, invalid: 0 },
    timings: { mainMs: 1, forkMs: 1, totalMs: 2 },
  };
}

function result(main: string, fields: Partial<AgentToolResult>): AgentToolResult {
  return { schemaVersion: 1, tool: "impact", base: main, checkpoint: main, result: "found", summary: "ran", impact: null, checks: [], decisions: [], fix: null, fixRef: null, pushed: false, durationMs: 4, ...fields };
}

describe("migration plans of a split, one per owner group", () => {
  let project: PlanProject;
  let runs: AgentToolStore;
  let store: MigrationStore;
  let tasks: EditTaskStore;
  let roster: EditRoster;
  let trials: PartTrialStore;
  let grants: FixGrantStore;
  let deps: MigrationDeps;
  let count: RetiringCountDeps;
  let forked: string[];
  let scopeMapNow: ScopeMap;

  beforeEach(async () => {
    project = new PlanProject(scopeMap, "");
    runs = new AgentToolStore(project.sql);
    store = new MigrationStore(project.sql);
    tasks = new EditTaskStore(project.sql);
    roster = new EditRoster(project.sql, new IdentityStore(project.sql));
    trials = new PartTrialStore(project.sql);
    grants = new FixGrantStore(project.sql);
    forked = [];
    scopeMapNow = scopeMap;
    deps = {
      store,
      features: project.features,
      runs,
      retiring: project.retiring,
      trials,
      reviews: new ReviewStore(project.sql),
      scopeMap: async () => scopeMapNow,
      sign: (draft) => project.sign(draft),
      openTask: async (source, adjust) => {
        roster.sync(scopeMapNow, project.features.list());
        return tasks.open(source, adjust(editRouting({ roster, features: project.features }, scopeMapNow, () => true)));
      },
      tasks,
      grants,
      invariants: async () => INVARIANTS,
      checkOverlap: (feature) =>
        checkOverlap({ db: project.sql, features: project.features, overlaps: project.overlaps, scopeMap: async () => scopeMapNow, sign: (draft) => project.sign(draft) }, feature),
      adminMode: false,
      fork: async (featureId) => {
        forked.push(featureId);
        return `feature-${featureId}`;
      },
    };
    count = {
      features: project.features,
      runs,
      retiring: project.retiring,
      facts: project.facts,
      sign: (draft) => project.sign(draft),
      carry: (featureId, symbols, at) => carryContract(deps, featureId, symbols, at),
    };
    // Ines's split is on main at EXPAND and retires price (with a rule) and line_total (without one).
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
    await project.checkpoint("money-minor", EXPAND, BASE, "@ines/money");
    project.retiring.declare({ featureId: "money-minor", planId: "money-minor/v1", person: "ines", rules: [PRICE_RULE] } as unknown as Plan, [PRICE, LINE], "record-money");
    // Bea's own split retires fee, with its own rule.
    await project.open("fee-minor", "bea", { scopes: ["billing"] }, { id: "s-bea2", handle: "@bea/fee" });
    await project.checkpoint("fee-minor", EXPAND, BASE, "@bea/fee");
    project.retiring.declare({ featureId: "fee-minor", planId: "fee-minor/v1", person: "bea", rules: [FEE_RULE] } as unknown as Plan, [FEE], "record-fee");
    // Bea's fees feature calls price and fee in its own changes.
    await project.open("fees", "bea", { scopes: ["billing"] }, { id: "s-bea", handle: "@bea/billing" });
    await project.checkpoint("fees", FEES, BASE, "@bea/billing");
  });

  /** Main moved to `main`; Penguin counts and the runner reports `fields`. Answers the plans changed. */
  async function counted(main: string, fields: Partial<ImpactReport>) {
    const runId = requestRetiringCount(count, "money-minor", main);
    assert.ok(runId !== undefined);
    const recorded = recordToolResult(runs, RUNNER, runId, result(main, { impact: impact(main, fields) }));
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    if (recorded.status !== "recorded") return [];
    await countReported(count, recorded.run);
    return migrationsCounted(deps, recorded.run);
  }

  const records = (feature: string, type: string) =>
    project.features
      .records(feature)
      .map((stored) => JSON.parse(stored.file) as { type: string; author: unknown; payload: Record<string, unknown> })
      .filter((each) => each.type === type);
  const rewriteRuns = () => runs.list("money-minor").filter((run) => run.input["search"] === "rewrite" && run.input["origin"] === "money-minor");

  /** The fix-write deps the ProjectAgent wires, every fork read from `repo`, with the migration parts' writes. */
  const writeDeps = (repo: GitRepo): FixWriteDeps => ({
    features: project.features,
    routes: new PlanRouteStore(project.sql),
    grants,
    keeper: () => project.plans,
    scopeMap: async () => scopeMapNow,
    readFork: async (_name, read) =>
      read({
        ...gitReader(repo.dir),
        log: async ({ ref, limit }) =>
          repo
            .git("log", "--format=%H", `-n${limit}`, ref)
            .split("\n")
            .filter(Boolean)
            .map((hash) => ({ hash })),
      }),
    sign: (draft) => project.sign(draft),
    notify: () => undefined,
    migration: migrationWrites(deps),
  });

  test("a count becomes one plan per owner group, each carrying only its originating feature's declarations", async () => {
    const changed = await counted(sha(1), {
      headUses: [lineUse("orders/report.py"), lineUse("orders/tests/test_model.py")],
      forks: [fork("fees", [priceUse("billing/fees.py", "billing"), feeUse("billing/fees.py")], sha(1))],
    });
    assert.deepEqual(changed.sort(), ["migrate:fee-minor:bea:1", "migrate:money-minor:bea:1", "migrate:money-minor:tomas:1"]);
    const plans = store.plans("money-minor");
    assert.deepEqual(
      plans.map((plan) => [plan.owner, plan.block, plan.parts.map((part) => [part.place, part.uses, part.contracts, part.rules, part.state])]),
      [
        ["bea", "migrate-bea-money-minor", [[{ kind: "feature", feature: "fees" }, 1, [PRICE.contract], ["price-times"], "rewriting"]]],
        ["tomas", "migrate-tomas-money-minor", [[{ kind: "scope", scope: "orders" }, 2, [LINE.contract], [], "task"]]],
      ],
    );
    // Bea's fee split has its own plan; its rule never reaches Ines's plans.
    assert.deepEqual(store.plans("fee-minor").map((plan) => plan.parts.map((part) => [part.contracts, part.rules])), [[[[FEE.contract], ["fee-minor"]]]]);
    const proposed = records("money-minor", "migration_proposed");
    assert.equal(proposed.length, 2);
    assert.deepEqual(proposed.map((each) => [each.author, each.payload["owner"], each.payload["rules"]]), [
      [{ penguin: true }, "bea", ["price-times"]],
      [{ penguin: true }, "tomas", ["price-times"]],
    ]);
    // One rewrite request per originating feature, with only that feature's declarations and places.
    const [rewrite] = rewriteRuns();
    assert.equal(rewriteRuns().length, 1);
    assert.equal(rewrite?.sessionId, PENGUIN_SESSION);
    assert.deepEqual(rewrite?.input["places"], [{ place: { kind: "feature", feature: "fees" }, target: "fees", paths: ["billing/fees.py"] }]);
    assert.deepEqual((rewrite?.input["retiring"] as { contract: string }[]).map((each) => each.contract), [LINE.contract, PRICE.contract]);
    // Code on main with no rule goes to the steward of the scope's DRI, in the plan's block, which Penguin opened from main.
    const [task] = tasks.forFeature("migrate-tomas-money-minor");
    assert.deepEqual([task?.kind, task?.handle, task?.via, task?.files], ["migration", "@tomas/steward", "steward", ["orders/report.py", "orders/tests/test_model.py"]]);
    assert.deepEqual(forked, ["migrate-tomas-money-minor"]);
    assert.deepEqual([project.features.get("migrate-tomas-money-minor")?.personId, project.features.get("migrate-tomas-money-minor")?.repo], ["tomas", "feature-migrate-tomas-money-minor"]);
    assert.deepEqual(records("migrate-tomas-money-minor", "open_feature").map((each) => each.author), [{ penguin: true }]);
  });

  /** Counts Bea's fees feature with one price call and reports the rules' rewrite of it, at `fees` (FEES by default). */
  async function rewritten(fees = FEES, patchText = PATCH) {
    await counted(sha(1), { forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(1)), fork("money-minor", [], sha(1))] });
    const [request] = rewriteRuns();
    assert.ok(request);
    const place = { kind: "feature" as const, feature: "fees" };
    const rewrite: MigrationRewritePlace = { place, target: "fees", sha: fees, files: [{ path: "billing/fees.py", rules: ["price-times"] }], patch: patchText, residual: 0, error: null };
    const recorded = recordToolResult(runs, RUNNER, request.id, result(sha(1), { rewrites: [rewrite] }));
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    if (recorded.status !== "recorded") throw new Error("not recorded");
    assert.deepEqual(await rewritesReported(deps, recorded.run), ["migrate:money-minor:bea:1"]);
    const [trial] = trials.current("migrate-bea-money-minor");
    assert.ok(trial);
    return trial;
  }

  /** The runner's report of `trial`: billing's tests with `status`, and billing's side-by-side run with `differing` inputs differing. */
  const trialReport = (trial: StoredPartTrial, status: "passed" | "failed", differing = 0) => ({
    schemaVersion: 1 as const,
    trialId: trial.id,
    partId: trial.partId,
    revision: 1,
    checkpoint: sha(1),
    target: trial.request.target.sha,
    status: "built" as const,
    tree: sha(9),
    reason: null,
    tests: [{ scopeId: "billing", commandId: "test:billing", status, breaks: status === "failed" ? ["billing/tests/test_fees.py::test_fee"] : [], reason: null, durationMs: 3 }],
    reviews: [],
    sideBySide: [{ scope: "billing", record: sideBySideRecord(trial.request.target.sha, sha(9), differing) }],
    durationMs: 9,
  });
  const decide = async (trial: StoredPartTrial, status: "passed" | "failed", differing = 0) => migrationTrialReported(deps, trials.record(trial.id, trialReport(trial, status, differing)) as StoredPartTrial);

  test("a rule-written part needs no review form: Penguin approves it when its tests pass and no protected invariant differs", async () => {
    const trial = await rewritten();
    const part = store.part(trial.partId);
    assert.deepEqual([part?.writer, part?.state, part?.reason], ["runner", "trial", "the rules price-times rewrite every use in the place"]);
    assert.deepEqual(records("money-minor", "migration_routed").map((each) => each.payload["parts"]), [
      [{ part: trial.partId, place: { kind: "feature", feature: "fees" }, writer: "runner", reason: "the rules price-times rewrite every use in the place" }],
    ]);
    // The trial applies the runner's patch to Bea's fork head, merged with main at the count, carries no
    // form and asks for billing's side-by-side run on its own.
    assert.deepEqual([trial.request.fork, trial.request.checkpoint, trial.request.target, trial.request.fix, trial.request.commandIds, trial.request.reviews, trial.request.sideBySide], [
      "base",
      sha(1),
      { id: "fees", repo: "feature-fees", sha: FEES },
      { kind: "patch", patch: PATCH },
      ["test:billing"],
      [],
      ["billing"],
    ]);
    assert.equal(await decide(trial, "passed"), "approved");
    assert.deepEqual([store.part(trial.partId)?.approvedBy, store.part(trial.partId)?.reason], ["penguin", "the trial's tests pass and no protected invariant differs; a rule-written part needs no review form"]);
    // No form is asked for, and the check runner's write into Bea's fork is queued.
    assert.deepEqual(tasks.forFeature("migrate-bea-money-minor"), []);
    assert.deepEqual(grants.claimable().map((grant) => [grant.planId, grant.partId, grant.targetFeatureId, grant.writer]), [["migrate:money-minor:bea:1", trial.partId, "fees", "runner"]]);
    assert.equal(store.plan("migrate:money-minor:bea:1")?.state, "approved");
    assert.deepEqual(records("money-minor", "migration_part_decided").map((each) => [each.payload["decision"], each.payload["approved_by"]]), [["approved", "penguin"]]);
  });

  test("a rule-written part whose trial fails becomes an edit task with the failing check, and reaches a person only when that task fails", async () => {
    const trial = await rewritten();
    assert.equal(await decide(trial, "failed"), "task");
    const part = store.part(trial.partId);
    assert.deepEqual([part?.writer, part?.reason], ["task", "the rules' patch failed its trial: test:billing failed on the trial tree"]);
    const [task] = tasks.forSource(`migrate:${trial.partId}`);
    assert.deepEqual([task?.kind, task?.via, task?.handle, task?.target], ["migration", "builder", "@bea/fees", "fees"]);
    assert.deepEqual(task?.evidence, ["test:billing failed on the trial tree", "test:billing fails billing/tests/test_fees.py::test_fee", "billing/fees.py"]);
    assert.deepEqual(await migrationTasksSettled(deps), []);
    // Bea's bridge runs the task and the run fails: now Bea decides in person.
    assert.ok(task);
    tasks.claim("bea", "br_bea", 2, 60_000, () => false);
    assert.equal(tasks.report("br_bea", task.id, { status: "failed", outcome: "claude -p stopped: tests still fail" }).status, "ok");
    assert.deepEqual(await migrationTasksSettled(deps), ["migrate:money-minor:bea:1"]);
    assert.deepEqual([store.part(trial.partId)?.state, store.part(trial.partId)?.reason], ["in_person", "the edit task for @bea/fees failed (run_failed): claude -p stopped: tests still fail"]);
    assert.deepEqual(records("money-minor", "migration_part_decided").map((each) => each.payload["decision"]), ["task", "in_person"]);
  });

  test("a protected invariant the side-by-side run shows differing fails the trial; a protected path needs a person", async () => {
    const trial = await rewritten();
    assert.equal(await decide(trial, "passed", 1), "task");
    assert.equal(store.part(trial.partId)?.reason, "the rules' patch failed its trial: 1 inputs of billing/api.py::fee differ on protected fee-rounding");
    const [task] = tasks.forSource(`migrate:${trial.partId}`);
    assert.deepEqual(task?.evidence.slice(0, 2), [
      "1 inputs of billing/api.py::fee differ on protected fee-rounding",
      'billing/api.py::fee small: main {"status":"returned","value":1}, patched {"status":"returned","value":2}',
    ]);
    // The same patch under a path Bea protects goes to Bea in person: no agent's edit settles it.
    scopeMapNow = parseScopeMap({ scopes: SCOPES.map((each) => (each.id === "billing" ? { ...each, protected_paths: ["billing/fees.py"] } : each)) });
    const { trialId: _trialId, ...spec } = trial.request;
    const again = trials.queue(spec, ["billing"]);
    store.updatePart(trial.partId, { state: "trial" });
    assert.equal(await decide(again, "passed"), "in_person");
    assert.equal(store.part(trial.partId)?.reason, "billing/fees.py lies under bea's protected billing/fees.py");
  });

  test("a plan whose places are all running features closes once every fix is written into its fork", async () => {
    const repo = new GitRepo();
    const head = repo.commit({ "billing/fees.py": "x = api.price(a * b)\n" }, "Bea's fees checkpoint");
    const trial = await rewritten(head);
    assert.equal(await decide(trial, "passed"), "approved");
    // The check runner claims the write on Bea's fork, as it claims a mechanical fix.
    const fixDeps = writeDeps(repo);
    const claim = await claimRunnerWrites(fixDeps, RUNNER);
    assert.ok(claim.status === "ok");
    const [write] = claim.writes;
    assert.deepEqual([write?.repo, write?.spec.target, write?.spec.parent, write?.spec.kind, write?.spec.paths], ["feature-fees", "fees", head, "mechanical", ["billing/fees.py"]]);
    assert.ok(write);
    repo.commit({ "billing/fees.py": "x = a.times(b)\n" }, write.spec.message);
    const kept = await runnerFixReport(fixDeps, RUNNER, write.spec.writeId, { commit: repo.git("rev-parse", "HEAD") });
    assert.equal(kept.status, "ok", JSON.stringify(kept));
    // Every live part is written and no place is on main: the plan closes with nothing to promote.
    assert.equal(store.part(trial.partId)?.state, "written");
    assert.equal(store.plan("migrate:money-minor:bea:1")?.state, "closed");
    assert.deepEqual(records("money-minor", "migration_part_written").map((each) => [each.payload["part"], each.payload["written_by"]]), [[trial.partId, "penguin"]]);
    assert.deepEqual(records("money-minor", "migration_closed").map((each) => each.payload["plan"]), ["migrate:money-minor:bea:1"]);
    assert.deepEqual(forked, []);
    // A caller found later in Bea's work opens Bea's next plan.
    await counted(sha(2), { forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(2))] });
    assert.deepEqual(store.plans("money-minor").map((plan) => [plan.planId, plan.state]), [
      ["migrate:money-minor:bea:1", "closed"],
      ["migrate:money-minor:bea:2", "open"],
    ]);
  });

  test("an edit task's kept commit writes its part; code on main is carried by the plan's block, which lands", async () => {
    await counted(sha(1), { headUses: [lineUse("orders/report.py")] });
    const [part] = store.plans("money-minor")[0]?.parts ?? [];
    assert.ok(part);
    const [task] = tasks.forSource(`migrate:${part.partId}`);
    assert.ok(task);
    tasks.close(task.sourceKey, "done", "the steward moved orders/report.py", "f".repeat(40));
    await migrationTasksSettled(deps);
    assert.equal(store.part(part.partId)?.state, "written");
    // Code on main lands with the block, so the plan waits for it rather than closing.
    assert.equal(store.plan("migrate:money-minor:tomas:1")?.state, "approved");
    await migrationBlockLanded(deps, "migrate-tomas-money-minor", sha(2));
    assert.deepEqual([store.plan("migrate:money-minor:tomas:1")?.state, store.part(part.partId)?.state], ["landed", "landed"]);
  });

  // #142: migration writes take turns with every other write into the same fork.

  /** `writeDeps` with the ProjectAgent's hook: a kept write asks each waiting write's trial on the new head. */
  const turnDeps = (repo: GitRepo): FixWriteDeps => {
    const wired: FixWriteDeps = {
      ...writeDeps(repo),
      written: async (grant, commit) => {
        await retryWaitingWrites({ ...wired, queueTrial: () => null }, grant, commit);
      },
    };
    return wired;
  };
  const editDeps = (repo: GitRepo): EditWorkDeps => ({
    tasks,
    roster,
    features: project.features,
    routes: new PlanRouteStore(project.sql),
    grants,
    reviews: () => [],
    scopeMap: async () => scopeMapNow,
    running: () => [],
    fix: turnDeps(repo),
    cap: 2,
    leaseMs: 60_000,
    notify: () => undefined,
  });
  /** A migration edit task in Bea's fees fork from Bea's fee split, routed to the fees builder. */
  const feeTask = async (key: string) => {
    const [task] = await deps.openTask(
      {
        key,
        kind: "migration",
        feature: "fee-minor",
        target: "fees",
        targetPerson: "bea",
        places: [{ path: "billing/fees.py", scope: "billing" }],
        instructions: "Move fees.py off fee().",
        verifier: "The retiring-calls check.",
        ref: { plan: "migrate:fee-minor:bea:1", part: key },
      },
      (context) => context,
    );
    assert.ok(task);
    return task;
  };
  const claimRunner = async (fix: FixWriteDeps) => {
    const claim = await claimRunnerWrites(fix, RUNNER);
    assert.ok(claim.status === "ok");
    return claim.writes;
  };

  /** Bea's fee task holds the fork; the approved money part's write waits; the task's commit moves the fork. Answers the re-trial. */
  async function contended(repo: GitRepo) {
    const head = repo.commit({ "billing/fees.py": "x = api.price(a * b)\ny = api.fee(c)\n" }, "Bea's fees checkpoint");
    const trial = await rewritten(head, "--- a/billing/fees.py\n+++ b/billing/fees.py\n@@ -1,2 +1,2 @@\n-x = api.price(a * b)\n+x = a.times(b)\n y = api.fee(c)\n");
    const task = await feeTask("migrate:fee-part");
    const claimed = await claimEditTasks(editDeps(repo), "bea", "br_bea");
    assert.deepEqual(claimed.status === "ok" ? claimed.tasks.map((each) => each.taskId) : null, [task.id]);
    assert.equal(await decide(trial, "passed"), "approved");
    // The task's run holds the fork: the runner's migration write waits for its turn.
    const fix = turnDeps(repo);
    assert.deepEqual(await claimRunner(fix), []);
    const write = grants.get(trial.partId, 1);
    assert.match(grants.waitsFor(write!) ?? "", new RegExp(`the run of edit task ${task.id} holds feature fees's fork`, "u"));
    // The run commits its change; Penguin keeps it and asks the waiting write's trial on the new head.
    const moved = repo.commit({ "billing/rates.py": "RATE = 2\n" }, "fee-minor");
    const reported = await reportEditTask(editDeps(repo), "bea", "br_bea", task.id, { status: "done", outcome: "moved fees.py off fee()", commit: moved });
    assert.equal(reported.status, "ok", JSON.stringify(reported));
    assert.equal(grants.get(taskWriteKey(task.id), 1)?.state, "written");
    const retrial = trials.ofPart("migrate-bea-money-minor", trial.partId);
    assert.ok(retrial);
    assert.deepEqual([retrial.state, retrial.request.target], ["pending", { id: "fees", repo: "feature-fees", sha: moved }]);
    assert.deepEqual(await claimRunner(fix), []);
    return { trial, retrial, moved, fix };
  }

  test("a migration write waits while an edit task's run holds the fork, is tried again on the head the run left, then is written on top", async () => {
    const repo = new GitRepo();
    const { retrial, moved, fix } = await contended(repo);
    trials.record(retrial.id, trialReport(retrial, "passed"));
    assert.equal(await retrialReported(fix, trials.get(retrial.id) as StoredPartTrial), "passed");
    const [write] = await claimRunner(fix);
    assert.deepEqual([write?.spec.parent, write?.spec.rebased], [moved, true]);
    assert.deepEqual(records("money-minor", "plan_part_retrial").map((each) => [each.payload["result"], each.payload["fork_head"]]), [["passed", moved]]);
  });

  test("a migration write whose trial on the new head fails goes back as an edit task", async () => {
    const repo = new GitRepo();
    const { trial, retrial, moved, fix } = await contended(repo);
    trials.record(retrial.id, trialReport(retrial, "failed"));
    assert.equal(await retrialReported(fix, trials.get(retrial.id) as StoredPartTrial), "returned");
    assert.equal(store.part(trial.partId)?.state, "task");
    assert.match(store.part(trial.partId)?.reason ?? "", /The part.s trial on that head failed: test:billing failed/u);
    assert.deepEqual(tasks.forSource(`migrate:${trial.partId}`).map((task) => [task.kind, task.target]), [["migration", "fees"]]);
    assert.equal(grants.get(trial.partId, 1)?.state, "withdrawn");
    assert.deepEqual(records("money-minor", "plan_part_retrial").map((each) => [each.payload["result"], each.payload["fork_head"]]), [["returned", moved]]);
    assert.deepEqual(await claimRunner(fix), []);
  });

  test("a second migration edit task into the same fork waits for the first run's turn to end", async () => {
    const repo = new GitRepo();
    repo.commit({ "billing/fees.py": "y = api.fee(c)\n" }, "Bea's fees checkpoint");
    const first = await feeTask("migrate:fee-a");
    const second = await feeTask("migrate:fee-b");
    const claimed = await claimEditTasks(editDeps(repo), "bea", "br_bea");
    assert.deepEqual(claimed.status === "ok" ? claimed.tasks.map((each) => each.taskId) : null, [first.id]);
    assert.match(writeWaitsFor(grants, tasks.get(second.id)!) ?? "", new RegExp(`the run of edit task ${first.id} holds feature fees's fork`, "u"));
    const moved = repo.commit({ "billing/fees.py": "y = api.fee_minor(c)\n" }, "fee-minor");
    assert.equal((await reportEditTask(editDeps(repo), "bea", "br_bea", first.id, { status: "done", outcome: "moved fees.py", commit: moved })).status, "ok");
    const next = await claimEditTasks(editDeps(repo), "bea", "br_bea");
    assert.deepEqual(next.status === "ok" ? next.tasks.map((each) => each.taskId) : null, [second.id]);
  });

  test("a feature Penguin opens goes through the overlap lock, and the runner writes nothing into it until the lock is approved", async () => {
    // Bea's checkout work runs in orders, which Tomas's block will cover.
    await project.open("checkout", "bea", { scopes: ["orders"] }, { id: "s-bea3", handle: "@bea/orders" });
    const main = new GitRepo();
    const before = main.commit({ "orders/report.py": "t = model.line_total(x)\n" }, "main");
    await counted(sha(1), { headUses: [lineUse("orders/report.py")] });
    const block = "migrate-tomas-money-minor";
    assert.deepEqual(project.overlaps.locksOn(block).map((lock) => [lock.featureId, lock.personId, lock.state]), [["checkout", "bea", "open"]]);
    assert.deepEqual(records(block, "overlap_check").map((each) => (each.payload["locks_opened"] as { feature: string }[]).map((lock) => lock.feature)), [["checkout"]]);
    // An approved part's write into the block waits on the lock.
    const [part] = store.plans("money-minor")[0]?.parts ?? [];
    assert.ok(part);
    store.updatePart(part.partId, { state: "approved", writer: "runner", patch: "--- a/orders/report.py\n+++ b/orders/report.py\n@@ -1 +1 @@\n-t = model.line_total(x)\n+t = model.line_total_minor(x)\n", targetSha: before });
    grants.open("money-minor", "migrate:money-minor:tomas:1", { partId: part.partId, revision: 1 }, block, "runner");
    const locked = { ...writeDeps(main), locked: (featureId: string) => project.overlaps.status(featureId).waitingOn.length > 0 };
    assert.deepEqual(await claimRunnerWrites(locked, RUNNER), { status: "ok", writes: [] });
    await approveOverlap({ db: project.sql, features: project.features, overlaps: project.overlaps, scopeMap: async () => scopeMapNow, sign: (draft) => project.sign(draft) }, "bea", "checkout", block);
    const claim = await claimRunnerWrites(locked, RUNNER);
    assert.ok(claim.status === "ok");
    assert.deepEqual(claim.writes.map((each) => [each.spec.target, each.spec.parent]), [[block, before]]);
  });

  test("a part the rules leave uses in goes to the running feature's builder", async () => {
    await counted(sha(1), { forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(1)), fork("money-minor", [], sha(1))] });
    const [request] = rewriteRuns();
    assert.ok(request);
    const place = { kind: "feature" as const, feature: "fees" };
    const recorded = recordToolResult(runs, RUNNER, request.id, result(sha(1), { rewrites: [{ place, target: "fees", sha: FEES, files: [], patch: PATCH, residual: 1, error: null }] }));
    assert.equal(recorded.status, "recorded");
    if (recorded.status !== "recorded") return;
    await rewritesReported(deps, recorded.run);
    const [part] = store.plans("money-minor")[0]?.parts ?? [];
    assert.deepEqual([part?.writer, part?.state, part?.reason], ["task", "task", "the declared rules leave 1 use of a retiring symbol in the place"]);
    const [task] = tasks.forFeature("fees");
    assert.deepEqual([task?.kind, task?.via, task?.handle, task?.target], ["migration", "builder", "@bea/fees", "fees"]);
    // No feature was opened: a running feature's own changes are fixed in its own fork.
    assert.deepEqual(forked, []);
  });

  test("a later caller joins its owner's open plan; once that plan landed, it opens the owner's next plan", async () => {
    await counted(sha(1), { headUses: [lineUse("orders/report.py")] });
    assert.deepEqual(store.plans("money-minor").map((plan) => plan.planId), ["migrate:money-minor:tomas:1"]);
    // Tomas's checkout feature adds a call in its own changes: its retiring-calls check finds it.
    await project.open("checkout", "tomas", { scopes: ["orders"] }, { id: "s-tomas", handle: "@tomas/orders" });
    await project.checkpoint("checkout", sha(5), BASE, "@tomas/orders");
    const check = runs.insert({
      featureId: "checkout",
      sessionId: PENGUIN_SESSION,
      caller: "penguin",
      tool: "impact",
      input: { feature: "checkout", search: "own" },
      result: "waiting",
      summary: "waits",
      checkpointSha: sha(5),
      durationMs: 0,
      baseSha: sha(1),
    });
    const own = recordToolResult(runs, RUNNER, check.id, { ...result(sha(1), { impact: impact(sha(5), { base: sha(1), forks: [fork("checkout", [lineUse("orders/cart.py")], sha(1))] }) }), checkpoint: sha(5) });
    assert.equal(own.status, "recorded", JSON.stringify(own));
    if (own.status !== "recorded") return;
    assert.deepEqual(await migrationsChecked(deps, own.run), ["migrate:money-minor:tomas:1"]);
    assert.deepEqual(store.plans("money-minor").map((plan) => [plan.planId, plan.parts.map((part) => part.place)]), [
      ["migrate:money-minor:tomas:1", [{ kind: "scope", scope: "orders" }, { kind: "feature", feature: "checkout" }]],
    ]);
    assert.equal(records("money-minor", "migration_joined").length, 1);

    // The plan's block lands; a caller found later opens Tomas's second plan.
    assert.equal(await migrationBlockLanded(deps, "migrate-tomas-money-minor", sha(2)), "migrate:money-minor:tomas:1");
    await counted(sha(3), { headUses: [lineUse("orders/later.py")] });
    assert.deepEqual(
      store.plans("money-minor").map((plan) => [plan.planId, plan.state, plan.block]),
      [
        ["migrate:money-minor:tomas:1", "landed", "migrate-tomas-money-minor"],
        ["migrate:money-minor:tomas:2", "open", "migrate-tomas-money-minor-2"],
      ],
    );
  });

  test("a place with no caller left at a complete count is dropped", async () => {
    await counted(sha(1), { headUses: [lineUse("orders/report.py")], forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(1))] });
    await counted(sha(2), { forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(2))] });
    const tomas = store.plans("money-minor").find((plan) => plan.owner === "tomas");
    assert.deepEqual(tomas?.parts.map((part) => part.state), ["dropped"]);
    // An incomplete count drops nothing.
    await counted(sha(3), { complete: false });
    assert.deepEqual(store.plans("money-minor").find((plan) => plan.owner === "bea")?.parts.map((part) => part.state), ["rewriting"]);
  });

  test("when the originating feature no longer runs, a feature Penguin opens from main for the defining scope's DRI carries the contract step", async () => {
    project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    const outcome = await (async () => {
      const runId = requestRetiringCount(count, "money-minor", sha(4));
      assert.ok(runId !== undefined);
      const recorded = recordToolResult(runs, RUNNER, runId, result(sha(4), { impact: impact(sha(4), { headUses: [feeUse("billing/fees.py")] }) }));
      assert.equal(recorded.status, "recorded");
      return recorded.status === "recorded" ? countReported(count, recorded.run) : undefined;
    })();
    // price is defined in money (Ines) and line_total in orders (Tomas): one carrier per DRI.
    assert.deepEqual(outcome?.proposed.map((each) => [each.feature, each.contracts]), [
      ["contract-ines-money-minor", [PRICE.contract]],
      ["contract-tomas-money-minor", [LINE.contract]],
    ]);
    const carrier = project.features.get("contract-ines-money-minor");
    assert.deepEqual([carrier?.personId, carrier?.repo, carrier?.state], ["ines", "feature-contract-ines-money-minor", "building"]);
    const [proposal] = records("contract-ines-money-minor", "contract_proposed");
    assert.deepEqual([proposal?.author, proposal?.payload["places"], proposal?.payload["approved_by"], proposal?.payload["origin"]], [{ penguin: true }, [], "penguin", "money-minor"]);
    // The removal is an edit task for the steward of the defining scope's DRI, never the carrier's builder.
    const [task] = tasks.forFeature("contract-ines-money-minor");
    assert.deepEqual([task?.kind, task?.handle, task?.via, task?.scopes], ["contract", "@ines/steward", "steward", ["money"]]);
    // The originating feature's contract step shows it approved and carried.
    const step = project.retiring.contractSteps("money-minor").find((each) => each.contract === PRICE.contract);
    assert.deepEqual([step?.state, step?.carrier], ["approved", "contract-ines-money-minor"]);
    // A later count does not carry it again.
    const again = requestRetiringCount(count, "money-minor", sha(6));
    assert.ok(again !== undefined);
    const rerun = recordToolResult(runs, RUNNER, again, result(sha(6), { impact: impact(sha(6), { headUses: [feeUse("billing/fees.py")] }) }));
    assert.ok(rerun.status === "recorded");
    assert.deepEqual((await countReported(count, rerun.run))?.proposed, []);
    // The carrier's block closes the symbol once its facts show it removed: its approved steps are the carrier's.
    assert.deepEqual(project.retiring.approvedSteps("contract-ines-money-minor").map((each) => each.contract), [PRICE.contract]);
    assert.deepEqual(await closeRemoved(count, "contract-ines-money-minor", sha(7)), []);
  });
});
