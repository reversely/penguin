// The four use cases of PRD 0.5 section 1, run in order on Larder through Penguin's own code with real
// git and pytest (scripts/preview/seed.ts). Larder is built once; case 1, 2, 3 and then 4 run on its
// one main. Each test checks the outcome the PRD states: who is asked, what Penguin approves itself
// and who is only told. Case 1's plan is also routed under each stage of the review policy (#175,
// #177). Each case's start opens with the owners told. Names and numbers come from the fixture.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BLOCK_CHECK_NAMES,
  PENGUIN_APPROVER,
  policyInForce,
  policyRoute,
  PRESET_POLICIES,
  REVIEW_PRESETS,
  VALIDATION_KIND_LABEL,
  VALIDATION_KINDS,
  type FeaturePage,
  type PartRouting,
  type PlanInbox,
  type PlanPart,
  type ReviewPolicy,
} from "@penguin/protocol";
import { build } from "esbuild";

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
/** The running features Penguin updated, or the originating person wrote a fix into, as the fixture holds them. */
const forksFixedBy = (origin: LarderFeature) => {
  const opened = Date.parse(origin.commits[0]?.date as string);
  const promoted = Date.parse(LARDER.promotions.find((promotion) => promotion.feature === origin.id)?.date as string);
  const fixes = (commit: LarderFeature["commits"][number]) => commit.update?.from === origin.id || commit.author === origin.owner;
  return LARDER.features
    .filter((feature) => feature.id !== origin.id && feature.commits.some((commit) => fixes(commit) && Date.parse(commit.date) >= opened && Date.parse(commit.date) < promoted))
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
  // The digest's verify part asks no form, so no read of the stored shape sends it to Priya: its
  // trial passes and Penguin approves it in every round.
  const [samVerify, samReviewed] = [owned(first, sam).filter((part) => part.kind === "verify"), owned(first, sam).filter((part) => part.kind !== "verify")];
  const samParts = JSON.stringify(owned(first, sam).map((part) => [part.partId, part.kind, part.approvalState, part.approvedBy]));
  assert.ok(samReviewed.length > 0 && samReviewed.every((part) => first.toOriginator.includes(part.partId)), `Sam's parts wait on Priya: ${samParts}`);
  assert.ok(samVerify.length > 0 && samVerify.every((part) => part.approvedBy === PENGUIN_APPROVER), `Penguin approves the digest's verify part: ${samParts}`);
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
  // The digest's verify part is trialled with messaging's fix for code on main, so its consent test
  // passes and Penguin approves it.
  const digest = last.plan.parts.find((part) => part.kind === "verify" && part.owner === sam);
  assert.equal(preview.trials.ofPart(origin.id, digest?.partId as string)?.request.checkpoint, tagSha(preview, origin, "fix-messaging"));
  assert.equal(digest?.approvedBy, PENGUIN_APPROVER, "Penguin approves the digest's verify part");
  assert.deepEqual(forksOf(last.plan.parts), forksFixedBy(origin));
  assert.equal(preview.features.get(origin.id)?.state, "landed");
});

test("case 1 under each stage: Local development lets Penguin approve Jun's part, Central development and Pre-production wait for Jun, Production waits on every part", async () => {
  const preview = await larder();
  const origin = originOf(1);
  const rounds = preview.rounds.filter((round) => round.plan.featureId === origin.id);
  // The round of the backfill, where Jun first decides the part in person.
  const backfill = rounds[1];
  const jun = preview.scopeMap.scopes.get("analytics")?.driId as string;
  const onMain = backfill!.plan.parts.find((part) => part.owner === jun && part.place.kind === "scope") as PlanPart;
  const inFork = backfill!.plan.parts.find((part) => part.owner === jun && part.place.kind === "feature") as PlanPart;
  const route = (policy: ReviewPolicy, part: PlanPart) => policyRoute(policyInForce(policy, false), backfill!.routings.get(part.partId) as PartRouting);
  const { local_development: local, central_development: central, pre_production: preProduction, production } = PRESET_POLICIES;

  // The review of analytics reports kiosk-shoppers-separate not holding (Logic) and its side-by-side
  // run differs on it (Data matching).
  assert.deepEqual(route(local, onMain), { ...route(local, onMain), decider: "penguin", rule: "set_to_penguin", types: ["logic", "data_matching"] }, "Local development: Penguin approves and tells Jun");
  assert.deepEqual([route(central, onMain).decider, route(central, onMain).types], ["person", ["logic", "data_matching"]], "Central development: it waits for Jun");
  assert.ok(backfill!.raised.includes(onMain.partId), "today's result: Jun decides it");
  const dataToPenguin: ReviewPolicy = { preset: "central_development", rows: { ...central.rows, data_matching: "penguin" } };
  assert.deepEqual([route(dataToPenguin, onMain).decider, route(dataToPenguin, onMain).types], ["person", ["logic"]], "Logic still flags it");
  assert.equal(route({ preset: "central_development", rows: { ...dataToPenguin.rows, logic: "penguin" } }, onMain).decider, "penguin", "with no flagged type set to person, Penguin approves");
  assert.deepEqual([route(preProduction, onMain).decider, route(preProduction, onMain).types], ["person", ["logic", "data_matching"]], "Pre-production: it waits for Jun");
  for (const part of backfill!.plan.parts) assert.equal(route(preProduction, part).decider, route(central, part).decider, `Pre-production routes plan part ${part.partId} as Central development does`);
  assert.ok(backfill!.plan.parts.every((part) => route(production, part).decider === "person"), "Production: every part waits");
  for (const preset of REVIEW_PRESETS) assert.equal(route(PRESET_POLICIES[preset], inFork).rule, "tests", `the cohort report part's failing test goes back under ${preset}`);

  // With no policy set, Central development decides every round of cases 1 to 3 as before: Penguin approves exactly the parts with no reason.
  for (const round of [...rounds, ...preview.rounds.filter((each) => each.plan.featureId !== origin.id)]) {
    for (const [partId, routing] of round.routings) assert.equal(policyRoute(policyInForce(undefined, false), routing).decider === "penguin", !routing.inPerson, partId);
  }
});

test("cases 1 to 3 start with no owner asked: Penguin approves each overlapping start and tells the owner of each running feature", async () => {
  const preview = await larder();
  let told = 0;
  for (const useCase of [1, 2, 3]) {
    const origin = originOf(useCase);
    const approvals = recordsOf(preview, origin.id, "approve_overlap");
    assert.ok(approvals.every((record) => record.payload["approved_by"] === PENGUIN_APPROVER), `${origin.id}: Penguin approves every overlapping start`);
    assert.deepEqual(preview.overlaps.status(origin.id).waitingOn, [], `${origin.id}: the start waits on no one`);
    for (const record of approvals) {
      const owner = record.payload["owner"] as string;
      const items = preview.inbox.items(owner).filter((item) => item.issueId === `${record.payload["feature"]}/${origin.id}`);
      assert.deepEqual(items.map((item) => item.reason), ["overlap_started"], `${origin.id}: ${owner} is told, not asked`);
      told += 1;
    }
  }
  assert.ok(told > 0, "some case's start overlaps a running feature");
});

/** The dashboard's feature page and inbox rendered on the server (render.tsx), bundled once for the test. */
async function dashboardRenderer(): Promise<{ featureHtml: (page: FeaturePage, viewer: string, view: string) => string; inboxHtml: (plan: PlanInbox) => string }> {
  const bundled = await build({
    entryPoints: [join(ROOT, "tests", "cases", "render.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    // React's server renderer requires Node's built-ins, which an ES module bundle reaches through require.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const file = join(await mkdtemp(join(tmpdir(), "penguin-render-")), "render.mjs");
  await writeFile(file, bundled.outputFiles[0]!.text);
  return import(file);
}

/** A page's text without the How Penguin validates panel, which names every kind whatever the results. */
const results = (html: string) => html.replace(/<details[^>]*class="validation-panel"[^>]*>[\s\S]*?<\/details>/u, "").replace(/<[^>]+>/gu, " ").replaceAll("&#x27;", "'");

test("case 1's feature page names each kind of validation on its results and each route of its decisions and writes; Jun's inbox names its kinds", async () => {
  const preview = await larder();
  const origin = originOf(1);
  const render = await dashboardRenderer();
  const backend = preview.backend();
  const page = (await backend.featurePage(origin.owner, origin.id)) as FeaturePage;
  const shown = ["changes", "pipeline", "record"].map((view) => results(render.featureHtml(page, origin.owner, view))).join(" ");
  for (const kind of VALIDATION_KINDS) assert.ok(shown.includes(VALIDATION_KIND_LABEL[kind]), `${VALIDATION_KIND_LABEL[kind]} on the feature page`);
  const jun = preview.scopeMap.scopes.get("analytics")?.driId as string;
  assert.ok(shown.includes("by Penguin (check runner)"), "an update Penguin's check runner wrote into an affected fork");
  assert.match(shown, /Approved by Penguin \(Central development policy: Tests/u, "a part Penguin approved under the policy");
  assert.ok(shown.includes(`Approved by ${jun} in the dashboard`), "a part a person approved in the dashboard");
  assert.match(shown, /@[a-z0-9-]+\/[a-z0-9.-]+ \(MCP propose_plan\)/u, "the record view names the agent's tool");
  assert.ok(shown.includes("Penguin automatically") && shown.includes(`${jun} in the dashboard`), "the record view names Penguin and the person");

  const inbox = results(render.inboxHtml((await backend.planParts(jun)) as PlanInbox));
  for (const kind of ["logic", "data_matching"] as const) assert.ok(inbox.includes(VALIDATION_KIND_LABEL[kind]), `${VALIDATION_KIND_LABEL[kind]} in ${jun}'s inbox`);
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

test("cases 1 to 3 each write their approved fixes, copy the originating modules into each affected fork before the land, pass the block checks and reach promotion, in order", async () => {
  const preview = await larder();
  // The retiring-calls check runs on a checkpoint, not on a block.
  const blockChecks = BLOCK_CHECK_NAMES.filter((name) => name !== "retiring");
  const promotedAt: string[] = [];
  for (const useCase of [1, 2, 3]) {
    const origin = originOf(useCase);
    const plan = (await preview.plan(origin.id))!;
    const writes = recordsOf(preview, origin.id, "fix_write");
    const written = writes.map((record) => record.payload["part_id"]);
    const featureParts = plan.parts.filter((part) => part.place.kind === "feature");
    const fixes = featureParts.filter((part) => part.kind !== "verify").map((part) => part.partId);
    assert.ok(fixes.every((part) => written.includes(part)), `${origin.id} writes each approved fix into its fork`);
    assert.ok(written.every((part) => featureParts.some((each) => each.partId === part)), `${origin.id} writes only into affected forks`);
    if (useCase !== 2) {
      // Cases 1 and 3: Penguin's check runner updates every affected fork; no agent writes into one.
      assert.deepEqual([...written].sort(), featureParts.map((part) => part.partId).sort(), `${origin.id} updates every affected fork`);
      assert.ok(writes.every((record) => record.payload["written_by"] === "penguin"), `${origin.id}'s updates are Penguin's`);
    }
    assert.equal(recordsOf(preview, origin.id, "land_requested").length, 1);
    // Each affected fork holds the originating change's modules before the land is asked: a mechanical
    // or verify part's own write copies them, and a behavioural part's copy write follows the agent's.
    const ordered = preview.features.records(origin.id).map((stored) => JSON.parse(stored.file) as { type: string; payload: Record<string, unknown> });
    const landAt = ordered.findIndex((record) => record.type === "land_requested");
    const copiedInto = ordered.slice(0, landAt).filter((record) => record.type === "fix_write" && ((record.payload["copied"] as unknown[] | undefined)?.length ?? 0) > 0);
    assert.deepEqual(
      [...new Set(copiedInto.map((record) => record.payload["target_repo"]))].sort(),
      featureParts.map((part) => `feature-${(part.place as { feature: string }).feature}`).sort(),
      `${origin.id}'s affected forks each hold its modules before it lands`,
    );
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
