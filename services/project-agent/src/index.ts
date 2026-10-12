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
import { BASE_BRANCH, readBaseFile } from "./base-repo.ts";
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
import { reviewTaskCall, type ReviewTaskCall, type ReviewTaskCallOutcome } from "./review-task.ts";
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
  recordPenguinCheckpoint,
  reportFeatureCheckpoint,
  type FeatureCheckpointDeps,
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
import { OWNERS_PATH, parseOwnersFile, parseScopeFile, SCOPE_MAP_PATH, TEAMS_PATH } from "./scope-file.ts";
import { ReviewStore, submitReview, type ReviewInput, type ReviewOutcome, type StoredReview } from "./review-submit.ts";
import { buildFeaturePage, buildFeaturePlan, buildPersonScopes, buildTeamView, type DashboardViewDeps } from "./dashboard-views.ts";
import { claimReviews, recordReview, type ReviewClaim, type ReviewReportOutcome } from "./review-record.ts";
import {
  claimPartTrials,
  PartTrialStore,
  queueTrials,
  queueTrialOn,
  queueTrialsForReview,
  recordPartTrial,
  trialHolds,
  trialStanding,
  type PartTrialClaim,
  type PartTrialOutcome,
} from "./part-trial.ts";
import { reviewDifferences } from "./review-view.ts";
import {
  AgentToolStore,
  requestRetiringCheck,
  requestTool,
  whatsNear,
  type AgentToolDeps,
  type AgentToolRun,
  type ToolRequestOutcome,
  type WhatsNearOutcome,
} from "./agent-tools.ts";
import { PlanFactsStore, type PlanFactsReportOutcome } from "./plan-facts.ts";
import { releaseRun, reportRunFailure, RunFailureStore, type RunFailure, type RunStores } from "./run-failures.ts";
import type { PlanKeeper } from "./plan-store.ts";
import { fileDiffs, type GitObjectReader } from "./repo-diff.ts";
import {
  checkProtectedChanges,
  confirmProtectedChange,
  ownChange,
  protectedChangeRequests,
  ProtectedChangeStore,
  unconfirmedProtected,
  type ProtectedConfirmInput,
  type ProtectedConfirmOutcome,
} from "./protected-change.ts";
import {
  agentFixGrant,
  agentFixReport,
  claimRunnerWrites,
  FixGrantStore,
  openFixWrite,
  parseFixTokenLease,
  runnerFixReport,
  type FixGrantOutcome,
  type FixPartInput,
  type FixWriteDeps,
  type FixWriteOutcome,
  type ForkReader,
} from "./fix-write.ts";
import { retrialReported, retryWaitingWrites } from "./fix-retrial.ts";
import { EditRoster } from "./edit-roster.ts";
import { EditTaskStore, type EditReportOutcome, type EditSource, type EditTask } from "./edit-tasks.ts";
import {
  availability,
  blockReported,
  claimEditTasks,
  deliverEditTasks,
  editTaskView,
  writeWaitsFor,
  featureLandedTasks,
  holdsFixTask,
  openEditTask,
  reportEditTask,
  syncEditWork,
  type EditClaim,
  type EditWorkDeps,
} from "./edit-work.ts";
import { coverMidway, handOver, meeting, PlanCoverageStore } from "./plan-coverage.ts";
import { RetiringStore } from "./retiring-store.ts";
import { edgesReported, requestScopeEdges, ScopeEdgeStore } from "./scope-edges.ts";
import { contractWork, ContractSplitStore, recordSplit, retireSplit, scheduleSort, type ContractSplitDeps } from "./contract-split.ts";
import type { BlockRun } from "./block-store.ts";
import {
  BlockQueueStore,
  blockTargets,
  claimBlockRuns,
  featureLanded,
  landFailed,
  ancestorsFound,
  mainState,
  requestLand,
  requestPenguinLand,
  requestPlanCheck,
  retryLand,
  signBlockRecord,
  type FeatureBlocks,
  type LandDeps,
  type LandInput,
  type LandOutcome,
} from "./block-land.ts";
import { requestExpand, retryExpand, type ExpandDeps } from "./expand-promotion.ts";
import { closeRemoved, countReported, requestRetiringCount, type RetiringCountDeps } from "./retiring-count.ts";
import {
  carryContract,
  migrationBlockLanded,
  migrationsChecked,
  migrationsCounted,
  migrationTasksSettled,
  migrationTrialReported,
  migrationWrites,
  MigrationStore,
  rewritesReported,
  stewardsFor,
  type MigrationDeps,
} from "./migration-plans.ts";
import { landPenguinFeatures, PenguinLandStore, type PenguinLandAttempt } from "./penguin-land.ts";
import { rebuildPenguinFeature } from "./penguin-rebuild.ts";
import { checkpointRecord, parseBreakLimit, proposePlan, type ProposePlanInput, type ProposePlanOutcome } from "./propose-plan.ts";
import { claimToolRuns, recordToolResult, type ToolReportOutcome, type ToolRunClaim } from "./agent-tool-runner.ts";
import { reviewResult } from "./part-checks.ts";
import {
  announcePlan,
  approveCleanParts,
  approvePlanPart,
  buildPlanInbox,
  parseAdminMode,
  parseRoundLimit,
  planNoticeSources,
  PlanRouteStore,
  planWork,
  requestPlanChange,
  reversePenguinApproval,
  revisePlanPart,
  type ChangeRequestInput,
  type PartDecisionInput,
  type PartDecisionOutcome,
  type PlanApprovalDeps,
  type PlanWork,
  type RevisionInput,
} from "./plan-approval.ts";
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
  BACKGROUND_RUN_CAP_DEFAULT,
  EDIT_RUN_MINUTES_DEFAULT,
  FIX_WRITE_BRANCH,
  identitiesChangedMessage,
  inboxChangedMessage,
  isMigrationPlanId,
  type RetiringSymbol,
  parseBackgroundRunCap,
  parseCombinedRunEvent,
  parseEditRunMinutes,
  type EditQueue,
  type EditTaskView,
  type LadderDecision,
  type StewardView,
  type ApprovalSpec,
  type Author,
  type BlockCheck,
  type BlockRunRequest,
  type Board,
  type CharterView,
  type ContractWorkView,
  type IdentitiesPage,
  type IdentityWriteOutcome,
  type Inbox,
  type FeaturePage,
  type IssuePage,
  type OverlapRequests,
  type PlanPart,
  type PlanInbox,
  type PlanFactsRequest,
  type ReviewDifferences,
  type TeamView,
  type PersonScopes,
  type Promotion,
  type VerificationRunSpec,
  type ViewerPlan,
  parseRunFailureLimit,
  type RunFailureOutcome,
} from "@penguin/protocol";
import { INVARIANTS_PATH, parseInvariantsBytes, routeScope, type ScopeMap } from "@penguin/scope-map";

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
export { McpTokenStore, type IssuedMcpToken, type IssuedTaskToken, type McpCaller } from "./mcp-tokens.ts";
export { reviewTaskCall, reviewTaskCallProblem, reviewTaskGrant, taskHeartbeat, taskSessionId, type ReviewTaskCall, type ReviewTaskCallDeps, type ReviewTaskCallOutcome, type ReviewTaskDeps, type ReviewTaskGrant, type ReviewTaskGrantOutcome } from "./review-task.ts";
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
export { PLAN_STORE_SCHEMA, PlanStore, type FixWrite, type PartVersion, type Plan, type PlanKeeper, type PlanPart } from "./plan-store.ts";
export {
  BLOCK_RUN_LEASE_MS,
  BLOCK_STORE_SCHEMA,
  BlockStore,
  PROMOTION_STALE_MS,
  type BlockOpenOutcome,
  type BlockReportOutcome,
  type BlockRun,
  type BlockRunInput,
  type BlockRunState,
  type FailingCheck,
} from "./block-store.ts";
export {
  ancestorsFound,
  BLOCK_QUEUE_SCHEMA,
  BLOCK_RECORD_TYPES,
  BlockQueueStore,
  blockTargets,
  claimBlockRuns,
  featureLanded,
  landFailed,
  parsePromotionTokenTtl,
  planStillApproved,
  PROMOTION_SLOT_MS,
  PROMOTION_TOKEN_TTL_DEFAULT_MINUTES,
  PROMOTION_TOKEN_TTL_MAX_MINUTES,
  reportBlockRun,
  requestLand,
  requestPlanCheck,
  retryLand,
  signBlockRecord,
  type BlockProjectPort,
  type BlockRecordType,
  type BlockReportDeps,
  type BlockReportResult,
  type FeatureBlocks,
  type LandDeps,
  type LandedDeps,
  type LandInput,
  type LandOutcome,
  type LandRejectReason,
  type LandRejection,
} from "./block-land.ts";
export { onlyAddsFailures, requestExpand, retryExpand, type ExpandDeps, type ExpandInput } from "./expand-promotion.ts";
export { EDIT_ROSTER_SCHEMA, EditRoster, type RosterRole } from "./edit-roster.ts";
export {
  BRIDGE_ONLINE_MS,
  EDIT_TASK_SCHEMA,
  EditTaskStore,
  type EditReportOutcome,
  type EditSource,
  type EditTask,
  type EditTaskStoreOptions,
  type SessionFor,
} from "./edit-tasks.ts";
export {
  allowedPaths,
  blockReported,
  claimEditTasks,
  deliverEditTasks,
  editRouting,
  editTaskView,
  featureLandedTasks,
  holdsFixTask,
  nextStepSources,
  openEditTask,
  reportEditTask,
  sessionFor,
  syncEditWork,
  type EditClaim,
  type EditWorkDeps,
} from "./edit-work.ts";
export {
  carryContract,
  migrationBlockLanded,
  migrationsChecked,
  migrationsCounted,
  migrationTasksSettled,
  migrationTrialReported,
  migrationWrites,
  MigrationStore,
  MIGRATION_SCHEMA,
  rewritesReported,
  type MigrationDeps,
  type MigrationPart,
} from "./migration-plans.ts";
export {
  CALLERS_SEARCH,
  closeRemoved,
  countReported,
  PENGUIN_SESSION,
  REWRITE_SEARCH,
  requestRetiringCount,
  type CountOutcome,
  type RetiringCountDeps,
} from "./retiring-count.ts";
export {
  contractNextStep,
  contractWork,
  ContractSplitStore,
  CONTRACT_SPLIT_SCHEMA,
  moduleContract,
  ownScopes,
  recordSplit,
  retireSplit,
  scheduleSort,
  splitReplacements,
  type ContractSplitDeps,
} from "./contract-split.ts";
export { fastForwardMain, packEnd, parseAdvertisement, pktLine, readPktStream, type FastForward, type FastForwardOutcome, type GitEndpoint } from "./main-push.ts";
export {
  agentFixGrant,
  agentFixReport,
  claimRunnerWrites,
  commitProblem,
  FIX_GRANT_SCHEMA,
  FIX_WRITE_LEASE_MS,
  FixGrantStore,
  openFixWrite,
  runnerFixReport,
  type FixGrant,
  type FixGrantOutcome,
  type FixPartInput,
  type FixRejection,
  type FixWriteDeps,
  type FixWriteOutcome,
  type ForkReader,
  type ForkReading,
} from "./fix-write.ts";
export {
  coverMidway,
  handOver,
  meeting,
  PLAN_COVERAGE_SCHEMA,
  planArea,
  PlanCoverageStore,
  type AnnouncedPlan,
  type CoverageDeps,
  type HandedPlan,
  type JoinedPlan,
  type PlanMeeting,
} from "./plan-coverage.ts";
export { protectedLookup, reviewResult } from "./part-checks.ts";
export {
  announcePlan,
  approveCleanParts,
  approvePlanPart,
  buildPlanInbox,
  parseAdminMode,
  parseRoundLimit,
  PLAN_ROUTE_SCHEMA,
  planNoticeSources,
  PlanRouteStore,
  planWork,
  requestPlanChange,
  reversePenguinApproval,
  revisePlanPart,
  type ChangeRequestInput,
  type OwnPlanPart,
  type PartDecisionInput,
  type PartDecisionOutcome,
  type PartRejection,
  type PartRoute,
  type PlanApprovalDeps,
  type PlanInboxDeps,
  type PlanWork,
  type PlanWorkDeps,
  type ReviseDeps,
  type RevisionInput,
} from "./plan-approval.ts";
export {
  dependentScopes,
  factsRequest,
  PLAN_FACTS_SCHEMA,
  PlanFactsStore,
  touchedScopes,
  type PlanFactsReportOutcome,
  type PlanFactsRun,
  type PlanFactsState,
} from "./plan-facts.ts";
export {
  notStopped,
  releaseRun,
  reportRunFailure,
  RUN_FAILURE_SCHEMA,
  RunFailureStore,
  type ReleaseOutcome,
  type RunFailure,
  type RunFailureDeps,
  type RunStores,
  type StoreRelease,
} from "./run-failures.ts";
export {
  classifyFix,
  parseBreakLimit,
  parseParts,
  proposePlan,
  type MissingItem,
  type PlanRejection,
  type ProposePlanDeps,
  type ProposePlanInput,
  type ProposePlanOutcome,
  type RepoReading,
} from "./propose-plan.ts";
export {
  checkProtectedChanges,
  confirmProtectedChange,
  ownChange,
  PROTECTED_CHANGE_SCHEMA,
  protectedChangeRequests,
  ProtectedChangeStore,
  unconfirmedProtected,
  type CheckpointProtectionDeps,
  type ConfirmDeps as ProtectedConfirmDeps,
  type OwnChange,
  type ProtectedChange,
  type ProtectedConfirmInput,
  type ProtectedConfirmOutcome,
} from "./protected-change.ts";
export {
  changedFiles,
  commitSubject,
  DIFF_LIMITS,
  fileDiffs,
  lineHunks,
  splitLines,
  type ChangedFile,
  type CommitObject,
  type GitObjectReader,
  type TreeObjectEntry,
} from "./repo-diff.ts";
export {
  AGENT_TOOL_LIMITS,
  AgentToolStore,
  requestTool,
  TOOL_RESULTS_LISTED,
  TOOL_RUN_CLAIM_LIMIT,
  TOOL_RUN_LEASE_MS,
  whatsNear,
  type AgentToolDeps,
  type AgentToolRun,
  type NearFeature,
  type ToolRequestOutcome,
  type ToolResultRef,
  type ToolRunClaimListing,
  type WhatsNearOutcome,
} from "./agent-tools.ts";
export {
  claimToolRuns,
  otherForks,
  recordToolResult,
  type ClaimedFork,
  type ClaimedToolRun,
  type ToolReportOutcome,
  type ToolRunClaim,
  type ToolRunnerDeps,
} from "./agent-tool-runner.ts";
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
  claimPartTrials,
  PART_TRIAL_CLAIM_LIMIT,
  PART_TRIAL_LEASE_MS,
  PART_TRIAL_TABLE_SCHEMA,
  PartTrialStore,
  queueTrials,
  queueTrialsForReview,
  recordPartTrial,
  trialEvidence,
  trialForms,
  trialHolds,
  trialSpec,
  trialStanding,
  type PartTrialClaim,
  type PartTrialOutcome,
  type PartTrialRecordDeps,
  type StoredPartTrial,
  type TrialQueueDeps,
  type TrialSpec,
} from "./part-trial.ts";
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
  /** The most parts needing a person one merge plan may hold. Defaults to PLAN_BREAK_LIMIT_DEFAULT (PRD 4.2). */
  readonly PENGUIN_PLAN_BREAK_LIMIT?: string;
  /** `on` makes a person approve every plan part, so Penguin approves none (PRD 4.3 step 5). Off when unset. */
  readonly PENGUIN_PLAN_ADMIN_MODE?: string;
  /** The changes an author may ask for on one plan part. Defaults to PLAN_ROUND_LIMIT_DEFAULT (PRD 7). */
  readonly PENGUIN_PLAN_ROUND_LIMIT?: string;
  /** Failures of one claimed run before Penguin stops handing it out. Defaults to RUN_FAILURE_LIMIT_DEFAULT. */
  readonly PENGUIN_RUN_FAILURE_LIMIT?: string;
  /** Background runs one person's bridge holds at once (PRD 0.5 section 4.4a). Defaults to BACKGROUND_RUN_CAP_DEFAULT. */
  readonly PENGUIN_BACKGROUND_RUN_CAP?: string;
  /** Minutes one background run holds its edit task and its token. Defaults to EDIT_RUN_MINUTES_DEFAULT. */
  readonly PENGUIN_EDIT_RUN_MINUTES?: string;
  /** The lifetime of a fix writer's token, which is how long a granted write holds its fork (fix-write.ts). */
  readonly PENGUIN_FIX_TOKEN_TTL_MINUTES?: string;
  /** Whether a fork Penguin makes for a feature it opens keeps only the default branch, as the Worker's forks do. */
  readonly PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY?: string;
}

/** A land's answer as the ProjectAgent returns it across RPC: the run without its full request. */
export type LandAnswer =
  | {
      readonly status: "checking";
      readonly runId: string;
      readonly recordId: string;
      readonly checkpoint: string;
      readonly mainBefore: string;
      readonly branch: string;
      readonly planId: string | null;
      readonly targets: readonly { readonly feature: string; readonly sha: string }[];
    }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

/** What a feature's FeatureAgent answers about its landing. */
type FeatureLanding = { runs: BlockRun[]; promotion: Promotion | null; expansions: Promotion[] };

/** Where a feature's landing stands, for `get_work` and the feature page. */
export interface LandingView {
  readonly feature: string;
  readonly state: Feature["state"];
  /** The feature's newest block runs, newest first. */
  readonly runs: readonly BlockRun[];
  readonly promotion: Promotion | null;
  /** The feature's expand checkpoints promoted on their own, oldest first. */
  readonly expansions: readonly Promotion[];
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
 * It checks and signs every feature record; each feature's plan, block runs and promotion live in
 * that feature's FeatureAgent. For owner forks it still opens Huddle issues and hands each Huddle's
 * verification loop to a FeatureAgent named for the Huddle.
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
  #trialRows: PartTrialStore | undefined;
  #toolRows: AgentToolStore | undefined;
  #overlapRows: OverlapStore | undefined;
  #planFacts: PlanFactsStore | undefined;
  #planRoutes: PlanRouteStore | undefined;
  #protectedChanges: ProtectedChangeStore | undefined;
  #fixGrants: FixGrantStore | undefined;
  #planCoverage: PlanCoverageStore | undefined;
  #retiring: RetiringStore | undefined;
  #scopeEdges: ScopeEdgeStore | undefined;
  #migrations: MigrationStore | undefined;
  #penguinLands: PenguinLandStore | undefined;
  /** Penguin's lands of the features it opened run one sweep at a time (penguin-land.ts). */
  #penguinLandSweeps: Promise<unknown> = Promise.resolve();
  #splits: ContractSplitStore | undefined;
  #blockQueue: BlockQueueStore | undefined;
  #editTasks: EditTaskStore | undefined;
  #editRoster: EditRoster | undefined;
  /** Plan proposals run one at a time, so no two take the same plan version or record sequence number. */
  #planSteps: Promise<unknown> = Promise.resolve();
  /** Overlap checks and approvals run one at a time, so no two race for a record's sequence number. */
  #lockSteps: Promise<unknown> = Promise.resolve();
  #ledger: IngestLedger | undefined;
  #live: LiveFeed | undefined;
  /** Ingests run one at a time, so two pushes never interleave their walks and applies. */
  #ingests: Promise<unknown> = Promise.resolve();
  #huddles: HuddleStore | undefined;
  #combinedRuns: CombinedRunStore | undefined;
  #runFailures: RunFailureStore | undefined;
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
    // Verification runs are kept by each Huddle's FeatureAgent; an empty table left from before goes.
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
      const parsedEvent = parseCombinedRunEvent(event);
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
        // A feature fork's failures are not a Huddle's: Huddles fix owner forks only.
        parsedEvent.ok ? this.#combinedRunStore().ownerForkResults(parsedEvent.event) : event,
      );
      const parsed = parsedEvent;
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
   * open Huddle's FeatureAgent lists its own. The Worker lists them only to a runner bridge.
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
   * Records a runner's report of a verification run with the FeatureAgent of the Huddle the run ID
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
   * checkpoint of that owner was recorded. Each Huddle's FeatureAgent decides and keeps the run.
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
   * The approved-branch requests waiting for the runner, one per open Huddle whose FeatureAgent found
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
   * at the requested commit, with that Huddle's FeatureAgent, which then closes the issue; see
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

  /** The FeatureAgent of the Huddle whose issue has this number: one instance per Huddle in this project. */
  async #huddleAgent(issueId: string): Promise<HuddleVerifier & HuddleReviewer & HuddleThreadKeeper & HuddleCloser> {
    // The binding's generated stub type refers back to this package, so the stub is typed here by
    // the interfaces FeatureAgent implements.
    const agent = await getAgentByName(this.env.FeatureAgent, `${this.name}-huddle-${issueId}`);
    return agent as unknown as HuddleVerifier & HuddleReviewer & HuddleThreadKeeper & HuddleCloser;
  }

  /**
   * What a FeatureAgent reads and writes here, passed to it over RPC: the issue index, the owner forks,
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
   * Has each Huddle's FeatureAgent collect the reviews of its fixes (huddle-reviews.ts) and evaluate
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
   * Has the FeatureAgent of the Huddle whose issue has this number collect its fixes' reviews; see
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
   * that Huddle's FeatureAgent keeps them; empty when no Huddle has this issue.
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
    const outcome = this.#armSweep(this.#sessionStore().register(caller, input));
    // A new session has nothing in progress: registering is its first safe checkpoint.
    if (outcome.status === "ok") this.#deliverEditTasks(outcome.session.id);
    return outcome;
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
    for (const delivery of deliveries) this.#deliverEditTasks(delivery.sessionId);
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
      this.#deliverEditTasks(sessionId);
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
              features: () => this.#featureStore().list(),
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
  async openFeature(owner: string, input: FeatureOpenInput, sessionId: string | null, repos: ProjectRepos): Promise<FeatureOpenOutcome> {
    const outcome = await this.#featuresChanging(openFeature(this.#featureDeps(repos), owner, input, sessionId));
    // Each feature gets its builder at open, chartered on its declared area (edit-roster.ts).
    if (outcome.status === "opened") this.#editRosterStore().builder(outcome.feature, await this.#scopeMap(repos));
    return outcome;
  }

  /** Records the fork the Worker made for a feature, which turns the feature to `building`. */
  recordFeatureRepo(featureId: string, repo: string): Feature | undefined {
    this.#liveFeed().featuresChanged();
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
    return this.#featuresChanging(declareArea(this.#featureDeps(repos), owner, featureId, area, sessionId));
  }

  /**
   * Records checkpoint `sha` of feature `featureId`: from one of its agent sessions, which then gets
   * its safe-checkpoint deliveries, or from the feature person's bridge with no session. The commit
   * must be in the feature's fork. The declared area grows by what the checkpoint changed against its
   * baseline on main; `durationMs` is how long that update took.
   */
  async reportFeatureCheckpoint(
    owner: string,
    sessionId: string | null,
    featureId: string,
    sha: string,
    repos: ProjectRepos,
  ): Promise<FeatureCheckpointOutcome & { readonly planChecks?: readonly { readonly feature: string; readonly runId: string }[] }> {
    const outcome = await this.#recordFeatureCheckpoint(owner, sessionId, featureId, sha, repos);
    if (outcome.status !== "ok") return outcome;
    if (sessionId !== null) this.#deliverEditTasks(sessionId);
    return { ...outcome, planChecks: await this.#checkPlansMet(outcome.feature, repos) };
  }

  /**
   * PRD 4.4 step 3: a checkpoint of a running feature whose area meets another feature's announced
   * plan asks for that plan's check, the plan's block checked again with this fork's new head. A
   * failure here is logged and never fails the checkpoint.
   */
  async #checkPlansMet(feature: Feature, repos: ProjectRepos): Promise<{ feature: string; runId: string }[]> {
    const checks: { feature: string; runId: string }[] = [];
    try {
      const scopeMap = await this.#scopeMap(repos);
      for (const plan of this.#planCoverageStore().plans()) {
        if (plan.featureId === feature.id || meeting(feature.area, plan, scopeMap) === undefined) continue;
        const trigger = { feature: feature.id, checkpoint: feature.latestCheckpointSha as string };
        const run = await this.#planStep(() => requestPlanCheck(this.#landDeps(repos), plan.featureId, trigger));
        if (run !== undefined) checks.push({ feature: plan.featureId, runId: run.runId });
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "plan_check_failed", feature: feature.id, error: String(error).slice(0, 200) }));
    }
    return checks;
  }

  #recordFeatureCheckpoint(
    owner: string,
    sessionId: string | null,
    featureId: string,
    sha: string,
    repos: ProjectRepos,
  ): Promise<FeatureCheckpointOutcome> {
    return this.#featuresChanging(reportFeatureCheckpoint(this.#featureCheckpointDeps(repos), owner, sessionId, featureId, sha));
  }

  /** What recording a feature's checkpoint reads and asks for, from a session, a bridge or Penguin itself. */
  #featureCheckpointDeps(repos: ProjectRepos): FeatureCheckpointDeps {
    return {
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
      // The feature's own change to a path another person protects asks that person (protected-change.ts).
      protectedChanges: async (feature: Feature, checkpoint: string) =>
        checkProtectedChanges(
          {
            store: this.#protectedChangeStore(),
            inbox: this.#inboxStore(),
            notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
            readOwnChange: (repo, commit) =>
              withRepo(this.env.ARTIFACTS, repo, (fork) => withRepo(this.env.ARTIFACTS, repos.base, (main) => ownChange(fork as unknown as GitObjectReader, main, commit))),
            readDiffs: async (repo, files) =>
              (await withRepo(this.env.ARTIFACTS, repo, (fork) => fileDiffs(fork as unknown as GitObjectReader, files, () => null))).files,
          },
          feature,
          checkpoint,
          await this.#scopeMap(repos),
          this.#available(),
        ),
      // A running feature that starts touching an announced plan's area gains a part in it (plan-coverage.ts).
      joinPlans: (feature: Feature) =>
        this.#planStep(async () => {
          const approval = this.#planApprovalDeps(repos);
          return coverMidway(
            { ...approval, coverage: this.#planCoverageStore() },
            this.#featureStore().get(feature.id) ?? feature,
            await this.#scopeMap(repos),
          );
        }),
      // PRD 0.5 section 4.2 step 1: one contract diff per checkpoint, from its facts run, sorted.
      // A failure here is logged and never fails the checkpoint.
      sortContract: async (feature: Feature) => {
        try {
          const scopeMap = await this.#scopeMap(repos);
          const baseline = checkpointRecord(this.#featureStore(), feature)?.baseline;
          if (baseline === undefined) return undefined;
          const deps = this.#splitDeps();
          const run = scheduleSort(deps, feature, baseline, scopeMap);
          if (run?.state === "reported") await recordSplit(deps, feature, scopeMap);
          return run?.runId;
        } catch (error) {
          console.error(JSON.stringify({ event: "contract_sort_failed", feature: feature.id, error: String(error).slice(0, 200) }));
          return undefined;
        }
      },
      // PRD 0.5 section 5.1: one retiring-calls check per checkpoint, when the project retires symbols.
      // A failure here is logged and never fails the checkpoint.
      checkRetiring: async (feature: Feature, session: string, commit: string) => {
        try {
          return await requestRetiringCheck(this.#agentToolDeps(repos), feature, session, commit);
        } catch (error) {
          console.error(JSON.stringify({ event: "retiring_check_failed", feature: feature.id, error: String(error).slice(0, 200) }));
          return undefined;
        }
      },
    };
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
    return this.#featuresChanging(this.#lockStep(() => approveOverlap(this.#overlapDeps(repos), caller, featureId, blockedFeatureId)));
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
      // A late starter receives every announced plan its area meets (plan-coverage.ts).
      handOver: async (feature) => handOver(this.#planCoverageStore(), feature, await this.#scopeMap(repos)),
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
    return this.#submitReview(owner, sessionId, input, repos, (caller, session) => this.sessionHeartbeat(caller, session));
  }

  #submitReview(owner: string, sessionId: string, input: ReviewInput, repos: ProjectRepos, heartbeat: (caller: string, sessionId: string) => SessionOutcome): Promise<ReviewOutcome> {
    return this.#featuresChanging(submitReview(
      {
        features: this.#featureStore(),
        reviews: this.#reviewStore(),
        scopeMap: () => this.#scopeMap(repos),
        invariantsFile: () => this.#baseFile(repos, INVARIANTS_PATH),
        readForkFile: (repo, sha, path) => withRepo(this.env.ARTIFACTS, repo, (fork) => fork.readFile({ ref: sha, path })),
        baseline: (repo, sha) =>
          withRepo(this.env.ARTIFACTS, repo, (fork) => withRepo(this.env.ARTIFACTS, repos.base, (base) => checkpointBaseline(fork, base, sha))),
        heartbeat,
        coveringPart: (featureId, scopeId, checkpoint) => this.#coveringPart(featureId, scopeId, checkpoint),
      },
      owner,
      sessionId,
      input,
    ).then(async (outcome) => {
      // A form that waits for the runner asks again for a trial of each part covering its scope.
      if (outcome.status === "ok" && outcome.state === "pending") {
        const plan = await this.#planKeeper(outcome.featureId).latestPlan(outcome.featureId);
        queueTrialsForReview(this.#trialDeps(), plan, outcome.scopeId, outcome.forkSha);
      }
      return outcome;
    }));
  }

  /** The part of the feature's newest plan on `checkpoint` covering `scopeId`, a running feature's first. */
  async #coveringPart(featureId: string, scopeId: string, checkpoint: string): Promise<PlanPart | undefined> {
    const plan = await this.#planKeeper(featureId).latestPlan(featureId);
    if (plan === undefined || plan.facts.change.checkpoint !== checkpoint) return undefined;
    const covering = plan.parts.filter((part) => part.scopes.includes(scopeId));
    return covering.find((part) => part.place.kind === "feature") ?? covering[0];
  }

  /**
   * For the integration runner only: claims the pending reviews, each with its form, baseline and
   * checkpoint (review-record.ts). A review whose form a part trial runs waits for that trial. Any
   * other role is refused.
   */
  claimReviews(caller: BridgeCaller): ReviewClaim {
    const trials = this.#partTrialStore();
    return claimReviews(this.#reviewStore(), caller, (review) => trialHolds(trials, review));
  }

  /**
   * For the integration runner only: claims the waiting trials of plan part revisions (part-trial.ts),
   * each with its target, fix, test commands and forms. Any other role is refused.
   */
  claimPartTrials(caller: BridgeCaller): PartTrialClaim {
    return claimPartTrials(this.#partTrialStore(), caller);
  }

  /**
   * Keeps the runner's report of trial `trialId` against its part revision and completes each form it
   * ran that still waits; an exception goes to the scope's owner. Penguin then approves each part of
   * the feature's plan whose checks are clean.
   */
  async reportPartTrial(caller: BridgeCaller, trialId: number, report: unknown, repos: ProjectRepos): Promise<PartTrialOutcome> {
    const personFor = await this.#reviewExceptionRoute(repos);
    const outcome = await this.#featuresChanging(recordPartTrial(
      {
        trials: this.#partTrialStore(),
        reviews: this.#reviewStore(),
        routeToOwner: (ownerId, review) => {
          this.#inboxStore().reviewException(ownerId, review.featureId, review.scopeId);
          sendToOwner(this.getConnections<{ owner?: string }>(), ownerId, inboxChangedMessage());
        },
        personFor,
      },
      caller,
      trialId,
      report,
    ));
    if (outcome.status === "recorded") {
      const featureId = outcome.trial.featureId;
      // A waiting write's trial on the head another write left decides its turn (fix-retrial.ts).
      await this.#featuresChanging(this.#planStep(() => retrialReported(this.#fixWriteDeps(repos), outcome.trial)));
      // A migration part's trial is decided by its own plan (migration-plans.ts); any other by the feature's plan.
      if (isMigrationPlanId(outcome.trial.planId)) await this.#featuresChanging(this.#planStep(() => migrationTrialReported(this.#migrationDeps(repos), outcome.trial)));
      else await this.#featuresChanging(this.#planStep(() => approveCleanParts(this.#planApprovalDeps(repos), featureId)));
    }
    return outcome;
  }

  #partTrialStore(): PartTrialStore {
    this.#trialRows ??= new PartTrialStore(this.#database());
    return this.#trialRows;
  }

  #trialDeps(): { readonly trials: PartTrialStore; readonly reviews: ReviewStore } {
    return { trials: this.#partTrialStore(), reviews: this.#reviewStore() };
  }

  /**
   * Attaches the runner's record to pending review `reviewId`. When the record raises an exception,
   * the scope's owner gets a `review_exception` inbox item. A recorded review may complete the checks
   * of a part of the feature's plan, so Penguin then approves each clean part (plan-approval.ts).
   */
  async reportReview(caller: BridgeCaller, reviewId: number, record: unknown, repos: ProjectRepos): Promise<ReviewReportOutcome> {
    const personFor = await this.#reviewExceptionRoute(repos);
    const outcome = await this.#featuresChanging(recordReview(
      {
        reviews: this.#reviewStore(),
        routeToOwner: (ownerId, review) => {
          this.#inboxStore().reviewException(ownerId, review.featureId, review.scopeId);
          sendToOwner(this.getConnections<{ owner?: string }>(), ownerId, inboxChangedMessage());
        },
        personFor,
      },
      caller,
      reviewId,
      record,
    ));
    if (outcome.status === "recorded") {
      const featureId = outcome.review.featureId;
      await this.#featuresChanging(this.#planStep(() => approveCleanParts(this.#planApprovalDeps(repos), featureId)));
    }
    return outcome;
  }

  /** The reviews of one feature, oldest first, each with its record once the runner attached it. */
  featureReviews(featureId: string): StoredReview[] {
    return this.#reviewStore().list(featureId);
  }

  /**
   * Every differing input of review `reviewId`'s side-by-side run (review-view.ts), for the dashboard's
   * full table; undefined for no such review or one the runner has not reported on. Any signed-in
   * person may read it, as the feature page shows every review to them.
   */
  reviewDifferences(reviewId: number): ReviewDifferences | undefined {
    const review = this.#reviewStore().get(reviewId);
    return review === undefined ? undefined : reviewDifferences(review);
  }

  /**
   * Tells every dashboard, once after the current task, that a feature, its merge plan, a part's
   * decision, a fix write or a review may have changed (live-feed.ts). It runs whether the write was
   * taken or refused; a refused write changed nothing, and the dashboards only read their views again.
   */
  #featuresChanging<T>(write: Promise<T>): Promise<T> {
    return write.finally(() => this.#liveFeed().featuresChanged());
  }

  #reviewStore(): ReviewStore {
    this.#reviewRows ??= new ReviewStore(this.#database());
    return this.#reviewRows;
  }

  /**
   * `whats_near` (agent-tools.ts): the running features near the paths or scopes `owner`'s session
   * names, each with its person and agent sessions. The call is recorded.
   */
  whatsNear(owner: string, sessionId: string, input: { readonly paths?: unknown; readonly scopes?: unknown }, repos: ProjectRepos): Promise<WhatsNearOutcome> {
    return whatsNear(this.#agentToolDeps(repos), owner, sessionId, input);
  }

  /**
   * `impact`, `check` or `apply_fix` (agent-tools.ts) on the feature `owner`'s session works on: the
   * request is checked and recorded for the check runner, at the feature's latest checkpoint.
   */
  requestAgentTool(
    owner: string,
    sessionId: string,
    tool: "impact" | "check" | "apply_fix",
    input: { readonly feature?: unknown; readonly kind?: unknown; readonly paths?: unknown; readonly edits?: unknown; readonly rules?: unknown },
    repos: ProjectRepos,
  ): Promise<ToolRequestOutcome> {
    return requestTool(this.#agentToolDeps(repos), owner, sessionId, tool, input);
  }

  /**
   * A call on the MCP server of review task `taskId`, whose task token the gateway accepted for
   * `owner` (review-task.ts, #138): checked against the task, then run as a session's call runs, as
   * the task's identity under its own session id.
   */
  reviewTaskCall(owner: string, taskId: number, call: ReviewTaskCall, repos: ProjectRepos): Promise<ReviewTaskCallOutcome> {
    return reviewTaskCall(
      {
        tasks: this.#editTaskStore(),
        routes: this.#planRouteStore(),
        identityId: (handle) => this.#identityStore().byHandle(handle)?.id,
        submit: (caller, session, input, heartbeat) => this.#submitReview(caller, session, input, repos, heartbeat),
        agentTools: this.#agentToolDeps(repos),
      },
      owner,
      taskId,
      call,
    );
  }

  /** The agent tool calls recorded on a feature, oldest first, for its page. */
  agentToolRuns(featureId: string): AgentToolRun[] {
    return this.#toolStore().list(featureId);
  }

  /**
   * For `get_work`: the tool results delivered to `caller`'s session `sessionId` at its safe
   * checkpoints, newest first. Empty for a session that is not the caller's.
   */
  agentToolResults(caller: string, sessionId: string): AgentToolRun[] {
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return [];
    return this.#toolStore().delivered(sessionId);
  }

  /**
   * For the integration runner only: claims the waiting `impact`, `check` and `apply_fix` requests,
   * each with its fork, checkpoint, baseline, charter and the other running features' forks
   * (agent-tool-runner.ts). Any other role is refused.
   */
  claimToolRuns(caller: BridgeCaller): Promise<ToolRunClaim> {
    const features = this.#featureStore();
    const readRepo: LandDeps["readRepo"] = (repo, use) => withRepo(this.env.ARTIFACTS, repo, (opened) => use(opened as unknown as ForkReader));
    return claimToolRuns(
      {
        runs: this.#toolStore(),
        features,
        identity: (identityId) => this.readIdentity(identityId),
        // `check` merges onto each fork's head with its written fixes, as a land does.
        targets: (own) => blockTargets({ features, readRepo }, own),
      },
      caller,
    );
  }

  /**
   * Attaches the runner's result to waiting tool request `runId`; the session hears of it at its next
   * safe checkpoint. A count of Penguin's own after a promotion goes on to the contract step
   * (retiring-count.ts); a failure there is logged and never fails the report. Penguin's read of
   * main's scope dependencies goes to the stored edges the team view reads (scope-edges.ts).
   */
  async reportToolRun(caller: BridgeCaller, runId: number, result: unknown, repos?: ProjectRepos): Promise<ToolReportOutcome> {
    const outcome = recordToolResult(this.#toolStore(), caller, runId, result);
    if (outcome.status === "recorded" && edgesReported(this.#scopeEdgeStore(), outcome.run)) this.#liveFeed().featuresChanged();
    if (outcome.status === "recorded") {
      try {
        const counted = await this.#planStep(() => countReported(this.#countDeps(repos), outcome.run));
        if (counted !== undefined && counted.proposed.length + counted.withdrawn.length > 0) this.#liveFeed().featuresChanged();
      } catch (error) {
        console.error(JSON.stringify({ event: "retiring_count_failed", run: runId, error: String(error).slice(0, 200) }));
      }
      // A count, a checkpoint's retiring-calls check or a rewrite request moves the split's migration
      // plans, which read the scope map from the project's repos.
      if (repos !== undefined) {
        try {
          const deps = this.#migrationDeps(repos);
          const changed = await this.#planStep(async () => [
            ...(await migrationsCounted(deps, outcome.run)),
            ...(await migrationsChecked(deps, outcome.run)),
            ...(await rewritesReported(deps, outcome.run)),
          ]);
          if (changed.length > 0) this.#liveFeed().featuresChanged();
        } catch (error) {
          console.error(JSON.stringify({ event: "migration_plans_failed", run: runId, error: String(error).slice(0, 200) }));
        }
      }
    }
    return outcome;
  }

  /** The split's migration plans and the contract step a feature Penguin opens carries (migration-plans.ts). */
  #migrationDeps(repos: ProjectRepos): MigrationDeps {
    return {
      store: this.#migrationStore(),
      features: this.#featureStore(),
      runs: this.#toolStore(),
      retiring: this.#retiringStore(),
      trials: this.#partTrialStore(),
      reviews: this.#reviewStore(),
      scopeMap: () => this.#scopeMap(repos),
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      openTask: (source, adjust) => openEditTask(this.#editWorkDeps(repos), source, adjust),
      tasks: this.#editTaskStore(),
      grants: this.#fixGrantStore(),
      invariants: async () => parseInvariantsBytes(await this.#baseFile(repos, INVARIANTS_PATH), await this.#scopeMap(repos)).invariants,
      // A feature Penguin opens goes through the overlap lock like any other (PRD 0.5 section 4.2 step 2).
      checkOverlap: (feature) => this.#lockStep(() => checkOverlap(this.#overlapDeps(repos), this.#featureStore().get(feature.id) ?? feature)),
      adminMode: this.#adminMode(),
      fork: (featureId) => this.#forkFromMain(repos, featureId),
      notify: (person) => sendToOwner(this.getConnections<{ owner?: string }>(), person, inboxChangedMessage()),
    };
  }

  /**
   * Forks main into the feature's repo for a feature Penguin opened, as the Worker forks one an agent
   * opens (apps/worker/src/repos.ts `forkFeatureRepo`): the name carries the base repo's deployment
   * prefix. A fork that already exists is kept. Null when the fork cannot be made.
   */
  async #forkFromMain(repos: ProjectRepos, featureId: string): Promise<string | null> {
    const prefix = repos.base.endsWith("base") ? repos.base.slice(0, -"base".length) : "";
    const name = `${prefix}feature-${featureId}`;
    const defaultBranchOnly = (this.env as unknown as ProjectAgentEnv).PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY !== "false";
    try {
      await withRepo(this.env.ARTIFACTS, repos.base, (base) => base.fork(name, { description: `Penguin feature ${featureId}`, defaultBranchOnly }));
      return name;
    } catch (error) {
      try {
        await withRepo(this.env.ARTIFACTS, name, async () => undefined);
        return name;
      } catch {
        console.error(JSON.stringify({ event: "penguin_fork_failed", feature: featureId, error: String(error).slice(0, 200) }));
        return null;
      }
    }
  }

  /**
   * Opens a feature Penguin opened again from main's head: its fork is deleted and forked from the base
   * repo under the same name (penguin-rebuild.ts). Null when the fork cannot be made again; a fork that
   * could not be deleted is kept as it is.
   */
  async #reforkFromMain(repos: ProjectRepos, featureId: string): Promise<string | null> {
    const prefix = repos.base.endsWith("base") ? repos.base.slice(0, -"base".length) : "";
    const name = `${prefix}feature-${featureId}`;
    try {
      if (!(await this.env.ARTIFACTS.delete(name))) return null;
    } catch (error) {
      console.error(JSON.stringify({ event: "penguin_refork_failed", feature: featureId, error: String(error).slice(0, 200) }));
      return null;
    }
    return this.#forkFromMain(repos, featureId);
  }

  #migrationStore(): MigrationStore {
    this.#migrations ??= new MigrationStore(this.#database());
    return this.#migrations;
  }

  /**
   * What counting the callers of retiring symbols and the contract step read and write
   * (retiring-count.ts). With the project's repos, a feature that no longer runs hands its contract
   * step to a feature Penguin opens from main (migration-plans.ts).
   */
  #countDeps(repos?: ProjectRepos): RetiringCountDeps {
    return {
      features: this.#featureStore(),
      runs: this.#toolStore(),
      retiring: this.#retiringStore(),
      facts: this.#planFactsStore(),
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
      ...(repos === undefined ? {} : { scopeMap: () => this.#scopeMap(repos) }),
      ...(repos === undefined ? {} : { carry: (featureId: string, symbols: readonly RetiringSymbol[], count: { readonly promotion: string; readonly runId: number }) => carryContract(this.#migrationDeps(repos), featureId, symbols, count) }),
    };
  }

  /**
   * After a promotion of `featureId` moved main to `mainAfter`: each symbol whose removal a landed
   * block carried closes as removed, then Penguin asks for one count of the remaining callers
   * (retiring-count.ts) and one read of main's scope dependencies (scope-edges.ts). A failure is
   * logged and never fails the promotion. Not a plan step: the
   * promoting FeatureAgent waits on this call, and a plan step may be waiting on that FeatureAgent.
   */
  async #countAfterPromotion(featureId: string, mainAfter: string, landed: boolean): Promise<void> {
    try {
      if (landed) await closeRemoved(this.#countDeps(), featureId, mainAfter);
      requestRetiringCount(this.#countDeps(), featureId, mainAfter);
    } catch (error) {
      console.error(JSON.stringify({ event: "retiring_count_failed", feature: featureId, error: String(error).slice(0, 200) }));
    }
    try {
      requestScopeEdges({ features: this.#featureStore(), runs: this.#toolStore() }, featureId, mainAfter);
    } catch (error) {
      console.error(JSON.stringify({ event: "scope_edges_failed", feature: featureId, error: String(error).slice(0, 200) }));
    }
  }

  #toolStore(): AgentToolStore {
    this.#toolRows ??= new AgentToolStore(this.#database());
    return this.#toolRows;
  }

  #agentToolDeps(repos: ProjectRepos): AgentToolDeps {
    return {
      features: this.#featureStore(),
      runs: this.#toolStore(),
      scopeMap: () => this.#scopeMap(repos),
      heartbeat: (caller, session) => this.sessionHeartbeat(caller, session),
      session: (session) => this.readSession(session),
      identity: (identityId) => this.readIdentity(identityId),
      baseline: (repo, sha) =>
        withRepo(this.env.ARTIFACTS, repo, (fork) => withRepo(this.env.ARTIFACTS, repos.base, (base) => checkpointBaseline(fork, base, sha))),
      retiring: () => this.#retiringStore().list(),
      split: (featureId) => this.#splitStore().get(featureId),
    };
  }

  /**
   * Takes a merge plan from `owner`'s session for the feature the session works on (propose-plan.ts):
   * fills in the facts, answers what is missing, returns a plan over the break limit, or signs the
   * plan and has the feature's own Durable Object keep it. Proposals run one at a time.
   */
  proposePlan(owner: string, sessionId: string, input: ProposePlanInput, repos: ProjectRepos): Promise<ProposePlanOutcome> {
    const run = this.#planSteps.then(async () => {
      const outcome = await proposePlan(
        {
          features: this.#featureStore(),
          facts: this.#planFactsStore(),
          keeper: (featureId) => this.#planKeeper(featureId),
          scopeMap: () => this.#scopeMap(repos),
          invariantsFile: () => this.#baseFile(repos, INVARIANTS_PATH),
          dependents: (featureId) => this.#overlapStore().dependents(featureId),
          readRepo: (repo, use) => withRepo(this.env.ARTIFACTS, repo, (opened) => use(opened as unknown as GitObjectReader)),
          heartbeat: (caller, session) => this.sessionHeartbeat(caller, session),
          sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
          breakLimit: parseBreakLimit((this.env as unknown as ProjectAgentEnv).PENGUIN_PLAN_BREAK_LIMIT),
          retiring: this.#retiringStore(),
          // An expand written first records its split from the plan's `retiring` (contract-split.ts).
          splits: this.#splitStore(),
          notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
          evidence: (featureId) => ({ reviews: this.#reviewStore().list(featureId).map(reviewResult), adminMode: this.#adminMode() }),
          exception: (personId, featureId) => {
            this.#inboxStore().planReturned(personId, featureId);
            sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage());
          },
          // Every author hears of their part at once (plan-approval.ts); the plan is then announced to
          // later features that meet its area (plan-coverage.ts).
          available: () => this.#available(),
          announce: (plan, scopeMap) => {
            announcePlan(this.#planApprovalDeps(repos), plan, scopeMap, this.#available());
            // Each part revision is tested on the tree it would land as (part-trial.ts).
            queueTrials(this.#trialDeps(), plan);
            this.#planCoverageStore().announce(plan, this.#featureStore().list(), scopeMap);
          },
        },
        owner,
        sessionId,
        input,
      );
      if (outcome.status !== "stored") return outcome;
      // Penguin approves each part whose checks are already clean; the answer shows who approved what.
      const featureId = outcome.plan.featureId;
      if ((await approveCleanParts(this.#planApprovalDeps(repos), featureId)).length === 0) return outcome;
      return { ...outcome, plan: (await this.#planKeeper(featureId).latestPlan(featureId)) ?? outcome.plan };
    });
    this.#planSteps = run.catch(() => undefined);
    return this.#featuresChanging(run);
  }

  /**
   * The dashboard's plan parts for `caller`, the person the dashboard session names (plan-approval.ts):
   * parts waiting on them as owner or delegate, parts that write a path they protect, parts of their
   * plans past the round limit and the reviews of their scopes that raised an exception.
   */
  async planInbox(caller: string, repos: ProjectRepos): Promise<PlanInbox> {
    const rules = await this.#reviewRules(repos);
    return buildPlanInbox(
      {
        routes: this.#planRouteStore(),
        reviews: this.#reviewStore(),
        keeper: (featureId) => this.#planKeeper(featureId),
        items: (person) => this.#inboxStore().items(person),
        scopeMap: async () => rules.scopeMap,
        delegates: async () => rules.delegates,
        roundLimit: this.#roundLimit(),
        adminMode: this.#adminMode(),
        landed: (featureId) => this.#featureStore().get(featureId)?.state === "landed",
        trial: (featureId, part) => trialStanding(this.#partTrialStore(), this.#reviewStore(), featureId, part),
        records: (featureId) => this.#featureStore().records(featureId),
        ownFeatures: (person) => this.#featureStore().list().filter((feature) => feature.personId === person && feature.state !== "landed").map((feature) => feature.id),
        protectedChanges: (owners, items, delegates, scopeMap) =>
          protectedChangeRequests(this.#protectedChangeStore(), this.#featureStore(), items, owners, caller, delegates, scopeMap),
      },
      caller,
    );
  }

  /** The dashboard's team view (dashboard-views.ts): every person with their role, features and agents. */
  async teamView(caller: string, repos: ProjectRepos): Promise<TeamView> {
    return buildTeamView(await this.#dashboardViewDeps(repos), caller);
  }

  /** One person's full role for the person page (dashboard-views.ts): the scope map and the stored edges, no runner call. */
  async personScopes(person: string, repos: ProjectRepos): Promise<PersonScopes> {
    const rules = await this.#reviewRules(repos);
    return buildPersonScopes({ scopeMap: async () => rules.scopeMap, scopeEdges: () => this.#scopeEdgeStore().snapshot() }, person);
  }

  /** One feature's page as `caller` may see it (dashboard-views.ts), or undefined for no such feature. */
  async featurePage(caller: string, featureId: string, repos: ProjectRepos): Promise<FeaturePage | undefined> {
    return buildFeaturePage(await this.#dashboardViewDeps(repos), featureId, caller);
  }

  async #dashboardViewDeps(repos: ProjectRepos): Promise<DashboardViewDeps> {
    const rules = await this.#reviewRules(repos);
    // Every task's state is brought up to date before a view shows it.
    await this.#syncEditWork(repos);
    return {
      // A task whose write waits for its fork's turn names why, for its waiting branch (fix-write.ts).
      editTasks: (featureId) => this.#editTaskStore().forFeature(featureId).map((task) => editTaskView(task, writeWaitsFor(this.#fixGrantStore(), task))),
      steward: (person) => this.#stewardView(person),
      features: this.#featureStore(),
      overlaps: this.#overlapStore(),
      routes: this.#planRouteStore(),
      reviews: this.#reviewStore(),
      tools: this.#toolStore(),
      session: (sessionId) => this.#sessionStore().get(sessionId),
      identities: () => this.#identityStore().list(),
      factsRun: (featureId, checkpoint) => this.#planFactsStore().forCheckpoint(featureId, checkpoint)?.state,
      scopeMap: async () => rules.scopeMap,
      delegates: async () => rules.delegates,
      plan: async (featureId) => this.#planKeeper(featureId).latestPlan(featureId),
      roundLimit: this.#roundLimit(),
      fixWrite: (partId, revision) => {
        const grants = this.#fixGrantStore();
        const grant = grants.get(partId, revision);
        if (grant === undefined) return undefined;
        const open = grant.state === "queued" || grant.state === "granted";
        return { ...grant, waitsFor: open ? grants.waitsFor(grant) : null };
      },
      incomingWrites: (featureId) => {
        const grants = this.#fixGrantStore();
        return grants
          .openOn(featureId)
          .filter((grant) => grant.featureId !== featureId && grants.waitsFor(grant) !== null)
          .map((grant) => ({ partId: grant.partId, feature: grant.featureId, person: this.#featureStore().get(grant.featureId)?.personId ?? grant.featureId }));
      },
      contract: (feature) => contractWork(this.#splitDeps(), feature, rules.scopeMap),
      stoppedRuns: (featureId) => this.#runFailureStore().stopped(featureId),
      protectedChanges: (featureId) => this.#protectedChangeStore().ofFeature(featureId),
      split: (featureId) => this.#splitStore().get(featureId),
      scopeEdges: () => this.#scopeEdgeStore().snapshot(),
    };
  }

  /**
   * `caller`, the person the dashboard session names, approves one revision of a plan part. Only the
   * part's owner or their delegate may, once; the approval is a signed record. Runs after the plan
   * steps before it.
   */
  approvePlanPart(caller: string, input: PartDecisionInput, repos: ProjectRepos): Promise<PartDecisionOutcome> {
    return this.#featuresChanging(this.#planStep(() => approvePlanPart(this.#planApprovalDeps(repos), caller, input)));
  }

  /** `caller` asks for a change to one revision of a plan part; see plan-approval.ts. */
  requestPlanChange(caller: string, input: ChangeRequestInput, repos: ProjectRepos): Promise<PartDecisionOutcome> {
    return this.#featuresChanging(this.#planStep(() => requestPlanChange(this.#planApprovalDeps(repos), caller, input)));
  }

  /**
   * `caller` reverses Penguin's approval of one revision of a plan part, until the block lands. Only
   * the part's owner or their delegate may; the part then waits on them in person (plan-approval.ts).
   */
  reversePenguinApproval(caller: string, input: PartDecisionInput, repos: ProjectRepos): Promise<PartDecisionOutcome> {
    return this.#featuresChanging(this.#planStep(() => reversePenguinApproval(this.#planApprovalDeps(repos), caller, input)));
  }

  /**
   * `revise_plan_part`: the originating agent's revision of a part its author asked to change. Penguin
   * approves the revision at once when its checks are clean.
   */
  revisePlanPart(owner: string, sessionId: string, input: RevisionInput, repos: ProjectRepos): Promise<PartDecisionOutcome> {
    return this.#featuresChanging(
      this.#planStep(async () => {
        const deps = this.#planApprovalDeps(repos);
        const outcome = await revisePlanPart(
          {
            ...deps,
            facts: this.#planFactsStore(),
            scopeMap: () => this.#scopeMap(repos),
            readRepo: (repo, use) => withRepo(this.env.ARTIFACTS, repo, (opened) => use(opened as unknown as GitObjectReader)),
            heartbeat: (caller, session) => this.sessionHeartbeat(caller, session),
          },
          owner,
          sessionId,
          input,
        );
        if (outcome.status !== "ok") return outcome;
        const featureId = this.#featureStore().featureOfSession(sessionId) as string;
        // The revision gets its own trial; the older revision's no longer counts.
        const plan = await this.#planKeeper(featureId).latestPlan(featureId);
        if (plan !== undefined) queueTrials(this.#trialDeps(), plan, plan.parts.filter((part) => part.partId === outcome.part.partId));
        const approved = (await approveCleanParts(deps, featureId)).find((part) => part.partId === outcome.part.partId);
        return approved === undefined ? outcome : { ...outcome, part: approved };
      }),
    );
  }

  /**
   * Advance notice for `get_work`: the parts waiting on `caller`, the plan of the feature the session
   * works on and the runner's verdicts on the session's reviews; undefined for another owner's session.
   */
  async planWork(caller: string, sessionId: string): Promise<PlanWork | undefined> {
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return undefined;
    const deps = { features: this.#featureStore(), routes: this.#planRouteStore(), reviews: this.#reviewStore(), keeper: (id: string) => this.#planKeeper(id) };
    return planWork(deps, caller, sessionId, this.#roundLimit());
  }

  #planApprovalDeps(repos: ProjectRepos): PlanApprovalDeps {
    return {
      features: this.#featureStore(),
      routes: this.#planRouteStore(),
      inbox: this.#inboxStore(),
      keeper: (featureId) => this.#planKeeper(featureId),
      delegates: async () => (await this.#reviewRules(repos)).delegates,
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      roundLimit: this.#roundLimit(),
      notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
      // An approved part on a running feature takes its place in its fork's order of writes (fix-write.ts):
      // the check runner writes a mechanical one, the originating agent or its fix task a behavioural one.
      approved: (featureId, plan, part) => openFixWrite(this.#fixGrantStore(), featureId, plan, part),
      // A reversed approval withdraws its revision's write while it has not happened yet.
      reversed: (_featureId, part) => {
        const grant = this.#fixGrantStore().get(part.partId, part.revision);
        if (grant !== undefined) this.#fixGrantStore().withdraw(grant.id);
      },
      checks: {
        reviews: (featureId) => this.#reviewStore().list(featureId),
        scopeMap: () => this.#scopeMap(repos),
        adminMode: this.#adminMode(),
        trial: (featureId, part) => trialStanding(this.#partTrialStore(), this.#reviewStore(), featureId, part),
      },
      available: () => this.#available(),
    };
  }

  /** PENGUIN_PLAN_ADMIN_MODE: whether a person approves every plan part. */
  #adminMode(): boolean {
    return parseAdminMode((this.env as unknown as ProjectAgentEnv).PENGUIN_PLAN_ADMIN_MODE);
  }

  /**
   * `fix_token`: a write on the affected fork for the originating agent's session, for the current
   * approved revision of a behavioural part (fix-write.ts). The Worker mints the token on the grant's
   * repo alone, so its plaintext never reaches this agent. Runs after the plan steps before it.
   */
  fixWriteGrant(owner: string, sessionId: string, input: FixPartInput, repos: ProjectRepos): Promise<FixGrantOutcome> {
    return this.#planStep(() => agentFixGrant(this.#fixWriteDeps(repos), (caller, session) => this.sessionHeartbeat(caller, session), owner, sessionId, input));
  }

  /** `report_fix_write`: checks the commit the originating agent pushed and keeps it as a signed record. */
  reportFixWrite(owner: string, sessionId: string, input: FixPartInput & { readonly commit: unknown }, repos: ProjectRepos): Promise<FixWriteOutcome> {
    return this.#featuresChanging(this.#planStep(() => agentFixReport(this.#fixWriteDeps(repos), (caller, session) => this.sessionHeartbeat(caller, session), owner, sessionId, input)));
  }

  /** The check runner's claim of the mechanical parts' writes; refused unless `caller` holds the runner role. */
  claimFixWrites(caller: BridgeCaller, repos: ProjectRepos): ReturnType<typeof claimRunnerWrites> {
    return this.#planStep(() => claimRunnerWrites(this.#fixWriteDeps(repos), caller));
  }

  /** The check runner reports the commit of write `writeId`, which it claimed. */
  async reportRunnerFixWrite(caller: BridgeCaller, writeId: number, body: unknown, repos: ProjectRepos): Promise<FixWriteOutcome> {
    const outcome = await this.#featuresChanging(this.#planStep(() => runnerFixReport(this.#fixWriteDeps(repos), caller, writeId, body)));
    // A migration part written into a block feature may be its last (penguin-land.ts).
    if (outcome.status === "ok") await this.#landPenguinFeatures(repos);
    return outcome;
  }

  #fixWriteDeps(repos: ProjectRepos): FixWriteDeps {
    const approval = this.#planApprovalDeps(repos);
    const deps: FixWriteDeps = {
      features: approval.features,
      routes: approval.routes,
      keeper: approval.keeper,
      sign: approval.sign,
      notify: approval.notify,
      grants: this.#fixGrantStore(),
      scopeMap: () => this.#scopeMap(repos),
      readFork: (repo, use) => withRepo(this.env.ARTIFACTS, repo, (opened) => use(opened as unknown as ForkReader)),
      // The identity a fix's edit task was routed to writes it too (PRD 0.5 section 4.4a).
      holds: (sessionId, partId, revision) => holdsFixTask(this.#editTaskStore(), sessionId, partId, revision),
      // An approved rule-written migration part is written by the runner the same way (migration-plans.ts).
      migration: migrationWrites(this.#migrationDeps(repos)),
      // A fork whose start waits on an overlap lock gets no write token yet.
      locked: (featureId) => this.#overlapStore().status(featureId).waitingOn.length > 0,
      tokenLeaseMs: parseFixTokenLease((this.env as unknown as ProjectAgentEnv).PENGUIN_FIX_TOKEN_TTL_MINUTES),
      // A kept write moves its fork: every other write waiting there is tried on the new head first (fix-retrial.ts).
      written: async (grant, commit) => {
        await retryWaitingWrites({ ...deps, queueTrial: (plan, part, head) => queueTrialOn(this.#trialDeps(), plan, part, head)?.id ?? null }, grant, commit);
      },
    };
    return deps;
  }

  // Edit tasks (PRD 0.5 section 4.4a, edit-work.ts).

  /** For `get_work`: the edit tasks delivered to `caller`'s session and the person's queue; undefined for another person's session. */
  async editTaskWork(caller: string, sessionId: string, repos: ProjectRepos): Promise<{ readonly tasks: EditTaskView[]; readonly queue: EditQueue } | undefined> {
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return undefined;
    await this.#syncEditWork(repos);
    return { tasks: this.#editTaskStore().forSession(sessionId).map((task) => editTaskView(task)), queue: this.#editTaskStore().queue(caller, this.#backgroundRunCap()) };
  }

  /**
   * The bridge of `caller.ownerId` claims that person's waiting edit tasks, up to the project's cap of
   * background runs. The Worker mints each task's token on its fork alone.
   */
  claimEditTasks(caller: { readonly bridgeId: string; readonly ownerId: string }, repos: ProjectRepos): Promise<EditClaim> {
    return this.#planStep(() => claimEditTasks(this.#editWorkDeps(repos), caller.ownerId, caller.bridgeId));
  }

  /** The claiming bridge reports one run's end: done with its commit, failed or timed out. */
  async reportEditTask(caller: { readonly bridgeId: string; readonly ownerId: string }, taskId: number, body: unknown, repos: ProjectRepos): Promise<EditReportOutcome> {
    const outcome = await this.#planStep(() => reportEditTask(this.#editWorkDeps(repos), caller.ownerId, caller.bridgeId, taskId, body));
    // A migration part's task done writes the part; one whose run failed sends it to a person (migration-plans.ts).
    if (outcome.status === "ok" && outcome.task.kind === "migration") await this.#settleMigrationTasks(repos, taskId);
    // A task done in a feature Penguin opened may write its last part or its removal, or fix its failed block (penguin-land.ts).
    if (outcome.status === "ok" && this.#migrationStore().openedByPenguin(outcome.task.target)) await this.#landPenguinFeatures(repos);
    return outcome;
  }

  /** A block run of the feature reported (block-land.ts): its agent steps become next-step tasks, or a pass does them. */
  async blockReported(featureId: string, run: { readonly runId: string; readonly checkpoint: string; readonly passed: boolean }, decisions: readonly LadderDecision[], repos: ProjectRepos): Promise<void> {
    // A feature Penguin opened has no builder: its next steps reach the steward of its person.
    const migrations = this.#migrationStore();
    await blockReported(this.#editWorkDeps(repos), featureId, run, decisions, migrations.openedByPenguin(featureId) ? stewardsFor(migrations) : undefined);
    this.#liveFeed().featuresChanged();
  }

  /**
   * Brings every edit task up to date (edit-work.ts `syncEditWork`); a migration part whose task's
   * claim ran out with no report goes to a person then (migration-plans.ts). A failure there is logged.
   */
  async #syncEditWork(repos: ProjectRepos): Promise<void> {
    await syncEditWork(this.#editWorkDeps(repos));
    await this.#settleMigrationTasks(repos, null);
  }

  /** Each migration part whose edit task was done or failed moves on, after the plan steps before it. */
  async #settleMigrationTasks(repos: ProjectRepos, taskId: number | null): Promise<void> {
    try {
      const changed = await this.#planStep(() => migrationTasksSettled(this.#migrationDeps(repos)));
      if (changed.length > 0) {
        this.#liveFeed().featuresChanged();
        await this.#landPenguinFeatures(repos);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "migration_tasks_failed", task: taskId, error: String(error).slice(0, 200) }));
    }
  }

  #penguinLandStore(): PenguinLandStore {
    this.#penguinLands ??= new PenguinLandStore(this.#database());
    return this.#penguinLands;
  }

  /**
   * Penguin lands each feature it opened whose parts are all written (penguin-land.ts): its fork head
   * recorded as its checkpoint, then the block check and promotion. Sweeps run one at a time and
   * outside the plan steps, since recording a checkpoint takes plan steps of its own; only the land
   * request is one. A failure is logged and never fails the report that asked for the sweep.
   */
  #landPenguinFeatures(repos: ProjectRepos): Promise<PenguinLandAttempt[]> {
    const sweep = this.#penguinLandSweeps.then(async () => {
      try {
        const land = this.#landDeps(repos);
        const attempts = await landPenguinFeatures({
          migrations: this.#migrationStore(),
          lands: this.#penguinLandStore(),
          features: this.#featureStore(),
          tasks: this.#editTaskStore(),
          forkHead: async (repo) => (await land.readRepo(repo, (reader) => reader.log({ ref: FIX_WRITE_BRANCH, limit: 1 })))[0]?.hash ?? null,
          mainHead: async () => (await mainState(land)).head,
          checkpoint: async (feature, sha) => {
            const recorded = await recordPenguinCheckpoint(this.#featureCheckpointDeps(repos), feature, sha);
            return recorded.status === "ok" ? recorded.feature : undefined;
          },
          factsWaiting: (feature) =>
            feature.latestCheckpointSha !== null && this.#planFactsStore().forCheckpoint(feature.id, feature.latestCheckpointSha)?.state === "pending",
          charter: (person) => {
            const steward = this.#editRosterStore().stewardOf(person);
            return steward === undefined ? undefined : land.charter(steward.handle, person);
          },
          land: (featureId, charter) => this.#planStep(() => requestPenguinLand(land, featureId, charter)),
          sign: land.sign,
          notify: land.notify,
          // A fork main moved past is rebuilt from main, never merged (penguin-rebuild.ts, #143).
          rebuild: {
            holdsMain: async (repo, head, main) => {
              const { history } = await mainState(land);
              return (await land.readRepo(repo, (reader) => ancestorsFound(reader, head, new Set([main]), history))).has(main);
            },
            run: (feature, kind, head, main) =>
              this.#planStep(() =>
                rebuildPenguinFeature(
                  { ...this.#migrationDeps(repos), readFork: land.readRepo, refork: (featureId) => this.#reforkFromMain(repos, featureId) },
                  feature,
                  kind,
                  head,
                  main,
                ),
              ),
          },
        });
        if (attempts.length > 0) this.#liveFeed().featuresChanged();
        return attempts;
      } catch (error) {
        console.error(JSON.stringify({ event: "penguin_land_failed", error: String(error).slice(0, 200) }));
        return [];
      }
    });
    this.#penguinLandSweeps = sweep;
    return sweep;
  }

  /** Opens an edit task from another source, such as a migration part of a split (#131). */
  openEditTask(source: EditSource, repos: ProjectRepos): Promise<EditTask[]> {
    return openEditTask(this.#editWorkDeps(repos), source);
  }

  /** Delivers the waiting edit tasks a running session counts for: its next safe checkpoint. */
  #deliverEditTasks(sessionId: string): void {
    const session = this.#sessionStore().get(sessionId);
    if (session === undefined || session.status !== "running") return;
    deliverEditTasks({ tasks: this.#editTaskStore(), features: this.#featureStore() }, session);
  }

  /** A person's steward and queue for the team view; null when the person has no steward yet. */
  #stewardView(person: string): StewardView | null {
    const charter = this.#editRosterStore().stewardOf(person);
    const identity = charter === undefined ? undefined : this.#identityStore().byHandle(charter.handle);
    if (identity === undefined) return null;
    const tasks = this.#editTaskStore();
    return { handle: identity.handle, identityId: identity.id, online: tasks.bridgeOnline(person), ...tasks.queue(person, this.#backgroundRunCap()) };
  }

  #editWorkDeps(repos: ProjectRepos): EditWorkDeps {
    const minutes = parseEditRunMinutes((this.env as unknown as ProjectAgentEnv).PENGUIN_EDIT_RUN_MINUTES);
    return {
      taskTokens: this.#mcpTokenStore(),
      tasks: this.#editTaskStore(),
      roster: this.#editRosterStore(),
      features: this.#featureStore(),
      routes: this.#planRouteStore(),
      grants: this.#fixGrantStore(),
      reviews: (featureId) => this.#reviewStore().list(featureId),
      scopeMap: () => this.#scopeMap(repos),
      running: () => this.#sessionStore().running(),
      plan: (featureId) => this.#planKeeper(featureId).latestPlan(featureId),
      fix: this.#fixWriteDeps(repos),
      cap: this.#backgroundRunCap(),
      leaseMs: minutes ?? EDIT_RUN_MINUTES_DEFAULT * 60_000,
      notify: (person) => {
        this.#liveFeed().featuresChanged();
        sendToOwner(this.getConnections<{ owner?: string }>(), person, inboxChangedMessage());
      },
    };
  }

  /** PENGUIN_BACKGROUND_RUN_CAP, or the default when unset or out of range. */
  #backgroundRunCap(): number {
    return parseBackgroundRunCap((this.env as unknown as ProjectAgentEnv).PENGUIN_BACKGROUND_RUN_CAP) ?? BACKGROUND_RUN_CAP_DEFAULT;
  }

  #editTaskStore(): EditTaskStore {
    this.#editTasks ??= new EditTaskStore(this.#database());
    return this.#editTasks;
  }

  #editRosterStore(): EditRoster {
    this.#editRoster ??= new EditRoster(this.#database(), this.#identityStore());
    return this.#editRoster;
  }

  #fixGrantStore(): FixGrantStore {
    this.#fixGrants ??= new FixGrantStore(this.#database());
    return this.#fixGrants;
  }

  #planCoverageStore(): PlanCoverageStore {
    this.#planCoverage ??= new PlanCoverageStore(this.#database());
    return this.#planCoverage;
  }

  /** Main's scope dependencies from the last promotion's derivation (scope-edges.ts). */
  #scopeEdgeStore(): ScopeEdgeStore {
    this.#scopeEdges ??= new ScopeEdgeStore(this.#database());
    return this.#scopeEdges;
  }

  /** The project's retiring symbols, declared by stored merge plans (retiring-store.ts). */
  #retiringStore(): RetiringStore {
    this.#retiring ??= new RetiringStore(this.#database());
    return this.#retiring;
  }

  #splitStore(): ContractSplitStore {
    this.#splits ??= new ContractSplitStore(this.#database());
    return this.#splits;
  }

  /** What sorting a contract diff and splitting a feature read and write (contract-split.ts). */
  #splitDeps(): ContractSplitDeps {
    return {
      features: this.#featureStore(),
      facts: this.#planFactsStore(),
      splits: this.#splitStore(),
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      dependents: (featureId) => this.#overlapStore().dependents(featureId),
      retiring: this.#retiringStore(),
      notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
      contractSteps: (featureId) => this.#retiringStore().contractSteps(featureId),
      migrationPlans: (featureId) => this.#migrationStore().plans(featureId),
    };
  }

  /**
   * For `get_work`: how Penguin sorted the latest checkpoint of the feature `caller`'s session works
   * on, its split and its next step (contract-split.ts). A sort that splits is recorded first.
   * Undefined when the session works on no feature or is not the caller's.
   */
  async contractWork(caller: string, sessionId: string, repos: ProjectRepos): Promise<ContractWorkView | undefined> {
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return undefined;
    const featureId = this.#featureStore().featureOfSession(sessionId);
    const feature = featureId === undefined ? undefined : this.#featureStore().get(featureId);
    if (feature === undefined) return undefined;
    const scopeMap = await this.#scopeMap(repos);
    await this.#planStep(() => recordSplit(this.#splitDeps(), feature, scopeMap));
    return contractWork(this.#splitDeps(), feature, scopeMap);
  }

  #roundLimit(): number | undefined {
    return parseRoundLimit((this.env as unknown as ProjectAgentEnv).PENGUIN_PLAN_ROUND_LIMIT);
  }

  /** Runs one plan step (a proposal, a decision or a revision) after the ones before it. */
  #planStep<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#planSteps.then(step);
    this.#planSteps = run.catch(() => undefined);
    return run;
  }

  #planRouteStore(): PlanRouteStore {
    this.#planRoutes ??= new PlanRouteStore(this.#database());
    return this.#planRoutes;
  }

  #protectedChangeStore(): ProtectedChangeStore {
    this.#protectedChanges ??= new ProtectedChangeStore(this.#database());
    return this.#protectedChanges;
  }

  /**
   * `caller`, the person the dashboard session names, confirms the lines a feature's own change writes
   * under paths `input.owner` protects (protected-change.ts). Only that person or their delegate may.
   */
  confirmProtectedChange(caller: string, input: ProtectedConfirmInput, repos: ProjectRepos): Promise<ProtectedConfirmOutcome> {
    return this.#featuresChanging(
      this.#planStep(() =>
        confirmProtectedChange(
          {
            store: this.#protectedChangeStore(),
            inbox: this.#inboxStore(),
            notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
            features: this.#featureStore(),
            delegates: async () => (await this.#reviewRules(repos)).delegates,
            sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
          },
          caller,
          input,
        ),
      ),
    );
  }

  /** The facts runs waiting for the check runner; refused unless `caller` holds the runner role. */
  planFactsRuns(caller: BridgeCaller): { readonly status: "ok"; readonly runs: PlanFactsRequest[] } | { readonly status: "forbidden"; readonly message: string } {
    if (caller.role !== "runner") return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    return { status: "ok", runs: this.#planFactsStore().pending() };
  }

  /**
   * Records the runner's report of facts run `runId`; refused unless `caller` holds the runner role.
   * With `repos`, a report of a feature's latest checkpoint is sorted, and a split recorded
   * (contract-split.ts); a failure there is logged and never refuses the report.
   */
  async reportPlanFacts(caller: BridgeCaller, runId: string, report: unknown, repos?: ProjectRepos): Promise<PlanFactsReportOutcome> {
    if (caller.role !== "runner") {
      return { status: "rejected", reason: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    }
    this.#liveFeed().featuresChanged();
    const outcome = this.#planFactsStore().record(runId, caller.bridgeId, report);
    const feature = outcome.status === "recorded" ? this.#featureStore().get(this.#planFactsStore().get(runId)?.featureId ?? "") : undefined;
    if (repos !== undefined && feature !== undefined) {
      try {
        const scopeMap = await this.#scopeMap(repos);
        await this.#planStep(() => recordSplit(this.#splitDeps(), feature, scopeMap));
      } catch (error) {
        console.error(JSON.stringify({ event: "contract_sort_failed", feature: feature.id, error: String(error).slice(0, 200) }));
      }
      // A contract carrier lands once its checkpoint's facts are in, so its promotion can close the symbols (penguin-land.ts).
      if (this.#migrationStore().openedByPenguin(feature.id)) await this.#landPenguinFeatures(repos);
    }
    return outcome;
  }

  /**
   * The feature's newest merge plan as `caller` may see it (dashboard-views.ts): a part's patch and
   * changed lines only for the feature's person, the part's owner and that owner's delegate.
   */
  async featurePlan(caller: string, featureId: string, repos: ProjectRepos): Promise<ViewerPlan | undefined> {
    return buildFeaturePlan(await this.#dashboardViewDeps(repos), featureId, caller);
  }

  #planFactsStore(): PlanFactsStore {
    this.#planFacts ??= new PlanFactsStore(this.#database());
    return this.#planFacts;
  }

  /** The plan store of one feature: its FeatureAgent (plan-store.ts). */
  #planKeeper(featureId: string): PlanKeeper {
    return this.#featureAgent(featureId);
  }

  /**
   * One feature's FeatureAgent, named `<project>-feature-<id>` apart from every Huddle's instance. It
   * keeps the feature's plan, fix writes, block runs and promotion.
   */
  #featureAgent(featureId: string): PlanKeeper & FeatureBlocks & { landing(featureId: string): Promise<FeatureLanding> } {
    type Stub = PlanKeeper & FeatureBlocks & { landing(featureId: string): Promise<FeatureLanding> };
    const named = getAgentByName(this.env.FeatureAgent, `${this.name}-feature-${featureId}`) as unknown as Promise<Stub>;
    return {
      planVersion: async (id) => (await named).planVersion(id),
      keepPlan: async (plan) => (await named).keepPlan(plan),
      latestPlan: async (id) => (await named).latestPlan(id),
      replacePart: async (id, part, expected) => (await named).replacePart(id, part, expected),
      addPart: async (id, planId, part) => (await named).addPart(id, planId, part),
      keepFixWrite: async (write) => (await named).keepFixWrite(write),
      fixWrites: async (id) => (await named).fixWrites(id),
      openBlockRun: async (input) => (await named).openBlockRun(input),
      claimBlockRuns: async (runnerId) => (await named).claimBlockRuns(runnerId),
      releaseBlockRun: async (runnerId, runId) => (await named).releaseBlockRun?.(runnerId, runId) ?? { status: "rejected", reason: "not_found", message: `no block run ${runId}` },
      stopBlockRun: async (runId, reason) => (await named).stopBlockRun?.(runId, reason),
      landing: async (id) => (await named).landing(id),
    };
  }

  /**
   * For the check runner only: a runner reports that it failed run `runId` of `kind`, which it claimed
   * (run-failures.ts). Penguin releases the run at once for any runner. At PENGUIN_RUN_FAILURE_LIMIT
   * failures the run is stopped and its feature's person gets the exception with the reason.
   */
  reportRunFailure(caller: BridgeCaller, body: unknown): Promise<RunFailureOutcome> {
    const features = this.#featureStore();
    const stores: RunStores = {
      combined: this.#combinedRunStore(),
      reviews: this.#reviewStore(),
      tools: this.#toolStore(),
      planFacts: this.#planFactsStore(),
      fixGrants: this.#fixGrantStore(),
      trials: this.#partTrialStore(),
      block: async (featureId, runId, runnerId) => this.#featureAgent(featureId).releaseBlockRun!(runnerId, runId),
      personOf: (featureId) => features.get(featureId)?.personId,
    };
    return reportRunFailure(
      {
        failures: this.#runFailureStore(),
        limit: parseRunFailureLimit((this.env as unknown as ProjectAgentEnv).PENGUIN_RUN_FAILURE_LIMIT),
        release: (kind, runId, runnerId) => releaseRun(stores, kind, runId, runnerId),
        stopped: async (failure) => this.#runStopped(failure),
      },
      caller,
      body,
    );
  }

  /** A run reached the failure limit: a block run fails, and the person hears of it in the inbox. */
  async #runStopped(failure: RunFailure): Promise<void> {
    if (failure.kind === "block" && failure.featureId !== null) {
      const purpose = await this.#featureAgent(failure.featureId).stopBlockRun!(failure.runId, failure.reason);
      // As a failed report does: a land or expand run returns its feature to building.
      if (purpose !== undefined && purpose !== "plan_check") this.landFailed(failure.featureId, failure.runId);
    }
    this.#inboxStore().runFailed(failure.personId, failure.kind, failure.runId);
    this.#liveFeed().featuresChanged();
    sendToOwner(this.getConnections<{ owner?: string }>(), failure.personId, inboxChangedMessage());
  }

  #runFailureStore(): RunFailureStore {
    this.#runFailures ??= new RunFailureStore(this.#database());
    return this.#runFailures;
  }

  #blockQueueStore(): BlockQueueStore {
    this.#blockQueue ??= new BlockQueueStore(this.#database());
    return this.#blockQueue;
  }

  #landDeps(repos: ProjectRepos): LandDeps {
    return {
      features: this.#featureStore(),
      heartbeat: (caller, session) => this.sessionHeartbeat(caller, session),
      charter: (handle, person) => {
        const identity = this.#identityStore().byHandle(handle);
        if (identity === undefined) return undefined;
        // A team identity has no one owner; the feature's person then receives its exceptions.
        return { handle: identity.handle, person: identity.ownerId ?? person, scopes: [...identity.charterScopes], paths: [...identity.charterPaths] };
      },
      agent: (featureId) => this.#featureAgent(featureId),
      readRepo: (repo, use) => withRepo(this.env.ARTIFACTS, repo, (opened) => use(opened as unknown as ForkReader)),
      baseRepo: repos.base,
      branch: BASE_BRANCH,
      queue: this.#blockQueueStore(),
      unconfirmedProtected: (featureId) => unconfirmedProtected(this.#protectedChangeStore(), featureId),
      sign: async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey),
      notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()),
    };
  }

  /** What promoting an expand checkpoint reads besides a land (expand-promotion.ts). */
  #expandDeps(repos: ProjectRepos): ExpandDeps {
    const overlaps = this.#overlapDeps(repos);
    return {
      ...this.#landDeps(repos),
      db: this.#database(),
      facts: this.#planFactsStore(),
      scopeMap: () => this.#scopeMap(repos),
      dependents: (featureId) => this.#overlapStore().dependents(featureId),
      overlaps: this.#overlapStore(),
      ...(overlaps.listener === undefined ? {} : { listener: overlaps.listener }),
      splits: this.#splitStore(),
    };
  }

  /**
   * `land_feature` (block-land.ts): `owner`'s session asks to land the feature it works on, or with
   * `expand: true` to promote its latest checkpoint on its own (expand-promotion.ts). A ready block run
   * waits for the check runner; anything else is refused with what is missing. Runs after the plan
   * steps before it.
   */
  landFeature(owner: string, sessionId: string, input: LandInput & { readonly expand?: unknown; readonly retiring?: unknown }, repos: ProjectRepos): Promise<LandAnswer> {
    const { expand, ...rest } = input;
    if (expand !== undefined && typeof expand !== "boolean") return Promise.resolve({ status: "rejected", reason: "invalid", message: "expand must be true or false" });
    if (rest.retiring !== undefined && expand !== true) return Promise.resolve({ status: "rejected", reason: "invalid", message: "only an expand names retiring replacements" });
    return this.#featuresChanging(
      this.#planStep(async () =>
        landAnswer(expand === true ? await requestExpand(this.#expandDeps(repos), owner, sessionId, rest) : await requestLand(this.#landDeps(repos), owner, sessionId, rest)),
      ),
    );
  }

  /** For the check runner only: the waiting block runs of every feature, each claimed by `caller`. */
  claimBlockRuns(caller: BridgeCaller): Promise<{ readonly status: "ok"; readonly runs: readonly BlockRunRequest[] } | { readonly status: "forbidden"; readonly message: string }> {
    return claimBlockRuns(this.#blockQueueStore(), (featureId) => this.#featureAgent(featureId), caller);
  }

  // The port a FeatureAgent calls while it records a block run and promotes (block-land.ts
  // BlockProjectPort). The service key signs here and never leaves this agent.

  /** Signs one block record on the feature; only the FeatureAgent's record types are signed. */
  async signBlockRecord(featureId: string, type: string, payload: Record<string, unknown>): Promise<string> {
    return signBlockRecord(this.#featureStore(), async (record) => signFeatureRecord(record, (await this.#loadServiceKey()).privateKey), featureId, type, payload);
  }

  /** Takes the project's one promotion slot for `runId`. */
  acquirePromotion(featureId: string, runId: string): boolean {
    return this.#blockQueueStore().acquire(featureId, runId);
  }

  releasePromotion(runId: string): void {
    this.#blockQueueStore().release(runId);
  }

  /**
   * Main moved to the feature's checkpoint: the feature is landed, its plan retired and the starts it
   * held checked again. The symbols its block removed close, and the callers of the rest are counted.
   */
  async featureLanded(featureId: string, promotion: Promotion, repos: ProjectRepos): Promise<void> {
    const notify = (personId: string) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage());
    // Penguin's approvals of the block's parts stand once it lands, so their reversible items go.
    for (const person of new Set(this.#inboxStore().blockLanded(featureId))) notify(person);
    featureLandedTasks(this.#editTaskStore(), featureId);
    try {
      await migrationBlockLanded(this.#migrationDeps(repos), featureId, promotion.mainAfter);
    } catch (error) {
      console.error(JSON.stringify({ event: "migration_landed_failed", feature: featureId, error: String(error).slice(0, 200) }));
    }
    await this.#featuresChanging(featureLanded(
      {
        features: this.#featureStore(),
        queue: this.#blockQueueStore(),
        retirePlan: (id) => this.#planCoverageStore().retire(id),
        recheckLocks: async (id) => {
          for (const blocked of this.#overlapStore().heldBy(id)) {
            const feature = this.#featureStore().get(blocked);
            if (feature !== undefined) await this.#lockStep(() => checkOverlap(this.#overlapDeps(repos), feature));
          }
        },
        notify,
      },
      featureId,
      promotion,
    ));
    await this.#countAfterPromotion(featureId, promotion.mainAfter, true);
  }

  /** A land run failed its checks or its push: the feature is building again. */
  landFailed(featureId: string, _runId: string): void {
    this.#liveFeed().featuresChanged();
    landFailed({ features: this.#featureStore(), notify: (personId) => sendToOwner(this.getConnections<{ owner?: string }>(), personId, inboxChangedMessage()) }, featureId);
  }

  /**
   * The fixes written into any of `targets`' forks at or after `since` (an ISO time), as
   * `<part> into <feature>`: a block run that named those fork heads checked them without the fixes.
   */
  async fixesWrittenSince(targets: readonly string[], since: string): Promise<string[]> {
    const at = Date.parse(since);
    if (Number.isNaN(at)) return [];
    return this.#fixGrantStore().writtenSince(targets, at).map((grant) => `${grant.partId} into ${grant.targetFeatureId}`);
  }

  /** Penguin lands the feature again after main refused its push (block-land.ts retryLand). */
  retryLand(featureId: string, runId: string, charter: CharterView, repos: ProjectRepos): Promise<LandAnswer> {
    return this.#planStep(async () => landAnswer(await retryLand(this.#landDeps(repos), featureId, { runId, charter })));
  }

  /**
   * Main moved to the feature's expand checkpoint: the feature keeps building, and its person hears.
   * A split's old names become retiring (contract-split.ts) and migration begins.
   */
  async expandPromoted(featureId: string, promotion: Promotion): Promise<void> {
    const feature = this.#featureStore().get(featureId);
    // Not a plan step: a block run reports from the feature's own Durable Object, which a plan step may be waiting on.
    await retireSplit(this.#splitDeps(), featureId, promotion.mainAfter);
    await this.#countAfterPromotion(featureId, promotion.mainAfter, false);
    this.#liveFeed().featuresChanged();
    if (feature !== undefined) sendToOwner(this.getConnections<{ owner?: string }>(), feature.personId, inboxChangedMessage());
  }

  /** Penguin promotes the expand again after main refused its push (expand-promotion.ts retryExpand). */
  retryExpand(featureId: string, runId: string, charter: CharterView, repos: ProjectRepos): Promise<LandAnswer> {
    return this.#planStep(async () => landAnswer(await retryExpand(this.#expandDeps(repos), featureId, { runId, charter })));
  }

  /** Where the feature's landing stands: its newest block runs, its promotion and its expand promotions; undefined for no feature. */
  async landing(featureId: string): Promise<LandingView | undefined> {
    const feature = this.#featureStore().get(featureId);
    if (feature === undefined) return undefined;
    const { runs, promotion, expansions } = await this.#featureAgent(featureId).landing(featureId);
    return { feature: featureId, state: feature.state, runs, promotion, expansions };
  }

  /** For `get_work`: the landing of the feature `caller`'s session works on, or undefined. */
  async landWork(caller: string, sessionId: string): Promise<LandingView | undefined> {
    if (this.sessionHeartbeat(caller, sessionId).status !== "ok") return undefined;
    const featureId = this.#featureStore().featureOfSession(sessionId);
    return featureId === undefined ? undefined : this.landing(featureId);
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

  /**
   * The scope map in the base repo's `penguin/scopes.json` on its branch, with the teams of its
   * `penguin/teams.json` (#135), read fresh for each call.
   */
  async #scopeMap(repos: ProjectRepos): Promise<ScopeMap> {
    const [scopes, teams] = await Promise.all([this.#baseFile(repos, SCOPE_MAP_PATH), this.#baseFile(repos, TEAMS_PATH)]);
    return parseScopeFile(scopes, teams);
  }

  /**
   * The scope map with its teams and each owner's delegate, from the base repo's `penguin/scopes.json`,
   * `penguin/teams.json` and `penguin/owners.json` on its branch, read fresh for each call.
   */
  async #reviewRules(repos: ProjectRepos): Promise<ReviewRules> {
    const [scopes, teams, owners] = await Promise.all([
      this.#baseFile(repos, SCOPE_MAP_PATH),
      this.#baseFile(repos, TEAMS_PATH),
      this.#baseFile(repos, OWNERS_PATH),
    ]);
    return { scopeMap: parseScopeFile(scopes, teams), delegates: parseOwnersFile(owners) };
  }

  /**
   * Whether a person can take a decision now: their bridge polled within the online window or a
   * session of theirs runs (edit-work.ts `availability`). Built once per routing decision (#135).
   */
  #available(): (person: string) => boolean {
    return availability({ tasks: this.#editTaskStore(), running: () => this.#sessionStore().running() });
  }

  /** Who a review exception goes to: the scope's DRI, or down its fallback order while the DRI is away. */
  async #reviewExceptionRoute(repos: ProjectRepos): Promise<(review: { readonly scopeId: string }) => string | undefined> {
    const scopeMap = await this.#scopeMap(repos);
    const available = this.#available();
    return (review) => routeScope(scopeMap, review.scopeId, available);
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
        // The check runner's result of a session's tool request reaches that session the same way.
        toolResultsFor: (sessionId) => this.#toolStore().deliver(sessionId),
        // Plan parts, decisions on a session's plan and review verdicts reach sessions the same way.
        planNotices: planNoticeSources(this.#planRouteStore(), this.#featureStore(), this.#reviewStore()),
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
 * labels, which its approval is read from, or the threads the FeatureAgent tracks.
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

/** A land outcome as it crosses RPC: the run's id and facts, never its full request. */
function landAnswer(outcome: LandOutcome): LandAnswer {
  if (outcome.status === "rejected") return outcome;
  const { run, recordId } = outcome;
  return {
    status: "checking",
    runId: run.runId,
    recordId,
    checkpoint: run.checkpoint,
    mainBefore: run.mainBefore,
    branch: run.request.branch,
    planId: run.planId,
    targets: run.request.targets.map(({ feature, sha }) => ({ feature, sha })),
  };
}

/** A Durable Object's SQLite storage as the stores' SqlDatabase. */
export function durableObjectSql(storage: DurableObjectStorage): SqlDatabase {
  return {
    exec: (query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec<Record<string, SqlValue>>(query, ...bindings).toArray(),
    transaction: (body) => storage.transactionSync(body),
  };
}
