// Sorting a feature's contract diff and splitting it (PRD 0.5 section 4.2 steps 1 and 2).
//
// 1. **One contract diff per checkpoint.** Each checkpoint a feature reports gets the facts run a
//    merge plan reads (plan-facts.ts): `scheduleSort` reuses the run of that checkpoint when one
//    exists, such as a plan's, and schedules one otherwise. Its impact report holds the contract diff.
// 2. **The sort.** `sortContractDiff` (`packages/protocol`, contract-sort.ts) sorts each entry as
//    additive, compatible, incompatible or a behaviour change. The author's scopes are the scopes the
//    feature's person owns in `penguin/scopes.json`. Before the first checkpoint the fork is main, so
//    the open feature has nothing to sort yet and is told when it will.
// 3. **The split.** When the sort finds an incompatible entry, Penguin records the split on the
//    feature with a signed `contract_split` record: the incompatible entries, kept until the expand
//    is promoted. A later checkpoint's new incompatible entries extend it. The agent's next step is
//    "expand first": `apply_fix` with `expand: true` has Penguin's codemod write the alias or
//    forwarding function for each rename, move and keyword rename; for a changed type, a breaking
//    signature or a removed symbol the agent writes the parallel function.
// 4. **Retiring.** Once the expand checkpoint is promoted (expand-promotion.ts), `retireSplit` marks
//    each old name retiring with its replacement (retiring-store.ts) under a signed `retire_symbols`
//    record, and migration begins. A rename or move names its own replacement; for any other entry
//    the agent names it with `land_feature`'s `retiring`. A method has no module-level contract to
//    retire, so it is listed as unretired with the reason.
// 5. **Behaviour change.** A feature whose sort finds behaviour changes and no incompatible entry
//    keeps today's merge plan.

import {
  CONTRACT_WORK_ENTRIES,
  expandPlan,
  parseRetiring,
  pythonModuleOf,
  sortContractDiff,
  type ContractSortEntry,
  type ContractSortResult,
  type ContractSplitState,
  type ContractSplitView,
  type ContractStepEntry,
  type ContractWorkView,
  type MigrationPlanView,
  type RetiringSymbol,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { Feature, FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { FeatureDependent } from "./overlap-lock.ts";
import { factsRequest, type PlanFactsRun, type PlanFactsStore } from "./plan-facts.ts";

export const CONTRACT_SPLIT_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ContractSplit (
    feature_id TEXT PRIMARY KEY, state TEXT NOT NULL, checkpoint TEXT NOT NULL, entries TEXT NOT NULL,
    replacements TEXT NOT NULL, promotion TEXT, retiring TEXT NOT NULL, unretired TEXT NOT NULL,
    record_id TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

type Row = Record<string, SqlValue>;

function split(row: Row): ContractSplitView {
  return {
    state: String(row["state"]) as ContractSplitState,
    checkpoint: String(row["checkpoint"]),
    entries: JSON.parse(String(row["entries"])) as ContractSortEntry[],
    replacements: JSON.parse(String(row["replacements"])) as RetiringSymbol[],
    promotion: row["promotion"] === null ? null : String(row["promotion"]),
    retiring: JSON.parse(String(row["retiring"])) as RetiringSymbol[],
    unretired: JSON.parse(String(row["unretired"])) as { symbol: string; reason: string }[],
    recordId: String(row["record_id"]),
  };
}

/** Each feature's split, one row per feature, in the ProjectAgent's database. */
export class ContractSplitStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of CONTRACT_SPLIT_SCHEMA) db.exec(statement);
  }

  get(featureId: string): ContractSplitView | undefined {
    const [row] = this.#db.exec(`SELECT * FROM ContractSplit WHERE feature_id = ?`, featureId);
    return row === undefined ? undefined : split(row);
  }

  /** Keeps the split's entries as of checkpoint `checkpoint`; the expand comes first again. */
  keep(featureId: string, checkpoint: string, entries: readonly ContractSortEntry[], recordId: string): void {
    this.#db.exec(
      `INSERT INTO ContractSplit (feature_id, state, checkpoint, entries, replacements, promotion, retiring, unretired, record_id, updated_at)
       VALUES (?, 'expand_first', ?, ?, '[]', NULL, '[]', '[]', ?, ?)
       ON CONFLICT (feature_id) DO UPDATE SET state = 'expand_first', checkpoint = excluded.checkpoint,
         entries = excluded.entries, record_id = excluded.record_id, updated_at = excluded.updated_at`,
      featureId,
      checkpoint,
      JSON.stringify(entries),
      recordId,
      this.#now(),
    );
  }

  /** The replacements the agent named when it asked for the expand. */
  name(featureId: string, replacements: readonly RetiringSymbol[]): void {
    this.#db.exec(`UPDATE ContractSplit SET replacements = ?, updated_at = ? WHERE feature_id = ?`, JSON.stringify(replacements), this.#now(), featureId);
  }

  /** The expand reached main at `promotion`: what retired, what did not, and the signed record. */
  retired(featureId: string, promotion: string, retiring: readonly RetiringSymbol[], unretired: ContractSplitView["unretired"], recordId: string): void {
    this.#db.exec(
      `UPDATE ContractSplit SET state = 'retiring', promotion = ?, retiring = ?, unretired = ?, record_id = ?, updated_at = ? WHERE feature_id = ?`,
      promotion,
      JSON.stringify(retiring),
      JSON.stringify(unretired),
      recordId,
      this.#now(),
      featureId,
    );
  }
}

export interface ContractSplitDeps {
  readonly features: FeatureStore;
  readonly facts: PlanFactsStore;
  readonly splits: ContractSplitStore;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** The feature's dependents the overlap check stored, which a facts run tests. */
  readonly dependents: (featureId: string) => readonly FeatureDependent[];
  /** The project's retiring symbols (retiring-store.ts); absent, nothing retires. */
  readonly retiring?: {
    heldElsewhere(featureId: string, symbols: readonly RetiringSymbol[]): string[];
    declareSplit(featureId: string, person: string, symbols: readonly RetiringSymbol[], recordId: string): unknown;
  };
  readonly notify?: (personId: string) => void;
  /** Each symbol the feature retires with its count and contract step (retiring-count.ts); absent is none. */
  readonly contractSteps?: (featureId: string) => readonly ContractStepEntry[];
  /** The migration plans Penguin proposed for the feature's retiring symbols (migration-plans.ts); absent is none. */
  readonly migrationPlans?: (featureId: string) => readonly MigrationPlanView[];
}

/** The scopes `person` owns in the scope map: the author's scopes of the sort. */
export function ownScopes(person: string, scopeMap: ScopeMap): Set<string> {
  return new Set([...scopeMap.scopes.values()].filter((scope) => scope.driId === person).map((scope) => scope.id));
}

/**
 * The facts run that sorts checkpoint `baseline`..latest of `feature`: the checkpoint's own run when
 * one exists, whatever rules it carries, or a new one. Undefined before the feature has a checkpoint.
 */
export function scheduleSort(deps: Pick<ContractSplitDeps, "features" | "facts" | "dependents">, feature: Feature, baseline: string, scopeMap: ScopeMap): PlanFactsRun | undefined {
  if (feature.latestCheckpointSha === null || feature.repo === null) return undefined;
  return (
    deps.facts.forCheckpoint(feature.id, feature.latestCheckpointSha) ??
    deps.facts.schedule(factsRequest(feature, baseline, scopeMap, deps.features.list(), deps.dependents(feature.id)))
  );
}

interface Sorted {
  readonly run: PlanFactsRun | undefined;
  readonly sort: ContractSortResult | null;
}

function sortLatest(deps: Pick<ContractSplitDeps, "facts">, feature: Feature, scopeMap: ScopeMap): Sorted {
  if (feature.latestCheckpointSha === null) return { run: undefined, sort: null };
  const run = deps.facts.forCheckpoint(feature.id, feature.latestCheckpointSha);
  const impact = run?.state === "reported" ? run.report?.impact : null;
  return { run, sort: impact == null ? null : sortContractDiff(impact, ownScopes(feature.personId, scopeMap)) };
}

/**
 * Records the split of `feature`'s latest checkpoint when its sort finds incompatible entries the
 * split does not hold yet, with a signed `contract_split` record, and tells the person. A split
 * whose expand already reached main keeps its retiring names; only a new entry opens the expand again.
 */
export async function recordSplit(deps: ContractSplitDeps, feature: Feature, scopeMap: ScopeMap): Promise<ContractSplitView | undefined> {
  const { sort } = sortLatest(deps, feature, scopeMap);
  const known = deps.splits.get(feature.id);
  if (sort === null || feature.latestCheckpointSha === null) return known;
  const held = new Set((known?.entries ?? []).map((entry) => entry.symbol));
  const fresh = sort.entries.filter((entry) => entry.sort === "incompatible" && !held.has(entry.symbol));
  if (fresh.length === 0) return known;
  const entries = [...(known?.entries ?? []), ...fresh];
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "contract_split", { penguin: true }, {
      checkpoint: feature.latestCheckpointSha,
      entries: fresh.map(({ symbol, breaks, callers, to }) => ({ symbol, breaks, callers, ...(to === null ? {} : { to: to.symbol }) })),
    }),
  );
  deps.features.addRecord(record);
  deps.splits.keep(feature.id, feature.latestCheckpointSha, entries, record.record_id);
  deps.notify?.(feature.personId);
  return deps.splits.get(feature.id);
}

/** The `path::name` contract of a module-level symbol, or null for a member or a name outside its file's module. */
export function moduleContract(symbol: string, path: string): string | null {
  const module = pythonModuleOf(path);
  if (!symbol.startsWith(`${module}.`)) return null;
  const local = symbol.slice(module.length + 1);
  return local.includes(".") ? null : `${path}::${local}`;
}

function replacementOf(entry: ContractSortEntry): string | null {
  if (entry.to === null || (entry.breaks !== "rename" && entry.breaks !== "move")) return null;
  const module = pythonModuleOf(entry.to.path);
  return entry.to.symbol.startsWith(`${module}.`) ? `${entry.to.path}::${entry.to.symbol.slice(module.length + 1)}` : null;
}

/**
 * The replacements `land_feature` with `expand: true` names for a split's entries, checked: each
 * contract must be an entry of the split. Absent is none. A message names the first that fails.
 */
export function splitReplacements(known: ContractSplitView | undefined, value: unknown): RetiringSymbol[] | string {
  const parsed = parseRetiring(value);
  if (typeof parsed === "string" || parsed.length === 0) return parsed;
  if (known === undefined) return "retiring names replacements for a split; this feature has none";
  const contracts = new Set(known.entries.map((entry) => moduleContract(entry.symbol, entry.path)));
  const stray = parsed.find((each) => !contracts.has(each.contract));
  return stray === undefined ? parsed : `${stray.contract} is not an incompatible entry of this feature's split`;
}

/**
 * The expand of `featureId` reached main at `promotion`: each old name of the split becomes retiring
 * with its replacement, under one signed `retire_symbols` record, and migration begins. Undefined
 * when the feature has no split waiting on its expand.
 */
export async function retireSplit(deps: ContractSplitDeps, featureId: string, promotion: string): Promise<ContractSplitView | undefined> {
  const known = deps.splits.get(featureId);
  const feature = deps.features.get(featureId);
  if (known === undefined || known.state !== "expand_first" || feature === undefined) return known;
  const named = new Map(known.replacements.map((each) => [each.contract, each.replacement]));
  const symbols: RetiringSymbol[] = [];
  const unretired: { symbol: string; reason: string }[] = [];
  for (const entry of known.entries) {
    const contract = moduleContract(entry.symbol, entry.path);
    if (contract === null) {
      unretired.push({ symbol: entry.symbol, reason: "a member has no module-level contract to retire" });
      continue;
    }
    const replacement = replacementOf(entry) ?? named.get(contract);
    if (replacement === undefined) {
      unretired.push({ symbol: entry.symbol, reason: "no replacement was named; declare it with propose_plan's retiring" });
      continue;
    }
    if (!symbols.some((each) => each.contract === contract)) symbols.push({ contract, replacement });
  }
  const elsewhere = new Set(deps.retiring?.heldElsewhere(featureId, symbols) ?? []);
  for (const contract of elsewhere) unretired.push({ symbol: contract, reason: "another feature already retires it" });
  const retiring = deps.retiring === undefined ? [] : symbols.filter((each) => !elsewhere.has(each.contract));
  if (deps.retiring === undefined) for (const each of symbols) unretired.push({ symbol: each.contract, reason: "this project keeps no retiring symbols" });
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "retire_symbols", { penguin: true }, {
      split: true,
      promotion,
      symbols: retiring.map((each) => ({ ...each, rules: [] })),
      unretired,
    }),
  );
  deps.features.addRecord(record);
  if (retiring.length > 0) deps.retiring?.declareSplit(featureId, feature.personId, retiring, record.record_id);
  deps.splits.retired(featureId, promotion, retiring, unretired, record.record_id);
  deps.notify?.(feature.personId);
  return deps.splits.get(featureId);
}

const short = (sha: string): string => sha.slice(0, 12);
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function names(symbols: readonly string[]): string {
  const shown = symbols.slice(0, 10).join(", ");
  return symbols.length > 10 ? `${shown} and ${symbols.length - 10} more` : shown;
}

const BREAK_WORDS: Readonly<Record<string, string>> = {
  rename: "renamed",
  move: "moved",
  "keyword-rename": "keyword renamed",
  removed: "removed",
  signature: "signature changed",
  type: "type changed",
};

function expandFirst(entries: readonly ContractSortEntry[], sort: ContractSortResult | null): string {
  const plan = expandPlan(entries);
  const listed = entries.map((entry) => `${entry.symbol} (${BREAK_WORDS[entry.breaks ?? ""] ?? entry.change}, ${plural(entry.callers, "caller")})`);
  const codemod = entries.filter((entry) => plan.edits.some((edit) => (edit.kind === "rename-parameter" ? edit.function : edit.from) === entry.symbol));
  const manual = plan.manual.map((each) => each.symbol);
  const behaviour = (sort?.entries ?? []).filter((entry) => entry.sort === "behaviour").map((entry) => entry.symbol);
  return [
    `Expand first: ${plural(entries.length, "incompatible contract change")} with callers outside your scopes: ${names(listed)}.`,
    codemod.length === 0
      ? ""
      : `For ${names(codemod.map((entry) => entry.symbol))}, call apply_fix with kind "codemod" and expand: true; Penguin's codemod writes the alias or forwarding function that keeps the old name working.`,
    manual.length === 0
      ? ""
      : `For ${names(manual)}, write the parallel function beside the old one under a new name. Keep the old one as main has it.`,
    `Report that expand as a checkpoint that only adds, then call land_feature with expand: true${manual.length === 0 ? "" : ", with retiring naming the new function for each old one"}. Penguin promotes it on its own; the old names then become retiring and migration begins.`,
    behaviour.length === 0 ? "" : `The behaviour changes to ${names(behaviour)} keep the merge plan after the split.`,
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

function migrate(split: ContractSplitView, plans: readonly MigrationPlanView[]): string {
  const retiring = split.retiring.map((each) => `${each.contract} for ${each.replacement}`);
  const parts = plans.reduce((sum, plan) => sum + plan.parts.length, 0);
  return [
    `The expand step is on main (${short(split.promotion ?? "")}).`,
    retiring.length === 0 ? "" : `Retiring: ${names(retiring)}.`,
    split.unretired.length === 0 ? "" : `Not retiring: ${names(split.unretired.map((each) => `${each.symbol} (${each.reason})`))}.`,
    plans.length === 0
      ? "Migrate: Penguin proposes one migration plan per owner group once the check runner counts the remaining callers."
      : `Migrate: Penguin proposed ${plural(plans.length, "migration plan")} with ${plural(parts, "part")}, one plan per owner group; the runner writes the parts the declared rules rewrite whole and each other part is an edit task for its builder or steward.`,
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

/** The contract step once Penguin approved removing symbols with no caller left (retiring-count.ts). */
function contract(approved: readonly ContractStepEntry[]): string {
  const listed = names(approved.map((each) => each.contract));
  const counted = [...new Set(approved.map((each) => short(each.promotion ?? "")))].join(", ");
  const them = approved.length === 1 ? "it" : "them";
  return (
    `Contract: no caller of ${listed} is left on main or in any running feature's own changes (counted after promotion ${counted}). ` +
    `Penguin approved removing ${them}: the plan has no places, so no person is asked. Remove ${them} from your fork, report that as a ` +
    `checkpoint and call land_feature. Penguin promotes the block and closes each removed symbol's retiring record.`
  );
}

/** The next step a sorted checkpoint gives the feature's agent. */
export function contractNextStep(view: Omit<ContractWorkView, "nextStep">, sort: ContractSortResult | null): string {
  const approved = view.contractStep.filter((each) => each.state === "approved");
  if (approved.length > 0) return contract(approved);
  if (view.split?.state === "expand_first") return expandFirst(view.split.entries, sort);
  if (view.split?.state === "retiring") return migrate(view.split, view.migration);
  if (view.decision === "split") return expandFirst((sort?.entries ?? []).filter((entry) => entry.sort === "incompatible"), sort);
  if (view.state === "no_checkpoint") return "Penguin sorts your feature's contract diff at its first checkpoint; report one with report_checkpoint.";
  if (view.state === "waiting") return `Penguin sorts checkpoint ${short(view.checkpoint ?? "")} once the check runner reports facts run ${view.factsRun}.`;
  if (view.state === "failed") return `The impact analysis of facts run ${view.factsRun} failed on the check runner, so checkpoint ${short(view.checkpoint ?? "")} is not sorted.`;
  if (view.decision === "plan") {
    const behaviour = (sort?.entries ?? []).filter((entry) => entry.sort === "behaviour").map((entry) => entry.symbol);
    return `Keep the merge plan: ${plural(behaviour.length, "behaviour change")} with the same signature: ${names(behaviour)}. Call propose_plan with one part per affected place.`;
  }
  const counts = view.counts;
  return `No contract change needs a split or a merge plan${counts === null ? "" : `: ${counts.additive} additive, ${counts.compatible} compatible`}.`;
}

const ORDER = { incompatible: 0, behaviour: 1, compatible: 2, additive: 3 } as const;

/** How Penguin sorted `feature`'s latest checkpoint, with its split and next step. Reads only. */
export function contractWork(deps: Pick<ContractSplitDeps, "facts" | "splits" | "contractSteps" | "migrationPlans">, feature: Feature, scopeMap: ScopeMap): ContractWorkView {
  const { run, sort } = sortLatest(deps, feature, scopeMap);
  const state: ContractWorkView["state"] =
    feature.latestCheckpointSha === null ? "no_checkpoint" : sort !== null ? "sorted" : run?.state === "reported" ? "failed" : "waiting";
  const entries = [...(sort?.entries ?? [])].sort((a, b) => ORDER[a.sort] - ORDER[b.sort]);
  const view = {
    checkpoint: feature.latestCheckpointSha,
    factsRun: run?.runId ?? null,
    state,
    decision: sort?.decision ?? null,
    counts: sort?.counts ?? null,
    complete: sort?.complete ?? null,
    entries: entries.slice(0, CONTRACT_WORK_ENTRIES),
    omitted: Math.max(0, entries.length - CONTRACT_WORK_ENTRIES),
    split: deps.splits.get(feature.id) ?? null,
    contractStep: deps.contractSteps?.(feature.id) ?? [],
    migration: deps.migrationPlans?.(feature.id) ?? [],
  };
  return { ...view, nextStep: contractNextStep(view, sort) };
}
