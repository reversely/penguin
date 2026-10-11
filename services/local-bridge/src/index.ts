export const packageName: string = "@penguin/local-bridge";

export {
  loadScopeMap,
  resolveCommand,
  SCOPES_FILE,
  testCommandId,
  UnknownCommandError,
} from "./command-allowlist.ts";
export type { ResolvedCommand } from "./command-allowlist.ts";

export { CheckpointPublisher, formatPreview } from "./checkpoint.ts";
export type {
  CheckpointFile,
  CheckpointPreview,
  CheckpointPublisherOptions,
  ConsentScope,
  OwnerFork,
  PublishResult,
} from "./checkpoint.ts";
export { runCli } from "./cli.ts";
export type { CliIo } from "./cli.ts";
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
