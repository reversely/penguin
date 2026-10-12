// Penguin's approval on use cases 1 and 2 (PRD 0.5 sections 1 and 4.3) as the preview seeds them
// (scripts/preview/seed.ts): every plan, part trial and review runs for real on the fixture's built
// repository. Expected checkpoints come from the fixture's pins, never typed here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
