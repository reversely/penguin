// The migration plans of a split (#131, PRD 0.5 section 4.2 step 2, Migrate): after a count of the
// remaining callers, each owner group of the originating feature becomes one plan with one part per
// place; the runner writes the parts the declared rules rewrite whole and every other part is an edit
// task for the place's builder or the steward of its scope's DRI; a later caller joins its owner's open
// plan or, once that plan landed, opens the next; and when the originating feature no longer runs, the
// contract step is carried by a feature Penguin opens from main for the defining scope's DRI.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  type AgentToolResult,
  type ImpactFork,
  type ImpactReport,
  type ImpactUse,
  type MigrationRewritePlace,
  type Plan,
  type RewriteRule,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore } from "../src/agent-tools.ts";
import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore } from "../src/edit-tasks.ts";
import { editRouting } from "../src/edit-work.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { carryContract, migrationBlockLanded, migrationsChecked, migrationsCounted, migrationTrialReported, MigrationStore, rewritesReported, type MigrationDeps } from "../src/migration-plans.ts";
import { PartTrialStore, type StoredPartTrial } from "../src/part-trial.ts";
import { closeRemoved, countReported, PENGUIN_SESSION, requestRetiringCount, type RetiringCountDeps } from "../src/retiring-count.ts";
import { ReviewStore } from "../src/review-submit.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts, depends_on: [] });
const scopeMap = parseScopeMap({
  scopes: [
    scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price"]),
    scope("orders", "tomas", ["orders/"], ["orders/model.py::line_total"]),
    scope("billing", "bea", ["billing/"], ["billing/api.py::fee"]),
  ],
});

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
  let deps: MigrationDeps;
  let count: RetiringCountDeps;
  let forked: string[];

  beforeEach(async () => {
    project = new PlanProject(scopeMap, "");
    runs = new AgentToolStore(project.sql);
    store = new MigrationStore(project.sql);
    tasks = new EditTaskStore(project.sql);
    roster = new EditRoster(project.sql, new IdentityStore(project.sql));
    trials = new PartTrialStore(project.sql);
    forked = [];
    deps = {
      store,
      features: project.features,
      runs,
      retiring: project.retiring,
      trials,
      reviews: new ReviewStore(project.sql),
      scopeMap: async () => scopeMap,
      sign: (draft) => project.sign(draft),
      openTask: async (source, adjust) => {
        roster.sync(scopeMap, project.features.list());
        return tasks.open(source, adjust(editRouting({ roster, features: project.features }, scopeMap, () => true)));
      },
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

  test("the runner writes a part its rules rewrite whole, and its trial decides it; any other part is an edit task", async () => {
    await counted(sha(1), { forks: [fork("fees", [priceUse("billing/fees.py", "billing")], sha(1)), fork("money-minor", [], sha(1))] });
    const [request] = rewriteRuns();
    assert.ok(request);
    const rewrite = (residual: number): MigrationRewritePlace => ({
      place: { kind: "feature", feature: "fees" },
      target: "fees",
      sha: FEES,
      files: [{ path: "billing/fees.py", rules: ["price-times"] }],
      patch: PATCH,
      residual,
      error: null,
    });
    const recorded = recordToolResult(runs, RUNNER, request.id, result(sha(1), { rewrites: [rewrite(0)] }));
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    if (recorded.status !== "recorded") return;
    assert.deepEqual(await rewritesReported(deps, recorded.run), ["migrate:money-minor:bea:1"]);
    const [part] = store.plans("money-minor")[0]?.parts ?? [];
    assert.deepEqual([part?.writer, part?.state, part?.reason], ["runner", "trial", "the rules price-times rewrite every use in the place"]);
    assert.deepEqual(records("money-minor", "migration_routed").map((each) => each.payload["parts"]), [
      [{ part: part?.partId, place: { kind: "feature", feature: "fees" }, writer: "runner", reason: "the rules price-times rewrite every use in the place" }],
    ]);
    // The trial applies the runner's patch to Bea's fork head, merged with main at the count.
    const [trial] = trials.current("migrate-bea-money-minor");
    assert.deepEqual([trial?.request.fork, trial?.request.checkpoint, trial?.request.target, trial?.request.fix, trial?.request.commandIds], [
      "base",
      sha(1),
      { id: "fees", repo: "feature-fees", sha: FEES },
      { kind: "patch", patch: PATCH },
      ["test:billing"],
    ]);
    assert.ok(trial);
    const report = (status: "passed" | "failed") => ({
      schemaVersion: 1 as const,
      trialId: trial.id,
      partId: trial.partId,
      revision: 1,
      checkpoint: sha(1),
      target: FEES,
      status: "built" as const,
      tree: sha(9),
      reason: null,
      tests: [{ scopeId: "billing", commandId: "test:billing", status, breaks: status === "failed" ? ["billing/tests/test_fees.py::test_fee"] : [], reason: null, durationMs: 3 }],
      reviews: [],
      durationMs: 9,
    });
    // Clean tests, no form yet: the part waits for the form, which Bea's steward is asked for.
    await migrationTrialReported(deps, trials.record(trial.id, report("passed")) as StoredPartTrial);
    assert.deepEqual([store.part(trial.partId)?.state, store.part(trial.partId)?.reason], ["waiting_review", "the review form of billing is missing"]);
    const [review] = tasks.forFeature("migrate-bea-money-minor").filter((each) => each.kind === "review");
    assert.deepEqual([review?.handle, review?.scopes], ["@bea/steward", ["billing"]]);
    // A failing test on the trial tree sends the part to its owner in person.
    const { trialId: _trialId, ...spec } = trial.request;
    const again = trials.queue(spec, ["billing"]);
    await migrationTrialReported(deps, trials.record(again.id, { ...report("failed"), trialId: again.id }) as StoredPartTrial);
    assert.equal(store.part(trial.partId)?.state, "in_person");
    assert.deepEqual(records("money-minor", "migration_part_decided").map((each) => each.payload["decision"]), ["waiting_review", "in_person"]);
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
