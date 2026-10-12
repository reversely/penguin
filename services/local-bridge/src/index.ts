export const packageName: string = "@penguin/local-bridge";

export {
  loadScopeMap,
  resolveAnalysisCommand,
  resolveCommand,
  SCOPES_FILE,
  testCommandId,
  UnknownCommandError,
} from "./command-allowlist.ts";
export type { AnalysisCommand, ResolvedCommand } from "./command-allowlist.ts";
export {
  AnalysisError,
  formatImpactReport,
  ImpactAnalysisError,
  pythonImpactAnalyzer,
  runPythonAnalysis,
} from "./impact-analysis.ts";
export type { ImpactAnalyzer, ImpactForkRequest, ImpactRequest, PythonImpactOptions } from "./impact-analysis.ts";
export { loadReviewConfig, readCommittedFile, runSideBySide, SideBySideError } from "./side-by-side.ts";
export type { SideBySideOptions, SideBySideRequest } from "./side-by-side.ts";
export { formatReviewResult, runReview } from "./review-harness.ts";
export { failureLines, testDocstring, testFunctionName, type FailureLines } from "./test-evidence.ts";
export {
  checkFactsRequest,
  factsFetcher,
  formatPlanFactsPass,
  planFactsPass,
  PlanFactsRunner,
  type PlanFactsPassOptions,
  type PlanFactsPassResult,
  type PlanFactsRunnerOptions,
} from "./plan-facts-run.ts";
export type { ReviewOptions, ReviewRequest, ReviewResult } from "./review-harness.ts";
export { formatReviewPass, reviewPass } from "./review-run.ts";
export type { ReviewPassOptions, ReviewPassResult, ReviewRunResult } from "./review-run.ts";
export { formatToolPass, toolPass } from "./tool-run.ts";
export type { ToolPassOptions, ToolPassResult, ToolRunResult } from "./tool-run.ts";
export { fixWritePass, formatFixWritePass, writeFix } from "./fix-write.ts";
export type { ClaimedFixWrite, FixWritePassOptions, FixWritePassResult, FixWriteReply, FixWriteResult, FixWriterOptions } from "./fix-write.ts";
export { runFixWriteCommand } from "./fix-write-cli.ts";
export { runPreviewCommand } from "./preview-cli.ts";
export { blockPass, formatBlockPass } from "./block-run.ts";
export type { BlockPassOptions, BlockPassResult, BlockRunResult } from "./block-run.ts";

export {
  AGENT_TRAILER_KEY,
  checkpointEntryId,
  CheckpointPublisher,
  formatPreview,
  IDENTITIES_FILE,
} from "./checkpoint.ts";
export { pushCheckpoint } from "./checkpoint-push.ts";
export type { CheckpointPushResult } from "./checkpoint-push.ts";
export {
  bridgeReporter,
  CHECKPOINT_ROUTE,
  checkpointReportId,
  unregisteredReporter,
} from "./checkpoint-report.ts";
export type { CheckpointReporter, CheckpointReportResult } from "./checkpoint-report.ts";
export {
  ARTIFACTS_FETCH_OPTIONS,
  ARTIFACTS_PUSH_OPTIONS,
  artifactsGitOptions,
  artifactsRemote,
  isAuthFailure,
  isPenguinRemote,
  localRemote,
  penguinRemote,
  penguinRepoOf,
  RemoteRefusedError,
  tokenEnvironment,
  tokenRemote,
  unregisteredRemotes,
} from "./git-remote.ts";
export type { GitRemote, RemoteResolver, RepoToken, TokenSource } from "./git-remote.ts";
export {
  APPROVAL_ROUTE,
  BLOCK_ROUTE,
  claimBlockRuns,
  reportBlockRun,
  bridgeRemotes,
  bridgeTokenAccount,
  checkedOrigin,
  claimCombinedRuns,
  claimReviews,
  claimToolRuns,
  claimFixWrites,
  fixWriteSpecOf,
  reportFixWrite,
  COMBINED_RUN_CLAIM_ROUTE,
  COMBINED_RUN_ROUTE,
  fetchApprovals,
  fetchPendingOperations,
  fetchPlanFactsRuns,
  fetchVerificationRuns,
  openBridge,
  PENDING_ROUTE,
  readRegistration,
  registerBridge,
  registrationFile,
  reportApproval,
  PLAN_FACTS_ROUTE,
  reportCombinedRun,
  reportReview,
  reportPlanFacts,
  reportToolRun,
  reportVerification,
  REVIEW_ROUTE,
  TokenClient,
  TOOL_RUN_ROUTE,
  VERIFICATION_ROUTE,
} from "./penguin-client.ts";
export type {
  ApprovalReply,
  BlockRunReply,
  BridgeRegistration,
  ClaimedCombinedRun,
  ClaimedFork,
  ClaimedReview,
  ClaimedToolRun,
  CombinedRunReply,
  ReviewReply,
  PlanFactsReply,
  ToolRunReply,
  VerificationReply,
  Fetch,
  PendingOperation,
  RegisterOptions,
  TokenClientOptions,
} from "./penguin-client.ts";
export { IssuesClone, operationText, RemoteUnavailableError } from "./issues-clone.ts";
export type { BatchFile, BatchOutcome, IssuesCloneOptions, PublishOutcome, SyncResult } from "./issues-clone.ts";
export { formatPass, pendingProblem, runnerPass, RunnerLoop } from "./runner.ts";
export type { RunnerLoopOptions, RunnerPassOptions, RunnerPassResult } from "./runner.ts";
export { pendingOf, Spool, SPOOL_VERSION } from "./spool.ts";
export type {
  CheckpointEntry,
  CheckpointReportEntry,
  FailedEntry,
  OperationEntry,
  PushedEntry,
  QueuedEntry,
  SpoolEntry,
  SpoolOptions,
} from "./spool.ts";
export { bridgeSpool, defaultStateDir, formatDrain } from "./spool-cli.ts";
export { bridgeConsent, FileConsentStore, MemoryConsentStore } from "./consent-store.ts";
export type { ConsentFilter, ConsentGrant, ConsentStore, ConsentTarget } from "./consent-store.ts";
export { drainLocked, drainSpool, RetryLoop } from "./spool-drain.ts";
export type { DrainResult, RetryLoopOptions } from "./spool-drain.ts";
export type {
  CheckpointFile,
  CheckpointPreview,
  CheckpointPublisherOptions,
  ConsentScope,
  OwnerFork,
  PublishOptions,
  PublishResult,
} from "./checkpoint.ts";
export { runCli } from "./cli.ts";
export {
  formatDeliveries,
  hookAnswer,
  LOCAL_BRIDGE_ID,
  sendSessionCheckpoint,
  SESSION_CHECKPOINT_ROUTE,
  worktreeAt,
} from "./session-checkpoint.ts";
export type { SessionDelivery } from "./session-checkpoint.ts";
export { bridgeTagFor } from "./issue-cli.ts";
export type { CliDependencies, CliIo } from "./cli.ts";
export { IssueWriter } from "./issue-writer.ts";
export type {
  BridgeOperationType,
  IssueChange,
  IssueWriterOptions,
  WriteOptions,
  WriteResult,
} from "./issue-writer.ts";
export {
  KEYCHAIN_SERVICE,
  KeychainStore,
  loadSigningKey,
  MemoryKeyStore,
  signingKeyAccount,
} from "./key-store.ts";
export type { BridgeSigningKey, KeyStore } from "./key-store.ts";
export { hashPath, worktreeId, WorktreeRegistry } from "./registry.ts";
export {
  combinedRunEvent,
  CombinedRunner,
  ownerForkTargets,
  parseCheckpointArgument,
  parseFailingTests,
  testChecks,
} from "./combined-run.ts";
export {
  BlockChecker,
  formatBlockChecks,
  pythonDependencyAnalyzer,
  type BlockCheckerOptions,
  type BlockCheckRequest,
  type BlockCheckRun,
  type BlockTarget,
  type DependencyAnalyzer,
  type TargetMerge,
} from "./block-checks.ts";
export {
  checkTools,
  defaultRuff,
  installedPyright,
  newFindings,
  parseFormatCheck,
  runProgram,
  type CheckToolOptions,
  type CheckTools,
  type ToolRun,
} from "./check-tools.ts";
export {
  checkFixRequest,
  defaultCodemodPython,
  FixApplier,
  FixRefusedError,
  symlinkRefusal,
  type FixApplierOptions,
  type FixRequest,
  type FixRun,
} from "./apply-fix.ts";
export {
  charterPaths,
  classifyCheck,
  DEFAULT_ROUND_LIMIT,
  formatResolution,
  loadIdentities,
  ResolutionLadder,
  routingContext,
  type IdentitySeed,
  type ResolutionLadderOptions,
  type ResolveRequest,
  type ResolveResult,
} from "./resolution.ts";
export { batchRuns, combinedRunPass, forkFetcher, formatCombinedPass } from "./combined-run-pass.ts";
export type {
  CombinedBatchResult,
  CombinedPassOptions,
  CombinedPassResult,
  RefusedCommand,
} from "./combined-run-pass.ts";
export type {
  CombinedResult,
  CombinedRunnerOptions,
  CombinedRunReport,
  CombinedRunRequest,
  ConflictResult,
  FailingTest,
  ForkTarget,
  MissingCheckpointResult,
  NotAffectedResult,
  TestedResult,
} from "./combined-run.ts";
export { fingerprint, LOCKFILE_NAMES, lockfileHash } from "./fingerprint.ts";
export { fetchedBranch, fetchedRefs, fetchRepoBranches, hasCommit, isRunnerRepo } from "./runner-repo.ts";
export {
  formatVerificationPass,
  INTEGRATION_BRANCH,
  verificationPass,
  VerificationRunner,
} from "./verification-run.ts";
export { ApprovedBranchWriter, approvalPass, formatApprovalPass } from "./approval-run.ts";
export type { ApprovalPassOptions, ApprovalPassResult, ApprovedBranchWriterOptions } from "./approval-run.ts";
export type {
  VerificationPassOptions,
  VerificationPassResult,
  VerificationRunnerOptions,
} from "./verification-run.ts";
export type { ResultFingerprint } from "./fingerprint.ts";
export type { WorktreeRecord, WorktreeRegistryOptions } from "./registry.ts";
export {
  childEnvironment,
  ConsentRefusedError,
  DEFAULT_TIMEOUT_MS,
  inDetachedWorktree,
  TestRunner,
} from "./test-runner.ts";
export type {
  ConsentPrompt,
  ConsentRequest,
  TestRunnerOptions,
  TestRunRequest,
  TestRunResult,
} from "./test-runner.ts";
export { parseWorktreeList } from "./worktree-list.ts";
export type { WorktreeListEntry } from "./worktree-list.ts";
