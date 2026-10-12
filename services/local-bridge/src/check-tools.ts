// The check runner's own tools (PRD section 5.1): ruff for lint and format (T18) and pyright for the
// type check (T19). Each runs as a fixed program with an argument vector and no shell, in a
// throwaway worktree of a merged commit, with the scrubbed environment of a test command and a
// timeout. A file path from the tree is passed after `--`, so a name such as `-x.py` is never read
// as an option. Each tool's output is parsed into findings; nothing calls a model.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECK_COMMAND_IDS, type BlockCheckFinding } from "@penguin/protocol";

import { childEnvironment, killGroup } from "./test-runner.ts";

/** What one run of a tool found, before it is compared with the target's own tree. */
export interface ToolRun {
  readonly tool: { readonly name: string; readonly version: string | null; readonly commandId: string };
  /** The tool exited normally and its output parsed; otherwise `error` says why. */
  readonly error: string | null;
  readonly findings: readonly BlockCheckFinding[];
  /** `sha256:<hex>` of the tool's standard output and standard error. */
  readonly logRef: string;
  readonly log: string;
  /** The interpreter pyright resolved imports against, or null for pyright's own search; type check only. */
  readonly python?: string | null;
}

export interface CheckTools {
  /** `ruff check` on the given repository paths of the tree at `worktree`. */
  lint(worktree: string, paths: readonly string[]): Promise<ToolRun>;
  /** `ruff format --check` on the given paths. */
  format(worktree: string, paths: readonly string[]): Promise<ToolRun>;
  /** pyright on the whole tree at `worktree`. */
  typecheck(worktree: string): Promise<ToolRun>;
}

export interface CheckToolOptions {
  /** The ruff program. Defaults to `ruff` on PATH. */
  readonly ruff?: string;
  /** pyright's command-line script. Defaults to the `pyright` package installed beside the bridge. */
  readonly pyright?: string;
  /** The interpreter whose installed packages pyright resolves imports against. Defaults to `defaultPython()`. */
  readonly python?: string;
  /** Environment the child starts from, before credentials are removed. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** A tool still running after this long is stopped. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** The most output bytes read from one tool. Defaults to 64 MiB. */
  readonly maxOutputBytes?: number;
}

export interface ProgramOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the program did not finish on its own: a start failure, the timeout or the output limit. */
  readonly stopped: string | null;
}

/** Runs a program with an argument vector, no shell and its own process group. */
export function runProgram(
  program: string,
  argv: readonly string[],
  cwd: string,
  options: Pick<CheckToolOptions, "env" | "timeoutMs" | "maxOutputBytes"> & { readonly input?: string },
): Promise<ProgramOutcome> {
  const { env = process.env, timeoutMs = 600_000, maxOutputBytes = 64 * 1024 * 1024, input } = options;
  return new Promise((resolve) => {
    const child = spawn(program, argv, {
      cwd,
      env: childEnvironment(env),
      shell: false,
      detached: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined && child.stdin !== null) {
      // A program that exits before reading its input closes the pipe; its exit code says why.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let stopped: string | null = null;
    const stop = (reason: string) => {
      stopped ??= reason;
      killGroup(child.pid);
    };
    const timer = setTimeout(() => stop(`stopped after ${timeoutMs} ms`), timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(`output exceeds ${maxOutputBytes} bytes`);
      else into.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: "", stopped: `could not start ${program}: ${error.message}` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
      resolve({ exitCode, stdout: text(stdout), stderr: text(stderr), stopped });
    });
  });
}

const logRefOf = (log: string): string => `sha256:${createHash("sha256").update(log).digest("hex")}`;

/** The pyright script of the `pyright` package (T19), or undefined when the package is not installed. */
export function installedPyright(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve("pyright/package.json");
    return join(dirname(manifest), "index.js");
  } catch {
    return undefined;
  }
}

// A repository's own ruff settings are used when its root has them; otherwise ruff's defaults, so a
// configuration file in the runner's home or temporary directory never changes a result.
export function ruffConfig(worktree: string): string[] {
  for (const name of ["ruff.toml", ".ruff.toml"]) {
    if (existsSync(join(worktree, name))) return ["--config", join(worktree, name)];
  }
  const pyproject = join(worktree, "pyproject.toml");
  if (existsSync(pyproject) && /^\s*\[tool\.ruff[\].]/m.test(readFileSync(pyproject, "utf8"))) {
    return ["--config", pyproject];
  }
  return ["--isolated"];
}

const repoPath = (worktree: string, file: string): string => (isAbsolute(file) ? relative(worktree, file) : file);

/**
 * The ruff the runner uses unless told otherwise: PENGUIN_RUFF, then the ruff this repository pins in
 * its uv environment (`.venv/bin/ruff`), then `ruff` on PATH. A ruff from elsewhere on PATH, such as
 * an Anaconda install, can be an older release whose formatter disagrees with the pinned one.
 */
export function defaultRuff(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PENGUIN_RUFF) return env.PENGUIN_RUFF;
  const pinned = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".venv", "bin", "ruff");
  return existsSync(pinned) ? pinned : "ruff";
}

/**
 * The interpreter pyright resolves imports against unless told otherwise: PENGUIN_PYTHON, then this
 * repository's uv environment (`.venv/bin/python`), else undefined for pyright's own search. Without
 * it the result depends on the host: a host whose own Python lacks pytest reports
 * `reportMissingImports` on every test file that a host with pytest installed passes.
 */
export function defaultPython(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PENGUIN_PYTHON) return env.PENGUIN_PYTHON;
  const pinned = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".venv", "bin", "python");
  return existsSync(pinned) ? pinned : undefined;
}

/**
 * The files `ruff format --check` would change. Older releases (0.12) print `Would reformat: <path>`;
 * newer ones (0.17) print a diagnostic whose location line reads ` --> <path>:<line>:<column>`. Each file is
 * listed once, with the first changed line when the output gives one.
 */
export function parseFormatCheck(stdout: string): { path: string; line: number | null }[] {
  const found = new Map<string, number | null>();
  for (const match of stdout.matchAll(/^Would reformat: (.+)$/gm)) {
    const path = (match[1] as string).trim();
    if (!found.has(path)) found.set(path, null);
  }
  for (const match of stdout.matchAll(/^\s*--> (.+?):(\d+):\d+\s*$/gm)) {
    const path = (match[1] as string).trim();
    if (!found.has(path)) found.set(path, Number(match[2]));
  }
  return [...found].map(([path, line]) => ({ path, line }));
}

/** The tools as programs: `ruff` and pyright run under Node, both with argument vectors. */
export function checkTools(options: CheckToolOptions = {}): CheckTools {
  const ruff = options.ruff ?? defaultRuff();
  const python = options.python ?? defaultPython(options.env);
  let ruffVersion: Promise<string | null> | undefined;
  const versionOfRuff = (cwd: string) =>
    (ruffVersion ??= runProgram(ruff, ["--version"], cwd, options).then(
      (outcome) => /ruff (\S+)/.exec(outcome.stdout)?.[1] ?? null,
    ));

  const run = async (
    name: string,
    commandId: string,
    program: string,
    argv: readonly string[],
    cwd: string,
    version: string | null,
    parse: (outcome: ProgramOutcome) => BlockCheckFinding[] | string,
  ): Promise<ToolRun> => {
    const outcome = await runProgram(program, argv, cwd, options);
    const log = `${outcome.stdout}${outcome.stderr}`;
    const tool = { name, version, commandId };
    if (outcome.stopped !== null) return { tool, error: outcome.stopped, findings: [], logRef: logRefOf(log), log };
    const parsed = parse(outcome);
    if (typeof parsed === "string") return { tool, error: parsed, findings: [], logRef: logRefOf(log), log };
    return { tool, error: null, findings: parsed, logRef: logRefOf(log), log };
  };

  return {
    async lint(worktree, paths) {
      const argv = ["check", "--no-cache", "--exit-zero", "--output-format", "json", ...ruffConfig(worktree), "--", ...paths];
      return run("ruff", CHECK_COMMAND_IDS.lint, ruff, argv, worktree, await versionOfRuff(worktree), (outcome) => {
        if (outcome.exitCode !== 0) return `ruff check exited with ${outcome.exitCode}: ${lastLine(outcome.stderr)}`;
        try {
          const diagnostics = JSON.parse(outcome.stdout) as RuffDiagnostic[];
          return diagnostics.map((item) => ({
            path: repoPath(worktree, item.filename),
            line: item.location?.row ?? null,
            code: item.code ?? null,
            message: item.message,
          }));
        } catch {
          return "ruff check printed no JSON report";
        }
      });
    },

    async format(worktree, paths) {
      const argv = ["format", "--check", "--no-cache", ...ruffConfig(worktree), "--", ...paths];
      return run("ruff", CHECK_COMMAND_IDS.format, ruff, argv, worktree, await versionOfRuff(worktree), (outcome) => {
        // ruff format --check exits 1 when a file would change and 2 when it could not check.
        if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
          return `ruff format exited with ${outcome.exitCode}: ${lastLine(outcome.stderr)}`;
        }
        return parseFormatCheck(outcome.stdout).map(({ path, line }) => ({
          path: repoPath(worktree, path),
          line,
          code: null,
          message: "would be reformatted",
        }));
      });
    },

    async typecheck(worktree) {
      const script = options.pyright ?? installedPyright();
      if (script === undefined) {
        const tool = { name: "pyright", version: null, commandId: CHECK_COMMAND_IDS.typecheck };
        const error = "pyright is not installed beside the bridge";
        return { tool, error, findings: [], logRef: logRefOf(""), log: "", python: python ?? null };
      }
      const argv = [script, "--outputjson", ...(python === undefined ? [] : ["--pythonpath", python])];
      let version: string | null = null;
      const result = await run("pyright", CHECK_COMMAND_IDS.typecheck, process.execPath, argv, worktree, null, (outcome) => {
        // pyright exits 0 with no errors, 1 with errors, and 2 or 3 when it could not run.
        if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
          return `pyright exited with ${outcome.exitCode}: ${lastLine(outcome.stderr || outcome.stdout)}`;
        }
        try {
          const report = JSON.parse(outcome.stdout) as PyrightReport;
          version = report.version ?? null;
          return report.generalDiagnostics
            .filter((item) => item.severity === "error")
            .map((item) => ({
              path: item.file === undefined ? null : repoPath(worktree, item.file),
              line: item.range === undefined ? null : item.range.start.line + 1,
              code: item.rule ?? null,
              message: item.message,
            }));
        } catch {
          return "pyright printed no JSON report";
        }
      });
      // The kept log names the interpreter, so a result can be traced to the packages it saw.
      const log = `python: ${python ?? "pyright's own search"}\n${result.log}`;
      return { ...result, tool: { ...result.tool, version }, log, logRef: logRefOf(log), python: python ?? null };
    },
  };
}

interface RuffDiagnostic {
  readonly code?: string | null;
  readonly message: string;
  readonly filename: string;
  readonly location?: { readonly row: number; readonly column: number } | null;
}

interface PyrightReport {
  readonly version?: string;
  readonly generalDiagnostics: readonly {
    readonly file?: string;
    readonly severity: string;
    readonly message: string;
    readonly rule?: string;
    readonly range?: { readonly start: { readonly line: number } };
  }[];
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

/**
 * The findings of a merged tree that its target's own tree does not have: each finding is matched
 * by file, rule and message, not by line, since the merge can move lines. A finding that appears
 * twice in the merged tree and once in the target counts once.
 */
export function newFindings(
  merged: readonly BlockCheckFinding[],
  target: readonly BlockCheckFinding[],
): BlockCheckFinding[] {
  const key = (finding: BlockCheckFinding) => JSON.stringify([finding.path, finding.code, finding.message]);
  const known = new Map<string, number>();
  for (const finding of target) known.set(key(finding), (known.get(key(finding)) ?? 0) + 1);
  return merged.filter((finding) => {
    const count = known.get(key(finding)) ?? 0;
    if (count === 0) return true;
    known.set(key(finding), count - 1);
    return false;
  });
}
