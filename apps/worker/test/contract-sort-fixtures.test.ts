// Sorting the contract diff on the fixtures' own data (#116, PRD 0.5 section 4.2 step 1), through the
// ProjectAgent's modules and the check runner's programs as the preview seed wires them
// (scripts/preview/seed.ts): each originating feature opens, reports the fixture's checkpoint, the
// check runner makes that checkpoint's one facts run, and Penguin sorts its contract diff. Every
// expected symbol is what the fixture's commits change; the sorts and counts are the runs' own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ContractSortEntry, ContractWorkView } from "@penguin/protocol";

import { retireSplit, splitReplacements } from "../../../services/project-agent/src/contract-split.ts";
import { buildFeaturePage } from "../../../services/project-agent/src/dashboard-views.ts";
import { buildFixture, builderOf, fixtureScopeMap, PreviewProject, type ExampleName } from "../../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface SeedIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
}

async function previewOf(fixture: ExampleName): Promise<{ preview: PreviewProject; identities: SeedIdentity[] }> {
  const repo = await buildFixture(fixture);
  const show = (path: string): unknown => JSON.parse(execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" }));
  const preview = new PreviewProject(fixture, repo, fixtureScopeMap(repo));
  const identities = (show("penguin/identities.json") as { identities: SeedIdentity[] }).identities;
  preview.seedIdentities(identities);
  return { preview, identities };
}

/** The originating feature of a fixture's features.json, opened and sorted at its first checkpoint. */
async function sortOriginating(fixture: ExampleName): Promise<{ preview: PreviewProject; feature: string; work: ContractWorkView }> {
  const { features } = JSON.parse(readFileSync(join(ROOT, "examples", fixture, "features.json"), "utf8")) as {
    features: { id: string; owner: string; role: string; area: unknown; commits: { tag?: string }[] }[];
  };
  const { preview, identities } = await previewOf(fixture);
  const origin = features.find((each) => each.role === "originating");
  assert.ok(origin);
  preview.sortContracts = true;
  await preview.open(identities.find((identity) => identity.handle === builderOf(origin)) as SeedIdentity, origin.id, origin.area);
  await preview.checkpoint(origin.id, origin.commits[0]?.tag as string);
  await preview.factsPass();
  return { preview, feature: origin.id, work: await preview.contract(origin.id) };
}

const entry = (work: ContractWorkView, symbol: string): ContractSortEntry | undefined => work.entries.find((each) => each.symbol === symbol);
const sorts = (work: ContractWorkView, symbols: readonly string[]) => symbols.map((symbol) => [symbol, entry(work, symbol)?.sort]);

describe("case 1, identity unification: Priya's person_id", () => {
  test("person_id is additive; the existing lookups change behaviour in place, so the feature keeps its merge plan", async () => {
    const { work } = await sortOriginating("identity-unification");
    assert.equal(work.state, "sorted");
    assert.deepEqual(sorts(work, ["ingestion.identity_map.IdentityMap.person_id"]), [["ingestion.identity_map.IdentityMap.person_id", "additive"]]);
    // The fixture edits resolve() and profile() in place with the same signatures: behaviour changes
    // to the declared IdentityMap contract, with callers in analytics and messaging. No entry is
    // incompatible, so Penguin records no split and nothing retires from this checkpoint.
    assert.deepEqual(sorts(work, ["ingestion.identity_map.IdentityMap.resolve", "ingestion.identity_map.IdentityMap.profile"]), [
      ["ingestion.identity_map.IdentityMap.resolve", "behaviour"],
      ["ingestion.identity_map.IdentityMap.profile", "behaviour"],
    ]);
    assert.equal(work.counts?.incompatible, 0);
    assert.deepEqual([work.decision, work.split], ["plan", null]);
    assert.match(work.nextStep, /^Keep the merge plan: /u);
  });
});

describe("case 2, the helpful fix: start_of_day to UTC", () => {
  test("start_of_day keeps its signature and changes behaviour, so the feature keeps its merge plan", async () => {
    const { work } = await sortOriginating("helpful-fix");
    assert.deepEqual(sorts(work, ["shared.dates.start_of_day"]), [["shared.dates.start_of_day", "behaviour"]]);
    assert.equal(entry(work, "shared.dates.start_of_day")?.reason, "its body changes with the same signature; it is the declared contract shared/dates.py::start_of_day");
    assert.deepEqual([work.decision, work.split, work.counts?.incompatible], ["plan", null, 0]);
    assert.equal(work.nextStep, "Keep the merge plan: 1 behaviour change with the same signature: shared.dates.start_of_day. Call propose_plan with one part per affected place.");
  });
});

describe("case 4, money in minor units: Ines's float-to-Money change", () => {
  test("the float price functions are incompatible, so Penguin splits the feature and the old names retire after the expand", async () => {
    const larder = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
      features: { id: string; owner: string; commits: { tag?: string }[] }[];
    };
    const { preview, identities } = await previewOf("money-minor-units");
    const ines = larder.features.find((each) => each.id === "money-minor-units");
    assert.ok(ines);
    // Main as Ines found it: Lena's stacking promoted.
    preview.moveMain(preview.git("rev-parse", "feature-promotion-stacking"));
    preview.sortContracts = true;
    const agent = identities.find((identity) => identity.handle === builderOf(ines)) as SeedIdentity;
    await preview.open(agent, ines.id, { scopes: agent.charter_scopes });
    await preview.checkpoint(ines.id, `feature-${ines.id}-${ines.commits[0]?.tag}`);
    await preview.factsPass();
    const work = await preview.contract(ines.id);

    // Against main with Lena's stacking promoted, Ines's checkpoint changes these three of the float
    // API; percent_off already took its stacking signature on main.
    const FLOAT_API = ["shared.money.display", "shared.money.price", "shared.money.total"];
    assert.deepEqual(
      sorts(work, FLOAT_API),
      FLOAT_API.map((symbol) => [symbol, "incompatible"]),
    );
    assert.deepEqual(
      FLOAT_API.map((symbol) => entry(work, symbol)?.breaks),
      ["removed", "signature", "type"],
    );
    for (const symbol of FLOAT_API) assert.ok((entry(work, symbol)?.callers ?? 0) > 0, `${symbol} has callers outside Ines's scopes`);
    assert.equal(entry(work, "shared.money.Money")?.sort, "additive");
    assert.deepEqual([work.decision, work.split?.state, work.split?.entries.map((each) => each.symbol)], ["split", "expand_first", FLOAT_API]);
    assert.match(work.nextStep, /^Expand first: 3 incompatible contract changes with callers outside your scopes: /u);
    // The feature page's API carries the same view, for the page to show the split's stage.
    const page = await buildFeaturePage(preview.viewDeps(), ines.id, ines.owner);
    assert.deepEqual([page?.contract?.decision, page?.contract?.split?.state], ["split", "expand_first"]);
    // No float function is a rename, move or keyword rename: the agent writes each parallel function.
    assert.match(work.nextStep, /write the parallel function beside the old one/u);
    assert.doesNotMatch(work.nextStep, /expand: true;/u);

    // The fixture's expand wave (money-type) is that parallel API; once it reaches main, the float
    // functions retire with the replacements the wave adds.
    // land_feature's retiring names them; Penguin checks each is an old name of the split.
    const named = splitReplacements(preview.splits.get(ines.id), [
      { contract: "shared/money/__init__.py::price", replacement: "shared/money/__init__.py::Money" },
      { contract: "shared/money/__init__.py::total", replacement: "shared/money/__init__.py::Money.sum" },
      { contract: "shared/money/__init__.py::display", replacement: "shared/money/__init__.py::Money.display" },
    ]);
    assert.ok(Array.isArray(named), String(named));
    preview.splits.name(ines.id, named);
    const retired = await retireSplit(preview.splitDeps(), ines.id, preview.git("rev-parse", "feature-money-type"));
    assert.deepEqual([retired?.state, retired?.unretired], ["retiring", []]);
    assert.deepEqual(
      preview.retiring.list().map((each) => each.contract),
      ["shared/money/__init__.py::display", "shared/money/__init__.py::price", "shared/money/__init__.py::total"],
    );
    assert.match((await preview.contract(ines.id)).nextStep, /^The expand step is on main \([0-9a-f]{12}\)\. Retiring: .* Migrate: Penguin proposes one migration plan per owner group/u);
  });
});
