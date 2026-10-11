// The side-by-side run of the review harness (PRD 0.4 section 6, step 3 and 4), on the check runner.
// For the reviewing scope it runs the scope's public functions on main and on the fork: over the
// examples files `penguin/invariants.json` names for the scope on main, and over the risky inputs the
// review form names. Each side runs the allowlisted `analysis:side-by-side` script, the bridge's own,
// in a throwaway detached worktree at that commit, under `python3 -I` with the scrubbed environment
// of a test command, a timeout and an output cap. Inputs reach the script as JSON on its standard
// input, never as code or shell text, and each is checked against the function's signature before
// anything runs.

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isObjectId, runGit, runGitWithStatus } from "@penguin/git-analysis";
import {
  parseExampleFile,
  parseRepoPath,
  REVIEW_SCHEMA_VERSION,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  type ExampleCase,
  type RiskyInput,
  type SideBySideDifference,
  type SideBySideInvalid,
  type SideBySideOutcome,
  type SideBySideRecord,
  type SideBySideSet,
} from "@penguin/protocol";
import { INVARIANTS_PATH, parseInvariantsBytes, type InvariantsFile, type ScopeMap } from "@penguin/scope-map";

import { loadScopeMap, resolveAnalysisCommand } from "./command-allowlist.ts";
import { childEnvironment } from "./test-runner.ts";

export interface SideBySideOptions {
  /** The repository that holds both commits. */
  readonly repoPath: string;
  /** The Python 3 interpreter that runs the scope's code. Defaults to `python3` on PATH. */
  readonly python?: string;
  /** Environment the child starts from, before credentials are removed. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Each side is stopped after this long. Defaults to 5 minutes. */
  readonly timeoutMs?: number;
  /** The most report bytes read from each side. Defaults to 16 MiB. */
  readonly maxOutputBytes?: number;
  /** Where throwaway worktrees go. Defaults to the system temp folder. */
  readonly scratchDir?: string;
}

export interface SideBySideRequest {
  /** Main: the commit the plan's change is made against. */
  readonly base: string;
  /** The fork's commit holding the change. */
  readonly fork: string;
  /** The reviewing scope, whose public functions run. */
  readonly scope: string;
  readonly riskyInputs?: readonly RiskyInput[];
}

/** The run could not be made; the message says why. */
export class SideBySideError extends Error {
  constructor(message: string) {
    super(`${SIDE_BY_SIDE_COMMAND_ID}: ${message}`);
    this.name = "SideBySideError";
  }
}

/** The most bytes read from one committed file: the invariants file or an examples file. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A file as committed at `sha`, or null when the commit has no file there. Reads Git objects only. */
export async function readCommittedFile(repoPath: string, sha: string, path: string): Promise<string | null> {
  if (!isObjectId(sha)) throw new SideBySideError(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  if (parseRepoPath(path) === undefined) return null;
  const object = `${sha}:${path}`;
  const type = await runGitWithStatus(repoPath, ["cat-file", "-t", object], [0, 1, 128]);
  if (type.exitCode !== 0 || type.stdout.trim() !== "blob") return null;
  const size = Number((await runGit(repoPath, ["cat-file", "-s", object])).trim());
  if (size > MAX_FILE_BYTES) throw new SideBySideError(`${path} at ${sha} is over ${MAX_FILE_BYTES} bytes`);
  return runGit(repoPath, ["cat-file", "blob", object]);
}

/** `penguin/scopes.json` and `penguin/invariants.json` as committed at `sha`. */
export async function loadReviewConfig(repoPath: string, sha: string): Promise<{ scopeMap: ScopeMap; invariants: InvariantsFile }> {
  const scopeMap = await loadScopeMap(repoPath, sha);
  return { scopeMap, invariants: parseInvariantsBytes(await readCommittedFile(repoPath, sha, INVARIANTS_PATH), scopeMap) };
}

/** Whether `contract` is one of `declared` or a method of a declared class. */
function covers(declared: readonly string[], contract: string): boolean {
  const at = contract.indexOf("::");
  if (at < 0) return false;
  const path = contract.slice(0, at);
  const parts = contract.slice(at + 2).split(".");
  return parts.some((_, index) => declared.includes(`${path}::${parts.slice(0, index + 1).join(".")}`));
}

interface PlannedSet {
  readonly source: SideBySideSet["source"];
  readonly file: string | null;
  readonly contract: string;
  readonly invariants: readonly string[];
  readonly cases: readonly ExampleCase[];
  readonly refused: SideBySideInvalid[];
}

/** The sets to run: each of the scope's examples files on main, then the risky inputs by contract. */
async function planSets(options: SideBySideOptions, request: SideBySideRequest, config: Awaited<ReturnType<typeof loadReviewConfig>>) {
  const scope = config.scopeMap.scopes.get(request.scope);
  if (scope === undefined) throw new SideBySideError(`penguin/scopes.json at ${request.base} has no scope ${request.scope}`);
  const sets: PlannedSet[] = [];
  for (const source of config.invariants.examples.filter((entry) => entry.scopeId === request.scope)) {
    const text = await readCommittedFile(options.repoPath, request.base, source.file);
    if (text === null) throw new SideBySideError(`${INVARIANTS_PATH} names ${source.file}, which main does not have`);
    let file;
    try {
      file = parseExampleFile(JSON.parse(text));
    } catch (error) {
      throw new SideBySideError(`${source.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!covers(scope.contracts, file.contract)) {
      throw new SideBySideError(`${source.file} runs ${file.contract}, which is not a contract of scope ${scope.id}`);
    }
    sets.push({ source: "examples", file: source.file, contract: file.contract, invariants: source.invariants, cases: file.cases, refused: [] });
  }
  const risky = new Map<string, PlannedSet>();
  for (const input of request.riskyInputs ?? []) {
    const set = risky.get(input.contract) ?? {
      source: "risky-inputs" as const,
      file: null,
      contract: input.contract,
      invariants: [] as string[],
      cases: [] as ExampleCase[],
      refused: [] as SideBySideInvalid[],
    };
    risky.set(input.contract, set);
    if (!covers(scope.contracts, input.contract)) {
      set.refused.push({ name: input.name, side: "request", reason: `${input.contract} is not a contract of scope ${scope.id}` });
      continue;
    }
    if (input.invariant !== undefined && !(set.invariants as string[]).includes(input.invariant)) {
      (set.invariants as string[]).push(input.invariant);
    }
    (set.cases as ExampleCase[]).push({ name: input.name, args: input.args });
  }
  return { sets: [...sets, ...risky.values()], contracts: [...config.scopeMap.contracts.keys()] };
}

interface CallResult {
  readonly id: string;
  readonly status: "returned" | "raised" | "invalid";
  readonly value?: unknown;
  readonly error?: { readonly type: string; readonly message: string };
  readonly reason?: string;
  readonly ms?: number;
}

/** Runs the scope's public functions on main and on the fork, and records where they differ. */
export async function runSideBySide(options: SideBySideOptions, request: SideBySideRequest): Promise<SideBySideRecord> {
  const started = performance.now();
  for (const sha of [request.base, request.fork]) {
    if (!isObjectId(sha)) throw new SideBySideError(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  }
  const config = await loadReviewConfig(options.repoPath, request.base);
  const { sets, contracts } = await planSets(options, request, config);
  const calls = sets.flatMap((set, index) =>
    set.cases.map((entry, caseIndex) => ({ id: `${index}:${caseIndex}`, contract: set.contract, args: entry.args })),
  );
  const input = JSON.stringify({ contracts, calls });
  // One side after the other, so each side's time is its own.
  const main = await runSide(options, request.base, input);
  const fork = await runSide(options, request.fork, input);

  const recorded: SideBySideSet[] = sets.map((set, index) => {
    const differing: SideBySideDifference[] = [];
    const invalid: SideBySideInvalid[] = [...set.refused];
    let mainMs = 0;
    let forkMs = 0;
    set.cases.forEach((entry, caseIndex) => {
      const id = `${index}:${caseIndex}`;
      const before = main.results.get(id);
      const after = fork.results.get(id);
      mainMs += before?.ms ?? 0;
      forkMs += after?.ms ?? 0;
      const refusedOn = [before?.status === "invalid" ? "main" : "", after?.status === "invalid" ? "fork" : ""].filter(Boolean);
      if (before === undefined || after === undefined || refusedOn.length > 0) {
        const reason = before?.reason ?? after?.reason ?? "the run returned no result";
        invalid.push({ name: entry.name, side: refusedOn.length === 2 ? "both" : ((refusedOn[0] ?? "both") as "main" | "fork"), reason });
        return;
      }
      const [was, now] = [outcome(before), outcome(after)];
      if (JSON.stringify(was) !== JSON.stringify(now)) differing.push({ name: entry.name, args: entry.args, main: was, fork: now });
    });
    return {
      source: set.source,
      file: set.file,
      contract: set.contract,
      invariants: [...set.invariants],
      inputs: [...set.cases.map((entry) => entry.name), ...set.refused.map((entry) => entry.name)],
      differing,
      invalid,
      mainMs,
      forkMs,
    };
  });
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    tool: SIDE_BY_SIDE_TOOL,
    commandId: SIDE_BY_SIDE_COMMAND_ID,
    base: request.base,
    fork: request.fork,
    scope: request.scope,
    sets: recorded,
    totals: {
      inputs: recorded.reduce((sum, set) => sum + set.inputs.length, 0),
      differing: recorded.reduce((sum, set) => sum + set.differing.length, 0),
      invalid: recorded.reduce((sum, set) => sum + set.invalid.length, 0),
    },
    timings: { mainMs: main.wallMs, forkMs: fork.wallMs, totalMs: performance.now() - started },
  };
}

function outcome(result: CallResult): SideBySideOutcome {
  return result.status === "raised"
    ? { status: "raised", error: result.error as { type: string; message: string } }
    : { status: "returned", value: result.value };
}

/** Runs the script on one commit in a throwaway detached worktree, then removes the worktree. */
async function runSide(options: SideBySideOptions, sha: string, input: string): Promise<{ results: Map<string, CallResult>; wallMs: number }> {
  const { script } = resolveAnalysisCommand(SIDE_BY_SIDE_COMMAND_ID);
  const dir = await realpath(await mkdtemp(join(options.scratchDir ?? tmpdir(), "penguin-side-by-side-")));
  const tree = join(dir, "tree");
  let added = false;
  const started = performance.now();
  try {
    await runGit(options.repoPath, ["worktree", "add", "--detach", "--", tree, sha]);
    added = true;
    // Python's own caches stay out of the tree, so the tree's files are the commit's files.
    const env = { ...childEnvironment(options.env ?? process.env), PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" };
    const output = await runScript(options.python ?? "python3", ["-I", script, "--tree", tree], input, env, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new SideBySideError(`the run on ${sha} wrote no JSON report`);
    }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new SideBySideError(`the run on ${sha} wrote no results`);
    return { results: new Map((results as CallResult[]).map((result) => [result.id, result])), wallMs: performance.now() - started };
  } finally {
    if (added) await runGit(options.repoPath, ["worktree", "remove", "--force", "--", tree]);
    await rm(dir, { recursive: true, force: true });
  }
}

function runScript(program: string, argv: string[], input: string, env: NodeJS.ProcessEnv, options: SideBySideOptions): Promise<string> {
  const { timeoutMs = 300_000, maxOutputBytes = 16 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let errSize = 0;
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
    // What the scope's code prints is kept only up to the cap, for the exit message.
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= maxOutputBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SideBySideError(`could not start ${program}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) return reject(new SideBySideError(failure));
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-3).join(" ");
        return reject(new SideBySideError(`exited with ${code}: ${message}`));
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
