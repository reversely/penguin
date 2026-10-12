// The contract step of a parallel change (PRD 0.5 section 4.2 step 2): "When the impact graph shows no
// caller of a retiring symbol on main or in any running feature's own changes, Penguin proposes
// removing it. That plan has no places, so Penguin approves and promotes it."
//
// 1. **Count.** Each promotion of main, a feature's block or an expand checkpoint, records one
//    `impact` request of Penguin's own while symbols are retiring (`requestRetiringCount`). The check
//    runner searches main at the promotion plus every running feature's own changes since that
//    commit, for every retiring symbol in one analysis (`search: "callers"`, tool-run.ts on the
//    bridge). The request is the promoted feature's, whose fork holds main's new head.
// 2. **Propose.** When the runner reports (`countReported`), each symbol keeps its callers
//    (retiring-store.ts). The defining scope's own uses, in the module that defines the symbol and in
//    that scope's test files (protocol `inDefiningFiles`), are no callers: they are kept apart as the
//    symbol's own files, which the contract step edits when it removes the symbol and its tests
//    together. A use in any other file of that scope is a caller. The contract step batches per
//    defining package, the directory that holds the symbol's module (`definingPackage`): a symbol
//    with no caller in a complete report is proposed once every retiring symbol of its originating
//    feature in that package has none, so the package's symbols are removed together, in one
//    proposal and one task. It is proposed for removal on its originating feature while that feature
//    is running. The proposal is a signed `contract_proposed`
//    record: the plan has no places, so no part needs a person (section 4.3) and Penguin approves it.
//    The feature's next step names the symbols to remove (contract-split.ts). When the originating
//    feature is no longer running, its landed fork is read-only, so `carry` (migration-plans.ts)
//    opens a short-lived feature from main for the DRI of each scope that defines the symbols, signs
//    the same proposal there and gives the removal to that DRI's steward as an edit task. An approved
//    symbol whose caller came back loses the approval with a signed `contract_withdrawn` record.
// 3. **Close.** When the originating feature's block reaches main (`closeRemoved`), each approved
//    symbol the landed checkpoint's contract diff removes leaves the retiring symbols, under a signed
//    `symbols_removed` record. A later checkpoint that calls it no longer gets a retiring-calls step;
//    it fails the type check and tests on the missing name like any other.
//
// A count proves "no caller" only from a complete report (`countIsComplete`): an incomplete or
// oversized report keeps every symbol's callers unknown. Nothing is then proposed or withdrawn.

import {
  contractPath,
  contractRemoved,
  countIsComplete,
  retiringCallerCounts,
  type RetiringCallerCount,
  type RetiringDeclaration,
  type RetiringSymbol,
} from "@penguin/protocol";

import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import { retiringInput, type AgentToolRun, type AgentToolStore } from "./agent-tools.ts";
import type { FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import type { PlanFactsStore } from "./plan-facts.ts";
import type { RetiringStore } from "./retiring-store.ts";

/** The session a count request of Penguin's own is recorded under; no agent session has this id. */
export const PENGUIN_SESSION = "penguin";
/** The `search` of a count request's input. */
export const CALLERS_SEARCH = "callers";
/** The `search` of Penguin's rewrite request of a split's migration parts (migration-plans.ts). */
export const REWRITE_SEARCH = "rewrite";

export interface RetiringCountDeps {
  readonly features: FeatureStore;
  readonly runs: AgentToolStore;
  readonly retiring: RetiringStore;
  /** The facts runs whose contract diff shows what a landed checkpoint removed. */
  readonly facts: PlanFactsStore;
  /**
   * The project's scope map on main, which says which test files are a retiring symbol's defining
   * scope's own. Absent, only a use in the defining module itself is left out of the callers.
   */
  readonly scopeMap?: () => Promise<ScopeMap>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  readonly notify?: (personId: string) => void;
  /**
   * Carries the removal of `symbols` whose originating feature `featureId` is no longer running
   * (migration-plans.ts `carryContract`): the proposals it signed, one per carrying feature. Absent,
   * such symbols stay retiring with no callers.
   */
  readonly carry?: (
    featureId: string,
    symbols: readonly RetiringSymbol[],
    count: { readonly promotion: string; readonly runId: number },
  ) => Promise<readonly { readonly feature: string; readonly contracts: readonly string[]; readonly recordId: string }[]>;
}

/** What one count changed: the callers of each symbol (null when incomplete) with the features proposed or withdrawn. */
export interface CountOutcome {
  readonly counts: readonly RetiringCallerCount[] | null;
  readonly proposed: readonly { readonly feature: string; readonly contracts: readonly string[]; readonly recordId: string }[];
  readonly withdrawn: readonly { readonly feature: string; readonly contracts: readonly string[]; readonly recordId: string }[];
}

const short = (sha: string): string => sha.slice(0, 12);
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const isCount = (run: AgentToolRun): boolean => run.tool === "impact" && run.input["search"] === CALLERS_SEARCH;

/**
 * After the promotion of `featureId` moved main to `mainAfter`: one count request of Penguin's own for
 * the check runner, searching for every retiring symbol. Undefined when nothing is retiring, the
 * feature is unknown or this promotion was already counted.
 */
export function requestRetiringCount(deps: Pick<RetiringCountDeps, "features" | "runs" | "retiring">, featureId: string, mainAfter: string): number | undefined {
  const retiring = deps.retiring.list();
  if (retiring.length === 0 || deps.features.get(featureId) === undefined) return undefined;
  if (deps.runs.list(featureId).some((run) => isCount(run) && run.checkpointSha === mainAfter)) return undefined;
  const run = deps.runs.insert({
    featureId,
    sessionId: PENGUIN_SESSION,
    caller: "penguin",
    tool: "impact",
    input: { feature: featureId, search: CALLERS_SEARCH, promotion: mainAfter, retiring: retiring.map(retiringInput) },
    result: "waiting",
    summary: `Penguin's count of the callers of ${plural(retiring.length, "retiring symbol")} after promotion ${short(mainAfter)} waits for the check runner`,
    checkpointSha: mainAfter,
    durationMs: 0,
    baseSha: mainAfter,
  });
  return run.id;
}

/** Declarations grouped by their originating feature, features in id order. */
function byFeature<T extends { readonly feature: string }>(items: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.feature, [...(groups.get(item.feature) ?? []), item]);
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * The package that holds a contract's defining module: its directory, as `shared/money` holds both
 * `shared/money/__init__.py` and `shared/money/discounts.py`. Real code removes a package's retired
 * functions together, so the contract step waits for all of them.
 */
export function definingPackage(contract: string): string {
  const path = contractPath(contract);
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

const symbolsOf = (items: readonly RetiringSymbol[]) => items.map(({ contract, replacement }) => ({ contract, replacement }));

/**
 * The runner reported count request `run`: each counted symbol keeps its callers. Penguin proposes and
 * approves removing each symbol with none on its running originating feature. It withdraws the
 * approval of each symbol whose caller came back. Undefined for any other request.
 */
export async function countReported(deps: RetiringCountDeps, run: AgentToolRun): Promise<CountOutcome | undefined> {
  if (!isCount(run) || run.outcome === null) return undefined;
  const promotion = String(run.input["promotion"] ?? run.checkpointSha);
  const asked = new Set((Array.isArray(run.input["retiring"]) ? (run.input["retiring"] as RetiringDeclaration[]) : []).map((each) => each.contract));
  // Only symbols still retiring and searched for by this request are counted.
  const declared = deps.retiring.list().filter((each) => asked.has(each.contract));
  const impact = run.outcome.result === "found" ? run.outcome.impact : null;
  const scopeMap = impact !== null && deps.scopeMap !== undefined ? await deps.scopeMap() : undefined;
  const scopeOf = (path: string) => (scopeMap === undefined ? undefined : scopeForPath(scopeMap, path));
  const counts = impact !== null && countIsComplete(impact) ? retiringCallerCounts(impact, declared, scopeOf) : null;
  deps.retiring.counted(
    declared.map((each) => each.contract),
    counts,
    run.id,
    promotion,
  );
  if (counts === null) return { counts, proposed: [], withdrawn: [] };

  const callers = new Map(counts.map((each) => [each.contract, each.callers]));
  const approved = deps.retiring.approvedSteps();
  const held = new Set(approved.map((step) => step.contract));
  const withdrawn: { feature: string; contracts: string[]; recordId: string }[] = [];
  for (const [feature, steps] of byFeature(approved.filter((step) => (callers.get(step.contract) ?? 0) > 0))) {
    const person = deps.features.get(feature)?.personId;
    if (person === undefined) continue;
    const record = await deps.sign(
      deps.features.draftRecord(feature, "contract_withdrawn", { penguin: true }, {
        promotion,
        count_run: run.id,
        symbols: steps.map((step) => ({ contract: step.contract, callers: callers.get(step.contract) ?? 0, approval: step.recordId })),
      }),
    );
    deps.features.addRecord(record);
    deps.retiring.withdrawRemoval(steps.map((step) => step.contract));
    withdrawn.push({ feature, contracts: steps.map((step) => step.contract), recordId: record.record_id });
    deps.notify?.(person);
  }

  const proposed: { feature: string; contracts: string[]; recordId: string }[] = [];
  // A package waits while any retiring symbol of its originating feature there has a caller or no count.
  const batch = (each: { readonly feature: string; readonly contract: string }) => `${each.feature}\0${definingPackage(each.contract)}`;
  const waiting = new Set(deps.retiring.list().filter((each) => callers.get(each.contract) !== 0).map(batch));
  const free = declared.filter((each) => callers.get(each.contract) === 0 && !held.has(each.contract) && !waiting.has(batch(each)));
  const own = new Map(counts.map((each) => [each.contract, each.ownFiles]));
  for (const [featureId, symbols] of byFeature(free)) {
    const feature = deps.features.get(featureId);
    if (feature === undefined) continue;
    // The removal is written on the originating feature's fork; a landed fork is read-only, so a
    // feature Penguin opens from main carries it instead.
    if (!RUNNING_STATES.has(feature.state)) {
      if (deps.carry !== undefined) proposed.push(...(await deps.carry(featureId, symbolsOf(symbols), { promotion, runId: run.id })).map((each) => ({ ...each, contracts: [...each.contracts] })));
      continue;
    }
    const record = await deps.sign(
      deps.features.draftRecord(featureId, "contract_proposed", { penguin: true }, {
        promotion,
        count_run: run.id,
        symbols: symbolsOf(symbols),
        callers: 0,
        // The defining scope's own uses: no callers, removed by the contract step with the symbols.
        own_files: [...new Set(symbols.flatMap((each) => own.get(each.contract) ?? []))].sort(),
        places: [],
        approved_by: "penguin",
        reason: "no caller is left on main or in any running feature's own changes, so the plan has no places and no part needs a person",
      }),
    );
    deps.features.addRecord(record);
    deps.retiring.approveRemoval(featureId, symbols, record.record_id, run.id, promotion);
    proposed.push({ feature: featureId, contracts: symbols.map((each) => each.contract), recordId: record.record_id });
    deps.notify?.(feature.personId);
  }
  return { counts, proposed, withdrawn };
}

/**
 * The block of `featureId` reached main at `mainAfter`: each symbol Penguin approved removing that the
 * landed checkpoint's contract diff (its facts run) removes leaves the retiring symbols, under one
 * signed `symbols_removed` record. Answers the contracts closed.
 */
export async function closeRemoved(deps: RetiringCountDeps, featureId: string, mainAfter: string): Promise<string[]> {
  const declared = new Set(deps.retiring.list().map((each) => each.contract));
  const steps = deps.retiring.approvedSteps(featureId).filter((step) => declared.has(step.contract));
  if (steps.length === 0) return [];
  const facts = deps.facts.forCheckpoint(featureId, mainAfter);
  const impact = facts?.state === "reported" ? facts.report?.impact ?? null : null;
  if (facts === undefined || impact === null) return [];
  const gone = steps.filter((step) => contractRemoved(impact, step.contract));
  if (gone.length === 0) return [];
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "symbols_removed", { penguin: true }, {
      promotion: mainAfter,
      facts_run: facts.runId,
      symbols: gone.map((step) => ({ contract: step.contract, replacement: step.replacement, approval: step.recordId })),
    }),
  );
  deps.features.addRecord(record);
  deps.retiring.removed(
    gone.map((step) => step.contract),
    mainAfter,
    record.record_id,
  );
  const person = deps.features.get(featureId)?.personId;
  if (person !== undefined) deps.notify?.(person);
  return gone.map((step) => step.contract);
}
