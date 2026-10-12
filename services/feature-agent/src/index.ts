import { Agent } from "agents";
import {
  ApprovedBranchStore,
  BlockStore,
  closeOut,
  collectReviews,
  durableObjectSql,
  fastForwardMain,
  FixReviewStore,
  HuddleThreadStore,
  parsePromotionTokenTtl,
  pendingApprovals,
  pendingVerifications,
  PlanStore,
  PROMOTION_TOKEN_TTL_MAX_MINUTES,
  recordApprovedBranch,
  recordVerification,
  reportBlockRun,
  runIdBaseOf,
  scheduleVerification,
  VerificationStore,
  type ApprovalOutcome,
  type ApprovalSpec,
  type BlockOpenOutcome,
  type BlockProjectPort,
  type BlockReportResult,
  type BlockRun,
  type BlockRunInput,
  type BridgeCaller,
  type CloseOutcome,
  type FastForwardOutcome,
  type FeatureBlocks,
  type FixWrite,
  type Huddle,
  type HuddleCloseDeps,
  type HuddleClosePort,
  type HuddleCloser,
  type HuddleReviewDeps,
  type HuddleReviewer,
  type HuddleThread,
  type HuddleThreadKeeper,
  type HuddleVerifier,
  type HuddleVerifyDeps,
  type PartVersion,
  type Plan,
  type PlanKeeper,
  type PlanPart,
  type PendingVerification,
  type ReviewCollection,
  type VerificationOutcome,
  type VerificationScheduleOutcome,
} from "@penguin/project-agent";
import type { BlockRunRequest, Promotion } from "@penguin/protocol";

/** The Worker's configuration a FeatureAgent reads. */
interface FeatureAgentEnv {
  readonly PENGUIN_PROMOTION_TOKEN_TTL_MINUTES?: string;
}

/** The project's repos a promotion names, with the deployment's prefix. */
export interface PromotionRepos {
  /** The base repo, whose main branch the promotion moves. */
  readonly base: string;
  /** The deployment's repo prefix, which leads every fork's Artifacts name. */
  readonly prefix: string;
}

/**
 * One feature's coordination state (PRD 0.4 section 8): its merge plan and the approval of each part
 * (plan-store.ts, decided on the ProjectAgent through plan-approval.ts), the fixes written into
 * affected forks (fix-write.ts), the block runs that check the feature merged onto main and every
 * running fork (block-store.ts), and the promotion that moves main (block-land.ts, main-push.ts). The
 * ProjectAgent names one instance per feature, `<project>-feature-<id>`, checks and signs every
 * record, and holds the service key; this agent keeps the rows and runs the promotion.
 *
 * The check runner's block reports reach this agent directly through the Worker, with a port back to
 * the ProjectAgent for signing, the promotion slot and the feature's state. A passing land run is
 * promoted here: the agent mints a write token on the base repo for minutes and a read token on the
 * feature's fork, moves main in one push, revokes both tokens and then every write token on the
 * fork. No token it mints leaves this agent, and none is logged.
 *
 * The same class, named `<project>-huddle-<issue>`, still runs the verification and review loop of a
 * Huddle issue opened from an owner fork's combined run (PRD 0.3's flow): it schedules, coalesces and
 * supersedes the Huddle's verification runs, collects the reviews of its fixes (huddle-reviews.ts),
 * keeps its threads (huddle-threads.ts) and evaluates its close (huddle-close.ts). A feature's results
 * never open a Huddle; its block replaces the Huddle flow (PRD 0.4 section 4.5).
 */
export class FeatureAgent extends Agent implements HuddleVerifier, HuddleReviewer, HuddleThreadKeeper, HuddleCloser, PlanKeeper, FeatureBlocks {
  #runs: VerificationStore | undefined;
  #reviews: FixReviewStore | undefined;
  #threads: HuddleThreadStore | undefined;
  #approvals: ApprovedBranchStore | undefined;
  #plans: PlanStore | undefined;
  #blocks: BlockStore | undefined;
  /** Huddle steps run one at a time, so no two interleave their writes. */
  #steps: Promise<unknown> = Promise.resolve();

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)`;
  }

  /** POST increments the counter; any other method reads it. */
  override onRequest(request: Request): Response {
    if (request.method === "POST") {
      this.sql`UPDATE counter SET value = value + 1 WHERE id = 1`;
    }
    const [row] = this.sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
    return Response.json({ agent: "FeatureAgent", name: this.name, counter: row?.value ?? 0 });
  }

  // The merge plan (plan-store.ts).

  /** The feature's newest plan version, or 0; see plan-store.ts. */
  planVersion(featureId: string): number {
    return this.#planStore().planVersion(featureId);
  }

  /** Keeps a plan the ProjectAgent signed, with every part; false when that version exists. */
  keepPlan(plan: Plan): boolean {
    return this.#planStore().keepPlan(plan);
  }

  /** The feature's newest plan with its parts, or undefined. */
  latestPlan(featureId: string): Plan | undefined {
    return this.#planStore().latestPlan(featureId);
  }

  /** Replaces one part of the newest plan while it stands at `expected`; see plan-store.ts. */
  replacePart(featureId: string, part: PlanPart, expected: PartVersion): boolean {
    return this.#planStore().replacePart(featureId, part, expected);
  }

  /** Adds the next part to the newest plan, `planId`; see plan-store.ts. */
  addPart(featureId: string, planId: string, part: PlanPart): boolean {
    return this.#planStore().addPart(featureId, planId, part);
  }

  /** Keeps one fix written into an affected fork (`FixWrite`); false when that revision has one. */
  keepFixWrite(write: FixWrite): boolean {
    return this.#planStore().keepFixWrite(write);
  }

  /** The fixes written for the feature's plan parts, oldest first. */
  fixWrites(featureId: string): FixWrite[] {
    return this.#planStore().fixWrites(featureId);
  }

  // The block and its promotion (block-store.ts, block-land.ts).

  /** Opens the feature's next block run; a land run in progress answers `busy`. */
  openBlockRun(input: BlockRunInput): BlockOpenOutcome {
    return this.#blockStore().open(input);
  }

  /** Hands a runner the waiting runs; `waiting` stays true while any run is pending or claimed. */
  claimBlockRuns(runnerId: string): { readonly runs: readonly BlockRunRequest[]; readonly waiting: boolean } {
    const runs = this.#blockStore().claim(runnerId);
    return { runs, waiting: this.#blockStore().hasWaiting() };
  }

  /**
   * Records the runner's report of a block run, and promotes main when a land run passed. `port`
   * reaches the ProjectAgent; `repos` names the base repo and the deployment's prefix.
   */
  reportBlockRun(caller: BridgeCaller, runId: string, body: unknown, port: BlockProjectPort, repos: PromotionRepos): Promise<BlockReportResult> {
    return reportBlockRun(
      {
        store: this.#blockStore(),
        fixWrites: (featureId) => this.#planStore().fixWrites(featureId),
        port,
        push: (run) => this.#pushMain(run, repos),
        seal: (run) => this.#seal(`${repos.prefix}${run.request.fork}`),
      },
      caller,
      runId,
      body,
    );
  }

  /** The feature's newest block runs, newest first, and its promotion. */
  landing(featureId: string): { readonly runs: BlockRun[]; readonly promotion: Promotion | null } {
    return { runs: this.#blockStore().runs(featureId, 10), promotion: this.#blockStore().promotion(featureId) ?? null };
  }

  /**
   * Moves main to the run's checkpoint: a write token on the base repo and a read token on the
   * feature's fork, each for PENGUIN_PROMOTION_TOKEN_TTL_MINUTES, one push, then both revoked.
   */
  async #pushMain(run: BlockRun, repos: PromotionRepos): Promise<FastForwardOutcome> {
    const ttl = parsePromotionTokenTtl((this.env as unknown as FeatureAgentEnv).PENGUIN_PROMOTION_TOKEN_TTL_MINUTES);
    if (ttl === undefined) {
      return { status: "failed", reason: `PENGUIN_PROMOTION_TOKEN_TTL_MINUTES must be a whole number of minutes from 1 to ${PROMOTION_TOKEN_TTL_MAX_MINUTES}`, head: null, durationMs: 0 };
    }
    const base = await this.env.ARTIFACTS.get(repos.base);
    const fork = await this.env.ARTIFACTS.get(`${repos.prefix}${run.request.fork}`);
    const minted: { repo: ArtifactsRepo; id: string }[] = [];
    try {
      const [write, read, baseInfo, forkInfo] = await Promise.all([base.createToken("write", ttl), fork.createToken("read", ttl), base.info(), fork.info()]);
      minted.push({ repo: base, id: write.id }, { repo: fork, id: read.id });
      return await fastForwardMain({
        source: { remote: forkInfo.remote, token: read.plaintext },
        target: { remote: baseInfo.remote, token: write.plaintext },
        branch: run.request.branch,
        before: run.mainBefore,
        after: run.checkpoint,
      });
    } finally {
      // Each token is revoked by its id; a revocation that fails still expires with the token's TTL.
      await Promise.allSettled(minted.map(({ repo, id }) => repo.revokeToken(id)));
      base[Symbol.dispose]();
      fork[Symbol.dispose]();
    }
  }

  /** Revokes every active write token on `repoName`, so the landed fork refuses pushes (PRD 4.5 step 5). */
  async #seal(repoName: string): Promise<number> {
    const repo = await this.env.ARTIFACTS.get(repoName);
    try {
      const { tokens } = await repo.listTokens();
      const writes = tokens.filter((token) => token.scope === "write" && token.state === "active");
      const revoked = await Promise.all(writes.map((token) => repo.revokeToken(token.id)));
      return revoked.filter(Boolean).length;
    } finally {
      repo[Symbol.dispose]();
    }
  }

  // An owner-fork Huddle (PRD 0.3's flow, kept for owner forks only).

  /**
   * Schedules a run when an owner in the Huddle has a newer checkpoint; see huddle-verify.ts. A
   * scheduled run supersedes the checks, so the close is evaluated again.
   */
  scheduleVerification(huddle: Huddle, project: HuddleClosePort): Promise<VerificationScheduleOutcome | undefined> {
    return this.#step(async () => {
      if (huddle.issueId === null) return undefined;
      const outcome = await scheduleVerification(this.#deps(huddle.issueId, project), huddle);
      if (outcome?.status === "scheduled") await this.#closeOut(huddle, project);
      return outcome;
    });
  }

  /** The Huddle's runs waiting for the runner, oldest first. */
  pendingVerifications(huddle: Huddle): PendingVerification[] {
    if (huddle.issueId === null) return [];
    return pendingVerifications(this.#runStore(huddle.issueId), huddle);
  }

  /**
   * Records a runner's report of the Huddle's run `runId` (see huddle-verify.ts). A report that moves
   * the Huddle to IN_REVIEW then collects its fixes' reviews, and any recorded report evaluates the
   * close; a failure there is logged and leaves the report recorded, and the next review or report
   * collects again.
   */
  reportVerification(
    huddle: Huddle,
    runId: string,
    runnerId: string,
    report: unknown,
    project: HuddleClosePort,
  ): Promise<VerificationOutcome> {
    return this.#step(async () => {
      if (huddle.issueId === null) {
        return { status: "rejected", reason: "not_found", message: `no verification run ${runId}` };
      }
      const outcome = await recordVerification(this.#deps(huddle.issueId, project), huddle, runId, runnerId, report);
      if (outcome.status === "recorded" && outcome.state === "in_review") {
        try {
          await collectReviews(this.#reviewDeps(huddle.issueId, project), huddle);
        } catch (error) {
          console.error(JSON.stringify({ event: "review_collection_failed", issue: huddle.issueId, error: String(error) }));
        }
      }
      if (outcome.status === "recorded") await this.#closeOut(huddle, project);
      return outcome;
    });
  }

  /** Collects the reviews of the Huddle's fixes (huddle-reviews.ts), then evaluates the close. */
  collectReviews(huddle: Huddle, project: HuddleClosePort): Promise<ReviewCollection | undefined> {
    return this.#step(async () => {
      if (huddle.issueId === null) return undefined;
      const collection = await collectReviews(this.#reviewDeps(huddle.issueId, project), huddle);
      await this.#closeOut(huddle, project);
      return collection;
    });
  }

  /**
   * Every thread on the Huddle issue and its fix sub-issues, as of the Huddle's last review
   * collection or close evaluation, open or resolved; see huddle-threads.ts.
   */
  threads(huddle: Huddle): HuddleThread[] {
    if (huddle.issueId === null) return [];
    return this.#threadStore().all();
  }

  /** Evaluates the Huddle's close; see huddle-close.ts. */
  closeOut(huddle: Huddle, project: HuddleClosePort): Promise<CloseOutcome | undefined> {
    return this.#step(async () => {
      if (huddle.issueId === null) return undefined;
      return closeOut(this.#closeDeps(huddle.issueId, project), huddle);
    });
  }

  /** The Huddle's approved-branch request waiting for the runner, if any. */
  pendingApprovals(huddle: Huddle): ApprovalSpec[] {
    return pendingApprovals(this.#approvalStore(), huddle);
  }

  /** Records the runner's report of the Huddle's approved branch, then evaluates the close. */
  reportApprovedBranch(huddle: Huddle, runnerId: string, report: unknown, project: HuddleClosePort): Promise<ApprovalOutcome> {
    return this.#step(async () => {
      if (huddle.issueId === null) {
        return { status: "rejected", reason: "not_found", message: `no approved branch is requested for ${huddle.triggerCommit}` };
      }
      return recordApprovedBranch(this.#closeDeps(huddle.issueId, project), huddle, runnerId, report);
    });
  }

  #planStore(): PlanStore {
    this.#plans ??= new PlanStore(durableObjectSql(this.ctx.storage));
    return this.#plans;
  }

  #blockStore(): BlockStore {
    this.#blocks ??= new BlockStore(durableObjectSql(this.ctx.storage));
    return this.#blocks;
  }

  /** Evaluates the close after another step; a failure is logged, and the next step evaluates again. */
  async #closeOut(huddle: Huddle, project: HuddleClosePort): Promise<void> {
    if (huddle.issueId === null) return;
    try {
      await closeOut(this.#closeDeps(huddle.issueId, project), huddle);
    } catch (error) {
      console.error(JSON.stringify({ event: "close_out_failed", issue: huddle.issueId, error: String(error) }));
    }
  }

  #step<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#steps.then(step);
    this.#steps = run.catch(() => undefined);
    return run;
  }

  #deps(issueId: string, project: HuddleClosePort): HuddleVerifyDeps {
    return {
      runs: this.#runStore(issueId),
      issue: (id) => project.issue(id),
      submit: (operation) => project.submit(operation),
      ownerFork: (ownerId) => project.ownerFork(ownerId),
    };
  }

  #reviewDeps(issueId: string, project: HuddleClosePort): HuddleReviewDeps {
    return {
      ...this.#deps(issueId, project),
      reviews: this.#reviewStore(),
      threads: this.#threadStore(),
      scopeMap: () => project.scopeMap(),
      requestReview: (ownerId, subIssueId) => project.requestReview(ownerId, subIssueId),
      recordApproval: (subIssueId, approval) => project.recordApproval(subIssueId, approval),
    };
  }

  #closeDeps(issueId: string, project: HuddleClosePort): HuddleCloseDeps {
    return {
      ...this.#reviewDeps(issueId, project),
      approvals: this.#approvalStore(),
      recordCloseOut: (id, waitingOn) => project.recordCloseOut(id, waitingOn),
    };
  }

  #reviewStore(): FixReviewStore {
    this.#reviews ??= new FixReviewStore(durableObjectSql(this.ctx.storage));
    return this.#reviews;
  }

  #threadStore(): HuddleThreadStore {
    this.#threads ??= new HuddleThreadStore(durableObjectSql(this.ctx.storage));
    return this.#threads;
  }

  #approvalStore(): ApprovedBranchStore {
    this.#approvals ??= new ApprovedBranchStore(durableObjectSql(this.ctx.storage));
    return this.#approvals;
  }

  /** The Huddle's runs, numbered in the Huddle issue's own range so run IDs stay unique in the project. */
  #runStore(issueId: string): VerificationStore {
    this.#runs ??= new VerificationStore(durableObjectSql(this.ctx.storage), { runIdBase: runIdBaseOf(issueId) });
    return this.#runs;
  }
}
