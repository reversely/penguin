// The migration plans of the money split (#131, PRD 0.5 section 4.2 step 2, Migrate) on the
// money-minor-units fixture's own data, through the ProjectAgent's modules and the check runner's
// programs as the preview seed wires them (scripts/preview/seed.ts). The expand wave's plan marks the
// float API retiring; after each promotion Penguin counts the remaining callers and proposes one
// migration plan per owner group; the check runner rewrites each place the declared rules cover and
// counts the uses left; each part the rules write whole is tried on its trial tree with no form, its
// scopes' tests and side-by-side runs deciding it (#139): Penguin approves it, or it becomes an edit task
// with the failing check, or a check no edit settles sends it to a person; every other part is an edit
// task. Noor's pagination then adds a caller midway and joins Noor's open plan. Expected features and
// owners are read from larder.json; every number the diagnostics print is the runs' own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { migrationPlaceKey, type MigrationPlanView, type RetiringSymbol, type RewriteRule } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { claimEditTasks, type EditWorkDeps } from "../../../services/project-agent/src/edit-work.ts";
import type { FixWriteDeps } from "../../../services/project-agent/src/fix-write.ts";
import { migrationWrites } from "../../../services/project-agent/src/migration-plans.ts";
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
const CALLERS = LARDER.features.filter((each) => each.role === "reader" || each.role === "midway");
const MIGRATE_WAVES = LARDER.features.filter((each) => each.role === "wave").slice(1, -1);

/** The float API the expand wave leaves beside Money, as money-retiring.test.ts declares it. */
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
const EXPAND = feature("money-type");

before(async () => {
  const repo = await buildFixture("money-minor-units");
  const git = (path: string): unknown => JSON.parse(execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" }));
  const owners = (git("penguin/owners.json") as { owners: { id: string }[] }).owners.map((owner) => owner.id);
  preview = new PreviewProject("money-minor-units", repo, parseScopeMap(git("penguin/scopes.json"), { ownerIds: owners }));
  identities = (git("penguin/identities.json") as { identities: SeedIdentity[] }).identities;
  preview.seedIdentities(identities);
  preview.migrationPlans = true;
  preview.moveMain(preview.git("rev-parse", "feature-promotion-stacking"));
  for (const each of CALLERS) {
    await preview.open(agentOf(each), each.id, { scopes: each.area ?? agentOf(each).charter_scopes });
    await preview.checkpoint(each.id, `feature-${each.id}-${each.commits[0]?.tag}`);
  }
});

const live = (plan: MigrationPlanView) => plan.parts.filter((part) => part.state !== "dropped");
const placeName = (part: MigrationPlanView["parts"][number]) => (part.place.kind === "scope" ? `scope ${part.place.scope}` : part.place.feature);

/** A part the rules wrote in full whose trial failed, now an edit task. */
const failedTrial = (part: MigrationPlanView["parts"][number]) => part.reason?.startsWith("the rules' patch failed its trial") === true;

/** The plans and parts of the money split as one diagnostic block. */
function describePlans(t: TestContext, when: string): void {
  const plans = preview.migrations.plans(EXPAND.id).filter((plan) => live(plan).length > 0);
  const parts = plans.flatMap(live);
  const by = (state: string) => parts.filter((part) => part.state === state).length;
  const tasks = parts.filter((part) => part.state === "task");
  const locked = new Set(preview.migrations.plans(EXPAND.id).flatMap((plan) => preview.overlaps.locksOn(plan.block).filter((lock) => lock.state === "open").map(() => plan.block)));
  t.diagnostic(
    `${when}: ${plans.length} plans, ${parts.length} parts; the rules wrote ${parts.filter((part) => part.writer === "runner" || failedTrial(part)).length}; ` +
      `Penguin approved ${by("approved")}, edit tasks ${tasks.length} (${tasks.filter(failedTrial).length} from a failed trial), in person ${by("in_person")}, ` +
      `in trial ${by("trial")}, rewriting ${by("rewriting")}, written ${by("written")}; plans approved ${plans.filter((plan) => plan.state === "approved").length}, ` +
      `closed ${plans.filter((plan) => plan.state === "closed").length}; block features waiting on an overlap lock ${locked.size}`,
  );
  for (const plan of plans) {
    t.diagnostic(`  ${plan.owner} (${plan.block}): ${live(plan).map((part) => `${placeName(part)} ${part.uses} uses, ${part.writer ?? "-"} ${part.state}${part.reason === null ? "" : ` (${part.reason})`}`).join("; ")}`);
  }
}

/** `featureId`'s block reaches main; Penguin counts, then the runner makes its rewrites and trials. */
async function promote(t: TestContext, featureId: string): Promise<number> {
  const started = performance.now();
  const runId = await preview.promoted(featureId, preview.git("rev-parse", `feature-${featureId}`), true);
  assert.ok(runId !== undefined, `${featureId}: the promotion asked for a count`);
  const counted = performance.now();
  // The count proposed plans and asked for one rewrite; the runner makes it, then each part's trial.
  await preview.runnerPass();
  const rewritten = performance.now();
  await preview.trialPass();
  const ms = (from: number, to: number) => Math.round(to - from);
  t.diagnostic(`${featureId}: count ${ms(started, counted)} ms, rewrites ${ms(counted, rewritten)} ms, trials ${ms(rewritten, performance.now())} ms`);
  return runId;
}

/** The count of `runId`, as the runner reported it. */
const countOf = (runId: number) => preview.counts.find((each) => each.runId === runId)?.outcome.counts ?? null;

test("after the expand, Penguin proposes one migration plan per owner group, with one part per place", async (t: TestContext) => {
  await preview.open(agentOf(EXPAND), EXPAND.id, { scopes: EXPAND.area });
  for (const lock of preview.overlaps.locksOn(EXPAND.id)) await preview.approveStart(lock.personId, lock.featureId, EXPAND.id);
  await preview.checkpoint(EXPAND.id, `feature-${EXPAND.id}-checkpoint`);
  const outcome = await preview.propose(EXPAND.id, [], LARDER.plan.rules, RETIRING);
  assert.equal(outcome.status, "stored", JSON.stringify(outcome).slice(0, 2_000));
  preview.features.setState(EXPAND.id, ["opening", "building", "landing"], "landed");
  const runId = await promote(t, EXPAND.id);

  const count = preview.tools.get(runId)?.outcome?.migration;
  assert.ok(count, "the count carries the owner groups");
  const plans = preview.migrations.plans(EXPAND.id);
  // One plan per owner group of the count, each holding exactly the group's places.
  assert.deepEqual(
    plans.map((plan) => [plan.owner, plan.parts.map((part) => migrationPlaceKey(part.place))]),
    count.groups.map((group) => [group.owner, group.places.map((each) => migrationPlaceKey(each.place))]),
  );
  // Every caller the count found is in a part.
  const callers = countOf(runId)?.reduce((sum, each) => sum + each.callers, 0);
  assert.equal(plans.flatMap((plan) => plan.parts).reduce((sum, part) => sum + part.uses, 0), callers);
  // Each part has its writer: the runner or an edit task.
  assert.ok(plans.flatMap((plan) => plan.parts).every((part) => part.writer !== null), "every part was routed");
  describePlans(t, `after ${EXPAND.id} (${callers} callers)`);
});

test("after the migrate waves, the remaining callers are all in the open plans' live parts", async (t: TestContext) => {
  let last = 0;
  for (const wave of MIGRATE_WAVES) {
    await preview.open(agentOf(wave), wave.id, { scopes: wave.area });
    for (const lock of preview.overlaps.locksOn(wave.id)) await preview.approveStart(lock.personId, lock.featureId, wave.id);
    await preview.checkpoint(wave.id, `feature-${wave.id}`);
    preview.features.setState(wave.id, ["opening", "building", "landing"], "landed");
    last = await promote(t, wave.id);
  }
  const counts = countOf(last);
  assert.ok(counts, "the last count is complete");
  const callers = counts.reduce((sum, each) => sum + each.callers, 0);
  const plans = preview.migrations.plans(EXPAND.id);
  const parts = plans.flatMap(live);
  assert.equal(parts.reduce((sum, part) => sum + part.uses, 0), callers, "every remaining caller is in a live part");
  const groups = preview.tools.get(last)?.outcome?.migration?.groups ?? [];
  assert.deepEqual(
    plans.filter((plan) => live(plan).length > 0).map((plan) => [plan.owner, live(plan).map((part) => migrationPlaceKey(part.place))]),
    groups.map((group) => [group.owner, group.places.map((each) => migrationPlaceKey(each.place))]),
  );
  // Each running reader is a part of its own person's plan.
  for (const each of CALLERS.filter((caller) => caller.role === "reader")) {
    assert.ok(
      plans.some((plan) => plan.owner === each.owner && live(plan).some((part) => part.place.kind === "feature" && part.place.feature === each.id)),
      `${each.id} is in ${each.owner}'s plan`,
    );
  }
  describePlans(t, `after ${MIGRATE_WAVES.at(-1)?.id} (${callers} callers)`);
});

test("a rule-written part needs no form: its trial approves it, makes it an edit task or, for a check no edit settles, sends it to a person", () => {
  const parts = preview.migrations.plans(EXPAND.id).flatMap(live);
  // No migration part asks for a review form.
  assert.deepEqual(preview.editTasks.forFeature(EXPAND.id).concat(...preview.migrations.plans(EXPAND.id).map((plan) => preview.editTasks.forFeature(plan.block))).filter((task) => task.kind === "review"), []);
  for (const part of parts) {
    if (part.state === "approved") assert.equal(part.approvedBy, "penguin");
    // Only a check no agent's edit settles sends a part to a person here: no edit task has run.
    if (part.state === "in_person") assert.doesNotMatch(part.reason ?? "", /^test:|differ on protected|edit task/u, part.partId);
    // A part whose trial failed is an edit task with that check attached.
    if (failedTrial(part)) {
      const [task] = preview.editTasks.forSource(`migrate:${part.partId}`);
      assert.ok(task !== undefined && task.kind === "migration" && task.evidence.length > part.files.length, part.partId);
    }
  }
  // Each approved part waits for the check runner's write into its target fork.
  const queued = new Set(preview.fixGrants.claimable().map((grant) => grant.partId));
  for (const part of parts.filter((each) => each.state === "approved")) assert.ok(queued.has(part.partId), part.partId);
  // Every feature Penguin opened went through the overlap lock.
  for (const plan of preview.migrations.plans(EXPAND.id)) {
    if (preview.features.get(plan.block) === undefined) continue;
    const checks = preview.features.records(plan.block).filter((stored) => (JSON.parse(stored.file) as { type: string }).type === "overlap_check");
    assert.ok(checks.length > 0, plan.block);
  }
});

test("Noor's pagination adds callers midway and joins Noor's open plan", async (t: TestContext) => {
  const noor = preview.migrations.plans(EXPAND.id).find((plan) => plan.owner === "noor" && plan.state !== "landed");
  assert.ok(noor, "Noor has an open plan");
  await preview.checkpoint("pagination", "feature-pagination-checkpoint");
  await preview.runnerPass();
  await preview.runnerPass();
  await preview.trialPass();
  const after = preview.migrations.plan(noor.planId);
  const part = after?.parts.find((each) => each.place.kind === "feature" && each.place.feature === "pagination");
  assert.ok(part, "pagination joined Noor's plan");
  const joined = preview.features
    .records(EXPAND.id)
    .map((stored) => JSON.parse(stored.file) as { type: string; payload: { plan?: string } })
    .filter((each) => each.type === "migration_joined" && each.payload.plan === noor.planId);
  assert.equal(joined.length, 1);
  t.diagnostic(`pagination: ${part.uses} uses of ${part.contracts.join(", ")}; ${part.writer} ${part.state} (${part.reason})`);
  describePlans(t, "after pagination's second checkpoint");
});

test("each person's bridge claims the migration edits one run per fork, and every other write into that fork waits its turn (#142)", async (t: TestContext) => {
  const migration = preview.migrationDeps();
  const fix: FixWriteDeps = {
    features: preview.features,
    routes: preview.routes,
    grants: preview.fixGrants,
    keeper: () => preview.plans,
    scopeMap: async () => preview.scopeMap,
    // No claim here reads a fork: a migration edit commits its own change, and the runner's write is only counted.
    readFork: () => Promise.reject(new Error("no fork is read")),
    sign: migration.sign,
    notify: () => undefined,
    migration: migrationWrites(migration),
  };
  const deps: EditWorkDeps = {
    tasks: preview.editTasks,
    roster: preview.roster,
    features: preview.features,
    routes: preview.routes,
    grants: preview.fixGrants,
    reviews: (featureId) => preview.reviews.list(featureId),
    scopeMap: async () => preview.scopeMap,
    running: () => [],
    fix,
    cap: 2,
    leaseMs: 20 * 60_000,
    notify: () => undefined,
  };
  const parts = preview.migrations.plans(EXPAND.id).flatMap(live);
  const people = [...new Set(parts.flatMap((part) => preview.editTasks.forSource(`migrate:${part.partId}`)).map((task) => task.person))].sort();
  for (const person of people) await claimEditTasks(deps, person, `br_${person}`);

  // Every write still to be made into a running fork or a block feature, by fork.
  const open = preview.fixGrants.allOpen();
  const forks = [...new Set(open.map((grant) => grant.targetFeatureId))].sort();
  const turn = (grant: (typeof open)[number]) => (grant.state === "granted" ? "holds the fork" : preview.fixGrants.waitsFor(grant) === null ? "its turn" : "waits");
  let contended = 0;
  for (const fork of forks) {
    const writes = open.filter((grant) => grant.targetFeatureId === fork);
    // One write token per fork at a time.
    assert.ok(writes.filter((grant) => grant.state === "granted").length <= 1, fork);
    if (writes.some((grant) => turn(grant) === "waits")) contended += 1;
    t.diagnostic(`${fork}: ${writes.map((grant) => `${grant.writer === "task" ? `edit ${grant.partId}` : `runner ${grant.partId}`} ${turn(grant)}`).join("; ")}`);
  }
  t.diagnostic(`${forks.length} forks take migration writes; ${open.filter((grant) => grant.state === "granted").length} hold a run; ${contended} have a write waiting its turn`);
});
