// Retiring symbols (#113, PRD 0.5 section 4.2 step 2) on the money-minor-units fixture's own data,
// through the ProjectAgent's modules and the check runner's programs as the preview seed wires them
// (scripts/preview/seed.ts). Ines's first checkpoint is the expand: Penguin sorts its contract diff
// as additive only, and the plan Ines's agent proposes there names no place and declares the float API
// it replaces with the split's rewrite rules. Penguin checks the declaration and records the split from
// it (#149); the float API retires when main moves to the expand. Penguin then counts the callers
// left (#117), too many for the contract step, grouped by owner. Noor's pagination then reports its
// second checkpoint, which calls two retiring functions, and gets one next step per call; the
// `display` rule rewrites one of them. Expected features and owners are read from larder.json; the
// counts are the runs' own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { contractPath, isTestFile, type AgentToolResult, type RetiringSymbol, type RewriteRule } from "@penguin/protocol";
import { scopeForPath } from "@penguin/scope-map";

import { retireSplit } from "../../../services/project-agent/src/contract-split.ts";
import { buildFixture, builderOf, fixtureScopeMap, PreviewProject, type SeedIdentity } from "../../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface LarderFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly area: readonly string[];
  readonly commits: readonly { readonly tag?: string }[];
}
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
  features: LarderFeature[];
  split: { feature: string; rules: RewriteRule[]; retiring: RetiringSymbol[] };
};
const ORIGIN = LARDER.features.find((each) => each.id === LARDER.split.feature) as LarderFeature;
// The readers and the midway feature call the float API in their own changes.
const CALLERS = LARDER.features.filter((each) => each.role === "reader" || each.role === "midway");
// The owners of a block for code on main, as the fixture holds one.
const BLOCK_OWNERS = LARDER.features.filter((each) => each.role === "migration").map((each) => each.owner);

let preview: PreviewProject;
let identities: SeedIdentity[];
let countRun: number;
const agentOf = (each: LarderFeature) => identities.find((identity) => identity.handle === builderOf(each)) as SeedIdentity;
const outcomeOf = (runId: number) => preview.tools.get(runId)?.outcome as AgentToolResult;

before(async () => {
  const repo = await buildFixture("money-minor-units");
  const git = (path: string): unknown => JSON.parse(execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" }));
  preview = new PreviewProject("money-minor-units", repo, fixtureScopeMap(repo));
  identities = (git("penguin/identities.json") as { identities: SeedIdentity[] }).identities;
  preview.seedIdentities(identities);
  preview.sortContracts = true;
  // Main as Ines found it: Lena's stacking promoted. Every caller is running at its first checkpoint.
  preview.moveMain(preview.git("rev-parse", "feature-promotion-stacking"));
  for (const each of CALLERS) {
    await preview.open(agentOf(each), each.id, { scopes: each.area });
    await preview.checkpoint(each.id, `feature-${each.id}-${each.commits[0]?.tag}`);
  }
  await preview.open(agentOf(ORIGIN), ORIGIN.id, { scopes: ORIGIN.area });
  for (const lock of preview.overlaps.locksOn(ORIGIN.id)) await preview.approveStart(lock.personId, lock.featureId, ORIGIN.id);
  await preview.checkpoint(ORIGIN.id, `feature-${ORIGIN.id}-${ORIGIN.commits[0]?.tag}`);
});

const records = (type: string) =>
  preview.features
    .records(ORIGIN.id)
    .map((stored) => JSON.parse(stored.file) as { type: string; record_id: string; payload: Record<string, unknown> })
    .filter((each) => each.type === type);

test("the expand only adds; Penguin records the split from the float API its plan declares, checked against main and the checkpoint", async (t: TestContext) => {
  await preview.factsPass();
  const work = await preview.contract(ORIGIN.id);
  assert.deepEqual([work.state, work.decision, work.split], ["sorted", "none", null]);
  assert.ok(work.entries.every((entry) => entry.sort === "additive"), JSON.stringify(work.entries.map((entry) => [entry.symbol, entry.sort])));
  t.diagnostic(`sort of the expand: ${work.counts?.additive} additive, ${work.counts?.compatible} compatible; ${work.nextStep}`);

  const outcome = await preview.propose(ORIGIN.id, [], LARDER.split.rules, LARDER.split.retiring);
  assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 2_000));
  if (outcome.status !== "stored") return;
  assert.deepEqual(outcome.plan.parts, []);
  assert.deepEqual(outcome.plan.retiring, LARDER.split.retiring);
  // Each declared contract exists on main, has callers outside Ines's scopes and its replacement in the checkpoint.
  const split = preview.splits.get(ORIGIN.id);
  assert.equal(split?.state, "expand_first");
  assert.deepEqual(split?.replacements, LARDER.split.retiring);
  assert.deepEqual(split?.entries.map((entry) => entry.contract).sort(), LARDER.split.retiring.map((each) => each.contract).sort());
  assert.ok(split?.entries.every((entry) => entry.sort === "incompatible" && entry.callers > 0), JSON.stringify(split?.entries.map((entry) => [entry.contract, entry.callers])));
  const [record] = records("contract_split");
  assert.deepEqual([record?.payload["declared"], record?.payload["checkpoint"]], [true, split?.checkpoint]);
  t.diagnostic(`split at the expand: ${split?.entries.map((entry) => `${entry.contract} (${entry.callers} callers outside ines's scopes)`).join(", ")}`);
  // Nothing retires before the expand reaches main.
  assert.deepEqual(preview.retiring.list(), []);
  assert.deepEqual(records("retire_symbols"), []);
});

test("after the expand reaches main, callers of the float API are left, grouped by owner, and no contract step is proposed", async (t: TestContext) => {
  // The expand reaches main on its own: the split's old names retire with the plan's rules, and Ines's feature keeps building on its fork.
  const expand = preview.git("rev-parse", `feature-${ORIGIN.id}-${ORIGIN.commits[0]?.tag}`);
  await retireSplit(preview.splitDeps(), ORIGIN.id, expand);
  const declared = preview.retiring.list();
  assert.deepEqual(declared.map((each) => each.contract), LARDER.split.retiring.map((each) => each.contract).sort());
  const rulesOf = (contract: string) => LARDER.split.rules.filter((rule) => rule.contract === contract).map((rule) => rule.id);
  for (const each of declared) assert.deepEqual(each.rules.map((rule) => rule.id), rulesOf(each.contract), each.contract);
  const [retired] = records("retire_symbols");
  assert.deepEqual([retired?.record_id, retired?.payload["split"], (retired?.payload["symbols"] as unknown[]).length], [declared[0]?.recordId, true, LARDER.split.retiring.length]);
  t.diagnostic(`retiring: ${declared.map((each) => `${each.contract} (${each.rules.length} rules)`).join(", ")}`);
  const runId = await preview.promoted(ORIGIN.id, expand, false);
  assert.ok(runId !== undefined, "the promotion asked for a count");
  countRun = runId;
  const counted = preview.counts.find((each) => each.runId === runId)?.outcome;
  assert.ok(counted?.counts, "the count is complete");
  for (const each of counted.counts) {
    t.diagnostic(`${each.contract}: ${each.callers} callers, ${each.onMain} on main, in ${each.features.length} features`);
  }
  assert.deepEqual([counted.proposed, counted.withdrawn], [[], []]);
  assert.ok(preview.retiring.contractSteps(ORIGIN.id).every((step) => step.state === "callers_left"));
  // Every running caller's own changes call the float API at its first checkpoint, except Noor's
  // pagination, which calls it only from its second.
  const calling = new Set(counted.counts.flatMap((each) => each.features.map((use) => use.feature)));
  assert.deepEqual([...calling].sort(), CALLERS.filter((each) => each.role === "reader").map((each) => each.id).sort());

  const migration = outcomeOf(countRun).migration;
  assert.ok(migration, outcomeOf(countRun).summary);
  for (const group of migration.groups) {
    t.diagnostic(`${group.owner}: ${group.places.map((each) => (each.place.kind === "scope" ? `scope ${each.place.scope}` : each.place.feature)).join(", ")} (${group.uses} uses)`);
  }
  for (const owner of [...new Set(CALLERS.filter((each) => each.role === "reader").map((each) => each.owner))]) {
    const features = migration.groups.find((group) => group.owner === owner)?.places.flatMap((each) => (each.place.kind === "feature" ? [each.place.feature] : [])) ?? [];
    assert.deepEqual(features.sort(), CALLERS.filter((each) => each.owner === owner && each.role === "reader").map((each) => each.id).sort(), owner);
  }
  // Each owner with code on main that calls the float API is an owner the fixture holds a block for.
  const onMain = [...new Set(migration.groups.filter((group) => group.places.some((each) => each.place.kind === "scope")).map((group) => group.owner))].sort();
  assert.deepEqual(onMain, [...BLOCK_OWNERS].sort());
  assert.equal(migration.unowned, 0);
});

test("Noor's pagination adds retiring calls midway and its checkpoint gets one next step per call", async (t: TestContext) => {
  const sha = await preview.checkpoint("pagination", "feature-pagination-checkpoint");
  const [run] = preview.tools.list("pagination").filter((each) => each.input["search"] === "own" && each.checkpointSha === sha);
  assert.ok(run, "the checkpoint asked for the retiring-calls check");
  await preview.runnerPass();
  const result = outcomeOf(run.id);
  assert.equal(result.result, "found", result.summary);
  t.diagnostic(result.summary);
  const pagination = LARDER.features.find((each) => each.role === "midway") as LarderFeature;
  const steps = result.decisions.map((decision) => [decision.evidence.findings[0]?.path, decision.evidence.findings[0]?.code, decision.step, decision.actor.id, decision.fix?.commandId ?? null]);
  assert.deepEqual(steps, [
    // `money.display(line_total(line))`: no rule covers line_total, so its builder adapts it; the plan's
    // `display` rule rewrites the display call, so Penguin's codemod applies it.
    ["mobile_api/order_lines_page.py", "orders/model.py::line_total", 4, builderOf(pagination), null],
    ["mobile_api/order_lines_page.py", "shared/money/__init__.py::display", 3, "penguin", "fix:python-codemod"],
  ]);
  assert.match(result.decisions[0]?.reason ?? "", /use orders\/model\.py::line_total_minor/u);
  assert.match(result.decisions[1]?.reason ?? "", /rules display rewrite it/u);
  // The step reaches the session at its next safe checkpoint.
  assert.ok(preview.tools.deliver(preview.sessionOf.get("pagination") as string).some((each) => each.runId === run.id));

  // The step 3 fix: apply_fix as a codemod by the rule the step names.
  const fixRun = await preview.runnerTool("pagination", "apply_fix", { kind: "codemod", paths: ["mobile_api/order_lines_page.py"], rules: ["display"] });
  const fixed = outcomeOf(fixRun);
  assert.equal(fixed.result, "changed", fixed.summary);
  assert.deepEqual(fixed.fix?.changed?.paths, ["mobile_api/order_lines_page.py"]);
  const after = await preview.runnerFile(fixed.fix?.changed?.after as string, "mobile_api/order_lines_page.py");
  assert.match(after, /"price": line_total\(line\)\.display\(\)/u);
});
