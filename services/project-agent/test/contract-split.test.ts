// Sorting a contract diff and splitting a feature in the ProjectAgent (#116, PRD 0.5 section 4.2
// steps 1 and 2): one facts run per checkpoint, reused by the plan; the split recorded once with a
// signed record; the agent's next step for each sort; `apply_fix` with `expand: true` deriving the
// codemod from the split; and the old names retiring once the expand reaches main.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  checkPlanFactsReport,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  type ImpactChange,
  type ImpactReport,
  type ImpactUse,
  type PlanFactsReport,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { AgentToolStore, requestTool, type AgentToolDeps } from "../src/agent-tools.ts";
import { contractWork, ContractSplitStore, recordSplit, retireSplit, scheduleSort, splitReplacements, type ContractSplitDeps } from "../src/contract-split.ts";
import { splitPlanId } from "../src/retiring-store.ts";
import type { Session } from "../src/session-store.ts";
import { GitRepo } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[], depends: string[] = []) => ({
  id,
  name: id,
  owner,
  paths,
  test_command: "true",
  contracts,
  depends_on: depends.map((each) => ({ scope: each, kind: "import" })),
});
const scopeMap = parseScopeMap({
  scopes: [
    scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price", "shared/money/api.py::total"]),
    scope("billing", "bea", ["billing/"], [], ["money"]),
  ],
});

const BASE = "a".repeat(40);
const CHECKPOINT = "b".repeat(40);

const use = (symbol: string, scope: string, path = "billing/fees.py"): ImpactUse => ({ path, line: 3, kind: "call", symbol, name: symbol.split(".").at(-1) as string, scope });
const RENAMED: ImpactChange = {
  symbol: "shared.money.api.price",
  path: "shared/money/api.py",
  line: 1,
  kind: "function",
  change: "renamed",
  scope: "money",
  contract: "shared/money/api.py::price",
  to: { symbol: "shared.money.api.price_minor", path: "shared/money/api.py", line: 1 },
};
const RETYPED: ImpactChange = { ...RENAMED, symbol: "shared.money.api.total", change: "modified", contract: "shared/money/api.py::total", line: 5 };
delete (RETYPED as { to?: unknown }).to;
const BEHAVIOUR: ImpactChange = { ...RETYPED, symbol: "shared.money.api.round_cents", contract: null, line: 9 };

function impact(fields: Partial<ImpactReport>): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: BASE,
    head: CHECKPOINT,
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

describe("sorting each checkpoint's contract diff and splitting the feature", () => {
  let project: PlanProject;
  let splits: ContractSplitStore;
  let deps: ContractSplitDeps;
  let notified: string[];

  beforeEach(async () => {
    project = new PlanProject(scopeMap, new GitRepo().dir);
    splits = new ContractSplitStore(project.sql);
    notified = [];
    deps = {
      features: project.features,
      facts: project.facts,
      splits,
      sign: (draft) => project.sign(draft),
      dependents: (id) => project.overlaps.dependents(id),
      retiring: project.retiring,
      notify: (person) => notified.push(person),
    };
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
  });

  const feature = () => project.features.get("money-minor") as NonNullable<ReturnType<typeof project.features.get>>;

  /** The checkpoint is reported; its facts run is reused or scheduled, as the checkpoint hook does. */
  async function checkpoint(): Promise<string> {
    await project.checkpoint("money-minor", CHECKPOINT, BASE, "@ines/money");
    const run = scheduleSort(deps, feature(), BASE, scopeMap);
    assert.ok(run);
    return run.runId;
  }

  /** The check runner reports the facts run with this contract diff. */
  function report(runId: string, diff: Partial<ImpactReport>): void {
    const facts: PlanFactsReport = { impact: impact(diff), impactError: null, results: [], durationMs: 5 };
    assert.deepEqual(checkPlanFactsReport(facts), []);
    assert.equal(project.facts.record(runId, "runner-1", JSON.parse(JSON.stringify(facts))).status, "recorded");
  }

  test("an open feature with no checkpoint has nothing to sort and is told when it will be sorted", () => {
    const work = contractWork(deps, feature(), scopeMap);
    assert.deepEqual([work.state, work.factsRun, work.split], ["no_checkpoint", null, null]);
    assert.equal(work.nextStep, "Penguin sorts your feature's contract diff at its first checkpoint; report one with report_checkpoint.");
  });

  test("one facts run per checkpoint: the sort schedules it, a second sort and the plan reuse it", async () => {
    const runId = await checkpoint();
    assert.equal(scheduleSort(deps, feature(), BASE, scopeMap)?.runId, runId);
    // propose_plan with no rules looks the run up the same way and takes it.
    assert.equal(project.facts.forCheckpoint("money-minor", CHECKPOINT, [])?.runId, runId);
    assert.deepEqual(
      project.facts.pending().map((request) => request.runId),
      [runId],
    );
    const work = contractWork(deps, feature(), scopeMap);
    assert.equal(work.state, "waiting");
    assert.equal(work.nextStep, `Penguin sorts checkpoint ${CHECKPOINT.slice(0, 12)} once the check runner reports facts run ${runId}.`);
  });

  test("an incompatible entry records the split once, signed, and the next step is expand first", async () => {
    const runId = await checkpoint();
    report(runId, {
      changes: [RENAMED, RETYPED, BEHAVIOUR],
      signatures: [{ symbol: RETYPED.symbol, path: RETYPED.path, line: 5, before: "(prices: list[float]) -> float", after: "(prices: list[Money]) -> Money", added: [], removed: [], breaking: false, reasons: [] }],
      headUses: [use(RENAMED.symbol, "billing"), use(RETYPED.symbol, "billing"), use(BEHAVIOUR.symbol, "billing"), use(RENAMED.symbol, "money", "shared/money/cart.py")],
    });
    const split = await recordSplit(deps, feature(), scopeMap);
    assert.deepEqual([split?.state, split?.entries.map((entry) => entry.symbol)], ["expand_first", [RENAMED.symbol, RETYPED.symbol]]);
    assert.equal(project.records("money-minor", "contract_split").length, 1);
    assert.deepEqual(notified, ["ines"]);
    // Recording again adds nothing and signs nothing.
    await recordSplit(deps, feature(), scopeMap);
    assert.equal(project.records("money-minor", "contract_split").length, 1);

    const work = contractWork(deps, feature(), scopeMap);
    assert.deepEqual([work.decision, work.counts], ["split", { additive: 0, compatible: 0, incompatible: 2, behaviour: 1 }]);
    assert.deepEqual(
      work.entries.map((entry) => [entry.sort, entry.symbol]),
      [
        ["incompatible", RENAMED.symbol],
        ["incompatible", RETYPED.symbol],
        ["behaviour", BEHAVIOUR.symbol],
      ],
    );
    assert.equal(
      work.nextStep,
      "Expand first: 2 incompatible contract changes with callers outside your scopes: shared.money.api.price (renamed, 1 caller), " +
        "shared.money.api.total (type changed, 1 caller). For shared.money.api.price, call apply_fix with kind \"codemod\" and expand: true; " +
        "Penguin's codemod writes the alias or forwarding function that keeps the old name working. For shared.money.api.total, write the " +
        "parallel function beside the old one under a new name. Keep the old one as main has it. Report that expand as a checkpoint that " +
        "only adds, then call land_feature with expand: true, with retiring naming the new function for each old one. Penguin promotes it on " +
        "its own; the old names then become retiring and migration begins. The behaviour changes to shared.money.api.round_cents keep the " +
        "merge plan after the split.",
    );
  });

  test("a behaviour change with the same signature keeps the merge plan", async () => {
    const runId = await checkpoint();
    report(runId, { changes: [{ ...RETYPED, symbol: "shared.money.api.price" , contract: "shared/money/api.py::price" }], headUses: [use("shared.money.api.price", "billing")] });
    assert.equal(await recordSplit(deps, feature(), scopeMap), undefined);
    const work = contractWork(deps, feature(), scopeMap);
    assert.equal(work.decision, "plan");
    assert.equal(work.nextStep, "Keep the merge plan: 1 behaviour change with the same signature: shared.money.api.price. Call propose_plan with one part per affected place.");
  });

  test("apply_fix with expand: true takes the codemod's edits and files from the split, inside the charter", async () => {
    const runId = await checkpoint();
    report(runId, { changes: [RENAMED], headUses: [use(RENAMED.symbol, "billing")] });
    const tools: AgentToolDeps = {
      features: project.features,
      runs: new AgentToolStore(project.sql),
      scopeMap: async () => scopeMap,
      heartbeat: (caller, id) => project.heartbeat(caller, id),
      session: (id) => (id === "s-ines" ? session(id, "@ines/money") : undefined),
      identity: () => ({ handle: "@ines/money", ownerId: "ines", teamOwners: [], charterScopes: ["money"], charterPaths: [] }),
      baseline: async () => BASE,
      split: (id) => splits.get(id),
    };
    const none = await requestTool(tools, "ines", "s-ines", "apply_fix", { feature: "money-minor", kind: "codemod", expand: true });
    assert.match((none as { message: string }).message, /has no split waiting on its expand/u);
    await recordSplit(deps, feature(), scopeMap);
    const fix = await requestTool(tools, "ines", "s-ines", "apply_fix", { feature: "money-minor", kind: "codemod", expand: true });
    assert.equal(fix.status, "ok", JSON.stringify(fix));
    assert.deepEqual(fix.status === "ok" ? [fix.input["paths"], fix.input["expand"], fix.commandId] : null, [
      ["shared/money/api.py"],
      [{ kind: "rename", from: "shared.money.api.price", to: "shared.money.api.price_minor" }],
      "fix:python-codemod",
    ]);
    for (const [input, pattern] of [
      [{ kind: "codemod", expand: true, paths: ["shared/money/api.py"] }, /names no paths, edits or rules/u],
      [{ kind: "format", expand: true }, /only a codemod takes expand/u],
    ] as const) {
      const refused = await requestTool(tools, "ines", "s-ines", "apply_fix", { feature: "money-minor", ...input });
      assert.match((refused as { message: string }).message, pattern, JSON.stringify(input));
    }
  });

  test("once the expand reaches main the old names retire with their replacements, and migration begins", async () => {
    const runId = await checkpoint();
    report(runId, {
      changes: [RENAMED, RETYPED],
      signatures: [{ symbol: RETYPED.symbol, path: RETYPED.path, line: 5, before: "(p: float) -> float", after: "(p: Money) -> Money", added: [], removed: [], breaking: false, reasons: [] }],
      headUses: [use(RENAMED.symbol, "billing"), use(RETYPED.symbol, "billing")],
    });
    await recordSplit(deps, feature(), scopeMap);
    // land_feature's retiring names the parallel function; a contract outside the split is refused.
    assert.match(String(splitReplacements(splits.get("money-minor"), [{ contract: "billing/fees.py::fee", replacement: "billing/fees.py::fee2" }])), /not an incompatible entry/u);
    const named = splitReplacements(splits.get("money-minor"), [{ contract: "shared/money/api.py::total", replacement: "shared/money/api.py::total_minor" }]);
    assert.ok(Array.isArray(named));
    splits.name("money-minor", named);

    const MAIN_AFTER = "c".repeat(40);
    const retired = await retireSplit(deps, "money-minor", MAIN_AFTER);
    assert.equal(retired?.state, "retiring");
    assert.deepEqual(
      project.retiring.list().map((each) => [each.contract, each.replacement, each.planId]),
      [
        ["shared/money/api.py::price", "shared/money/api.py::price_minor", splitPlanId("money-minor")],
        ["shared/money/api.py::total", "shared/money/api.py::total_minor", splitPlanId("money-minor")],
      ],
    );
    const [record] = project.records("money-minor", "retire_symbols");
    assert.deepEqual([record?.payload["split"], record?.payload["promotion"]], [true, MAIN_AFTER]);
    assert.equal(
      contractWork(deps, feature(), scopeMap).nextStep,
      `The expand step is on main (${MAIN_AFTER.slice(0, 12)}). Retiring: shared/money/api.py::price for shared/money/api.py::price_minor, ` +
        "shared/money/api.py::total for shared/money/api.py::total_minor. Migrate: call impact for the remaining callers grouped by owner, " +
        "then propose_plan with one part per place.",
    );
    // A second promotion report retires nothing more.
    await retireSplit(deps, "money-minor", MAIN_AFTER);
    assert.equal(project.records("money-minor", "retire_symbols").length, 1);
  });

  test("an old name with no replacement is promoted unretired, with the reason", async () => {
    const runId = await checkpoint();
    report(runId, {
      changes: [RETYPED],
      signatures: [{ symbol: RETYPED.symbol, path: RETYPED.path, line: 5, before: "(p: float) -> float", after: "(p: Money) -> Money", added: [], removed: [], breaking: false, reasons: [] }],
      headUses: [use(RETYPED.symbol, "billing")],
    });
    await recordSplit(deps, feature(), scopeMap);
    const retired = await retireSplit(deps, "money-minor", "c".repeat(40));
    assert.deepEqual(retired?.unretired, [{ symbol: RETYPED.symbol, reason: "no replacement was named; declare it with propose_plan's retiring" }]);
    assert.deepEqual(project.retiring.list(), []);
  });
});
