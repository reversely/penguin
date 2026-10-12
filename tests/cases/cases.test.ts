// The four use cases of PRD 0.5 section 1, run through Penguin's own code on the fixtures with real
// git and pytest (scripts/preview/seed.ts). Each test checks the outcome the PRD states: who is asked,
// what Penguin approves itself and who is only told. Names and numbers come from the fixtures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { seed, type MoneyLarder } from "../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function planCase(fixture: "identity-unification" | "helpful-fix" | "dependency-bump") {
  const preview = await seed(fixture, { runnerTools: false });
  const origin = preview.features.list().find((feature) => preview.plan(feature.id) !== undefined);
  const plans = await Promise.all(preview.features.list().map((feature) => preview.plan(feature.id)));
  const plan = plans.find((each) => each !== undefined);
  assert.ok(origin !== undefined && plan !== undefined, `${fixture} stores a plan`);
  const toldBy = (person: string) => preview.inbox.items(person).map((item) => item.reason);
  return { preview, plan, toldBy };
}

test("case 1, identity unification: Jun decides both of Jun's parts; Sam's parts wait on Priya's missing backfill", async () => {
  const { plan, toldBy } = await planCase("identity-unification");
  const owned = (person: string) => plan.parts.filter((part) => part.owner === person);
  assert.ok(owned("jun").length > 0 && owned("jun").every((part) => part.approvedBy !== "penguin"));
  assert.ok(toldBy("jun").includes("review_exception"), "the tablet invariant reaches Jun");
  assert.ok(owned("sam").every((part) => part.approvedBy !== "sam"), "Sam is not asked to approve");
  assert.equal(plan.storeMarker ?? null, null);
});

test("case 2, helpful fix: Penguin approves every part and the authors are only told", async () => {
  const { plan, toldBy } = await planCase("helpful-fix");
  assert.ok(plan.parts.length > 0);
  assert.ok(plan.parts.every((part) => part.approvedBy === "penguin"), JSON.stringify(plan.parts.map((part) => [part.owner, part.approvedBy])));
  for (const owner of new Set(plan.parts.map((part) => part.owner))) assert.ok(toldBy(owner).includes("penguin_approved"), `${owner} is told`);
});

test("case 3, dependency bump: Penguin approves Ana's idempotency part and Ana is only told", async () => {
  const { plan, toldBy } = await planCase("dependency-bump");
  assert.ok(plan.parts.every((part) => part.approvedBy === "penguin"), JSON.stringify(plan.parts.map((part) => [part.owner, part.approvedBy])));
  for (const owner of new Set(plan.parts.map((part) => part.owner))) assert.ok(toldBy(owner).includes("penguin_approved"));
});

test("case 4, money in minor units: the split runs from expand to contract with main moving block by block", async () => {
  const larder = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as MoneyLarder;
  const preview = await seed("money-minor-units", { runnerTools: false });
  const origin = larder.split.feature;
  const callers = preview.counts.map((count) => (count.outcome.counts ?? []).reduce((sum, each) => sum + each.callers, 0));
  assert.ok(callers[0]! > 0, "the expand leaves callers to migrate");
  assert.equal(callers.at(-1), 0, "no caller is left at the end");
  for (let i = 1; i < callers.length; i += 1) assert.ok(callers[i]! <= callers[i - 1]!, "callers never rise");
  const plans = preview.migrations.plans(origin);
  assert.ok(plans.length > 0 && plans.every((plan) => plan.state === "landed" || plan.state === "closed"));
  const steps = preview.retiring.contractSteps(origin);
  assert.deepEqual(steps.map((step) => step.contract).sort(), larder.split.retiring.map((each) => each.contract).sort());
  assert.ok(steps.every((step) => step.state === "removed"));
  // Only a broken invariant reaches a person: the tax review on the whole-order step.
  const people = preview.features.list().map((feature) => feature.personId);
  const asked = [...new Set(people)].filter((person) => preview.inbox.items(person).some((item) => item.reason === "review_exception" || item.reason === "plan_part"));
  assert.deepEqual(asked, ["rahul"]);
});
