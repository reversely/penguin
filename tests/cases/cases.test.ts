// The four use cases of PRD 0.5 section 1, run in order on Larder through Penguin's own code with real
// git and pytest (scripts/preview/seed.ts). Larder is built once; case 1, 2, 3 and then 4 run on its
// one main. Each test checks the outcome the PRD states: who is asked, what Penguin approves itself
// and who is only told. Names and numbers come from the fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BLOCK_CHECK_NAMES, PENGUIN_APPROVER, type PlanPart } from "@penguin/protocol";

import { seed, type LarderFeature, type MoneyLarder, type PreviewProject } from "../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LARDER = JSON.parse(readFileSync(join(ROOT, "examples", "money-minor-units", "larder.json"), "utf8")) as MoneyLarder;

// One Larder run serves the four cases, which run in order on one main.
let larderRun: Promise<PreviewProject> | undefined;
const larder = () => (larderRun ??= seed("money-minor-units", { runnerTools: false }));

const originOf = (useCase: number) => LARDER.features.find((feature) => feature.case === useCase) as LarderFeature;
const tagSha = (preview: PreviewProject, feature: LarderFeature, tag: string) => preview.git("rev-parse", `feature-${feature.id}-${tag}^{commit}`);
const recordsOf = (preview: PreviewProject, featureId: string, type: string) =>
  preview.features.records(featureId).map((stored) => JSON.parse(stored.file) as { type: string; payload: Record<string, unknown> }).filter((record) => record.type === type);
const toldOf = (preview: PreviewProject, person: string) => preview.inbox.items(person).map((item) => item.reason);
const forksOf = (parts: readonly PlanPart[]) => parts.flatMap((part) => (part.place.kind === "feature" ? [part.place.feature] : [])).sort();
/** The running features the originating person wrote a fix into, as the fixture holds them. */
const forksFixedBy = (origin: LarderFeature) => {
  const opened = Date.parse(origin.commits[0]?.date as string);
  const promoted = Date.parse(LARDER.promotions.find((promotion) => promotion.feature === origin.id)?.date as string);
  return LARDER.features
    .filter((feature) => feature.id !== origin.id && feature.commits.some((commit) => commit.author === origin.owner && Date.parse(commit.date) >= opened && Date.parse(commit.date) < promoted))
    .map((feature) => feature.id)
    .sort();
};

test("case 1, shopper accounts: Sam's parts wait on Priya until the backfill; Jun asks twice; Penguin approves the rest", async () => {
  const preview = await larder();
  const origin = originOf(1);
  const rounds = preview.rounds.filter((round) => round.plan.featureId === origin.id);
  const owned = (round: (typeof rounds)[number], person: string) => round.plan.parts.filter((part) => part.owner === person);
  const scopeDri = (scope: string) => preview.scopeMap.scopes.get(scope)?.driId as string;
  const proposals = origin.commits.filter((commit) => commit.plan === true);
  const backfill = origin.commits.find((commit) => commit.fix?.kind === "backfill");
  const revisions = origin.commits.filter((commit) => commit.fix?.kind === "revision");
  assert.equal(rounds.length, proposals.length + revisions.length, "one round per proposal and one per revision");

  // Sam's parts go to Priya while the plan names no backfill; Priya's agent proposes again at the
  // backfill and Penguin approves them.
  const sam = scopeDri("messaging");
  const marker = backfill?.declares?.contracts?.[backfill.fix?.scope as string]?.[0];
  const first = rounds[0]!;
  assert.equal(first.plan.storeMarker ?? null, null);
  assert.ok(owned(first, sam).length > 0 && owned(first, sam).every((part) => first.toOriginator.includes(part.partId)), "Sam's parts wait on Priya");
  const decided = recordsOf(preview, origin.id, "approve_plan_part").filter((record) => record.payload["plan_id"] === first.plan.planId && record.payload["approved_by"] !== PENGUIN_APPROVER);
  assert.deepEqual(decided, [], "no one decides the plan Priya proposes again");
  for (const round of rounds.slice(1)) {
    assert.equal(round.plan.storeMarker?.evidence, marker);
    assert.ok(owned(round, sam).every((part) => part.approvedBy === PENGUIN_APPROVER), "Penguin approves Sam's parts once the backfill is named");
  }
  assert.ok(toldOf(preview, sam).includes("penguin_approved"), "Sam is told");

  // Jun asks twice: for a device limit on the kiosk invariant, then for a lower one. Each request
  // names the revision Priya's agent then makes.
  const jun = scopeDri("analytics");
  const requests = recordsOf(preview, origin.id, "request_plan_change");
  assert.deepEqual(requests.map((record) => record.payload["requested_by"]), revisions.map(() => jun));
  assert.deepEqual(requests.map((record) => record.payload["text"]), revisions.map((commit) => commit.message.split("\n")[0]));
  assert.deepEqual(
    rounds.map((round) => owned(round, jun).some((part) => round.raised.includes(part.partId))),
    [false, true, true, false],
    "the kiosk invariant breaks at the backfill and the limit of five, and holds at the limit of one",
  );
  assert.ok(toldOf(preview, jun).includes("review_exception"));

  // After the limit of one every part is approved. Jun's cohort report part is trialled on the
  // revision and Penguin approves it. Jun's form names the cutover marker in Jun's fork, which the
  // trial of analytics' code on main does not hold, so Jun approves that part in person.
  const last = rounds.at(-1)!;
  assert.ok(last.plan.parts.every((part) => part.approvalState === "approved"), JSON.stringify(last.plan.parts.map((part) => [part.owner, part.approvedBy])));
  const limitOne = tagSha(preview, origin, revisions.at(-1)?.tag as string);
  const [onMain, inFork] = [owned(last, jun).find((part) => part.place.kind === "scope"), owned(last, jun).find((part) => part.place.kind === "feature")];
  assert.equal(onMain?.diff.commit, limitOne);
  assert.equal(onMain?.approvedBy, jun);
  assert.equal(inFork?.approvedBy, PENGUIN_APPROVER);
  assert.equal(preview.trials.ofPart(origin.id, inFork?.partId as string)?.request.checkpoint, limitOne, "the cohort report part is trialled on the newest revision");
  const lena = scopeDri("loyalty");
  const verify = owned(last, lena);
  assert.ok(verify.length > 0 && verify.every((part) => part.kind === "verify" && part.approvedBy === PENGUIN_APPROVER), "Penguin approves loyalty's verify part");
  assert.ok(toldOf(preview, lena).includes("penguin_approved"), "Lena is told");
  assert.deepEqual(forksOf(last.plan.parts), forksFixedBy(origin));
  assert.equal(preview.features.get(origin.id)?.state, "landed");
});

for (const useCase of [2, 3]) {
  test(`case ${useCase}, ${originOf(useCase).id}: Penguin approves every part with no one asked and the owners are only told`, async () => {
    const preview = await larder();
    const origin = originOf(useCase);
    const rounds = preview.rounds.filter((round) => round.plan.featureId === origin.id);
    assert.equal(rounds.length, 1, "one plan, never revised");
    const plan = rounds[0]!.plan;
    assert.deepEqual(forksOf(plan.parts), forksFixedBy(origin));
    assert.ok(plan.parts.every((part) => part.approvedBy === PENGUIN_APPROVER), JSON.stringify(plan.parts.map((part) => [part.owner, part.approvedBy])));
    assert.deepEqual(rounds[0]!.raised, []);
    assert.deepEqual(recordsOf(preview, origin.id, "request_plan_change"), []);
    assert.deepEqual(recordsOf(preview, origin.id, "approve_plan_part").filter((record) => record.payload["approved_by"] !== PENGUIN_APPROVER), [], "no one is asked");
    for (const owner of new Set(plan.parts.map((part) => part.owner))) assert.ok(toldOf(preview, owner).includes("penguin_approved"), `${owner} is told`);
    assert.equal(preview.features.get(origin.id)?.state, "landed");
  });
}

test("case 3: the dependency diff names the two other people's running features that send requests through the client", async () => {
  const preview = await larder();
  const origin = originOf(3);
  const check = preview.tools.list(origin.id).find((run) => run.tool === "check");
  // A target's dependency diff lists the version change, then each place the target imports the library.
  const importing = (check?.outcome?.checks ?? []).filter((each) => each.check === "dependencies" && each.target !== "main" && each.findings.some((finding) => finding.message.startsWith("imports ")));
  const targets = [...new Set(importing.map((each) => each.target))];
  // Hugo's own platform features import the client too; the other people's are the two the PRD names.
  const others = targets.filter((target) => preview.features.get(target)?.personId !== origin.owner).sort();
  assert.deepEqual(others, forksFixedBy(origin));
});

test("cases 1 to 3 each write their approved fixes, pass the block checks and reach promotion, in order", async () => {
  const preview = await larder();
  // The retiring-calls check runs on a checkpoint, not on a block.
  const blockChecks = BLOCK_CHECK_NAMES.filter((name) => name !== "retiring");
  const promotedAt: string[] = [];
  for (const useCase of [1, 2, 3]) {
    const origin = originOf(useCase);
    const plan = (await preview.plan(origin.id))!;
    const written = recordsOf(preview, origin.id, "fix_write").map((record) => record.payload["part_id"]);
    const fixes = plan.parts.filter((part) => part.place.kind === "feature" && part.kind !== "verify").map((part) => part.partId);
    assert.deepEqual([...written].sort(), [...fixes].sort(), `${origin.id} writes each approved fix into its fork`);
    assert.equal(recordsOf(preview, origin.id, "land_requested").length, 1);
    const checked = recordsOf(preview, origin.id, "block_checked");
    assert.equal(checked.length, 1);
    assert.equal(checked[0]!.payload["passed"], true);
    const ran = new Set((checked[0]!.payload["checks"] as { check: string }[]).map((check) => check.check));
    assert.deepEqual([...ran].sort(), [...blockChecks].sort(), `${origin.id}'s block runs every block check`);
    const promotions = preview.features.records(origin.id).filter((stored) => (JSON.parse(stored.file) as { type: string }).type === "promotion");
    assert.equal(promotions.length, 1, `${origin.id} is promoted once`);
    promotedAt.push((JSON.parse(promotions[0]!.file) as { created_at: string }).created_at);
    assert.equal(preview.features.get(origin.id)?.state, "landed");
  }
  assert.deepEqual([...promotedAt].sort(), promotedAt, "main moves case 1, then 2, then 3");
});

test("case 4, money in minor units: the split runs from expand to contract with main moving block by block", async () => {
  const preview = await larder();
  const origin = LARDER.split.feature;
  const callers = preview.counts.map((count) => (count.outcome.counts ?? []).reduce((sum, each) => sum + each.callers, 0));
  assert.ok(callers[0]! > 0, "the expand leaves callers to migrate");
  assert.equal(callers.at(-1), 0, "no caller is left at the end");
  for (let i = 1; i < callers.length; i += 1) assert.ok(callers[i]! <= callers[i - 1]!, "callers never rise");
  const plans = preview.migrations.plans(origin);
  assert.ok(plans.length > 0 && plans.every((plan) => plan.state === "landed" || plan.state === "closed"));
  const steps = preview.retiring.contractSteps(origin);
  assert.deepEqual(steps.map((step) => step.contract).sort(), LARDER.split.retiring.map((each) => each.contract).sort());
  assert.ok(steps.every((step) => step.state === "removed"));
  // Only a broken invariant reaches a person in this case: the tax review on the whole-order step.
  const people = [...new Set(preview.features.list().map((feature) => feature.personId))];
  const asked = people.filter((person) =>
    preview.inbox.items(person).some((item) => item.issueId.includes(origin) && (item.reason === "review_exception" || item.reason === "plan_part")),
  );
  assert.deepEqual(asked, ["rahul"]);
});
