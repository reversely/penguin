// Promoting a feature's expand checkpoint on its own (#115, PRD 0.5 section 4.2 step 2 and 4.5 step 6)
// on the repository fix-project.ts builds: Ines's money feature adds `price_minor` beside `price` in
// her fork and asks Penguin to promote that checkpoint alone. The facts run's impact report is
// scripted; the push to main runs real Git (main-push.ts) against a bare repository standing for the
// base repo, through the same block landing path as a land (block-land.ts).

import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  ownerLockId,
  type ImpactChange,
  type ImpactReport,
  type PlanFactsReport,
} from "@penguin/protocol";

import {
  BlockQueueStore,
  claimBlockRuns,
  landFailed,
  reportBlockRun,
  requestLand,
  retryLand,
  signBlockRecord,
  type BlockProjectPort,
  type BlockReportDeps,
  type FeatureBlocks,
  type LandDeps,
} from "../src/block-land.ts";
import { BlockStore } from "../src/block-store.ts";
import { onlyAddsFailures, requestExpand, retryExpand, type ExpandDeps } from "../src/expand-promotion.ts";
import { featureTokenGrant } from "../src/feature-open.ts";
import type { ForkReading } from "../src/fix-write.ts";
import { fastForwardMain } from "../src/main-push.ts";
import { approveOverlap, type OverlapDeps } from "../src/overlap-lock.ts";
import { gitServer, reportOf } from "./block-support.ts";
import { FixProject, git, SESSIONS } from "./fix-project.ts";
import { gitReader } from "./git-reader.ts";

const RUNNER = { bridgeId: "runner-1", role: "runner" as const };
const API = "shared/money/api.py";
const PRICE = "def price(item):\n    return item.amount\n";
const PRICE_MINOR = "\n\ndef price_minor(item):\n    return item.amount_minor\n";

const added = (symbol: string, path: string, scope: string): ImpactChange => ({ symbol, path, line: 4, kind: "function", change: "added", scope, contract: null });

function impact(base: string, head: string, taxHead: string, fields: Partial<ImpactReport> = {}): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base,
    head,
    changes: [added("shared.money.api.price_minor", API, "money")],
    signatures: [],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [{ id: "tax-rounding", sha: taxHead, scopes: ["tax"], since: base, mergeBase: base, carried: 0, uses: [], errors: [] }],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 4, head: 4, parsed: 4 },
    ...fields,
  };
}

const PASSED = { status: "passed" as const, fingerprint: null, breaks: [], reason: null, durationMs: 5 };

describe("promoting an expand checkpoint on its own", () => {
  let fx: FixProject;
  let base: string;
  let blocks: BlockStore;
  let queue: BlockQueueStore;
  const notified: string[] = [];
  const sealed: string[] = [];
  const asked: { person: string; blocked: string }[] = [];
  let slotHeldElsewhere = false;
  /** The people whose protected paths Ines's own change touches and who have not confirmed it. */
  let unconfirmed: { ownerId: string; files: { protectedPath: string }[] }[] = [];

  beforeEach(async () => {
    fx = await FixProject.create();
    base = join(fx.root, "base.git");
    git(fx.root, "clone", "--quiet", "--bare", fx.repo.dir, base);
    git(base, "update-ref", "refs/heads/main", fx.main);
    // Ines's fork builds from main on its own branch, so its commits stay reachable for the push.
    fx.repo.git("checkout", "--quiet", "-B", "expand", fx.main);
    blocks = new BlockStore(fx.project.sql, () => fx.now);
    queue = new BlockQueueStore(fx.project.sql, () => fx.now);
    notified.length = 0;
    sealed.length = 0;
    asked.length = 0;
    slotHeldElsewhere = false;
    unconfirmed = [];
  });

  afterEach(() => fx.remove());

  const dirOf = (name: string): string => (name === "base" ? base : name === "feature-tax-rounding" ? fx.forkDir : name === "feature-sam-reports" ? base : fx.repo.dir);
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
    unconfirmedProtected: () => unconfirmed,
    sign: (draft) => fx.project.sign(draft),
    notify: (person) => notified.push(person),
    now: () => fx.now,
  });
  const listener = {
    lockOpened: ({ personId, blockedFeatureId }: { personId: string; blockedFeatureId: string }) => asked.push({ person: personId, blocked: blockedFeatureId }),
    lockSettled: () => undefined,
  };
  const expandDeps = (): ExpandDeps => ({
    ...landDeps(),
    db: fx.project.sql,
    facts: fx.project.facts,
    scopeMap: async () => fx.scopeMap,
    dependents: (id) => fx.project.overlaps.dependents(id),
    overlaps: fx.project.overlaps,
    listener,
  });
  const overlapDeps = (): OverlapDeps => ({
    db: fx.project.sql,
    features: fx.project.features,
    overlaps: fx.project.overlaps,
    scopeMap: async () => fx.scopeMap,
    sign: (draft) => fx.project.sign(draft),
    listener,
  });
  const port = (): BlockProjectPort => ({
    signBlockRecord: (feature, type, payload) => signBlockRecord(fx.project.features, (draft) => fx.project.sign(draft), feature, type, payload),
    acquirePromotion: async (feature, run) => !slotHeldElsewhere && queue.acquire(feature, run),
    releasePromotion: async (run) => queue.release(run),
    featureLanded: async () => assert.fail("an expand never lands the feature"),
    landFailed: async (feature) => landFailed({ features: fx.project.features, notify: (person) => notified.push(person) }, feature),
    retryLand: async (feature, run, charter) => {
      const retried = await retryLand(landDeps(), feature, { runId: run, charter });
      return retried.status === "checking" ? { status: retried.status, runId: retried.run.runId } : retried;
    },
    expandPromoted: async (feature) => {
      notified.push(`expanded ${feature}`);
    },
    retryExpand: async (feature, run, charter) => {
      const retried = await retryExpand(expandDeps(), feature, { runId: run, charter });
      return retried.status === "checking" ? { status: retried.status, runId: retried.run.runId } : retried;
    },
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
    now: () => fx.now,
  });
  const expand = () => requestExpand(expandDeps(), "ines", SESSIONS.ines, { feature: "money-minor" });
  const mainHead = () => git(base, "rev-parse", "main");
  const refused = (outcome: { readonly status: string; readonly reason?: string; readonly message?: string }, reason: string) => {
    assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
    assert.equal(outcome.reason, reason, JSON.stringify(outcome));
    return outcome.message ?? "";
  };

  /** Commits `files` on Ines's fork branch and records the commit as her checkpoint built on `baseline`. */
  async function checkpoint(files: Record<string, string>, baseline = fx.main): Promise<string> {
    const sha = fx.repo.commit(files, "Expand");
    await fx.project.checkpoint("money-minor", sha, baseline, "@ines/money");
    return sha;
  }

  /** The runner reports the waiting facts run with `report`'s impact and every test passing. */
  function reportFacts(report: (request: { checkpoint: string; baseline: string }) => ImpactReport): void {
    const [request] = fx.project.facts.pending();
    assert.ok(request, "a facts run waits for the runner");
    const facts: PlanFactsReport = {
      impact: report(request),
      impactError: null,
      results: request.targets.flatMap((target) => target.commandIds.map((commandId) => ({ target: target.id, scopeId: commandId.slice(5), commandId, merged: target.sha, ...PASSED }))),
      durationMs: 10,
    };
    assert.equal(fx.project.facts.record(request.runId, "runner", JSON.parse(JSON.stringify(facts))).status, "recorded");
  }

  async function claimOne() {
    const claimed = await claimBlockRuns(queue, agent, RUNNER);
    assert.equal(claimed.status, "ok");
    const [run] = claimed.status === "ok" ? claimed.runs : [];
    assert.ok(run, "a block run waits for the runner");
    return run;
  }

  test("an additive checkpoint reaches main on its own and the fork keeps building on top", async () => {
    const expanded = await checkpoint({ [API]: PRICE + PRICE_MINOR });
    // The first request schedules the impact run of the checkpoint against main.
    refused(await expand(), "waiting_for_runner");
    const taxHead = git(fx.forkDir, "rev-parse", "main");
    reportFacts(({ baseline, checkpoint: head }) => {
      assert.deepEqual([baseline, head], [fx.main, expanded]);
      return impact(baseline, head, taxHead);
    });
    const asked = await expand();
    assert.equal(asked.status, "checking", JSON.stringify(asked));
    if (asked.status !== "checking") return;
    assert.deepEqual([asked.run.purpose, asked.run.planId, asked.run.checkpoint, asked.run.mainBefore], ["expand", null, expanded, fx.main]);
    assert.equal(fx.project.features.get("money-minor")?.state, "building", "the feature keeps building while its expand is checked");
    // A second expand or a land waits for the first.
    refused(await expand(), "busy");
    refused(await requestLand(landDeps(), "ines", SESSIONS.ines, { feature: "money-minor" }), "busy");

    const run = await claimOne();
    assert.deepEqual(run.targets.map((each) => each.feature), ["sam-reports", "tax-rounding"], "checked against every running fork");
    fx.now += 1_500;
    const result = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run))));
    assert.equal(result.status, "recorded", JSON.stringify(result));
    if (result.status !== "recorded") return;
    assert.equal(result.state, "promoted");
    assert.equal(mainHead(), expanded, "main moved to the expand checkpoint in one push");
    assert.equal(result.promotion?.purpose, "expand");
    assert.deepEqual([result.promotion?.mainBefore, result.promotion?.mainAfter, result.promotion?.checkMs], [fx.main, expanded, 1_500]);

    // The feature has not landed: its fork keeps its write tokens and its own promotion is still to come.
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    assert.deepEqual(sealed, []);
    assert.equal(blocks.promotion("money-minor"), undefined);
    assert.deepEqual(blocks.expansions("money-minor").map((each) => each.mainAfter), [expanded]);
    assert.deepEqual([fx.records("expand_requested").length, fx.records("expand_promotion").length, fx.records("promotion").length], [1, 1, 0]);
    assert.deepEqual(fx.records("expand_promotion")[0]?.payload["main_after"], expanded);
    assert.ok(notified.includes("expanded money-minor"));
    const grant = featureTokenGrant(
      { features: fx.project.features, heartbeat: fx.heartbeat, overlapStatus: () => ({ waitingOn: [], approved: [], ownOverlaps: [], dependents: [] }) } as never,
      "ines",
      SESSIONS.ines,
      "money-minor",
    );
    assert.equal(grant.status, "ok", JSON.stringify(grant));

    // The fork continues on top of what reached main and later lands the rest as its block.
    const rest = await checkpoint({ [API]: `${PRICE_MINOR.trimStart()}` }, expanded);
    const landed = await requestLand(landDeps(), "ines", SESSIONS.ines, { feature: "money-minor" });
    assert.equal(landed.status, "checking", JSON.stringify(landed));
    if (landed.status === "checking") assert.deepEqual([landed.run.purpose, landed.run.mainBefore, landed.run.checkpoint], ["land", expanded, rest]);
  });

  test("a checkpoint that changes an existing signature is refused with each entry that fails", async () => {
    const changed = await checkpoint({ [API]: "def price(item, currency):\n    return item.amount\n" });
    refused(await expand(), "waiting_for_runner");
    reportFacts(({ baseline }) =>
      impact(baseline, changed, fx.main, {
        changes: [{ symbol: "shared.money.api.price", path: API, line: 1, kind: "function", change: "modified", scope: "money", contract: "shared/money/api.py::price" }],
        signatures: [{ symbol: "shared.money.api.price", path: API, line: 1, before: "(item)", after: "(item, currency)", added: [{ name: "currency", required: true }], removed: [], breaking: true, reasons: ["a required parameter was added"] }],
        contracts: ["shared/money/api.py::price"],
        headUses: [{ path: "billing/old.py", line: 2, kind: "call", symbol: "shared.money.api.price", name: "price", scope: "billing" }],
      }),
    );
    const message = refused(await expand(), "not_only_adds");
    assert.match(message, /modified shared\.money\.api\.price \(shared\/money\/api\.py:1\)/u);
    assert.match(message, /signature of shared\.money\.api\.price changed from \(item\) to \(item, currency\)/u);
    assert.match(message, /scope billing is a place: 1 caller, 0 breaks/u);
    assert.equal(mainHead(), fx.main, "nothing moved main");
    assert.equal(blocks.latest("money-minor"), undefined, "no block run opened");
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
  });

  test("a checkpoint that adds to another owner's scope waits on that owner once, through the overlap lock", async () => {
    const expanded = await checkpoint({ [API]: PRICE + PRICE_MINOR, "tax/helpers.py": "def round_half(value):\n    return round(value)\n" });
    refused(await expand(), "waiting_for_runner");
    reportFacts(({ baseline }) =>
      impact(baseline, expanded, git(fx.forkDir, "rev-parse", "main"), {
        changes: [added("shared.money.api.price_minor", API, "money"), added("tax.helpers.round_half", "tax/helpers.py", "tax")],
      }),
    );
    refused(await expand(), "waiting_on_owner");
    refused(await expand(), "waiting_on_owner");
    assert.deepEqual(asked, [{ person: "rahul", blocked: "money-minor" }], "Rahul is asked once");
    const [lock] = fx.project.overlaps.ownerLocksOn("money-minor");
    assert.deepEqual([lock?.featureId, lock?.personId, lock?.state, lock?.overlap.scopes, lock?.overlap.paths], [ownerLockId("rahul"), "rahul", "open", ["tax"], ["tax/helpers.py"]]);
    // The lock holds the expand only: the feature's start and its write tokens never wait on it.
    assert.deepEqual(fx.project.overlaps.status("money-minor").waitingOn, []);
    assert.equal(fx.records("overlap_check").length, 1);

    // Only Rahul approves, once.
    assert.equal((await approveOverlap(overlapDeps(), "bea", ownerLockId("rahul"), "money-minor")).status, "rejected");
    assert.equal((await approveOverlap(overlapDeps(), "rahul", ownerLockId("rahul"), "money-minor")).status, "ok");
    assert.equal((await approveOverlap(overlapDeps(), "rahul", ownerLockId("rahul"), "money-minor")).status, "rejected");
    const after = await expand();
    assert.equal(after.status, "checking", JSON.stringify(after));
    assert.equal(asked.length, 1, "an approved owner is not asked again");
  });

  test("an expand waits, as a land does, for a protector to confirm the feature's own protected lines", async () => {
    const expanded = await checkpoint({ [API]: PRICE + PRICE_MINOR });
    unconfirmed = [{ ownerId: "bea", files: [{ protectedPath: "shared/money/" }] }];
    assert.match(refused(await expand(), "protected_path_unconfirmed"), /bea \(shared\/money\/\)/u);
    assert.deepEqual(fx.project.facts.pending(), [], "no impact run is scheduled while the confirmation waits");
    unconfirmed = [];
    refused(await expand(), "waiting_for_runner");
    reportFacts(({ baseline }) => impact(baseline, expanded, git(fx.forkDir, "rev-parse", "main")));
    assert.equal((await expand()).status, "checking");
  });

  test("an expand that raced another push is checked again as an expand", async () => {
    const expanded = await checkpoint({ [API]: PRICE + PRICE_MINOR });
    refused(await expand(), "waiting_for_runner");
    reportFacts(({ baseline }) => impact(baseline, expanded, git(fx.forkDir, "rev-parse", "main")));
    assert.equal((await expand()).status, "checking");
    const run = await claimOne();
    slotHeldElsewhere = true;
    const raced = await reportBlockRun(reportDeps(), RUNNER, run.runId, JSON.parse(JSON.stringify(reportOf(run))));
    assert.equal(raced.status === "recorded" && raced.state, "raced");
    assert.equal(raced.status === "recorded" && raced.retried?.status, "checking");
    assert.equal(blocks.latest("money-minor")?.purpose, "expand");
    assert.equal(fx.project.features.get("money-minor")?.state, "building");
    assert.equal(mainHead(), fx.main);
  });

  test("the Only adds check lists an incomplete report and every kind of change that is not an addition", () => {
    const report = impact("a".repeat(40), "b".repeat(40), "c".repeat(40), {
      complete: false,
      unanalysed: ["penguin/scopes.json"],
      changes: [added("shared.money.api.price_minor", API, "money"), { symbol: "shared.money.api.price", path: API, line: 1, kind: "function", change: "removed", scope: "money", contract: null }],
      removedExports: [{ module: "shared.money.api", path: API, name: "price" }],
      dataShapes: [{ symbol: "shared.money.api.Money", path: API, line: 9, kind: "dataclass", before: ["amount"], after: ["minor"], added: ["minor"], removed: ["amount"], changed: [], reordered: false }],
    });
    assert.deepEqual(onlyAddsFailures(report, []), [
      "the impact report is incomplete: penguin/scopes.json could not be analysed",
      "removed shared.money.api.price (shared/money/api.py:1)",
      "removed export shared.money.api.price",
      "stored data shape of shared.money.api.Money changed (shared/money/api.py:9)",
    ]);
    assert.deepEqual(onlyAddsFailures(impact("a".repeat(40), "b".repeat(40), "c".repeat(40)), []), []);
  });
});
