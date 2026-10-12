import { Agent } from "agents";
import {
  ApprovedBranchStore,
  closeOut,
  collectReviews,
  durableObjectSql,
  FixReviewStore,
  HuddleThreadStore,
  pendingApprovals,
  pendingVerifications,
  PlanStore,
  recordApprovedBranch,
  recordVerification,
  runIdBaseOf,
  scheduleVerification,
  VerificationStore,
  type ApprovalOutcome,
  type ApprovalSpec,
  type CloseOutcome,
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


/**
 * Runs the verification and review loop of one Huddle issue (PRD section 5): it schedules, coalesces
 * and supersedes the Huddle's verification runs and records their results, once the combined tests
 * pass it collects the reviews of the Huddle's fixes (huddle-reviews.ts), where a counting review
 * that requests changes opens a thread on its fix (huddle-threads.ts). After each step it evaluates
 * the close (huddle-close.ts): once every fix is approved, the tests pass and every thread is
 * resolved, it has the runner record the Huddle repo's `approved` branch and closes the issue. It
 * keeps the runs, each fix's review standing, the Huddle's threads and the approved-branch request
 * in its own SQLite. The
 * ProjectAgent names one instance per Huddle issue and passes the Huddle record with each call, with
 * a port back to itself: the HuddleAgent reads the issue, owner forks and scope map there and writes
 * its operations, review requests, approvals and close-out there, where the service key signs the
 * operations and the index validates them. A CryptoKey cannot cross Durable Object RPC, so the
 * signing stays on the ProjectAgent's side.
 *
 * An instance named for a feature instead keeps that feature's merge plans, their parts and the fixes
 * written for them into affected forks
 * (plan-store.ts, PRD 0.4 section 9), until the FeatureAgent takes them over (#96). The ProjectAgent
 * checks and signs each plan before this instance keeps it.
 */
export class HuddleAgent extends Agent implements HuddleVerifier, HuddleReviewer, HuddleThreadKeeper, HuddleCloser, PlanKeeper {
  #runs: VerificationStore | undefined;
  #reviews: FixReviewStore | undefined;
  #threads: HuddleThreadStore | undefined;
  #approvals: ApprovedBranchStore | undefined;
  #plans: PlanStore | undefined;
  /** Steps run one at a time, so no two interleave their writes. */
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
    return Response.json({ agent: "HuddleAgent", name: this.name, counter: row?.value ?? 0 });
  }

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

  #planStore(): PlanStore {
    this.#plans ??= new PlanStore(durableObjectSql(this.ctx.storage));
    return this.#plans;
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
