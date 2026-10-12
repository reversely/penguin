// Penguin's half of part trials (PRD 0.5 sections 4.3 and 6): which tree each part revision is tested
// on, which trial still counts, what a report must hold to be kept, the reviews a trial completes, and
// `check` claiming the same fork heads a land merges onto. The runner's half runs on the fixtures in
// tests/integration/part-trial.test.ts.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  PART_TRIAL_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  type PartTrialReport,
  type PartTrialRequest,
  type Plan,
  type PlanPart,
  type ReviewForm,
  type ReviewRecord,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { AgentToolStore } from "../src/agent-tools.ts";
import { claimToolRuns } from "../src/agent-tool-runner.ts";
import { blockTargets, type LandDeps } from "../src/block-land.ts";
import { reviewTarget } from "../src/edit-work.ts";
import {
  claimPartTrials,
  PartTrialStore,
  queueTrials,
  queueTrialsForReview,
  recordPartTrial,
  trialEvidence,
  trialHolds,
  trialStanding,
} from "../src/part-trial.ts";
import { routePart } from "../src/plan-approval.ts";
import { claimReviews } from "../src/review-record.ts";
import { ReviewStore, type StoredReview } from "../src/review-submit.ts";
import { PlanProject } from "./plan-project.ts";

const BASELINE = "a".repeat(40);
const CHECKPOINT = "b".repeat(40);
const FIX = "c".repeat(40);
const FIX_BASE = "d".repeat(40);
const JUN_HEAD = "e".repeat(40);
const JUN_FIXED = "f".repeat(40);
const TREE = "1".repeat(40);
const RUNNER = { bridgeId: "runner-1", role: "runner" as const };
const OWNER_BRIDGE = { bridgeId: "bridge-jun", role: "owner" as const };

const scope = (id: string, owner: string) => ({ id, name: id, owner, paths: [`${id}/`], test_command: "true", contracts: [], depends_on: [] });
const scopeMap = parseScopeMap({ scopes: [scope("ingestion", "priya"), scope("analytics", "jun"), scope("messaging", "sam")] });

const PATCH = "--- a/analytics/weekly.py\n+++ b/analytics/weekly.py\n@@ -1 +1 @@\n-old\n+new\n";

function part(index: number, fields: Partial<PlanPart>): PlanPart {
  return {
    partId: `utc-day/v1#${index}`,
    revision: 1,
    place: { kind: "scope", scope: "messaging" },
    owner: "sam",
    scopes: ["messaging"],
    kind: "behavioural",
    kindReason: "",
    diff: { source: "commit", repo: "feature-utc-day", ref: "", commit: FIX, base: FIX_BASE, patch: null, files: [], truncated: false },
    callers: [],
    breaks: [],
    invariants: [],
    note: null,
    approvalState: "pending",
    approvedBy: null,
    changeRequests: 0,
    changeRequest: null,
    ...fields,
  };
}

const SCOPE_PART = part(1, {});
const FEATURE_PART = part(2, {
  place: { kind: "feature", feature: "weekly-report" },
  owner: "jun",
  scopes: ["analytics"],
  diff: { source: "patch", repo: "feature-weekly-report", ref: "", commit: null, base: JUN_HEAD, patch: PATCH, files: [], truncated: false },
});

function plan(version: number, parts: readonly PlanPart[] = [SCOPE_PART, FEATURE_PART]): Plan {
  return {
    planId: `utc-day/v${version}`,
    featureId: "utc-day",
    version,
    facts: { change: { checkpoint: CHECKPOINT, baseline: BASELINE, subject: "", madeBy: "" } },
    parts,
  } as unknown as Plan;
}

const FORM: ReviewForm = {
  rows: [{ invariant: "evening-activity-local-day", verdict: "holds", evidence: ["analytics/weekly.py::weekly_report"], storedData: "" }],
  riskyInputs: [],
  storedDataMarker: null,
};
const INVARIANTS = [{ id: "evening-activity-local-day", scopeId: "analytics", statement: "Evening activity stays on its local day", protected: true }];

function record(base: string, fork: string, differing: number): ReviewRecord {
  const differences = Array.from({ length: differing }, (_, index) => ({
    name: `case ${index}`,
    args: {},
    main: { status: "returned" as const, value: 1 },
    fork: { status: "returned" as const, value: 2 },
  }));
  const sideBySide: ReviewRecord["sideBySide"] = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    tool: SIDE_BY_SIDE_TOOL,
    commandId: SIDE_BY_SIDE_COMMAND_ID,
    base,
    fork,
    scope: "analytics",
    sets: [
      {
        source: "examples" as const,
        file: "analytics/examples/weekly_report.json",
        contract: "analytics/weekly.py::weekly_report",
        invariants: ["evening-activity-local-day"],
        inputs: ["case 0", "case 1"],
        differing: differences,
        invalid: [],
        mainMs: 1,
        forkMs: 1,
      },
    ],
    totals: { inputs: 2, differing, invalid: 0 },
    timings: { mainMs: 1, forkMs: 1, totalMs: 2 },
  };
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    base,
    fork,
    scope: "analytics",
    state: "accepted",
    refusals: [],
    invariants: INVARIANTS,
    storedShapes: [],
    sideBySide,
    exceptions: [],
    timings: { impactMs: 1, sideBySideMs: 1, totalMs: 2 },
  };
}

function report(request: PartTrialRequest, fields: Partial<PartTrialReport> = {}, differing = 0): PartTrialReport {
  return {
    schemaVersion: PART_TRIAL_SCHEMA_VERSION,
    trialId: request.trialId,
    partId: request.partId,
    revision: request.revision,
    checkpoint: request.checkpoint,
    target: request.target.sha,
    status: "built",
    tree: TREE,
    reason: null,
    tests: request.commandIds.map((commandId) => ({ scopeId: commandId.slice(5), commandId, status: "passed", breaks: [], reason: null, durationMs: 1 })),
    reviews: request.reviews.map(({ reviewId, scope }) => ({ reviewId, scope, record: record(request.target.sha, TREE, differing) })),
    durationMs: 3,
    ...fields,
  };
}

describe("part trials", () => {
  let project: PlanProject;
  let reviews: ReviewStore;
  let trials: PartTrialStore;
  let routed: string[];
  let now: number;

  beforeEach(() => {
    project = new PlanProject(scopeMap, "/nonexistent");
    now = 1_000;
    reviews = new ReviewStore(project.sql, () => now);
    trials = new PartTrialStore(project.sql, () => now);
    routed = [];
  });

  const submit = (fields: Partial<StoredReview> = {}): StoredReview =>
    reviews.insert({
      featureId: "utc-day",
      scopeId: "analytics",
      ownerId: "jun",
      reviewer: "@jun/reports",
      sessionId: "s-jun",
      forkSha: CHECKPOINT,
      baseSha: BASELINE,
      form: FORM,
      invariants: INVARIANTS,
      state: "pending",
      refusals: [],
      ...fields,
    });
  const recordDeps = () => ({ trials, reviews, routeToOwner: (owner: string) => routed.push(owner) });
  const claimed = (): PartTrialRequest[] => {
    const claim = claimPartTrials(trials, RUNNER);
    return claim.status === "ok" ? [...claim.trials] : [];
  };

  test("a part for code on main is tried on main with its fix commit, a running feature's on its fork head with its patch", () => {
    const form = submit();
    queueTrials({ trials, reviews }, plan(1));
    const [onMain, onFork] = claimed();
    assert.deepEqual(onMain?.target, { id: "main", repo: "base", sha: BASELINE });
    assert.deepEqual(onMain?.fix, { kind: "commit", repo: "feature-utc-day", commit: FIX, base: FIX_BASE });
    assert.deepEqual([onMain?.commandIds, onMain?.reviews], [["test:messaging"], []]);
    assert.deepEqual(onFork?.target, { id: "weekly-report", repo: "feature-weekly-report", sha: JUN_HEAD });
    assert.deepEqual(onFork?.fix, { kind: "patch", patch: PATCH });
    assert.deepEqual([onFork?.checkpoint, onFork?.commandIds], [CHECKPOINT, ["test:analytics"]]);
    // The newest form of the part's scope on the plan's checkpoint comes with the trial.
    assert.deepEqual(onFork?.reviews.map((each) => [each.reviewId, each.scope]), [[form.id, "analytics"]]);
  });

  test("a verify part is tried with no fix and no form: the checkpoint merged onto its place (#148)", async () => {
    submit();
    const none = { source: "none" as const, ref: "", commit: null, patch: null, files: [], truncated: false, outside: [] };
    const onMain = part(3, { kind: "verify", diff: { ...none, repo: "feature-utc-day", base: null } });
    const onFork = part(4, { kind: "verify", place: { kind: "feature", feature: "weekly-report" }, owner: "jun", scopes: ["analytics"], diff: { ...none, repo: "feature-weekly-report", base: JUN_HEAD } });
    queueTrials({ trials, reviews }, plan(1, [onMain, onFork]));
    const [main, fork] = claimed();
    assert.deepEqual([main?.target, main?.fix, main?.commandIds, main?.reviews], [{ id: "main", repo: "base", sha: BASELINE }, { kind: "none" }, ["test:messaging"], []]);
    // Jun's form on the plan's checkpoint is not carried: a verify part needs none.
    assert.deepEqual([fork?.target, fork?.fix, fork?.reviews], [{ id: "weekly-report", repo: "feature-weekly-report", sha: JUN_HEAD }, { kind: "none" }, []]);
    // A clean trial clears every check, with no review asked for.
    await recordPartTrial(recordDeps(), RUNNER, (fork as PartTrialRequest).trialId, report(fork as PartTrialRequest));
    const standing = trialStanding(trials, reviews, "utc-day", onFork);
    assert.deepEqual(routePart(plan(1, [onMain, onFork]), onFork, reviews.list("utc-day"), scopeMap, false, standing).reasons, []);
  });

  test("a review task carries its part revision's trial tree, as the part's trial builds it (#140)", () => {
    const task = (partId: string, revision = 1) => ({ target: "utc-day", ref: { part: partId, revision, scope: "analytics" }, scopes: ["analytics"] });
    const onFork = reviewTarget(task(FEATURE_PART.partId), plan(1));
    assert.deepEqual(onFork, {
      feature: "utc-day",
      scope: "analytics",
      part: FEATURE_PART.partId,
      revision: 1,
      trial: { checkpoint: CHECKPOINT, target: { id: "weekly-report", repo: "feature-weekly-report", sha: JUN_HEAD }, fix: { kind: "patch", patch: PATCH } },
    });
    assert.deepEqual(reviewTarget(task(SCOPE_PART.partId), plan(1))?.trial, {
      checkpoint: CHECKPOINT,
      target: { id: "main", repo: "base", sha: BASELINE },
      fix: { kind: "commit", repo: "feature-utc-day", commit: FIX, base: FIX_BASE },
    });
    // A revision the newest plan no longer holds, or no plan, carries no trial.
    assert.equal(reviewTarget(task(FEATURE_PART.partId, 2), plan(1))?.trial, null);
    assert.equal(reviewTarget(task(FEATURE_PART.partId), undefined)?.trial, null);
  });

  test("a form on another checkpoint or refused at submission is not tried; the newest one is", () => {
    submit({ forkSha: "9".repeat(40) });
    submit({ baseSha: null, state: "refused" });
    const newest = submit();
    queueTrials({ trials, reviews }, plan(1), [FEATURE_PART]);
    assert.deepEqual(claimed()[0]?.reviews.map((each) => each.reviewId), [newest.id]);
  });

  test("a revision, a newer form or a newer plan replaces a trial; only the newest one counts", async () => {
    const [first] = queueTrials({ trials, reviews }, plan(1), [FEATURE_PART]);
    const [revised] = queueTrials({ trials, reviews }, plan(1, [{ ...FEATURE_PART, revision: 2 }]), [{ ...FEATURE_PART, revision: 2 }]);
    assert.equal(trials.get(first?.id ?? 0)?.state, "superseded");
    assert.equal(trials.ofPart("utc-day", FEATURE_PART.partId)?.id, revised?.id);
    // A form of a scope no part covers asks for nothing; one of a covered scope asks again.
    assert.deepEqual(queueTrialsForReview({ trials, reviews }, plan(1), "ingestion", CHECKPOINT), []);
    const [again] = queueTrialsForReview({ trials, reviews }, plan(1, [{ ...FEATURE_PART, revision: 2 }]), "analytics", CHECKPOINT);
    assert.equal(trials.get(revised?.id ?? 0)?.state, "superseded");
    // A form on a checkpoint the plan was not made on asks for nothing.
    assert.deepEqual(queueTrialsForReview({ trials, reviews }, plan(1), "analytics", "9".repeat(40)), []);
    queueTrials({ trials, reviews }, plan(2), [SCOPE_PART]);
    assert.equal(trials.get(again?.id ?? 0)?.state, "superseded");
    // The superseded trial's report is answered as such and not kept.
    const request = trials.get(again?.id ?? 0)?.request as PartTrialRequest;
    const outcome = await recordPartTrial(recordDeps(), RUNNER, request.trialId, report(request));
    assert.equal(outcome.status, "superseded");
    assert.equal(trials.get(request.trialId)?.report, null);
  });

  test("only a runner claims trials; a claim is held for its lease", () => {
    queueTrials({ trials, reviews }, plan(1));
    assert.equal(claimPartTrials(trials, OWNER_BRIDGE).status, "forbidden");
    assert.equal(claimed().length, 2);
    assert.equal(claimed().length, 0);
    now += 31 * 60_000;
    assert.equal(claimed().length, 2);
  });

  test("a report must be of its trial: its part, revision, target, test commands and forms on its tree", async () => {
    submit();
    queueTrials({ trials, reviews }, plan(1), [FEATURE_PART]);
    const [request] = claimed() as [PartTrialRequest];
    const wrong: PartTrialReport[] = [
      report(request, { revision: 2 }),
      report(request, { target: BASELINE }),
      report(request, { tests: [] }),
      report(request, { reviews: [] }),
      report(request, { status: "built", tree: null }),
      { ...report(request), reviews: report(request).reviews.map((each) => ({ ...each, record: record(BASELINE, TREE, 0) })) },
      { ...report(request), reviews: report(request).reviews.map((each) => ({ ...each, record: record(JUN_HEAD, JUN_FIXED, 0) })) },
    ];
    for (const body of wrong) {
      const outcome = await recordPartTrial(recordDeps(), RUNNER, request.trialId, JSON.parse(JSON.stringify(body)));
      assert.equal(outcome.status, "rejected", JSON.stringify(body).slice(0, 200));
    }
    assert.equal((await recordPartTrial(recordDeps(), OWNER_BRIDGE, request.trialId, report(request))).status, "rejected");
    assert.equal((await recordPartTrial(recordDeps(), RUNNER, 999, report(request))).status, "rejected");
    assert.equal((await recordPartTrial(recordDeps(), RUNNER, request.trialId, report(request))).status, "recorded");
    const twice = await recordPartTrial(recordDeps(), RUNNER, request.trialId, report(request));
    assert.deepEqual([twice.status, (twice as { reason: string }).reason], ["rejected", "conflict"]);
  });

  test("a kept trial completes the form it ran and is the part revision's evidence", async () => {
    const form = submit();
    queueTrials({ trials, reviews }, plan(1), [FEATURE_PART]);
    // The review claim leaves the form to the trial while the trial runs.
    assert.equal(trialHolds(trials, form), true);
    const listing = claimReviews(reviews, RUNNER, (review) => trialHolds(trials, review));
    assert.deepEqual(listing.status === "ok" ? listing.reviews : ["not ok"], []);
    const [request] = claimed() as [PartTrialRequest];
    assert.equal(trialEvidence(trials, reviews, "utc-day", FEATURE_PART), undefined, "a running trial is no evidence yet");
    const outcome = await recordPartTrial(recordDeps(), RUNNER, request.trialId, report(request, {}, 2));
    assert.equal(outcome.status, "recorded");
    const completed = reviews.get(form.id);
    assert.deepEqual([completed?.state, completed?.record?.fork, completed?.exceptions.map((each) => each.kind)], ["accepted", TREE, ["protected_difference"]]);
    assert.deepEqual(routed, ["jun"]);
    const evidence = trialEvidence(trials, reviews, "utc-day", FEATURE_PART);
    assert.deepEqual(evidence?.tests, {
      target: "weekly-report",
      runId: `trial-${request.trialId}`,
      fixInTree: true,
      results: [{ scopeId: "analytics", commandId: "test:analytics", status: "passed", breaks: 0 }],
    });
    assert.deepEqual(evidence?.reviews.map((each) => [each.reviewId, each.forkSha, each.state, each.exceptions.length, each.notHolding]), [[form.id, CHECKPOINT, "accepted", 1, []]]);
    // The evidence is of one revision: a revised part has none until its own trial reports.
    assert.equal(trialEvidence(trials, reviews, "utc-day", { ...FEATURE_PART, revision: 2 }), undefined);
  });

  test("Penguin's checks read the trial: a running trial waits, a clean one passes, a difference on its tree goes to a person", async () => {
    // A running feature's patch is in no facts-run tree, so without a trial its tests are not clean.
    const part: PlanPart = {
      ...FEATURE_PART,
      diff: { ...FEATURE_PART.diff, outside: [] },
      tests: { target: "weekly-report", runId: "facts-1", fixInTree: false, results: [{ scopeId: "analytics", commandId: "test:analytics", status: "failed", breaks: 1 }] },
    };
    const kinds = (trial: ReturnType<typeof trialStanding>) =>
      routePart(plan(1, [part]), part, reviews.list("utc-day"), scopeMap, false, trial).reasons.map((reason) => ("state" in reason ? `${reason.kind}:${reason.state}` : `${reason.kind}${"status" in reason ? `:${reason.status}` : ""}`));
    const form = submit();
    reviews.complete(form.id, { state: "accepted", refusals: [], record: record(BASELINE, CHECKPOINT, 0), sideBySideRef: "sha256:0", exceptions: [] });
    assert.deepEqual(kinds(undefined), ["tests:fix_not_run", "tests:failed"]);
    queueTrials({ trials, reviews }, plan(1, [part]), [part]);
    // While the trial runs, the form it carries waits for it, whatever the checkpoint's run said.
    assert.deepEqual(kinds(trialStanding(trials, reviews, "utc-day", part)), ["tests:fix_not_run", "tests:failed", "review:pending"]);
    const [request] = claimed() as [PartTrialRequest];
    await recordPartTrial(recordDeps(), RUNNER, request.trialId, report(request));
    assert.deepEqual(kinds(trialStanding(trials, reviews, "utc-day", part)), []);
    // The same trial with a difference on the protected invariant goes to the scope's owner.
    const [again] = queueTrials({ trials, reviews }, plan(1, [part]), [part]);
    const [rerun] = claimed() as [PartTrialRequest];
    assert.equal(rerun.trialId, again?.id);
    await recordPartTrial(recordDeps(), RUNNER, rerun.trialId, report(rerun, {}, 2));
    assert.deepEqual(kinds(trialStanding(trials, reviews, "utc-day", part)), ["protected_difference"]);
    // A revision has no trial yet, so the facts run counts again.
    assert.equal(trialStanding(trials, reviews, "utc-day", { ...part, revision: 2 }), undefined);
  });

  test("a trial whose tree does not build tests nothing and leaves its forms to the review claim", async () => {
    const form = submit();
    queueTrials({ trials, reviews }, plan(1), [FEATURE_PART]);
    const [request] = claimed() as [PartTrialRequest];
    const conflict = report(request, {
      status: "conflict",
      tree: null,
      reason: "the patch does not apply",
      tests: request.commandIds.map((commandId) => ({ scopeId: commandId.slice(5), commandId, status: "conflict", breaks: [], reason: "the patch does not apply", durationMs: 0 })),
      reviews: [],
    });
    assert.equal((await recordPartTrial(recordDeps(), RUNNER, request.trialId, conflict)).status, "recorded");
    assert.equal(trialEvidence(trials, reviews, "utc-day", FEATURE_PART)?.tests.fixInTree, false);
    assert.equal(trialHolds(trials, form), false);
    const listing = claimReviews(reviews, RUNNER, (review) => trialHolds(trials, review));
    assert.deepEqual(listing.status === "ok" ? listing.reviews.map((each) => each.reviewId) : [], [form.id]);
  });
});

describe("check and land targets", () => {
  test("check claims every other running fork at its head with written fixes, as a land merges onto it", async () => {
    const project = new PlanProject(scopeMap, "/nonexistent");
    const runs = new AgentToolStore(project.sql);
    await project.open("utc-day", "priya", { scopes: ["ingestion"] }, { id: "s-priya", handle: "@priya/batches" });
    await project.open("weekly-report", "jun", { scopes: ["analytics"] });
    await project.open("reminders", "sam", { scopes: ["messaging"] });
    await project.open("drafts", "sam", { scopes: ["messaging"] });
    await project.checkpoint("utc-day", CHECKPOINT, BASELINE, "@priya/batches");
    await project.checkpoint("weekly-report", JUN_HEAD, BASELINE, "@jun/reports");
    await project.checkpoint("reminders", "2".repeat(40), BASELINE, "@sam/reminders");
    // Jun's fork carries a fix written after his last checkpoint; Sam's draft fork has a head and no checkpoint yet.
    const heads: Record<string, string> = { "feature-weekly-report": JUN_FIXED, "feature-drafts": "3".repeat(40) };
    const readRepo: LandDeps["readRepo"] = async (repo, use) => use({ log: async () => (heads[repo] === undefined ? [] : [{ hash: heads[repo] }]) } as never);
    runs.insert({
      featureId: "utc-day",
      sessionId: "s-priya",
      caller: "@priya/batches",
      tool: "check",
      input: { feature: "utc-day" },
      result: "waiting",
      summary: "",
      checkpointSha: CHECKPOINT,
      durationMs: 0,
      identityId: "identity-priya",
      baseSha: BASELINE,
    });
    const features = project.features;
    const claim = await claimToolRuns(
      {
        runs,
        features,
        identity: () => ({ handle: "@priya/batches", ownerId: "priya", teamOwners: [], charterScopes: ["ingestion"], charterPaths: [] }),
        targets: (own) => blockTargets({ features, readRepo }, own),
      },
      RUNNER,
    );
    const forks = claim.status === "ok" ? claim.runs[0]?.forks : undefined;
    const land = await blockTargets({ features, readRepo }, "utc-day");
    assert.deepEqual(forks?.map(({ feature, checkpoint }) => [feature, checkpoint]), land.map(({ feature, sha }) => [feature, sha]));
    assert.deepEqual(land.map(({ feature, sha }) => [feature, sha]), [
      ["drafts", "3".repeat(40)],
      ["reminders", "2".repeat(40)],
      ["weekly-report", JUN_FIXED],
    ]);
  });
});
