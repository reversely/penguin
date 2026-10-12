// Retiring symbols in the ProjectAgent (#113, PRD 0.5 section 4.2 step 2): a stored plan's
// declaration becomes signed project data, only for contracts of the feature's own area and only from
// its own person's agent; each checkpoint then asks the check runner for one retiring-calls check; an
// agent's `impact` call carries the symbols for the migration groups; `apply_fix` takes a retiring
// symbol's rewrite rules by id.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { canonicalBytes, fromBase64Url } from "@penguin/issues";
import {
  checkPlanFactsReport,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  retiringCallDecisions,
  TOOL_RESULT_SCHEMA_VERSION,
  type ImpactReport,
  type PlanFactsReport,
  type RetiringDeclaration,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { claimToolRuns, recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore, requestRetiringCheck, requestTool, type AgentToolDeps } from "../src/agent-tools.ts";
import type { Session } from "../src/session-store.ts";
import { GitRepo } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts, depends_on: [] });
const scopeMap = parseScopeMap({
  scopes: [scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price"]), scope("billing", "bea", ["billing/"], ["billing/fees.py::fee"])],
});

const PRICE = { contract: "shared/money/api.py::price", replacement: "shared/money/api.py::price_minor" };
const RULE = { id: "price-minor", contract: "shared/money/api.py::price", kind: "expression", pattern: "price($item)", replacement: "price_minor($item) / 100", imports: [] };
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;

function impactReport(base: string, head: string): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base,
    head,
    // The expand step only adds: the old function stays beside the new one.
    changes: [{ symbol: "shared.money.api.price_minor", path: "shared/money/api.py", line: 4, kind: "function", change: "added", scope: "money", contract: null }],
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
  };
}

describe("declaring retiring symbols", () => {
  let project: PlanProject;
  let main: string;
  let checkpoint: string;

  beforeEach(async () => {
    const repo = new GitRepo();
    main = repo.commit({ "shared/money/api.py": "def price(item):\n    return item.amount\n", "billing/fees.py": "def fee(x):\n    return x\n" }, "Base");
    checkpoint = repo.commit(
      { "shared/money/api.py": "def price(item):\n    return item.amount\n\n\ndef price_minor(item):\n    return item.amount_minor\n" },
      "Add price_minor beside price",
    );
    project = new PlanProject(scopeMap, repo.dir);
    await project.open("money-type", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
    await project.checkpoint("money-type", checkpoint, main, "@ines/money");
  });

  /** The runner reports the facts run, with the rules applied nowhere. */
  function reportFacts(): void {
    const [request] = project.facts.pending();
    assert.ok(request);
    const report: PlanFactsReport = {
      impact: impactReport(main, checkpoint),
      impactError: null,
      results: [],
      durationMs: 5,
      rewrites: { refused: [], places: (request.rewrites?.places ?? []).map((place) => ({ target: place.target, files: [], error: null })) },
    };
    assert.deepEqual(checkPlanFactsReport(report), []);
    assert.equal(project.facts.record(request.runId, "runner-1", JSON.parse(JSON.stringify(report))).status, "recorded");
  }

  test("a stored plan with no place marks its contract retiring, with its rewrite rule, in a signed record", async () => {
    const waiting = await project.propose("ines", "s-ines", "money-type", [], [RULE], [PRICE]);
    assert.equal(waiting.status, "missing");
    // Nothing is declared until the plan is stored.
    assert.deepEqual(project.retiring.list(), []);
    reportFacts();
    const outcome = await project.propose("ines", "s-ines", "money-type", [], [RULE], [PRICE]);
    assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 1_000));
    if (outcome.status !== "stored") return;
    assert.deepEqual(outcome.plan.retiring, [PRICE]);
    assert.deepEqual(project.records("money-type", "propose_plan")[0]?.payload["retiring"], [PRICE]);

    const [record] = project.records("money-type", "retire_symbols");
    assert.deepEqual(record?.payload, { plan_id: "money-type/v1", symbols: [{ ...PRICE, rules: ["price-minor"] }] });
    assert.deepEqual(record?.author, { identity: "@ines/money" });
    const { signature, ...unsigned } = record as NonNullable<typeof record>;
    const valid = await crypto.subtle.verify("Ed25519", await project.publicKey(), fromBase64Url(signature) as Uint8Array<ArrayBuffer>, canonicalBytes(unsigned) as Uint8Array<ArrayBuffer>);
    assert.ok(valid);

    const [declared] = project.retiring.list();
    assert.deepEqual(
      [declared?.contract, declared?.replacement, declared?.feature, declared?.person, declared?.recordId, declared?.rules.map((rule) => rule.id)],
      [PRICE.contract, PRICE.replacement, "money-type", "ines", record?.record_id, ["price-minor"]],
    );
  });

  test("a rule for a retiring contract the change does not touch is not refused; without the declaration it is", async () => {
    await project.propose("ines", "s-ines", "money-type", [], [RULE]);
    reportFacts();
    const refused = await project.propose("ines", "s-ines", "money-type", [], [RULE]);
    assert.equal(refused.status, "missing");
    if (refused.status !== "missing") return;
    assert.deepEqual(refused.missing.map((item) => [item.code, item.rule]), [["rule_refused", "price-minor"]]);
    assert.match(refused.missing[0]?.message ?? "", /does not touch and the plan does not retire/u);
  });

  test("only a contract of the feature's own area, held by no other feature, may be declared", async () => {
    for (const [retiring, reason, pattern] of [
      [[{ contract: "billing/fees.py::fee", replacement: "billing/fees.py::fee_minor" }], "invalid", /belongs to scope billing/u],
      [[{ contract: "shared/money/api.py::cost", replacement: "shared/money/api.py::price_minor" }], "invalid", /not a contract/u],
      [[{ contract: "shared/money/api.py::price" }], "invalid", /replacement/u],
    ] as const) {
      const outcome = await project.propose("ines", "s-ines", "money-type", [], [], retiring);
      assert.equal(outcome.status, "rejected");
      assert.equal((outcome as { reason: string }).reason, reason);
      assert.match((outcome as { message: string }).message, pattern);
    }
    // Another person's session cannot propose the plan at all, so it cannot retire anything.
    project.sessions.set("s-bea", { person: "bea", handle: "@bea/billing" });
    assert.equal((await project.propose("bea", "s-bea", "money-type", [], [], [PRICE])).status, "rejected");

    await project.propose("ines", "s-ines", "money-type", [], [], [PRICE]);
    reportFacts();
    assert.equal((await project.propose("ines", "s-ines", "money-type", [], [], [PRICE])).status, "stored");
    await project.open("money-two", "ines", { scopes: ["money"] }, { id: "s-ines-2", handle: "@ines/two" });
    await project.checkpoint("money-two", checkpoint, main, "@ines/two");
    const held = await project.propose("ines", "s-ines-2", "money-two", [], [], [PRICE]);
    assert.deepEqual([held.status, (held as { reason: string }).reason], ["rejected", "conflict"]);
  });
});

describe("the retiring-calls check and the tools", () => {
  const BASE = "a".repeat(40);
  const CHECKPOINT = "b".repeat(40);
  let project: PlanProject;
  let runs: AgentToolStore;
  let declared: RetiringDeclaration[];
  let deps: AgentToolDeps;

  const session = (id: string, handle: string): Session => ({
    id,
    identityId: `identity-${handle}`,
    handle,
    vendor: "test",
    worktreeId: "wt",
    branch: "main",
    status: "running",
    currentIssueId: null,
    lastSeen: new Date(0).toISOString(),
  });

  beforeEach(async () => {
    project = new PlanProject(scopeMap, new GitRepo().dir);
    runs = new AgentToolStore(project.sql);
    await project.open("billing-v2", "bea", { scopes: ["billing"] }, { id: "s-bea", handle: "@bea/billing" });
    await project.checkpoint("billing-v2", CHECKPOINT, BASE, "@bea/billing");
    declared = [];
    deps = {
      features: project.features,
      runs,
      scopeMap: async () => scopeMap,
      heartbeat: (caller, id) => project.heartbeat(caller, id),
      session: (id) => (id === "s-bea" ? session(id, "@bea/billing") : undefined),
      identity: () => ({ handle: "@bea/billing", ownerId: "bea", teamOwners: [], charterScopes: ["billing"], charterPaths: [] }),
      baseline: async () => BASE,
      retiring: () => declared,
    };
  });

  const declare = () => {
    declared = [{ ...PRICE, feature: "money-type", planId: "money-type/v1", person: "ines", rules: [RULE] as never, recordId: "r1", declaredAt: new Date(0).toISOString() }];
  };

  test("a checkpoint asks for one check of its own changes, only while symbols are retiring", async () => {
    const feature = project.features.get("billing-v2");
    assert.ok(feature);
    assert.equal(await requestRetiringCheck(deps, feature, "s-bea", CHECKPOINT), undefined);
    declare();
    const id = await requestRetiringCheck(deps, feature, "s-bea", CHECKPOINT);
    assert.ok(id !== undefined);
    // The same checkpoint is checked once; a session Penguin does not know asks for nothing.
    assert.equal(await requestRetiringCheck(deps, feature, "s-bea", CHECKPOINT), undefined);
    assert.equal(await requestRetiringCheck(deps, feature, "s-gone", "c".repeat(40)), undefined);

    const claim = claimToolRuns({ runs, features: project.features, identity: deps.identity }, RUNNER);
    assert.equal(claim.status, "ok");
    const [claimed] = claim.status === "ok" ? claim.runs : [];
    assert.deepEqual([claimed?.tool, claimed?.base, claimed?.checkpoint, claimed?.input["search"]], ["impact", BASE, CHECKPOINT, "own"]);
    assert.deepEqual((claimed?.input["retiring"] as RetiringDeclaration[]).map((each) => [each.contract, each.rules.map((rule) => rule.id)]), [[PRICE.contract, ["price-minor"]]]);

    // The runner's result: one step for the own change's new call, which the rule rewrites.
    const impact: ImpactReport = {
      ...impactReport(BASE, CHECKPOINT),
      changes: [],
      forks: [{ id: "billing-v2", sha: CHECKPOINT, scopes: [], since: BASE, mergeBase: BASE, carried: 0, uses: [{ path: "billing/new.py", line: 3, kind: "call", symbol: "shared.money.api.price", name: "price", scope: "billing" }], errors: [] }],
    };
    const context = { charter: { handle: "@bea/billing", person: "bea", scopes: ["billing"], paths: [] }, scopeOf: () => "billing", ownerOf: () => "bea", ownerAgentOf: () => "@bea/billing", roundLimit: 3 };
    const decisions = retiringCallDecisions(impact, "billing-v2", declared, context, CHECKPOINT, () => ["price-minor"]);
    const body = { schemaVersion: TOOL_RESULT_SCHEMA_VERSION, tool: "impact", base: BASE, checkpoint: CHECKPOINT, result: "found", summary: "1 place", impact, checks: [], decisions, fix: null, fixRef: null, pushed: false, durationMs: 4 };
    const recorded = recordToolResult(runs, RUNNER, id, JSON.parse(JSON.stringify(body)));
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    assert.deepEqual(runs.get(id)?.outcome?.decisions.map((each) => [each.step, each.fix?.commandId]), [[3, "fix:python-codemod"]]);
    assert.deepEqual(runs.deliver("s-bea").map((each) => each.runId), [id]);
  });

  test("impact carries the retiring symbols; apply_fix takes a retiring symbol's rules by id, inside the charter", async () => {
    declare();
    const impact = await requestTool(deps, "bea", "s-bea", "impact", { feature: "billing-v2" });
    assert.equal(impact.status, "ok");
    assert.deepEqual((impact.status === "ok" ? (impact.input["retiring"] as RetiringDeclaration[]) : []).map((each) => each.contract), [PRICE.contract]);

    const fix = await requestTool(deps, "bea", "s-bea", "apply_fix", { feature: "billing-v2", kind: "codemod", paths: ["billing/new.py"], rules: ["price-minor"] });
    assert.equal(fix.status, "ok", JSON.stringify(fix));
    assert.deepEqual(fix.status === "ok" ? fix.input["rules"] : null, [RULE]);
    for (const [input, pattern] of [
      [{ kind: "codemod", paths: ["billing/new.py"], rules: ["made-up"] }, /not a rewrite rule of a retiring symbol/u],
      [{ kind: "format", paths: ["billing/new.py"], rules: ["price-minor"] }, /only a codemod takes edits or rules/u],
      [{ kind: "codemod", paths: ["billing/new.py"], rules: ["price-minor"], edits: [{ kind: "rename", from: "a.b", to: "a.c" }] }, /edits or rules, not both/u],
      [{ kind: "codemod", paths: ["shared/money/api.py"], rules: ["price-minor"] }, /charter/u],
    ] as const) {
      const refused = await requestTool(deps, "bea", "s-bea", "apply_fix", { feature: "billing-v2", ...input });
      assert.equal(refused.status, "rejected", JSON.stringify(input));
      assert.match((refused as { message: string }).message, pattern);
    }
  });
});
