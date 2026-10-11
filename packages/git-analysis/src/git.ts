import { execFile } from "node:child_process";

// Diff and worktree listings on a large repo can exceed execFile's 1 MiB default.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True for a full SHA-1 or SHA-256 object ID in lowercase hex. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

/**
 * Runs `git` with an argument array and no shell, so no argument (including a path read from
 * earlier Git output) is ever interpreted by a shell. Resolves with stdout.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
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
