// The resolution ladder on the check runner (PRD section 5.3). A combined run checks the originating
// checkpoint merged onto main and onto each affected fork's checkpoint, one target per running
// feature. Each failed or erred check is
// classified into one next step for one actor (`classifyFailure`, @penguin/protocol). Penguin applies
// the fixes of steps 1 to 3 itself, each into the fork that holds the failing files, and runs the
// checks again: a fix counts only once the next round's checks no longer show its failure. A failure
// a fix did not clear, or one past the round limit, goes up the ladder. Steps 4 to 6 are routed to an
// agent or a person, with the failing check attached. No step calls a model or an agent.
//
// Every tool run and every decision is recorded, round by round, for the feature page and demos.

import { changedPathsBetween, runGit } from "@penguin/git-analysis";
import {
  charterHolds,
  classifyFailure,
  codemodPlan,
  describeEdit,
  MAIN_TARGET,
  type BlockCheck,
  type CharterView,
  type EditCharter,
  type FixKind,
  type LadderDecision,
  type RecordedDecision,
  type ResolutionRecord,
  type RoutingContext,
  type ToolRunRecord,
  stewardHandle,
} from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FixApplier, FixRequest } from "./apply-fix.ts";
import { loadScopeMap } from "./command-allowlist.ts";
import type { CombinedRunner, CombinedRunReport, ForkTarget } from "./combined-run.ts";

/** The identity registry the originating agent's charter is read from. */
export const IDENTITIES_FILE = "penguin/identities.json";

/** The project's round limit unless it sets another (PRD section 7). */
export const DEFAULT_ROUND_LIMIT = 3;

export interface ResolveRequest {
  /** The originating checkpoint. */
  readonly checkpointSha: string;
  /** The commit the checkpoint was made from. */
  readonly baselineSha: string;
  /** The affected forks, each with its latest checkpoint and its person. */
  readonly targets: readonly ForkTarget[];
  /** Main's commit; defaults to the baseline. */
  readonly mainSha?: string;
  /** The handle of the agent identity whose session made the checkpoint. */
  readonly identity: string;
  readonly roundLimit?: number;
}

export interface ResolveResult {
  readonly record: ResolutionRecord;
  /** The originating checkpoint after Penguin's fixes. */
  readonly checkpointSha: string;
  /** Each target's checkpoint after Penguin's fixes, keyed by target id. */
  readonly latestCheckpoints: Readonly<Record<string, string>>;
  /** The combined run of each round, the last one on the fixed commits. */
  readonly reports: readonly CombinedRunReport[];
}

export interface ResolutionLadderOptions {
  readonly repoPath: string;
  readonly combined: CombinedRunner;
  readonly fixes: FixApplier;
}

/** One identity of `penguin/identities.json` as the routing reads it. */
export interface IdentitySeed {
  readonly handle: string;
  readonly owner: string;
  readonly charterScopes: readonly string[];
  readonly charterPaths: readonly string[];
}

/** The identities in `penguin/identities.json` at `sha`, read from Git objects. Malformed entries are skipped. */
export async function loadIdentities(repoPath: string, sha: string): Promise<IdentitySeed[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await runGit(repoPath, ["cat-file", "blob", `${sha}:${IDENTITIES_FILE}`]));
  } catch {
    return [];
  }
  const list = (parsed as { identities?: unknown })?.identities;
  if (!Array.isArray(list)) return [];
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return list.flatMap((entry: Record<string, unknown>) =>
    typeof entry?.["handle"] === "string" && typeof entry["owner"] === "string"
      ? [{ handle: entry["handle"], owner: entry["owner"], charterScopes: strings(entry["charter_scopes"]), charterPaths: strings(entry["charter_paths"]) }]
      : [],
  );
}

/**
 * The routing context of one originating identity, from the scope map and the identities. A failing
 * place outside the originating charter goes by PRD 4.4a step 1: to the builder of the target feature
 * when `builders` names one whose charter holds the scope, else to the steward of the scope's owner,
 * which Penguin keeps for every person who owns a scope. The ProjectAgent routes the task it opens
 * from the decision again, with every builder's charter (edit-tasks.ts).
 */
export function routingContext(
  scopeMap: ScopeMap,
  identities: readonly IdentitySeed[],
  handle: string,
  roundLimit: number,
  builders: ReadonlyMap<string, EditCharter> = new Map(),
): RoutingContext {
  const own = identities.find((identity) => identity.handle === handle);
  if (own === undefined) throw new Error(`${IDENTITIES_FILE} names no identity ${handle}`);
  const charter: CharterView = { handle, person: own.owner, scopes: own.charterScopes, paths: own.charterPaths };
  return {
    charter,
    roundLimit,
    scopeOf: (path) => scopeForPath(scopeMap, path),
    ownerOf: (scope) => scopeMap.scopes.get(scope)?.ownerId,
    ownerAgentOf: (scope, target) => {
      const builder = target === MAIN_TARGET ? undefined : builders.get(target);
      if (builder !== undefined && charterHolds(builder, null, scope)) return builder.handle;
      const owner = scopeMap.scopes.get(scope)?.ownerId;
      return owner === undefined ? undefined : stewardHandle(owner);
    },
  };
}

/** The paths an identity's charter allows a fix to change: its scopes' paths and its own paths. */
export function charterPaths(scopeMap: ScopeMap, charter: CharterView): string[] {
  const paths = charter.scopes.flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []);
  return [...new Set([...paths, ...charter.paths])].filter((path) => path !== "");
}

/** The paths of every scope a person owns: where Penguin may write a fix into that person's fork. */
function ownerPaths(scopeMap: ScopeMap, ownerId: string): string[] {
  return [...scopeMap.scopes.values()].filter((scope) => scope.ownerId === ownerId).flatMap((scope) => [...scope.paths]);
}

const ORIGIN = Symbol("origin");
type Side = typeof ORIGIN | string;

interface PlannedFix {
  readonly side: Side;
  readonly kind: FixKind;
  readonly paths: Set<string>;
  readonly edits: Map<string, NonNullable<FixRequest["edits"]>[number]>;
  merge?: string;
  readonly decisions: number[];
}

/** Runs the checks, the ladder and Penguin's fixes until no step Penguin takes is left. */
export class ResolutionLadder {
  readonly #options: ResolutionLadderOptions;

  constructor(options: ResolutionLadderOptions) {
    this.#options = options;
  }

  async resolve(request: ResolveRequest): Promise<ResolveResult> {
    const started = performance.now();
    const { repoPath, combined, fixes } = this.#options;
    const roundLimit = request.roundLimit ?? DEFAULT_ROUND_LIMIT;
    let origin = request.checkpointSha;
    const initial = Object.fromEntries(request.targets.map((target) => [target.id, target.checkpoint]));
    const checkpoints: Record<string, string> = { ...initial };
    const personOf = new Map(request.targets.map((target) => [target.id, target.person]));
    const decisions: RecordedDecision[] = [];
    const toolRuns: ToolRunRecord[] = [];
    const reports: CombinedRunReport[] = [];
    // Fixes Penguin applied for a target and check that did not clear its failure.
    const failedFixes = new Map<string, number>();
    let applied: number[] = [];

    for (let round = 0; ; round += 1) {
      const report = await combined.run({
        checkpointSha: origin,
        baselineSha: request.baselineSha,
        targets: request.targets.map((target) => ({ ...target, checkpoint: checkpoints[target.id] as string })),
        // A fork Penguin fixed runs its tests and type check again, whatever the impact graph says.
        recheck: Object.keys(checkpoints).filter((id) => checkpoints[id] !== initial[id]),
        ...(request.mainSha === undefined ? {} : { mainSha: request.mainSha }),
      });
      reports.push(report);
      const failing = (report.checks ?? []).filter((check) => check.result === "failed" || check.result === "error");
      settle(decisions, applied, failing, failedFixes);

      const scopeMap = await loadScopeMap(repoPath, origin);
      const context = routingContext(scopeMap, await loadIdentities(repoPath, origin), request.identity, roundLimit);
      const now = failing.map((check) => this.#classify(check, report, context, failedFixes, round));
      const firstIndex = decisions.length;
      const mainSha = request.mainSha ?? request.baselineSha;
      const { planned, unplanned } = await this.#plan(now, firstIndex, report, origin, request.baselineSha, mainSha);
      // A step Penguin takes but has nothing to work on counts as a fix that did not clear its failure.
      for (const offset of unplanned) {
        const check = failing[offset] as BlockCheck;
        bump(failedFixes, key(check));
        now[offset] = this.#classify(check, report, context, failedFixes, round);
      }
      decisions.push(...now.map((decision) => ({ ...decision, round, fixRun: null, outcome: "routed" as const })));
      if (planned.length === 0) break;

      applied = [];
      for (const fix of planned) {
        const sideCommit = fix.side === ORIGIN ? origin : (checkpoints[fix.side] as string);
        const allowed = fix.side === ORIGIN ? charterPaths(scopeMap, context.charter) : ownerPaths(scopeMap, personOf.get(fix.side) ?? fix.side);
        const run = await fixes.apply(
          {
            kind: fix.kind,
            commit: sideCommit,
            paths: fix.kind === "lockfile" ? [] : [...fix.paths].sort(),
            allowed,
            ...(fix.kind === "codemod" ? { edits: [...fix.edits.values()] } : {}),
            ...(fix.merge === undefined ? {} : { merge: fix.merge }),
          },
          `apply_fix-${toolRuns.length + 1}`,
        );
        toolRuns.push(run.record);
        const outcome = run.commit !== null ? "applied" : "refused";
        for (const index of fix.decisions) {
          decisions[index] = { ...(decisions[index] as RecordedDecision), fixRun: run.record.id, outcome };
          if (outcome === "applied") applied.push(index);
          else bump(failedFixes, key(decisions[index] as RecordedDecision));
        }
        if (run.commit === null) continue;
        if (fix.side === ORIGIN) origin = run.commit;
        else checkpoints[fix.side] = run.commit;
      }
    }

    const last = decisions.filter((decision) => decision.round === reports.length - 1);
    const record: ResolutionRecord = {
      rounds: reports.length,
      decisions,
      toolRuns,
      resolvedByPenguin: decisions.filter((decision) => decision.outcome === "accepted").length,
      routedToAgents: last.filter((decision) => decision.step === 4 || decision.step === 5).length,
      routedToPeople: last.filter((decision) => decision.step === 6).length,
      agentCalls: 0,
      durationMs: Math.round(performance.now() - started),
    };
    return { record, checkpointSha: origin, latestCheckpoints: checkpoints, reports };
  }

  #classify(check: BlockCheck, report: CombinedRunReport, context: RoutingContext, failedFixes: Map<string, number>, round: number): LadderDecision {
    return classifyCheck(check, report, context, failedFixes.get(`${check.target}:${check.check}`) ?? 0, round);
  }

  /**
   * Groups the fixes of one round by the fork they go into and their kind. Format and lint fixes go
   * into the side that changed the file: the originating checkpoint, or the target's own fork. A codemod
   * goes into the target whose code uses the changed symbol; for `main`, into the originating
   * checkpoint, whose own callers then follow. A lockfile fix merges the other side in.
   */
  async #plan(
    now: LadderDecision[],
    firstIndex: number,
    report: CombinedRunReport,
    origin: string,
    baseline: string,
    mainSha: string,
  ): Promise<{ planned: PlannedFix[]; unplanned: number[] }> {
    const planned = new Map<string, PlannedFix>();
    const unplanned: number[] = [];
    const changedByOrigin = new Set(await changedPathsBetween(this.#options.repoPath, baseline, origin));
    const add = (side: Side, kind: FixKind, index: number): PlannedFix => {
      const id = `${side === ORIGIN ? "origin" : side}:${kind}`;
      const fix: PlannedFix = planned.get(id) ?? { side, kind, paths: new Set(), edits: new Map(), decisions: [] };
      planned.set(id, fix);
      fix.decisions.push(index);
      return fix;
    };
    now.forEach((decision, offset) => {
      const index = firstIndex + offset;
      if (decision.fix === null) return;
      const owner = decision.target === MAIN_TARGET ? null : decision.target;
      const kind = decision.fix.kind;
      if (kind === "codemod") {
        const plan = report.impact ? codemodPlan(report.impact, owner) : null;
        if (plan === null || plan.paths.length === 0) return void unplanned.push(offset);
        const fix = add(owner ?? ORIGIN, kind, index);
        for (const edit of plan.edits) fix.edits.set(describeEdit(edit), edit);
        for (const path of plan.paths) fix.paths.add(path);
      } else if (kind === "lockfile") {
        add(owner ?? ORIGIN, kind, index).merge = owner === null ? mainSha : origin;
      } else {
        const paths = decision.evidence.findings.map((finding) => finding.path).filter((path): path is string => path !== null);
        if (paths.length === 0) return void unplanned.push(offset);
        for (const path of paths) add(owner === null || changedByOrigin.has(path) ? ORIGIN : owner, kind, index).paths.add(path);
      }
    });
    return { planned: [...planned.values()], unplanned };
  }
}

/** One failed or erred check of a combined run classified into its next step (`classifyFailure`). */
export function classifyCheck(check: BlockCheck, report: CombinedRunReport, context: RoutingContext, failedFixes = 0, round = 0): LadderDecision {
  const target = check.target === MAIN_TARGET ? null : check.target;
  const targetScopes = target === null ? [] : report.results.filter((result) => result.target === target).map((result) => result.scopeId);
  const codemod = report.impact === undefined || report.impact === null ? null : codemodPlan(report.impact, target);
  return classifyFailure({ check, targetScopes, codemod, failedFixes, round }, context);
}

const key = (decision: Pick<LadderDecision, "target" | "check">) => `${decision.target}:${decision.check}`;

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** Marks each fix applied last round accepted, or not cleared when its check still fails. */
function settle(decisions: RecordedDecision[], applied: readonly number[], failing: readonly BlockCheck[], failedFixes: Map<string, number>): void {
  const still = new Set(failing.map((check) => key(check)));
  for (const index of applied) {
    const decision = decisions[index] as RecordedDecision;
    const cleared = !still.has(key(decision));
    decisions[index] = { ...decision, outcome: cleared ? "accepted" : "not-cleared" };
    if (!cleared) bump(failedFixes, key(decision));
  }
}

/**
 * The resolution as text for a terminal, a feature page or the walkthrough: each round's decisions
 * with the actor and the reason, each tool run with its input and what it changed, then the counts.
 */
export function formatResolution(result: ResolveResult): string {
  const { record } = result;
  const lines: string[] = [];
  for (let round = 0; round < record.rounds; round += 1) {
    const report = result.reports[round];
    const checks = report?.checks ?? [];
    const failing = checks.filter((check) => check.result === "failed" || check.result === "error").length;
    lines.push(`round ${round + 1}: ${checks.length} checks, ${failing} failing, on ${report?.checkpointSha.slice(0, 12) ?? "?"}`);
    for (const decision of record.decisions.filter((item) => item.round === round)) {
      const fix = decision.fix === null ? "" : ` [${decision.fix.commandId}]`;
      lines.push(
        `  ${decision.target} ${decision.check}: step ${decision.step} ${decision.failure} -> ${decision.actor.kind} ${decision.actor.id}${fix}, ${decision.outcome}`,
      );
      lines.push(`    ${decision.reason}`);
    }
    const runs = new Set(record.decisions.filter((item) => item.round === round && item.fixRun !== null).map((item) => item.fixRun));
    for (const run of record.toolRuns.filter((item) => runs.has(item.id))) {
      const changed = run.changed === null ? "" : ` ${run.changed.before.slice(0, 12)} -> ${run.changed.after.slice(0, 12)}`;
      lines.push(`  ${run.id} ${run.tool} ${run.commandId ?? ""} by ${run.caller}: ${run.result}, ${run.summary}${changed} [${run.durationMs} ms]`);
      for (const path of run.changed?.paths ?? []) lines.push(`    changed ${path}`);
      for (const finding of run.findings) lines.push(`    ${finding.path ?? ""} ${finding.code ?? ""} ${finding.message}`.trimEnd());
    }
  }
  lines.push(
    `${record.resolvedByPenguin} failure${record.resolvedByPenguin === 1 ? "" : "s"} resolved by Penguin's fixes, ` +
      `${record.routedToAgents} routed to agents, ${record.routedToPeople} to people; ` +
      `${record.agentCalls} agent calls; ${record.rounds} round${record.rounds === 1 ? "" : "s"} in ${record.durationMs} ms.`,
  );
  return `${lines.join("\n")}\n`;
}
