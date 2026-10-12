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

describe("case 4, money in minor units: Ines's split", () => {
  const larder = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
    features: { id: string; owner: string; role: string; commits: { tag?: string }[] }[];
    promotions: { feature: string }[];
    split: { feature: string; retiring: { contract: string }[] };
  };
  const ines = larder.features.find((each) => each.id === larder.split.feature) as (typeof larder.features)[number];

  test("the expand only adds, so Penguin records no split and the feature has nothing to sort as incompatible", async () => {
    const { preview, identities } = await previewOf("money-minor-units");
    // Main as Ines found it: Lena's stacking promoted.
    preview.moveMain(preview.git("rev-parse", `feature-${larder.promotions[0]?.feature}`));
    preview.sortContracts = true;
    await preview.open(identities.find((identity) => identity.handle === builderOf(ines)) as SeedIdentity, ines.id, { scopes: ["money", "orders"] });
    await preview.checkpoint(ines.id, `feature-${ines.id}-${ines.commits[0]?.tag}`);
    await preview.factsPass();
    const work = await preview.contract(ines.id);
    assert.deepEqual([work.state, work.decision, work.split, work.counts?.incompatible], ["sorted", "none", null, 0]);
    assert.ok(work.counts !== null && work.counts.additive > 0);
    assert.deepEqual(sorts(work, ["shared.money.Money", "orders.model.line_total_minor", "orders.model.order_total_minor", "shared.money.discounts.discounted"]), [
      ["shared.money.Money", "additive"],
      ["orders.model.line_total_minor", "additive"],
      ["orders.model.order_total_minor", "additive"],
      ["shared.money.discounts.discounted", "additive"],
    ]);
    assert.match(work.nextStep, /^No contract change needs a split or a merge plan: \d+ additive/u);
  });

  test("the contract checkpoint removes the float API with no caller left, so each removal is compatible", async () => {
    const { preview, identities } = await previewOf("money-minor-units");
    // Main as the last block left it, just before Ines's contract.
    const last = larder.promotions.at(-2)?.feature as string;
    const block = larder.features.find((each) => each.id === last) as (typeof larder.features)[number];
    preview.moveMain(preview.git("rev-parse", `feature-${block.id}-${block.commits.at(-1)?.tag}^{commit}`));
    preview.sortContracts = true;
    await preview.open(identities.find((identity) => identity.handle === builderOf(ines)) as SeedIdentity, ines.id, { scopes: ["money", "orders"] });
    await preview.checkpoint(ines.id, `feature-${ines.id}-${ines.commits.at(-1)?.tag}`);
    await preview.factsPass();
    const work = await preview.contract(ines.id);
    // The contract also drops the CENT constants the float functions rounded with.
    const removed = work.entries.filter((entry) => entry.breaks === "removed").map((entry) => [entry.symbol, entry.sort, entry.callers]);
    const retired = ["orders.model.line_total", "orders.model.order_total", "shared.money.discounts.percent_off", "shared.money.display", "shared.money.price", "shared.money.total"];
    assert.ok(retired.every((symbol) => removed.some(([each]) => each === symbol)), JSON.stringify(removed));
    assert.ok(removed.every(([, sort, callers]) => sort === "compatible" && callers === 0), JSON.stringify(removed));
    assert.deepEqual([work.decision, work.split], ["none", null]);
  });
});
