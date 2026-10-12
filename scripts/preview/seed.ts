// A Penguin project seeded from one fixture under `examples/`, for the dashboard preview, its
// screenshots and the dashboard's fixture tests. The stores are the ProjectAgent's own, wired as the
// ProjectAgent wires them, over an in-memory SQLite database. Every step goes through the module the
// ProjectAgent calls for it: opening a feature with its overlap check, each checkpoint, the agent tools,
// a merge plan with the check runner's facts run, each review form with the runner's side-by-side run,
// and each person's decision. The check runner's programs run for real on the fixture's built
// repository: the impact analysis, the block checks, pytest and the review harness.
//
// Every person, scope, identity, feature, commit, test and invariant comes from the fixture's files
// and the runs. A review form is derived from the fixture too (`reviewForm`).

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { generateSigningKeyPair } from "@penguin/issues";
import {
  BlockChecker,
  checkTools,
  CombinedRunner,
  fetchRepoBranches,
  FixApplier,
  localRemote,
  PlanFactsRunner,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  runReview,
  TestRunner,
  toolPass,
} from "@penguin/local-bridge";
import { boundReviewRecord, type Plan, type PlanBreakFact, type ReviewForm } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import type { DashboardBackend } from "../../apps/worker/src/dashboard.ts";
import { featureView } from "../../apps/worker/src/features.ts";
import { claimToolRuns, recordToolResult } from "../../services/project-agent/src/agent-tool-runner.ts";
import { AgentToolStore, requestTool, whatsNear, type AgentToolDeps } from "../../services/project-agent/src/agent-tools.ts";
import { buildBoard } from "../../services/project-agent/src/board.ts";
import { checkpointBaseline, checkpointChange, type RepoHistoryReader } from "../../services/project-agent/src/combined-run-schedule.ts";
import { buildFeaturePage, buildFeaturePlan, buildTeamView, type DashboardViewDeps } from "../../services/project-agent/src/dashboard-views.ts";
import { openFeature, recordFeatureRepo, reportFeatureCheckpoint, type FeatureDeps } from "../../services/project-agent/src/feature-open.ts";
import { FeatureStore, signFeatureRecord } from "../../services/project-agent/src/feature-store.ts";
import { buildIdentitiesPage } from "../../services/project-agent/src/identities-page.ts";
import { IdentityStore } from "../../services/project-agent/src/identity-store.ts";
import { buildInbox } from "../../services/project-agent/src/inbox-page.ts";
import { InboxStore } from "../../services/project-agent/src/inbox-store.ts";
import { IssueIndex, type BridgeCaller, type SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { approveOverlap, checkOverlap, OverlapStore, type OverlapDeps } from "../../services/project-agent/src/overlap-lock.ts";
import { OwnerForkStore } from "../../services/project-agent/src/owner-forks.ts";
import {
  announcePlan,
  approvePlanPart,
  buildPlanInbox,
  PlanRouteStore,
  requestPlanChange,
  type PlanApprovalDeps,
} from "../../services/project-agent/src/plan-approval.ts";
import { PlanFactsStore } from "../../services/project-agent/src/plan-facts.ts";
import { PlanStore } from "../../services/project-agent/src/plan-store.ts";
import { proposePlan, type ProposePlanOutcome } from "../../services/project-agent/src/propose-plan.ts";
import { claimReviews, recordReview } from "../../services/project-agent/src/review-record.ts";
import { ReviewStore, submitReview } from "../../services/project-agent/src/review-submit.ts";
import { SessionStore } from "../../services/project-agent/src/session-store.ts";
import { gitReader } from "../../services/project-agent/test/git-reader.ts";

const ROOT = join(import.meta.dirname, "../..");
const VENV_BIN = join(ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const ENV = { ...process.env, PATH: [VENV_BIN, process.env["PATH"]].join(delimiter), UV_OFFLINE: "1" };
const RUNNER: BridgeCaller = { bridgeId: "preview-runner", role: "runner" };

export const FIXTURES = ["identity-unification", "money-minor-units"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** One identity as the fixture's `penguin/identities.json` seeds it. */
interface SeedIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
}

/** One step a scenario logs, with how long it took, so a run reads as the fixture's story. */
export interface SeedStep {
  readonly step: string;
  readonly ms: number;
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
  readonly reviews: ReviewStore;
  readonly tools: AgentToolStore;
  readonly index: IssueIndex;
  readonly forks: OwnerForkStore;
  readonly steps: SeedStep[] = [];
  /** Each person whose inbox changed, in order, as the live feed would tell them. */
  readonly notified: string[] = [];
  readonly sessionOf = new Map<string, string>();
  #key = generateSigningKeyPair();
  #clock = Date.parse("2026-10-11T09:00:00Z");
  #runnerRepo: Promise<string> | undefined;

  readonly scopeMap: ScopeMap;
  readonly repo: string;
  readonly fixture: FixtureName;
  readonly roundLimit = 3;
  /** Whether the originating agent calls impact and check, which the check runner runs: off for a quick seed. */
  runnerTools = true;
  /** PENGUIN_PLAN_BREAK_LIMIT: the PRD default until a scenario changes the project's setting. */
  breakLimit = 10;
  /** The originating agent's last `propose_plan` answer. */
  planOutcome: ProposePlanOutcome | undefined;

  constructor(fixture: FixtureName, repo: string, scopeMap: ScopeMap) {
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
    this.reviews = new ReviewStore(this.sql);
    this.tools = new AgentToolStore(this.sql);
    this.forks = new OwnerForkStore(this.sql, now);
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
    const started = performance.now();
    const value = await run();
    this.steps.push({ step, ms: Math.round(performance.now() - started) });
    return value;
  }

  async #sign(draft: Parameters<typeof signFeatureRecord>[0]) {
    return signFeatureRecord(draft, (await this.#key).privateKey);
  }

  #notify = (person: string) => {
    this.notified.push(person);
  };

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
    };
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
    };
  }

  /** Creates each identity of `penguin/identities.json` and registers one session of it, in its vendor. */
  seedIdentities(identities: readonly SeedIdentity[]): void {
    for (const identity of identities) {
      const name = identity.handle.split("/")[1] ?? identity.handle;
      // A charter names only its owner's scopes; a scope another person owns stays in the feature's area.
      const charterScopes = identity.charter_scopes.filter((scope) => this.scopeMap.scopes.get(scope)?.ownerId === identity.owner);
      const created = this.identities.create(identity.owner, { handle: identity.handle, name, job: identity.job, charterScopes, autoAccept: true }, this.scopeMap);
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

  /** The feature's agent reports checkpoint `ref` of its fork. */
  async checkpoint(featureId: string, ref: string): Promise<string> {
    this.tick();
    const sha = this.git("rev-parse", `${ref}^{commit}`);
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

  /** The person who owns `blocked`'s covering feature approves its start. */
  async approveStart(person: string, feature: string, blocked: string): Promise<void> {
    this.tick();
    const approved = await approveOverlap(this.overlapDeps(), person, feature, blocked);
    if (approved.status !== "ok") throw new Error(`approve ${blocked}: ${approved.message}`);
  }

  /** The feature's agent asks `whats_near` about its own scopes. */
  async whatsNear(featureId: string): Promise<void> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    await whatsNear(this.toolDeps(), feature.personId, this.sessionOf.get(featureId) as string, { scopes: feature.area.scopes });
  }

  /** The feature's agent calls `impact` or `check`; the check runner claims and runs it. */
  async runnerTool(featureId: string, tool: "impact" | "check"): Promise<void> {
    this.tick();
    const feature = this.features.get(featureId);
    if (feature === undefined) throw new Error(`no feature ${featureId}`);
    const requested = await requestTool(this.toolDeps(), feature.personId, this.sessionOf.get(featureId) as string, tool, { feature: featureId });
    if (requested.status === "rejected") throw new Error(`${tool} on ${featureId}: ${requested.message}`);
    const repo = await this.#runner();
    const scratch = `${repo}-scratch`;
    const impact = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: ENV });
    const pass = await toolPass({
      claim: async () => {
        const claimed = claimToolRuns({ runs: this.tools, features: this.features, identity: (id) => this.identities.get(id) }, RUNNER);
        return claimed.status === "ok" ? claimed.runs : [];
      },
      report: async (runId, result) => {
        const recorded = recordToolResult(this.tools, RUNNER, runId, result);
        if (recorded.status !== "recorded") throw new Error(`report ${runId}: ${JSON.stringify(recorded)}`);
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
    if (failed !== undefined) throw new Error(`${tool} on ${featureId}: ${failed.error}`);
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
   * The originating agent proposes its merge plan. The first proposal schedules the facts run, which
   * the check runner makes; the second stores the plan and tells every author.
   */
  async propose(featureId: string, parts: readonly unknown[]): Promise<ProposePlanOutcome> {
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
          exception: (person, id) => {
            this.inbox.planReturned(person, id);
            this.#notify(person);
          },
          announce: (plan, scopeMap) => announcePlan(this.approvalDeps(), plan, scopeMap),
        },
        feature.personId,
        this.sessionOf.get(featureId) as string,
        { feature: featureId, parts },
      );
    const first = await call();
    if (first.status !== "missing" || !first.missing.some((item) => item.code === "waiting_for_runner")) return first;
    const runner = new PlanFactsRunner({
      repoPath: this.repo,
      runner: new TestRunner({ repoPath: this.repo, env: ENV, scratchDir: await mkdtemp(join(tmpdir(), "penguin-preview-facts-")), consent: () => true }),
      impact: pythonImpactAnalyzer({ repoPath: this.repo, python: PYTHON, env: ENV }),
    });
    for (const request of this.facts.pending()) {
      const report = JSON.parse(JSON.stringify(await runner.run(request)));
      const recorded = this.facts.record(request.runId, RUNNER.bridgeId, report);
      if (recorded.status !== "recorded") throw new Error(`facts ${request.runId}: ${JSON.stringify(recorded)}`);
    }
    return call();
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
      },
      reviewer.personId,
      this.sessionOf.get(reviewerFeature) as string,
      { feature: featureId, scope, form },
    );
    if (submitted.status === "rejected") throw new Error(`review ${scope} on ${featureId}: ${submitted.message}`);
    const claimed = claimReviews(this.reviews, RUNNER);
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
  }

  /** A part's owner approves its current revision, or asks for a change with `text`. */
  async decide(person: string, featureId: string, partId: string, text?: string): Promise<void> {
    this.tick();
    const part = (await this.plan(featureId))?.parts.find((each) => each.partId === partId);
    if (part === undefined) throw new Error(`no part ${partId}`);
    const input = { feature: featureId, part: partId, revision: part.revision };
    const decided =
      text === undefined ? await approvePlanPart(this.approvalDeps(), person, input) : await requestPlanChange(this.approvalDeps(), person, { ...input, text });
    if (decided.status !== "ok") throw new Error(`decide ${partId}: ${decided.message}`);
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
      factsRun: (featureId, checkpoint) => this.facts.forCheckpoint(featureId, checkpoint)?.state,
      scopeMap: async () => this.scopeMap,
      delegates: async () => new Map(),
      plan: async (featureId) => this.plans.latestPlan(featureId),
      roundLimit: this.roundLimit,
      // The preview's runner writes no fix into a fork, so no part has a write.
      fixWrite: () => undefined,
    };
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
      team: async (owner) => buildTeamView(this.viewDeps(), owner),
      featurePage: async (owner, featureId) => buildFeaturePage(this.viewDeps(), featureId, owner),
      overlapRequests: async (owner) => ({
        requests: this.inbox.items(owner).flatMap((item) => {
          if (item.reason !== "overlap") return [];
          const lock = this.overlaps.openFor(owner).find((each) => item.issueId.endsWith(`${each.featureId}/${each.blockedFeatureId}`));
          const blocked = lock === undefined ? undefined : this.features.get(lock.blockedFeatureId);
          if (lock === undefined || blocked === undefined) return [];
          return [{ feature: lock.featureId, blockedFeature: lock.blockedFeatureId, blockedPerson: blocked.personId, overlap: lock.overlap, read: item.read, raisedAt: item.raisedAt }];
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
            records: (featureId) => this.features.records(featureId),
          },
          owner,
        ),
      decidePlanPart: async (owner, decision) => {
        const decided =
          decision.kind === "approve" ? await approvePlanPart(this.approvalDeps(), owner, decision) : await requestPlanChange(this.approvalDeps(), owner, decision);
        return decided.status === "ok" ? { status: "ok", part: decided.part, recordId: decided.recordId } : decided;
      },
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
export async function buildFixture(fixture: FixtureName): Promise<string> {
  const dir = join(await realpath(await mkdtemp(join(tmpdir(), `penguin-preview-${fixture}-`))), "repo");
  await promisify(execFile)(PYTHON, [join(ROOT, "examples", fixture, "build.py"), dir], { env: ENV });
  return dir;
}

async function project(fixture: FixtureName): Promise<PreviewProject> {
  const repo = await buildFixture(fixture);
  const show = (path: string) => execFileSync("git", ["-C", repo, "show", `main:${path}`], { encoding: "utf8" });
  const owners = (JSON.parse(show("penguin/owners.json")) as { owners: { id: string }[] }).owners.map((owner) => owner.id);
  return new PreviewProject(fixture, repo, parseScopeMap(JSON.parse(show("penguin/scopes.json")), { ownerIds: owners }));
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

/**
 * A review form for `scope`, from the fixture's facts: one row per invariant of the scope. A row
 * breaks when the facts run states a break of the test that protects the invariant (the test whose
 * docstring is its statement) on the reviewer's feature, and the fixture's `pins.json` names a commit
 * other than that feature's own fix as the one that makes the test pass, so the fix leaves it broken.
 * The evidence is the contract the invariant's recorded examples run, which the reviewed fork holds.
 */
function reviewForm(
  preview: PreviewProject,
  breaks: readonly PlanBreakFact[],
  scope: string,
  fixedBy: Readonly<Record<string, string>>,
  fix: string,
): ReviewForm {
  const rows = invariantsOf(preview)
    .filter((invariant) => invariant.scope === scope && invariant.contract !== undefined)
    .map((invariant) => {
      const broken = breaks.some(
        (each) => each.statement.replace(/\.$/u, "") === invariant.statement && fixedBy[each.nodeId] !== undefined && fixedBy[each.nodeId] !== fix,
      );
      return { invariant: invariant.id, verdict: broken ? ("breaks" as const) : ("holds" as const), evidence: [invariant.contract as string], storedData: "" };
    });
  return { rows, riskyInputs: [], storedDataMarker: null };
}

interface IdentityFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: unknown;
  readonly commits: readonly { readonly tag?: string }[];
}

/**
 * Use cases 1 to 3 from the fixture's `features.json`, up to frame 5 of docs/demo-story.md: every
 * feature open at its checkpoint, the originating agent's whats_near, impact and check, its merge plan
 * with one part per running feature, each running feature's agent reviewing its scope, and each author
 * whose review raised nothing approving. When the facts name a place the fixture holds no fix for, the
 * plan stays unstored with Penguin's list of what it lacks, and the reviews go ahead on the feature.
 */
async function featuresFixture(preview: PreviewProject): Promise<void> {
  const fixtureDir = join(ROOT, "examples", preview.fixture);
  const { features } = JSON.parse(await readFile(join(fixtureDir, "features.json"), "utf8")) as { features: IdentityFeature[] };
  const pins = JSON.parse(await readFile(join(fixtureDir, "pins.json"), "utf8")) as { branches: Record<string, string>; fixes: Record<string, string> };
  const identities = identitiesOf(preview);
  preview.seedIdentities(identities);
  const agentOf = (feature: IdentityFeature) => identities.find((identity) => identity.owner === feature.owner) as SeedIdentity;
  // Running features open first, so the originating feature's overlap check lists them as dependents.
  const ordered = [...features.filter((feature) => feature.role === "running"), ...features.filter((feature) => feature.role === "originating")];
  // A contract the feature itself adds is not on main's scope map yet, so the declaration leaves it out.
  const onMain = new Set([...preview.scopeMap.scopes.values()].flatMap((scope) => scope.contracts));
  for (const feature of ordered) {
    const area = feature.area as { scopes: string[]; paths: string[]; contracts: string[] };
    const declared = { ...area, contracts: area.contracts.filter((contract) => onMain.has(contract)) };
    await preview.step(`open ${feature.id}`, () => preview.open(agentOf(feature), feature.id, declared));
    await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, feature.commits[0]?.tag as string));
  }
  const origin = features.find((feature) => feature.role === "originating") as IdentityFeature;
  await preview.step("whats_near", () => preview.whatsNear(origin.id));
  if (preview.runnerTools) {
    await preview.step("impact", () => preview.runnerTool(origin.id, "impact"));
    await preview.step("check", () => preview.runnerTool(origin.id, "check"));
  }

  // Each running feature's fix is the fixture's own later commit on its fork, sent as a patch against
  // the feature's checkpoint, as `git diff` prints it for the feature's scopes.
  const running = features.filter((feature) => feature.role === "running");
  const fixOf = (feature: IdentityFeature) => pins.branches[feature.fork] as string;
  const parts = running.map((feature) => {
    const head = preview.git("rev-parse", `${feature.commits[0]?.tag}^{commit}`);
    const paths = ((feature.area as { scopes: string[] }).scopes ?? []).flatMap((scope) => preview.scopeMap.scopes.get(scope)?.paths ?? []);
    const diff = preview.diff(head, fixOf(feature), paths);
    return { place: { feature: feature.id }, patch: { base: head, diff } };
  });
  const proposed = await preview.step("propose_plan", () => preview.propose(origin.id, parts));
  if (proposed.status !== "stored" && proposed.status !== "missing") throw new Error(`plan: ${JSON.stringify(proposed).slice(0, 2_000)}`);
  preview.planOutcome = proposed;
  for (const feature of running) {
    const scope = (feature.area as { scopes: string[] }).scopes[0] as string;
    const facts = proposed.status === "stored" ? proposed.plan.facts : proposed.facts;
    const breaks = facts.breaks.filter((each) => each.target === feature.id && each.scopeId === scope);
    const form = reviewForm(preview, breaks, scope, pins.fixes, fixOf(feature));
    await preview.step(`submit_review ${scope}`, () => preview.review(feature.id, origin.id, scope, form));
  }
  if (proposed.status !== "stored") return;
  // An author whose review stands with no exception approves; one with an exception decides in person.
  for (const part of proposed.plan.parts) {
    const exceptions = preview.reviews.list(origin.id).filter((review) => part.scopes.includes(review.scopeId)).flatMap((review) => review.exceptions);
    if (exceptions.length === 0) await preview.step(`approve ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId));
  }
}

interface LarderCommit {
  readonly source: string;
  readonly tag?: string;
  readonly fix?: { readonly scope: string; readonly kind: string };
}
interface LarderFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly agent: string;
  readonly commits: readonly LarderCommit[];
}

/**
 * Use case 4 (money in minor units) as docs/case-study-money.md runs it up to the requested revision:
 * every feature running at its first checkpoint, Hugo's same-area start approved, Ines's nine-scope plan
 * with a part for each affected reader, Rahul's tax review on the whole-order step and the mechanical
 * parts approved. Lena's stacking reached main before Ines opened, so it is not running.
 */
async function moneyMinorUnits(preview: PreviewProject): Promise<void> {
  const larder = JSON.parse(await readFile(join(ROOT, "examples", preview.fixture, "larder.json"), "utf8")) as {
    features: LarderFeature[];
    promotions: { feature: string }[];
    plan: { feature: string; parts: { scope: string; kind: string }[] };
  };
  const identities = identitiesOf(preview);
  preview.seedIdentities(identities);
  const handleOf = (feature: LarderFeature) => `@${feature.owner}/${feature.agent}`;
  const agentOf = (feature: LarderFeature) => identities.find((identity) => identity.handle === handleOf(feature)) as SeedIdentity;
  const promoted = new Set(larder.promotions.map((promotion) => promotion.feature));
  const origin = larder.features.find((feature) => feature.id === larder.plan.feature) as LarderFeature;
  // Every feature that started before the plan, the originating one last, so its overlap check finds the rest.
  const early = larder.features.filter((feature) => feature !== origin && !promoted.has(feature.id) && feature.role !== "late-starter");
  for (const feature of [...early, origin]) {
    const area = { scopes: agentOf(feature).charter_scopes };
    await preview.step(`open ${feature.id}`, () => preview.open(agentOf(feature), feature.id, area));
    const first = feature.commits[0]?.tag as string;
    await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, `feature-${feature.id}-${first}`));
  }
  // The same-area feature still running approves Ines's start.
  for (const lock of preview.overlaps.locksOn(origin.id)) {
    await preview.step(`approve start beside ${lock.featureId}`, () => preview.approveStart(lock.personId, lock.featureId, origin.id));
  }
  await preview.step("whats_near", () => preview.whatsNear(origin.id));
  if (preview.runnerTools) {
    await preview.step("impact", () => preview.runnerTool(origin.id, "impact"));
    await preview.step("check", () => preview.runnerTool(origin.id, "check"));
  }

  // A part per plan scope names the fix commit in Ines's fork; a part per reader carries its fork's
  // own fix as a patch against its checkpoint, limited to the reader's scopes.
  const scopeParts = larder.plan.parts.map((part) => ({
    place: { scope: part.scope },
    diff: { commit: preview.git("rev-parse", `feature-${origin.id}-fix-${part.scope}^{commit}`) },
  }));
  const readers = early.filter((feature) => feature.commits.some((commit) => commit.fix !== undefined) && feature.role !== "same-area");
  const readerParts = readers.map((feature) => {
    const head = preview.git("rev-parse", `feature-${feature.id}-${feature.commits[0]?.tag}^{commit}`);
    const paths = agentOf(feature).charter_scopes.flatMap((scope) => preview.scopeMap.scopes.get(scope)?.paths ?? []);
    const diff = preview.diff(head, `feature-${feature.id}`, paths);
    return { place: { feature: feature.id }, patch: { base: head, diff } };
  });
  let parts: unknown[] = [...scopeParts, ...readerParts];
  let proposed = await preview.step("propose_plan", () => preview.propose(origin.id, parts));
  // The facts decide the places: a part for a place they leave out is dropped, as the agent would.
  if (proposed.status === "missing") {
    const unaffected = new Set(proposed.missing.filter((item) => item.code === "not_affected").map((item) => JSON.stringify(item.place)));
    parts = parts.filter((part) => !unaffected.has(JSON.stringify((part as { place: unknown }).place)));
    proposed = await preview.step("propose_plan again", () => preview.propose(origin.id, parts));
  }
  // Over the break limit Penguin returns the plan to Ines. The fixture holds no smaller plan, so the
  // project raises its limit (PRD 13, decision 1) to the behavioural parts the returned plan counted,
  // and Ines's agent proposes the same parts again. The returned plan stays in Ines's inbox.
  if (proposed.status === "returned") {
    preview.breakLimit = proposed.behavioural.length;
    proposed = await preview.step("propose_plan at the project's raised break limit", () => preview.propose(origin.id, parts));
  }
  if (proposed.status !== "stored") throw new Error(`plan: ${JSON.stringify(proposed).slice(0, 3_000)}`);

  // The originating agent writes the fixes for code on main into its own fork, up to the step before
  // the first requested revision. The reviewing scope's agent reviews the fork at that checkpoint with
  // the fixture's whole-order form, whose rows name the scope's invariants.
  const revision = origin.commits.findIndex((commit) => commit.fix?.kind === "revision");
  const reviewed = origin.commits[revision - 1]?.tag as string;
  await preview.step(`checkpoint ${origin.id} ${reviewed}`, () => preview.checkpoint(origin.id, `feature-${origin.id}-${reviewed}`));
  const form = JSON.parse(await readFile(join(ROOT, "examples", preview.fixture, "reviews", "tax-whole-order.json"), "utf8")) as ReviewForm;
  const scope = invariantsOf(preview).find((invariant) => invariant.id === form.rows[0]?.invariant)?.scope as string;
  const reviewer = readers.find((feature) => agentOf(feature).charter_scopes.includes(scope)) as LarderFeature;
  await preview.step(`submit_review ${scope}`, () => preview.review(reviewer.id, origin.id, scope, { ...form, riskyInputs: form.riskyInputs ?? [], storedDataMarker: form.storedDataMarker ?? null }));
  // The owners of the scopes the fixture's plan fixes by codemod approve their parts once.
  const codemodded = new Set(larder.plan.parts.filter((part) => part.kind === "mechanical").map((part) => part.scope));
  for (const part of proposed.plan.parts.filter((each) => each.place.kind === "scope" && codemodded.has(each.place.scope))) {
    await preview.step(`approve ${part.partId}`, () => preview.decide(part.owner, origin.id, part.partId));
  }
  // The late starter opens after the plan was announced, at its first checkpoint.
  for (const feature of larder.features.filter((each) => each.role === "late-starter")) {
    await preview.step(`open ${feature.id}`, () => preview.open(agentOf(feature), feature.id, { scopes: agentOf(feature).charter_scopes }));
    await preview.step(`checkpoint ${feature.id}`, () => preview.checkpoint(feature.id, `feature-${feature.id}-${feature.commits[0]?.tag}`));
  }
}

/** Seeds `fixture`'s project through the ProjectAgent's modules and the check runner's programs. */
export async function seed(fixture: FixtureName, options: { readonly runnerTools?: boolean } = {}): Promise<PreviewProject> {
  const preview = await project(fixture);
  preview.runnerTools = options.runnerTools ?? true;
  if (fixture === "identity-unification") await featuresFixture(preview);
  else await moneyMinorUnits(preview);
  return preview;
}
