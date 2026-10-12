// Retiring symbols (#113, PRD 0.5 section 4.2 step 2) on the money-minor-units fixture's own data,
// through the ProjectAgent's modules and the check runner's programs as the preview seed wires them
// (scripts/preview/seed.ts). The expand wave's plan marks the float API retiring; main then moves
// past the migrate waves; Noor's pagination reports its second checkpoint, which calls two retiring
// functions, and gets one next step per call; the plan's display rule rewrites one of them; and the
// remaining callers on main and in the running features' own changes come back grouped by owner.
// Expected features and owners are read from larder.json; the counts are the runs' own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentToolResult, RetiringSymbol, RewriteRule } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { buildFixture, PreviewProject } from "../../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface LarderFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly agent: string;
  readonly area?: readonly string[];
  readonly commits: readonly { readonly tag?: string }[];
}
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
  features: LarderFeature[];
  plan: { rules: RewriteRule[] };
};
const feature = (id: string) => LARDER.features.find((each) => each.id === id) as LarderFeature;
// The readers and the midway feature call the float API in their own changes.
const CALLERS = LARDER.features.filter((each) => each.role === "reader" || each.role === "midway");

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
const agentOf = (each: LarderFeature) => identities.find((identity) => identity.handle === `@${each.owner}/${each.agent}`) as SeedIdentity;
const outcomeOf = (runId: number) => preview.tools.get(runId)?.outcome as AgentToolResult;

before(async () => {
  const repo = await buildFixture("money-minor-units");
  const git = (path: string): unknown => JSON.parse(execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" }));
  const owners = (git("penguin/owners.json") as { owners: { id: string }[] }).owners.map((owner) => owner.id);
  preview = new PreviewProject("money-minor-units", repo, parseScopeMap(git("penguin/scopes.json"), { ownerIds: owners }));
  identities = (git("penguin/identities.json") as { identities: SeedIdentity[] }).identities;
  preview.seedIdentities(identities);
  // Main as Ines found it: Lena's stacking promoted. Every caller is running at its first checkpoint.
  preview.moveMain(preview.git("rev-parse", "feature-promotion-stacking"));
  for (const each of CALLERS) {
    await preview.open(agentOf(each), each.id, { scopes: each.area ?? agentOf(each).charter_scopes });
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

  // The expand wave lands; main moves on past the five migrate waves.
  preview.moveMain(preview.git("rev-parse", "feature-money-type"));
  preview.features.setState(expand.id, ["opening", "building", "landing"], "landed");
  preview.moveMain(preview.git("rev-parse", "feature-money-messaging-mobile"));
});

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
  const ines = identities.find((identity) => identity.handle === "@ines/money") as SeedIdentity;
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
  // On main the migrate waves left the money scope's own tests and the orders tests calling the float API.
  const onMain = migration.groups.flatMap((group) => group.places.flatMap((each) => (each.place.kind === "scope" ? [`${group.owner}:${each.place.scope}`] : [])));
  assert.deepEqual(onMain, ["ines:money", "tomas:orders"]);
  assert.equal(migration.unowned, 0);
});
