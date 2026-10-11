import { fileURLToPath } from "node:url";

import { isObjectId, runGit } from "@penguin/git-analysis";
import { DEPENDENCY_COMMAND_ID, FIX_COMMAND_IDS, IMPACT_COMMAND_ID, SIDE_BY_SIDE_COMMAND_ID } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

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
  const scopeId = match[1] as string;
  const scope = (await loadScopeMap(repoPath, sha)).scopes.get(scopeId);
  if (scope === undefined) {
    throw new UnknownCommandError(commandId, `${SCOPES_FILE} at ${sha} defines no such scope`);
  }
  return { commandId, scopeId, sha, command: scope.testCommand };
}

// Penguin's own analysis commands and its codemod. Unlike a test command, the program is part of the
// bridge, never the repository: an ID maps to a script shipped beside this file. An analysis reads
// the repository's Git objects as data; the codemod rewrites the files it is given in a throwaway
// worktree.
const ANALYSIS_SCRIPTS: Readonly<Record<string, string>> = {
  [IMPACT_COMMAND_ID]: "../analysis/python_impact.py",
  [SIDE_BY_SIDE_COMMAND_ID]: "../analysis/side_by_side.py",
  [DEPENDENCY_COMMAND_ID]: "../analysis/python_dependencies.py",
  [FIX_COMMAND_IDS.codemod]: "../analysis/python_codemod.py",
};

/** One of the bridge's own analysis commands, resolved to the script it runs. */
export interface AnalysisCommand {
  readonly commandId: string;
  /** Absolute path of the script, inside the bridge's own folder. */
  readonly script: string;
}

/**
 * Resolves an analysis command ID, such as `analysis:python-impact`, to the bridge's script.
 *
 * Raises:
 *   UnknownCommandError: when the ID names no analysis the bridge ships.
 */
export function resolveAnalysisCommand(commandId: string): AnalysisCommand {
  if (!Object.hasOwn(ANALYSIS_SCRIPTS, commandId)) {
    throw new UnknownCommandError(commandId, "the bridge ships no such analysis");
  }
  const script = fileURLToPath(new URL(ANALYSIS_SCRIPTS[commandId] as string, import.meta.url));
  return { commandId, script };
}

/** The command ID of a scope's test command. */
export function testCommandId(scopeId: string): string {
  return `test:${scopeId}`;
}

/**
 * Reads and validates `penguin/scopes.json` as committed at `sha`, never from a working tree.
 *
 * Raises:
 *   ScopeMapError: when the config at `sha` is invalid.
 *   Error: when `sha` is not a full object ID or the config is missing at that commit.
 */
export async function loadScopeMap(repoPath: string, sha: string): Promise<ScopeMap> {
  if (!isObjectId(sha)) {
    throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  // `cat-file blob` returns the committed bytes as-is; `git show` could apply a textconv filter.
  const text = await runGit(repoPath, ["cat-file", "blob", `${sha}:${SCOPES_FILE}`]);
  return parseScopeMap(JSON.parse(text));
}
