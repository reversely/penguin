// Runs the bridge's Python impact analysis (`analysis:python-impact`) on the check runner and reads
// its report. The analysis is the bridge's own script, started with an argument vector and no
// shell, in isolated mode (`python3 -I`), with the same scrubbed environment as a test command. It
// reads the repository's Git objects and never imports or runs the code it analyses.

import { spawn } from "node:child_process";

import { checkImpactReport, IMPACT_COMMAND_ID, type ImpactReport, type SchemaError } from "@penguin/protocol";

import { resolveAnalysisCommand } from "./command-allowlist.ts";
import { childEnvironment } from "./test-runner.ts";

/** One fork to search for uses of the change, limited to the fork's scopes. */
export interface ImpactForkRequest {
  readonly id: string;
  readonly sha: string;
  /** Scope ids from `penguin/scopes.json`; empty searches the whole tree. */
  readonly scopes: readonly string[];
  /**
   * Main's commit. When set, the fork's uses are those in files it added or changed since its merge
   * base with this commit; a use in a file it carries unchanged is main's caller.
   */
  readonly since?: string;
}

export interface ImpactRequest {
  /** The commit the change was made from. */
  readonly base: string;
  /** The commit holding the change. */
  readonly head: string;
  readonly forks: readonly ImpactForkRequest[];
}

export type ImpactAnalyzer = (request: ImpactRequest) => Promise<ImpactReport>;

export interface PythonImpactOptions {
  /** The repository that holds every commit the request names. */
  readonly repoPath: string;
  /** The Python 3 interpreter. Defaults to `python3` on PATH. */
  readonly python?: string;
  /** Environment the child starts from, before credentials are removed. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The analysis is stopped after this long. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** The most report bytes read. Defaults to 64 MiB. */
  readonly maxOutputBytes?: number;
}

/** An analysis did not produce a valid report; the message says why. */
export class AnalysisError extends Error {
  constructor(commandId: string, message: string) {
    super(`${commandId}: ${message}`);
    this.name = "AnalysisError";
  }
}

/** The impact analysis did not produce a valid report. */
export class ImpactAnalysisError extends AnalysisError {
  constructor(message: string) {
    super(IMPACT_COMMAND_ID, message);
    this.name = "ImpactAnalysisError";
  }
}

/** An analyzer that runs `analysis:python-impact` in `repoPath` and checks its report. */
export function pythonImpactAnalyzer(options: PythonImpactOptions): ImpactAnalyzer {
  return (request) =>
    runPythonAnalysis<ImpactReport>(IMPACT_COMMAND_ID, checkImpactReport, options, request, (message) => new ImpactAnalysisError(message));
}

/**
 * Runs one of the bridge's Python analyses on a request and checks its report against `check`. The
 * report must describe the request's base and head commits.
 */
export async function runPythonAnalysis<T extends { readonly base: string; readonly head: string }>(
  commandId: string,
  check: (value: unknown) => SchemaError[],
  options: PythonImpactOptions,
  request: { readonly base: string; readonly head: string },
  fail: (message: string) => Error = (message) => new AnalysisError(commandId, message),
): Promise<T> {
  const { script } = resolveAnalysisCommand(commandId);
  const argv = ["-I", script, "--repo", options.repoPath];
  const output = await runAnalysis(options.python ?? "python3", argv, JSON.stringify(request), options, fail);
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    throw fail("the report is not JSON");
  }
  const errors = check(report);
  if (errors.length > 0) {
    const first = errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`);
    throw fail(`the report breaks its schema: ${first.join("; ")}`);
  }
  const checked = report as T;
  if (checked.base !== request.base || checked.head !== request.head) {
    throw fail("the report describes other commits than the request");
  }
  return checked;
}

function runAnalysis(
  program: string,
  argv: string[],
  input: string,
  options: PythonImpactOptions,
  fail: (message: string) => Error,
): Promise<string> {
  const { env = process.env, timeoutMs = 600_000, maxOutputBytes = 64 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { env: childEnvironment(env), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(`stopped after ${timeoutMs} ms`), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(`the report exceeds ${maxOutputBytes} bytes`);
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(fail(`could not start ${program}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) return reject(fail(failure));
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-3).join(" ");
        return reject(fail(`exited with ${code}: ${message}`));
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    // A child that exits before reading its input closes the pipe; the exit code reports why.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The report as text for a terminal, a feature page or the walkthrough: the tool and its inputs,
 * then every finding with its file and line, then each fork with whether its tests run.
 */
export function formatImpactReport(report: ImpactReport, selected: readonly string[]): string {
  const at = (path: string, line: number) => `${path}:${line}`;
  const lines = [
    `${report.tool} (${report.commandId}) ${report.base.slice(0, 12)}..${report.head.slice(0, 12)}: ` +
      `${report.files.base} files at base, ${report.files.head} at head${report.complete ? "" : ", incomplete"}`,
  ];
  for (const change of report.changes) {
    if (change.change === "added") continue;
    const to = change.to === undefined ? "" : ` to ${change.to.symbol} (${at(change.to.path, change.to.line)})`;
    const origin = change.origin === undefined ? "" : `, now from ${change.origin.after} (was ${change.origin.before})`;
    const contract = change.contract === null ? "" : `, contract ${change.contract}`;
    lines.push(`  ${change.change} ${change.kind} ${change.symbol} (${at(change.path, change.line)})${to}${origin}${contract}`);
  }
  const added = report.changes.filter((change) => change.change === "added").length;
  if (added > 0) lines.push(`  ${added} added symbol${added === 1 ? "" : "s"}`);
  for (const signature of report.signatures) {
    const breaking = signature.breaking ? `breaking: ${signature.reasons.join("; ")}` : "compatible";
    lines.push(`  signature ${signature.symbol} (${at(signature.path, signature.line)}): was ${signature.before}, now ${signature.after}, ${breaking}`);
  }
  for (const removed of report.removedExports) lines.push(`  removed export ${removed.module}.${removed.name} (${removed.path})`);
  for (const shape of report.dataShapes) {
    const parts = [
      shape.removed.length > 0 ? `removed ${shape.removed.join(", ")}` : "",
      shape.added.length > 0 ? `added ${shape.added.join(", ")}` : "",
      shape.changed.length > 0 ? `changed ${shape.changed.join(", ")}` : "",
      shape.reordered ? "reordered" : "",
    ].filter((part) => part !== "");
    lines.push(`  stored shape ${shape.kind} ${shape.symbol} (${at(shape.path, shape.line)}): ${parts.join("; ")}`);
  }
  for (const path of report.unanalysed) lines.push(`  not analysed: ${path}`);
  for (const error of report.errors) lines.push(`  ${error.tree} ${error.path}: ${error.kind}, ${error.message}`);
  const chosen = new Set(selected);
  for (const fork of report.forks) {
    const scopes = fork.scopes.length > 0 ? fork.scopes.join(", ") : "every scope";
    lines.push(`  fork ${fork.id}@${fork.sha.slice(0, 12)} (${scopes}): ${chosen.has(fork.id) ? "tests run" : "not affected"}`);
    for (const use of fork.uses) lines.push(`    ${at(use.path, use.line)} ${use.kind} ${use.symbol}`);
    for (const error of fork.errors) lines.push(`    ${error.path}: ${error.kind}, ${error.message}`);
  }
  return `${lines.join("\n")}\n`;
}
