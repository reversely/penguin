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
  readonly owner: string;
  readonly role: string;
  readonly area?: readonly string[];
  readonly commits: readonly { readonly tag?: string; readonly after?: string; readonly fix?: { readonly scope: string; readonly kind: string } }[];
}
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
  features: LarderFeature[];
  scopes: { id: string; owner: string; protected_paths?: string[] }[];
  plan: { parts: { scope: string }[] };
};
const WAVES = LARDER.features.filter((feature) => feature.role === "wave");
const READERS = LARDER.features.filter((feature) => feature.role === "reader");

let preview: PreviewProject;

before(async () => {
  preview = await seed("money-minor-units", { runnerTools: false });
});

const label = (place: PlanPlace) => (place.kind === "scope" ? `scope:${place.scope}` : `feature:${place.feature}`);

/** Every place of an answer and how many of its parts need a person (PRD 4.2 step 4). */
function places(outcome: ProposePlanOutcome | undefined): { places: string[]; inPerson: number } {
  if (outcome?.status === "stored") {
    return { places: outcome.plan.parts.map((part) => label(part.place)).sort(), inPerson: outcome.plan.parts.filter((part) => part.approvedBy !== "penguin").length };
  }
  if (outcome?.status === "returned") return { places: outcome.inPerson.map(label).sort(), inPerson: outcome.inPerson.length };
  throw new Error(`no plan: ${JSON.stringify(outcome).slice(0, 2_000)}`);
}

const outcomeOf = (feature: string) => preview.waveOutcomes.find((each) => each.feature === feature)?.outcome;

test("the one-block plan reaches every scope that reads money and the readers' own callers, over the break limit", (t: TestContext) => {
  const outcome = preview.blockOutcome;
  assert.equal(outcome?.status, "returned");
  const found = places(outcome);
  t.diagnostic(`one-block: ${found.inPerson} parts needing a person`);
  assert.deepEqual(found.places, [...LARDER.plan.parts.map((part) => `scope:${part.scope}`), ...READERS.map((feature) => `feature:${feature.id}`)].sort());
  assert.ok(found.inPerson > preview.breakLimit);
});

test("every wave is proposed in order, the expand wave with no place at all", () => {
  assert.deepEqual(
    preview.waveOutcomes.map((each) => each.feature),
    WAVES.map((wave) => wave.id),
  );
  const expand = outcomeOf(WAVES[0]?.id as string);
  assert.equal(expand?.status, "stored");
  assert.deepEqual(places(expand), { places: [], inPerson: 0 });
});

test("each migrate wave's places are the other scopes on main its fix commits name", (t: TestContext) => {
  for (const wave of WAVES.slice(1, -1)) {
    const outcome = outcomeOf(wave.id);
    assert.equal(outcome?.status, "stored", wave.id);
    const found = places(outcome);
    t.diagnostic(`${wave.id}: ${found.places.length} parts, ${found.inPerson} needing a person`);
    const named = wave.commits.flatMap((commit) => (commit.fix === undefined || commit.fix.kind === "revision" ? [] : [`scope:${commit.fix.scope}`]));
    assert.deepEqual(found.places, named.sort(), wave.id);
    assert.ok(found.inPerson <= preview.breakLimit, wave.id);
  }
});

test("the contract wave's places are the remaining callers of the float API: orders on main and each reader's own changes", (t: TestContext) => {
  const contract = WAVES.at(-1) as LarderFeature;
  const found = places(outcomeOf(contract.id));
  t.diagnostic(`${contract.id}: ${outcomeOf(contract.id)?.status}, ${found.inPerson} parts needing a person`);
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

test("a wave whose own change writes a protected file asks the file's protector, who confirms the lines before main moves", async () => {
  const guarded = LARDER.scopes.filter((scope) => (scope.protected_paths ?? []).length > 0);
  // Each wave that declares a protected scope as its area and belongs to another person rewrites that scope's protected file.
  const expected = WAVES.flatMap((wave) => guarded.flatMap((scope) => ((wave.area ?? []).includes(scope.id) && scope.owner !== wave.owner ? [[wave.id, scope.owner]] : [])));
  assert.ok(expected.length > 0);
  const rows = preview.features.list().flatMap((feature) => preview.protectedChanges.ofFeature(feature.id));
  assert.deepEqual(rows.map((row) => [row.featureId, row.ownerId]), expected, "only the waves' own changes touch another person's protected file");
  for (const row of rows) {
    assert.equal(row.state, "confirmed");
    assert.equal(row.confirmedBy, row.ownerId);
    assert.deepEqual(row.files.map((file) => file.protectedPath), guarded.find((scope) => scope.owner === row.ownerId)?.protected_paths);
    const confirm = preview.steps.findIndex((step) => step.step === `confirm ${row.featureId}'s protected lines as ${row.ownerId}`);
    assert.ok(confirm > preview.steps.findIndex((step) => step.step === `propose_plan for ${row.featureId}`), "the protector confirms once the wave's plan is stored, before main moves");
    const records = preview.features.records(row.featureId).map((kept) => JSON.parse(kept.file) as { type: string; payload: { owner: string } });
    assert.deepEqual(records.filter((record) => record.type === "confirm_protected_change").map((record) => record.payload.owner), [row.ownerId]);
    const inbox = (await preview.backend().planParts(row.ownerId)) as { protectedChanges: { feature: string; state: string; files: { lines: string[] | null }[] }[] };
    assert.deepEqual(inbox.protectedChanges.map((change) => [change.feature, change.state]), [[row.featureId, "confirmed"]]);
    assert.ok(inbox.protectedChanges[0]?.files.every((file) => file.lines !== null && file.lines.length > 0), "the protector reads the changed lines");
  }
});

test("each stored wave's part goes to its author, and Rahul's tax review still goes to Rahul", async () => {
  // Neither part's fix is under the checkpoint its facts run tested, and neither author's agent reviewed it.
  const decided = [];
  for (const wave of WAVES) {
    for (const part of (await preview.plan(wave.id))?.parts ?? []) decided.push([part.partId, part.owner, part.approvedBy]);
  }
  assert.deepEqual(decided, [
    ["money-checkout/v1#1", "lena", "lena"],
    ["money-tax/v2#1", "mei", "mei"],
  ]);
  assert.deepEqual(preview.inbox.items("rahul").map((item) => [item.reason, item.issueId]), [["review_exception", "money-tax/tax"]]);
});
