// Use case 4 (PRD 0.4 section 1, docs/case-study-money.md) end to end without the network: the
// money-minor-units fixture seeded through the ProjectAgent's modules and the check runner's programs
// (scripts/preview/seed.ts). Every count below is what propose_plan answers on the fixture's built
// repository: the one-block attempt returned over the break limit, then the waves of the parallel
// change. Expected places are read from larder.json, never typed here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { PlanPlace } from "@penguin/protocol";

import type { ProposePlanOutcome } from "../../../services/project-agent/src/propose-plan.ts";
import { seed, type PreviewProject } from "../../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface LarderFeature {
  readonly id: string;
  readonly role: string;
  readonly commits: readonly { readonly tag?: string; readonly after?: string; readonly fix?: { readonly scope: string; readonly kind: string } }[];
}
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
  features: LarderFeature[];
  plan: { parts: { scope: string }[] };
};
const WAVES = LARDER.features.filter((feature) => feature.role === "wave");
const READERS = LARDER.features.filter((feature) => feature.role === "reader");

let preview: PreviewProject;

before(async () => {
  preview = await seed("money-minor-units", { runnerTools: false });
});

const label = (place: PlanPlace) => (place.kind === "scope" ? `scope:${place.scope}` : `feature:${place.feature}`);

/** Every place of an answer and how many of them are behavioural. */
function places(outcome: ProposePlanOutcome | undefined): { places: string[]; behavioural: number } {
  if (outcome?.status === "stored") {
    return { places: outcome.plan.parts.map((part) => label(part.place)).sort(), behavioural: outcome.plan.parts.filter((part) => part.kind === "behavioural").length };
  }
  if (outcome?.status === "returned") return { places: outcome.behavioural.map(label).sort(), behavioural: outcome.behavioural.length };
  throw new Error(`no plan: ${JSON.stringify(outcome).slice(0, 2_000)}`);
}

const outcomeOf = (feature: string) => preview.waveOutcomes.find((each) => each.feature === feature)?.outcome;

test("the one-block plan reaches every scope that reads money and the readers' own callers, over the break limit", (t: TestContext) => {
  const outcome = preview.blockOutcome;
  assert.equal(outcome?.status, "returned");
  const found = places(outcome);
  t.diagnostic(`one-block: ${found.behavioural} behavioural parts`);
  assert.deepEqual(found.places, [...LARDER.plan.parts.map((part) => `scope:${part.scope}`), ...READERS.map((feature) => `feature:${feature.id}`)].sort());
  assert.ok(found.behavioural > preview.breakLimit);
});

test("every wave is proposed in order, the expand wave with no place at all", () => {
  assert.deepEqual(
    preview.waveOutcomes.map((each) => each.feature),
    WAVES.map((wave) => wave.id),
  );
  const expand = outcomeOf(WAVES[0]?.id as string);
  assert.equal(expand?.status, "stored");
  assert.deepEqual(places(expand), { places: [], behavioural: 0 });
});

test("each migrate wave's places are the other scopes on main its fix commits name", (t: TestContext) => {
  for (const wave of WAVES.slice(1, -1)) {
    const outcome = outcomeOf(wave.id);
    assert.equal(outcome?.status, "stored", wave.id);
    const found = places(outcome);
    t.diagnostic(`${wave.id}: ${found.places.length} parts, ${found.behavioural} behavioural`);
    const named = wave.commits.flatMap((commit) => (commit.fix === undefined || commit.fix.kind === "revision" ? [] : [`scope:${commit.fix.scope}`]));
    assert.deepEqual(found.places, named.sort(), wave.id);
    assert.ok(found.behavioural <= preview.breakLimit, wave.id);
  }
});

test("the contract wave's places are the remaining callers of the float API: orders on main and each reader's own changes", (t: TestContext) => {
  const contract = WAVES.at(-1) as LarderFeature;
  const found = places(outcomeOf(contract.id));
  t.diagnostic(`${contract.id}: ${outcomeOf(contract.id)?.status}, ${found.behavioural} behavioural parts`);
  const onMain = contract.commits.flatMap((commit) => (commit.fix === undefined ? [] : [`scope:${commit.fix.scope}`]));
  // A reader is a place when the checkpoint it reported is the one its wave fix is built on.
  const reached = READERS.filter((feature) => feature.commits.some((commit) => commit.after !== undefined)).map((feature) => `feature:${feature.id}`);
  assert.deepEqual(found.places, [...onMain, ...reached].sort());
});

test("the tax wave's review breaks tax-per-line on the whole-order step and holds on the per-line revision", () => {
  const reviews = preview.reviews.list("money-tax");
  assert.equal(reviews.length, 2);
  const [whole, perLine] = reviews;
  assert.ok((whole?.record?.sideBySide.totals.differing ?? 0) > 0);
  assert.deepEqual(whole?.exceptions.map((each) => each.kind), ["broken_invariant"]);
  assert.ok((perLine?.record?.sideBySide.totals.differing ?? 0) < (whole?.record?.sideBySide.totals.differing ?? 0));
  assert.deepEqual(perLine?.exceptions, []);
});
