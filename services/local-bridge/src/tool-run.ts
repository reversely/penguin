// Runner mode's agent tools (PRD 0.4 section 5.2): claim the `impact`, `check` and `apply_fix`
// requests agents made on their features, run each on the feature's fork and report the result to
// POST /tool-runs/<id>. Penguin delivers it to the requesting session at its next safe checkpoint.
//
// A claim names the feature's fork, the checkpoint, its baseline on main, the caller's charter and the
// other running features' forks. The runner fetches every fork with a read token into its own
// repository, as it does for reviews (review-run.ts).
//
// - `impact` runs `analysis:python-impact` on the baseline and the checkpoint, searching each other
//   fork for uses of the change. When the project has retiring symbols (retiring.ts), the request
//   carries them. A request Penguin made at a checkpoint (`search: "own"`) is the retiring-calls
//   check: one analysis of the checkpoint's own changes, with one ladder step per file and symbol it
//   uses. An agent's `impact` call also lists the remaining callers on main and in each other
//   running feature's own changes, grouped by owner, from a second analysis. Penguin's own count
//   after a promotion (`search: "callers"`) runs only that second analysis, on main at the promotion
//   and every running feature, and reports it as the result's impact. Penguin's rewrite of a split's
//   migration parts (`search: "rewrite"`) applies the declared rules to each place and reports each
//   place's patch with the uses it leaves (`runMigrationRewrite`). Penguin's read of main's scope
//   dependencies after a promotion (`search: "edges"`) runs one analysis of main with `edges: true`
//   and reports the scope pairs with their counts (`runScopeEdges`).
// - `check` runs a combined run with the block checks (combined-run.ts): the checkpoint merged onto
//   its baseline (`main`) and onto each other running feature's fork, keyed by the feature id. A
//   person with two running features gets two merged trees, each tested in that person's scopes. Each failed or erred
//   check gets its one next step from the resolution ladder (`classifyCheck`). No fix is applied: a
//   fix for steps 1 to 3 is the agent's `apply_fix`, or Penguin's once a merge plan grants it a fork.
// - `apply_fix` applies the requested fix to the checkpoint inside the caller's charter
//   (apply-fix.ts). The runner holds write on a feature's fork only for an approved mechanical plan
//   part, with a token minted for that part (fix-write.ts), so the commit stays at
//   `refs/penguin/fixes/<commit>` in the runner's repository and is reported with `pushed: false`.
//
// A request whose forks or commits cannot be fetched stays claimed until its lease runs out and is
// then run again. A tool that runs and fails is reported as `error`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  boundToolResult,
  countIsComplete,
  MIGRATION_LIMITS,
  parsePatch,
  type MigrationRewritePlace,
  type PlanFileDiff,
  type PlanPlace,
  selectAffectedForks,
  TOOL_RESULT_LIMITS,
  TOOL_RESULT_SCHEMA_VERSION,
  type AgentToolResult,
  type CharterView,
  type CodemodEdit,
  type FixKind,
  type ImpactReport,
  migrationGroups,
  retiringCallDecisions,
  retiringCallerUses,
  retiringUses,
  rewriteRuleContractPath,
  type RetiringDeclaration,
  type RewriteRule,
  type ToolCaller,
} from "@penguin/protocol";
import { commitMergedTree, runGit } from "@penguin/git-analysis";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FixApplier } from "./apply-fix.ts";
import { loadScopeMap } from "./command-allowlist.ts";
import type { CombinedRunner } from "./combined-run.ts";
import type { ImpactAnalyzer } from "./impact-analysis.ts";
import type { ClaimedToolRun, ToolRunReply } from "./penguin-client.ts";
import { charterPaths, classifyCheck, DEFAULT_ROUND_LIMIT, loadIdentities, routingContext } from "./resolution.ts";
import { patchedTree } from "./patch-tree.ts";
import { hasCommit } from "./runner-repo.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";

export interface ToolPassOptions {
  /** Claims the waiting requests, such as `claimToolRuns` bound to the bridge token. */
  readonly claim: () => Promise<readonly ClaimedToolRun[]>;
  /** Reports one request's result, such as `reportToolRun` bound to the bridge token. */
  readonly report: (runId: number, result: AgentToolResult) => Promise<ToolRunReply>;
  /** Makes every commit of a feature's fork (`feature-<id>`) available in `repoPath`. */
  readonly fetchFork: (fork: string) => Promise<void>;
  readonly impact: ImpactAnalyzer;
  /** Runs the block checks; its runner must hold consent for the scopes' tests. */
  readonly combined: CombinedRunner;
  readonly fixes: FixApplier;
  /** The runner's repository. */
  readonly repoPath: string;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface ToolRunResult {
  readonly runId: number;
  readonly tool: ClaimedToolRun["tool"];
  readonly feature: string;
  /** The result reported, or null when the request did not run. */
  readonly result: AgentToolResult | null;
  /** Penguin's answer, or null when nothing was reported. */
  readonly reply: ToolRunReply | null;
  /** Why the request stopped; the pass then reports it as failed. */
  readonly error: string | null;
  /** What Penguin did with the stopped request; null when it did not stop or could not be reported. */
  readonly failure: FailureNote | null;
}

export interface ToolPassResult {
  readonly claimed: number;
  readonly runs: readonly ToolRunResult[];
  readonly durationMs: number;
}

/** Claims, runs and reports every waiting tool request once. Each fork is fetched once a pass. */
export async function toolPass(options: ToolPassOptions): Promise<ToolPassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const fetched = new Map<string, Promise<void>>();
  const fetchOnce = (fork: string): Promise<void> => {
    if (!fetched.has(fork)) fetched.set(fork, options.fetchFork(fork));
    return fetched.get(fork) as Promise<void>;
  };
  const runs: ToolRunResult[] = [];
  for (const claim of claimed) runs.push(await runOne(options, claim, fetchOnce));
  return { claimed: claimed.length, runs, durationMs: Math.round(performance.now() - started) };
}

async function runOne(options: ToolPassOptions, claim: ClaimedToolRun, fetchFork: (fork: string) => Promise<void>): Promise<ToolRunResult> {
  const base = { runId: claim.runId, tool: claim.tool, feature: claim.feature };
  let result: AgentToolResult;
  try {
    for (const fork of [claim.fork, ...claim.forks.map((other) => other.fork)]) await fetchFork(fork);
    for (const sha of [claim.base, claim.checkpoint, ...claim.forks.map((other) => other.checkpoint)]) {
      if (!(await hasCommit(options.repoPath, sha))) throw new Error(`commit ${sha} is not in the fetched forks`);
    }
  } catch (error) {
    const reason = (error as Error).message;
    return { ...base, result: null, reply: null, error: reason, failure: await noteFailure(options.fail, "tool", String(claim.runId), reason) };
  }
  const started = performance.now();
  try {
    result = await runTool(options, claim);
  } catch (error) {
    result = { ...emptyResult(claim), result: "error", summary: bounded(`${claim.tool} could not run: ${(error as Error).message}`) };
  }
  result = boundToolResult({ ...result, durationMs: Math.round(performance.now() - started) });
  try {
    return { ...base, result, reply: await options.report(claim.runId, result), error: null, failure: null };
  } catch (error) {
    const reason = `the result was not reported: ${(error as Error).message}`;
    return { ...base, result, reply: null, error: reason, failure: await noteFailure(options.fail, "tool", String(claim.runId), reason) };
  }
}

const bounded = (text: string): string => text.slice(0, TOOL_RESULT_LIMITS.summaryLength);
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function emptyResult(claim: ClaimedToolRun): AgentToolResult {
  return {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    tool: claim.tool,
    base: claim.base,
    checkpoint: claim.checkpoint,
    result: "found",
    summary: "",
    impact: null,
    checks: [],
    decisions: [],
    fix: null,
    fixRef: null,
    pushed: false,
    durationMs: 0,
  };
}

function runTool(options: ToolPassOptions, claim: ClaimedToolRun): Promise<AgentToolResult> {
  switch (claim.tool) {
    case "impact":
      return runImpact(options, claim);
    case "check":
      return runCheck(options, claim);
    case "apply_fix":
      return runFix(options, claim);
  }
}

/** The scopes each person owns, which the impact analysis searches in that person's fork. */
function ownedScopes(scopeMap: ScopeMap, person: string): string[] {
  return [...scopeMap.scopes.values()].filter((scope) => scope.driId === person).map((scope) => scope.id);
}

/** The retiring symbols a request carries, as the ProjectAgent recorded them; empty when none. */
function retiringOf(claim: ClaimedToolRun): RetiringDeclaration[] {
  const listed = claim.input["retiring"];
  return Array.isArray(listed) ? (listed as RetiringDeclaration[]) : [];
}

async function runImpact(options: ToolPassOptions, claim: ClaimedToolRun): Promise<AgentToolResult> {
  if (claim.input["search"] === "edges") return runScopeEdges(options, claim);
  const scopeMap = await loadScopeMap(options.repoPath, claim.checkpoint);
  const retiring = retiringOf(claim);
  if (retiring.length > 0 && claim.input["search"] === "own") return runRetiringCheck(options, claim, scopeMap, retiring);
  if (retiring.length > 0 && claim.input["search"] === "callers") return runCallerCount(options, claim, scopeMap, retiring);
  if (retiring.length > 0 && claim.input["search"] === "rewrite") return runMigrationRewrite(options, claim, scopeMap, retiring);
  const forks = claim.forks.map((other) => ({ id: other.feature, sha: other.checkpoint, scopes: ownedScopes(scopeMap, other.person) }));
  const impact: ImpactReport = await options.impact({ base: claim.base, head: claim.checkpoint, forks });
  const using = selectAffectedForks(impact);
  const summary =
    `${plural(impact.changes.length, "changed symbol")}, ${plural(impact.contracts.length, "contract")} touched; ` +
    (using.length === 0 ? "no other running feature uses the change" : `used by ${using.join(", ")}`);
  if (retiring.length === 0) return { ...emptyResult(claim), impact, summary: bounded(summary) };
  // The remaining callers of retiring symbols: on main (the baseline) and in each running feature's
  // own changes since its merge base with main.
  const callers = await options.impact({
    base: claim.base,
    head: claim.base,
    forks: claim.forks.map((other) => ({ id: other.feature, sha: other.checkpoint, scopes: [], since: claim.base })),
    symbols: retiring.map((each) => each.contract),
  });
  const person = new Map(claim.forks.map((other) => [other.feature, other.person]));
  const migration = migrationGroups(callers, retiring, (scope) => scopeMap.scopes.get(scope)?.driId, (feature) => person.get(feature), (path) => scopeForPath(scopeMap, path));
  const places = migration.groups.reduce((sum, group) => sum + group.places.length, 0);
  const listed = `; retiring symbols: ${plural(places, "place")} left in ${plural(migration.groups.length, "owner group")}`;
  return { ...emptyResult(claim), impact, migration, summary: bounded(`${summary}${listed}`) };
}

/**
 * Penguin's count after a promotion (`search: "callers"`): one analysis of main at the promotion,
 * with every running feature as a fork of its own changes since that commit, searched for every
 * retiring symbol. The report is the result's impact, from which Penguin counts each symbol's
 * callers; the migration groups come with it.
 */
async function runCallerCount(options: ToolPassOptions, claim: ClaimedToolRun, scopeMap: ScopeMap, retiring: readonly RetiringDeclaration[]): Promise<AgentToolResult> {
  const impact = await options.impact({
    base: claim.base,
    head: claim.base,
    forks: claim.forks.map((other) => ({ id: other.feature, sha: other.checkpoint, scopes: [], since: claim.base })),
    symbols: retiring.map((each) => each.contract),
  });
  const person = new Map(claim.forks.map((other) => [other.feature, other.person]));
  const scopeOf = (path: string) => scopeForPath(scopeMap, path);
  const migration = migrationGroups(impact, retiring, (scope) => scopeMap.scopes.get(scope)?.driId, (feature) => person.get(feature), scopeOf);
  const uses =
    retiringCallerUses(impact.headUses, retiring, null, scopeOf).length +
    impact.forks.reduce((sum, fork) => sum + retiringCallerUses(fork.uses, retiring, fork.id, scopeOf).length, 0);
  const summary =
    `${plural(uses, "caller")} of ${plural(retiring.length, "retiring symbol")} on main and in the own changes of ${plural(claim.forks.length, "running feature")}` +
    (impact.complete ? "" : "; the report is incomplete");
  return { ...emptyResult(claim), impact, migration, summary: bounded(summary) };
}

/**
 * Penguin's read of main's scope dependencies after a promotion (`search: "edges"`): one analysis of
 * main at the promotion with `edges: true`. The report names scope ids and counts, no code.
 */
async function runScopeEdges(options: ToolPassOptions, claim: ClaimedToolRun): Promise<AgentToolResult> {
  const impact = await options.impact({ base: claim.base, head: claim.base, forks: [], edges: true });
  const edges = impact.scopeEdges ?? [];
  const summary =
    `${edges.length} scope ${edges.length === 1 ? "dependency" : "dependencies"} read from main at ${claim.base.slice(0, 12)}` +
    (impact.complete ? "" : "; the report is incomplete");
  return { ...emptyResult(claim), impact, summary: bounded(summary) };
}

/** One place Penguin's rewrite request names: its target and the files whose uses the rules may rewrite. */
interface RewritePlaceInput {
  readonly place: PlanPlace;
  readonly target: string;
  readonly paths: readonly string[];
}

const clipError = (text: string): string => text.slice(0, MIGRATION_LIMITS.errorLength);

/**
 * Penguin's rewrite of a split's migration parts (`search: "rewrite"`, migration.ts): for each place,
 * the declared rules applied to its files in a throwaway worktree of its target (main at the request's
 * baseline, or the running feature's fork head), as a patch. The patches are then applied, without a
 * checkout, to commits kept only in the runner's repository, and one analysis of those commits counts
 * the uses of a retiring symbol each place still holds. Nothing is pushed.
 */
async function runMigrationRewrite(options: ToolPassOptions, claim: ClaimedToolRun, scopeMap: ScopeMap, retiring: readonly RetiringDeclaration[]): Promise<AgentToolResult> {
  const places = (Array.isArray(claim.input["places"]) ? (claim.input["places"] as RewritePlaceInput[]) : []).slice(0, MIGRATION_LIMITS.places);
  const rules = retiring.flatMap((each) => each.rules);
  const contracts: Record<string, string> = {};
  for (const contract of new Set(rules.map(rewriteRuleContractPath))) {
    try {
      contracts[contract] = await runGit(options.repoPath, ["show", `${claim.base}:${contract}`]);
    } catch {
      // Absent on main: the codemod refuses the rule.
    }
  }
  const heads = new Map(claim.forks.map((fork) => [fork.feature, fork.checkpoint]));
  const rewritten: { input: RewritePlaceInput; sha: string | null; files: MigrationRewritePlace["files"]; patch: string | null; error: string | null }[] = [];
  for (const input of places) {
    const sha = input.target === "main" ? claim.base : (heads.get(input.target) ?? null);
    if (sha === null) {
      rewritten.push({ input, sha, files: [], patch: null, error: `feature ${input.target} is not a running feature with a checkpoint` });
      continue;
    }
    const paths = [...input.paths].slice(0, MIGRATION_LIMITS.files);
    const outcome = await options.fixes.rewrite({ commit: sha, paths, allowed: paths, rules, contracts });
    const patch = outcome.patch ?? null;
    const error = outcome.error ?? (patch !== null && new TextEncoder().encode(patch).length > MIGRATION_LIMITS.patchBytes ? "the patch is over its size limit" : null);
    rewritten.push({ input, sha, files: outcome.files.map((file) => ({ path: file.path, rules: [...file.rules] })), patch: error === null ? patch : null, error: error === null ? null : clipError(error) });
  }

  // The uses left: each target's patches applied to a commit of its own, then one analysis.
  const scratch = await mkdtemp(join(tmpdir(), "penguin-migration-"));
  const after = new Map<string, string>();
  try {
    const byTarget = new Map<string, { sha: string; files: PlanFileDiff[] }>();
    for (const entry of rewritten) {
      if (entry.sha === null || entry.patch === null) continue;
      const parsed = parsePatch(entry.patch);
      if (!parsed.ok) {
        entry.error = clipError(`the rewrite's patch does not parse: ${parsed.message}`);
        entry.patch = null;
        continue;
      }
      const known = byTarget.get(entry.input.target) ?? { sha: entry.sha, files: [] };
      known.files.push(...parsed.files);
      byTarget.set(entry.input.target, known);
    }
    for (const [target, { sha, files }] of byTarget) {
      const tree = await patchedTree(options.repoPath, sha, files, await mkdtemp(join(scratch, "tree-")));
      if (tree.ok) after.set(target, await commitMergedTree(options.repoPath, tree.tree, [sha]));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const main = after.get("main") ?? claim.base;
  const forkTargets = [...new Set(places.map((each) => each.target).filter((target) => target !== "main" && heads.has(target)))];
  let residual: ImpactReport | null = null;
  let residualError: string | null = null;
  try {
    residual = await options.impact({
      base: main,
      head: main,
      forks: forkTargets.map((id) => ({ id, sha: after.get(id) ?? (heads.get(id) as string), scopes: [], since: claim.base })),
      symbols: retiring.map((each) => each.contract),
    });
    if (!countIsComplete(residual)) residualError = "the analysis of the rewritten trees is incomplete";
  } catch (error) {
    residualError = clipError(`the analysis of the rewritten trees failed: ${(error as Error).message}`);
  }
  const left = (input: RewritePlaceInput): number => {
    if (residual === null) return 0;
    const place = input.place;
    // The defining scope's own uses are no part's: the contract step removes them.
    const scopeOf = (path: string) => scopeForPath(scopeMap, path);
    if (place.kind === "scope") return retiringCallerUses(residual.headUses, retiring, null, scopeOf).filter(({ use }) => use.scope === place.scope).length;
    return retiringCallerUses(residual.forks.find((fork) => fork.id === place.feature)?.uses ?? [], retiring, place.feature, scopeOf).length;
  };
  const rewrites: MigrationRewritePlace[] = rewritten.map((entry) => ({
    place: entry.input.place,
    target: entry.input.target,
    sha: entry.sha ?? claim.base,
    files: entry.files.slice(0, MIGRATION_LIMITS.files),
    patch: entry.patch,
    residual: left(entry.input),
    error: entry.error ?? residualError,
  }));
  const written = rewrites.filter((each) => each.error === null && each.patch !== null && each.residual === 0).length;
  const summary = `the declared rules rewrite ${plural(written, "place")} of ${plural(rewrites.length, "place")} with no use of a retiring symbol left`;
  return { ...emptyResult(claim), rewrites, summary: bounded(summary) };
}

/**
 * For each file of the checkpoint's own changes that uses a retiring symbol with declared rewrite
 * rules: the ids of the rules that rewrite it, from a dry run of the codemod on the checkpoint that
 * commits nothing (FixApplier.rewrite). A file no rule changes is absent.
 */
async function ruleRewrites(
  options: ToolPassOptions,
  claim: ClaimedToolRun,
  impact: ImpactReport,
  retiring: readonly RetiringDeclaration[],
): Promise<Map<string, string[]>> {
  const rulesByPath = new Map<string, Map<string, RewriteRule>>();
  for (const { use, declaration } of retiringUses(impact.forks.find((fork) => fork.id === claim.feature)?.uses ?? [], retiring)) {
    const rules = rulesByPath.get(use.path) ?? new Map<string, RewriteRule>();
    for (const rule of declaration.rules) rules.set(rule.id, rule);
    if (rules.size > 0) rulesByPath.set(use.path, rules);
  }
  const rewritten = new Map<string, string[]>();
  for (const [path, byId] of rulesByPath) {
    const rules = [...byId.values()];
    const contracts: Record<string, string> = {};
    for (const contract of new Set(rules.map(rewriteRuleContractPath))) {
      try {
        contracts[contract] = await runGit(options.repoPath, ["show", `${claim.checkpoint}:${contract}`]);
      } catch {
        // Absent at the checkpoint: the codemod refuses the rule.
      }
    }
    const outcome = await options.fixes.rewrite({ commit: claim.checkpoint, paths: [path], allowed: [path], rules, contracts });
    const file = outcome.error === null ? outcome.files.find((each) => each.path === path) : undefined;
    if (file !== undefined) rewritten.set(path, [...file.rules]);
  }
  return rewritten;
}

/**
 * The retiring-calls check (PRD 0.5 section 5.1) on a checkpoint Penguin recorded: one analysis of the
 * checkpoint against its baseline, with the checkpoint as a fork of its own changes since the
 * baseline, searched for the retiring symbols. Each file and symbol it uses gets one next step.
 */
async function runRetiringCheck(options: ToolPassOptions, claim: ClaimedToolRun, scopeMap: ScopeMap, retiring: readonly RetiringDeclaration[]): Promise<AgentToolResult> {
  const impact = await options.impact({
    base: claim.base,
    head: claim.checkpoint,
    forks: [{ id: claim.feature, sha: claim.checkpoint, scopes: [], since: claim.base }],
    symbols: retiring.map((each) => each.contract),
  });
  const context = await routing(options, claim, scopeMap);
  const rewritten = await ruleRewrites(options, claim, impact, retiring);
  const decisions = retiringCallDecisions(impact, claim.feature, retiring, context, claim.checkpoint, (path) => rewritten.get(path) ?? []);
  const summary =
    decisions.length === 0
      ? "the checkpoint's own changes call no retiring symbol"
      : `the checkpoint's own changes use retiring symbols in ${plural(decisions.length, "place")}: ` +
        decisions.map((decision) => `${decision.evidence.findings[0]?.path} (step ${decision.step})`).join(", ");
  return { ...emptyResult(claim), impact, decisions, summary: bounded(summary) };
}

/** The caller's charter as the ladder reads it, with the project's identities for the owners' agents. */
async function routing(options: ToolPassOptions, claim: ClaimedToolRun, scopeMap: ScopeMap) {
  const { handle, person, scopes, paths } = claim.charter;
  const seeded = (await loadIdentities(options.repoPath, claim.checkpoint)).filter((identity) => identity.handle !== handle);
  const identities = [{ handle, owner: person, charterScopes: scopes, charterPaths: paths }, ...seeded];
  return routingContext(scopeMap, identities, handle, DEFAULT_ROUND_LIMIT);
}

async function runCheck(options: ToolPassOptions, claim: ClaimedToolRun): Promise<AgentToolResult> {
  const report = await options.combined.run({
    checkpointSha: claim.checkpoint,
    baselineSha: claim.base,
    targets: claim.forks.map((other) => ({ id: other.feature, person: other.person, checkpoint: other.checkpoint })),
    mainSha: claim.base,
    // The feature's person's own dependent scopes run on the checkpoint, never as no-checkpoint.
    changer: claim.person,
  });
  const checks = report.checks ?? [];
  const failing = checks.filter((check) => check.result === "failed" || check.result === "error");
  const context = await routing(options, claim, await loadScopeMap(options.repoPath, claim.checkpoint));
  const decisions = failing.map((check) => classifyCheck(check, report, context));
  const places = [...new Set(failing.map((check) => `${check.target} ${check.check}`))];
  const summary = `${plural(checks.length, "check")}, ${failing.length} failing${places.length === 0 ? "" : `: ${places.join(", ")}`}`;
  return { ...emptyResult(claim), checks, decisions, summary: bounded(summary) };
}

async function runFix(options: ToolPassOptions, claim: ClaimedToolRun): Promise<AgentToolResult> {
  const scopeMap = await loadScopeMap(options.repoPath, claim.checkpoint);
  const { handle, person, scopes, paths } = claim.charter;
  const charter: CharterView = { handle, person, scopes, paths };
  const input = claim.input as {
    readonly kind: FixKind;
    readonly paths?: readonly string[];
    readonly edits?: readonly CodemodEdit[];
    /** The expand step's edits, as the ProjectAgent derived them from the feature's sorted contract diff. */
    readonly expand?: readonly CodemodEdit[];
    /** A codemod by the rewrite rules of retiring symbols, as the ProjectAgent resolved them. */
    readonly rules?: readonly RewriteRule[];
  };
  const run = await options.fixes.apply(
    {
      kind: input.kind,
      commit: claim.checkpoint,
      paths: [...(input.paths ?? [])],
      allowed: charterPaths(scopeMap, charter),
      ...(input.edits === undefined ? {} : { edits: input.edits }),
      ...(input.expand === undefined ? {} : { expand: input.expand }),
      ...(input.rules === undefined ? {} : { rules: input.rules }),
      caller: handle as ToolCaller,
    },
    `apply_fix-${claim.runId}`,
  );
  const fixRef = run.commit === null ? null : `refs/penguin/fixes/${run.commit}`;
  const kept = fixRef === null ? "" : `; kept on the runner as ${run.commit?.slice(0, 12)}, not pushed`;
  return {
    ...emptyResult(claim),
    result: run.record.result === "waiting" || run.record.result === "found" ? "error" : run.record.result,
    summary: bounded(`${run.record.summary}${kept}`),
    fix: run.record,
    fixRef,
  };
}

export function formatToolPass(result: ToolPassResult): string {
  const lines: string[] = [];
  for (const run of result.runs) {
    const name = `Tool request ${run.runId} (${run.tool}) on feature ${run.feature}`;
    if (run.error !== null && run.result === null) {
      lines.push(`${name} stopped; ${failureText(run.failure)}: ${run.error}`);
    } else if (run.error !== null) {
      lines.push(`${name}: ${run.result?.result}, ${run.error}; ${failureText(run.failure)}`);
    } else {
      lines.push(`${name}: ${run.result?.result}, ${run.result?.summary}.`);
    }
  }
  lines.push(`${plural(result.claimed, "tool request")} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
