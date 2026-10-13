// A Penguin project seeded from one fixture under `examples/`, for the dashboard preview, its
// screenshots and the dashboard's fixture tests. The stores are the ProjectAgent's own, wired as the
// ProjectAgent wires them, over an in-memory SQLite database. Every step goes through the module the
// ProjectAgent calls for it: opening a feature with its overlap check, each checkpoint, the agent tools,
// a merge plan with the check runner's facts run, each review form with the runner's side-by-side run,
// and each person's decision. The check runner's programs run for real on the fixture's built
// repository: the impact analysis, the block checks, pytest and the review harness.
//
// Every person, scope, identity, feature, area, commit, fix, review form, test and invariant comes
// from the fixture's files and the runs.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { generateSigningKeyPair } from "@penguin/issues";
import {
  BlockChecker,
  blockPass,
  checkTools,
  CombinedRunner,
  fetchRepoBranches,
  FixApplier,
  localRemote,
  PartTrialRunner,
  PlanFactsRunner,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  runReview,
  runSideBySide,
  TestRunner,
  toolPass,
  writeFix,
  type GitRemote,
} from "@penguin/local-bridge";
import {
  BACKGROUND_RUN_CAP_DEFAULT,
  boundReviewRecord,
  EDIT_RUN_MINUTES_DEFAULT,
  FIX_WRITE_BRANCH,
  isMigrationPlanId,
  routesToOriginator,
  type ContractWorkView,
  type LadderDecision,
  needsPerson,
  PLAN_STORE_MARKERS,
  type FixWriteSpec,
  type PartRouting,
  policyInForce,
  policyRoute,
  type PolicyInForce,
  type Plan,
  type PlanPart,
  type PlanStoreMarker,
  type RetiringSymbol,
  type ReviewForm,
  type RewriteRule,
  type StewardView,
} from "@penguin/protocol";
import { parseInvariantsBytes, parseScopeMap, parseTeams, type ScopeMap } from "@penguin/scope-map";

import type { DashboardBackend } from "../../apps/worker/src/dashboard.ts";
import { featureView } from "../../apps/worker/src/features.ts";
import { claimToolRuns, recordToolResult } from "../../services/project-agent/src/agent-tool-runner.ts";
import { AgentToolStore, requestRetiringCheck, requestTool, whatsNear, type AgentToolDeps } from "../../services/project-agent/src/agent-tools.ts";
import { buildBoard } from "../../services/project-agent/src/board.ts";
import { checkpointBaseline, checkpointChange, type RepoHistoryReader } from "../../services/project-agent/src/combined-run-schedule.ts";
import { contractWork, ContractSplitStore, recordSplit, retireSplit, scheduleSort, type ContractSplitDeps } from "../../services/project-agent/src/contract-split.ts";
import { buildFeaturePage, buildFeaturePlan, buildPersonScopes, buildTeamView, type DashboardViewDeps } from "../../services/project-agent/src/dashboard-views.ts";
import { openFeature, recordFeatureRepo, recordPenguinCheckpoint, reportFeatureCheckpoint, type FeatureDeps } from "../../services/project-agent/src/feature-open.ts";
import { FeatureStore, signFeatureRecord, verifyFeatureRecord } from "../../services/project-agent/src/feature-store.ts";
import {
  agentFixGrant,
  agentFixReport,
  claimRunnerWrites,
  copiesBehind,
  copyWriteOf,
  FixGrantStore,
  openCopyWrites,
  openFixWrite,
  runnerFixReport,
  writtenPart,
  type FixGrant,
  type FixWriteDeps,
} from "../../services/project-agent/src/fix-write.ts";
import { buildIdentitiesPage } from "../../services/project-agent/src/identities-page.ts";
import { IdentityStore } from "../../services/project-agent/src/identity-store.ts";
import { buildInbox } from "../../services/project-agent/src/inbox-page.ts";
import { InboxStore, parseOverlapRef } from "../../services/project-agent/src/inbox-store.ts";
import { IssueIndex, type BridgeCaller, type SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { approveOverlap, checkOverlap, OverlapStore, type OverlapDeps } from "../../services/project-agent/src/overlap-lock.ts";
import { OwnerForkStore } from "../../services/project-agent/src/owner-forks.ts";
import { reviewResult } from "../../services/project-agent/src/part-checks.ts";
import { claimPartTrials, PartTrialStore, queueTrials, queueTrialsForReview, recordPartTrial, trialHolds, trialStanding } from "../../services/project-agent/src/part-trial.ts";
import {
  announcePlan,
  approveCleanParts,
  approvePlanPart,
  buildPlanInbox,
  PlanRouteStore,
  requestPlanChange,
  reversePenguinApproval,
  revisePlanPart,
  routePart,
  type PlanApprovalDeps,
} from "../../services/project-agent/src/plan-approval.ts";
import { PlanFactsStore } from "../../services/project-agent/src/plan-facts.ts";
import { PlanStore } from "../../services/project-agent/src/plan-store.ts";
import { checkpointRecord, proposePlan, type ProposePlanOutcome } from "../../services/project-agent/src/propose-plan.ts";
import {
  checkProtectedChanges,
  confirmProtectedChange,
  ownChange,
  protectedChangeRequests,
  ProtectedChangeStore,
  unconfirmedProtected,
  type ConfirmDeps,
} from "../../services/project-agent/src/protected-change.ts";
import { fileDiffs } from "../../services/project-agent/src/repo-diff.ts";
import { edgesReported, requestScopeEdges, ScopeEdgeStore } from "../../services/project-agent/src/scope-edges.ts";
import { closeRemoved, countReported, requestRetiringCount, type CountOutcome, type RetiringCountDeps } from "../../services/project-agent/src/retiring-count.ts";
import { EditRoster } from "../../services/project-agent/src/edit-roster.ts";
import { EditTaskStore } from "../../services/project-agent/src/edit-tasks.ts";
import { blockReported, editRouting, editTaskView, syncEditWork, type EditWorkDeps } from "../../services/project-agent/src/edit-work.ts";
import {
  BlockQueueStore,
  featureLanded,
  landFailed,
  reportBlockRun,
  requestLand,
  requestPenguinLand,
  type BlockReportResult,
  type FeatureBlocks,
  type LandDeps,
} from "../../services/project-agent/src/block-land.ts";
import { BlockStore } from "../../services/project-agent/src/block-store.ts";
import { landPenguinFeatures, PenguinLandStore, type PenguinLandAttempt } from "../../services/project-agent/src/penguin-land.ts";
import { rebuildPenguinFeature } from "../../services/project-agent/src/penguin-rebuild.ts";
import {
  carryContract,
  migrationBlockLanded,
  migrationsChecked,
  migrationsCounted,
  migrationTasksSettled,
  migrationTrialReported,
  MigrationStore,
  rewritesReported,
  stewardsFor,
  type MigrationDeps,
} from "../../services/project-agent/src/migration-plans.ts";
import { RetiringStore } from "../../services/project-agent/src/retiring-store.ts";
import { claimReviews, recordReview } from "../../services/project-agent/src/review-record.ts";
import { ReviewStore, submitReview } from "../../services/project-agent/src/review-submit.ts";
import {
  changeReviewPolicy,
  PROJECT_RECORDS,
  readReviewPolicy,
  reviewPolicyView,
  type PolicyChangeOutcome,
  type StoredPolicy,
} from "../../services/project-agent/src/review-policy.ts";
import { reviewDifferences } from "../../services/project-agent/src/review-view.ts";
import { SessionStore } from "../../services/project-agent/src/session-store.ts";
import { flushRecords, RecordRepoStore } from "../../services/project-agent/src/record-repo.ts";
import { gitReader } from "./git-reader.ts";
import { gitServer } from "./git-server.ts";

const ROOT = join(import.meta.dirname, "../..");
const VENV_BIN = join(ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const ENV = { ...process.env, PATH: [VENV_BIN, process.env["PATH"]].join(delimiter), UV_OFFLINE: "1" };
const RUNNER: BridgeCaller = { bridgeId: "preview-runner", role: "runner" };

export const FIXTURES = ["identity-unification", "helpful-fix", "money-minor-units"] as const;
export type FixtureName = (typeof FIXTURES)[number];
/** Every fixture under `examples/` a test may build; the preview seeds only FIXTURES. */
export type ExampleName = FixtureName | "helpful-fix" | "dependency-bump";

/** One identity as the fixture's `penguin/identities.json` seeds it: a person's steward or a feature's builder. */
export interface SeedIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
  /** A builder's paths in its feature's area that another person's scopes hold. */
  readonly charter_paths?: readonly string[];
}

/** A feature's builder handle, `@<person>/<feature>`, as the fixtures' identities name it. */
export const builderOf = (feature: { readonly owner: string; readonly id: string }): string => `@${feature.owner}/${feature.id}`;

/** One proposal of a use case's merge plan, read once its reviews and its people's decisions were in. */
export interface PlanRound {
  readonly plan: Plan;
  /** The parts that wait on the originating person for the stored data their change reshapes (#132). */
  readonly toOriginator: readonly string[];
  /** The parts whose review raised a broken invariant or a protected difference to their author. */
  readonly raised: readonly string[];
  /** Each part's routing when its people decided, which the review policy reads (review-policy.ts). */
  readonly routings: ReadonlyMap<string, PartRouting>;
}

/** One step a scenario logs, with how long it took, so a run reads as the fixture's story. */
export interface SeedStep {
  readonly step: string;
  readonly ms: number;
}

/** A person's decision the seed waits for in step mode: the dashboard routes it may arrive on and the body fields that name it. */
export interface AwaitedDecision {
  readonly person: string;
  readonly routes: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Step mode for a preview a person watches: the seed waits before each step until `advance` is
 * called, and a step whose action is a person's decision waits for that decision to arrive through
 * the dashboard's API instead of making it in code.
 */
export class StepGate {
  /** The name of the step waiting to run, or running, if any. */
  next: string | undefined;
  /** The decision the running step waits for, if any. */
  waitingFor: AwaitedDecision | undefined;
  finished = false;
  failed: string | undefined;
  /** Called after each step runs. */
  onStep: (step: SeedStep) => void = () => undefined;
  readonly #project = Promise.withResolvers<PreviewProject>();
  /** The project, once it exists and before its first step. */
  readonly project = this.#project.promise;
  #go: (() => void) | undefined;
  #decided: (() => void) | undefined;
  #settled: (() => void) | undefined;

  attach(preview: PreviewProject): void {
    preview.gate = this;
    this.#project.resolve(preview);
  }

  /** Waits until `advance` lets step `name` run. */
  async before(name: string): Promise<void> {
    this.next = name;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#go = resolve;
    await promise;
  }

  after(step: SeedStep): void {
    this.next = undefined;
    this.onStep(step);
    this.#settle();
  }

  /**
   * Lets the waiting step run. Answers once it has run, waits for a person, or the seed stops; answers
   * undefined when no step is waiting.
   */
  advance(): Promise<void> | undefined {
    const go = this.#go;
    if (go === undefined) return undefined;
    this.#go = undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#settled = resolve;
    go();
    return promise;
  }

  /** Waits until `decision` arrives through the dashboard's API. */
  async decision(decision: AwaitedDecision): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#decided = resolve;
    this.waitingFor = decision;
    this.#settle();
    await promise;
    this.waitingFor = undefined;
  }

  /** The dashboard reports each request it answered with success: `person` posted `body` to `route`. */
  arrived(route: string, person: string, body: Readonly<Record<string, unknown>>): void {
    const awaited = this.waitingFor;
    if (awaited === undefined || awaited.person !== person || !awaited.routes.includes(route)) return;
    if (Object.entries(awaited.fields).every(([name, value]) => body[name] === value)) this.#decided?.();
  }

  finish(error?: unknown): void {
    this.finished = true;
    this.next = undefined;
    if (error !== undefined) this.failed = error instanceof Error ? error.message : String(error);
    this.#settle();
  }

  #settle(): void {
    this.#settled?.();
    this.#settled = undefined;
  }
}

/**
 * The project's stores and the fixture's built repository. The repository stands in for main and every
 * feature's fork in Artifacts, as the Worker's own tests do.
 */
export class PreviewProject {
  readonly sql: SqlDatabase = memoryDatabase();
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features: FeatureStore;
  readonly overlaps: OverlapStore;
  readonly inbox: InboxStore;
  readonly facts: PlanFactsStore;
  readonly plans: PlanStore;
  readonly routes: PlanRouteStore;
  readonly protectedChanges: ProtectedChangeStore;
  readonly reviews: ReviewStore;
  readonly trials: PartTrialStore;
  readonly tools: AgentToolStore;
  readonly index: IssueIndex;
  readonly forks: OwnerForkStore;
  readonly retiring: RetiringStore;
  /** Main's scope dependencies from the last derivation, as the ProjectAgent keeps them. */
  readonly scopeEdges: ScopeEdgeStore;
  readonly splits: ContractSplitStore;
  readonly migrations: MigrationStore;
  readonly editTasks: EditTaskStore;
  readonly roster: EditRoster;
  readonly fixGrants: FixGrantStore;
  /** The FeatureAgents' block runs, kept in the preview's one database, and the ProjectAgent's queue of them. */
  readonly blocks: BlockStore;
  readonly blockQueue: BlockQueueStore;
  readonly penguinLands: PenguinLandStore;
  /** What the record repo holds; the repo is a bare repository on disk (`#recordRepo`). */
  readonly recordRepo: RecordRepoStore;
  /**
   * True to propose the split's migration plans after each count, as the ProjectAgent does: each plan's
   * rewrites and trials then run on the check runner. Off by default, since a scenario that does not
   * look at migration would spend minutes on them.
   */
  migrationPlans = false;
  /** True to sort each checkpoint's contract diff, as the ProjectAgent does; each sort is a facts run. */
  sortContracts = false;
  readonly steps: SeedStep[] = [];
  /** Step mode: each step waits for the gate, and each person's decision for the dashboard. */
  gate: StepGate | undefined;
  /** Each person whose inbox changed, in order, as the live feed would tell them. */
  readonly notified: string[] = [];
  readonly sessionOf = new Map<string, string>();
  #key = generateSigningKeyPair();
  #clock = Date.parse("2026-10-11T09:00:00Z");
  #runnerRepo: Promise<string> | undefined;
  #recordRepoDir: Promise<string> | undefined;

  readonly scopeMap: ScopeMap;
  readonly repo: string;
  readonly fixture: ExampleName;
  readonly roundLimit = 3;
  /** Whether the originating agent calls impact and check, which the check runner runs: off for a quick seed. */
  runnerTools = true;
  /** PENGUIN_PLAN_BREAK_LIMIT: the PRD default until a scenario changes the project's setting. */
  breakLimit = 10;
  /** PENGUIN_PLAN_ADMIN_MODE: off, so Penguin approves each part whose checks are clean. */
  adminMode = false;
  /** The originating agent's last `propose_plan` answer for use cases 1 to 3. */
  planOutcome: ProposePlanOutcome | undefined;
  /** Use case 4: Penguin's answer to the plan Ines's agent proposes at the expand. */
  splitOutcome: ProposePlanOutcome | undefined;
  /** Each plan of use cases 1 to 3 on Larder as it stood once its reviews and decisions were in. */
  readonly rounds: PlanRound[] = [];

  constructor(fixture: ExampleName, repo: string, scopeMap: ScopeMap) {
    this.fixture = fixture;
    this.repo = repo;
    this.scopeMap = scopeMap;
    const now = () => this.#clock;
    let next = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++next}`);
    this.features = new FeatureStore(this.sql, now);
    this.overlaps = new OverlapStore(this.sql, now);
    this.inbox = new InboxStore(this.sql, this.identities, { now });
    this.facts = new PlanFactsStore(this.sql);
    this.plans = new PlanStore(this.sql);
    this.routes = new PlanRouteStore(this.sql, now);
    this.protectedChanges = new ProtectedChangeStore(this.sql, now);
    this.reviews = new ReviewStore(this.sql);
    this.trials = new PartTrialStore(this.sql, now);
    this.tools = new AgentToolStore(this.sql);
    this.forks = new OwnerForkStore(this.sql, now);
    this.retiring = new RetiringStore(this.sql, now);
    this.scopeEdges = new ScopeEdgeStore(this.sql, now);
    this.splits = new ContractSplitStore(this.sql, now);
    this.migrations = new MigrationStore(this.sql, now);
    this.editTasks = new EditTaskStore(this.sql, { now });
    this.roster = new EditRoster(this.sql, this.identities);
    this.fixGrants = new FixGrantStore(this.sql, now);
    this.blocks = new BlockStore(this.sql, now);
    this.blockQueue = new BlockQueueStore(this.sql, now);
    this.penguinLands = new PenguinLandStore(this.sql, now);
    this.recordRepo = new RecordRepoStore(this.sql);
    let sessions: SessionStore | undefined;
    this.index = new IssueIndex(this.sql, { assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed) });
    sessions = new SessionStore(this.sql, this.identities, {
      now,
      // The preview's clock moves only with its steps, so a session stays online while the preview runs.
      offlineAfterMs: Number.MAX_SAFE_INTEGER,
      assigningOwner: (issueId, handle) => this.index.assigningOwner(issueId, handle),
      toolResultsFor: (sessionId) => this.tools.deliver(sessionId),
    });
    this.sessions = sessions;
  }

  /** Moves main to `sha`, as a promotion of a feature's block does in one push. */
  moveMain(sha: string): void {
    this.git("update-ref", "refs/heads/main", sha);
  }

  /** Moves the project's clock one minute, so records and items keep their order. */
  tick(): void {
    this.#clock += 60_000;
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  }

  /** `git diff` of `from` to `to` inside `paths`, untrimmed, as an agent sends a patch. */
  diff(from: string, to: string, paths: readonly string[]): string {
    return execFileSync("git", ["-C", this.repo, "diff", from, to, "--", ...paths], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  async step<T>(step: string, run: () => Promise<T>): Promise<T> {
    await this.gate?.before(step);
    const started = performance.now();
    const value = await run();
    const done = { step, ms: Math.round(performance.now() - started) };
    this.steps.push(done);
    this.gate?.after(done);
    return value;
  }

  async #sign(draft: Parameters<typeof signFeatureRecord>[0]) {
    return signFeatureRecord(draft, (await this.#key).privateKey);
  }

  #notify = (person: string) => {
    this.notified.push(person);
  };

  /** The review policy as the ProjectAgent reads it: the newest verified record, or Dev. */
  async storedPolicy(): Promise<StoredPolicy> {
    const { publicKey } = await this.#key;
    return readReviewPolicy(this.features.records(PROJECT_RECORDS), (record) => verifyFeatureRecord(record, publicKey));
  }

  /** The policy every decision of the preview reads, as the ProjectAgent wires it. */
  async policyInForce(): Promise<PolicyInForce> {
    return policyInForce((await this.storedPolicy()).policy, this.adminMode);
  }

  /** A team lead sets the review policy, as POST /api/review-policy does (review-policy.ts). */
  changePolicy(person: string, policy: unknown): Promise<PolicyChangeOutcome> {
    return changeReviewPolicy(
      { features: this.features, scopeMap: async () => this.scopeMap, sign: (record) => this.#sign(record), current: () => this.storedPolicy(), adminMode: this.adminMode },
      person,
      policy,
    );
  }

  overlapDeps(): OverlapDeps {
    return {
      db: this.sql,
      features: this.features,
      overlaps: this.overlaps,
      scopeMap: async () => this.scopeMap,
      sign: (record) => this.#sign(record),
      listener: {
        lockOpened: ({ featureId, blockedFeatureId, personId }) => {
          this.inbox.overlapRequested(personId, featureId, blockedFeatureId);
          this.#notify(personId);
        },
        lockSettled: ({ featureId, blockedFeatureId, personId }) => {
          this.inbox.overlapSettled(personId, featureId, blockedFeatureId);
          this.#notify(personId);
        },
        startTold: ({ featureId, blockedFeatureId, personId }) => {
          this.inbox.overlapTold(personId, featureId, blockedFeatureId);
          this.#notify(personId);
        },
      },
    };
  }

  featureDeps(): FeatureDeps {
    return {
      features: this.features,
      scopeMap: async () => this.scopeMap,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      sign: (record) => this.#sign(record),
      checkOverlap: (feature) => checkOverlap(this.overlapDeps(), this.features.get(feature.id) ?? feature),
      overlapStatus: (featureId) => this.overlaps.status(featureId),
    };
  }

  approvalDeps(): PlanApprovalDeps {
    return {
      features: this.features,
      routes: this.routes,
      inbox: this.inbox,
      keeper: () => this.plans,
      delegates: async () => new Map(),
      sign: (record) => this.#sign(record),
      roundLimit: this.roundLimit,
      notify: this.#notify,
      // An approved part on a running feature takes its place in its fork's order of writes. Each
      // approval also opens the copy writes of the originating change's current modules (#179).
      approved: (featureId, plan, part) => {
        openFixWrite(this.fixGrants, featureId, plan, part);
        openCopyWrites(this.fixGrants, featureId, plan, part);
      },
      checks: {
        reviews: (featureId) => this.reviews.list(featureId),
        scopeMap: async () => this.scopeMap,
        adminMode: this.adminMode,
        trial: (featureId, part) => trialStanding(this.trials, this.reviews, featureId, part),
        policy: () => this.policyInForce(),
      },
    };
  }

  /** Penguin approves each pending part of the feature's plan whose checks are clean, as the ProjectAgent does. */
  async penguinApproves(featureId: string): Promise<void> {
    await approveCleanParts(this.approvalDeps(), featureId);
  }

  toolDeps(): AgentToolDeps {
    const history = gitHistory(this.repo);
    return {
      features: this.features,
      runs: this.tools,
      scopeMap: async () => this.scopeMap,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      session: (sessionId) => this.sessions.get(sessionId),
      identity: (identityId) => this.identities.get(identityId),
      baseline: (_repo, sha) => checkpointBaseline(history, history, sha),
      retiring: () => this.retiring.list(),
      split: (featureId) => this.splits.get(featureId),
    };
  }

  /** What sorting a contract diff and splitting a feature read and write, as the ProjectAgent wires it. */
  splitDeps(): ContractSplitDeps {
    return {
      features: this.features,
      facts: this.facts,
      splits: this.splits,
      sign: (record) => this.#sign(record),
      dependents: (id) => this.overlaps.dependents(id),
      retiring: this.retiring,
      notify: this.#notify,
      contractSteps: (id) => this.retiring.contractSteps(id),
      migrationPlans: (id) => this.migrations.plans(id),
    };
  }

  /** What the split's migration plans read and write, as the ProjectAgent wires them (migration-plans.ts). */
  migrationDeps(): MigrationDeps {
    return {
      store: this.migrations,
      features: this.features,
      runs: this.tools,
      retiring: this.retiring,
      trials: this.trials,
      reviews: this.reviews,
      scopeMap: async () => this.scopeMap,
      sign: (record) => this.#sign(record),
      // As edit-work.ts openEditTask: the roster brought up to date, then the source routed once.
      openTask: async (source, adjust) => {
        this.roster.sync(this.scopeMap, this.features.list());
        return this.editTasks.open(source, adjust(editRouting({ roster: this.roster, features: this.features }, this.scopeMap, () => true)));
      },
      tasks: this.editTasks,
      grants: this.fixGrants,
      invariants: async () => parseInvariantsBytes(new TextEncoder().encode(this.git("show", "main:penguin/invariants.json")), this.scopeMap).invariants,
      // A feature Penguin opens goes through the overlap lock, as the ProjectAgent wires it.
      checkOverlap: (feature) => checkOverlap(this.overlapDeps(), this.features.get(feature.id) ?? feature),
      adminMode: this.adminMode,
      policy: () => this.policyInForce(),
      // The fixture's repository stands in for Artifacts: a fork of main is a branch at main's head.
      fork: async (featureId) => {
        this.git("update-ref", `refs/heads/feature-${featureId}`, this.git("rev-parse", "main"));
        return `feature-${featureId}`;
      },
      // As the ProjectAgent wires it: a closed block asks no one, leaves the queue and frees each start it held.
      released: async (featureId) => {
        this.overlaps.withdrawAll(featureId);
        this.blockQueue.remove(featureId);
        for (const blocked of this.overlaps.heldBy(featureId)) {
          const feature = this.features.get(blocked);
          if (feature !== undefined) await checkOverlap(this.overlapDeps(), feature);
        }
      },
      notify: this.#notify,
    };
  }

  /** What counting the callers of retiring symbols and the contract step read and write, as the ProjectAgent wires it. */
  countDeps(): RetiringCountDeps {
    return {
      features: this.features,
      runs: this.tools,
      retiring: this.retiring,
      facts: this.facts,
      scopeMap: async () => this.scopeMap,
      sign: (record) => this.#sign(record),
      notify: this.#notify,
      carry: (featureId, symbols, count) => carryContract(this.migrationDeps(), featureId, symbols, count),
    };
  }

  /** Each count of Penguin's own the runner reported, with what it changed. */
  readonly counts: { readonly runId: number; readonly outcome: CountOutcome }[] = [];

  /**
   * The promotion of `featureId` moved main to `sha`, as its block's push does: the symbols a landed
   * block removed close, and Penguin's count of the remaining callers runs on the check runner.
   * Answers the count's run id, or undefined when nothing is retiring.
   */
  async promoted(featureId: string, sha: string, landed: boolean): Promise<number | undefined> {
    this.tick();
    this.moveMain(sha);
    if (landed) await closeRemoved(this.countDeps(), featureId, sha);
    const runId = requestRetiringCount(this.countDeps(), featureId, sha);
    const edges = requestScopeEdges({ features: this.features, runs: this.tools }, featureId, sha);
    if (runId !== undefined || edges !== undefined) await this.runnerPass();
    return runId;
  }

  /**
   * What writing approved fixes reads and writes, as the ProjectAgent wires it (fix-write.ts). The
   * fixture's repository stands in for Artifacts: a fork's `main` is the feature's branch.
   */
  fixWriteDeps(): FixWriteDeps {
    const approval = this.approvalDeps();
    return {
      features: this.features,
      routes: this.routes,
      keeper: approval.keeper,
      sign: approval.sign,
      notify: this.#notify,
      grants: this.fixGrants,
      scopeMap: async () => this.scopeMap,
      readFork: async (repo, use) => use({ ...gitReader(this.repo), log: async ({ limit }) => this.#branchLog(repo, limit) }),
      locked: (featureId) => this.overlaps.status(featureId).waitingOn.length > 0,
    };
  }

  /** The newest `limit` commits of a branch's first-parent history: `base` reads main, a fork its own branch. */
  #branchLog(repo: string, limit: number): { readonly hash: string }[] {
    return this.git("log", "--first-parent", "--format=%H", `-n${limit}`, repo === "base" ? "main" : repo)
      .split("\n")
      .filter(Boolean)
      .map((hash) => ({ hash }));
  }

  /** A fork as a writer's remote: the fixture's repository, with the fork's `main` read as the feature's branch. */
  #forkRemote(fork: string): GitRemote {
    const branch = `refs/heads/${FIX_WRITE_BRANCH}`;
    return {
      name: fork,
      artifacts: false,
      git: (cwd, args) => runGit(cwd, args(this.repo).map((arg) => arg.replace(branch, `refs/heads/${fork}`))),
    };
  }

  /**
   * Writes the approved fix of `partId` into its running feature's fork and reports the commit, as
   * the originating agent does with `fix_token` and `report_fix_write`, or the check runner for a
   * mechanical part with its claim. The commit is the approved patch on the fork head, written with
   * the bridge's `writeFix`. Answers the commit kept as the `fix_write` record.
   */
  async writeApprovedFix(featureId: string, partId: string): Promise<string> {
    this.tick();
    const feature = this.features.get(featureId);
    const part = (await this.plan(featureId))?.parts.find((each) => each.partId === partId);
    if (feature === undefined || part === undefined) throw new Error(`no part ${partId}`);
    const deps = this.fixWriteDeps();
    const sessionId = this.sessionOf.get(featureId) as string;
    const heartbeat = (caller: string, session: string) => this.sessions.heartbeat(caller, session);
    const input = { feature: featureId, part: partId, revision: part.revision };
    if (part.kind !== "behavioural") {
      const [own] = await this.#runnerClaim((grant) => grant.partId === partId);
      if (own === undefined) throw new Error(`the check runner claimed no write of ${partId}`);
      return own.commit;
    }
    const granted = await agentFixGrant(deps, heartbeat, feature.personId, sessionId, input);
    if (granted.status !== "ok") throw new Error(`fix_token ${partId}: ${granted.message}`);
    const written = await this.#pushFix(granted.spec);
    const reported = await agentFixReport(deps, heartbeat, feature.personId, sessionId, { ...input, commit: written });
    if (reported.status !== "ok") throw new Error(`report_fix_write ${partId}: ${reported.message}`);
    return written;
  }

  /**
   * Writes `spec` into its fork with the bridge's `writeFix`; answers the commit pushed. A write that
   * copies the originating change's modules reads them from the originating fork, as runner mode does.
   */
  async #pushFix(spec: FixWriteSpec): Promise<string> {
    const repo = await this.#runner();
    if (spec.copy !== undefined) await fetchRepoBranches(repo, () => localRemote(this.repo), `feature-${spec.feature}`);
    const written = await writeFix({ repoPath: repo, remote: this.#forkRemote(spec.fork) }, spec);
    if (written.status !== "written") throw new Error(`writing ${spec.partId} into ${spec.fork}: ${written.status === "moved" ? `the fork moved to ${written.head}` : written.reason}`);
    return written.commit;
  }

  /**
   * One claim of the check runner's (`POST /fix-writes/claim`): it writes and reports each claimed
   * write whose grant `pick` accepts, and releases the rest, which go back to their place in their
   * fork's order for a later claim. The preview writes each fork's writes at the fixture's dates, so
   * one claim does not write them all as a polling runner would. Answers each write kept.
   */
  async #runnerClaim(pick: (grant: FixGrant) => boolean): Promise<{ readonly grant: FixGrant; readonly commit: string }[]> {
    const deps = this.fixWriteDeps();
    const claimed = await claimRunnerWrites(deps, RUNNER);
    if (claimed.status !== "ok") throw new Error(claimed.message);
    const kept: { grant: FixGrant; commit: string }[] = [];
    for (const { spec } of claimed.writes) {
      const grant = this.fixGrants.byId(spec.writeId) as FixGrant;
      if (!pick(grant)) {
        this.fixGrants.release(grant.id, RUNNER.bridgeId);
        continue;
      }
      const commit = await this.#pushFix(spec);
      const reported = await runnerFixReport(deps, RUNNER, spec.writeId, { commit });
      if (reported.status !== "ok") throw new Error(`report_fix_write ${grant.partId}: ${reported.message}`);
      kept.push({ grant, commit });
    }
    return kept;
  }

  /** Whether a copy write waits to be made into feature `featureId`'s fork. */
  copiesWaiting(featureId: string): boolean {
    return this.fixGrants.openOn(featureId).some((grant) => copyWriteOf(grant) !== undefined);
  }

  /**
   * The check runner claims the copy writes whose turn it is, into feature `target`'s fork or into
   * any, and copies the originating change's current modules there (fix-write.ts `openCopyWrites`).
   * A copy write whose fork already holds every module is withdrawn by the claim. Answers each copy
   * kept, as `<part> into <feature>`.
   */
  async writeCopies(target?: string): Promise<string[]> {
    this.tick();
    const kept = await this.#runnerClaim((grant) => copyWriteOf(grant) !== undefined && (target === undefined || grant.targetFeatureId === target));
    return kept.map(({ grant }) => `${writtenPart(grant)} into ${grant.targetFeatureId}`);
  }

  /**
   * The originating agent asks to land its feature (`land_feature`): a signed `land_requested` record
   * names the block run. Answers `copy_not_written` when an affected fork does not yet hold the
   * originating change's current modules: Penguin opened that fork's copy write, and the agent asks
   * again once it is written.
   */
  async requestLand(featureId: string): Promise<"asked" | "copy_not_written"> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    const asked = await requestLand(this.landDeps(), feature.personId, this.sessionOf.get(featureId) as string, { feature: featureId });
    if (asked.status === "rejected" && asked.reason === "copy_not_written") return "copy_not_written";
    if (asked.status === "rejected") throw new Error(`land ${featureId}: ${asked.message}`);
    return "asked";
  }

  /** The promotion of the block `checkBlocks` held, once the next step lets it go. */
  #heldPromotion: { readonly go: () => void; readonly pass: Promise<BlockReportResult[]> } | undefined;

  /**
   * The check runner checks each waiting block run on its merged trees and reports it; the report is
   * a signed `block_checked` record. A passing land's promotion waits for `promoteChecked`, so the
   * checks and the promotion are two steps.
   */
  async checkBlocks(): Promise<void> {
    const hold = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const pass = this.blockPass({ checked: checked.resolve, hold: hold.promise });
    this.#heldPromotion = { go: hold.resolve, pass };
    await Promise.race([checked.promise, pass]);
  }

  /** Lets the promotion `checkBlocks` held move main; answers each report's outcome. */
  async promoteChecked(): Promise<BlockReportResult[]> {
    const held = this.#heldPromotion;
    if (held === undefined) throw new Error("no block was checked");
    this.#heldPromotion = undefined;
    held.go();
    return held.pass;
  }

  /**
   * Reads main's scope dependencies with the check runner's analysis when no promotion in the seed
   * asked for them, so the team view shows main as the fixture builds it.
   */
  async deriveMain(): Promise<void> {
    if (this.scopeEdges.snapshot().derivation !== null) return;
    const main = this.git("rev-parse", "main");
    const report = await pythonImpactAnalyzer({ repoPath: this.repo, python: PYTHON, env: ENV })({ base: main, head: main, forks: [], edges: true });
    this.scopeEdges.derived(report.scopeEdges ?? [], main, 0, report.complete);
  }

  /** The check runner makes every pending facts run; each report of a latest checkpoint is sorted, as the ProjectAgent does. */
  async factsPass(): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), "penguin-preview-facts-"));
    const runner = new PlanFactsRunner({
      repoPath: this.repo,
      runner: new TestRunner({ repoPath: this.repo, env: ENV, scratchDir: scratch, consent: () => true }),
      impact: pythonImpactAnalyzer({ repoPath: this.repo, python: PYTHON, env: ENV }),
      fixes: new FixApplier({ repoPath: this.repo, ruff: RUFF, python: PYTHON, env: ENV, scratchDir: scratch }),
    });
    for (const request of this.facts.pending()) {
      const report = JSON.parse(JSON.stringify(await runner.run(request)));
      const recorded = this.facts.record(request.runId, RUNNER.bridgeId, report);
      if (recorded.status !== "recorded") throw new Error(`facts ${request.runId}: ${JSON.stringify(recorded)}`);
      const feature = this.features.get(request.feature);
      if (feature !== undefined) await recordSplit(this.splitDeps(), feature, this.scopeMap);
    }
  }

  /** `get_work`'s contract for a feature: the sort of its latest checkpoint, its split and its next step. */
  async contract(featureId: string): Promise<ContractWorkView> {
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    await recordSplit(this.splitDeps(), feature, this.scopeMap);
    return contractWork(this.splitDeps(), feature, this.scopeMap);
  }

  /** Creates each identity of `penguin/identities.json` and registers one session of it, in its vendor. */
  seedIdentities(identities: readonly SeedIdentity[]): void {
    for (const identity of identities) {
      const name = identity.handle.split("/")[1] ?? identity.handle;
      const created = this.identities.create(
        identity.owner,
        { handle: identity.handle, name, job: identity.job, charterScopes: identity.charter_scopes, charterPaths: identity.charter_paths ?? [], autoAccept: true },
        this.scopeMap,
      );
      if (created.status !== "ok") throw new Error(`${identity.handle}: ${JSON.stringify(created)}`);
    }
  }

  /** Registers a session of `handle` for feature `featureId`, as its agent's bridge would. */
  register(identity: SeedIdentity, featureId: string): string {
    const registered = this.sessions.register(identity.owner, {
      identity: identity.handle,
      vendor: identity.vendor,
      worktreeId: `wt_${featureId}`,
      branch: `feature-${featureId}`,
    });
    if (registered.status !== "ok") throw new Error(`${identity.handle}: ${JSON.stringify(registered)}`);
    this.sessionOf.set(featureId, registered.session.id);
    return registered.session.id;
  }

  /** The feature's agent opens it with its declared area; Penguin records the fork. */
  async open(identity: SeedIdentity, featureId: string, area: unknown): Promise<void> {
    this.tick();
    const sessionId = this.register(identity, featureId);
    const opened = await openFeature(this.featureDeps(), identity.owner, { feature: featureId, area }, sessionId);
    if (opened.status === "rejected") throw new Error(`open ${featureId}: ${opened.message}`);
    recordFeatureRepo(this.features, featureId, `feature-${featureId}`);
  }

  /**
   * The feature's agent pushes commit `ref` to its fork and reports it as a checkpoint. The fixture's
   * repository stands in for the fork: the feature's branch moves to the commit, so the branch is the
   * fork head a fix write or a block run reads.
   */
  async checkpoint(featureId: string, ref: string): Promise<string> {
    this.tick();
    const sha = this.git("rev-parse", `${ref}^{commit}`);
    this.git("update-ref", `refs/heads/feature-${featureId}`, sha);
    const feature = this.features.get(featureId);
    const sessionId = this.sessionOf.get(featureId);
    if (feature === undefined || sessionId === undefined) throw new Error(`no feature ${featureId}`);
    const history = gitHistory(this.repo);
    const reported = await reportFeatureCheckpoint(
      {
        ...this.featureDeps(),
        commitExists: async (_repo, commit) => history.has(commit),
        readChange: (_repo, commit) => checkpointChange(history, history, commit),
        deliver: (caller, session) => {
          const delivery = this.sessions.checkpoint(caller, session);
          return delivery.status === "ok" ? delivery : undefined;
        },
        protectedChanges: (reporting, commit) =>
          checkProtectedChanges(
            {
              ...this.protectedDeps(),
              readOwnChange: (_repo, at) => ownChange(gitReader(this.repo), history, at),
              readDiffs: async (_repo, files) => (await fileDiffs(gitReader(this.repo), files, () => null)).files,
            },
            reporting,
            commit,
            this.scopeMap,
          ),
        checkRetiring: (checked, session, commit) => requestRetiringCheck(this.toolDeps(), checked, session, commit),
        ...(this.sortContracts
          ? {
              sortContract: async (sorted: Parameters<typeof recordSplit>[1]) => {
                const baseline = checkpointRecord(this.features, sorted)?.baseline;
                const run = baseline === undefined ? undefined : scheduleSort(this.splitDeps(), sorted, baseline, this.scopeMap);
                if (run?.state === "reported") await recordSplit(this.splitDeps(), sorted, this.scopeMap);
                return run?.runId;
              },
            }
          : {}),
        now: () => Date.now(),
      },
      feature.personId,
      sessionId,
      featureId,
      sha,
    );
    if (reported.status === "rejected") throw new Error(`checkpoint ${featureId}: ${reported.message}`);
    return sha;
  }

  protectedDeps(): ConfirmDeps {
    return {
      store: this.protectedChanges,
      inbox: this.inbox,
      notify: this.#notify,
      features: this.features,
      delegates: async () => new Map(),
      sign: (record) => this.#sign(record),
    };
  }

  /** `person` confirms the lines feature `featureId`'s own change writes under the paths they protect. */
  async confirmProtected(person: string, featureId: string): Promise<void> {
    this.tick();
    const change = this.protectedChanges.get(featureId, person);
    if (change === undefined) throw new Error(`no protected change of ${featureId} for ${person}`);
    if (this.gate !== undefined) {
      return this.gate.decision({ person, routes: ["/api/plan-parts/confirm-protected"], fields: { feature: featureId, owner: person } });
    }
    const confirmed = await confirmProtectedChange(this.protectedDeps(), person, { feature: featureId, owner: person, checkpoint: change.checkpoint });
    if (confirmed.status !== "ok") throw new Error(`confirm ${featureId} for ${person}: ${confirmed.message}`);
  }

  /** The feature's agent asks `whats_near` about its own scopes. */
  async whatsNear(featureId: string): Promise<void> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    await whatsNear(this.toolDeps(), feature.personId, this.sessionOf.get(featureId) as string, { scopes: feature.area.scopes });
  }

  /**
   * The feature's agent calls `impact`, `check` or `apply_fix` with `input`; the check runner claims and
   * runs it with every other waiting request. Answers the request's run id.
   */
  async runnerTool(featureId: string, tool: "impact" | "check" | "apply_fix", input: Record<string, unknown> = {}): Promise<number> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    const requested = await requestTool(this.toolDeps(), feature.personId, this.sessionOf.get(featureId) as string, tool, { ...input, feature: featureId });
    if (requested.status === "rejected") throw new Error(`${tool} on ${featureId}: ${requested.message}`);
    await this.runnerPass();
    return requested.runId;
  }

  /** The check runner claims and runs every waiting tool request, such as a checkpoint's retiring-calls check. */
  async runnerPass(): Promise<void> {
    const repo = await this.#runner();
    const scratch = `${repo}-scratch`;
    const impact = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: ENV });
    const pass = await toolPass({
      claim: async () => {
        const claimed = await claimToolRuns({ runs: this.tools, features: this.features, identity: (id) => this.identities.get(id) }, RUNNER);
        return claimed.status === "ok" ? claimed.runs : [];
      },
      report: async (runId, result) => {
        const recorded = recordToolResult(this.tools, RUNNER, runId, result);
        if (recorded.status !== "recorded") throw new Error(`report ${runId}: ${JSON.stringify(recorded)}`);
        // Main's scope dependencies go to the stored edges, as the ProjectAgent's report does.
        edgesReported(this.scopeEdges, recorded.run);
        // A count of Penguin's own goes on to the contract step, as the ProjectAgent's report does.
        const counted = await countReported(this.countDeps(), recorded.run);
        if (counted !== undefined) this.counts.push({ runId, outcome: counted });
        // The split's migration plans follow each count, retiring-calls check and rewrite, as the ProjectAgent's report does.
        if (this.migrationPlans) {
          const deps = this.migrationDeps();
          await migrationsCounted(deps, recorded.run);
          await migrationsChecked(deps, recorded.run);
          await rewritesReported(deps, recorded.run);
        }
        return recorded as never;
      },
      fetchFork: (fork) => fetchRepoBranches(repo, () => localRemote(this.repo), fork),
      impact,
      combined: new CombinedRunner({
        repoPath: repo,
        runner: new TestRunner({ repoPath: repo, env: ENV, scratchDir: scratch, consent: () => true }),
        impact,
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: ENV }),
        }),
      }),
      fixes: new FixApplier({ repoPath: repo, ruff: RUFF, python: PYTHON, env: ENV, scratchDir: scratch }),
      repoPath: repo,
    });
    const failed = pass.runs.find((run) => run.error !== null);
    if (failed !== undefined) throw new Error(`tool request ${failed.runId} (${failed.tool}) on ${failed.feature}: ${failed.error}`);
  }

  /** A file at a commit of the check runner's repository, such as a fix `apply_fix` kept there unpushed. */
  async runnerFile(sha: string, path: string): Promise<string> {
    return execFileSync("git", ["-C", await this.#runner(), "show", `${sha}:${path}`], { encoding: "utf8" });
  }

  /** The record repo: an empty bare repository on disk, as project setup makes it in Artifacts. */
  #recordRepo(): Promise<string> {
    this.#recordRepoDir ??= (async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "penguin-preview-record-")));
      execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", dir]);
      return dir;
    })();
    return this.#recordRepoDir;
  }

  /**
   * Commits every stored record to the record repo, a batch a push, as the ProjectAgent's alarm does
   * a few seconds after each record (record-repo.ts). The push goes to the bare repository through
   * `git receive-pack`.
   */
  async pushRecords(): Promise<void> {
    const server = gitServer({ record: await this.#recordRepo() }, { preview: "write" });
    const open = async () => ({ endpoint: { remote: "https://artifacts.test/git/record.git", token: "preview" }, close: async () => undefined });
    for (;;) {
      const outcome = await flushRecords({ store: this.recordRepo, open, fetch: server.fetch });
      if (outcome.status === "failed") throw new Error(`pushing records: ${outcome.reason}`);
      if (outcome.status === "idle") return;
    }
  }

  /** A record's file at the commit that added it, or undefined while it is not in the record repo. */
  async recordFile(featureId: string, recordId: string): Promise<string | undefined> {
    const stored = this.features.records(featureId).find((record) => record.recordId === recordId);
    const commit = this.recordRepo.commitOf(recordId);
    if (stored === undefined || commit === undefined) return undefined;
    return execFileSync("git", ["-C", await this.#recordRepo(), "show", `${commit}:${stored.path}`], { encoding: "utf8" });
  }

  /** An empty repository for the check runner, which fetches each fork as runner mode does. */
  #runner(): Promise<string> {
    this.#runnerRepo ??= (async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "penguin-preview-runner-")));
      await mkdir(`${dir}-scratch`, { recursive: true });
      execFileSync("git", ["init", "--quiet", dir]);
      return dir;
    })();
    return this.#runnerRepo;
  }

  /**
   * The originating agent proposes its merge plan with its rewrite rules and, for the stored data its
   * change owns, its store marker, as the MCP tool passes them. The first proposal schedules the facts
   * run, which the check runner makes, rules included; the second stores the plan and tells every
   * author.
   */
  async propose(
    featureId: string,
    parts: readonly unknown[],
    rules: readonly RewriteRule[] = [],
    retiring: readonly RetiringSymbol[] = [],
    storeMarker?: PlanStoreMarker,
  ): Promise<ProposePlanOutcome> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    const call = () =>
      proposePlan(
        {
          features: this.features,
          facts: this.facts,
          keeper: () => this.plans,
          scopeMap: async () => this.scopeMap,
          invariantsFile: async () => new TextEncoder().encode(this.git("show", "main:penguin/invariants.json")),
          dependents: (id) => this.overlaps.dependents(id),
          readRepo: async (_repo, use) => use(gitReader(this.repo)),
          heartbeat: (caller, session) => this.sessions.heartbeat(caller, session),
          sign: (record) => this.#sign(record),
          breakLimit: this.breakLimit,
          evidence: (id) => ({ reviews: this.reviews.list(id).map(reviewResult), adminMode: this.adminMode }),
          exception: (person, id) => {
            this.inbox.planReturned(person, id);
            this.#notify(person);
          },
          announce: (plan, scopeMap) => {
            announcePlan(this.approvalDeps(), plan, scopeMap);
            queueTrials({ trials: this.trials, reviews: this.reviews }, plan);
          },
          retiring: this.retiring,
          splits: this.splits,
          notify: this.#notify,
        },
        feature.personId,
        this.sessionOf.get(featureId) as string,
        {
          feature: featureId,
          parts,
          ...(rules.length === 0 ? {} : { rules }),
          ...(retiring.length === 0 ? {} : { retiring }),
          ...(storeMarker === undefined ? {} : { storeMarker }),
        },
      );
    // The check runner tests each part revision of a stored plan on its trial tree; Penguin then
    // approves each part whose checks are clean.
    const settled = async (outcome: ProposePlanOutcome): Promise<ProposePlanOutcome> => {
      if (outcome.status !== "stored") return outcome;
      await this.trialPass();
      await this.penguinApproves(featureId);
      return { ...outcome, plan: (await this.plan(featureId)) ?? outcome.plan };
    };
    const first = await call();
    if (first.status !== "missing" || !first.missing.some((item) => item.code === "waiting_for_runner")) return settled(first);
    await this.factsPass();
    return settled(await call());
  }

  /**
   * The check runner claims every waiting part trial (part-trial.ts), builds each part revision's trial
   * tree in its own repository and runs the part's scopes' tests and the review harness for each form
   * on it, then reports, as runner mode does.
   */
  async trialPass(): Promise<void> {
    const claimed = claimPartTrials(this.trials, RUNNER);
    if (claimed.status !== "ok") return;
    const scratch = await mkdtemp(join(tmpdir(), "penguin-preview-trial-"));
    const runner = new PartTrialRunner({
      repoPath: this.repo,
      runner: new TestRunner({ repoPath: this.repo, env: ENV, scratchDir: scratch, consent: () => true }),
      review: (request) =>
        runReview({ repoPath: this.repo, python: PYTHON, env: ENV, scratchDir: scratch, analyzer: pythonImpactAnalyzer({ repoPath: this.repo, python: PYTHON, env: ENV }) }, request),
      sideBySide: (request) => runSideBySide({ repoPath: this.repo, python: PYTHON, env: ENV, scratchDir: scratch }, request),
      scratchDir: scratch,
    });
    for (const request of claimed.trials) {
      const report = JSON.parse(JSON.stringify(await runner.run(request)));
      const recorded = await recordPartTrial(
        {
          trials: this.trials,
          reviews: this.reviews,
          routeToOwner: (ownerId, stored) => {
            this.inbox.reviewException(ownerId, stored.featureId, stored.scopeId);
            this.#notify(ownerId);
          },
        },
        RUNNER,
        request.trialId,
        report,
      );
      if (recorded.status === "rejected") throw new Error(`trial ${request.trialId}: ${recorded.message}`);
      // A migration part's trial is decided by its own plan (migration-plans.ts).
      if (recorded.status === "recorded" && isMigrationPlanId(recorded.trial.planId)) await migrationTrialReported(this.migrationDeps(), recorded.trial);
    }
  }

  /**
   * What landing a block reads, as the ProjectAgent wires it (block-land.ts). The fixture's repository
   * stands in for Artifacts: the base repo's branch is `main`, and a fork's branch is its repo name.
   */
  landDeps(): LandDeps {
    const agent = (): FeatureBlocks => ({
      latestPlan: (id) => this.plans.latestPlan(id),
      fixWrites: (id) => this.plans.fixWrites(id),
      openBlockRun: (input) => this.blocks.open(input),
      claimBlockRuns: (runner) => ({ runs: this.blocks.claim(runner), waiting: this.blocks.hasWaiting() }),
    });
    return {
      features: this.features,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      charter: (handle, person) => {
        const identity = this.identities.byHandle(handle);
        return identity === undefined ? undefined : { handle: identity.handle, person: identity.ownerId ?? person, scopes: [...identity.charterScopes], paths: [...identity.charterPaths] };
      },
      agent,
      readRepo: async (name, read) =>
        read({
          ...gitReader(this.repo),
          log: async ({ ref, limit }) =>
            this.git("log", "--first-parent", "--format=%H", `-n${limit}`, name === "base" ? ref : name)
              .split("\n")
              .filter(Boolean)
              .map((hash) => ({ hash })),
        }),
      baseRepo: "base",
      branch: "main",
      queue: this.blockQueue,
      unconfirmedProtected: (id) => unconfirmedProtected(this.protectedChanges, id),
      // A land waits until every affected fork holds the originating change's current modules (#179).
      copiesBehind: (plan, targets) => copiesBehind(this.fixWriteDeps(), plan, targets),
      sign: (record) => this.#sign(record),
      notify: this.#notify,
    };
  }

  /**
   * Penguin lands each feature it opened whose parts are all written (penguin-land.ts), as the
   * ProjectAgent's sweep does: the fork's head recorded as its checkpoint, then the land itself with
   * the charter of the steward of the feature's person.
   */
  async landPenguinFeatures(): Promise<PenguinLandAttempt[]> {
    this.tick();
    const history = gitHistory(this.repo);
    const land = this.landDeps();
    return landPenguinFeatures({
      migrations: this.migrations,
      lands: this.penguinLands,
      features: this.features,
      tasks: this.editTasks,
      forkHead: async (repo) => this.git("rev-parse", repo),
      mainHead: async () => this.git("rev-parse", "main"),
      checkpoint: async (feature, sha) => {
        const recorded = await recordPenguinCheckpoint(
          {
            ...this.featureDeps(),
            readChange: (_repo, commit) => checkpointChange(history, history, commit),
            protectedChanges: (reporting, commit) =>
              checkProtectedChanges(
                {
                  ...this.protectedDeps(),
                  readOwnChange: (_repo, at) => ownChange(gitReader(this.repo), history, at),
                  readDiffs: async (_repo, files) => (await fileDiffs(gitReader(this.repo), files, () => null)).files,
                },
                reporting,
                commit,
                this.scopeMap,
              ),
          },
          feature,
          sha,
        );
        return recorded.status === "ok" ? recorded.feature : undefined;
      },
      factsWaiting: (feature) => feature.latestCheckpointSha !== null && this.facts.forCheckpoint(feature.id, feature.latestCheckpointSha)?.state === "pending",
      charter: (person) => {
        const steward = this.roster.stewardOf(person);
        return steward === undefined ? undefined : land.charter(steward.handle, person);
      },
      land: (featureId, charter) => requestPenguinLand(land, featureId, charter),
      sign: (record) => this.#sign(record),
      notify: this.#notify,
      // A fork main moved past is rebuilt from main. Its branch moves to main's head, as a new fork of
      // main would start; the old commits stay readable in the fixture's repository.
      rebuild: {
        holdsMain: async (_repo, head, main) => this.git("merge-base", head, main) === main,
        run: (feature, kind, head, main) =>
          rebuildPenguinFeature(
            {
              ...this.migrationDeps(),
              readFork: async (_repo, read) => read({ ...gitReader(this.repo), log: async () => [] }),
              refork: async (featureId) => {
                this.git("update-ref", `refs/heads/feature-${featureId}`, this.git("rev-parse", "main"));
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
  }

  /**
   * The check runner claims every waiting block run and checks it on its merged trees (block-run.ts);
   * each report is recorded and a passing land is promoted, as the FeatureAgent does. The push moves
   * main only from the commit the block was checked against. A promotion then lands the feature, its
   * migration plan when it is a block, and counts the remaining callers, as the ProjectAgent does. A
   * failed check's agent steps become next-step edit tasks, a feature Penguin opened's for the steward
   * of its person. Answers each report's outcome.
   */
  async blockPass(step: { readonly checked?: () => void; readonly hold?: Promise<void> } = {}): Promise<BlockReportResult[]> {
    const repo = await this.#runner();
    const scratch = `${repo}-scratch`;
    const impact = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: ENV });
    const notify = this.#notify;
    const outcomes: BlockReportResult[] = [];
    const work = {
      tasks: this.editTasks,
      roster: this.roster,
      features: this.features,
      scopeMap: async () => this.scopeMap,
      running: () => [],
      notify,
    } as unknown as EditWorkDeps;
    const pass = await blockPass({
      claim: async () => this.blocks.claim(RUNNER.bridgeId),
      report: async (report) => {
        const recorded = await reportBlockRun(
          {
            store: this.blocks,
            fixWrites: (id) => this.plans.fixWrites(id),
            port: {
              signBlockRecord: async (featureId, type, payload) => {
                const record = await this.#sign(this.features.draftRecord(featureId, type, { penguin: true }, payload));
                this.features.addRecord(record);
                if (type === "block_checked") step.checked?.();
                return record.record_id;
              },
              acquirePromotion: async (featureId, runId) => {
                await step.hold;
                return this.blockQueue.acquire(featureId, runId);
              },
              releasePromotion: async (runId) => this.blockQueue.release(runId),
              featureLanded: async (featureId, promotion) => {
                await migrationBlockLanded(this.migrationDeps(), featureId, promotion.mainAfter);
                await featureLanded(
                  {
                    features: this.features,
                    queue: this.blockQueue,
                    retirePlan: () => undefined,
                    // Each start the landed feature held is checked again, as the ProjectAgent does.
                    recheckLocks: async (id) => {
                      for (const blocked of this.overlaps.heldBy(id)) {
                        const waiting = this.features.get(blocked);
                        if (waiting !== undefined) await checkOverlap(this.overlapDeps(), waiting);
                      }
                    },
                    notify,
                  },
                  featureId,
                  promotion,
                );
                await this.promoted(featureId, promotion.mainAfter, true);
              },
              landFailed: async (featureId) => landFailed({ features: this.features, notify }, featureId),
              retryLand: async () => ({ status: "rejected", reason: "busy", message: "the preview makes one push at a time" }),
              expandPromoted: async () => undefined,
              retryExpand: async () => ({ status: "rejected", reason: "busy", message: "the preview makes one push at a time" }),
              blockReported: async (featureId, run, decisions: readonly LadderDecision[]) =>
                blockReported(work, featureId, run, decisions, this.migrations.openedByPenguin(featureId) ? stewardsFor(this.migrations) : undefined),
            },
            // Main moves only from the commit the block was checked against, in one step.
            push: async (run) => {
              const head = this.git("rev-parse", "main");
              if (head !== run.mainBefore) return { status: "moved", head, durationMs: 0 };
              this.moveMain(run.checkpoint);
              return { status: "pushed", packBytes: 0, durationMs: 0 };
            },
            seal: async () => 0,
          },
          RUNNER,
          report.runId,
          JSON.parse(JSON.stringify(report)),
        );
        outcomes.push(recorded);
        if (recorded.status === "rejected") throw new Error(`block ${report.runId}: ${recorded.message}`);
        return recorded as never;
      },
      fetchRepo: (fork) => fetchRepoBranches(repo, () => localRemote(this.repo), fork),
      combined: new CombinedRunner({
        repoPath: repo,
        runner: new TestRunner({ repoPath: repo, env: ENV, scratchDir: scratch, consent: () => true }),
        impact,
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: ENV }),
        }),
      }),
      repoPath: repo,
    });
    const failed = pass.runs.find((run) => run.error !== null);
    if (failed !== undefined) throw new Error(`block run ${failed.runId}: ${failed.error}`);
    return outcomes;
  }

  /** The newest plan of a feature, or undefined. */
  async plan(featureId: string): Promise<Plan | undefined> {
    return this.plans.latestPlan(featureId);
  }

  /**
   * The agent of `reviewer`'s feature submits a review form for its own scope on `featureId`; the
   * check runner runs the review harness and attaches the record.
   */
  async review(reviewerFeature: string, featureId: string, scope: string, form: ReviewForm): Promise<void> {
    this.tick();
    const reviewer = this.features.get(reviewerFeature);
    if (reviewer === undefined) throw new Error(`no feature ${reviewerFeature}`);
    const history = gitHistory(this.repo);
    const submitted = await submitReview(
      {
        features: this.features,
        reviews: this.reviews,
        scopeMap: async () => this.scopeMap,
        invariantsFile: async () => new TextEncoder().encode(this.git("show", "main:penguin/invariants.json")),
        readForkFile: async (_repo, sha, path) => {
          try {
            return new Blob([this.git("show", `${sha}:${path}`)]);
          } catch {
            return null;
          }
        },
        baseline: (_repo, sha) => checkpointBaseline(history, history, sha),
        heartbeat: (caller, id) => this.sessions.heartbeat(caller, id),
        coveringPart: async (id, scopeId, checkpoint) => {
          const plan = await this.plan(id);
          const covering = plan?.facts.change.checkpoint === checkpoint ? plan.parts.filter((part) => part.scopes.includes(scopeId)) : [];
          return covering.find((part) => part.place.kind === "feature") ?? covering[0];
        },
      },
      reviewer.personId,
      this.sessionOf.get(reviewerFeature) as string,
      { feature: featureId, scope, form },
    );
    if (submitted.status === "rejected") throw new Error(`review ${scope} on ${featureId}: ${submitted.message}`);
    // A form that waits for the runner asks again for a trial of each part covering its scope; the
    // trial runs the form on the part's trial tree, and the review claim leaves it to the trial.
    if (submitted.state === "pending") {
      queueTrialsForReview({ trials: this.trials, reviews: this.reviews }, await this.plan(featureId), submitted.scopeId, submitted.forkSha);
      await this.trialPass();
    }
    const claimed = claimReviews(this.reviews, RUNNER, (review) => trialHolds(this.trials, review));
    if (claimed.status !== "ok") return;
    const scratch = await mkdtemp(join(tmpdir(), "penguin-preview-review-"));
    for (const request of claimed.reviews) {
      const record = await runReview(
        { repoPath: this.repo, python: PYTHON, env: ENV, scratchDir: scratch, analyzer: pythonImpactAnalyzer({ repoPath: this.repo, python: PYTHON, env: ENV }) },
        { base: request.base, fork: request.forkSha, scope: request.scope, form: request.form },
      );
      const recorded = await recordReview(
        {
          reviews: this.reviews,
          routeToOwner: (ownerId, stored) => {
            this.inbox.reviewException(ownerId, stored.featureId, stored.scopeId);
            this.#notify(ownerId);
          },
        },
        RUNNER,
        request.reviewId,
        JSON.parse(JSON.stringify(boundReviewRecord(record))),
      );
      if (recorded.status === "rejected") throw new Error(`review record ${request.reviewId}: ${recorded.message}`);
    }
    // A recorded review may complete a part's checks.
    await this.penguinApproves(featureId);
  }

  /** A part's owner approves its current revision, or asks for a change with `text`. */
  async decide(person: string, featureId: string, partId: string, text?: string): Promise<void> {
    this.tick();
    const part = (await this.plan(featureId))?.parts.find((each) => each.partId === partId);
    if (part === undefined) throw new Error(`no part ${partId}`);
    if (this.gate !== undefined) {
      const routes = ["/api/plan-parts/approve", "/api/plan-parts/request-change"];
      return this.gate.decision({ person, routes, fields: { feature: featureId, part: partId } });
    }
    const input = { feature: featureId, part: partId, revision: part.revision };
    const decided =
      text === undefined ? await approvePlanPart(this.approvalDeps(), person, input) : await requestPlanChange(this.approvalDeps(), person, { ...input, text });
    if (decided.status !== "ok") throw new Error(`decide ${partId}: ${decided.message}`);
  }

  /**
   * The originating agent answers a requested change with `revise_plan_part`: the part's next revision
   * with `fix`, its own trial, then Penguin's approval when every check is clean, as the ProjectAgent's
   * revisePlanPart does.
   */
  async revise(featureId: string, partId: string, fix: { readonly diff?: unknown; readonly patch?: unknown }): Promise<void> {
    this.tick();
    const feature = this.features.get(featureId);
    const part = (await this.plan(featureId))?.parts.find((each) => each.partId === partId);
    if (feature === undefined || part === undefined) throw new Error(`no part ${partId}`);
    const revised = await revisePlanPart(
      {
        ...this.approvalDeps(),
        facts: this.facts,
        scopeMap: async () => this.scopeMap,
        readRepo: async (_repo, use) => use(gitReader(this.repo)),
        heartbeat: (caller, session) => this.sessions.heartbeat(caller, session),
      },
      feature.personId,
      this.sessionOf.get(featureId) as string,
      { feature: featureId, part: partId, revision: part.revision, ...fix },
    );
    if (revised.status !== "ok") throw new Error(`revise ${partId}: ${revised.message}`);
    const plan = await this.plan(featureId);
    if (plan !== undefined) queueTrials({ trials: this.trials, reviews: this.reviews }, plan, plan.parts.filter((each) => each.partId === partId));
    await this.trialPass();
    await this.penguinApproves(featureId);
  }

  viewDeps(): DashboardViewDeps {
    return {
      features: this.features,
      overlaps: this.overlaps,
      routes: this.routes,
      reviews: this.reviews,
      tools: this.tools,
      session: (sessionId) => this.sessions.get(sessionId),
      identities: () => this.identities.list(),
      factsRun: (featureId, checkpoint) => this.facts.forCheckpoint(featureId, checkpoint),
      scopeMap: async () => this.scopeMap,
      delegates: async () => new Map(),
      plan: async (featureId) => this.plans.latestPlan(featureId),
      roundLimit: this.roundLimit,
      fixWrite: (partId, revision) => {
        const grant = this.fixGrants.get(partId, revision);
        if (grant === undefined) return undefined;
        const open = grant.state === "queued" || grant.state === "granted";
        return { ...grant, waitsFor: open ? this.fixGrants.waitsFor(grant) : null };
      },
      // Another plan's writes that wait their turn in the feature's fork, a copy write by its part, as the ProjectAgent reads them.
      incomingWrites: (featureId) =>
        this.fixGrants
          .openOn(featureId)
          .filter((grant) => grant.featureId !== featureId && this.fixGrants.waitsFor(grant) !== null)
          .map((grant) => ({ partId: writtenPart(grant), feature: grant.featureId, person: this.features.get(grant.featureId)?.personId ?? grant.featureId })),
      contract: (feature) => contractWork(this.splitDeps(), feature, this.scopeMap),
      protectedChanges: (featureId) => this.protectedChanges.ofFeature(featureId),
      split: (featureId) => this.splits.get(featureId),
      editTasks: (featureId) => this.editTasks.forFeature(featureId).map((task) => editTaskView(task)),
      steward: (person) => this.stewardView(person),
      builderFeature: (identityId) => {
        const role = this.roster.roleOf(identityId);
        return role?.role === "builder" ? (role.featureId ?? undefined) : undefined;
      },
      scopeEdges: () => this.scopeEdges.snapshot(),
      recordCommits: (featureId) => this.recordRepo.commits(featureId),
      routeOf: async (plan, part) =>
        policyRoute(await this.policyInForce(), routePart(plan, part, this.reviews.list(plan.featureId), this.scopeMap, false, trialStanding(this.trials, this.reviews, plan.featureId, part))),
    };
  }

  /**
   * Opens and settles the edit tasks, as the ProjectAgent does before the team view and the feature
   * page answer. No bridge polls in the preview, so a task no session takes asks its person.
   */
  async syncEditWork(): Promise<void> {
    await syncEditWork({
      tasks: this.editTasks,
      roster: this.roster,
      features: this.features,
      routes: this.routes,
      grants: this.fixGrants,
      reviews: (featureId) => this.reviews.list(featureId),
      scopeMap: async () => this.scopeMap,
      running: () => this.sessions.running(),
      // Only a bridge's claim or report checks a fix write, and the preview has no bridge.
      fix: undefined as never,
      cap: BACKGROUND_RUN_CAP_DEFAULT,
      leaseMs: EDIT_RUN_MINUTES_DEFAULT * 60_000,
      notify: () => undefined,
    });
  }

  /** A person's steward with their queue, as the ProjectAgent's team view reads it. */
  stewardView(person: string): StewardView | null {
    const charter = this.roster.stewardOf(person);
    const identity = charter === undefined ? undefined : this.identities.byHandle(charter.handle);
    if (identity === undefined) return null;
    return { handle: identity.handle, identityId: identity.id, online: this.editTasks.bridgeOnline(person), ...this.editTasks.queue(person, BACKGROUND_RUN_CAP_DEFAULT, "steward") };
  }

  /** The Worker's dashboard backend over these stores, as apps/worker/src/index.ts wires the ProjectAgent's. */
  backend(connectLive: DashboardBackend["connectLive"] = async () => new Response(null, { status: 426 })): DashboardBackend {
    const unsupported = async () => ({ status: "rejected", reason: "forbidden", message: "the preview takes no writes of this kind" }) as const;
    return {
      readIssue: async (issueId) => this.index.read(issueId),
      board: async () =>
        buildBoard({
          ids: () => this.index.ids(),
          issue: (issueId) => this.index.issue(issueId),
          identities: () => this.identities.list(),
          running: () => this.sessions.running(),
          routes: (issueId) => this.sessions.routes(issueId),
          session: (sessionId) => this.sessions.get(sessionId),
          approval: () => undefined,
          assigningOwner: (issueId, handle) => this.index.assigningOwner(issueId, handle),
          actionItems: () => this.inbox.actionItems(),
        }),
      inbox: async (owner) => buildInbox({ items: (person) => this.inbox.items(person), issue: (issueId) => this.index.issue(issueId) }, owner),
      markInboxRead: async (owner, issueId, reason) => this.inbox.markRead(owner, issueId, reason as never) as never,
      submit: unsupported as never,
      identities: async () =>
        buildIdentitiesPage({
          identities: () => this.identities.list(),
          sessions: () => this.sessions.byIdentity(10),
          history: () => this.index.identityHistory(),
          issue: (issueId) => this.index.issue(issueId),
          forks: () => this.forks.list(),
          operations: (handle) => this.index.authoredOperations(handle, 5),
          scopeMap: this.scopeMap,
        }),
      createIdentity: unsupported as never,
      editIdentity: unsupported as never,
      duplicateIdentity: unsupported as never,
      connectLive,
      features: async () => this.features.list().map(featureView),
      openFeature: unsupported as never,
      declareFeatureArea: unsupported as never,
      featurePlan: async (owner, featureId) => buildFeaturePlan(this.viewDeps(), featureId, owner),
      team: async (owner) => {
        await this.syncEditWork();
        return buildTeamView(this.viewDeps(), owner);
      },
      personScopes: async (person) => buildPersonScopes(this.viewDeps(), person),
      featurePage: async (owner, featureId) => {
        await this.syncEditWork();
        await this.pushRecords();
        return buildFeaturePage(this.viewDeps(), featureId, owner);
      },
      featureRecord: async (featureId, recordId) => this.recordFile(featureId, recordId),
      reviewDifferences: async (reviewId) => {
        const review = this.reviews.get(reviewId);
        return review === undefined ? undefined : reviewDifferences(review);
      },
      overlapRequests: async (owner) => ({
        requests: this.inbox.items(owner).flatMap((item) => {
          const told = item.reason === "overlap_started";
          if (item.reason !== "overlap" && !told) return [];
          const ref = parseOverlapRef(item.issueId);
          const held = ref === undefined ? undefined : this.overlaps.get(ref.featureId, ref.blockedFeatureId);
          const lock = held?.state === (told ? "approved" : "open") ? held : undefined;
          const blocked = lock === undefined ? undefined : this.features.get(lock.blockedFeatureId);
          if (lock === undefined || blocked === undefined) return [];
          return [{ feature: lock.featureId, blockedFeature: lock.blockedFeatureId, blockedPerson: blocked.personId, overlap: lock.overlap, told, read: item.read, raisedAt: item.raisedAt }];
        }),
      }),
      approveOverlap: async (owner, featureId, blockedFeatureId) => {
        const approved = await approveOverlap(this.overlapDeps(), owner, featureId, blockedFeatureId);
        return approved.status === "ok" ? { status: "ok", lock: approved.lock } : approved;
      },
      planParts: async (owner) =>
        buildPlanInbox(
          {
            routes: this.routes,
            reviews: this.reviews,
            keeper: () => this.plans,
            items: (person) => this.inbox.items(person),
            scopeMap: async () => this.scopeMap,
            delegates: async () => new Map(),
            roundLimit: this.roundLimit,
            adminMode: this.adminMode,
            policy: () => this.policyInForce(),
            landed: (featureId) => this.features.get(featureId)?.state === "landed",
            trial: (featureId, part) => trialStanding(this.trials, this.reviews, featureId, part),
            records: (featureId) => this.features.records(featureId),
            ownFeatures: (person) => this.features.list().filter((feature) => feature.personId === person && feature.state !== "landed").map((feature) => feature.id),
            protectedChanges: (owners, items, delegates) => protectedChangeRequests(this.protectedChanges, this.features, items, owners, owner, delegates),
          },
          owner,
        ),
      decidePlanPart: async (owner, decision) => {
        const decided =
          decision.kind === "request_change"
            ? await requestPlanChange(this.approvalDeps(), owner, decision)
            : decision.kind === "reverse"
              ? await reversePenguinApproval(this.approvalDeps(), owner, decision)
              : await approvePlanPart(this.approvalDeps(), owner, decision);
        return decided.status === "ok" ? { status: "ok", part: decided.part, recordId: decided.recordId } : decided;
      },
      confirmProtectedChange: async (owner, input) => {
        const confirmed = await confirmProtectedChange(this.protectedDeps(), owner, input);
        return confirmed.status === "ok" ? { status: "ok", recordId: confirmed.recordId } : confirmed;
      },
      reviewPolicy: async (owner) => reviewPolicyView(await this.storedPolicy(), this.adminMode, this.scopeMap, owner, this.sql, this.#clock),
      changeReviewPolicy: (owner, policy) => this.changePolicy(owner, policy),
    };
  }
}

/** The ProjectAgent's SQL surface over one in-memory SQLite database. */
function memoryDatabase(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * The built repository read through the Artifacts binding's `log` and `readTree`, as the ProjectAgent
 * reads a fork and main: one repository holds both here.
 */
function gitHistory(dir: string): RepoHistoryReader & { has(sha: string): boolean } {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return {
    has: (sha) => {
      try {
        git("cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    log: async ({ ref, limit, offset }) => {
      const out = git("log", "--first-parent", "--format=%H %T", `--skip=${offset}`, `-n${limit}`, ref, "--");
      return out === "" ? [] : out.split("\n").map((line) => {
        const [hash, treeHash] = line.split(" ") as [string, string];
        return { hash, treeHash };
      });
    },
    readTree: async (hash) => {
      const out = git("ls-tree", hash);
      return out === "" ? [] : out.split("\n").map((line) => {
        const [meta, name] = line.split("\t") as [string, string];
        const [mode, , object] = meta.split(" ") as [string, string, string];
        return { name, hash: object, type: mode === "040000" ? "tree" : "blob" };
      });
    },
  };
}

/** Builds the fixture's repository with its own build.py into a new directory. */
export async function buildFixture(fixture: ExampleName): Promise<string> {
  const dir = join(await realpath(await mkdtemp(join(tmpdir(), `penguin-preview-${fixture}-`))), "repo");
  await promisify(execFile)(PYTHON, [join(ROOT, "examples", fixture, "build.py"), dir], { env: ENV });
  return dir;
}

/**
 * The scope map of `penguin/owners.json`, `penguin/teams.json` and `penguin/scopes.json` at `ref` of a
 * built fixture, as the ProjectAgent reads them from main (scope-file.ts).
 */
export function fixtureScopeMap(repo: string, ref = "main"): ScopeMap {
  const show = (path: string): string | null => {
    try {
      return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const owners = (JSON.parse(show("penguin/owners.json") ?? "{}") as { owners: { id: string }[] }).owners.map((owner) => owner.id);
  const teamsFile = show("penguin/teams.json");
  const teams = teamsFile === null ? undefined : parseTeams(JSON.parse(teamsFile), { ownerIds: owners });
  return parseScopeMap(JSON.parse(show("penguin/scopes.json") ?? "{}"), { ownerIds: owners, ...(teams === undefined ? {} : { teams }) });
}

async function project(fixture: ExampleName): Promise<PreviewProject> {
  const repo = await buildFixture(fixture);
  return new PreviewProject(fixture, repo, fixtureScopeMap(repo));
}

const identitiesOf = (preview: PreviewProject): SeedIdentity[] =>
  (JSON.parse(preview.git("show", "main:penguin/identities.json")) as { identities: SeedIdentity[] }).identities;

/** The invariants of `penguin/invariants.json` on main, with each example file's contract. */
function invariantsOf(preview: PreviewProject) {
  const file = JSON.parse(preview.git("show", "main:penguin/invariants.json")) as {
    invariants: { id: string; scope: string; statement: string }[];
    examples: { scope: string; file: string; invariants: string[] }[];
  };
  const contractOf = (path: string) => (JSON.parse(preview.git("show", `main:${path}`)) as { contract: string }).contract;
  return file.invariants.map((invariant) => ({
    ...invariant,
    contract: file.examples.filter((example) => example.invariants.includes(invariant.id)).map((example) => contractOf(example.file))[0],
  }));
}

interface IdentityFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: { readonly scopes: readonly string[] };
  readonly commits: readonly { readonly tag?: string; readonly plan?: boolean; readonly fix?: { readonly scope: string } }[];
}

/**
 * Use cases 1 to 3 from the fixture's `features.json`, up to frame 5 of docs/demo-story.md: every
 * feature open at its checkpoint, the originating agent's whats_near, impact and check, its merge plan
 * with one part per affected place, each running feature's agent reviewing its scope with the
 * fixture's form, and each author whose review raised nothing approving.
 */
async function featuresFixture(preview: PreviewProject): Promise<void> {
  const fixtureDir = join(ROOT, "examples", preview.fixture);
  const { features } = JSON.parse(await readFile(join(fixtureDir, "features.json"), "utf8")) as { features: IdentityFeature[] };
  const pins = JSON.parse(await readFile(join(fixtureDir, "pins.json"), "utf8")) as { branches: Record<string, string>; tags: Record<string, string> };
  const identities = identitiesOf(preview);
  preview.seedIdentities(identities);
  const agentOf = (feature: IdentityFeature) => identities.find((identity) => identity.handle === builderOf(feature)) as SeedIdentity;
  // Running features open first, so the originating feature's overlap check lists them as dependents.
  const ordered = [...features.filter((feature) => feature.role === "running"), ...features.filter((feature) => feature.role === "originating")];
  for (const feature of ordered) {
    await preview.step(`open ${feature.id}`, () => preview.open(agentOf(feature), feature.id, feature.area));
    await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, feature.commits[0]?.tag as string));
  }
  const origin = features.find((feature) => feature.role === "originating") as IdentityFeature;
  // The originating agent proposes its plan at the commit features.json marks `plan`, when that is a
  // later checkpoint: on the helpful fix, Priya's agent adds start_of_local_day() first (PRD case 2).
  const planAt = origin.commits.find((commit) => commit.plan === true)?.tag;
  if (planAt !== undefined && planAt !== origin.commits[0]?.tag) await preview.step(`checkpoint ${origin.id} ${planAt}`, () => preview.checkpoint(origin.id, planAt));
  await preview.step("whats_near", () => preview.whatsNear(origin.id));
  if (preview.runnerTools) {
    await preview.step("impact", () => preview.runnerTool(origin.id, "impact"));
    await preview.step("check", () => preview.runnerTool(origin.id, "check"));
  }

  // A part for code on main names the originating fork's commit that fixes that scope. Each running
  // feature's fix is the fixture's own later commit on its fork, sent as a patch against the feature's
  // checkpoint, as `git diff` prints it for the feature's scopes.
  const running = features.filter((feature) => feature.role === "running");
  const scopeParts = origin.commits.flatMap((commit) =>
    commit.fix === undefined ? [] : [{ place: { scope: commit.fix.scope }, diff: { commit: pins.tags[commit.tag as string] as string } }],
  );
  const featureParts = running.map((feature) => {
    const head = preview.git("rev-parse", `${feature.commits[0]?.tag}^{commit}`);
    const paths = feature.area.scopes.flatMap((scope) => preview.scopeMap.scopes.get(scope)?.paths ?? []);
    const diff = preview.diff(head, pins.branches[feature.fork] as string, paths);
    return { place: { feature: feature.id }, patch: { base: head, diff } };
  });
  const proposed = await preview.step("propose_plan", () => preview.propose(origin.id, [...scopeParts, ...featureParts]));
  if (proposed.status !== "stored") throw new Error(`plan: ${JSON.stringify(proposed).slice(0, 2_000)}`);
  preview.planOutcome = proposed;
  // Each running feature's agent reviews its scope with the fixture's form, `reviews/<scope>.json`. A
  // scope with no form in the fixture gets no review.
  for (const feature of running) {
    const scope = feature.area.scopes[0] as string;
    const file = join(fixtureDir, "reviews", `${scope}.json`);
    if (!existsSync(file)) continue;
    const form = JSON.parse(await readFile(file, "utf8")) as ReviewForm;
    await preview.step(`submit_review ${scope}`, () => preview.review(feature.id, origin.id, scope, form));
  }
  // Penguin approved each part whose checks are clean. An author whose review raised no exception
  // approves a part still waiting on them; one with an exception decides in person. A part that waits
  // on the originating person for their change's stored data is not its author's to approve (#132).
  const plan = await preview.plan(origin.id);
  for (const part of plan?.parts ?? []) {
    if (plan === undefined || part.approvalState !== "pending") continue;
    const routing = routePart(plan, part, preview.reviews.list(origin.id), preview.scopeMap, preview.adminMode, trialStanding(preview.trials, preview.reviews, origin.id, part));
    if (routesToOriginator(routing)) continue;
    const exceptions = preview.reviews.list(origin.id).filter((review) => part.scopes.includes(review.scopeId)).flatMap((review) => review.exceptions);
    if (exceptions.length === 0) await preview.step(`approve ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId));
  }
}

export interface LarderCommit {
  /** Absent for Penguin's update of a fork and for a merge of main that lays nothing of its own. */
  readonly source?: string;
  readonly tag?: string;
  readonly date: string;
  readonly message: string;
  /** `owner` when absent; a person when another person's agent wrote the commit into this fork. */
  readonly author?: string;
  readonly plan?: boolean;
  readonly merge?: string;
  readonly fix?: { readonly scope: string; readonly kind: string };
  readonly declares?: { readonly contracts?: Readonly<Record<string, readonly string[]>> };
  /** Penguin's update of this fork from an originating change: the modules it copies from `tag` of feature `from`. */
  readonly update?: { readonly from: string; readonly tag: string; readonly copies: readonly string[] };
}
export interface LarderFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly start: string;
  /** The use case, 1 to 4, of an originating feature. */
  readonly case?: number;
  /** The scopes the feature declares when it opens. */
  readonly area: readonly string[];
  /** The rewrite rules an originating feature's agent declares with its merge plan. */
  readonly rules?: readonly RewriteRule[];
  readonly commits: readonly LarderCommit[];
}

/** The larder data the use cases read. */
export interface MoneyLarder {
  readonly base: { readonly tag: string };
  readonly features: readonly LarderFeature[];
  readonly promotions: readonly { readonly feature: string; readonly date: string }[];
  readonly split: { readonly feature: string; readonly rules: readonly RewriteRule[]; readonly retiring: readonly RetiringSymbol[] };
}

/** What both halves of the Larder run read: the data file and each feature's agent and tags. */
interface Larder {
  readonly data: MoneyLarder;
  readonly byId: ReadonlyMap<string, LarderFeature>;
  readonly builder: (feature: LarderFeature) => SeedIdentity;
  readonly steward: (person: string) => SeedIdentity;
  /** The fixture's tag of one commit of a feature, `feature-<id>-<tag>`. */
  readonly tagOf: (feature: LarderFeature, tag: string) => string;
  readonly sha: (ref: string) => string;
}

const subjectOf = (commit: LarderCommit): string => commit.message.split("\n")[0] as string;

/**
 * Use cases 1 to 3 on Larder, then Lena's promotion stacking, in the fixture's date order up to the
 * split's first commit (docs/fixture-money.md, Cases 1 to 3). Each running feature opens from `base`
 * at its first commit. Each originating feature (`case`) opens from main as the case before left it,
 * and each person whose running feature covers its area approves its start. At the commit marked
 * `plan` its agent proposes the merge plan: a part for code on main per `fix` of kind `fix` in its own
 * fork, a patch per commit its person wrote into another feature's fork, the backfill's or migration's
 * declared contract as the store marker once the fork holds it, and a verify part for each place
 * Penguin answers is affected with no part. Each running feature with a part reviews its scope with
 * the case's form for the round. When the agent proposes again at a later `plan` commit, no one
 * decides the earlier plan. A review that raises an exception gets its author's request for the
 * change the next `revision` commit makes, which the agent answers with `revise_plan_part`. Each fix
 * written into another fork is reported there as a checkpoint, a `merge` commit takes main, and main
 * moves at each promotion.
 */
async function casesOneToThree(preview: PreviewProject, larder: Larder): Promise<void> {
  const { data, byId, builder, tagOf, sha } = larder;
  const split = byId.get(data.split.feature) as LarderFeature;
  const until = Date.parse(split.commits[0]?.date as string);
  const origins = data.features.filter((feature) => feature.case !== undefined && feature.id !== split.id);
  const promotionOf = (feature: LarderFeature) => Date.parse(data.promotions.find((promotion) => promotion.feature === feature.id)?.date as string);
  const reviewsDir = join(ROOT, "examples", preview.fixture, "reviews");

  type Event = { readonly at: number; readonly feature: LarderFeature; readonly commit: LarderCommit; readonly index: number } | { readonly at: number; readonly promote: string };
  const events: Event[] = [
    ...data.features.flatMap((feature) => feature.commits.map((commit, index) => ({ at: Date.parse(commit.date), feature, commit, index }))),
    ...data.promotions.map((promotion) => ({ at: Date.parse(promotion.date), promote: promotion.feature })),
  ]
    .filter((event) => event.at < until)
    .sort((a, b) => a.at - b.at);

  // The originating feature whose case runs: its commits' fixes written into other forks, by date.
  // Penguin's update of a fork names its originating feature; a fix the originating agent wrote is
  // authored by its person.
  const originAt = (at: number) => origins.find((origin) => Date.parse(origin.commits[0]?.date as string) <= at && at < promotionOf(origin));
  const fixedBy = (origin: LarderFeature, feature: LarderFeature, commit: LarderCommit): boolean =>
    feature.id !== origin.id && originAt(Date.parse(commit.date)) === origin && (commit.update?.from === origin.id || commit.author === origin.owner);
  const writtenFixes = (origin: LarderFeature) =>
    data.features.flatMap((feature) => feature.commits.filter((commit) => fixedBy(origin, feature, commit)).map((commit) => ({ feature, commit })));

  /** The parts the originating agent proposes, from the fixture's own commits. */
  const partsOf = (origin: LarderFeature): unknown[] => {
    const scopeParts = origin.commits
      .filter((commit) => commit.fix?.kind === "fix")
      .map((commit) => ({ place: { scope: commit.fix?.scope }, diff: { commit: sha(tagOf(origin, commit.tag as string)) } }));
    const featureParts = writtenFixes(origin).map(({ feature, commit }) => {
      const base = preview.features.get(feature.id)?.latestCheckpointSha as string;
      // Penguin's update: the patch is the rules' rewrite of the fork's own files; the copied
      // modules are Penguin's to copy at the write, never part of the patch.
      const copies = (commit.update?.copies ?? []).map((path) => `:(exclude)${path}`);
      const paths = feature.area.flatMap((scope) => preview.scopeMap.scopes.get(scope)?.paths ?? []);
      const diff = preview.diff(base, sha(tagOf(feature, commit.tag as string)), [...paths, ...copies]);
      // An update that only copies has nothing for the rules to rewrite: the place is a verify part,
      // whose write copies the modules.
      return diff === "" ? { place: { feature: feature.id }, verify: true } : { place: { feature: feature.id }, patch: { base, diff } };
    });
    return [...scopeParts, ...featureParts];
  };

  /** The backfill or migration the fork holds at `upTo`, named by the contract its commit declares. */
  const markerAt = (origin: LarderFeature, upTo: number): PlanStoreMarker | undefined => {
    for (const commit of origin.commits.slice(0, upTo + 1)) {
      const kind = PLAN_STORE_MARKERS.find((each) => each === commit.fix?.kind);
      const evidence = commit.declares?.contracts?.[commit.fix?.scope as string]?.[0];
      if (kind !== undefined && evidence !== undefined) return { kind, evidence };
    }
    return undefined;
  };

  /**
   * Each running feature with a part reviews its scope with the case's form for the round at commit
   * `index`: `reviews/case<N>-<scope>-<tag>.json` of the newest commit up to it that has one, or else
   * the case's one form, `reviews/case<N>-<scope>.json`.
   */
  const reviewRound = async (origin: LarderFeature, index: number): Promise<void> => {
    const plan = (await preview.plan(origin.id)) as Plan;
    const tags = origin.commits.slice(0, index + 1).map((commit) => commit.tag as string).reverse();
    const at = origin.commits[index]?.tag as string;
    // A verify part asks for no review form, but its feature's agent still reviews the scope: the
    // form decides the plan's parts for that scope's code on main.
    for (const place of plan.parts.map((part) => part.place)) {
      if (place.kind !== "feature") continue;
      const reviewer = byId.get(place.feature) as LarderFeature;
      for (const scope of reviewer.area) {
        const names = [...tags.map((tag) => `case${origin.case}-${scope}-${tag}.json`), `case${origin.case}-${scope}.json`];
        const file = names.map((name) => join(reviewsDir, name)).find((path) => existsSync(path));
        if (file === undefined) continue;
        const form = JSON.parse(await readFile(file, "utf8")) as ReviewForm;
        await preview.step(`submit_review ${scope} on ${origin.id} at ${at}`, () => preview.review(reviewer.id, origin.id, scope, form));
      }
    }
  };

  /** The agent proposes at commit `index`, adding a verify part where Penguin answers a scope has none. */
  const propose = async (origin: LarderFeature, index: number): Promise<void> => {
    const commit = origin.commits[index] as LarderCommit;
    const parts = partsOf(origin);
    const marker = markerAt(origin, index);
    const outcome = await preview.step(`propose_plan ${origin.id} at ${commit.tag}`, async () => {
      const rules = origin.rules ?? [];
      const first = await preview.propose(origin.id, parts, rules, [], marker);
      // An affected place with no fix of its own, such as loyalty in case 1, gets a verify part.
      const unclaimed = first.status === "missing" ? first.missing.filter((item) => item.code === "no_part") : [];
      if (first.status !== "missing" || unclaimed.length !== first.missing.length) return first;
      const verify = unclaimed.map((item) => ({ place: item.place?.kind === "scope" ? { scope: item.place.scope } : { feature: (item.place as { feature: string }).feature }, verify: true }));
      return preview.propose(origin.id, [...parts, ...verify], rules, [], marker);
    });
    if (outcome.status !== "stored") throw new Error(`${origin.id} plan at ${commit.tag}: ${JSON.stringify(outcome).slice(0, 2_000)}`);
    preview.planOutcome = outcome;
    await reviewRound(origin, index);
    await decide(origin, index);
  };

  /** The part each requested revision commit answers. */
  const answers = new Map<LarderCommit, string>();
  /** Whether the originating agent proposes again before its next revision: then no one decides this round. */
  const proposesAgain = (origin: LarderFeature, index: number): boolean => {
    const next = origin.commits.slice(index + 1).find((commit) => commit.plan === true || commit.fix?.kind === "revision");
    return next?.plan === true;
  };

  /**
   * Each person decides the parts that wait on them. A review that raised an exception on a part for
   * code on main gets its author's request for the change the next revision commit of that scope
   * makes: a revision is a commit in the originating fork, which only such a part names. A part whose
   * exception no revision is left to answer is approved by its author as it stands, and any other part
   * waiting on its author is approved. A part waiting on a review, on the originating person or on a
   * revision still to come is left.
   */
  const decide = async (origin: LarderFeature, index: number): Promise<void> => {
    const plan = (await preview.plan(origin.id)) as Plan;
    const reviews = preview.reviews.list(origin.id);
    const raised: string[] = [];
    const toOriginator: string[] = [];
    const ahead = origin.commits.slice(index + 1).filter((commit) => commit.fix?.kind === "revision" && !answers.has(commit));
    const again = proposesAgain(origin, index);
    const routings = new Map<string, PartRouting>();
    for (const part of plan.parts) {
      const routing = routePart(plan, part, reviews, preview.scopeMap, preview.adminMode, trialStanding(preview.trials, preview.reviews, origin.id, part));
      routings.set(part.partId, routing);
      if (part.approvalState !== "pending") continue;
      if (routesToOriginator(routing)) toOriginator.push(part.partId);
      if (!needsPerson(routing) || routesToOriginator(routing) || again) continue;
      if (!routing.reasons.some((reason) => reason.kind === "broken_invariant" || reason.kind === "protected_difference")) {
        await preview.step(`${part.owner} approves ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId));
        continue;
      }
      raised.push(part.partId);
      const answer = ahead.find((commit) => part.scopes.includes(commit.fix?.scope as string));
      if (answer === undefined) {
        await preview.step(`${part.owner} approves ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId));
      } else if (part.place.kind === "scope" && ![...answers.values()].includes(part.partId)) {
        answers.set(answer, part.partId);
        await preview.step(`${part.owner} asks for a change to ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId, subjectOf(answer)));
      }
    }
    preview.rounds.push({ plan: (await preview.plan(origin.id)) as Plan, toOriginator, raised, routings });
  };

  /**
   * The feature opens. Penguin lets it start beside every running feature that covers its area and
   * tells each one's person (overlap-lock.ts, #177): no one is asked.
   */
  const open = async (feature: LarderFeature): Promise<void> => {
    await preview.step(`open ${feature.id}`, () => preview.open(builder(feature), feature.id, { scopes: feature.area }));
  };

  const originCommit = async (origin: LarderFeature, commit: LarderCommit, index: number): Promise<void> => {
    const tag = commit.tag as string;
    if (index === 0) await open(origin);
    if (commit.plan === true) {
      await preview.step(`checkpoint ${origin.id} ${tag}`, () => preview.checkpoint(origin.id, tagOf(origin, tag)));
      await preview.step(`whats_near ${origin.id}`, () => preview.whatsNear(origin.id));
      if (preview.runnerTools) await preview.step(`impact ${origin.id}`, () => preview.runnerTool(origin.id, "impact"));
      // Case 3 opens on the dependency diff `check` shows (PRD section 1), so its agent always checks.
      if (preview.runnerTools || origin.case === 3) await preview.step(`check ${origin.id}`, () => preview.runnerTool(origin.id, "check"));
      await propose(origin, index);
    } else if (commit.fix?.kind === "revision") {
      // The originating agent answers the request with revise_plan_part, naming the revision commit
      // against the part's first base; its author's agent reviews the round with the round's form.
      const partId = answers.get(commit);
      if (partId === undefined) throw new Error(`${origin.id} ${tag} revises ${commit.fix.scope}, but no one asked for a change there`);
      answers.delete(commit);
      const part = (await preview.plan(origin.id))?.parts.find((each) => each.partId === partId);
      const diff = { commit: sha(tagOf(origin, tag)), ...(part?.diff.base == null ? {} : { base: part.diff.base }) };
      await preview.step(`revise_plan_part ${partId} with ${tag}`, () => preview.revise(origin.id, partId, { diff }));
      await reviewRound(origin, index);
      await decide(origin, index);
    } else if (index === 0) {
      await preview.step(`checkpoint ${origin.id} ${tag}`, () => preview.checkpoint(origin.id, tagOf(origin, tag)));
    }
    // Any other commit is the agent's work between checkpoints, reported with the next one.
  };

  for (const event of events) {
    if ("promote" in event) {
      // The block lands at the feature's head, which holds every fix for code on main and every
      // revision: its agent reports that head as a checkpoint first, as land_feature requires.
      const feature = byId.get(event.promote) as LarderFeature;
      const head = feature.commits.filter((commit) => Date.parse(commit.date) < event.at).at(-1) as LarderCommit;
      const headSha = sha(tagOf(feature, head.tag as string));
      if (preview.features.get(feature.id)?.latestCheckpointSha !== headSha) {
        await preview.step(`checkpoint ${feature.id} ${head.tag}`, () => preview.checkpoint(feature.id, tagOf(feature, head.tag as string)));
      }
      // The agent asks to land; the check runner checks the block on main and every running fork;
      // the passing block's promotion moves main. While an affected fork lacks the originating
      // change's current modules the land is refused: the check runner copies them, then the agent asks again.
      let asked = await preview.step(`land_feature ${feature.id}`, () => preview.requestLand(feature.id));
      while (asked === "copy_not_written") {
        const copied = await preview.step(`check runner copies ${feature.id}'s modules into its affected forks`, () => preview.writeCopies());
        if (copied.length === 0) throw new Error(`${feature.id}'s land waits for copies the check runner did not write`);
        asked = await preview.step(`land_feature ${feature.id} again`, () => preview.requestLand(feature.id));
      }
      await preview.step(`block checks of ${feature.id}`, () => preview.checkBlocks());
      await preview.step(`promote ${feature.id}`, async () => {
        await preview.promoteChecked();
        if (preview.features.get(feature.id)?.state !== "landed") {
          const records = preview.features.records(feature.id).map((kept) => JSON.parse(kept.file) as { type: string; payload: Record<string, unknown> });
          const checked = records.filter((record) => record.type === "block_checked").at(-1)?.payload;
          const failing = preview.blocks.get(String(checked?.["run_id"]))?.failing;
          throw new Error(`${feature.id} did not land: ${JSON.stringify({ failing, last: records.at(-1)?.type }).slice(0, 4_000)}`);
        }
      });
      continue;
    }
    const { feature, commit, index } = event;
    const tag = commit.tag as string;
    if (feature.case !== undefined) {
      await originCommit(feature, commit, index);
    } else if (index === 0 && feature.start === "base") {
      await open(feature);
      await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, tagOf(feature, tag)));
    } else if (origins.some((origin) => fixedBy(origin, feature, commit))) {
      // The fixture's commit is the approved fix of the originating plan's part on this fork. Penguin's
      // check runner writes a mechanical or verify part's update (the rules' patch and the copied
      // modules); the originating agent writes a behavioural part's patch (fix_token), unchanged.
      const origin = originAt(event.at) as LarderFeature;
      const part = (await preview.plan(origin.id))?.parts.find((each) => each.place.kind === "feature" && each.place.feature === feature.id);
      if (part?.approvalState !== "approved") throw new Error(`${feature.id} ${tag}: ${origin.id}'s part there is ${part?.approvalState ?? "missing"}, not approved`);
      await preview.step(`fix_write ${part.partId} into ${feature.id}`, () => preview.writeApprovedFix(origin.id, part.partId));
      // A behavioural part's copy write follows the agent's write into the fork: the check runner
      // copies the originating change's current modules the fork imports.
      if (preview.copiesWaiting(feature.id)) {
        await preview.step(`check runner copies ${origin.id}'s modules into ${feature.id}`, () => preview.writeCopies(feature.id));
      }
    } else if (commit.merge === "main") {
      await preview.step(`${feature.id} takes main`, () => preview.checkpoint(feature.id, tagOf(feature, tag)));
    } else {
      throw new Error(`no step for ${feature.id} ${tag} before the split`);
    }
  }
}

/** Use cases 1 to 4 on Larder, run in order on one main (PRD section 1). */
async function larderCases(preview: PreviewProject): Promise<void> {
  const data = JSON.parse(await readFile(join(ROOT, "examples", preview.fixture, "larder.json"), "utf8")) as MoneyLarder;
  const identities = identitiesOf(preview);
  preview.seedIdentities(identities);
  preview.sortContracts = true;
  preview.migrationPlans = true;
  const larder: Larder = {
    data,
    byId: new Map(data.features.map((feature) => [feature.id, feature])),
    builder: (feature) => identities.find((identity) => identity.handle === builderOf(feature)) as SeedIdentity,
    steward: (person) => identities.find((identity) => identity.handle === `@${person}/steward`) as SeedIdentity,
    tagOf: (feature, tag) => `feature-${feature.id}-${tag}`,
    sha: (ref) => preview.git("rev-parse", `${ref}^{commit}`),
  };
  // The build leaves main where the last promotion put it; the cases start it at the first commit.
  preview.moveMain(larder.sha(data.base.tag));
  await casesOneToThree(preview, larder);
  await moneyMinorUnits(preview, larder);
}

/**
 * Use case 4 (money in minor units) as docs/case-study-money.md runs it, on main as cases 1 to 3 and
 * Lena's promotion left it: Ines's feature opens, its first checkpoint is the expand, and the plan Ines's agent
 * proposes there names no place and declares the rewrite rules and the retiring float API. Main moves
 * to the expand; Penguin counts the remaining callers and proposes one migration plan per owner
 * group. Noor's pagination adds a float call midway and Sun's currency filter starts after the
 * expand. Each part is then written as the fixture holds it: a reader's builder reports its migration
 * as a checkpoint, and each owner's steward writes the block Penguin opened for code on main, which
 * lands. Rahul's review of the tax block breaks tax-per-line on the whole-order step and holds on the
 * per-line revision. When no caller is left Penguin proposes the contract, and Ines's contract lands.
 */
async function moneyMinorUnits(preview: PreviewProject, { data: larder, byId, builder, steward, tagOf, sha }: Larder): Promise<void> {
  const origin = byId.get(larder.split.feature) as LarderFeature;

  // Ines opens the split feature; Penguin lets it start and tells the person of each running feature in its area.
  await preview.step(`open ${origin.id}`, () => preview.open(builder(origin), origin.id, { scopes: origin.area }));
  const expand = origin.commits[0]?.tag as string;
  await preview.step(`checkpoint ${origin.id} ${expand}`, () => preview.checkpoint(origin.id, tagOf(origin, expand)));
  await preview.step("whats_near", () => preview.whatsNear(origin.id));
  if (preview.runnerTools) {
    await preview.step("impact", () => preview.runnerTool(origin.id, "impact"));
    await preview.step("check", () => preview.runnerTool(origin.id, "check"));
  }
  // The expand only adds, so the plan has no place. It declares the rules and the float API it
  // replaces; Penguin checks the declaration and records the split from it (PRD 0.5 section 4.2 step 2).
  preview.splitOutcome = await preview.step("propose_plan at the expand", () => preview.propose(origin.id, [], larder.split.rules, larder.split.retiring));
  if (preview.splitOutcome.status !== "stored") throw new Error(`expand plan: ${JSON.stringify(preview.splitOutcome).slice(0, 2_000)}`);
  // Penguin promotes the expand on its own; the split's old names retire and the feature keeps building on its fork.
  await preview.step(`promote ${origin.id}'s expand`, async () => {
    await retireSplit(preview.splitDeps(), origin.id, sha(tagOf(origin, expand)));
    await preview.promoted(origin.id, sha(tagOf(origin, expand)), false);
    await preview.runnerPass();
    await preview.trialPass();
  });

  // Noor's pagination calls the float API midway; Sun's currency filter starts after the expand.
  for (const feature of larder.features.filter((each) => each.role === "midway")) {
    const later = feature.commits.find((commit) => commit.tag === "checkpoint") as LarderCommit;
    await preview.step(`checkpoint ${feature.id}`, async () => {
      await preview.checkpoint(feature.id, tagOf(feature, later.tag as string));
      await preview.runnerPass();
      await preview.runnerPass();
      await preview.trialPass();
    });
  }
  for (const feature of larder.features.filter((each) => each.role === "late-starter")) {
    await preview.step(`open ${feature.id}`, () => preview.open(builder(feature), feature.id, { scopes: feature.area }));
    await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, tagOf(feature, feature.commits[0]?.tag as string)));
  }

  // Each running feature's builder writes its migration and reports it as a checkpoint.
  for (const plan of preview.migrations.plans(origin.id)) {
    for (const part of plan.parts) {
      if (part.place.kind !== "feature" || part.state === "dropped") continue;
      const feature = byId.get(part.place.feature) as LarderFeature;
      const migrate = feature.commits.find((commit) => commit.fix?.kind === "migration");
      if (migrate === undefined) continue;
      await preview.step(`migrate ${feature.id}`, async () => {
        const written = await preview.checkpoint(feature.id, tagOf(feature, migrate.tag as string));
        preview.editTasks.close(`migrate:${part.partId}`, "done", `${builderOf(feature)} reported the migration as a checkpoint`, written);
      });
    }
  }

  await migrationTasksSettled(preview.migrationDeps());

  // Each owner's steward writes the block Penguin opened for that owner's code on main, in the
  // fixture's order: each commit starts from main as the last block left it. Rahul's agent reviews the
  // tax block at each step with the fixture's form for it. Penguin lands each block once its parts on
  // main are written (penguin-land.ts), and the check runner checks and promotes it.
  const blocks = larder.promotions.map((promotion) => byId.get(promotion.feature) as LarderFeature).filter((feature) => feature.role === "migration");
  for (const block of blocks) {
    const plan = preview.migrations.planOfBlock(block.id);
    if (plan === undefined) throw new Error(`Penguin opened no block ${block.id}`);
    await preview.step(`open ${block.id} as ${block.owner}'s steward`, () => preview.open(steward(block.owner), block.id, { scopes: block.area }));
    for (const commit of block.commits) {
      const written = sha(tagOf(block, commit.tag as string));
      preview.git("update-ref", `refs/heads/feature-${block.id}`, written);
      await preview.step(`checkpoint ${block.id} ${commit.tag}`, () => preview.checkpoint(block.id, tagOf(block, commit.tag as string)));
      const form = join(ROOT, "examples", preview.fixture, "reviews", `${commit.fix?.scope}-${commit.tag}.json`);
      if (existsSync(form)) {
        const parsed = JSON.parse(await readFile(form, "utf8")) as ReviewForm;
        await preview.step(`submit_review ${commit.fix?.scope} at ${commit.tag}`, () => preview.review(block.id, block.id, commit.fix?.scope as string, parsed));
      }
      for (const part of plan.parts.filter((each) => each.place.kind === "scope")) {
        preview.editTasks.close(`migrate:${part.partId}`, "done", `${steward(block.owner).handle} wrote ${commit.tag}`, written);
      }
    }
    await migrationTasksSettled(preview.migrationDeps());
    for (const change of preview.protectedChanges.ofFeature(block.id).filter((row) => row.state === "pending")) {
      await preview.step(`confirm ${block.id}'s custom path rule lines as ${change.ownerId}`, () => preview.confirmProtected(change.ownerId, block.id));
    }
    await preview.step(`land ${block.id}`, async () => {
      await preview.landPenguinFeatures();
      await preview.blockPass();
      // The count after the promotion asked for rewrites and trials.
      await preview.runnerPass();
      await preview.trialPass();
    });
    if (preview.migrations.planOfBlock(block.id)?.state !== "landed") {
      throw new Error(`${block.id} did not land: ${JSON.stringify(preview.features.records(block.id).map((kept) => JSON.parse(kept.file).type).slice(-8))}`);
    }
  }

  // No caller is left: Penguin approved the contract on Ines's feature, and Ines's agent removes the
  // float API with its own tests, then lands the feature.
  const contract = origin.commits.at(-1) as LarderCommit;
  if (preview.retiring.contractSteps(origin.id).some((step) => step.state === "approved")) {
    await preview.step(`checkpoint ${origin.id} ${contract.tag}`, async () => {
      preview.git("update-ref", `refs/heads/feature-${origin.id}`, sha(tagOf(origin, contract.tag as string)));
      await preview.checkpoint(origin.id, tagOf(origin, contract.tag as string));
      // The checkpoint's facts run holds the contract diff that shows each symbol removed.
      await preview.factsPass();
    });
    await preview.step(`land ${origin.id}`, async () => {
      const asked = await requestLand(preview.landDeps(), origin.owner, preview.sessionOf.get(origin.id) as string, { feature: origin.id });
      if (asked.status === "rejected") throw new Error(`land ${origin.id}: ${asked.message}`);
      await preview.blockPass();
      await preview.runnerPass();
    });
  }
}

/**
 * Seeds `fixture`'s project through the ProjectAgent's modules and the check runner's programs. With
 * `gate`, the gate gets the project before the first step, and each step waits for it.
 */
export async function seed(fixture: ExampleName, options: { readonly runnerTools?: boolean; readonly gate?: StepGate } = {}): Promise<PreviewProject> {
  const preview = await project(fixture);
  preview.runnerTools = options.runnerTools ?? true;
  options.gate?.attach(preview);
  try {
    if (fixture === "money-minor-units") await larderCases(preview);
    else await featuresFixture(preview);
    await preview.step("read main's scope dependencies", () => preview.deriveMain());
  } catch (error) {
    options.gate?.finish(error);
    throw error;
  }
  options.gate?.finish();
  return preview;
}
