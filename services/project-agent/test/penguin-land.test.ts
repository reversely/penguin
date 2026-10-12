// Penguin lands the features it opened from main (#141, PRD 0.5 section 4.2 step 2 and section 4.5):
// a migration plan's block feature once every part on main is written, and a contract carrier once its
// removal is done and its checkpoint's facts are in. Penguin records the fork's head as the feature's
// checkpoint and asks for the land itself with the steward's charter; a failed block's next steps go to
// that steward; a head is landed once; a carrier's promotion closes the symbols it removed (#117).
// A fork main moved past is never merged: Penguin rebuilds it from main, re-applies each written part
// and tries it again; a part that no longer applies or fails its trial becomes an edit task (#143).

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  checkPlanFactsReport,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  MAIN_TARGET,
  type AgentToolResult,
  type CharterView,
  type ImpactChange,
  type ImpactReport,
  type ImpactUse,
  type LadderDecision,
  type Plan,
  type PlanFactsReport,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore } from "../src/agent-tools.ts";
import type { LandOutcome } from "../src/block-land.ts";
import type { BlockRun } from "../src/block-store.ts";
import { scheduleSort } from "../src/contract-split.ts";
import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore } from "../src/edit-tasks.ts";
import { blockReported, editRouting, type EditWorkDeps } from "../src/edit-work.ts";
import { recordPenguinCheckpoint, type FeatureCheckpointDeps } from "../src/feature-open.ts";
import type { Feature } from "../src/feature-store.ts";
import { FixGrantStore } from "../src/fix-write.ts";
import { gitReader } from "./git-reader.ts";
import { GitRepo } from "./issues-repo.ts";
import { IdentityStore } from "../src/identity-store.ts";
import {
  carryContract,
  migrationsCounted,
  migrationTasksSettled,
  migrationTrialReported,
  MigrationStore,
  stewardsFor,
  type MigrationDeps,
} from "../src/migration-plans.ts";
import { checkOverlap } from "../src/overlap-lock.ts";
import { PartTrialStore, type StoredPartTrial } from "../src/part-trial.ts";
import { landPenguinFeatures, PenguinLandStore, type PenguinLandDeps } from "../src/penguin-land.ts";
import { rebuildPenguinFeature } from "../src/penguin-rebuild.ts";
import { closeRemoved, countReported, requestRetiringCount, type RetiringCountDeps } from "../src/retiring-count.ts";
import { ReviewStore } from "../src/review-submit.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[], contracts: string[]) => ({ id, name: id, owner, paths, test_command: "true", contracts, depends_on: [] });
const scopeMap = parseScopeMap({
  scopes: [
    scope("money", "ines", ["shared/money/"], ["shared/money/api.py::price"]),
    scope("orders", "tomas", ["orders/"], ["orders/model.py::line_total"]),
    scope("billing", "bea", ["billing/"], ["billing/api.py::fee"]),
  ],
});

const BASE = "a".repeat(40);
const EXPAND = "b".repeat(40);
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const PRICE = { contract: "shared/money/api.py::price", replacement: "shared/money/api.py::Money" };
const LINE = { contract: "orders/model.py::line_total", replacement: "orders/model.py::line_total_minor" };
const BLOCK = "migrate-tomas-money-minor";
const CARRIER = "contract-ines-money-minor";

const sha = (n: number) => n.toString(16).padStart(40, "d");
const lineUse = (path: string): ImpactUse => ({ path, line: 3, kind: "call", symbol: "orders.model.line_total", name: "line_total", scope: "orders" });

function impact(head: string, fields: Partial<ImpactReport>): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: head,
    head,
    changes: [],
    signatures: [],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 2, head: 2, parsed: 2 },
    ...fields,
  };
}

function result(main: string, fields: Partial<AgentToolResult>): AgentToolResult {
  return { schemaVersion: 1, tool: "impact", base: main, checkpoint: main, result: "found", summary: "ran", impact: null, checks: [], decisions: [], fix: null, fixRef: null, pushed: false, durationMs: 4, ...fields };
}

describe("Penguin lands the features it opened once every part is written", () => {
  let project: PlanProject;
  let runs: AgentToolStore;
  let store: MigrationStore;
  let tasks: EditTaskStore;
  let roster: EditRoster;
  let identities: IdentityStore;
  let deps: MigrationDeps;
  let trials: PartTrialStore;
  let grants: FixGrantStore;
  let count: RetiringCountDeps;
  let lands: PenguinLandStore;
  /** Each fork's head as the land reads it, by repo name; main's head under "base". */
  let heads: Map<string, string>;
  /** Each land Penguin asked for: the feature and the charter it routes failures by. */
  let asked: { feature: string; charter: CharterView }[];
  /** What the next land answers; a block run opens unless a test says otherwise. */
  let answer: (featureId: string) => LandOutcome;

  beforeEach(async () => {
    project = new PlanProject(scopeMap, "");
    runs = new AgentToolStore(project.sql);
    store = new MigrationStore(project.sql);
    tasks = new EditTaskStore(project.sql);
    identities = new IdentityStore(project.sql);
    roster = new EditRoster(project.sql, identities);
    lands = new PenguinLandStore(project.sql);
    heads = new Map([["base", sha(1)]]);
    asked = [];
    answer = (featureId) => {
      // As block-land.ts openLand: the feature is landing while its run waits for the check runner.
      project.features.setState(featureId, ["building"], "landing");
      return { status: "checking", run: { runId: `${featureId}/1` } as BlockRun, recordId: "land" };
    };
    trials = new PartTrialStore(project.sql);
    grants = new FixGrantStore(project.sql);
    deps = {
      store,
      features: project.features,
      runs,
      retiring: project.retiring,
      trials,
      reviews: new ReviewStore(project.sql),
      scopeMap: async () => scopeMap,
      sign: (draft) => project.sign(draft),
      openTask: async (source, adjust) => {
        roster.sync(scopeMap, project.features.list());
        return tasks.open(source, adjust(editRouting({ roster, features: project.features }, scopeMap, () => true)));
      },
      tasks,
      grants,
      invariants: async () => [],
      checkOverlap: (feature) => checkOverlap({ db: project.sql, features: project.features, overlaps: project.overlaps, scopeMap: async () => scopeMap, sign: (draft) => project.sign(draft) }, feature),
      adminMode: false,
      fork: async (featureId) => `feature-${featureId}`,
    };
    count = {
      features: project.features,
      runs,
      retiring: project.retiring,
      facts: project.facts,
      sign: (draft) => project.sign(draft),
      carry: (featureId, symbols, at) => carryContract(deps, featureId, symbols, at),
    };
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
    await project.checkpoint("money-minor", EXPAND, BASE, "@ines/money");
    project.retiring.declare({ featureId: "money-minor", planId: "money-minor/v1", person: "ines", rules: [] } as unknown as Plan, [PRICE, LINE], "record-money");
  });

  /** What recording a checkpoint of a feature Penguin opened reads: its change and its contract diff's facts run. */
  const checkpointDeps = (): Omit<FeatureCheckpointDeps, "deliver" | "commitExists"> =>
    ({
      features: project.features,
      scopeMap: async () => scopeMap,
      heartbeat: (caller: string, session: string) => project.heartbeat(caller, session),
      sign: (draft: Parameters<PlanProject["sign"]>[0]) => project.sign(draft),
      readChange: async () => ({ baselineSha: sha(1), paths: ["orders/report.py"] }),
      sortContract: async (feature: Feature) =>
        scheduleSort({ features: project.features, facts: project.facts, dependents: () => [] }, feature, sha(1), scopeMap)?.runId,
    }) as unknown as Omit<FeatureCheckpointDeps, "deliver" | "commitExists">;

  const landDeps = (): PenguinLandDeps => ({
    migrations: store,
    lands,
    features: project.features,
    tasks,
    forkHead: async (repo) => heads.get(repo) ?? null,
    mainHead: async () => heads.get("base") ?? null,
    checkpoint: async (feature, at) => {
      const recorded = await recordPenguinCheckpoint(checkpointDeps(), feature, at);
      return recorded.status === "ok" ? recorded.feature : undefined;
    },
    factsWaiting: (feature) => feature.latestCheckpointSha !== null && project.facts.forCheckpoint(feature.id, feature.latestCheckpointSha)?.state === "pending",
    charter: (person) => {
      const steward = roster.stewardOf(person);
      return steward === undefined ? undefined : { handle: steward.handle, person, scopes: [...steward.scopes], paths: [...steward.paths] };
    },
    land: async (featureId, charter) => {
      asked.push({ feature: featureId, charter });
      return answer(featureId);
    },
    sign: (draft) => project.sign(draft),
  });

  const records = (feature: string, type: string) =>
    project.features
      .records(feature)
      .map((stored) => JSON.parse(stored.file) as { type: string; author: unknown; payload: Record<string, unknown> })
      .filter((each) => each.type === type);

  /** Main moved to sha(1) with Tomas's orders report still calling line_total: Tomas's block holds one part. */
  async function blockWithOnePart(): Promise<string> {
    const runId = requestRetiringCount(count, "money-minor", sha(1));
    assert.ok(runId !== undefined);
    const recorded = recordToolResult(runs, RUNNER, runId, result(sha(1), { impact: impact(sha(1), { headUses: [lineUse("orders/report.py")] }) }));
    assert.ok(recorded.status === "recorded");
    await countReported(count, recorded.run);
    await migrationsCounted(deps, recorded.run);
    const [part] = store.plans("money-minor")[0]?.parts ?? [];
    assert.ok(part);
    return part.partId;
  }

  test("written parts trigger the land: Penguin records the fork's head and lands it with the steward's charter, once", async () => {
    const partId = await blockWithOnePart();
    // The part is an edit task for Tomas's steward: nothing is written, so nothing lands.
    heads.set(`feature-${BLOCK}`, sha(1));
    assert.deepEqual(await landPenguinFeatures(landDeps()), []);
    // The steward's kept commit writes the part.
    const [task] = tasks.forSource(`migrate:${partId}`);
    assert.ok(task);
    tasks.close(task.sourceKey, "done", "the steward moved orders/report.py", sha(2));
    await migrationTasksSettled(deps);
    assert.equal(store.part(partId)?.state, "written");
    heads.set(`feature-${BLOCK}`, sha(2));
    assert.deepEqual(await landPenguinFeatures(landDeps()), [{ feature: BLOCK, checkpoint: sha(2), status: "checking", runId: `${BLOCK}/1`, reason: null }]);
    // Penguin recorded the head as the block's checkpoint, under its own record.
    assert.equal(project.features.get(BLOCK)?.latestCheckpointSha, sha(2));
    assert.deepEqual(records(BLOCK, "checkpoint_area").map((each) => [each.author, each.payload["checkpoint"]]), [[{ penguin: true }, sha(2)]]);
    // The land carries the charter of Tomas's steward, so the ladder routes a failure there.
    assert.deepEqual(asked.map((each) => [each.feature, each.charter.handle, each.charter.person]), [[BLOCK, "@tomas/steward", "tomas"]]);
    // One block run per carrier and head: a second sweep, and one after a failed block, ask nothing.
    assert.deepEqual(await landPenguinFeatures(landDeps()), []);
    project.features.setState(BLOCK, ["landing"], "building");
    assert.deepEqual(await landPenguinFeatures(landDeps()), []);
    assert.equal(asked.length, 1);
  });

  test("a land refused before its run is kept with its reason once per head, and asked again at the next sweep", async () => {
    const partId = await blockWithOnePart();
    tasks.close(`migrate:${partId}`, "done", "moved", sha(2));
    await migrationTasksSettled(deps);
    heads.set(`feature-${BLOCK}`, sha(2));
    answer = () => ({ status: "rejected", reason: "behind_main", message: "main moved" });
    const [first] = await landPenguinFeatures(landDeps());
    assert.deepEqual([first?.status, first?.reason], ["rejected", "behind_main"]);
    await landPenguinFeatures(landDeps());
    assert.equal(asked.length, 2);
    assert.deepEqual(records(BLOCK, "land_returned").map((each) => [each.author, each.payload["reason"], each.payload["checkpoint"]]), [[{ penguin: true }, "behind_main", sha(2)]]);
  });

  test("a failed block opens next-step edit tasks for the steward of the block's person, and a kept fix lands the new head", async () => {
    const partId = await blockWithOnePart();
    tasks.close(`migrate:${partId}`, "done", "moved", sha(2));
    await migrationTasksSettled(deps);
    heads.set(`feature-${BLOCK}`, sha(2));
    await landPenguinFeatures(landDeps());
    // The block's tests fail on main's merged tree; the ladder gives the step to an agent.
    const decision: LadderDecision = {
      target: MAIN_TARGET,
      check: "tests",
      failure: "behaviour",
      step: 4,
      nextStep: "the originating agent adapts",
      actor: { kind: "originating-agent", id: "@tomas/steward" },
      fix: null,
      reason: "a behaviour change inside the agent's charter",
      evidence: { summary: "1 failing test", findings: [{ path: "orders/report.py", line: 3, code: null, message: "fails: report total" }] },
    };
    project.features.setState(BLOCK, ["landing"], "building");
    const work = { tasks, roster, features: project.features, scopeMap: async () => scopeMap, running: () => [], notify: () => undefined } as unknown as EditWorkDeps;
    await blockReported(work, BLOCK, { runId: `${BLOCK}/1`, checkpoint: sha(2), passed: false }, [decision], stewardsFor(store));
    const [step] = tasks.forFeature(BLOCK).filter((each) => each.kind === "next_step");
    assert.deepEqual([step?.handle, step?.via, step?.target, step?.files], ["@tomas/steward", "steward", BLOCK, ["orders/report.py"]]);
    // The steward's kept fix moves the head; Penguin lands it.
    assert.ok(step);
    tasks.close(step.sourceKey, "done", "fixed", sha(3));
    heads.set(`feature-${BLOCK}`, sha(3));
    assert.deepEqual((await landPenguinFeatures(landDeps())).map((each) => [each.checkpoint, each.status]), [[sha(3), "checking"]]);
  });

  test("a contract carrier lands once its removal is done and its facts are in, and its promotion closes the symbols", async () => {
    project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    const runId = requestRetiringCount(count, "money-minor", sha(4));
    assert.ok(runId !== undefined);
    const recorded = recordToolResult(runs, RUNNER, runId, result(sha(4), { impact: impact(sha(4), {}) }));
    assert.ok(recorded.status === "recorded");
    await countReported(count, recorded.run);
    assert.equal(project.features.get(CARRIER)?.personId, "ines");
    heads.set("base", sha(4));
    heads.set(`feature-${CARRIER}`, sha(4));
    // The removal is not done: nothing lands.
    assert.deepEqual(await landPenguinFeatures(landDeps()), []);
    const REMOVED = sha(5);
    tasks.close(`contract:${CARRIER}`, "done", "removed price", REMOVED);
    heads.set(`feature-${CARRIER}`, REMOVED);
    // The checkpoint is recorded and its facts run asked for; the land waits for that run.
    assert.deepEqual(await landPenguinFeatures(landDeps()), []);
    assert.equal(project.features.get(CARRIER)?.latestCheckpointSha, REMOVED);
    const facts = project.facts.forCheckpoint(CARRIER, REMOVED);
    assert.equal(facts?.state, "pending");
    const removal: ImpactChange = { symbol: "shared.money.api.price", path: "shared/money/api.py", line: 4, kind: "function", change: "removed", scope: "money", contract: PRICE.contract };
    const report: PlanFactsReport = { impact: impact(REMOVED, { base: sha(4), changes: [removal] }), impactError: null, results: [], durationMs: 5 };
    assert.deepEqual(checkPlanFactsReport(report), []);
    assert.equal(project.facts.record(facts?.runId as string, "runner-1", JSON.parse(JSON.stringify(report))).status, "recorded");
    assert.deepEqual((await landPenguinFeatures(landDeps())).map((each) => [each.feature, each.checkpoint, each.status]), [[CARRIER, REMOVED, "checking"]]);
    assert.deepEqual(asked.map((each) => each.charter.handle), ["@ines/steward"]);
    // The block passed and main moved to the carrier's checkpoint: the symbol closes as removed.
    assert.deepEqual(await closeRemoved(count, CARRIER, REMOVED), [PRICE.contract]);
    assert.deepEqual(project.retiring.list().map((each) => each.contract), [LINE.contract]);
  });

  /**
   * The land deps with Penguin's rebuild: every fork head counts as behind main, kept commits are read
   * from `repo`, and a fork opened again starts at main's head. `reforked` lists each fork made again.
   */
  const rebuildingDeps = (repo: GitRepo, reforked: string[]): PenguinLandDeps => ({
    ...landDeps(),
    rebuild: {
      holdsMain: async () => false,
      run: (feature, kind, head, main) =>
        rebuildPenguinFeature(
          {
            ...deps,
            readFork: async (_repo, read) => read({ ...gitReader(repo.dir), log: async () => [] }),
            refork: async (featureId) => {
              reforked.push(featureId);
              heads.set(`feature-${featureId}`, heads.get("base") as string);
              return `feature-${featureId}`;
            },
          },
          feature,
          kind,
          head,
          main,
        ),
    },
  });

  /** Tomas's block with its one part written by the steward's kept commit `after`, on a fork main then moved past. */
  async function writtenBehindMain(repo: GitRepo, after: string): Promise<{ partId: string; kept: string }> {
    const partId = await blockWithOnePart();
    repo.commit({ "orders/report.py": "total = line_total(order)\n" });
    const kept = repo.commit({ "orders/report.py": after }, "orders: move the report to line_total_minor");
    tasks.close(`migrate:${partId}`, "done", "the steward moved orders/report.py", kept);
    await migrationTasksSettled(deps);
    assert.equal(store.part(partId)?.state, "written");
    heads.set(`feature-${BLOCK}`, kept);
    // Five promotions later, main is at sha(7), which the block's fork does not hold.
    heads.set("base", sha(7));
    return { partId, kept };
  }

  /** The runner's report of a rebuilt part's trial: orders' tests with `status`. */
  const trialReport = (trial: StoredPartTrial, status: "passed" | "failed") => ({
    schemaVersion: 1 as const,
    trialId: trial.id,
    partId: trial.partId,
    revision: 1,
    checkpoint: trial.request.checkpoint,
    target: trial.request.target.sha,
    status: "built" as const,
    tree: sha(8),
    reason: null,
    tests: [{ scopeId: "orders", commandId: "test:orders", status, breaks: status === "failed" ? ["orders/tests/test_report.py::test_total"] : [], reason: null, durationMs: 3 }],
    reviews: [],
    sideBySide: [],
    durationMs: 9,
  });

  test("a ready block behind main is rebuilt from main, never merged: its kept commit is re-applied and tried again, and a passing trial asks for its write", async () => {
    const repo = new GitRepo();
    const reforked: string[] = [];
    const { partId, kept } = await writtenBehindMain(repo, "total = line_total_minor(order)\n");
    const attempts = await landPenguinFeatures(rebuildingDeps(repo, reforked));
    assert.deepEqual(attempts, [{ feature: BLOCK, checkpoint: kept, status: "rebuilt", runId: null, reason: "behind_main" }]);
    // No land was asked and no merge made: the fork was opened again from main.
    assert.deepEqual([asked.length, reforked], [0, [BLOCK]]);
    // The kept commit is re-applied as its patch against main's head and tried there.
    const part = store.part(partId);
    assert.deepEqual([part?.state, part?.targetSha], ["trial", sha(7)]);
    const trial = trials.ofPart(BLOCK, partId) as StoredPartTrial;
    assert.deepEqual([trial.request.target, trial.request.fix], [
      { id: "main", repo: "base", sha: sha(7) },
      { kind: "patch", patch: "--- a/orders/report.py\n+++ b/orders/report.py\n@@ -1,1 +1,1 @@\n-total = line_total(order)\n+total = line_total_minor(order)\n" },
    ]);
    assert.deepEqual(records(BLOCK, "block_rebuilt").map((each) => [each.author, each.payload["from_head"], each.payload["main"], each.payload["parts"]]), [
      [{ penguin: true }, kept, sha(7), [{ part: partId, from: "commit", state: "trial" }]],
    ]);
    // The new fork is at main's head: a second sweep neither rebuilds nor lands.
    assert.deepEqual(await landPenguinFeatures(rebuildingDeps(repo, reforked)), []);
    assert.deepEqual(reforked, [BLOCK]);
    // The trial passes: Penguin approves the part and the check runner's write into the new fork waits.
    assert.equal(await migrationTrialReported(deps, trials.record(trial.id, trialReport(trial, "passed")) as StoredPartTrial), "approved");
    assert.deepEqual(grants.allOpen().map((grant) => [grant.targetFeatureId, grant.partId, grant.writer]), [[BLOCK, partId, "runner"]]);
  });

  test("a rebuilt part that fails its trial becomes an edit task for the steward with the failing check", async () => {
    const repo = new GitRepo();
    const { partId } = await writtenBehindMain(repo, "total = line_total_minor(order)\n");
    await landPenguinFeatures(rebuildingDeps(repo, []));
    const trial = trials.ofPart(BLOCK, partId) as StoredPartTrial;
    assert.equal(await migrationTrialReported(deps, trials.record(trial.id, trialReport(trial, "failed")) as StoredPartTrial), "task");
    assert.match(store.part(partId)?.reason ?? "", /^the kept commit, re-applied on the rebuilt block, failed its trial: test:orders failed/u);
    const [task] = tasks.forSource(`migrate:${partId}`);
    assert.deepEqual([task?.state, task?.handle, task?.target], ["queued", "@tomas/steward", BLOCK]);
    assert.ok(task?.evidence.includes("test:orders fails orders/tests/test_report.py::test_total"));
  });

  test("a kept commit that is no plain text patch makes the rebuilt part an edit task at once", async () => {
    const repo = new GitRepo();
    const { partId } = await writtenBehindMain(repo, "total = line_total_minor(order)");
    const [attempt] = await landPenguinFeatures(rebuildingDeps(repo, []));
    assert.equal(attempt?.status, "rebuilt");
    assert.equal(trials.ofPart(BLOCK, partId), undefined);
    assert.deepEqual([store.part(partId)?.state, tasks.forSource(`migrate:${partId}`)[0]?.state], ["task", "queued"]);
    assert.match(store.part(partId)?.reason ?? "", /the kept commit cannot be re-applied: orders\/report\.py: the change is not a plain text patch/u);
  });

  test("a ready contract carrier behind main is rebuilt and its removal is asked again on the new fork", async () => {
    project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    const runId = requestRetiringCount(count, "money-minor", sha(4));
    assert.ok(runId !== undefined);
    const recorded = recordToolResult(runs, RUNNER, runId, result(sha(4), { impact: impact(sha(4), {}) }));
    assert.ok(recorded.status === "recorded");
    await countReported(count, recorded.run);
    tasks.close(`contract:${CARRIER}`, "done", "removed price", sha(5));
    heads.set(`feature-${CARRIER}`, sha(5));
    heads.set("base", sha(7));
    const reforked: string[] = [];
    const [attempt] = await landPenguinFeatures(rebuildingDeps(new GitRepo(), reforked));
    assert.deepEqual([attempt?.status, reforked, asked.length], ["rebuilt", [CARRIER], 0]);
    const [task] = tasks.forSource(`contract:${CARRIER}`);
    assert.deepEqual([task?.state, task?.handle], ["queued", "@ines/steward"]);
    assert.ok(task?.evidence.includes(`the earlier removal was commit ${sha(5).slice(0, 12)} on fork head ${sha(5).slice(0, 12)}`));
    assert.deepEqual(records(CARRIER, "block_rebuilt").map((each) => each.payload["parts"]), [[{ part: `contract:${CARRIER}`, from: "removal", state: "task" }]]);
  });
});
