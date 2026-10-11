import { execFile } from "node:child_process";

// Diff and worktree listings on a large repo can exceed execFile's 1 MiB default.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True for a full SHA-1 or SHA-256 object ID in lowercase hex. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

export interface RunGitOptions {
  /** Variables set on top of `process.env` for this one command. */
  readonly env?: NodeJS.ProcessEnv;
}

/** A Git command's output together with the exit status it ended with. */
export interface GitOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs `git` with an argument array and no shell, so no argument (including a path read from
 * earlier Git output) is ever interpreted by a shell. Resolves with stdout.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  return (await runGitWithStatus(cwd, args, [0], options)).stdout;
}

/**
 * Runs `git` like `runGit`, but resolves for every exit status in `okStatuses`, for commands
 * such as `merge-tree` whose non-zero status reports a result rather than an error.
 */
export function runGitWithStatus(
  cwd: string,
  args: readonly string[],
  okStatuses: readonly number[],
  options: RunGitOptions = {},
): Promise<GitOutcome> {
  const env = options.env === undefined ? process.env : { ...process.env, ...options.env };
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        // A non-zero exit sets a numeric `code`; a spawn failure or a signal does not.
        const exitCode = error === null ? 0 : error.code;
        if (typeof exitCode === "number" && okStatuses.includes(exitCode)) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || error?.message}`));
      },
    );
  });
}

/** Splits `-z` output into its NUL-terminated fields, dropping the trailing empty field. */
export function splitNul(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}
