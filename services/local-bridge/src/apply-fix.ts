// Penguin's deterministic fixes (PRD section 5.2, `apply_fix`, and the ladder's steps 1 to 3): the
// formatter, lint autofix, a regenerated lockfile and a codemod generated from the contract diff.
//
// Each fix runs one fixed program with an argument vector and no shell, in a throwaway worktree of
// the commit it starts from, with the scrubbed environment of a test command:
//
// | Kind     | Command ID           | Program                                             |
// |----------|----------------------|-----------------------------------------------------|
// | format   | fix:ruff-format      | `ruff format` on the named files                    |
// | lint     | fix:ruff-autofix     | `ruff check --fix` on the named files               |
// | lockfile | fix:uv-lock          | `uv lock`, after merging the other side when given  |
// | codemod  | fix:python-codemod   | the bridge's libcst script on the named files       |
//
// A merge plan's rewrite rules run through the same codemod script (`rewrite`), followed by the lint
// autofix and the formatter on the files the rules changed. That run reports blobs and commits nothing.
//
// A fix may change only the files it names, and only inside the allowed paths: the caller's charter
// or the approved part of a plan. A lockfile fix may change only the lockfiles. A named file that is
// a symlink, or lies under a symlinked directory, is refused before any program runs. When the
// program changes anything else, the fix is refused and nothing is committed. A fix that changes
// files becomes one commit on top of the commit it started from.

import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isObjectId, runGit } from "@penguin/git-analysis";
import {
  codemodEditProblem,
  FIX_COMMAND_IDS,
  rewriteRuleContractPath,
  rewriteRuleProblem,
  FIX_KINDS,
  REGENERATED_LOCKFILES,
  type BlockCheckFinding,
  type CodemodEdit,
  type FixKind,
  type PlanRewriteFile,
  type RewriteRule,
  type ToolCaller,
  type ToolRunRecord,
} from "@penguin/protocol";
import { InvalidPathError, normalizeRepoPath } from "@penguin/scope-map";

import { resolveAnalysisCommand } from "./command-allowlist.ts";
import { defaultRuff, ruffConfig, runProgram, type ProgramOutcome } from "./check-tools.ts";
import { inDetachedWorktree } from "./test-runner.ts";

export const FIX_LIMITS = { paths: 2_000, allowed: 256 } as const;

export interface FixRequest {
  readonly kind: FixKind;
  /** The commit the fix starts from: a full object ID. */
  readonly commit: string;
  /** The files to fix. A lockfile fix names none. */
  readonly paths: readonly string[];
  /** Path prefixes the fix may change: the caller's charter or the approved part of a plan. */
  readonly allowed: readonly string[];
  /** The codemod's edits, from the contract diff. */
  readonly edits?: readonly CodemodEdit[];
  /**
   * Instead of edits: rewrite rules a plan declared for retiring symbols (retiring.ts), applied as the
   * ladder's step 3 to a new call of a retiring symbol. Each rule's contract module is read at `commit`.
   */
  readonly rules?: readonly RewriteRule[];
  /** For a lockfile fix: the commit merged in first; the lockfiles it conflicts on are regenerated. */
  readonly merge?: string;
  readonly caller?: ToolCaller;
}

export interface FixRun {
  readonly record: ToolRunRecord;
  /** The commit the fix made, or null when it changed nothing or was refused. */
  readonly commit: string | null;
  /** The program's output, kept on the runner. */
  readonly log: string;
}

export interface FixApplierOptions {
  readonly repoPath: string;
  /** The ruff program; defaults to `defaultRuff()`. */
  readonly ruff?: string;
  /** The uv program; defaults to PENGUIN_UV, then `uv` on PATH. */
  readonly uv?: string;
  /** The interpreter with libcst for the codemod; defaults to `defaultCodemodPython()`. */
  readonly python?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly scratchDir?: string;
  /** A program still running after this long is stopped. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
}

/** A merge plan's rewrite rules to apply to some files of one commit (PRD 0.4 section 4.2 step 4). */
export interface RewriteRequest {
  readonly commit: string;
  /** The Python files the rules may rewrite. */
  readonly paths: readonly string[];
  /** Path prefixes the rewrite may change: the place's scopes. */
  readonly allowed: readonly string[];
  readonly rules: readonly RewriteRule[];
  /** Each rule's contract module as the originating checkpoint holds it, by path. */
  readonly contracts: Readonly<Record<string, string>>;
}

/** What the rules wrote: each changed file's blob before and after. Nothing is committed. */
export interface RewriteOutcome {
  readonly refused: readonly { readonly rule: string; readonly message: string }[];
  readonly files: readonly PlanRewriteFile[];
  readonly error: string | null;
}

/** A fix the request itself rules out; nothing ran. */
export class FixRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixRefusedError";
  }
}

/**
 * The interpreter the codemod runs under unless told otherwise: PENGUIN_CODEMOD_PYTHON, then the
 * interpreter of this repository's uv environment (`.venv/bin/python`), which has the pinned libcst,
 * then `python3` on PATH.
 */
export function defaultCodemodPython(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PENGUIN_CODEMOD_PYTHON) return env.PENGUIN_CODEMOD_PYTHON;
  const pinned = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".venv", "bin", "python");
  return existsSync(pinned) ? pinned : "python3";
}

const PENGUIN_COMMITTER = ["-c", "user.name=Penguin", "-c", "user.email=penguin@penguin.invalid", "-c", "commit.gpgsign=false"];
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const under = (path: string, prefix: string): boolean => {
  const trimmed = prefix.replace(/\/+$/u, "");
  return path === trimmed || path.startsWith(`${trimmed}/`);
};

/** Checks a request's fields; raises FixRefusedError with the first problem. */
export function checkFixRequest(request: FixRequest): void {
  if (!(FIX_KINDS as readonly string[]).includes(request.kind)) throw new FixRefusedError(`no fix of kind ${JSON.stringify(request.kind)}`);
  if (!isObjectId(request.commit)) throw new FixRefusedError("the commit must be a full object ID");
  if (request.merge !== undefined && (request.kind !== "lockfile" || !isObjectId(request.merge))) {
    throw new FixRefusedError("only a lockfile fix merges, and it names a full object ID");
  }
  if (request.paths.length > FIX_LIMITS.paths) throw new FixRefusedError(`at most ${FIX_LIMITS.paths} paths`);
  if (request.allowed.length === 0 || request.allowed.length > FIX_LIMITS.allowed) {
    throw new FixRefusedError(`a fix needs 1 to ${FIX_LIMITS.allowed} allowed paths`);
  }
  for (const prefix of request.allowed) normalized(prefix, "an allowed path");
  if (request.kind === "lockfile") {
    if (request.paths.length > 0) throw new FixRefusedError("a lockfile fix names no files; it regenerates the lockfiles");
  } else {
    if (request.paths.length === 0) throw new FixRefusedError(`a ${request.kind} fix names the files it fixes`);
    for (const path of request.paths) {
      const clean = normalized(path, "a path");
      if (!clean.endsWith(".py")) throw new FixRefusedError(`${clean} is not a Python file`);
      if (!request.allowed.some((prefix) => under(clean, normalized(prefix, "an allowed path")))) {
        throw new FixRefusedError(`${clean} lies outside the allowed paths (${request.allowed.join(", ")})`);
      }
    }
  }
  if (request.kind === "codemod" && request.rules !== undefined) {
    if (request.edits !== undefined) throw new FixRefusedError("a codemod takes edits or rules, not both");
    if (request.rules.length === 0) throw new FixRefusedError("a codemod by rules needs at least one rule");
    for (const rule of request.rules) {
      const problem = rewriteRuleProblem(rule);
      if (problem !== null) throw new FixRefusedError(`a rewrite rule is malformed: ${problem}`);
    }
  } else if (request.kind === "codemod") {
    if (request.edits === undefined || request.edits.length === 0) throw new FixRefusedError("a codemod needs edits from the contract diff");
    for (const edit of request.edits) {
      const problem = codemodEditProblem(edit);
      if (problem !== null) throw new FixRefusedError(`a codemod edit is malformed: ${problem}`);
    }
  } else if (request.edits !== undefined || request.rules !== undefined) {
    throw new FixRefusedError("only a codemod takes edits or rules");
  }
}

function normalized(path: string, what: string): string {
  try {
    const clean = normalizeRepoPath(path);
    if (clean === "") throw new FixRefusedError(`${what} may not be the repository root`);
    return clean;
  } catch (error) {
    if (error instanceof InvalidPathError) throw new FixRefusedError(`${what} is not a repository path: ${JSON.stringify(path)}`);
    throw error;
  }
}

/**
 * Why `path` may not be touched inside `worktree`: it, or a directory on the way to it, is a symlink,
 * or it resolves outside the checkout. Null when it may. A missing file is left to the program.
 */
export async function symlinkRefusal(worktree: string, path: string): Promise<string | null> {
  let current = worktree;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return `${path} is or lies under a symlink`;
    } catch {
      return null;
    }
  }
  const root = await realpath(worktree);
  const resolved = await realpath(current).catch(() => null);
  if (resolved === null) return null;
  return resolved === root || resolved.startsWith(`${root}${sep}`) ? null : `${path} resolves outside the checkout`;
}

/** Applies Penguin's deterministic fixes in throwaway worktrees and commits each result. */
export class FixApplier {
  readonly #options: FixApplierOptions;
  #runs = 0;

  constructor(options: FixApplierOptions) {
    this.#options = options;
  }

  /** Applies one fix. Never raises for a refused or failed fix: the record says what happened. */
  async apply(request: FixRequest, id = `apply_fix-${++this.#runs}`): Promise<FixRun> {
    const started = performance.now();
    const commandId = FIX_COMMAND_IDS[request.kind] ?? null;
    const input: Record<string, unknown> = {
      kind: request.kind,
      commit: request.commit,
      paths: [...request.paths],
      allowed: [...request.allowed],
      ...(request.edits === undefined ? {} : { edits: request.edits.map((edit) => ({ ...edit })) }),
      ...(request.rules === undefined ? {} : { rules: request.rules.map((rule) => rule.id) }),
      ...(request.merge === undefined ? {} : { merge: request.merge }),
    };
    const record = (fields: Pick<ToolRunRecord, "result" | "summary"> & Partial<ToolRunRecord>): ToolRunRecord => ({
      id,
      tool: "apply_fix",
      caller: request.caller ?? "penguin",
      commandId,
      input,
      findings: [],
      changed: null,
      durationMs: Math.round(performance.now() - started),
      ...fields,
    });
    try {
      checkFixRequest(request);
    } catch (error) {
      if (error instanceof FixRefusedError) return { record: record({ result: "refused", summary: error.message }), commit: null, log: "" };
      throw error;
    }
    const { repoPath, scratchDir } = this.#options;
    try {
      const { value } = await inDetachedWorktree(repoPath, request.commit, scratchDir ?? tmpdir(), (worktree) =>
        this.#inWorktree(request, worktree),
      );
      const changed = value.commit === null ? null : { before: request.commit, after: value.commit, paths: value.paths };
      return { record: record({ ...value.outcome, changed }), commit: value.commit, log: value.log };
    } catch (error) {
      return { record: record({ result: "error", summary: (error as Error).message.slice(0, 300) }), commit: null, log: "" };
    }
  }

  /**
   * Applies a plan's rewrite rules with the codemod (`fix:python-codemod`), then ruff's lint autofix
   * and formatter on the files the rules changed, as the ladder's steps 3 and 1 would, in a throwaway
   * worktree of `request.commit`. Reports each changed file's blob before and after; commits nothing.
   * A rule the codemod refuses is listed and not applied. Never raises for a failed run: `error` says why.
   */
  async rewrite(request: RewriteRequest): Promise<RewriteOutcome> {
    const failed = (error: string): RewriteOutcome => ({ refused: [], files: [], error: error.slice(0, 300) });
    try {
      // With no paths the codemod only checks the rules, so the refusals are known everywhere.
      if (request.paths.length > 0) checkFixRequest({ kind: "format", commit: request.commit, paths: request.paths, allowed: request.allowed });
      else if (!isObjectId(request.commit)) throw new FixRefusedError("the commit must be a full object ID");
    } catch (error) {
      if (error instanceof FixRefusedError) return failed(error.message);
      throw error;
    }
    const { repoPath, scratchDir } = this.#options;
    try {
      const { value } = await inDetachedWorktree(repoPath, request.commit, scratchDir ?? tmpdir(), (worktree) => this.#rewriteIn(request, worktree));
      return value;
    } catch (error) {
      return failed((error as Error).message);
    }
  }

  async #rewriteIn(request: RewriteRequest, worktree: string): Promise<RewriteOutcome> {
    const paths = request.paths.map((path) => normalizeRepoPath(path));
    for (const path of paths) {
      const problem = await symlinkRefusal(worktree, path);
      if (problem !== null) return { refused: [], files: [], error: problem };
    }
    const options = { env: this.#options.env, timeoutMs: this.#options.timeoutMs };
    const { script } = resolveAnalysisCommand(FIX_COMMAND_IDS.codemod);
    const python = this.#options.python ?? defaultCodemodPython(this.#options.env);
    const input = JSON.stringify({ rules: request.rules, contracts: request.contracts, paths });
    const ran = failedExit(await runProgram(python, ["-I", script, "--tree", worktree], worktree, { ...options, input }), [0], "the codemod");
    if (ran.stopped !== null) return { refused: [], files: [], error: ran.stopped };
    const report = JSON.parse(ran.stdout) as { refused: { rule: string; message: string }[]; changed: { path: string; rules: string[] }[] };
    const refused = report.refused.map(({ rule, message }) => ({ rule, message: message.slice(0, 300) }));
    const rulesOf = new Map(report.changed.map((entry) => [entry.path, entry.rules]));
    const touched = [...rulesOf.keys()];
    if (touched.length > 0) {
      const ruff = this.#options.ruff ?? defaultRuff(this.#options.env);
      const lint = ["check", "--fix", "--no-cache", "--exit-zero", "--quiet", ...ruffConfig(worktree), "--", ...touched];
      for (const [argv, name] of [[lint, "ruff check --fix"], [["format", "--no-cache", "--quiet", ...ruffConfig(worktree), "--", ...touched], "ruff format"]] as const) {
        const outcome = failedExit(await runProgram(ruff, [...argv], worktree, options), [0], name);
        if (outcome.stopped !== null) return { refused, files: [], error: outcome.stopped };
      }
    }
    const changed = await changedFiles(worktree);
    const stray = changed.filter((path) => !paths.includes(path) || !request.allowed.some((prefix) => under(path, prefix)));
    if (stray.length > 0) return { refused, files: [], error: `the rules changed files they may not change: ${stray.slice(0, 5).join(", ")}` };
    const files: PlanRewriteFile[] = [];
    for (const path of changed) {
      const before = (await runGit(worktree, ["rev-parse", `HEAD:${path}`])).trim();
      const after = (await runGit(worktree, ["hash-object", "--", path])).trim();
      if (before !== after) files.push({ path, before, after, rules: rulesOf.get(path) ?? [] });
    }
    return { refused, files, error: null };
  }

  async #inWorktree(request: FixRequest, worktree: string): Promise<{
    outcome: { result: ToolRunRecord["result"]; summary: string; findings: BlockCheckFinding[] };
    commit: string | null;
    paths: string[];
    log: string;
  }> {
    const refuse = (summary: string, log = "") => ({ outcome: { result: "refused" as const, summary, findings: [] }, commit: null, paths: [], log });
    const paths = request.paths.map((path) => normalizeRepoPath(path));
    for (const path of paths) {
      const problem = await symlinkRefusal(worktree, path);
      if (problem !== null) return refuse(problem);
    }
    const ran = await this.#run(request, worktree, paths);
    if ("refused" in ran) return refuse(ran.refused, ran.log ?? "");
    const { outcome, findings, log } = ran;
    if (outcome.stopped !== null) return { outcome: { result: "error", summary: outcome.stopped, findings }, commit: null, paths: [], log };

    const changed = await changedFiles(worktree);
    const lockfileOnly = request.kind === "lockfile";
    const stray = changed.filter((path) =>
      lockfileOnly ? !REGENERATED_LOCKFILES.has(baseName(path)) : !paths.includes(path) || !request.allowed.some((prefix) => under(path, prefix)),
    );
    if (stray.length > 0) return refuse(`the fix changed files it may not change: ${stray.slice(0, 5).join(", ")}`, log);
    for (const path of changed) {
      const problem = await symlinkRefusal(worktree, path);
      if (problem !== null) return refuse(problem, log);
    }
    if (changed.length === 0 && request.merge === undefined) {
      return { outcome: { result: "unchanged", summary: `${request.kind}: nothing to change`, findings }, commit: null, paths: [], log };
    }
    if (changed.length > 0) await runGit(worktree, ["add", "--", ...changed]);
    const message = `Penguin fix: ${request.kind} (${FIX_COMMAND_IDS[request.kind]})\n\nPenguin-Fix: ${FIX_COMMAND_IDS[request.kind]}\n`;
    await runGit(worktree, [...PENGUIN_COMMITTER, ...NO_HOOKS, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message]);
    const commit = (await runGit(worktree, ["rev-parse", "HEAD"])).trim();
    // The commit outlives the throwaway worktree; a ref keeps it from garbage collection.
    await runGit(this.#options.repoPath, ["update-ref", `refs/penguin/fixes/${commit}`, commit]);
    const summary = `${request.kind}: changed ${changed.length} file${changed.length === 1 ? "" : "s"}${request.merge === undefined ? "" : `, merging ${request.merge.slice(0, 12)}`}`;
    return { outcome: { result: "changed", summary, findings }, commit, paths: changed, log };
  }

  async #run(
    request: FixRequest,
    worktree: string,
    paths: readonly string[],
  ): Promise<{ outcome: ProgramOutcome; findings: BlockCheckFinding[]; log: string } | { refused: string; log?: string }> {
    const options = { env: this.#options.env, timeoutMs: this.#options.timeoutMs };
    const ruff = this.#options.ruff ?? defaultRuff(this.#options.env);
    const done = (outcome: ProgramOutcome, findings: BlockCheckFinding[] = []) => ({ outcome, findings, log: `${outcome.stdout}${outcome.stderr}` });
    switch (request.kind) {
      case "format": {
        const outcome = await runProgram(ruff, ["format", "--no-cache", ...ruffConfig(worktree), "--", ...paths], worktree, options);
        return done(failedExit(outcome, [0], "ruff format"));
      }
      case "lint": {
        const argv = ["check", "--fix", "--no-cache", "--exit-zero", "--output-format", "json", ...ruffConfig(worktree), "--", ...paths];
        const outcome = await runProgram(ruff, argv, worktree, options);
        return done(failedExit(outcome, [0], "ruff check --fix"), remainingLint(outcome.stdout, worktree));
      }
      case "codemod": {
        const { script } = resolveAnalysisCommand(FIX_COMMAND_IDS.codemod);
        const python = this.#options.python ?? defaultCodemodPython(this.#options.env);
        const input = JSON.stringify(request.rules === undefined ? { edits: request.edits, paths } : { rules: request.rules, contracts: await ruleContracts(worktree, request.rules), paths });
        const outcome = await runProgram(python, ["-I", script, "--tree", worktree], worktree, { ...options, input });
        return done(failedExit(outcome, [0], "the codemod"), codemodFindings(outcome.stdout));
      }
      case "lockfile":
        return this.#lockfile(request, worktree, options);
    }
  }

  async #lockfile(
    request: FixRequest,
    worktree: string,
    options: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<{ outcome: ProgramOutcome; findings: BlockCheckFinding[]; log: string } | { refused: string; log?: string }> {
    let lockfiles: string[] = [];
    if (request.merge !== undefined) {
      try {
        await runGit(worktree, [...PENGUIN_COMMITTER, ...NO_HOOKS, "merge", "--no-ff", "--no-commit", "--quiet", "--end-of-options", request.merge]);
      } catch {
        // A conflict leaves the merge in progress; the conflicted files decide what happens.
      }
      const conflicted = (await runGit(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter((path) => path !== "");
      const others = conflicted.filter((path) => !REGENERATED_LOCKFILES.has(baseName(path)));
      if (others.length > 0) return { refused: `the merge conflicts outside the lockfile: ${others.slice(0, 5).join(", ")}` };
      lockfiles = conflicted;
      // Either side's lockfile will do: uv lock rewrites it from the merged pyproject.toml. Staging it
      // resolves the conflict, so only what uv lock then changes counts as the fix.
      for (const path of lockfiles) {
        await runGit(worktree, ["checkout", "--ours", "--", path]);
        await runGit(worktree, ["add", "--", path]);
      }
    }
    if (lockfiles.length === 0) {
      lockfiles = (await runGit(worktree, ["ls-files", "-z"])).split("\0").filter((path) => REGENERATED_LOCKFILES.has(baseName(path)));
    }
    if (lockfiles.length === 0) return { refused: "the tree has no uv.lock to regenerate" };
    const uv = this.#options.uv ?? this.#options.env?.PENGUIN_UV ?? process.env.PENGUIN_UV ?? "uv";
    let log = "";
    for (const path of lockfiles) {
      const problem = await symlinkRefusal(worktree, path);
      if (problem !== null) return { refused: problem, log };
      const directory = join(worktree, dirname(path));
      const outcome = failedExit(await runProgram(uv, ["lock", "--no-progress"], directory, options), [0], "uv lock");
      log += `${outcome.stdout}${outcome.stderr}`;
      if (outcome.stopped !== null) return { outcome, findings: [], log };
    }
    return { outcome: { exitCode: 0, stdout: log, stderr: "", stopped: null }, findings: [], log };
  }
}

/** An outcome whose exit code is not one of `ok` turns into a stopped one that says so. */
function failedExit(outcome: ProgramOutcome, ok: readonly number[], name: string): ProgramOutcome {
  if (outcome.stopped !== null || (outcome.exitCode !== null && ok.includes(outcome.exitCode))) return outcome;
  const last = (outcome.stderr || outcome.stdout).trim().split("\n").at(-1) ?? "";
  return { ...outcome, stopped: `${name} exited with ${outcome.exitCode}: ${last}`.slice(0, 300) };
}

/** The lint findings `ruff check --fix` could not fix. */
function remainingLint(stdout: string, worktree: string): BlockCheckFinding[] {
  try {
    const diagnostics = JSON.parse(stdout) as { code?: string | null; message: string; filename: string; location?: { row: number } | null }[];
    return diagnostics.slice(0, 20).map((item) => ({
      path: (isAbsolute(item.filename) ? relative(worktree, item.filename) : item.filename).split(sep).join("/").slice(0, 1_024),
      line: item.location?.row ?? null,
      code: item.code ?? null,
      message: `not fixed: ${item.message}`.slice(0, 300),
    }));
  } catch {
    return [];
  }
}

/** The files the codemod refused or could not parse. */
/**
 * Each rule's contract module as the worktree holds it, by path: the codemod reads which names the
 * module defines from it. A module the worktree lacks is left out, and the codemod refuses its rules.
 */
async function ruleContracts(worktree: string, rules: readonly RewriteRule[]): Promise<Record<string, string>> {
  const contracts: Record<string, string> = {};
  for (const path of new Set(rules.map(rewriteRuleContractPath))) {
    try {
      contracts[path] = await runGit(worktree, ["show", `HEAD:${normalizeRepoPath(path)}`]);
    } catch {
      // Absent at the commit.
    }
  }
  return contracts;
}

function codemodFindings(stdout: string): BlockCheckFinding[] {
  try {
    const report = JSON.parse(stdout) as { errors?: { path: string; kind: string; message: string }[] };
    return (report.errors ?? []).slice(0, 20).map((error) => ({
      path: error.path.slice(0, 1_024),
      line: null,
      code: error.kind.slice(0, 128),
      message: error.message.slice(0, 300),
    }));
  } catch {
    return [];
  }
}

/**
 * The files a program changed in a worktree: those that differ from the index, and new files. The
 * index holds HEAD, or the merged tree when a lockfile fix merged first, so a merge's own changes
 * never count as the program's.
 */
async function changedFiles(worktree: string): Promise<string[]> {
  const modified = await runGit(worktree, ["diff", "--name-only", "--no-renames", "-z"]);
  const added = await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set(`${modified}\0${added}`.split("\0").filter((path) => path !== ""))].sort();
}
