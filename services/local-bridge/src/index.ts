export const packageName: string = "@penguin/local-bridge";

export {
  loadScopeMap,
  resolveCommand,
  SCOPES_FILE,
  testCommandId,
  UnknownCommandError,
} from "./command-allowlist.ts";
export type { ResolvedCommand } from "./command-allowlist.ts";

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
  ARTIFACTS_GIT_OPTIONS,
  artifactsRemote,
  isAuthFailure,
  isPenguinRemote,
  localRemote,
  penguinRemote,
  penguinRepoOf,
  RemoteRefusedError,
  tokenEnvironment,
  unregisteredRemotes,
} from "./git-remote.ts";
export type { GitRemote, RemoteResolver, RepoToken, TokenSource } from "./git-remote.ts";
export {
  bridgeRemotes,
  bridgeTokenAccount,
  checkedOrigin,
  COMBINED_RUN_ROUTE,
  fetchPendingOperations,
  openBridge,
  PENDING_ROUTE,
  readRegistration,
  registerBridge,
  registrationFile,
  reportCombinedRun,
  TokenClient,
} from "./penguin-client.ts";
export type {
  BridgeRegistration,
  CombinedRunReply,
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
export { combinedRunEvent, CombinedRunner, parseFailingTests } from "./combined-run.ts";
export type {
  CombinedResult,
  CombinedRunnerOptions,
  CombinedRunReport,
  CombinedRunRequest,
  ConflictResult,
  FailingTest,
  MissingCheckpointResult,
  TestedResult,
} from "./combined-run.ts";
export { fingerprint, LOCKFILE_NAMES, lockfileHash } from "./fingerprint.ts";
export type { ResultFingerprint } from "./fingerprint.ts";
export type { WorktreeRecord, WorktreeRegistryOptions } from "./registry.ts";
export { childEnvironment, ConsentRefusedError, TestRunner } from "./test-runner.ts";
export type {
  ConsentPrompt,
  ConsentRequest,
  TestRunnerOptions,
  TestRunRequest,
  TestRunResult,
} from "./test-runner.ts";
export { parseWorktreeList } from "./worktree-list.ts";
export type { WorktreeListEntry } from "./worktree-list.ts";
