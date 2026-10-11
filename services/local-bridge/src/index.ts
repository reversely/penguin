export const packageName: string = "@penguin/local-bridge";

export {
  loadScopeMap,
  resolveCommand,
  SCOPES_FILE,
  testCommandId,
  UnknownCommandError,
} from "./command-allowlist.ts";
export type { ResolvedCommand } from "./command-allowlist.ts";

export { checkpointEntryId, CheckpointPublisher, formatPreview } from "./checkpoint.ts";
export { pushCheckpoint } from "./checkpoint-push.ts";
export type { CheckpointPushResult } from "./checkpoint-push.ts";
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
  readRegistration,
  registerBridge,
  registrationFile,
  TokenClient,
} from "./penguin-client.ts";
export type { BridgeRegistration, Fetch, RegisterOptions, TokenClientOptions } from "./penguin-client.ts";
export { IssuesClone, operationText, RemoteUnavailableError } from "./issues-clone.ts";
export type { IssuesCloneOptions, PublishOutcome, SyncResult } from "./issues-clone.ts";
export { pendingOf, Spool, SPOOL_VERSION } from "./spool.ts";
export type {
  CheckpointEntry,
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
  PublishResult,
} from "./checkpoint.ts";
export { runCli } from "./cli.ts";
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
export { CombinedRunner, parseFailingTests } from "./combined-run.ts";
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
