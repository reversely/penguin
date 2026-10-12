// Penguin's approval on use cases 1 and 2 (PRD 0.5 sections 1 and 4.3) as the preview seeds them
// (scripts/preview/seed.ts): every plan, part trial and review runs for real on the fixture's built
// repository. Expected checkpoints come from the fixture's pins, never typed here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { routesToOriginator } from "@penguin/protocol";

import { seed } from "../../../scripts/preview/seed.ts";
import { trialStanding } from "../../../services/project-agent/src/part-trial.ts";
import { routePart } from "../../../services/project-agent/src/plan-approval.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const pins = (fixture: string) => JSON.parse(readFileSync(join(ROOT, "examples", fixture, "pins.json"), "utf8")) as { tags: Record<string, string> };

test("the helpful fix is planned once start_of_local_day exists, and Penguin approves both clean parts", async () => {
  const preview = await seed("helpful-fix", { runnerTools: false });
  const [origin] = preview.features.list().filter((feature) => feature.personId === "priya");
  const plan = await preview.plan(origin?.id as string);
  // PRD case 2: Priya's agent adds the helper, then proposes the switch, so the plan's checkpoint is
  // the commit that adds it and each trial tree holds it.
  assert.equal(plan?.facts.change.checkpoint, pins("helpful-fix").tags["owner-priya-local-day"]);
  assert.deepEqual(
    plan?.parts.map((part) => [part.owner, part.approvedBy]),
    [
      ["jun", "penguin"],
      ["sam", "penguin"],
    ],
  );
});

test("identity unification: every part Jun owns stays with Jun, and the tablet invariant reaches him", async () => {
  const preview = await seed("identity-unification", { runnerTools: false });
  const [origin] = preview.features.list().filter((feature) => feature.personId === "priya");
  const plan = await preview.plan(origin?.id as string);
  const juns = plan?.parts.filter((part) => part.owner === "jun") ?? [];
  assert.equal(juns.length, 2);
  for (const part of juns) assert.notEqual(part.approvedBy, "penguin", part.partId);
  // On the trial of Jun's own part, Jun's form is accepted with the cutover marker its patch adds, and
  // the invariant it reports broken routes the part to Jun.
  const own = juns.find((part) => part.place.kind === "feature");
  assert.ok(own !== undefined && plan !== undefined);
  const routing = routePart(plan, own, preview.reviews.list(plan.featureId), preview.scopeMap, false, trialStanding(preview.trials, preview.reviews, plan.featureId, own));
  assert.ok(routing.reasons.some((reason) => reason.kind === "broken_invariant" && reason.invariant === "tablet-patrons-separate"), JSON.stringify(routing.reasons));
  assert.ok(!routing.reasons.some((reason) => reason.kind === "review" && reason.state === "refused"), JSON.stringify(routing.reasons));
  assert.ok(preview.inbox.items("jun").some((item) => item.reason === "review_exception"));
});

test("identity unification: Sam's parts wait on Priya, whose change reshapes the Profile store with no backfill", async () => {
  // #132: messaging only reads Profile, which identity-map owns. Priya's checkpoint and plan carry no
  // migration or backfill, so both of Sam's parts route to Priya, and Sam is not asked.
  const preview = await seed("identity-unification", { runnerTools: false });
  const [origin] = preview.features.list().filter((feature) => feature.personId === "priya");
  const plan = await preview.plan(origin?.id as string);
  assert.ok(plan !== undefined);
  assert.equal(plan.storeMarker ?? null, null);
  assert.deepEqual(
    plan.facts.contractDiff?.dataShapes.map((shape) => [shape.symbol, shape.path]),
    [["ingestion.identity_map.Profile", "ingestion/identity_map.py"]],
  );
  // Sam's form is accepted without a marker of its own.
  const messaging = preview.reviews.list(plan.featureId).filter((review) => review.scopeId === "messaging").at(-1);
  assert.equal(messaging?.state, "accepted", JSON.stringify(messaging?.refusals));
  const sams = plan.parts.filter((part) => part.owner === "sam");
  assert.equal(sams.length, 2);
  for (const part of sams) {
    assert.equal(part.approvalState, "pending", part.partId);
    const routing = routePart(plan, part, preview.reviews.list(plan.featureId), preview.scopeMap, false, trialStanding(preview.trials, preview.reviews, plan.featureId, part));
    const symbol = "ingestion.identity_map.Profile";
    assert.deepEqual(routing.reasons, [
      { kind: "stored_data_unmarked", scope: "messaging", symbol, path: "ingestion/identity_map.py", store: "identity-map", reviewId: messaging?.id },
    ]);
    assert.equal(routesToOriginator(routing), true);
  }
  const backend = preview.backend();
  const asks = async (person: string) => (await backend.planParts(person)).parts.map((part) => [part.ask, part.partId]);
  assert.deepEqual(await asks("sam"), []);
  assert.deepEqual(await asks("priya"), sams.map((part) => ["stored_data", part.partId]));
  // Priya decides it: approving it accepts the store as it is.
  const first = sams[0] as (typeof sams)[number];
  await preview.decide("priya", plan.featureId, first.partId);
  const after = (await preview.plan(plan.featureId))?.parts.find((part) => part.partId === first.partId);
  assert.deepEqual([after?.approvalState, after?.approvedBy], ["approved", "priya"]);
});
