import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";

import { resolveCommand, type ResolvedCommand } from "./command-allowlist.ts";

/** A coordinator's request to run a command. It names the command by ID only, never by text. */
export interface TestRunRequest {
  readonly commandId: string;
  /** Full object ID of the commit to check out and read the config from. */
  readonly sha: string;
}

/** What the owner is asked to approve before the bridge creates a worktree. */
export interface ConsentRequest extends ResolvedCommand {
  readonly action: "create-worktree-and-run";
}

export type ConsentPrompt = (request: ConsentRequest) => boolean | Promise<boolean>;

export interface TestRunnerOptions {
  /** Any path inside the owner's repository. */
  repoPath: string;
  /** Asked once per run, after the command resolves and before any worktree exists. */
  consent: ConsentPrompt;
  /** Environment the child starts from, before tokens are removed. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Directory that holds the temporary worktrees. Defaults to the OS temp directory. */
  scratchDir?: string;
}

export interface TestRunResult extends ResolvedCommand {
  /** The command's exit status, or null when a signal ended it. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Standard output and standard error, interleaved in arrival order. */
  readonly log: string;
  readonly timings: { readonly createMs: number; readonly runMs: number; readonly removeMs: number };
}

/** The owner declined the run; no worktree was created and no command started. */
export class ConsentRefusedError extends Error {
  constructor(commandId: string) {
    super(`the owner refused consent to run ${commandId}`);
    this.name = "ConsentRefusedError";
  }
}

// Penguin bridge and MCP tokens (K3, K4, K5), Artifacts repo tokens (K2) and the Cloudflare
// credential that can mint them (K1) never reach a command the repository defines.
const TOKEN_VARIABLE = /^(?:PENGUIN_|ARTIFACTS_|CLOUDFLARE_API_TOKEN$)/i;

// Variables that force colour on (pytest reads PY_COLORS before NO_COLOR, and FORCE_COLOR after).
// Playwright and some operator shells set FORCE_COLOR; a coloured log hides `FAILED <node ID>` lines.
const FORCE_COLOUR_VARIABLE = /^(?:FORCE_COLOR|PY_COLORS|CLICOLOR_FORCE)$/;

/**
 * Copies an environment without the Penguin, Artifacts and Cloudflare credential variables, with
 * colour turned off: the variables that force colour are removed and `NO_COLOR=1` is set.
 */
export function childEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(base).filter(([name]) => !TOKEN_VARIABLE.test(name) && !FORCE_COLOUR_VARIABLE.test(name));
  return { ...Object.fromEntries(kept), NO_COLOR: "1" };
}

/**
 * Runs allowlisted commands in throwaway worktrees. Each run resolves the command ID from the
 * config at the pinned commit, asks the owner, adds a detached worktree at that commit in a
 * temporary directory, runs the command there and removes the worktree, so the owner's own
 * worktrees are never read from or written to.
 */
export class TestRunner {
  readonly #options: TestRunnerOptions;

  constructor(options: TestRunnerOptions) {
    this.#options = options;
  }

  /**
   * Raises:
   *   UnknownCommandError: before consent or any worktree, when the ID is not in the config.
   *   ConsentRefusedError: when the owner declines; no worktree is created.
   */
  async run(request: TestRunRequest): Promise<TestRunResult> {
    const { repoPath, consent, env = process.env, scratchDir = tmpdir() } = this.#options;
    const resolved = await resolveCommand(repoPath, request.sha, request.commandId);
    if (!(await consent({ ...resolved, action: "create-worktree-and-run" }))) {
      throw new ConsentRefusedError(resolved.commandId);
    }

    const dir = await realpath(await mkdtemp(join(scratchDir, "penguin-run-")));
    const worktree = join(dir, "tree");
    const started = performance.now();
    let created = started;
    let finished = started;
    let added = false;
    let outcome: ShellOutcome;
    try {
      // Hooks off: a post-checkout hook would run code that is not an allowlisted command.
      await runGit(repoPath, [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--detach",
        "--quiet",
        worktree,
        resolved.sha,
      ]);
      added = true;
      created = performance.now();
      outcome = await runShell(resolved.command, worktree, childEnvironment(env));
    } finally {
      finished = performance.now();
      // --force: the command may leave untracked files (caches, reports) in the worktree.
      if (added) await runGit(repoPath, ["worktree", "remove", "--force", worktree]);
      await rm(dir, { recursive: true, force: true });
    }
    const timings = {
      createMs: created - started,
      runMs: finished - created,
      removeMs: performance.now() - finished,
    };
    return { ...resolved, ...outcome, timings };
  }
}

interface ShellOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  log: string;
}

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ShellOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, log: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
