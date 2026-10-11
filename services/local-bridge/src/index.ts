export const packageName: string = "@penguin/local-bridge";

export { resolveCommand, SCOPES_FILE, UnknownCommandError } from "./command-allowlist.ts";
export type { ResolvedCommand } from "./command-allowlist.ts";

export { hashPath, WorktreeRegistry } from "./registry.ts";
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
