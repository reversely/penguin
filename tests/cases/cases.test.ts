// The four use cases of PRD 0.5 section 1, run in order on Larder through Penguin's own code with real
// git and pytest (scripts/preview/seed.ts). Larder is built once; case 1, 2, 3 and then 4 run on its
// one main. Each test checks the outcome the PRD states: who is asked, what Penguin approves itself
// and who is only told. Case 1's plan is also routed under each stage of the review policy (#175,
// #177). Each case's start opens with the owners told. Names and numbers come from the fixture.

import assert from "node:assert/strict";
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

import { builderOf, larderExpanded, seed, type LarderFeature, type PreviewProject } from "../../scripts/preview/seed.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LARDER = larderExpanded().larder;

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

test("case 1, shopper accounts: Sam's parts wait on Priya until the backfill; nothing is flagged for Jun and Penguin approves every part", async () => {
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

  // Priya's change limits a device to one account from its first checkpoint, so the kiosk's shoppers
  // stay apart: nothing in analytics is flagged, no one asks for a change and Penguin approves Jun's
  // parts. The cohort report's update is trialled on Priya's fix for analytics' code on main, whose
  // analytics/activity.py it copies.
  const jun = scopeDri("analytics");
  assert.equal(revisions.length, 0, "the change needs no revision");
  assert.deepEqual(recordsOf(preview, origin.id, "request_plan_change"), [], "no one asks for a change");
  assert.ok(rounds.every((round) => owned(round, jun).every((part) => !round.raised.includes(part.partId))), "nothing of Jun's is flagged in any round");
  const last = rounds.at(-1)!;
  assert.ok(last.plan.parts.every((part) => part.approvalState === "approved"), JSON.stringify(last.plan.parts.map((part) => [part.owner, part.approvedBy])));
  const [onMain, inFork] = [owned(last, jun).find((part) => part.place.kind === "scope"), owned(last, jun).find((part) => part.place.kind === "feature")];
  assert.equal(onMain?.approvedBy, PENGUIN_APPROVER, "Penguin approves analytics' part for code on main");
  assert.equal(inFork?.approvedBy, PENGUIN_APPROVER, "Penguin approves the cohort report's update");
  assert.equal(preview.trials.ofPart(origin.id, inFork?.partId as string)?.request.checkpoint, tagSha(preview, origin, "fix-analytics"), "the cohort report's update is trialled with the fix for analytics' code on main");
  assert.ok(toldOf(preview, jun).includes("penguin_approved"), "Jun is told");
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

test("case 1 under each stage: with nothing flagged, Local and Central development and Pre-production let Penguin approve every part; Production waits on every part", async () => {
  const preview = await larder();
  const origin = originOf(1);
  const rounds = preview.rounds.filter((round) => round.plan.featureId === origin.id);
  const last = rounds.at(-1)!;
  const route = (policy: ReviewPolicy, part: PlanPart) => policyRoute(policyInForce(policy, false), last.routings.get(part.partId) as PartRouting);
  const { local_development: local, central_development: central, pre_production: preProduction, production } = PRESET_POLICIES;
  for (const part of last.plan.parts) {
    for (const [name, policy] of [["Local development", local], ["Central development", central], ["Pre-production", preProduction]] as const) {
      assert.equal(route(policy, part).decider, "penguin", `${name}: Penguin approves plan part ${part.partId}`);
    }
    assert.equal(route(production, part).decider, "person", `Production: plan part ${part.partId} waits`);
  }

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

test("case 1's feature page names each kind of validation on its results and each route of its decisions and writes; Jun's inbox renders", async () => {
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
  assert.match(shown, /@[a-z0-9-]+\/[a-z0-9.-]+ \(MCP propose_plan\)/u, "the record view names the agent's tool");
  assert.ok(shown.includes("Penguin automatically"), "the record view names Penguin's approvals");

  const inbox = (await backend.planParts(jun)) as PlanInbox;
  assert.ok(render.inboxHtml(inbox).length > 0, `${jun}'s inbox renders`);
});

test("case 2, structured-logs: Hugo's agent revises its change, Elif's and Sam's agents confirm their callers and the land writes into no fork", async () => {
  const preview = await larder();
  const origin = originOf(2);
  const receiving = ["holiday-closures", "weekly-digest"];
  const checks = preview.tools.list(origin.id).filter((run) => run.tool === "check");
  const verdictsAt = (tag: string) => {
    const replay = checks.find((run) => run.checkpointSha === tagSha(preview, origin, tag))?.outcome?.callerReplay;
    return Object.fromEntries(receiving.map((feature) => [feature, [...new Set(replay?.callers.filter((caller) => caller.feature === feature).map((caller) => caller.verdict))]]));
  };
  // The checkpoint's UTC start_of_day() moves both features' calls; the revision restores them.
  assert.deepEqual(verdictsAt("checkpoint"), { "holiday-closures": ["differs"], "weekly-digest": ["differs"] });
  assert.deepEqual(verdictsAt("utc-day"), { "holiday-closures": ["unaffected"], "weekly-digest": ["unaffected"] });

  // Hugo's agent classifies every differing call as incidental and revises, with the case's words; no one reviews.
  const words = larderExpanded().callers["case2"] as { explanations: Readonly<Record<string, string>> };
  const explained = recordsOf(preview, origin.id, "explain_difference");
  assert.deepEqual(explained.map((record) => [record.payload["feature"], record.payload["kind"]]).sort(), receiving.map((feature) => [feature, "revising"]));
  for (const record of explained) {
    assert.equal(record.payload["text"], words.explanations[String(record.payload["feature"])]);
    assert.ok((record.payload["calls"] as { kind: string }[]).every((call) => call.kind === "incidental"));
  }
  assert.deepEqual(recordsOf(preview, origin.id, "review_caller"), []);

  // Each receiving agent confirms with its identity, citing the revision's replay run.
  const utcDay = checks.find((run) => run.checkpointSha === tagSha(preview, origin, "utc-day"))?.outcome?.callerReplay;
  const confirmed = preview.features.records(origin.id).map((stored) => JSON.parse(stored.file) as { type: string; author: Record<string, string>; payload: Record<string, unknown> }).filter((record) => record.type === "confirm_caller");
  assert.deepEqual(confirmed.map((record) => record.payload["feature"]).sort(), receiving);
  for (const record of confirmed) {
    assert.equal(record.author["identity"], builderOf(LARDER.features.find((feature) => feature.id === record.payload["feature"]) as LarderFeature));
    assert.ok(utcDay?.runs.some((run) => run.runId === record.payload["run_id"] && run.feature === record.payload["feature"]), `${record.payload["feature"]} cites the revision's run`);
  }
  assert.deepEqual(preview.callerItemsOf(origin.id).map((item) => [item.feature, item.verdict, item.state]).sort(), receiving.map((feature) => [feature, "unaffected", "confirmed"]));

  // The land merges with no plan and nothing written into either fork.
  assert.equal(await preview.plan(origin.id), undefined);
  assert.deepEqual(recordsOf(preview, origin.id, "fix_write"), []);
  assert.deepEqual(forksFixedBy(origin), []);
  assert.equal(preview.features.get(origin.id)?.state, "landed");
});

test("case 3, dependency-audit: Penguin approves every part with no one asked and the owners are only told", async () => {
  const preview = await larder();
  const origin = originOf(3);
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

test("cases 1 and 3: the caller replay shows each affected running feature's calls differ before Penguin's update and match after it, with case 3's second payout and charge as effects", async (t) => {
  const preview = await larder();
  const replayOf = (useCase: number) => preview.tools.list(originOf(useCase).id).find((run) => run.tool === "check")?.outcome?.callerReplay;
  const verdicts = (callers: readonly { feature: string; verdict: string }[], feature: string) => [...new Set(callers.filter((caller) => caller.feature === feature).map((caller) => caller.verdict))].sort();

  // Case 1, before the updates: the shopper map's new links move Jun's counts and Sam's audience.
  const case1 = replayOf(1);
  assert.ok(case1 !== undefined, "case 1's check carries a caller replay");
  for (const feature of ["cohort-ltv", "weekly-digest"]) assert.ok(verdicts(case1.callers, feature).includes("differs"), `${feature} differs: ${JSON.stringify(verdicts(case1.callers, feature))}`);
  const published = case1.callers.find((caller) => caller.feature === "cohort-ltv" && caller.differing.some((call) => call.test.endsWith("test_dau_stable")));
  assert.ok(published !== undefined, "a published day's count is one of cohort-ltv's differing calls");
  assert.ok(!case1.callers.some((caller) => caller.differing.some((call) => call.test.endsWith("test_shared_device_split"))), "the kiosk's shoppers stay apart: one account per device");

  // Case 3 on the upgrade alone: the timed-out request is sent again, so money moves twice.
  const case3 = replayOf(3);
  assert.ok(case3 !== undefined, "case 3's check carries a caller replay");
  for (const [feature, endpoint] of [["instant-payouts", "/v1/payouts"], ["tip-jar", "/v1/charges"]] as const) {
    const callers = case3.callers.filter((caller) => caller.feature === feature);
    assert.deepEqual(verdicts(callers, feature), ["differs"], `${feature} on the upgrade alone`);
    const twice = callers.flatMap((caller) => caller.differing).find((call) => call.new.effects.filter((effect) => effect.summary.endsWith(endpoint)).length === 2);
    assert.ok(twice !== undefined, `${feature} records the second request to ${endpoint} as an effect`);
    assert.equal(twice.old.effects.filter((effect) => effect.summary.endsWith(endpoint)).length, 1);
    assert.equal(twice.old.status, "raised");
  }

  // Case 3's block, with Penguin's update in each fork: every call matches.
  const checked = recordsOf(preview, originOf(3).id, "block_checked");
  const replay = checked.at(-1)?.payload["caller_replay"] as { callers: { feature: string; verdict: string }[] } | undefined;
  assert.ok(replay !== undefined, "case 3's block record keeps the caller replay");
  for (const feature of ["instant-payouts", "tip-jar"]) assert.deepEqual(verdicts(replay.callers, feature), ["unaffected"], `${feature} with Penguin's update`);
  // The replay's one extra run of each feature's tests, on its fork head.
  for (const [name, section] of [["case 1 check", case1], ["case 3 check", case3]] as const) {
    t.diagnostic(`${name}: ${section.runs.map((run) => `${run.feature} ${run.durationMs} ms`).join(", ")}`);
  }
});

test("cases 1 and 3 run the caller protocol: each unaffected caller confirmed, each difference explained and approved, each write into a receiving fork after its approval", async () => {
  const preview = await larder();
  const steps = ["caller_item", "confirm_caller", "explain_difference", "review_caller", "decide_caller", "propose_caller_fix"];
  for (const useCase of [1, 3]) {
    const origin = originOf(useCase);
    const words = larderExpanded().callers[`case${useCase}`] as { explanations: Readonly<Record<string, string>> };
    const records = preview.features.records(origin.id).map((stored) => JSON.parse(stored.file) as { type: string; author: Record<string, string>; payload: Record<string, unknown> });
    // Replays each item's state from its signed records; at each write into a fork, every item there is approved from its side.
    const states = new Map<string, { feature: string; state: string; ownerAsked: unknown }>();
    let writes = 0;
    for (const record of records) {
      if (steps.includes(record.type)) {
        states.set(String(record.payload["item_id"]), { feature: String(record.payload["feature"]), state: String(record.payload["to"]), ownerAsked: record.payload["owner_asked"] });
        continue;
      }
      if (record.type !== "fix_write") continue;
      const target = String(record.payload["target_repo"]).replace(/^feature-/u, "");
      const open = [...states.values()].filter((item) => item.feature === target && (item.ownerAsked !== null || !["confirmed", "fix_approved", "written", "approved", "withdrawn"].includes(item.state)));
      assert.deepEqual(open, [], `${origin.id}'s write into ${target} waits for that worktree's approval`);
      if (states.size > 0) writes += 1;
    }
    assert.ok(writes > 0, `${origin.id} writes into a receiving fork after its approval`);
    // Each receiving agent confirms with its own identity; each explanation is the case's words, reviewed by the receiving agent.
    const confirmed = records.filter((record) => record.type === "confirm_caller");
    assert.ok(confirmed.length > 0, `${origin.id}'s unaffected callers are confirmed`);
    for (const record of confirmed) assert.equal(record.author["identity"], builderOf(LARDER.features.find((feature) => feature.id === record.payload["feature"]) as LarderFeature));
    const explained = records.filter((record) => record.type === "explain_difference" && record.payload["action"] === "explain");
    assert.ok(explained.length > 0, `${origin.id}'s differences are explained`);
    for (const record of explained) assert.equal(record.payload["text"], words.explanations[String(record.payload["feature"])]);
    assert.ok(records.some((record) => record.type === "review_caller" && record.payload["to"] === "approved"), `${origin.id}'s explained differences are approved`);
    // At the land every item is settled.
    const left = preview.callerItemsOf(origin.id).filter((item) => !["confirmed", "written", "approved"].includes(item.state) || item.ownerAsked !== null);
    assert.deepEqual(left.map((item) => `${item.feature} ${item.state}`), []);
  }
  // Case 3's payouts and tips match once Penguin's update is in, and their agents still confirm them.
  const case3 = preview.callerItemsOf(originOf(3).id);
  for (const feature of ["instant-payouts", "tip-jar"]) {
    assert.deepEqual(case3.filter((item) => item.feature === feature).map((item) => [item.verdict, item.state]), [["unaffected", "confirmed"]], feature);
  }
});

test("cases 1 to 3 each write their approved fixes, copy the originating modules into each affected fork before the land, pass the block checks and reach promotion, in order", async () => {
  const preview = await larder();
  // The retiring-calls check runs on a checkpoint, not on a block.
  const blockChecks = BLOCK_CHECK_NAMES.filter((name) => name !== "retiring");
  const promotedAt: string[] = [];
  for (const useCase of [1, 2, 3]) {
    const origin = originOf(useCase);
    // Case 2 proposes no plan: its revision leaves every fork as it was.
    const parts = (await preview.plan(origin.id))?.parts ?? [];
    const writes = recordsOf(preview, origin.id, "fix_write");
    const written = writes.map((record) => record.payload["part_id"]);
    const featureParts = parts.filter((part) => part.place.kind === "feature");
    // Penguin's check runner updates every affected fork; no agent writes into one.
    assert.deepEqual([...written].sort(), featureParts.map((part) => part.partId).sort(), `${origin.id} updates every affected fork`);
    assert.ok(writes.every((record) => record.payload["written_by"] === "penguin"), `${origin.id}'s updates are Penguin's`);
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
