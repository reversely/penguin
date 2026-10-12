// The contract step (#117, PRD 0.5 section 4.2 step 2): after each promotion Penguin counts the callers
// of each retiring symbol on main and in every running feature's own changes, in one request of its
// own; at zero it proposes removing the symbol on the originating feature, approved by Penguin with no
// place; a caller coming back withdraws it; and the block that removes it closes the retiring record.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  checkPlanFactsReport,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  type AgentToolResult,
  type ImpactChange,
  type ImpactFork,
  type ImpactReport,
  type ImpactUse,
  type PlanFactsReport,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { claimToolRuns, recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore } from "../src/agent-tools.ts";
import { contractWork, ContractSplitStore, scheduleSort, type ContractSplitDeps } from "../src/contract-split.ts";
import { CALLERS_SEARCH, closeRemoved, countReported, PENGUIN_SESSION, requestRetiringCount, type CountOutcome, type RetiringCountDeps } from "../src/retiring-count.ts";
import { GitRepo } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts, depends_on: [] });
const scopeMap = parseScopeMap({
  scopes: [scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price"]), scope("billing", "bea", ["billing/"], [])],
});

const BASE = "a".repeat(40);
const EXPAND = "b".repeat(40);
const FEES = "c".repeat(40);
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const PRICE = { contract: "shared/money/api.py::price", replacement: "shared/money/api.py::price_minor" };
const DOTTED = "shared.money.api.price";

const sha = (n: number) => n.toString(16).padStart(40, "d");
const use = (path: string, scope: string): ImpactUse => ({ path, line: 3, kind: "call", symbol: DOTTED, name: "price", scope });
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

describe("counting the callers of retiring symbols after each promotion and the contract step", () => {
  let project: PlanProject;
  let runs: AgentToolStore;
  let deps: RetiringCountDeps;
  let split: ContractSplitDeps;
  let notified: string[];

  beforeEach(async () => {
    project = new PlanProject(scopeMap, new GitRepo().dir);
    runs = new AgentToolStore(project.sql);
    notified = [];
    deps = { features: project.features, runs, retiring: project.retiring, facts: project.facts, sign: (draft) => project.sign(draft), notify: (person) => notified.push(person) };
    split = {
      features: project.features,
      facts: project.facts,
      splits: new ContractSplitStore(project.sql),
      sign: (draft) => project.sign(draft),
      dependents: () => [],
      contractSteps: (id) => project.retiring.contractSteps(id),
    };
    // Ines's split is on main at EXPAND and price retires; Bea's fees feature runs beside it.
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
    await project.checkpoint("money-minor", EXPAND, BASE, "@ines/money");
    project.retiring.declareSplit("money-minor", "ines", [PRICE], "record-split");
    await project.open("fees", "bea", { scopes: ["billing"] }, { id: "s-bea", handle: "@bea/billing" });
    await project.checkpoint("fees", FEES, BASE, "@bea/billing");
  });

  /** Main moved to `main`; Penguin asks for the count and the runner reports `uses` in Bea's own changes. */
  async function promote(main: string, fees: ImpactUse[], fields: Partial<ImpactReport> = {}): Promise<CountOutcome | undefined> {
    const runId = requestRetiringCount(deps, "money-minor", main);
    assert.ok(runId !== undefined);
    const claimed = await claimToolRuns({ runs, features: project.features, identity: () => undefined }, RUNNER);
    assert.equal(claimed.status, "ok");
    const report = impact(main, { forks: [fork("fees", fees, main), fork("money-minor", [], main)], ...fields });
    const result: AgentToolResult = {
      schemaVersion: 1,
      tool: "impact",
      base: main,
      checkpoint: main,
      result: "found",
      summary: "counted",
      impact: report,
      checks: [],
      decisions: [],
      fix: null,
      fixRef: null,
      pushed: false,
      durationMs: 4,
    };
    const recorded = recordToolResult(runs, RUNNER, runId, result);
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    return recorded.status === "recorded" ? countReported(deps, recorded.run) : undefined;
  }

  const steps = () => project.retiring.contractSteps("money-minor").map((each) => [each.contract, each.state, each.callers]);

  test("each promotion asks for one count of its own, claimed with every running feature and no agent's charter", async () => {
    const runId = requestRetiringCount(deps, "money-minor", sha(1));
    assert.ok(runId !== undefined);
    // The same promotion is counted once.
    assert.equal(requestRetiringCount(deps, "money-minor", sha(1)), undefined);
    const run = runs.get(runId);
    assert.deepEqual([run?.sessionId, run?.caller, run?.tool, run?.input["search"], run?.baseSha, run?.checkpointSha], [PENGUIN_SESSION, "penguin", "impact", CALLERS_SEARCH, sha(1), sha(1)]);
    const claimed = await claimToolRuns({ runs, features: project.features, identity: () => undefined }, RUNNER);
    const [claim] = claimed.status === "ok" ? claimed.runs : [];
    assert.deepEqual([claim?.fork, claim?.base, claim?.charter.handle, claim?.charter.scopes], ["feature-money-minor", sha(1), "penguin", []]);
    // The promoted feature still runs, so its own changes are searched too.
    assert.deepEqual(claim?.forks.map((each) => each.feature), ["fees", "money-minor"]);
    // No one is asked and nothing is delivered to an agent session.
    assert.deepEqual(runs.deliver("s-ines"), []);
  });

  test("a project that retires nothing asks for no count", async () => {
    const empty = new PlanProject(scopeMap, new GitRepo().dir);
    await empty.open("money-minor", "ines", { scopes: ["money"] });
    assert.equal(requestRetiringCount({ ...deps, features: empty.features, retiring: empty.retiring }, "money-minor", sha(1)), undefined);
  });

  test("while one caller remains in a running feature's own changes, nothing is proposed", async () => {
    const counted = await promote(sha(1), [use("billing/fees.py", "billing")]);
    assert.deepEqual(counted?.counts, [{ contract: PRICE.contract, onMain: 0, features: [{ feature: "fees", uses: 1 }], callers: 1 }]);
    assert.deepEqual([counted?.proposed, counted?.withdrawn], [[], []]);
    assert.deepEqual(steps(), [[PRICE.contract, "callers_left", 1]]);
    assert.deepEqual(project.records("money-minor", "contract_proposed"), []);
  });

  test("at zero Penguin proposes removing the symbol on the originating feature and approves it, with no place", async () => {
    await promote(sha(1), [use("billing/fees.py", "billing")]);
    const counted = await promote(sha(2), []);
    assert.deepEqual(counted?.counts?.map((each) => each.callers), [0]);
    assert.deepEqual(counted?.proposed.map((each) => [each.feature, each.contracts]), [["money-minor", [PRICE.contract]]]);
    const [record] = project.records("money-minor", "contract_proposed");
    assert.deepEqual(record?.author, { penguin: true });
    assert.deepEqual([record?.payload["places"], record?.payload["approved_by"], record?.payload["callers"], record?.payload["promotion"]], [[], "penguin", 0, sha(2)]);
    assert.deepEqual(record?.payload["symbols"], [PRICE]);
    assert.deepEqual(steps(), [[PRICE.contract, "approved", 0]]);
    assert.deepEqual(notified, ["ines"]);
    const work = contractWork(split, project.features.get("money-minor") as NonNullable<ReturnType<typeof project.features.get>>, scopeMap);
    assert.equal(work.contractStep[0]?.recordId, record?.record_id);
    assert.equal(
      work.nextStep,
      `Contract: no caller of ${PRICE.contract} is left on main or in any running feature's own changes (counted after promotion ${sha(2).slice(0, 12)}). ` +
        "Penguin approved removing it: the plan has no places, so no person is asked. Remove it from your fork, report that as a checkpoint " +
        "and call land_feature. Penguin promotes the block and closes each removed symbol's retiring record.",
    );
    // A later count at zero proposes nothing twice.
    assert.deepEqual((await promote(sha(3), []))?.proposed, []);
    assert.equal(project.records("money-minor", "contract_proposed").length, 1);
  });

  test("a caller that comes back withdraws Penguin's approval", async () => {
    await promote(sha(1), []);
    const counted = await promote(sha(2), [use("billing/fees.py", "billing")]);
    assert.deepEqual(counted?.withdrawn.map((each) => [each.feature, each.contracts]), [["money-minor", [PRICE.contract]]]);
    assert.equal(project.records("money-minor", "contract_withdrawn").length, 1);
    assert.deepEqual(steps(), [[PRICE.contract, "callers_left", 1]]);
  });

  test("a caller on main counts like one in a running feature", async () => {
    const counted = await promote(sha(1), [], { headUses: [use("billing/invoice.py", "billing")] });
    assert.deepEqual(counted?.counts, [{ contract: PRICE.contract, onMain: 1, features: [], callers: 1 }]);
    assert.deepEqual(counted?.proposed, []);
  });

  test("an incomplete count proves nothing: no caller is known and nothing is proposed", async () => {
    const counted = await promote(sha(1), [], { forks: [{ ...fork("fees", [], sha(1)), errors: [{ kind: "syntax", path: "billing/fees.py", message: "invalid syntax" }] }] });
    assert.deepEqual([counted?.counts, counted?.proposed], [null, []]);
    assert.deepEqual(steps(), [[PRICE.contract, "counting", null]]);
  });

  test("a symbol whose originating feature has landed stays retiring with no callers", async () => {
    project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    const counted = await promote(sha(1), []);
    assert.deepEqual(counted?.proposed, []);
    assert.deepEqual(steps(), [[PRICE.contract, "no_callers", 0]]);
  });

  /** Ines's agent reports `checkpoint`; the facts run's contract diff holds `changes`. */
  async function landedCheckpoint(checkpoint: string, changes: ImpactChange[]): Promise<void> {
    await project.checkpoint("money-minor", checkpoint, sha(2), "@ines/money");
    const run = scheduleSort(split, project.features.get("money-minor") as NonNullable<ReturnType<typeof project.features.get>>, sha(2), scopeMap);
    assert.ok(run);
    const facts: PlanFactsReport = { impact: impact(checkpoint, { base: sha(2), changes }), impactError: null, results: [], durationMs: 5 };
    assert.deepEqual(checkPlanFactsReport(facts), []);
    assert.equal(project.facts.record(run.runId, "runner-1", JSON.parse(JSON.stringify(facts))).status, "recorded");
  }

  const removal: ImpactChange = { symbol: DOTTED, path: "shared/money/api.py", line: 4, kind: "function", change: "removed", scope: "money", contract: PRICE.contract };

  test("the block that removes the symbol closes its retiring record as removed", async () => {
    await promote(sha(1), []);
    const LANDED = sha(9);
    await landedCheckpoint(LANDED, [removal]);
    project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    assert.deepEqual(await closeRemoved(deps, "money-minor", LANDED), [PRICE.contract]);
    // No check names it as retiring any more; a later call fails the normal checks on the missing name.
    assert.deepEqual(project.retiring.list(), []);
    assert.equal(requestRetiringCount(deps, "money-minor", LANDED), undefined);
    const [record] = project.records("money-minor", "symbols_removed");
    assert.deepEqual([record?.payload["promotion"], record?.payload["symbols"]], [LANDED, [{ ...PRICE, approval: project.records("money-minor", "contract_proposed")[0]?.record_id }]]);
    const [entry] = project.retiring.contractSteps("money-minor");
    assert.deepEqual([entry?.state, entry?.removedPromotion, entry?.removedRecordId], ["removed", LANDED, record?.record_id]);
  });

  test("a block whose checkpoint keeps the symbol closes nothing", async () => {
    await promote(sha(1), []);
    const LANDED = sha(9);
    await landedCheckpoint(LANDED, [{ ...removal, change: "modified" }]);
    assert.deepEqual(await closeRemoved(deps, "money-minor", LANDED), []);
    assert.deepEqual(steps(), [[PRICE.contract, "approved", 0]]);
    assert.deepEqual(project.records("money-minor", "symbols_removed"), []);
  });
});
