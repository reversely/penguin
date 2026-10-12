// Use case 4 (PRD 0.5 section 1, docs/case-study-money.md) end to end without the network: the
// money-minor-units fixture seeded through the ProjectAgent's modules and the check runner's programs
// (scripts/preview/seed.ts). Ines's one feature is split: its first checkpoint is the expand, which
// reaches main with a plan of no place; Penguin counts the callers left and proposes one migration
// plan per owner group (#131); Noor's pagination joins Noor's plan midway (#113); each owner's block
// for code on main lands; and once no caller is left Penguin proposes the contract (#117), which
// Ines's last checkpoint carries to main. Expected features and owners come from larder.json; every
// number the diagnostics print is the run's own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { migrationPlaceKey, type MigrationPlanView } from "@penguin/protocol";

import { seed, type PreviewProject } from "../../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface LarderFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly area: readonly string[];
  readonly commits: readonly { readonly tag?: string; readonly fix?: { readonly scope: string; readonly kind: string } }[];
}
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as {
  features: LarderFeature[];
  split: { feature: string; retiring: { contract: string }[] };
};
const ORIGIN = LARDER.features.find((each) => each.id === LARDER.split.feature) as LarderFeature;
const READERS = LARDER.features.filter((each) => each.role === "reader");
const MIDWAY = LARDER.features.filter((each) => each.role === "midway");
const BLOCKS = LARDER.features.filter((each) => each.role === "migration");

let preview: PreviewProject;
let seconds = 0;

before(async () => {
  const started = performance.now();
  preview = await seed("money-minor-units", { runnerTools: false });
  seconds = Math.round((performance.now() - started) / 1000);
});

const firstPlans = () => preview.migrations.plans(ORIGIN.id).filter((plan) => plan.seq === 1);
const describe = (plan: MigrationPlanView) =>
  `${plan.owner} ${plan.state}: ${plan.parts.map((part) => `${part.place.kind === "scope" ? `scope ${part.place.scope}` : part.place.feature} ${part.uses} uses ${part.writer ?? "-"} ${part.state}`).join("; ")}`;

test("the expand reaches main with a plan of no place, and the float API retires", (t: TestContext) => {
  t.diagnostic(`seed: ${seconds} s, ${preview.steps.length} steps`);
  const outcome = preview.splitOutcome;
  assert.equal(outcome?.status, "stored");
  if (outcome?.status !== "stored") return;
  assert.deepEqual(outcome.plan.parts, []);
  const records = preview.features.records(ORIGIN.id).map((kept) => JSON.parse(kept.file) as { type: string; payload: { symbols?: unknown[] } });
  assert.equal(records.filter((record) => record.type === "retire_symbols")[0]?.payload.symbols?.length, LARDER.split.retiring.length);
});

test("Penguin proposes one migration plan per owner group, with each reader in its own person's plan", (t: TestContext) => {
  const plans = firstPlans();
  for (const plan of plans) t.diagnostic(describe(plan));
  const owners = [...new Set([...READERS, ...MIDWAY, ...BLOCKS].map((each) => each.owner))].sort();
  assert.deepEqual(plans.map((plan) => plan.owner).sort(), owners);
  for (const reader of READERS) {
    const plan = plans.find((each) => each.owner === reader.owner);
    assert.ok(plan?.parts.some((part) => part.place.kind === "feature" && part.place.feature === reader.id), `${reader.id} is in ${reader.owner}'s plan`);
  }
  // Each block holds the owner's code on main: the scopes of the block's area.
  for (const block of BLOCKS) {
    const plan = plans.find((each) => each.block === block.id);
    assert.ok(plan, `${block.id} is a plan's block`);
    assert.deepEqual(plan.parts.filter((part) => part.place.kind === "scope").map((part) => migrationPlaceKey(part.place)), block.area.map((scope) => migrationPlaceKey({ kind: "scope", scope })));
  }
  const parts = plans.flatMap((plan) => plan.parts);
  const by = (key: (part: (typeof parts)[number]) => string) => Object.entries(Object.groupBy(parts, key)).map(([name, list]) => `${name} ${list?.length}`).join(", ");
  t.diagnostic(`${plans.length} plans, ${parts.length} parts; writers: ${by((part) => part.writer ?? "none")}; states: ${by((part) => part.state)}`);
});

test("each reader's migration task names the reader's own builder, which its agent session runs as", (t: TestContext) => {
  const handles: string[] = [];
  for (const plan of preview.migrations.plans(ORIGIN.id)) {
    for (const part of plan.parts) {
      if (part.place.kind !== "feature") continue;
      const feature = LARDER.features.find((each) => each.id === (part.place as { feature: string }).feature) as LarderFeature;
      for (const task of preview.editTasks.forSource(`migrate:${part.partId}`)) {
        assert.equal(task.handle, `@${feature.owner}/${feature.id}`, `${part.partId} routes to ${task.handle}`);
        handles.push(task.handle as string);
      }
    }
  }
  assert.ok(handles.length > 0);
  assert.deepEqual(preview.identities.list().filter((identity) => /-\d+$/u.test(identity.handle)).map((identity) => identity.handle), []);
  t.diagnostic(`${handles.length} reader tasks, builders: ${[...new Set(handles)].sort().join(", ")}`);
});

test("Noor's pagination calls the float API midway and joins Noor's open plan", () => {
  for (const feature of MIDWAY) {
    const plan = firstPlans().find((each) => each.owner === feature.owner);
    assert.ok(plan?.parts.some((part) => part.place.kind === "feature" && part.place.feature === feature.id), `${feature.id} joined ${feature.owner}'s plan`);
  }
  const joined = preview.features
    .records(ORIGIN.id)
    .map((kept) => JSON.parse(kept.file) as { type: string })
    .filter((record) => record.type === "migration_joined");
  assert.ok(joined.length >= MIDWAY.length);
});

test("Rahul's review of the tax block breaks tax-per-line on the whole-order step and holds on the per-line revision", (t: TestContext) => {
  const tax = BLOCKS.find((block) => block.commits.some((commit) => commit.fix?.kind === "revision")) as LarderFeature;
  const reviews = preview.reviews.list(tax.id);
  assert.equal(reviews.length, 2);
  const [whole, perLine] = reviews;
  t.diagnostic(`whole order: ${JSON.stringify(whole?.record?.sideBySide.totals)}; per line: ${JSON.stringify(perLine?.record?.sideBySide.totals)}`);
  assert.deepEqual(whole?.exceptions.map((each) => each.kind), ["broken_invariant"]);
  assert.ok((perLine?.record?.sideBySide.totals.differing ?? 0) < (whole?.record?.sideBySide.totals.differing ?? 0));
  assert.deepEqual(perLine?.exceptions, []);
  assert.deepEqual(preview.inbox.items(tax.owner).map((item) => [item.reason, item.issueId]), [["review_exception", `${tax.id}/tax`]]);
});

test("every block lands, the contract follows when no caller is left, and the float API leaves main", (t: TestContext) => {
  for (const block of BLOCKS) assert.equal(preview.migrations.planOfBlock(block.id)?.state, "landed", block.id);
  for (const plan of preview.migrations.plans(ORIGIN.id).filter((each) => each.seq > 1)) t.diagnostic(`later plan ${describe(plan)}`);
  const steps = preview.retiring.contractSteps(ORIGIN.id);
  assert.deepEqual(steps.map((step) => step.contract).sort(), LARDER.split.retiring.map((each) => each.contract).sort());
  assert.ok(steps.every((step) => step.state === "removed"), JSON.stringify(steps.map((step) => [step.contract, step.state])));
  assert.deepEqual(preview.retiring.list(), []);
  assert.equal(preview.git("rev-parse", "main"), preview.git("rev-parse", `feature-${ORIGIN.id}-${ORIGIN.commits.at(-1)?.tag}^{commit}`));
  const counts = preview.counts.map((count) => (count.outcome.counts ?? []).reduce((sum, each) => sum + each.callers, 0));
  t.diagnostic(`callers left after each count: ${counts.join(", ")}`);
});
