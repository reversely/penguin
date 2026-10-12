// Retiring symbols (#113, PRD 0.5 section 4.2 step 2) on the money-minor-units fixture's own data,
// through the ProjectAgent's modules and the check runner's programs as the preview seed wires them
// (scripts/preview/seed.ts). The expand wave's plan marks the float API retiring; main then moves
// past the migrate waves, and after each promotion Penguin counts the callers left (#117), too many
// for the contract step of every symbol but one: the money and orders scopes' own tests of the float
// API are no callers (#144); Noor's pagination reports its second checkpoint, which calls two retiring
// functions, and gets one next step per call; the plan's display rule rewrites one of them; and the
// remaining callers on main and in the running features' own changes come back grouped by owner.
// Expected features and owners are read from larder.json; the counts are the runs' own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { contractPath, isTestFile, type AgentToolResult, type RetiringSymbol, type RewriteRule } from "@penguin/protocol";
import { scopeForPath } from "@penguin/scope-map";

import { buildFixture, builderOf, fixtureScopeMap, PreviewProject } from "../../../scripts/preview/seed.ts";

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
  plan: { rules: RewriteRule[] };
};
const feature = (id: string) => LARDER.features.find((each) => each.id === id) as LarderFeature;
// The readers and the midway feature call the float API in their own changes.
const CALLERS = LARDER.features.filter((each) => each.role === "reader" || each.role === "midway");
// The waves between the expand wave and the contract wave.
const MIGRATE_WAVES = LARDER.features.filter((each) => each.role === "wave").slice(1, -1);

/** The float API the expand wave leaves beside Money, each with what replaces it. */
const RETIRING: RetiringSymbol[] = [
  { contract: "shared/money/__init__.py::price", replacement: "shared/money/__init__.py::Money" },
  { contract: "shared/money/__init__.py::total", replacement: "shared/money/__init__.py::Money.sum" },
  { contract: "shared/money/__init__.py::display", replacement: "shared/money/__init__.py::Money.display" },
  { contract: "shared/money/discounts.py::percent_off", replacement: "shared/money/discounts.py::discounted" },
  { contract: "orders/model.py::line_total", replacement: "orders/model.py::line_total_minor" },
  { contract: "orders/model.py::order_total", replacement: "orders/model.py::order_total_minor" },
];

interface SeedIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
}

let preview: PreviewProject;
let identities: SeedIdentity[];
const agentOf = (each: LarderFeature) => identities.find((identity) => identity.handle === builderOf(each)) as SeedIdentity;
const outcomeOf = (runId: number) => preview.tools.get(runId)?.outcome as AgentToolResult;

before(async () => {
  const repo = await buildFixture("money-minor-units");
  const git = (path: string): unknown => JSON.parse(execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" }));
  preview = new PreviewProject("money-minor-units", repo, fixtureScopeMap(repo));
  identities = (git("penguin/identities.json") as { identities: SeedIdentity[] }).identities;
  preview.seedIdentities(identities);
  // Main as Ines found it: Lena's stacking promoted. Every caller is running at its first checkpoint.
  preview.moveMain(preview.git("rev-parse", "feature-promotion-stacking"));
  for (const each of CALLERS) {
    await preview.open(agentOf(each), each.id, { scopes: each.area });
    await preview.checkpoint(each.id, `feature-${each.id}-${each.commits[0]?.tag}`);
  }
});

test("the expand wave's plan marks the float API retiring, signed, with the rewrite rules for each contract", async (t: TestContext) => {
  const expand = feature("money-type");
  await preview.open(agentOf(expand), expand.id, { scopes: expand.area });
  for (const lock of preview.overlaps.locksOn(expand.id)) await preview.approveStart(lock.personId, lock.featureId, expand.id);
  await preview.checkpoint(expand.id, `feature-${expand.id}-checkpoint`);
  const outcome = await preview.propose(expand.id, [], LARDER.plan.rules, RETIRING);
  assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 2_000));
  if (outcome.status !== "stored") return;
  assert.deepEqual(outcome.plan.parts, []);
  assert.deepEqual(outcome.plan.retiring, RETIRING);

  const declared = preview.retiring.list();
  assert.deepEqual(declared.map((each) => each.contract), RETIRING.map((each) => each.contract).sort());
  const rulesOf = (contract: string) => LARDER.plan.rules.filter((rule) => rule.contract === contract).map((rule) => rule.id);
  for (const each of declared) assert.deepEqual(each.rules.map((rule) => rule.id), rulesOf(each.contract), each.contract);
  const [record] = preview.features
    .records(expand.id)
    .map((stored) => JSON.parse(stored.file) as { type: string; record_id: string; payload: { symbols: unknown[] } })
    .filter((each) => each.type === "retire_symbols");
  assert.equal(record?.record_id, declared[0]?.recordId);
  assert.equal(record?.payload.symbols.length, RETIRING.length);
  t.diagnostic(`retiring: ${declared.map((each) => `${each.contract} (${each.rules.length} rules)`).join(", ")}`);

  // The expand wave lands; main moves on past the five migrate waves, each its own feature and block.
  // After each promotion Penguin counts the callers of every retiring symbol (#117).
  preview.features.setState(expand.id, ["opening", "building", "landing"], "landed");
  await countAfter(t, expand.id);
  for (const wave of MIGRATE_WAVES) {
    await preview.open(agentOf(wave), wave.id, { scopes: wave.area });
    for (const lock of preview.overlaps.locksOn(wave.id)) await preview.approveStart(lock.personId, lock.featureId, wave.id);
    await preview.checkpoint(wave.id, `feature-${wave.id}`);
    preview.features.setState(wave.id, ["opening", "building", "landing"], "landed");
    await countAfter(t, wave.id);
  }
  assert.equal(preview.git("rev-parse", "main"), preview.git("rev-parse", `feature-${MIGRATE_WAVES.at(-1)?.id}`));
});

/** The counts of Penguin's own, one per promotion, in promotion order. */
const promotions: { feature: string; runId: number }[] = [];

/** `featureId`'s block reaches main at its fork's head; Penguin counts the callers left. */
async function countAfter(t: TestContext, featureId: string): Promise<void> {
  const runId = await preview.promoted(featureId, preview.git("rev-parse", `feature-${featureId}`), true);
  assert.ok(runId !== undefined, `${featureId}: the promotion asked for a count`);
  promotions.push({ feature: featureId, runId });
  const counted = preview.counts.find((each) => each.runId === runId)?.outcome;
  assert.ok(counted, `${featureId}: the runner reported the count`);
  const total = counted.counts?.reduce((sum, each) => sum + each.callers, 0) ?? null;
  const onMain = counted.counts?.reduce((sum, each) => sum + each.onMain, 0) ?? null;
  t.diagnostic(`after ${featureId}: ${total ?? "unknown"} callers (${onMain ?? "unknown"} on main); ${outcomeOf(runId).summary}`);
}

test("Noor's pagination adds retiring calls midway and its checkpoint gets one next step per call", async (t: TestContext) => {
  const sha = await preview.checkpoint("pagination", "feature-pagination-checkpoint");
  const [run] = preview.tools.list("pagination").filter((each) => each.input["search"] === "own" && each.checkpointSha === sha);
  assert.ok(run, "the checkpoint asked for the retiring-calls check");
  await preview.runnerPass();
  const result = outcomeOf(run.id);
  assert.equal(result.result, "found", result.summary);
  t.diagnostic(result.summary);
  const steps = result.decisions.map((decision) => [decision.evidence.findings[0]?.path, decision.evidence.findings[0]?.code, decision.step, decision.actor.id, decision.fix?.commandId ?? null]);
  assert.deepEqual(steps, [
    // `money.display(line_total(line))`: the plan's `display` rule rewrites it, so Penguin's codemod applies it.
    ["mobile_api/order_lines_page.py", "orders/model.py::line_total", 4, "@noor/pagination", null],
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

test("the remaining callers on main and in the running features' own changes come back grouped by owner", async (t: TestContext) => {
  // Ines's agent asks from a checkpoint at main's head, so main's callers are main's after the migrate waves.
  const ines = identities.find((identity) => identity.handle === "@ines/money-minor-units") as SeedIdentity;
  await preview.open(ines, "money-migrate", { scopes: ["money"] });
  await preview.checkpoint("money-migrate", "feature-money-messaging-mobile");
  const runId = await preview.runnerTool("money-migrate", "impact");
  const migration = outcomeOf(runId).migration;
  assert.ok(migration, outcomeOf(runId).summary);
  t.diagnostic(outcomeOf(runId).summary);
  for (const group of migration.groups) {
    t.diagnostic(`${group.owner}: ${group.places.map((each) => (each.place.kind === "scope" ? `scope ${each.place.scope}` : each.place.feature)).join(", ")} (${group.uses} uses)`);
  }
  const featuresOf = (owner: string) =>
    migration.groups.find((group) => group.owner === owner)?.places.flatMap((each) => (each.place.kind === "feature" ? [each.place.feature] : [])) ?? [];
  const owners = [...new Set(CALLERS.map((each) => each.owner))].sort();
  for (const owner of owners) {
    assert.deepEqual(featuresOf(owner), CALLERS.filter((each) => each.owner === owner).map((each) => each.id).sort(), owner);
  }
  // On main the migrate waves left only the money and orders scopes' own tests calling the float API.
  // Those are no callers (#144): the contract step removes them with the symbols, so no group holds code on main.
  const onMain = migration.groups.flatMap((group) => group.places.flatMap((each) => (each.place.kind === "scope" ? [`${group.owner}:${each.place.scope}`] : [])));
  assert.deepEqual(onMain, []);
  assert.equal(migration.unowned, 0);
});

test("after the migrate waves callers of the float API are left in running features; only a symbol its own scope's tests alone use gets its contract step", (t: TestContext) => {
  assert.deepEqual(
    promotions.map((each) => each.feature),
    [feature("money-type").id, ...MIGRATE_WAVES.map((wave) => wave.id)],
  );
  const last = preview.counts.find((each) => each.runId === promotions.at(-1)?.runId)?.outcome;
  assert.ok(last?.counts, "the count after the last migrate wave is complete");
  for (const each of last.counts) {
    const features = each.features.map((use) => `${use.feature} (${use.uses})`).join(", ");
    t.diagnostic(
      `${each.contract}: ${each.callers} callers, ${each.onMain} on main; in features: ${features || "none"}; ` +
        `own uses ${each.ownUses} in ${each.ownFiles.join(", ") || "none"}`,
    );
    // Each own use sits in a test file of the scope that defines the symbol.
    const defining = preview.scopeMap.scopes.get(scopeForPath(preview.scopeMap, contractPath(each.contract)) as string)?.paths ?? [];
    for (const path of each.ownFiles) assert.ok(isTestFile(path) && defining.some((prefix) => path.startsWith(prefix)), `${each.contract}: ${path}`);
  }
  // The counts proposed only the symbols with no caller left, each once, and withdrew nothing.
  const proposed = promotions.flatMap(({ feature: promoted, runId }) => (preview.counts.find((each) => each.runId === runId)?.outcome.proposed ?? []).map((each) => ({ ...each, promoted })));
  const withdrawn = promotions.flatMap(({ runId }) => preview.counts.find((each) => each.runId === runId)?.outcome.withdrawn ?? []);
  const free = last.counts.filter((each) => each.callers === 0).map((each) => each.contract);
  assert.deepEqual(proposed.flatMap((each) => each.contracts).sort(), free);
  assert.deepEqual(withdrawn, []);
  for (const each of proposed) t.diagnostic(`contract step proposed after the ${each.promoted} promotion, carried by ${each.feature}: ${each.contracts.join(", ")}`);
  const steps = preview.retiring.contractSteps(feature("money-type").id);
  assert.deepEqual(
    steps.map((each) => [each.contract, each.state]),
    last.counts.map((each) => [each.contract, each.callers === 0 ? "approved" : "callers_left"]),
  );
  // At that promotion the running features whose own changes call the float API are the readers.
  // Noor's pagination calls it only from its second checkpoint, reported after the last wave.
  const calling = new Set(last.counts.flatMap((each) => each.features.map((use) => use.feature)));
  assert.deepEqual([...calling].sort(), CALLERS.filter((each) => each.role === "reader").map((each) => each.id).sort());
  t.diagnostic(`contract step: ${steps.map((each) => `${each.contract} ${each.state}`).join(", ")}`);
});
