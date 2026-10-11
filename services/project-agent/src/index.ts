import { Agent, getAgentByName, type Connection, type ConnectionContext } from "agents";

import {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type BridgeCaller,
  type HuddleLookup,
  type IndexListener,
  type IssueChange,
  type OperationKeys,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SqlValue,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
import { readBaseFile } from "./base-repo.ts";
import { buildBoard } from "./board.ts";
import { buildIssuePage } from "./issue-page.ts";
import { LiveFeed, liveOwner, sendToOwner } from "./live-feed.ts";
import { buildInbox } from "./inbox-page.ts";
import {
  buildIdentitiesPage,
  identityWriteOutcome,
  PAGE_OPERATIONS_PER_IDENTITY,
  PAGE_SESSIONS_PER_IDENTITY,
} from "./identities-page.ts";
import { InboxStore, parseOverlapRef, type InboxItem, type InboxOutcome, type InboxReason } from "./inbox-store.ts";
import { McpTokenStore, type IssuedMcpToken, type McpCaller } from "./mcp-tokens.ts";
import {
  OwnerForkStore,
  recordReportedCheckpoint,
  reportCheckpoint,
  type CheckpointOutcome,
  type CheckpointRecordDeps,
  type OwnerFork,
  type SessionCheckpointOutcome,
} from "./owner-forks.ts";
import { postSessionUpdate, type SessionUpdate, type SessionUpdateOutcome } from "./session-updates.ts";
import { openHuddle, type HuddleOpenOutcome } from "./huddle-open.ts";
import {
  checkpointBaseline,
  checkpointChange,
  CombinedRunStore,
  scheduleCombinedRuns,
  type ClaimListing,
} from "./combined-run-schedule.ts";
import {
  declareArea,
  featureTokenGrant,
  openFeature,
  recordFeatureRepo,
  reportFeatureCheckpoint,
  type FeatureCheckpointOutcome,
  type FeatureDeps,
  type FeatureOpenInput,
  type FeatureOpenOutcome,
  type FeatureOutcome,
  type TokenGrant,
} from "./feature-open.ts";
import { FeatureStore, signFeatureRecord, type Feature } from "./feature-store.ts";
import {
  approveOverlap,
  checkOverlap,
  settledForSession,
  OverlapStore,
  type ApproveOutcome,
  type OverlapDeps,
  type OverlapLock,
  type OverlapStatus,
} from "./overlap-lock.ts";
import { HuddleStore, type Huddle } from "./huddle-store.ts";
import { fixTask, type FixTask } from "./fix-task.ts";
import {
  huddlesOf,
  unknownVerification,
  type HuddleProjectPort,
  type HuddleVerifier,
  type PendingVerification,
  type VerificationScheduleOutcome,
  type VerificationOutcome,
} from "./huddle-verify.ts";
import { dropProjectVerificationTable, huddleIssueOfRun } from "./verification-store.ts";
import { reassignUpstream } from "./upstream.ts";
import { IngestLedger, ingestPush, type IngestReport } from "./push-ingest.ts";
import { rebuildIndex, type RebuildReport } from "./rebuild.ts";
import { OWNERS_PATH, parseOwnersFile, parseScopeFile, SCOPE_MAP_PATH } from "./scope-file.ts";
import { ReviewStore, submitReview, type ReviewInput, type ReviewOutcome, type StoredReview } from "./review-submit.ts";
import { claimReviews, recordReview, type ReviewClaim, type ReviewReportOutcome } from "./review-record.ts";
import { CloseOutStore, FixApprovalStore } from "./approval-store.ts";
import type { HuddleReviewer, ReviewCollection } from "./huddle-reviews.ts";
import type { HuddleThread, HuddleThreadKeeper } from "./huddle-threads.ts";
import {
  CLOSE_RECORDED_REJECTIONS,
  type ApprovalOutcome,
  type HuddleClosePort,
  type HuddleCloser,
} from "./huddle-close.ts";
import {
  IdentityStore,
  type Identity,
  type IdentityChanges,
  type IdentityInput,
  type IdentityOutcome,
  type TeamIdentityInput,
} from "./identity-store.ts";
import { importServiceKey, type ServiceKey } from "./service-key.ts";
import { scheduleSweep } from "./session-sweep.ts";
import {
  SESSION_OFFLINE_AFTER_MS,
  SessionStore,
  threadRefs,
  type AcceptOutcome,
  type AssignmentRoute,
  type Delivery,
  type OwnerRequest,
  type Session,
  type SessionInput,
  type SessionOutcome,
  type SessionWork,
} from "./session-store.ts";
import type { Delegates, FixLookup, IssueRecord, ReduceRejectReason, RejectReason, Thread } from "@penguin/issues";
import {
  identitiesChangedMessage,
  inboxChangedMessage,
  parseCombinedRunEvent,
  type ApprovalSpec,
  type Author,
  type BlockCheck,
  type Board,
  type IdentitiesPage,
  type IdentityWriteOutcome,
  type Inbox,
  type IssuePage,
  type OverlapRequests,
  type VerificationRunSpec,
} from "@penguin/protocol";
import { INVARIANTS_PATH, type ScopeMap } from "@penguin/scope-map";

import {
  BridgeRegistry,
  type BridgeIdentity,
  type BridgeRole,
  type RegisterOutcome,
  type RegistrationCode,
} from "./bridge-registry.ts";

export {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type AssignmentListener,
  type BridgeCaller,
  type IdentitySource,
  type IndexListener,
  type IssueChange,
  type OperationKeys,
  type PendingFile,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SubmitInput,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
export {
  IDENTITY_LIMITS,
  IdentityStore,
  type Avatar,
  type AvatarMediaType,
  type Identity,
  type IdentityChanges,
  type IdentityInput,
  type IdentityOutcome,
  type IdentityRejectReason,
  type TeamIdentityInput,
} from "./identity-store.ts";
export { buildBoard, type BoardSources } from "./board.ts";
export { buildIssuePage, issueView, type IssuePageSources } from "./issue-page.ts";
export { LIVE_OWNER_HEADER, LiveFeed, liveOwner, sendToOwner, type OwnedConnection } from "./live-feed.ts";
export { buildInbox, type InboxPageSources } from "./inbox-page.ts";
export {
  avatarUrl,
  buildIdentitiesPage,
  identityWriteOutcome,
  PAGE_OPERATIONS_PER_IDENTITY,
  PAGE_SESSIONS_PER_IDENTITY,
  type IdentitiesPageSources,
} from "./identities-page.ts";
export { McpTokenStore, type IssuedMcpToken, type McpCaller } from "./mcp-tokens.ts";
export {
  CHECKPOINT_SHA_PATTERN,
  OwnerForkStore,
  recordReportedCheckpoint,
  reportCheckpoint,
  type CheckpointDeps,
  type CheckpointOutcome,
  type CheckpointRecordDeps,
  type OwnerFork,
  type SessionCheckpointOutcome,
} from "./owner-forks.ts";
export {
  postSessionUpdate,
  SESSION_UPDATE_TYPES,
  type SessionUpdate,
  type SessionUpdateDeps,
  type SessionUpdateOutcome,
  type SessionUpdateType,
} from "./session-updates.ts";
export { importServiceKey, type ServiceKey } from "./service-key.ts";
export {
  fixAssignee,
  fixesOf,
  HUDDLE_LABEL,
  openHuddle,
  UNASSIGNED_IMPACT_ANCHOR,
  type Fix,
  type HuddleDraft,
  type HuddleOpenDeps,
  type HuddleOpenOutcome,
} from "./huddle-open.ts";
export { HuddleStore, ownerCommit, type Huddle, type HuddleStatus } from "./huddle-store.ts";
export {
  declareArea,
  FEATURE_REPO_PATTERN,
  featureTokenGrant,
  openFeature,
  recordCheckpointArea,
  recordFeatureRepo,
  reportFeatureCheckpoint,
  type CheckpointAreaOutcome,
  type CheckpointReader,
  type FeatureCheckpointDeps,
  type FeatureCheckpointOutcome,
  type FeatureDeps,
  type FeatureOpenInput,
  type FeatureOpenOutcome,
  type FeatureOutcome,
  type FeatureRejection,
  type FeatureRejectReason,
  type TokenGrant,
} from "./feature-open.ts";
export {
  EMPTY_AREA,
  extendArea,
  FEATURE_LIMITS,
  featureRecordPath,
  FeatureStore,
  parseArea,
  parseAreaPath,
  parseFeatureId,
  signFeatureRecord,
  type Feature,
  type FeatureArea,
  type FeatureRecord,
  type FeatureRecordType,
  type FeatureState,
  type StoredFeatureRecord,
  type UnsignedFeatureRecord,
} from "./feature-store.ts";
export {
  REVIEW_CLAIM_LIMIT,
  REVIEW_LEASE_MS,
  REVIEW_TABLE_SCHEMA,
  ReviewStore,
  submitReview,
  type ReviewClaimListing,
  type ReviewCompletion,
  type ReviewDeps,
  type ReviewInput,
  type ReviewOutcome,
  type ReviewState,
  type StoredReview,
} from "./review-submit.ts";
export {
  claimReviews,
  recordReview,
  type ClaimedReview,
  type ReviewClaim,
  type ReviewRecordDeps,
  type ReviewReportOutcome,
} from "./review-record.ts";
export {
  approveOverlap,
  checkOverlap,
  findOverlaps,
  footprint,
  OVERLAP_LIMITS,
  OVERLAP_SCHEMA,
  overlapOf,
  OverlapStore,
  planCheck,
  RUNNING_STATES,
  settledForSession,
  type ApproveOutcome,
  type FeatureDependent,
  type Overlap,
  type OverlapDeps,
  type OverlapFindings,
  type OverlapListener,
  type OverlapLock,
  type OverlapLockState,
  type OverlapPlan,
  type OverlapStatus,
  type OwnOverlap,
  type SettledLock,
} from "./overlap-lock.ts";
export { fixTask, type FailingTest, type FixTask } from "./fix-task.ts";
export {
  changedPaths,
  checkpointBaseline,
  checkpointChange,
  CombinedRunStore,
  scheduleCombinedRuns,
  type ClaimListing,
  type CombinedRun,
  type CombinedRunStatus,
  type CombinedRunStoreOptions,
  type RepoHistoryReader,
  type ScheduleDeps,
  type ScheduleOutcome,
} from "./combined-run-schedule.ts";
export {
  huddlesOf,
  initialCheckpoints,
  pendingVerifications,
  recordVerification,
  scheduleVerification,
  unknownVerification,
  verificationPlan,
  verificationSpecs,
  type HuddleProjectPort,
  type HuddleVerifier,
  type HuddleVerifyDeps,
  type PendingVerification,
  type VerificationScheduleOutcome,
  type VerificationOutcome,
  type VerificationPlan,
} from "./huddle-verify.ts";
export {
  collectReviews,
  FIX_REVIEW_SCHEMA,
  FixReviewStore,
  type FixReview,
  type HuddleReviewDeps,
  type HuddleReviewer,
  type HuddleReviewPort,
  type ReviewCollection,
} from "./huddle-reviews.ts";
export {
  assigneeOwner,
  HUDDLE_THREAD_SCHEMA,
  HuddleThreadStore,
  reviewThreadsDue,
  type HuddleThread,
  type HuddleThreadKeeper,
  type ReviewThreadDraft,
} from "./huddle-threads.ts";
export { CLOSE_OUT_SCHEMA, CloseOutStore, FIX_APPROVAL_SCHEMA, FixApprovalStore } from "./approval-store.ts";
export {
  APPROVED_BRANCH_SCHEMA,
  ApprovedBranchStore,
  closeOut,
  huddleOpenThreads,
  pendingApprovals,
  recordApprovedBranch,
  type ApprovalOutcome,
  type ApprovedBranchRequest,
  type CloseOutcome,
  type HuddleCloseDeps,
  type HuddleClosePort,
  type HuddleCloser,
} from "./huddle-close.ts";
export type { ApprovalSpec } from "@penguin/protocol";
export {
  dropProjectVerificationTable,
  huddleIssueOfRun,
  runIdBaseOf,
  RUNS_PER_HUDDLE,
  sameCheckpoints,
  VerificationStore,
  type VerificationRun,
  type VerificationStatus,
  type VerificationStoreOptions,
} from "./verification-store.ts";
export {
  reassignUpstream,
  upstreamAssignee,
  upstreamOwner,
  UPSTREAM_RECORDED_REJECTIONS,
  type Reassignment,
  type ReassignDeps,
} from "./upstream.ts";
export {
  INBOX_REASONS,
  InboxStore,
  overlapRef,
  parseOverlapRef,
  type InboxItem,
  type InboxOutcome,
  type InboxReason,
  type InboxStoreOptions,
} from "./inbox-store.ts";
export type { IngestReport } from "./push-ingest.ts";
export type { IndexComparison, RebuildReport, RowDifference, TableComparison } from "./rebuild.ts";
export {
  SESSION_LIMITS,
  SESSION_OFFLINE_AFTER_MS,
  SessionStore,
  threadRefs,
  type AcceptOutcome,
  type AssignmentRoute,
  type CheckpointDelivery,
  type Delivery,
  type OwnerRequest,
  type OwnerRequestKind,
  type Session,
  type SessionInput,
  type SessionOutcome,
  type SessionRejectReason,
  type SessionListener,
  type SessionStatus,
  type SessionStoreOptions,
  type SessionWork,
  type StartRequestListener,
  type ThreadRef,
} from "./session-store.ts";

/**
 * The Worker settings this class reads that `wrangler types` does not list: the signing key is a
 * secret, and the offline window is an optional variable.
 */
interface ProjectAgentEnv {
  readonly PENGUIN_OP_SIGNING_KEY?: string;
  /** Seconds without a heartbeat before a session goes offline. Defaults to SESSION_OFFLINE_AFTER_MS. */
  readonly PENGUIN_SESSION_OFFLINE_SECONDS?: string;
}
export {
  BRIDGE_ROLES,
  BridgeRegistry,
  type BridgeIdentity,
  type BridgeRole,
  type RegisterOutcome,
  type RegisteredBridge,
  type RegistrationCode,
} from "./bridge-registry.ts";

/** What review rights are judged by: the base repo's scope map and each owner's delegate. */
export interface ReviewRules {
  readonly scopeMap: ScopeMap;
  readonly delegates: Delegates;
}

/** The project's repos the agent reads, named by the Worker from its configuration. */
export interface ProjectRepos {
  /** The issues repo, which holds the operation log. */
  readonly issues: string;
  /** The base repo, whose `penguin/scopes.json` and `penguin/owners.json` decide review rights. */
  readonly base: string;
}

/**
 * An operation handed to the agent directly. A CryptoKey cannot cross Durable Object RPC
 * (`wrangler dev` 4.149.0: "DataCloneError: Could not serialize object of type CryptoKey"), so the
 * agent loads the keys itself.
 */
export type OperationInput = Omit<ApplyInput, "keys">;

/** A push to the issues repo's main branch, taken from a `cf.artifacts.repo.pushed` event. */
export interface IssuesPush {
  readonly before: string;
  readonly after: string;
}

export type IngestResult = IngestReport & { readonly durationMs: number };

/**
 * Holds the project-wide state: issue index, scope map, owners, identities, sessions and inboxes.
 * It opens Huddle issues and hands each Huddle's verification loop to that Huddle's HuddleAgent.
 * It keeps a counter in its SQL storage beside the issue index.
 */
export class ProjectAgent extends Agent {
  #sql: SqlDatabase | undefined;
  #issues: IssueIndex | undefined;
  #identities: IdentityStore | undefined;
  #sessions: SessionStore | undefined;
  #inbox: InboxStore | undefined;
  #serviceKey: Promise<ServiceKey> | undefined;
  #bridges: BridgeRegistry | undefined;
  #mcpTokens: McpTokenStore | undefined;
  #forks: OwnerForkStore | undefined;
  #featureRows: FeatureStore | undefined;
  #reviewRows: ReviewStore | undefined;
  #overlapRows: OverlapStore | undefined;
  /** Overlap checks and approvals run one at a time, so no two race for a record's sequence number. */
  #lockSteps: Promise<unknown> = Promise.resolve();
  #ledger: IngestLedger | undefined;
  #live: LiveFeed | undefined;
  /** Ingests run one at a time, so two pushes never interleave their walks and applies. */
  #ingests: Promise<unknown> = Promise.resolve();
  #huddles: HuddleStore | undefined;
  #combinedRuns: CombinedRunStore | undefined;
  /** Huddle openings and verification steps run one at a time, so no two interleave their writes. */
  #huddleSteps: Promise<unknown> = Promise.resolve();
  #approvals: FixApprovalStore | undefined;
  #closeOuts: CloseOutStore | undefined;
  /**
   * Fix sub-issues whose reviews, linked commits, labels or threads, and Huddle issues whose threads,
   * an applied operation changed since their Huddles last collected reviews; see
   * `#collectChangedReviews`.
   */
  #reviewsChanged = new Set<string>();

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)`;
    // Verification runs are kept by each Huddle's HuddleAgent; an empty table left from before goes.
    if (dropProjectVerificationTable(this.#database()) === "kept") {
      console.error(JSON.stringify({ event: "project_verification_runs_kept" }));
    }
  }

  /** POST increments the counter; any other method reads it. */
  override onRequest(request: Request): Response {
    if (request.method === "POST") {
      this.sql`UPDATE counter SET value = value + 1 WHERE id = 1`;
    }
    const [row] = this.sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
    return Response.json({ agent: "ProjectAgent", name: this.name, counter: row?.value ?? 0 });
  }

  /**
   * Accepts a dashboard's WebSocket, which the Worker forwards only for a signed-in person and
   * names that person in LIVE_OWNER_HEADER. Any other connection, such as one through the
   * local-development agent route, is closed. The owner is kept on the connection, which survives
   * hibernation.
   */
  override onConnect(connection: Connection, context: ConnectionContext): void {
    const owner = liveOwner(context.request);
    if (owner === undefined) {
      connection.close(1008, "sign in on the dashboard");
      return;
    }
    connection.setState({ owner });
  }

  /**
   * Applies an operation a signed-in person wrote on the dashboard, with that person as author.
   * `owner` is the person the Worker's session names; the operation cannot name anyone else.
   */
  async submitFromDashboard(owner: string, operation: unknown, repos: ProjectRepos): Promise<SubmitOutcome> {
    const rules = await this.#reviewRules(repos);
    const outcome = await this.submit(operation, { person: owner }, "dashboard", rules, CLOSE_RECORDED_REJECTIONS);
    await this.#collectChangedReviews(repos);
    return outcome;
  }

  /**
   * Opens the Huddle issue for a combined run the integration runner reports (see huddle-open.ts),
   * or answers `existing` when one is already open for the same trigger. `triggerFork` is the
   * Artifacts repo name of the trigger owner's fork, named by the Worker; the trigger commit must be
   * there. Openings run one at a time, so two reports of one trigger never open two issues.
   *
   * A report that is not rejected also completes the scheduled combined runs it answers, so a
   * passing run is recorded as passed and opens nothing.
   */
  openHuddle(event: unknown, triggerFork: string, repos: ProjectRepos): Promise<HuddleOpenOutcome> {
    return this.#huddleStep(async () => {
      const rules = await this.#reviewRules(repos);
      const index = this.#index();
      const sessions = this.#sessionStore();
      const outcome = await openHuddle(
        {
          huddles: this.#huddleStore(),
          scopeMap: rules.scopeMap,
          issue: (issueId) => index.issue(issueId),
          issueIds: () => index.ids(),
          submit: (operation) => this.submit(operation, { penguin: true }, "penguin", rules),
          ownerFork: (ownerId) => this.#ownerForks().get(ownerId),
          session: (sessionId) => sessions.get(sessionId),
          identities: () => this.#identityStore().list(),
          triggerPublished: ({ trigger }) =>
            withRepo(this.env.ARTIFACTS, triggerFork, async (repo) => (await repo.readCommit(trigger.sha)) !== null),
        },
        event,
      );
      const parsed = parseCombinedRunEvent(event);
      if (outcome.status !== "rejected" && parsed.ok) this.#combinedRunStore().complete(parsed.event);
      return outcome;
    });
  }

  /** Runs one Huddle step after the ones before it; see `#huddleSteps`. */
  #huddleStep<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#huddleSteps.then(step);
    this.#huddleSteps = run.catch(() => undefined);
    return run;
  }

  /**
   * The verification runs waiting for the runner, with what each merges and runs, oldest first. Each
   * open Huddle's HuddleAgent lists its own. The Worker lists them only to a runner bridge.
   */
  async pendingVerifications(): Promise<VerificationRunSpec[]> {
    const huddles = this.#huddleStore().open().filter((huddle) => huddle.issueId !== null && huddle.huddleRepo !== null);
    const lists: PendingVerification[][] = await Promise.all(
      huddles.map(async (huddle) => (await this.#huddleAgent(huddle.issueId as string)).pendingVerifications(huddle)),
    );
    return lists
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((pending) => pending.spec);
  }

  /**
   * Records a runner's report of a verification run with the HuddleAgent of the Huddle the run ID
   * belongs to (see huddle-verify.ts). `runnerId` is the reporting runner bridge, which the Worker
   * takes from its token.
   */
  reportVerification(runId: string, runnerId: string, report: unknown, repos: ProjectRepos): Promise<VerificationOutcome> {
    return this.#huddleStep(async () => {
      const issueId = huddleIssueOfRun(runId);
      const huddle = issueId === undefined ? undefined : this.#huddleStore().byIssue(issueId);
      if (huddle?.issueId == null) return unknownVerification(runId, report);
      const agent = await this.#huddleAgent(huddle.issueId);
      return agent.reportVerification(huddle, runId, runnerId, report, await this.#huddlePort(repos));
    });
  }

  /**
   * Schedules a verification run for each open Huddle `ownerId` takes part in, after a newer
   * checkpoint of that owner was recorded. Each Huddle's HuddleAgent decides and keeps the run.
   */
  scheduleVerifications(ownerId: string, repos: ProjectRepos): Promise<VerificationScheduleOutcome[]> {
    return this.#huddleStep(async () => {
      const outcomes: VerificationScheduleOutcome[] = [];
      const huddles = huddlesOf(this.#huddleStore().open(), ownerId);
      const port = huddles.length === 0 ? undefined : await this.#huddlePort(repos);
      for (const huddle of huddles) {
        if (huddle.issueId === null || port === undefined) continue;
        const outcome = await (await this.#huddleAgent(huddle.issueId)).scheduleVerification(huddle, port);
        if (outcome !== undefined) outcomes.push(outcome);
      }
      return outcomes;
    });
  }

  /**
   * The approved-branch requests waiting for the runner, one per open Huddle whose HuddleAgent found
   * nothing standing in the way of its close. The Worker lists them only to a runner bridge.
   */
  async pendingApprovals(): Promise<ApprovalSpec[]> {
    const huddles = this.#huddleStore()
      .open()
      .filter((huddle) => huddle.issueId !== null && huddle.huddleRepo !== null)
      .filter((huddle) => this.#index().issue(huddle.issueId as string)?.state !== "closed");
    const lists = await Promise.all(
      huddles.map(async (huddle) => (await this.#huddleAgent(huddle.issueId as string)).pendingApprovals(huddle)),
    );
    return lists.flat();
  }

  /**
   * Records a runner's report that the Huddle repo of Huddle issue `issueId` has its `approved` branch
   * at the requested commit, with that Huddle's HuddleAgent, which then closes the issue; see
   * huddle-close.ts. `runnerId` is the reporting runner bridge, from its token.
   */
  reportApprovedBranch(issueId: string, runnerId: string, report: unknown, repos: ProjectRepos): Promise<ApprovalOutcome> {
    return this.#huddleStep(async () => {
      const huddle = this.#huddleStore().byIssue(this.#index().resolve(issueId));
      if (huddle?.issueId == null) {
        return { status: "rejected", reason: "not_found", message: `no Huddle has issue ${issueId}` };
      }
      const agent = await this.#huddleAgent(huddle.issueId);
      return agent.reportApprovedBranch(huddle, runnerId, report, await this.#huddlePort(repos));
    });
  }

  /** The HuddleAgent of the Huddle whose issue has this number: one instance per Huddle in this project. */
  async #huddleAgent(issueId: string): Promise<HuddleVerifier & HuddleReviewer & HuddleThreadKeeper & HuddleCloser> {
    // The binding's generated stub type refers back to this package, so the stub is typed here by
    // the interfaces HuddleAgent implements.
    const agent = await getAgentByName(this.env.HuddleAgent, `${this.name}-huddle-${issueId}`);
    return agent as unknown as HuddleVerifier & HuddleReviewer & HuddleThreadKeeper & HuddleCloser;
  }

  /**
   * What a HuddleAgent reads and writes here, passed to it over RPC: the issue index, the owner forks,
   * the scope map, operations signed with the service key, which never leaves this agent, review
   * requests in owners' inboxes, and each fix's approval and what the Huddle issue waits on before
   * it may close, for the issue page.
   */
  async #huddlePort(repos: ProjectRepos): Promise<HuddleClosePort> {
    const rules = await this.#reviewRules(repos);
    const index = this.#index();
    return {
      issue: (issueId) => index.issue(issueId),
      submit: (operation) => this.submit(operation, { penguin: true }, "penguin", rules),
      ownerFork: (ownerId) => this.#ownerForks().get(ownerId),
      scopeMap: () => rules.scopeMap,
      requestReview: (ownerId, issueId) => {
        this.#inboxStore().reviewRequested(ownerId, issueId);
        sendToOwner(this.getConnections<{ owner?: string }>(), ownerId, inboxChangedMessage());
      },
      recordApproval: (issueId, approval) => {
        if (!this.#approvalStore().set(issueId, approval)) return;
        this.#liveFeed().issueChanged(issueId);
        const parent = index.issue(issueId)?.parentId;
        if (parent != null) this.#liveFeed().issueChanged(parent);
      },
      recordCloseOut: (issueId, waitingOn) => {
        if (this.#closeOutStore().set(issueId, waitingOn)) this.#liveFeed().issueChanged(issueId);
      },
    };
  }

  /**
   * Has each Huddle's HuddleAgent collect the reviews of its fixes (huddle-reviews.ts) and evaluate
   * its close (huddle-close.ts), for the Huddles of the issues `#reviewsChanged` names. A failure is
   * logged and never fails the operation that changed the issue: the next change collects again.
   */
  async #collectChangedReviews(repos: ProjectRepos): Promise<void> {
    if (this.#reviewsChanged.size === 0) return;
    const changed = [...this.#reviewsChanged];
    this.#reviewsChanged.clear();
    const huddles = new Set<string>();
    for (const issueId of changed) {
      const huddleIssue = this.#huddleOfIssue(issueId)?.issueId;
      if (huddleIssue != null) huddles.add(huddleIssue);
    }
    for (const huddleIssue of huddles) {
      try {
        await this.collectReviews(huddleIssue, repos);
      } catch (error) {
        console.error(JSON.stringify({ event: "review_collection_failed", issue: huddleIssue, error: String(error) }));
      }
    }
  }

  /** The Huddle an issue belongs to, as its Huddle issue or one of its fix sub-issues, or undefined. */
  #huddleOfIssue(issueId: string): Huddle | undefined {
    return this.#huddleStore().fixOf(issueId)?.huddle ?? this.#huddleStore().byIssue(issueId);
  }

  /**
   * Has the HuddleAgent of the Huddle whose issue has this number collect its fixes' reviews; see
   * huddle-reviews.ts. Undefined when no open Huddle has this issue.
   */
  collectReviews(issueId: string, repos: ProjectRepos): Promise<ReviewCollection | undefined> {
    return this.#huddleStep(async () => {
      const huddle = this.#huddleStore().byIssue(this.#index().resolve(issueId));
      if (huddle?.issueId == null || huddle.status !== "open") return undefined;
      const agent = await this.#huddleAgent(huddle.issueId);
      return agent.collectReviews(huddle, await this.#huddlePort(repos));
    });
  }

  /**
   * After `owner`'s checkpoint is recorded, schedules verification of the Huddles the owner takes
   * part in. A failure there never fails the report: the checkpoint stays recorded, and the next
   * report schedules again.
   */
  async #scheduleVerificationsFor(owner: string, repos: ProjectRepos): Promise<void> {
    try {
      const scheduled = await this.scheduleVerifications(owner, repos);
      for (const rejected of scheduled.filter((outcome) => outcome.status === "rejected")) {
        console.error(JSON.stringify({ event: "verification_schedule_failed", owner, ...rejected }));
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "verification_schedule_failed", owner, error: String(error) }));
    }
  }

  /**
   * Every thread on the Huddle issue with this number and on its fix sub-issues, open or resolved, as
   * that Huddle's HuddleAgent keeps them; empty when no Huddle has this issue.
   */
  async huddleThreads(issueId: string): Promise<HuddleThread[]> {
    const huddle = this.#huddleStore().byIssue(this.#index().resolve(issueId));
    if (huddle?.issueId == null) return [];
    return (await this.#huddleAgent(huddle.issueId)).threads(huddle);
  }

  /** Records the Huddle repo the Worker forked for the Huddle opened by `triggerCommit`. */
  recordHuddleRepo(triggerCommit: string, huddleRepo: string): Huddle | undefined {
    return this.#huddleStore().setRepo(triggerCommit, huddleRepo);
  }

  /** The Huddle whose issue has this number or temporary ID, or undefined. */
  readHuddle(issueId: string): Huddle | undefined {
    return this.#huddleStore().byIssue(this.#index().resolve(issueId));
  }

  /**
   * Validates one operation, applies it to the issue index and records it in AppliedOp. A pushed
   * file that matches a pending operation instead records its commit and clears the PendingOp row.
   */
  async applyOperation(input: OperationInput, repos: ProjectRepos): Promise<ApplyOutcome> {
    const outcome = await this.#index().apply({ ...input, keys: await this.#operationKeys(repos) });
    await this.#collectChangedReviews(repos);
    return outcome;
  }

  /**
   * Applies the operation files added on the issues repo's main branch up to `push.after`, in
   * coordination order, and resolves once every one is recorded in AppliedOp. Commits already
   * ingested are skipped, so a repeated or late event applies nothing twice. `push.before` is not a
   * stopping point: see push-ingest.ts for why the walk ends at the last ingested commit instead.
   *
   * Rejects when key material or a Git object is missing, so no operation is judged without its
   * keys, and the caller retries.
   */
  ingestPush(push: IssuesPush, repos: ProjectRepos): Promise<IngestResult> {
    const run = this.#ingests.then(() => this.#ingest(push, repos));
    this.#ingests = run.catch(() => undefined);
    return run;
  }

  /**
   * Rebuilds the issue index from the issues repo into shadow tables and compares them row by row
   * with the live tables; see rebuild.ts. The live index is first caught up to the repo's head. Runs
   * in the ingest queue, so no push is applied part way through the rebuild.
   */
  rebuildIndex(repos: ProjectRepos): Promise<RebuildReport> {
    const run = this.#ingests.then(() => this.#rebuild(repos));
    this.#ingests = run.catch(() => undefined);
    return run;
  }

  /**
   * One issue's state and its timeline of applied and rejected operations. `id` is the issue's number
   * or, for an issue created offline, its temporary ID, which stays an alias of the number.
   */
  readIssue(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: TimelineEntry[] } {
    return this.#index().read(id);
  }

  /**
   * The dashboard's page for one issue: the issue, its sub-issues with their sessions, reviews and
   * checks, and its timeline. Undefined when no issue has this number or temporary ID.
   */
  issuePage(id: string): IssuePage | undefined {
    const index = this.#index();
    const sessions = this.#sessionStore();
    return buildIssuePage(
      {
        read: (issueId) => index.read(issueId),
        issue: (issueId) => index.issue(issueId),
        routes: (issueId) => sessions.routes(issueId),
        session: (sessionId) => sessions.get(sessionId),
        approval: (issueId) => this.#approvalStore().get(issueId),
        waitingOn: (issueId) => this.#closeOutStore().get(issueId),
      },
      id,
    );
  }

  /**
   * The dashboard's board: every issue without its timeline, and every owner with their identities
   * and those identities' running sessions.
   */
  board(): Board {
    const index = this.#index();
    const sessions = this.#sessionStore();
    const identities = this.#identityStore();
    return buildBoard({
      ids: () => index.ids(),
      issue: (issueId) => index.issue(issueId),
      identities: () => identities.list(),
      running: () => sessions.running(),
      routes: (issueId) => sessions.routes(issueId),
      session: (sessionId) => sessions.get(sessionId),
      approval: (issueId) => this.#approvalStore().get(issueId),
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      actionItems: () => this.#inboxStore().actionItems(),
    });
  }

  /**
   * Marks sessions past their offline window, which tells connected dashboards, and schedules the
   * next sweep for when the next running session's window ends. Called by the Agents SDK scheduler.
   */
  async sweepSessions(): Promise<void> {
    await this.#scheduleSweep();
  }

  /**
   * Applies an operation from MCP, the dashboard or Penguin at once and queues it for the Git log.
   * `author` is the caller the gateway authenticated; the operation cannot name anyone else. The
   * operation is signed here with the service key (K5), which never leaves the Worker. A rejection
   * whose reason is in `recordRejections` is recorded on the issue. `rules` judge a review's rights.
   */
  async submit(
    operation: unknown,
    author: Author,
    source: PendingSource,
    rules: ReviewRules,
    recordRejections?: readonly (RejectReason | ReduceRejectReason)[],
  ): Promise<SubmitOutcome> {
    const serviceKey = await this.#loadServiceKey();
    return this.#index().submit({
      operation,
      author,
      source,
      signingKey: serviceKey.privateKey,
      // Service-signed operations verify under the service key alone, so no bridge key is needed.
      keys: {
        bridges: [],
        serviceKey: serviceKey.publicKey,
        scopeMap: rules.scopeMap,
        delegates: rules.delegates,
        identities: this.#identityStore(),
        fixes: this.#fixLookup(),
        huddles: this.#huddleLookup(),
      },
      ...(recordRejections === undefined ? {} : { recordRejections }),
    });
  }

  /**
   * For the integration runner only: every pending operation as the signed file to push and its
   * path. The push event for those files then reaches `ingestPush`, which clears the rows.
   */
  pendingOperations(caller: BridgeCaller): PendingListing {
    return this.#index().pendingFiles(caller);
  }

  /**
   * Creates an identity owned by `caller`, the person the gateway authenticated. The handle must be
   * "@<caller>/<name>", and each charter scope must be one of the caller's scopes in `scopeMap`.
   */
  createIdentity(caller: string, input: IdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().create(caller, input, scopeMap);
  }

  /**
   * Creates a team identity that serves `input.owners`, the caller among them. It works only within
   * the scopes of the owner who assigns it to an issue.
   */
  createTeamIdentity(caller: string, input: TeamIdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().createTeam(caller, input, scopeMap);
  }

  /** Changes an identity's fields. Only its owner, or one of a team identity's owners, may. */
  editIdentity(caller: string, id: string, changes: IdentityChanges, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().edit(caller, id, changes, scopeMap);
  }

  /** Copies an identity under a new handle; the charter carries over and the history stays with the original. */
  duplicateIdentity(
    caller: string,
    id: string,
    copy: { readonly handle: string; readonly name?: string },
  ): IdentityOutcome {
    return this.#identityStore().duplicate(caller, id, copy);
  }

  /**
   * The dashboard's identities page: every identity with its charter, sessions, issue history, last
   * checkpoint and recent operations, and the scope map's scopes a charter may name.
   */
  async identitiesPage(repos: ProjectRepos): Promise<IdentitiesPage> {
    const index = this.#index();
    const sessions = this.#sessionStore();
    const identities = this.#identityStore();
    return buildIdentitiesPage({
      identities: () => identities.list(),
      sessions: () => sessions.byIdentity(PAGE_SESSIONS_PER_IDENTITY),
      history: () => index.identityHistory(),
      issue: (issueId) => index.issue(issueId),
      forks: () => this.#ownerForks().list(),
      operations: (handle) => index.authoredOperations(handle, PAGE_OPERATIONS_PER_IDENTITY),
      scopeMap: await this.#scopeMap(repos),
    });
  }

  /**
   * Creates an identity a signed-in person wrote on the dashboard: a team identity when the input
   * names `owners`, else a personal one. `owner` is the person the Worker's session names.
   */
  async createIdentityFromDashboard(owner: string, input: unknown, repos: ProjectRepos): Promise<IdentityWriteOutcome> {
    const scopeMap = await this.#scopeMap(repos);
    const store = this.#identityStore();
    const team = typeof input === "object" && input !== null && "owners" in input;
    return this.#identityWritten(
      team
        ? store.createTeam(owner, input as TeamIdentityInput, scopeMap)
        : store.create(owner, input as IdentityInput, scopeMap),
    );
  }

  /** Edits an identity from the dashboard. Only its owner, or one of a team identity's owners, may. */
  async editIdentityFromDashboard(
    owner: string,
    id: string,
    changes: unknown,
    repos: ProjectRepos,
  ): Promise<IdentityWriteOutcome> {
    const scopeMap = await this.#scopeMap(repos);
    return this.#identityWritten(this.#identityStore().edit(owner, id, changes as IdentityChanges, scopeMap));
  }

  /** Duplicates an identity from the dashboard under the handle, and optionally the name, in `copy`. */
  duplicateIdentityFromDashboard(owner: string, id: string, copy: unknown): IdentityWriteOutcome {
    const { handle, name } = (typeof copy === "object" && copy !== null ? copy : {}) as {
      handle?: unknown;
      name?: unknown;
    };
    const named = name === undefined ? {} : { name: name as string };
    return this.#identityWritten(this.#identityStore().duplicate(owner, id, { handle: handle as string, ...named }));
  }

  /** Tells every connected dashboard that an identity changed; the answer carries no avatar bytes. */
  #identityWritten(outcome: IdentityOutcome): IdentityWriteOutcome {
    if (outcome.status === "ok") this.broadcast(identitiesChangedMessage());
    return identityWriteOutcome(outcome);
  }

  readIdentity(id: string): Identity | undefined {
    return this.#identityStore().get(id);
  }

  /**
   * Registers a session of an identity and returns it with its ID. `caller` is the owner the gateway
   * authenticated by token; a session registers only as an identity of that owner. The identity's
   * waiting assignments route to it.
   */
  registerSession(caller: string, input: SessionInput): SessionOutcome {
    return this.#armSweep(this.#sessionStore().register(caller, input));
  }

  /** Records a session's heartbeat. A session with no heartbeat within the offline window goes offline. */
  sessionHeartbeat(caller: string, sessionId: string): SessionOutcome {
    return this.#armSweep(this.#sessionStore().heartbeat(caller, sessionId));
  }

  readSession(sessionId: string): Session | undefined {
    return this.#sessionStore().get(sessionId);
  }

  /**
   * The issues routed to a running session: assigned to its identity and accepted by the owner. A fix
   * task appears from the session's next safe checkpoint on.
   */
  sessionWork(caller: string, sessionId: string): SessionWork {
    return this.#sessionStore().work(caller, sessionId);
  }

  /**
   * Every open thread that needs `person`, on any issue, for `get_work`: the agent tells its developer
   * about each (PRD section 8). `person` is the owner the gateway authenticated.
   */
  threadsNeeding(person: string): { readonly issueId: string; readonly thread: Thread }[] {
    return this.#index().threadsNeeding(person);
  }

  /**
   * The overlapping starts that wait for `person`'s approval, for `get_work`: the agent tells its
   * developer about each. `person` is the owner the gateway authenticated.
   */
  overlapsNeeding(person: string): OverlapLock[] {
    return this.#overlapStore().openFor(person);
  }

  /**
   * The feature `caller`'s session works on, with the locks its start waits on and its dependents,
   * for `get_work`; undefined when the session works on none or is not the caller's.
   */
  featureWork(caller: string, sessionId: string): ({ readonly feature: string } & OverlapStatus) | undefined {
    // A heartbeat refuses a session of another owner, as every call with a session does.
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return undefined;
    const feature = this.#featureStore().featureOfSession(sessionId);
    return feature === undefined ? undefined : { feature, ...this.#overlapStore().status(feature) };
  }

  /** The task view of a fix sub-issue for `get_work`: pinned base, failing test, acceptance criteria. */
  readFixTask(issueId: string): FixTask | undefined {
    const id = this.#index().resolve(issueId);
    return fixTask(this.#huddleStore(), id, this.#index().issue(id));
  }

  /**
   * A safe checkpoint in the worktree `worktreeId`, reported by `owner`'s bridge (the bridge's
   * session checkpoint route): the bridge's hook before an agent's next tool action, or an explicit
   * bridge checkpoint. Delivers the waiting fix tasks of each of the owner's running sessions there.
   */
  sessionCheckpoint(owner: string, worktreeId: string): Delivery[] {
    const deliveries = this.#sessionStore().checkpointWorktree(owner, worktreeId);
    if (deliveries.length > 0) this.#armSweep({ status: "ok" });
    return deliveries;
  }

  /** The owner accepts an identity's assignment to an issue, which then routes to a running session. */
  acceptAssignment(caller: string, issueId: string, handle: string): AcceptOutcome {
    return this.#sessionStore().accept(caller, this.#index().resolve(issueId), handle);
  }

  /** The caller's requests: assignments to accept and sessions to start. */
  ownerRequests(caller: string): OwnerRequest[] {
    return this.#sessionStore().requests(caller);
  }

  /** The caller's inbox items, newest first. `caller` is the person the gateway authenticated. */
  inbox(caller: string): InboxItem[] {
    return this.#inboxStore().items(caller);
  }

  /** The dashboard's inbox for the caller: their items, newest first, with each issue's title and state. */
  inboxPage(caller: string): Inbox {
    const index = this.#index();
    const inbox = this.#inboxStore();
    return buildInbox({ items: (person) => inbox.items(person), issue: (issueId) => index.issue(issueId) }, caller);
  }

  /**
   * Marks one of the caller's inbox items read. A person can mark only their own items. The caller's
   * other dashboards hear of it; nobody else's do.
   */
  markInboxRead(caller: string, issueId: string, reason: InboxReason): InboxOutcome {
    const outcome = this.#inboxStore().markRead(caller, this.#index().resolve(issueId), reason);
    if (outcome.status === "ok") {
      sendToOwner(this.getConnections<{ owner?: string }>(), caller, inboxChangedMessage());
    }
    return outcome;
  }

  /**
   * Posts an update from an agent session (MCP `post_update`): applies the operation at once and
   * queues it for the Git log. `caller` is the owner the gateway authenticated by MCP token and must
   * own the session; the author is the session's identity. The call counts as a heartbeat. A
   * send_upstream that applies is followed by Penguin's reassignment (upstream.ts).
   */
  async sessionUpdate(
    caller: string,
    sessionId: string,
    update: SessionUpdate,
    repos: ProjectRepos,
  ): Promise<SessionUpdateOutcome> {
    const index = this.#index();
    const sessions = this.#sessionStore();
    const rules = await this.#reviewRules(repos);
    const outcome = await postSessionUpdate(
      {
        // Routes are kept under the issue number, so a temporary ID resolves to it first.
        sessions: {
          heartbeat: (owner, id) => this.#armSweep(sessions.heartbeat(owner, id)),
          routes: (issueId) => sessions.routes(index.resolve(issueId)),
        },
        issueVersion: (issueId) => index.issue(issueId)?.version,
        submit: (operation, author, record) => this.submit(operation, author, "mcp", rules, record),
        reassignUpstream: (issueId, sender) =>
          reassignUpstream(
            {
              huddleOf: (id) => this.#huddleStore().fixOf(id)?.huddle,
              scopeMap: rules.scopeMap,
              issue: (id) => index.issue(id),
              identities: () => this.#identityStore().list(),
              runningHandles: () => sessions.running().map((session) => session.handle),
              submit: (operation) => this.submit(operation, { penguin: true }, "penguin", rules),
            },
            issueId,
            sender,
          ),
      },
      caller,
      sessionId,
      update,
    );
    await this.#collectChangedReviews(repos);
    return outcome;
  }

  /**
   * Records a checkpoint the caller's bridge published (MCP `report_checkpoint`) as the latest
   * checkpoint of the caller's fork, once `readCommit` finds the commit in that fork. `fork` is the
   * Artifacts repo name of the caller's fork, which the Worker derives from the authenticated owner.
   * A recorded checkpoint is the session's safe checkpoint: its waiting fix tasks are delivered. It
   * then schedules its combined runs; see `#scheduleCombinedRuns`.
   */
  async reportCheckpoint(
    caller: string,
    sessionId: string,
    sha: string,
    fork: string,
    repos: ProjectRepos,
  ): Promise<SessionCheckpointOutcome> {
    const deps = { sessions: this.#sessionStore(), ...this.#checkpointDeps() };
    const outcome = await reportCheckpoint(deps, caller, sessionId, sha, fork);
    if (outcome.status === "ok") {
      await this.#scheduleCombinedRuns(caller, sha, fork, repos);
      await this.#scheduleVerificationsFor(caller, repos);
    }
    return outcome;
  }

  /**
   * Records a checkpoint the owner's bridge pushed (the bridge checkpoint route), with no agent
   * session. `owner` comes from the bridge token and `fork` is that owner's fork, named by the Worker.
   * A recorded checkpoint then schedules its combined runs; see `#scheduleCombinedRuns`.
   */
  async reportBridgeCheckpoint(owner: string, sha: string, fork: string, repos: ProjectRepos): Promise<CheckpointOutcome> {
    const outcome = await recordReportedCheckpoint(this.#checkpointDeps(), owner, sha, fork, null);
    if (outcome.status === "ok") {
      await this.#scheduleCombinedRuns(owner, sha, fork, repos);
      await this.#scheduleVerificationsFor(owner, repos);
    }
    return outcome;
  }

  /**
   * For the integration runner only: claims the scheduled combined runs (see
   * combined-run-schedule.ts). Any other role is refused.
   */
  claimCombinedRuns(caller: BridgeCaller): ClaimListing {
    return this.#combinedRunStore().claim(caller);
  }

  /** The section 5.1 checks the runner reported for one trigger checkpoint, by target. */
  blockChecks(ownerId: string, sha: string): BlockCheck[] {
    return this.#combinedRunStore().checks(ownerId, sha);
  }

  /**
   * Schedules the combined runs a recorded checkpoint calls for, reading the checkpoint's history
   * from `fork` and the scope map and baseline from the base repo. The checkpoint stays recorded when
   * this fails: a later report of the same checkpoint schedules again, and runs already scheduled
   * are not repeated.
   */
  async #scheduleCombinedRuns(owner: string, sha: string, fork: string, repos: ProjectRepos): Promise<void> {
    try {
      const scopeMap = await this.#scopeMap(repos);
      const forks = this.#ownerForks();
      await withRepo(this.env.ARTIFACTS, fork, (forkRepo) =>
        withRepo(this.env.ARTIFACTS, repos.base, (baseRepo) =>
          scheduleCombinedRuns(
            {
              scopeMap,
              fork: forkRepo,
              base: baseRepo,
              latestCheckpoint: (ownerId) => forks.get(ownerId)?.latestCheckpointSha ?? undefined,
              runs: this.#combinedRunStore(),
            },
            owner,
            sha,
          ),
        ),
      );
    } catch (error) {
      console.error(JSON.stringify({ event: "combined_run_schedule_failed", owner, sha, error: String(error) }));
    }
  }

  #checkpointDeps(): CheckpointRecordDeps {
    return {
      forks: this.#ownerForks(),
      commitExists: (repoName, commit) =>
        withRepo(this.env.ARTIFACTS, repoName, async (repo) => (await repo.readCommit(commit)) !== null),
    };
  }

  /**
   * Opens a feature for `owner`, the person the gateway authenticated, with its declared area and a
   * signed `open_feature` record (feature-open.ts). With `sessionId`, the owner's session opens it and
   * joins it. The Worker then forks main and calls `recordFeatureRepo`.
   */
  openFeature(owner: string, input: FeatureOpenInput, sessionId: string | null, repos: ProjectRepos): Promise<FeatureOpenOutcome> {
    return openFeature(this.#featureDeps(repos), owner, input, sessionId);
  }

  /** Records the fork the Worker made for a feature, which turns the feature to `building`. */
  recordFeatureRepo(featureId: string, repo: string): Feature | undefined {
    return recordFeatureRepo(this.#featureStore(), featureId, repo);
  }

  /**
   * Whether `owner`'s session may hold a write token on feature `featureId`'s fork, and that fork's
   * repo name. The Worker mints the token only on a grant, so its plaintext never reaches this agent.
   */
  featureTokenGrant(owner: string, sessionId: string, featureId: string, repos: ProjectRepos): TokenGrant {
    return featureTokenGrant(this.#featureDeps(repos), owner, sessionId, featureId);
  }

  /** Replaces a feature's declared area: by one of its agent sessions, or by its person with no session. */
  declareFeatureArea(
    owner: string,
    featureId: string,
    area: unknown,
    sessionId: string | null,
    repos: ProjectRepos,
  ): Promise<FeatureOutcome> {
    return declareArea(this.#featureDeps(repos), owner, featureId, area, sessionId);
  }

  /**
   * Records checkpoint `sha` of feature `featureId`: from one of its agent sessions, which then gets
   * its safe-checkpoint deliveries, or from the feature person's bridge with no session. The commit
   * must be in the feature's fork. The declared area grows by what the checkpoint changed against its
   * baseline on main; `durationMs` is how long that update took.
   */
  reportFeatureCheckpoint(
    owner: string,
    sessionId: string | null,
    featureId: string,
    sha: string,
    repos: ProjectRepos,
  ): Promise<FeatureCheckpointOutcome> {
    const deps = {
      ...this.#featureDeps(repos),
      commitExists: this.#checkpointDeps().commitExists,
      readChange: (repo: string, commit: string) =>
        withRepo(this.env.ARTIFACTS, repo, (fork) =>
          withRepo(this.env.ARTIFACTS, repos.base, (base) => checkpointChange(fork, base, commit)),
        ),
      deliver: (caller: string, session: string) => {
        const delivery = this.#sessionStore().checkpoint(caller, session);
        return delivery.status === "ok" ? delivery : undefined;
      },
    };
    return reportFeatureCheckpoint(deps, owner, sessionId, featureId, sha);
  }

  /** Every feature, newest first, for the dashboard. */
  features(): Feature[] {
    return this.#featureStore().list();
  }

  readFeature(featureId: string): Feature | undefined {
    return this.#featureStore().get(featureId);
  }

  /**
   * `caller`, the person the dashboard session names, approves the start of `blockedFeatureId`
   * beside their running feature `featureId` (overlap-lock.ts). Only the person who owns
   * `featureId` may, once; the approval is a signed record.
   */
  approveOverlap(caller: string, featureId: string, blockedFeatureId: string, repos: ProjectRepos): Promise<ApproveOutcome> {
    return this.#lockStep(() => approveOverlap(this.#overlapDeps(repos), caller, featureId, blockedFeatureId));
  }

  /** The dashboard's overlapping starts waiting for `caller`: their overlap inbox items with each lock. */
  overlapRequests(caller: string): OverlapRequests {
    const overlaps = this.#overlapStore();
    return {
      requests: this.#inboxStore()
        .items(caller)
        .flatMap((item) => {
          const ref = item.reason === "overlap" ? parseOverlapRef(item.issueId) : undefined;
          const held = ref === undefined ? undefined : overlaps.get(ref.featureId, ref.blockedFeatureId);
          const blocked = held === undefined ? undefined : this.#featureStore().get(held.blockedFeatureId);
          if (held === undefined || held.state !== "open" || blocked === undefined) return [];
          return [
            {
              feature: held.featureId,
              blockedFeature: held.blockedFeatureId,
              blockedPerson: blocked.personId,
              overlap: {
                scopes: [...held.overlap.scopes],
                paths: [...held.overlap.paths],
                contracts: [...held.overlap.contracts],
                omittedPaths: held.overlap.omittedPaths,
              },
              read: item.read,
              raisedAt: item.raisedAt,
            },
          ];
        }),
    };
  }

  #featureDeps(repos: ProjectRepos): FeatureDeps {
    const overlapDeps = this.#overlapDeps(repos);
    return {
      features: this.#featureStore(),
      scopeMap: () => this.#scopeMap(repos),
      heartbeat: (caller, sessionId) => this.sessionHeartbeat(caller, sessionId),
      sign: overlapDeps.sign,
      checkOverlap: (feature) =>
        // The area as stored when the check runs, which a later declaration may have replaced.
        this.#lockStep(() => checkOverlap(overlapDeps, this.#featureStore().get(feature.id) ?? feature)),
      overlapStatus: (featureId) => this.#overlapStore().status(featureId),
    };
  }

  #overlapDeps(repos: ProjectRepos): OverlapDeps {
    const notify = (personId: string) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage());
    return {
      db: this.#database(),
      features: this.#featureStore(),
      overlaps: this.#overlapStore(),
      scopeMap: () => this.#scopeMap(repos),
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      listener: {
        lockOpened: ({ featureId, blockedFeatureId, personId }) => {
          this.#inboxStore().overlapRequested(personId, featureId, blockedFeatureId);
          notify(personId);
        },
        lockSettled: ({ featureId, blockedFeatureId, personId }) => {
          this.#inboxStore().overlapSettled(personId, featureId, blockedFeatureId);
          notify(personId);
        },
      },
    };
  }

  /** Runs one overlap check or approval after the ones before it; see `#lockSteps`. */
  #lockStep<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#lockSteps.then(step);
    this.#lockSteps = run.catch(() => undefined);
    return run;
  }

  #overlapStore(): OverlapStore {
    this.#overlapRows ??= new OverlapStore(this.#database());
    return this.#overlapRows;
  }

  #featureStore(): FeatureStore {
    this.#featureRows ??= new FeatureStore(this.#database());
    return this.#featureRows;
  }

  /**
   * Checks and keeps the review form `owner`'s session submits for its own scope on feature
   * `input.feature` (review-submit.ts): against the scope's invariants in `penguin/invariants.json`
   * on main and the evidence in the feature's fork at its latest checkpoint.
   */
  submitReview(owner: string, sessionId: string, input: ReviewInput, repos: ProjectRepos): Promise<ReviewOutcome> {
    return submitReview(
      {
        features: this.#featureStore(),
        reviews: this.#reviewStore(),
        scopeMap: () => this.#scopeMap(repos),
        invariantsFile: () => this.#baseFile(repos, INVARIANTS_PATH),
        readForkFile: (repo, sha, path) => withRepo(this.env.ARTIFACTS, repo, (fork) => fork.readFile({ ref: sha, path })),
        baseline: (repo, sha) =>
          withRepo(this.env.ARTIFACTS, repo, (fork) => withRepo(this.env.ARTIFACTS, repos.base, (base) => checkpointBaseline(fork, base, sha))),
        heartbeat: (caller, session) => this.sessionHeartbeat(caller, session),
      },
      owner,
      sessionId,
      input,
    );
  }

  /**
   * For the integration runner only: claims the pending reviews, each with its form, baseline and
   * checkpoint (review-record.ts). Any other role is refused.
   */
  claimReviews(caller: BridgeCaller): ReviewClaim {
    return claimReviews(this.#reviewStore(), caller);
  }

  /**
   * Attaches the runner's record to pending review `reviewId`. When the record raises an exception,
   * the scope's owner gets a `review_exception` inbox item.
   */
  reportReview(caller: BridgeCaller, reviewId: number, record: unknown): Promise<ReviewReportOutcome> {
    return recordReview(
      {
        reviews: this.#reviewStore(),
        routeToOwner: (ownerId, review) => {
          this.#inboxStore().reviewException(ownerId, review.featureId, review.scopeId);
          sendToOwner(this.getConnections<{ owner?: string }>(), ownerId, inboxChangedMessage());
        },
      },
      caller,
      reviewId,
      record,
    );
  }

  /** The reviews of one feature, oldest first, each with its record once the runner attached it. */
  featureReviews(featureId: string): StoredReview[] {
    return this.#reviewStore().list(featureId);
  }

  #reviewStore(): ReviewStore {
    this.#reviewRows ??= new ReviewStore(this.#database());
    return this.#reviewRows;
  }

  /** An owner's fork record with its latest reported checkpoint, or undefined before the first report. */
  readOwnerFork(ownerId: string): OwnerFork | undefined {
    return this.#ownerForks().get(ownerId);
  }

  /** Where each identity assignment of an issue stands: its session, or what it waits for. */
  issueRoutes(issueId: string): AssignmentRoute[] {
    return this.#sessionStore().routes(this.#index().resolve(issueId));
  }

  /** Makes sure a sweep is scheduled after a session registered or sent a heartbeat. */
  #armSweep<T extends { readonly status: string }>(outcome: T): T {
    if (outcome.status === "ok") {
      this.#scheduleSweep().catch((error: unknown) => console.error("scheduling the session sweep failed", error));
    }
    return outcome;
  }

  /** Sweeps now and keeps a later sweep scheduled while any session runs; see `scheduleSweep`. */
  #scheduleSweep(): Promise<void> {
    return scheduleSweep({
      sweep: () => this.#sessionStore().sweep(),
      now: () => Date.now(),
      scheduled: async () =>
        (await this.listSchedules())
          .filter((schedule) => schedule.callback === "sweepSessions")
          .map((schedule) => schedule.time * 1_000),
      schedule: async (at) => {
        await this.schedule(new Date(at), "sweepSessions");
      },
    });
  }

  #loadServiceKey(): Promise<ServiceKey> {
    if (this.#serviceKey === undefined) {
      const loading = importServiceKey((this.env as unknown as ProjectAgentEnv).PENGUIN_OP_SIGNING_KEY);
      // A failed import is retried on the next call, once the secret is set.
      loading.catch(() => (this.#serviceKey = undefined));
      this.#serviceKey = loading;
    }
    return this.#serviceKey;
  }

  /** Issues a one-time code that registers one bridge for `ownerId`. */
  issueBridgeRegistrationCode(ownerId: string, role: BridgeRole, ttlSeconds: number): Promise<RegistrationCode> {
    return this.#registry().issueCode(ownerId, role, ttlSeconds);
  }

  /** Spends a registration code and records the bridge's owner, role, public key and token hash. */
  registerBridge(code: string, publicKey: unknown): Promise<RegisterOutcome> {
    return this.#registry().register(code, publicKey);
  }

  /** The registered, unrevoked bridge holding `bridgeToken`, or undefined. */
  authenticateBridge(bridgeToken: string): Promise<BridgeIdentity | undefined> {
    return this.#registry().authenticate(bridgeToken);
  }

  /** Revokes a bridge. Returns false when no unrevoked bridge has that id. */
  revokeBridge(bridgeId: string): boolean {
    return this.#registry().revoke(bridgeId);
  }

  /** Issues an MCP token (K3) for `ownerId`. The plaintext is returned only here; the agent keeps its hash. */
  issueMcpToken(ownerId: string): Promise<IssuedMcpToken> {
    return this.#mcpTokenStore().issue(ownerId);
  }

  /** The owner holding this unrevoked MCP token, or undefined. */
  authenticateMcpToken(token: string): Promise<McpCaller | undefined> {
    return this.#mcpTokenStore().authenticate(token);
  }

  /** Revokes an MCP token. Returns false when no unrevoked token has that id. */
  revokeMcpToken(tokenId: string): boolean {
    return this.#mcpTokenStore().revoke(tokenId);
  }

  async #ingest(push: IssuesPush, repos: ProjectRepos): Promise<IngestResult> {
    const started = Date.now();
    const keys = await this.#operationKeys(repos);
    const index = this.#index();
    this.#ledger ??= new IngestLedger(this.#database());
    const ledger = this.#ledger;
    const report = await withRepo(this.env.ARTIFACTS, repos.issues, (repo) =>
      ingestPush(repo, push.after, ledger, (file, commit) =>
        index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
      ),
    );
    await this.#collectChangedReviews(repos);
    return { ...report, durationMs: Date.now() - started };
  }

  async #rebuild(repos: ProjectRepos): Promise<RebuildReport> {
    const keys = await this.#operationKeys(repos);
    this.#ledger ??= new IngestLedger(this.#database());
    const live = { index: this.#index(), ledger: this.#ledger };
    return withRepo(this.env.ARTIFACTS, repos.issues, (repo) =>
      rebuildIndex({ repo, db: this.#database(), live, keys }),
    );
  }

  /**
   * The keys operations are judged by, read fresh for each call: the service key (K5), the signing
   * keys of unrevoked bridges only, so a revoked bridge's key no longer verifies, and the scope map.
   * The identity store supplies the charters of identity-authored operations.
   */
  async #operationKeys(repos: ProjectRepos): Promise<OperationKeys> {
    const [serviceKey, bridges, rules] = await Promise.all([
      this.#loadServiceKey(),
      this.#registry().bridgeKeys(),
      this.#reviewRules(repos),
    ]);
    return {
      serviceKey: serviceKey.publicKey,
      bridges,
      scopeMap: rules.scopeMap,
      delegates: rules.delegates,
      identities: this.#identityStore(),
      fixes: this.#fixLookup(),
      huddles: this.#huddleLookup(),
    };
  }

  /** The Huddle issues whose close the close rule judges, with the owner who started each one's work. */
  #huddleLookup(): HuddleLookup {
    return { startedBy: (issueId) => this.#huddleStore().byIssue(issueId)?.triggerOwner };
  }

  /** The fix sub-issues a send_upstream may name, with the scopes their Huddle's trigger changed. */
  #fixLookup(): FixLookup {
    return { upstreamScopes: (issueId) => this.#huddleStore().fixOf(this.#index().resolve(issueId))?.huddle.triggerScopes };
  }

  /** The scope map in the base repo's `penguin/scopes.json` on its branch, read fresh for each call. */
  async #scopeMap(repos: ProjectRepos): Promise<ScopeMap> {
    return parseScopeFile(await this.#baseFile(repos, SCOPE_MAP_PATH));
  }

  /**
   * The scope map and each owner's delegate, from the base repo's `penguin/scopes.json` and
   * `penguin/owners.json` on its branch, read fresh for each call.
   */
  async #reviewRules(repos: ProjectRepos): Promise<ReviewRules> {
    const [scopes, owners] = await Promise.all([
      this.#baseFile(repos, SCOPE_MAP_PATH),
      this.#baseFile(repos, OWNERS_PATH),
    ]);
    return { scopeMap: parseScopeFile(scopes), delegates: parseOwnersFile(owners) };
  }

  /** A file on the base repo's branch, or null when there is none. */
  #baseFile(repos: ProjectRepos, path: string): Promise<Uint8Array | null> {
    return withRepo(this.env.ARTIFACTS, repos.base, (repo) => readBaseFile(repo, path));
  }

  #approvalStore(): FixApprovalStore {
    this.#approvals ??= new FixApprovalStore(this.#database());
    return this.#approvals;
  }

  #closeOutStore(): CloseOutStore {
    this.#closeOuts ??= new CloseOutStore(this.#database());
    return this.#closeOuts;
  }

  #huddleStore(): HuddleStore {
    this.#huddles ??= new HuddleStore(this.#database());
    return this.#huddles;
  }

  #combinedRunStore(): CombinedRunStore {
    this.#combinedRuns ??= new CombinedRunStore(this.#database());
    return this.#combinedRuns;
}

  #ownerForks(): OwnerForkStore {
    this.#forks ??= new OwnerForkStore(this.#database());
    return this.#forks;
  }

  #database(): SqlDatabase {
    this.#sql ??= durableObjectSql(this.ctx.storage);
    return this.#sql;
  }

  #registry(): BridgeRegistry {
    this.#bridges ??= new BridgeRegistry(this.#database());
    return this.#bridges;
  }

  #mcpTokenStore(): McpTokenStore {
    this.#mcpTokens ??= new McpTokenStore(this.#database());
    return this.#mcpTokens;
  }

  #index(): IssueIndex {
    if (this.#issues === undefined) {
      // The router hears of every assignment an applied operation changes, and the inbox of every
      // change to the issue, inside the operation's transaction.
      const listener: IndexListener = {
        assignmentsChanged: (issueId, added, removed) =>
          this.#sessionStore().assignmentsChanged(issueId, added, removed),
        issueChanged: (change) => {
          this.#inboxStore().issueChanged(change);
          this.#liveFeed().issueChanged(change.issueId);
          if (reviewsMayHaveMoved(change) && this.#huddleOfIssue(change.issueId) !== undefined) {
            this.#reviewsChanged.add(change.issueId);
          }
        },
        timelineChanged: (issueId) => this.#liveFeed().issueChanged(issueId),
      };
      this.#issues = new IssueIndex(this.#database(), listener);
    }
    return this.#issues;
  }

  #liveFeed(): LiveFeed {
    this.#live ??= new LiveFeed((message) => this.broadcast(message));
    return this.#live;
  }

  #sessionStore(): SessionStore {
    if (this.#sessions === undefined) {
      // The index first: it creates the Assignment table the router reads and writes.
      const index = this.#index();
      const seconds = Number((this.env as unknown as ProjectAgentEnv).PENGUIN_SESSION_OFFLINE_SECONDS);
      this.#sessions = new SessionStore(this.#database(), this.#identityStore(), {
        offlineAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SESSION_OFFLINE_AFTER_MS,
        assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
        startRequests: this.#inboxStore(),
        // A Huddle's fix sub-issue reaches its session at the session's next safe checkpoint.
        deliverAtCheckpoint: (issueId) => this.#huddleStore().isFix(issueId),
        // A thread that needs a person reaches that person's sessions at their next safe checkpoint.
        threadsNeeding: (person) => threadRefs(index.threadsNeeding(person)),
        // An overlapping start waiting for a person reaches that person's sessions the same way.
        overlapsNeeding: (person) => this.#overlapStore().openFor(person),
        // A lock approved or withdrawn reaches the waiting feature's sessions the same way.
        settledFor: settledForSession(this.#featureStore(), this.#overlapStore()),
        listener: {
          sessionChanged: (handle) => this.#liveFeed().sessionChanged(handle),
          routeChanged: (issueId) => this.#liveFeed().issueChanged(issueId),
        },
      });
    }
    return this.#sessions;
  }

  #inboxStore(): InboxStore {
    this.#inbox ??= new InboxStore(this.#database(), this.#identityStore(), {
      assigningOwner: (issueId, handle) => this.#index().assigningOwner(issueId, handle),
    });
    return this.#inbox;
  }

  #identityStore(): IdentityStore {
    this.#identities ??= new IdentityStore(this.#database());
    return this.#identities;
  }
}

/**
 * True when the operation changed what a Huddle's review collection reads: a fix's reviews, commits or
 * labels, which its approval is read from, or the threads the HuddleAgent tracks.
 */
function reviewsMayHaveMoved({ previous, next }: IssueChange): boolean {
  return (
    previous !== undefined &&
    (previous.reviews !== next.reviews ||
      previous.linkedCommits !== next.linkedCommits ||
      previous.labels !== next.labels ||
      previous.threads !== next.threads)
  );
}

/** Opens a repo through the binding, runs `use` with it and releases the RPC stub afterwards. */
async function withRepo<T>(artifacts: Artifacts, name: string, use: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

/** A Durable Object's SQLite storage as the stores' SqlDatabase. */
export function durableObjectSql(storage: DurableObjectStorage): SqlDatabase {
  return {
    exec: (query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec<Record<string, SqlValue>>(query, ...bindings).toArray(),
    transaction: (body) => storage.transactionSync(body),
  };
}
