// Writing an approved plan part's fix into the affected feature's fork (PRD 0.4 section 4.4 step 1).
//
// The writer is the check runner for every approved part and module copy, through the writes it
// claims at POST /fix-writes/claim, or, for a write opened for an agent before #207, the originating
// agent's bridge through `penguin-bridge fix-write` with the answer of the `fix_token` MCP tool.
// Either way the writer holds a `FixWriteSpec` and a write token minted for that one part on that one
// fork.
//
// The fix becomes one commit built without a checkout: the fork's `main` is fetched, its head must be
// the spec's `parent`, each file the patch writes is read at the parent, patched with `applyPatchFile`
// (the function Penguin checks the commit with), written as a blob into a scratch index over the
// parent's tree. Each module the spec's `copy` names then takes its blob at the originating checkpoint,
// byte for byte, once the writer has checked it is a file the originating change itself added or
// changed (`git diff-tree` from the change's base to the checkpoint). The tree is committed with the
// spec's message. The commit must change exactly the patch's files and the copies; anything else
// stops the write before any push.
//
// A rule write (#209) carries the originating agent's rewrite rules in `rewrite` and no patch. Once the
// fork's head is the parent, the writer applies the rules to the call sites' files at the parent with
// Penguin's codemod (`FixApplier.rewrite`), each rule's contract module read at the originating
// revision, and the rewrite becomes the patch. Rules that rewrite nothing make no write: the result is
// `unmatched`, which the runner reports so the items go back to the originating agent. The
// push fast-forwards `main` with no force, so a fork whose head moved refuses it and nothing is
// overwritten. No hook, editor or credential helper runs.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { checkFixWriteSpec, copyProblem, parsePatch, rewriteRuleContractPath, type FixRewrite, type FixWriteSpec, type ModuleCopy, type PlanFileDiff } from "@penguin/protocol";

import type { FixApplier } from "./apply-fix.ts";
import type { GitRemote } from "./git-remote.ts";
import { patchedTree } from "./patch-tree.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";

export type FixWriteResult =
  | { readonly status: "written"; readonly commit: string; readonly parent: string; readonly durationMs: number }
  /** The fork's head is not the spec's parent: ask Penguin again, which rebases or sends the part back. */
  | { readonly status: "moved"; readonly head: string; readonly durationMs: number }
  /** The spec or the patch does not hold; nothing was pushed. */
  | { readonly status: "refused"; readonly reason: string; readonly durationMs: number }
  /** A rule write's rules rewrote nothing at the parent; nothing was pushed. */
  | { readonly status: "unmatched"; readonly reason: string; readonly durationMs: number };

export interface FixWriterOptions {
  /** A Git repository the fork is fetched into; the commit is built from its objects. */
  readonly repoPath: string;
  /** The affected fork, reached with the token minted for this part. */
  readonly remote: GitRemote;
  readonly scratchDir?: string;
  /** Applies a rule write's rules; without it a rule write is refused. */
  readonly rewriter?: Pick<FixApplier, "rewrite">;
}

/** The commit's author and committer: the fix is the plan's, written for it. */
const WRITER_ENV = {
  GIT_AUTHOR_NAME: "Penguin",
  GIT_AUTHOR_EMAIL: "penguin@penguin.invalid",
  GIT_COMMITTER_NAME: "Penguin",
  GIT_COMMITTER_EMAIL: "penguin@penguin.invalid",
};
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

/** Writes `spec`'s fix as one commit on the fork's branch. */
export async function writeFix(options: FixWriterOptions, spec: FixWriteSpec): Promise<FixWriteResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const refused = (reason: string): FixWriteResult => ({ status: "refused", reason, durationMs: elapsed() });

  const problems = checkFixWriteSpec(spec);
  if (problems.length > 0) return refused(`the write is malformed at ${problems[0]?.path || "the top"}: ${problems[0]?.message}`);
  if (spec.rewrite !== undefined && (spec.patch !== "" || spec.paths.length > 0)) return refused("a rule write carries no patch of its own");
  let parsed: { ok: true; files: readonly PlanFileDiff[] } | { ok: false; message: string } = spec.patch === "" ? { ok: true, files: [] } : parsePatch(spec.patch);
  if (!parsed.ok) return refused(`the patch does not parse: ${parsed.message}`);
  if (parsed.files.length === 0 && spec.copy === undefined && spec.rewrite === undefined) return refused("the write carries neither a patch nor a copy");
  let paths = parsed.files.map((file) => file.path).sort();
  if (paths.join("\n") !== [...spec.paths].sort().join("\n")) return refused("the spec's paths are not the patch's files");
  const copies = [...(spec.copy?.paths ?? [])].sort();

  const { repoPath, remote } = options;
  const ref = `refs/penguin/fix-writes/${spec.writeId}`;
  await remote.git(repoPath, (url) => ["fetch", "--quiet", "--no-tags", "--end-of-options", url, `+refs/heads/${spec.branch}:${ref}`]);
  const head = (await runGit(repoPath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  if (head !== spec.parent) return { status: "moved", head, durationMs: elapsed() };
  if (spec.rewrite !== undefined) {
    const rewritten = await ruleRewrite(options, spec.parent, spec.rewrite);
    if (rewritten.status !== "ok") return rewritten.status === "unmatched" ? { status: "unmatched", reason: rewritten.reason, durationMs: elapsed() } : refused(rewritten.reason);
    parsed = { ok: true, files: rewritten.files };
    paths = rewritten.files.map((file) => file.path).sort();
  }
  const both = copies.find((path) => paths.includes(path));
  if (both !== undefined) return refused(`the patch and the copy both write ${both}`);

  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), "penguin-fix-write-"));
  try {
    const patched = await patchedTree(repoPath, spec.parent, parsed.files, scratch);
    if (!patched.ok) return refused(patched.message);
    const copied = spec.copy === undefined ? patched : await copiedTree(repoPath, patched.tree, spec.copy, scratch);
    if (!copied.ok) return refused(copied.message);
    const { tree } = copied;
    const changed = (await runGit(repoPath, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", spec.parent, tree])).split("\0").filter(Boolean).sort();
    const expected = [...paths, ...copies].sort();
    if (changed.join("\n") !== expected.join("\n")) return refused(`the commit would change ${changed.join(", ") || "nothing"}, not exactly the patch's files and the copies`);
    const message = join(scratch, "message");
    await writeFile(message, spec.message, { mode: 0o600 });
    const commit = (await runGit(repoPath, [...NO_HOOKS, "commit-tree", tree, "-p", spec.parent, "-F", message], { env: WRITER_ENV })).trim();
    try {
      // No force: a fork whose head moved since the fetch refuses the push and keeps its head.
      await remote.git(repoPath, (url) => ["push", "--porcelain", "--end-of-options", url, `${commit}:refs/heads/${spec.branch}`]);
    } catch (error) {
      await remote.git(repoPath, (url) => ["fetch", "--quiet", "--no-tags", "--end-of-options", url, `+refs/heads/${spec.branch}:${ref}`]);
      const now = (await runGit(repoPath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
      if (now !== spec.parent && now !== commit) return { status: "moved", head: now, durationMs: elapsed() };
      if (now !== commit) return refused(`the fork refused the push: ${(error as Error).message.trim().split("\n").at(-1) ?? ""}`);
    }
    return { status: "written", commit, parent: spec.parent, durationMs: elapsed() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A rule write's rules applied at `parent` to the call sites' files only: the files they change as a
 * parsed patch, `unmatched` when they change none, or why they could not run.
 */
async function ruleRewrite(
  options: FixWriterOptions,
  parent: string,
  rewrite: FixRewrite,
): Promise<{ readonly status: "ok"; readonly files: readonly PlanFileDiff[] } | { readonly status: "unmatched" | "refused"; readonly reason: string }> {
  if (options.rewriter === undefined) return { status: "refused", reason: "this runner applies no rewrite rules" };
  const contracts: Record<string, string> = {};
  for (const path of new Set(rewrite.rules.map(rewriteRuleContractPath))) {
    const source = await runGit(options.repoPath, ["show", `${rewrite.source}:${path}`]).catch(() => null);
    if (source === null) return { status: "refused", reason: `${path} is not at the originating revision ${rewrite.source}` };
    contracts[path] = source;
  }
  const outcome = await options.rewriter.rewrite({ commit: parent, paths: rewrite.paths, allowed: rewrite.paths, rules: rewrite.rules, contracts });
  if (outcome.error !== null) return { status: "refused", reason: `the rules could not run: ${outcome.error}` };
  const [first] = outcome.refused;
  if (first !== undefined) return { status: "refused", reason: `the codemod refused rule ${first.rule}: ${first.message}` };
  if (outcome.patch == null || outcome.files.length === 0) return { status: "unmatched", reason: `the rules match no call in ${rewrite.paths.join(", ")}` };
  const parsed = parsePatch(outcome.patch);
  if (!parsed.ok) return { status: "refused", reason: `the rules' rewrite does not parse: ${parsed.message}` };
  const stray = parsed.files.find((file) => !rewrite.paths.includes(file.path));
  if (stray !== undefined) return { status: "refused", reason: `the rules changed ${stray.path}, which is no call site's file` };
  return { status: "ok", files: parsed.files };
}

const REGULAR_MODES = new Set(["100644", "100755"]);

/**
 * `tree` with each of `copy`'s modules set to its blob and mode at the originating checkpoint, byte for
 * byte. A module that is not a file the originating change itself added or changed, from its base to
 * the checkpoint, is refused, as is an originating commit this repository does not hold. `scratch` is
 * an empty folder.
 */
export async function copiedTree(repoPath: string, tree: string, copy: ModuleCopy, scratch: string): Promise<{ readonly ok: true; readonly tree: string } | { readonly ok: false; readonly message: string }> {
  for (const commit of [copy.source, copy.base]) {
    const held = await runGit(repoPath, ["cat-file", "-e", `${commit}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!held) return { ok: false, message: `the originating commit ${commit} is not in the repository` };
  }
  const changed = new Set((await runGit(repoPath, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", copy.base, copy.source])).split("\0").filter(Boolean));
  const problem = copyProblem(copy.paths, changed);
  if (problem !== null) return { ok: false, message: problem };
  const env = { GIT_INDEX_FILE: join(scratch, "copy-index") };
  await runGit(repoPath, ["read-tree", tree], { env });
  for (const path of copy.paths) {
    const entry = (await runGit(repoPath, ["ls-tree", "-z", "--end-of-options", copy.source, "--", path])).split("\0")[0] ?? "";
    const [meta = "", listed] = entry.split("\t");
    const [mode, , blob] = meta.split(" ");
    // A module the change deleted is no module to copy.
    if (listed !== path || !REGULAR_MODES.has(mode ?? "")) return { ok: false, message: `${path} is not a regular file at the originating checkpoint` };
    await runGit(repoPath, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
  }
  return { ok: true, tree: (await runGit(repoPath, ["write-tree"], { env })).trim() };
}

/** One write the runner claimed:the spec and the token minted for that part on that fork. */
export interface ClaimedFixWrite {
  readonly spec: FixWriteSpec;
  readonly token: { readonly token: string; readonly remote: string; readonly expiresAt: string };
}

/** Penguin's answer to a reported write. */
export interface FixWriteReply {
  readonly status: "written";
  readonly commit: string;
  readonly recordId: string;
  readonly durationMs: number;
}

export interface FixWritePassOptions {
  readonly claim: () => Promise<readonly ClaimedFixWrite[]>;
  readonly write: (claimed: ClaimedFixWrite) => Promise<FixWriteResult>;
  readonly report: (writeId: number, commit: string) => Promise<FixWriteReply>;
  /** Reports a rule write whose rules rewrote nothing; absent, it counts as a stopped write. */
  readonly unmatched?: (writeId: number, reason: string) => Promise<unknown>;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface FixWritePassEntry {
  readonly writeId: number;
  readonly partId: string;
  readonly fork: string;
  readonly result: FixWriteResult | null;
  readonly reply: FixWriteReply | null;
  /** Why the write stopped; the pass then reports it as failed. */
  readonly error: string | null;
  /** What Penguin did with the stopped write; null when it did not stop or could not be reported. */
  readonly failure: FailureNote | null;
}

export interface FixWritePassResult {
  readonly claimed: number;
  readonly writes: readonly FixWritePassEntry[];
  readonly durationMs: number;
}

/** Claims, writes and reports every claimed fix write and module copy once (runner mode). */
export async function fixWritePass(options: FixWritePassOptions): Promise<FixWritePassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const writes: FixWritePassEntry[] = [];
  const stop = async (entry: Omit<FixWritePassEntry, "failure">) =>
    writes.push({ ...entry, failure: await noteFailure(options.fail, "fix-write", String(entry.writeId), entry.error ?? "the write stopped") });
  for (const each of claimed) {
    const base = { writeId: each.spec.writeId, partId: each.spec.partId, fork: each.spec.fork };
    let result: FixWriteResult;
    try {
      result = await options.write(each);
    } catch (error) {
      await stop({ ...base, result: null, reply: null, error: (error as Error).message });
      continue;
    }
    if (result.status === "unmatched" && options.unmatched !== undefined) {
      try {
        await options.unmatched(each.spec.writeId, result.reason);
        writes.push({ ...base, result, reply: null, error: null, failure: null });
      } catch (error) {
        await stop({ ...base, result, reply: null, error: (error as Error).message });
      }
      continue;
    }
    if (result.status !== "written") {
      await stop({ ...base, result, reply: null, error: result.status === "moved" ? `the fork moved to ${result.head}` : result.reason });
      continue;
    }
    try {
      writes.push({ ...base, result, reply: await options.report(each.spec.writeId, result.commit), error: null, failure: null });
    } catch (error) {
      await stop({ ...base, result, reply: null, error: (error as Error).message });
    }
  }
  return { claimed: claimed.length, writes, durationMs: Math.round(performance.now() - started) };
}

export function formatFixWritePass(result: FixWritePassResult): string {
  const lines = result.writes.map(({ writeId, partId, fork, result: written, reply, error, failure }) => {
    const name = `Fix write ${writeId} (part ${partId}) on ${fork}`;
    if (written?.status === "written" && reply !== null) return `${name}: ${written.commit.slice(0, 12)} kept as ${reply.recordId} (${written.durationMs} ms).`;
    if (written?.status === "unmatched" && error === null) return `${name}: ${written.reason}; nothing written, and the rules went back to the originating agent.`;
    return `${name} stopped; ${failureText(failure)}: ${error ?? "unknown"}`;
  });
  lines.push(`${result.claimed} fix write${result.claimed === 1 ? "" : "s"} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
