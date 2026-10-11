import { isObjectId, runGit } from "@penguin/git-analysis";
import { parseScopeMap } from "@penguin/scope-map";

/** The repository config that maps command IDs to shell commands, relative to the repo root. */
export const SCOPES_FILE = "penguin/scopes.json";

// A command ID names a scope's test command: `test:<scope id>`. The prefix leaves room for
// other command kinds without changing how test IDs are spelled.
const TEST_COMMAND_ID = /^test:([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** A command ID the repository config at the pinned commit does not define. */
export class UnknownCommandError extends Error {
  readonly commandId: string;

  constructor(commandId: string, reason: string) {
    super(`refused command ID ${JSON.stringify(commandId)}: ${reason}`);
    this.name = "UnknownCommandError";
    this.commandId = commandId;
  }
}

/** An allowlisted command resolved from the repository config at one commit. */
export interface ResolvedCommand {
  readonly commandId: string;
  readonly scopeId: string;
  /** The commit whose `penguin/scopes.json` supplied the command. */
  readonly sha: string;
  /** The shell command, run from the repository root. */
  readonly command: string;
}

/**
 * Resolves a command ID to its shell command from `penguin/scopes.json` as committed at `sha`.
 * The working tree, the index and any other commit are never consulted, so an uncommitted or
 * later edit to the config cannot change what runs. Reads Git objects only; starts no command.
 *
 * Raises:
 *   UnknownCommandError: when the ID is malformed or names no scope in the config.
 *   ScopeMapError: when the config at `sha` is invalid.
 *   Error: when `sha` is not a full object ID or the config is missing at that commit.
 */
export async function resolveCommand(
  repoPath: string,
  sha: string,
  commandId: string,
): Promise<ResolvedCommand> {
  const match = TEST_COMMAND_ID.exec(commandId);
  if (!match) throw new UnknownCommandError(commandId, "expected the form test:<scope id>");
  if (!isObjectId(sha)) {
    throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  // `cat-file blob` returns the committed bytes as-is; `git show` could apply a textconv filter.
  const text = await runGit(repoPath, ["cat-file", "blob", `${sha}:${SCOPES_FILE}`]);
  const scopeId = match[1] as string;
  const scope = parseScopeMap(JSON.parse(text)).scopes.get(scopeId);
  if (scope === undefined) {
    throw new UnknownCommandError(commandId, `${SCOPES_FILE} at ${sha} defines no such scope`);
  }
  return { commandId, scopeId, sha, command: scope.testCommand };
}
