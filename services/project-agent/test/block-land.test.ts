// Landing a feature as a block (#96, PRD 0.4 section 4.5) on the repository fix-project.ts builds:
// Ines's money feature renames `price`, its plan fixes billing on main in her own fork and Rahul's tax
// feature in his fork. Once both parts are approved and the tax fix is written, Ines's agent lands.
// The check runner's reports are scripted; the push to main runs real Git (main-push.ts) against a bare
// repository standing for the base repo, so every test can show where main is.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { MAIN_TARGET, type BlockCheck, type BlockRunRequest, type Promotion } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import {
  BlockQueueStore,
  claimBlockRuns,
  featureLanded,
  landFailed,
  planStillApproved,
  reportBlockRun,
  requestLand,
  requestPlanCheck,
  retryLand,
  signBlockRecord,
  type BlockProjectPort,
  type BlockReportDeps,
  type FeatureBlocks,
  type LandDeps,
} from "../src/block-land.ts";
import { BlockStore } from "../src/block-store.ts";
import { featureTokenGrant } from "../src/feature-open.ts";
import { agentFixGrant, agentFixReport, type ForkReading } from "../src/fix-write.ts";
import { fastForwardMain } from "../src/main-push.ts";
import { checkProtectedChanges, confirmProtectedChange, ownChange, ProtectedChangeStore, unconfirmedProtected } from "../src/protected-change.ts";
import { fileDiffs } from "../src/repo-diff.ts";
import { gitServer, reportOf } from "./block-support.ts";
import { FixProject, git, SCOPES, SESSIONS, TAX, TAX_FIXED, TAX_FORK } from "./fix-project.ts";
import { gitReader } from "./git-reader.ts";

const BILLING = "money-minor/v1#1";
const RUNNER = { bridgeId: "runner-1", role: "runner" as const };

describe("landing a feature as a block", () => {
  let fx: FixProject;
  let base: string;
  let blocks: BlockStore;
  let queue: BlockQueueStore;
  let protectedChanges: ProtectedChangeStore;
  const notified: string[] = [];
  const sealed: string[] = [];
  let slotHeldElsewhere = false;

  beforeEach(async () => {
    fx = await FixProject.create();
    base = join(fx.root, "base.git");
    git(fx.root, "clone", "--quiet", "--bare", fx.repo.dir, base);
    git(base, "update-ref", "refs/heads/main", fx.main);
    blocks = new BlockStore(fx.project.sql, () => fx.now);
    queue = new BlockQueueStore(fx.project.sql, () => fx.now);
    protectedChanges = new ProtectedChangeStore(fx.project.sql, () => fx.now);
    notified.length = 0;
    sealed.length = 0;
    slotHeldElsewhere = false;
  });

  afterEach(() => fx.remove());

  /** Each repo by the name the stores give it: main is the bare base, the tax fork its own, the rest the shared repository. */
  const dirOf = (name: string): string => (name === "base" ? base : name === TAX_FORK ? fx.forkDir : name === "feature-sam-reports" ? base : fx.repo.dir);
  const readRepo: ForkReading = async (name, read) => {
    const dir = dirOf(name);
    return read({
      ...gitReader(dir),
      log: async ({ ref, limit }) => {
        try {
          return git(dir, "log", "--first-parent", "--format=%H", `-n${limit}`, ref).split("\n").filter(Boolean).map((hash) => ({ hash }));
        } catch {
          return [];
        }
      },
    });
  };
  const agent = (): FeatureBlocks => ({
    latestPlan: (id) => fx.project.plans.latestPlan(id),
    fixWrites: (id) => fx.project.plans.fixWrites(id),
    openBlockRun: (input) => blocks.open(input),
    claimBlockRuns: (runner) => ({ runs: blocks.claim(runner), waiting: blocks.hasWaiting() }),
  });
  const landDeps = (): LandDeps => ({
    features: fx.project.features,
    heartbeat: fx.heartbeat,
    charter: (handle, person) => ({ handle, person, scopes: ["money"], paths: [] }),
    agent,
    readRepo,
    baseRepo: "base",
    branch: "main",
    queue,
    unconfirmedProtected: (id) => unconfirmedProtected(protectedChanges, id),
    sign: (draft) => fx.project.sign(draft),
    notify: (person) => notified.push(person),
    now: () => fx.now,
  });
  const port = (): BlockProjectPort => ({
    signBlockRecord: (feature, type, payload) => signBlockRecord(fx.project.features, (draft) => fx.project.sign(draft), feature, type, payload),
    acquirePromotion: async (feature, run) => !slotHeldElsewhere && queue.acquire(feature, run),
    releasePromotion: async (run) => queue.release(run),
    featureLanded: (feature, promotion) =>
      featureLanded(
        { features: fx.project.features, queue, retirePlan: (id) => fx.coverage.retire(id), recheckLocks: async () => undefined, notify: (person) => notified.push(person) },
        feature,
        promotion,
      ),
    landFailed: async (feature) => landFailed({ features: fx.project.features, notify: (person) => notified.push(person) }, feature),
    retryLand: async (feature, run, charter) => {
      const retried = await retryLand(landDeps(), feature, { runId: run, charter });
      return retried.status === "checking" ? { status: retried.status, runId: retried.run.runId } : retried;
    },
    expandPromoted: async () => undefined,
    retryExpand: async () => ({ status: "rejected", reason: "not_found", message: "no expand in these tests" }),
  });
  const reportDeps = (): BlockReportDeps => ({
    store: blocks,
    fixWrites: (id) => fx.project.plans.fixWrites(id),
    port: port(),
    push: (run) =>
      fastForwardMain({
        source: { remote: "https://artifacts.test/git/feature-money-minor.git", token: "read" },
        target: { remote: "https://artifacts.test/git/base.git", token: "write" },
        branch: run.request.branch,
        before: run.mainBefore,
        after: run.checkpoint,
        fetch: gitServer({ base, "feature-money-minor": fx.repo.dir }),
      }),
    seal: async (run) => {
      sealed.push(run.request.fork);
      return 1;
    },
    planApproved: (featureId, planId) => planStillApproved(fx.project.plans.latestPlan(featureId), planId),
    now: () => fx.now,
  });
  const land = (input: Record<string, unknown> = {}, session: string = SESSIONS.ines, caller = "ines") =>
    requestLand(landDeps(), caller, session, { feature: "money-minor", ...input });
  const claim = async (): Promise<BlockRunRequest[]> => {
    const claimed = await claimBlockRuns(queue, agent, RUNNER);
    assert.equal(claimed.status, "ok");
    return claimed.status === "ok" ? [...claimed.runs] : [];
  };
  const mainHead = () => git(base, "rev-parse", "main");
  /** A commit on main in the base repo that no feature holds: another block that landed first. */
  const anotherBlock = () =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", "-p", fx.main, "-m", "Another block", `${fx.main}^{tree}`], { cwd: base, encoding: "utf8" }).trim();
  const refused = (outcome: { readonly status: string; readonly reason?: string }, reason: string) => {
    assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
    assert.equal(outcome.reason, reason, JSON.stringify(outcome));
  };

  /** Stores the plan, approves both parts, writes the tax fix into Rahul's fork and checkpoints the billing fix. */
  async function ready(): Promise<string> {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    await fx.approve(BILLING, 1, "bea");
    return writeTaxFix();
  }

  async function writeTaxFix(): Promise<string> {
    const grant = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 });
    assert.equal(grant.status, "ok", JSON.stringify(grant));
    if (grant.status !== "ok") throw new Error("no grant");
    const commit = fx.pushToFork(grant.spec.parent, { "tax/rounding.py": TAX_FIXED }, grant.spec.message);
    const written = await agentFixReport(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1, commit });
    assert.equal(written.status, "ok", JSON.stringify(written));
    await fx.project.checkpoint("money-minor", fx.billingFix, fx.main, "@ines/money");
    return commit;
  }

  test("a feature lands only when it is ready: plan approved, fixes written and in place, main taken", async () => {
    // Sam's checkpoint is main itself: there is nothing to land.
    refused(await land({ feature: "sam-reports" }, SESSIONS.sam, "sam"), "not_ready");
    await fx.proposeWith(TAX_FIXED);
    refused(await land(), "plan_not_approved");
    await fx.approve();
    await fx.approve(BILLING, 1, "bea");
    refused(await land(), "fix_not_written");
    await writeTaxFix();
    // The checkpoint the plan stored holds the rename but not the billing fix.
    await fx.project.checkpoint("money-minor", fx.checkpoint, fx.main, "@ines/money");
    refused(await land(), "fix_not_in_block");
    await fx.project.checkpoint("money-minor", fx.billingFix, fx.main, "@ines/money");
    refused(await land({ checkpoint: fx.checkpoint }), "conflict");
    refused(await land({ checkpoint: "HEAD" }), "invalid");
    refused(await land({}, SESSIONS.rahul, "rahul"), "forbidden");
    // Any agent of the feature may land it, once: a second land waits for the first.
    assert.equal((await land({}, SESSIONS.inesOther)).status, "checking");
    refused(await land(), "busy");
    assert.equal(mainHead(), fx.main, "nothing moved main");
  });

  test("a feature whose own change writes a path another person protects lands only once that person confirms the lines", async () => {
    await ready();
    // Bea protects billing/old.py, which Ines's own checkpoint rewrites; the tax fix sits in Rahul's fork.
    const scopeMap = parseScopeMap({
      scopes: SCOPES.scopes.map((each) => (each.id === "billing" ? { ...each, protected_paths: ["billing/old.py"] } : each)),
    });
    const feature = fx.project.features.get("money-minor");
    assert.ok(feature);
    const mainLog = { log: async ({ limit }: { limit: number }) => git(base, "log", "--first-parent", "--format=%H %T", `-n${limit}`, "main").split("\n").map((line) => ({ hash: line.split(" ")[0] as string, treeHash: line.split(" ")[1] as string })) };
    const asked = await checkProtectedChanges(
      {
        store: protectedChanges,
        inbox: fx.project.inbox,
        notify: (person) => notified.push(person),
        readOwnChange: (_repo, sha) => ownChange(gitReader(fx.repo.dir), mainLog, sha),
        readDiffs: async (_repo, files) => (await fileDiffs(gitReader(fx.repo.dir), files, () => null)).files,
      },
      feature,
      fx.billingFix,
      scopeMap,
    );
    assert.deepEqual(asked, ["bea"]);
    const waiting = await land();
    refused(waiting, "protected_path_unconfirmed");
    assert.match(waiting.status === "rejected" ? waiting.message : "", /bea \(billing\/old\.py\)/u);
    const confirmDeps = {
      store: protectedChanges,
      inbox: fx.project.inbox,
      notify: (person: string) => notified.push(person),
      features: fx.project.features,
      delegates: async () => new Map<string, string>(),
      sign: (draft: Parameters<typeof fx.project.sign>[0]) => fx.project.sign(draft),
    };
    const byOther = await confirmProtectedChange(confirmDeps, "ines", { feature: "money-minor", owner: "bea", checkpoint: fx.billingFix });
    assert.equal(byOther.status === "rejected" && byOther.reason, "forbidden", "the feature's own person cannot confirm another person's lines");
    assert.equal((await confirmProtectedChange(confirmDeps, "bea", { feature: "money-minor", owner: "bea", checkpoint: fx.billingFix })).status, "ok");
    assert.equal((await land()).status, "checking");
  });

  test("a fix whose commit is no longer under its fork's head is not in place", async () => {
    await ready();
    // Rahul's fork main is pushed back to the head before the fix.
    git(fx.forkDir, "update-ref", "refs/heads/main", fx.main);
    refused(await land(), "fix_not_in_place");
  });

  test("main that moved past the checkpoint sends the agent to take main first", async () => {
    await ready();
    git(base, "update-ref", "refs/heads/main", anotherBlock());
    refused(await land(), "behind_main");
  });

  test("a block with one failing target does not move main, and the feature goes back to building with one next step per failure", async () => {
    await ready();
    const asked = await land();
    assert.equal(asked.status, "checking", JSON.stringify(asked));
    assert.equal(fx.project.features.get("money-minor")?.state, "landing");
    const [run] = await claim();
    assert.ok(run);
    assert.deepEqual(
      run.targets.map((each) => each.feature),
      ["sam-reports", "tax-rounding"],
    );
    // The tax target is Rahul's fork head, with Ines's fix in place.
    assert.equal(run.targets.find((each) => each.feature === "tax-rounding")?.sha, git(fx.forkDir, "rev-parse", "main"));
    assert.equal(run.main, fx.main);
    assert.equal(run.checkpoint, fx.billingFix);

    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run, [{ target: "tax-rounding", check: "tests" }]))));
    assert.equal(result.status, "recorded", JSON.stringify(result));
    if (result.status !== "recorded") return;
    assert.deepEqual([result.passed, result.state, result.promotion], [false, "failed", null]);
    assert.equal(mainHead(), fx.main, "main is unchanged");
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    const stored = blocks.get(run.runId);
    assert.deepEqual(stored?.failing.map(({ target, check }) => `${target} ${check}`), ["tax-rounding tests"]);
    assert.equal(stored?.decisions.length, 1);
    const [record] = fx.records("block_checked");
    assert.ok(record);
    assert.deepEqual([record.payload["passed"], record.payload["run_id"], (record.payload["checks"] as unknown[]).length], [false, run.runId, 6]);
  });

  test("when every check passes, main moves to the checkpoint in one push and the fork turns read-only", async () => {
    const taxFix = await ready();
    const asked = await land();
    assert.equal(asked.status, "checking");
    const [run] = await claim();
    assert.ok(run);
    fx.now += 2_000;
    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run))));
    assert.equal(result.status, "recorded", JSON.stringify(result));
    if (result.status !== "recorded") return;
    assert.equal(result.state, "promoted");
    assert.equal(mainHead(), fx.billingFix, "main moved to the originating feature's checkpoint");
    assert.equal(git(base, "rev-list", "--count", `${fx.main}..main`), "2", "one fast-forward over the feature's two commits");

    const promotion = result.promotion as Promotion;
    assert.deepEqual([promotion.mainBefore, promotion.mainAfter, promotion.checkMs], [fx.main, fx.billingFix, 2_000]);
    assert.deepEqual(promotion.fixes, [{ partId: TAX, revision: 1, targetRepo: TAX_FORK, commitSha: taxFix }]);
    assert.deepEqual(blocks.promotion("money-minor"), promotion);
    const [record] = fx.records("promotion");
    assert.deepEqual([record?.payload["main_before"], record?.payload["main_after"]], [fx.main, fx.billingFix]);
    assert.equal(record?.signature.length > 0, true);
    // Every step is a signed record.
    for (const type of ["land_requested", "block_checked", "promotion"]) assert.equal(fx.records(type).length, 1, type);

    assert.equal(fx.project.features.get("money-minor")?.state, "landed");
    assert.deepEqual(sealed, ["feature-money-minor"]);
    assert.deepEqual(queue.queued(), []);
    assert.ok(notified.includes("rahul"), "the person whose fork carries a fix hears");
    // The landed fork gets no write token, and no fix is written for its plan.
    const grant = featureTokenGrant(
      { features: fx.project.features, heartbeat: fx.heartbeat, overlapStatus: () => ({ waitingOn: [], approved: [], ownOverlaps: [], dependents: [] }) } as never,
      "ines",
      SESSIONS.ines,
      "money-minor",
    );
    refused(grant, "forbidden");
    refused(await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 }), "conflict");
    refused(await land(), "conflict");
  });

  test("a land run's plan must still be the newest with every part approved; an expand's, when there is one", async () => {
    await fx.proposeWith(TAX_FIXED);
    const plan = fx.project.plans.latestPlan("money-minor");
    assert.ok(plan);
    assert.deepEqual([planStillApproved(plan, plan.planId), planStillApproved(plan, null)], [false, false]);
    const approved = { ...plan, parts: plan.parts.map((part) => ({ ...part, approvalState: "approved" as const })) };
    assert.deepEqual([planStillApproved(approved, approved.planId), planStillApproved(approved, null), planStillApproved(approved, "money-minor/v9")], [true, true, false]);
    assert.deepEqual([planStillApproved(undefined, null), planStillApproved(undefined, plan.planId)], [true, false]);
  });

  test("an approval reversed while the block is checked stops the promotion", async () => {
    await ready();
    await land();
    const [run] = await claim();
    assert.ok(run);
    // The author reverses an approval of Penguin's before the run reports: the part waits on them again.
    const plan = fx.project.plans.latestPlan("money-minor");
    const billing = plan?.parts.find((part) => part.partId === BILLING);
    assert.ok(billing);
    assert.equal(fx.project.plans.replacePart("money-minor", { ...billing, approvalState: "pending", approvedBy: null }, { revision: 1, state: "approved" }), true);
    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run))));
    assert.equal(result.status, "recorded");
    if (result.status !== "recorded") return;
    assert.deepEqual([result.state, result.promotion], ["refused", null]);
    assert.equal(mainHead(), fx.main, "main does not move");
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    const [record] = fx.records("promotion_refused");
    assert.match(String(record?.payload["reason"]), /no longer approved/u);
  });

  test("a promotion that raced another push to main is refused and the land goes back through the checks", async () => {
    await ready();
    await land();
    const [run] = await claim();
    assert.ok(run);
    // Another promotion holds the slot: the land is checked again on main as it stands.
    slotHeldElsewhere = true;
    const raced = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run))));
    assert.equal(raced.status, "recorded");
    if (raced.status !== "recorded") return;
    assert.equal(raced.state, "raced");
    assert.equal(raced.retried?.status, "checking");
    assert.equal(mainHead(), fx.main);
    slotHeldElsewhere = false;

    // Main moves before the retried run reports: the push is refused and the land returns to the agent.
    const [again] = await claim();
    assert.ok(again);
    assert.equal(again.runId, raced.retried?.runId);
    const elsewhere = anotherBlock();
    git(base, "update-ref", "refs/heads/main", elsewhere);
    const moved = await reportBlockRun(reportDeps(), RUNNER, again.runId, JSON.parse(JSON.stringify(reportOf(again))));
    assert.equal(moved.status, "recorded");
    if (moved.status !== "recorded") return;
    assert.equal(moved.state, "raced");
    assert.equal(moved.retried?.reason, "behind_main");
    assert.equal(mainHead(), elsewhere, "main keeps the other push");
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    assert.equal(fx.records("promotion_refused").length, 2);
    assert.equal(fx.records("land_returned").length, 1);
  });

  test("the runner's report must answer the run it claimed", async () => {
    await ready();
    await land();
    const [run] = await claim();
    assert.ok(run);
    const valid = JSON.parse(JSON.stringify(reportOf(run)));
    refused(await reportBlockRun(reportDeps(), { bridgeId: "owner-1", role: "owner" }, run.runId, valid), "forbidden");
    refused(await reportBlockRun(reportDeps(), { bridgeId: "runner-2", role: "runner" }, run.runId, valid), "forbidden");
    const otherTarget = { ...valid, checks: [...valid.checks, { ...valid.checks[0], target: "elsewhere" }] };
    refused(await reportBlockRun(reportDeps(), RUNNER, run.runId, otherTarget), "invalid");
    const otherCommit = { ...valid, checks: valid.checks.map((check: BlockCheck) => ({ ...check, input: { ...check.input, origin: fx.main } })) };
    refused(await reportBlockRun(reportDeps(), RUNNER, run.runId, otherCommit), "invalid");
    refused(await reportBlockRun(reportDeps(), RUNNER, "money-minor/99", valid), "not_found");
    // A report with no tests on main never passes.
    const untested = { ...valid, checks: valid.checks.filter((check: BlockCheck) => !(check.target === MAIN_TARGET && check.check === "tests")) };
    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, untested);
    assert.equal(result.status === "recorded" && result.passed, false);
    refused(await reportBlockRun(reportDeps(), RUNNER, run.runId, valid), "conflict");
    assert.equal(mainHead(), fx.main);
    assert.deepEqual(await claimBlockRuns(queue, agent, { bridgeId: "owner-1", role: "owner" }), { status: "forbidden", message: "bridge owner-1 does not hold the runner role" });
  });

  test("a checkpoint in an open plan's area asks for the plan's check, which never moves main", async () => {
    await ready();
    const run = await requestPlanCheck(landDeps(), "money-minor", { feature: "tax-rounding", checkpoint: fx.main });
    assert.ok(run);
    assert.equal(run.purpose, "plan_check");
    const [claimed] = await claim();
    assert.equal(claimed?.runId, run.runId);
    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(claimed as BlockRunRequest))));
    assert.equal(result.status === "recorded" && result.state, "passed");
    assert.equal(mainHead(), fx.main);
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    assert.equal(fx.records("plan_check_requested").length, 1);
    // A land supersedes nothing it should not: a plan check waiting is replaced by the land.
    await requestPlanCheck(landDeps(), "money-minor", { feature: "tax-rounding", checkpoint: fx.main });
    const asked = await land();
    assert.equal(asked.status, "checking");
    assert.equal(blocks.latest("money-minor", "plan_check")?.state, "superseded");
    // While the land holds the feature, a plan check waits for it.
    assert.equal(await requestPlanCheck(landDeps(), "money-minor", { feature: "tax-rounding", checkpoint: fx.main }), undefined);
  });
});
