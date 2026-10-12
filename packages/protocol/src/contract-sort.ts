// Sorting a feature's contract diff (PRD 0.5 section 4.2 step 1). Penguin sorts each entry of the
// contract diff `analysis:python-impact` reports for a checkpoint, at open and at each checkpoint:
//
// - **Additive:** a new symbol. It reaches main with the expand step.
// - **Compatible:** existing callers keep working: a new parameter with a default, a rename or move
//   whose old name still reaches the new definition (`kept`), or a breaking change with no caller
//   outside the author's scopes, whose callers the author fixes in the same change.
// - **Incompatible:** a rename, move, keyword rename, removed symbol, breaking signature or changed
//   type with callers outside the author's scopes. Penguin splits the feature.
// - **Behaviour change:** an existing contract, or a symbol with callers outside the author's scopes,
//   changes its body or its stored data shape with the same signature. The feature keeps its merge
//   plan, because an expand step would leave the old behaviour in place for every caller that has not
//   moved.
//
// The author's scopes are the scopes the feature's person owns. A caller is a use on main (`headUses`)
// or in a running feature's own changes (`forks[].uses`) in any other scope, or in no scope. The sort
// reads the report only: nothing here runs code.

import type { CodemodEdit } from "./resolution.ts";
import type { RetiringSymbol } from "./retiring.ts";
import type { ImpactChangeKind, ImpactLocation, ImpactReport, ImpactSymbolKind, ImpactUse } from "./impact.ts";

export const CONTRACT_SORTS = ["additive", "compatible", "incompatible", "behaviour"] as const;
export type ContractSort = (typeof CONTRACT_SORTS)[number];

/** What breaks an existing caller, for an entry that could: the split's kinds of change. */
export const CONTRACT_BREAKS = ["rename", "move", "keyword-rename", "removed", "signature", "type"] as const;
export type ContractBreak = (typeof CONTRACT_BREAKS)[number];

/** The feature's next step the sort gives: split it, keep the merge plan, or nothing more. */
export type ContractDecision = "split" | "plan" | "none";

/** The breaks Penguin's codemod expands itself, with an alias or a forwarding function. */
export const CODEMOD_BREAKS: ReadonlySet<ContractBreak> = new Set(["rename", "move", "keyword-rename"]);

export interface ContractSortEntry extends ImpactLocation {
  readonly kind: ImpactSymbolKind;
  /** The contract diff's own word for the change. */
  readonly change: ImpactChangeKind;
  readonly sort: ContractSort;
  /** What could break a caller; null for an added symbol or a change of body or data shape. */
  readonly breaks: ContractBreak | null;
  readonly scope: string | null;
  readonly contract: string | null;
  /** For a rename or a move: the new name and place. */
  readonly to: ImpactLocation | null;
  /** For a keyword rename: the old and the new keyword. */
  readonly keyword: { readonly from: string; readonly to: string } | null;
  /** Uses outside the author's scopes, on main and in running features' own changes. */
  readonly callers: number;
  /** One sentence: why the entry sorts as it does. */
  readonly reason: string;
}

export interface ContractSortResult {
  readonly entries: readonly ContractSortEntry[];
  readonly counts: Readonly<Record<ContractSort, number>>;
  readonly decision: ContractDecision;
  /** False when the report was incomplete: a caller may be unseen. */
  readonly complete: boolean;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Uses outside `own`, counted by the symbol they reach: a use of a member counts for its class too. */
function callerCounts(impact: ImpactReport, own: ReadonlySet<string>): (symbol: string) => number {
  const outside: ImpactUse[] = [...impact.headUses, ...impact.forks.flatMap((fork) => fork.uses)].filter((use) => use.scope === null || !own.has(use.scope));
  const bySymbol = new Map<string, number>();
  for (const use of outside) bySymbol.set(use.symbol, (bySymbol.get(use.symbol) ?? 0) + 1);
  return (symbol) => {
    let total = 0;
    for (const [used, count] of bySymbol) if (used === symbol || used.startsWith(`${symbol}.`)) total += count;
    return total;
  };
}

/** The break a modified symbol's signature shows, or null when its signature is unchanged or only gains optional parameters. */
function signatureBreak(signature: ImpactReport["signatures"][number] | undefined): { breaks: ContractBreak; keyword: ContractSortEntry["keyword"]; reason: string } | "optional" | null {
  if (signature === undefined) return null;
  const [removed] = signature.removed;
  const [added] = signature.added;
  if (signature.breaking) {
    // `*name` or `**name` in the new signature is no keyword a caller passes by name.
    const variadic = added !== undefined && new RegExp(`\\*${added.name}\\b`, "u").test(signature.after);
    const rename = removed !== undefined && added !== undefined && !variadic && signature.removed.length === 1 && signature.added.length === 1;
    const expected = new Set([`removes parameter ${removed}`, `adds required parameter ${added?.name}`]);
    if (rename && signature.reasons.every((reason) => expected.has(reason))) {
      return { breaks: "keyword-rename", keyword: { from: removed, to: added.name }, reason: `renames keyword ${removed} to ${added.name}` };
    }
    return { breaks: "signature", keyword: null, reason: signature.reasons.join(", ") };
  }
  if (signature.added.length > 0) return "optional";
  return { breaks: "type", keyword: null, reason: `changes type from ${signature.before} to ${signature.after}` };
}

/**
 * Sorts each entry of `impact`'s contract diff for a feature whose person owns `own`. A name a module
 * no longer exports and that the diff lists no change for is sorted as a removed symbol.
 */
export function sortContractDiff(impact: ImpactReport, own: ReadonlySet<string>): ContractSortResult {
  const callersOf = callerCounts(impact, own);
  const signatures = new Map(impact.signatures.map((each) => [each.symbol, each]));
  const shapes = new Set(impact.dataShapes.map((each) => each.symbol));
  const entries: ContractSortEntry[] = [];
  const push = (base: Omit<ContractSortEntry, "sort" | "reason" | "callers">, sorted: { sort: ContractSort; reason: string }, callers: number) =>
    entries.push({ ...base, ...sorted, callers });

  for (const change of impact.changes) {
    const callers = callersOf(change.symbol);
    const base = {
      symbol: change.symbol,
      path: change.path,
      line: change.line,
      kind: change.kind,
      change: change.change,
      scope: change.scope,
      contract: change.contract,
      to: change.to ?? null,
      keyword: null,
      breaks: null,
    } satisfies Omit<ContractSortEntry, "sort" | "reason" | "callers">;
    if (change.change === "added") {
      push(base, { sort: "additive", reason: "a new symbol" }, callers);
      continue;
    }
    if (change.change === "renamed" || change.change === "moved") {
      const breaks: ContractBreak = change.change === "renamed" ? "rename" : "move";
      const to = change.to?.symbol ?? "its new name";
      if (change.kept === true) {
        push({ ...base, breaks }, { sort: "compatible", reason: `${change.change} to ${to}; the old name still reaches it, so callers keep working` }, callers);
      } else {
        push({ ...base, breaks }, breaking(`${change.change} to ${to}`, callers), callers);
      }
      continue;
    }
    if (change.change === "removed") {
      push({ ...base, breaks: "removed" }, breaking("removed", callers), callers);
      continue;
    }
    const signature = signatureBreak(signatures.get(change.symbol));
    if (signature === "optional") {
      push(base, { sort: "compatible", reason: "adds parameters with defaults; existing calls keep working" }, callers);
    } else if (signature !== null) {
      push({ ...base, breaks: signature.breaks, keyword: signature.keyword }, breaking(signature.reason, callers), callers);
    } else {
      push(base, behaviour(change.contract, shapes.has(change.symbol), callers), callers);
    }
  }

  const listed = new Set(entries.map((entry) => entry.symbol));
  for (const removed of impact.removedExports) {
    const symbol = `${removed.module}.${removed.name}`;
    if (listed.has(symbol)) continue;
    const callers = callersOf(symbol);
    push(
      { symbol, path: removed.path, line: 1, kind: "alias", change: "removed", breaks: "removed", scope: null, contract: null, to: null, keyword: null },
      breaking(`no longer exported by ${removed.module}`, callers),
      callers,
    );
  }

  const counts = { additive: 0, compatible: 0, incompatible: 0, behaviour: 0 };
  for (const entry of entries) counts[entry.sort] += 1;
  const decision: ContractDecision = counts.incompatible > 0 ? "split" : counts.behaviour > 0 ? "plan" : "none";
  return { entries, counts, decision, complete: impact.complete };
}

function breaking(what: string, callers: number): { sort: ContractSort; reason: string } {
  return callers > 0
    ? { sort: "incompatible", reason: `${what}, with ${plural(callers, "caller")} outside the author's scopes` }
    : { sort: "compatible", reason: `${what}, with no caller outside the author's scopes` };
}

function behaviour(contract: string | null, shape: boolean, callers: number): { sort: ContractSort; reason: string } {
  const what = shape ? "its stored data shape changes" : "its body changes with the same signature";
  if (contract !== null) return { sort: "behaviour", reason: `${what}; it is the declared contract ${contract}` };
  if (callers > 0) return { sort: "behaviour", reason: `${what}, with ${plural(callers, "caller")} outside the author's scopes` };
  return { sort: "compatible", reason: `${what}, with no declared contract and no caller outside the author's scopes` };
}

/** The dotted module a repository path defines, such as `shared.money` for `shared/money/__init__.py`. */
export function pythonModuleOf(path: string): string {
  const parts = path.replace(/\.py$/u, "").split("/");
  if (parts.at(-1) === "__init__") parts.pop();
  return parts.join(".");
}

/** The codemod edits that write the expand step's aliases and forwarding functions, and the files they write. */
export interface ExpandPlan {
  readonly edits: readonly CodemodEdit[];
  readonly paths: readonly string[];
  /** Incompatible entries the codemod cannot expand, each with why: the agent writes those. */
  readonly manual: readonly { readonly symbol: string; readonly reason: string }[];
}

/**
 * The expand step Penguin's codemod writes for the incompatible entries of a sort (PRD 0.5 section
 * 4.2 step 2): for a rename, `old = new` beside the new definition; for a move, an import of the new
 * definition under the old name in the old module; for a keyword rename, a forwarding signature that
 * takes both keywords. A changed type, a breaking signature or a removed symbol is the agent's to
 * write as a parallel function.
 */
export function expandPlan(entries: readonly ContractSortEntry[]): ExpandPlan {
  const edits: CodemodEdit[] = [];
  const paths = new Set<string>();
  const manual: { symbol: string; reason: string }[] = [];
  for (const entry of entries) {
    if (entry.sort !== "incompatible" || entry.breaks === null) continue;
    if (entry.breaks === "rename" && entry.to !== null) {
      edits.push({ kind: "rename", from: entry.symbol, to: entry.to.symbol });
      paths.add(entry.to.path);
    } else if (entry.breaks === "move" && entry.to !== null) {
      // Only a module-level symbol moved to another module's top level: the old module imports it back.
      const fromModule = pythonModuleOf(entry.path);
      const toModule = pythonModuleOf(entry.to.path);
      if (entry.symbol.slice(fromModule.length + 1).includes(".") || entry.to.symbol.slice(toModule.length + 1).includes(".")) {
        manual.push({ symbol: entry.symbol, reason: "a member moved between classes; write the forwarding member yourself" });
        continue;
      }
      edits.push({ kind: "move", from: entry.symbol, to: entry.to.symbol });
      paths.add(entry.path);
    } else if (entry.breaks === "keyword-rename" && entry.keyword !== null) {
      edits.push({ kind: "rename-parameter", function: entry.symbol, from: entry.keyword.from, to: entry.keyword.to });
      paths.add(entry.path);
    } else {
      manual.push({ symbol: entry.symbol, reason: `a ${entry.breaks === "removed" ? "removed symbol" : entry.breaks === "type" ? "changed type" : "breaking signature"}: write the parallel function beside the old one` });
    }
  }
  return { edits, paths: [...paths].sort(), manual };
}

/** Where a feature's split stands: the expand step comes first, then the old names are retiring. */
export type ContractSplitState = "expand_first" | "retiring";

/** A feature's split as Penguin keeps it: the incompatible entries and, once promoted, what retires. */
export interface ContractSplitView {
  readonly state: ContractSplitState;
  /** The checkpoint whose sort last added an entry. */
  readonly checkpoint: string;
  readonly entries: readonly ContractSortEntry[];
  /** The replacements the agent named for entries the codemod cannot expand (`land_feature`'s `retiring`). */
  readonly replacements: readonly RetiringSymbol[];
  /** Main's commit after the expand promotion, once promoted. */
  readonly promotion: string | null;
  /** The old names marked retiring at the promotion, each with its replacement. */
  readonly retiring: readonly RetiringSymbol[];
  /** Entries promoted without a retiring declaration, each with why. */
  readonly unretired: readonly { readonly symbol: string; readonly reason: string }[];
  /** The signed `contract_split` record of the last change to the split. */
  readonly recordId: string;
}

/** How Penguin sorted a feature's latest checkpoint, for `get_work` and the feature page. */
export interface ContractWorkView {
  readonly checkpoint: string | null;
  /** The facts run whose impact report holds the contract diff, or null before the first checkpoint. */
  readonly factsRun: string | null;
  readonly state: "no_checkpoint" | "waiting" | "failed" | "sorted";
  readonly decision: ContractDecision | null;
  readonly counts: Readonly<Record<ContractSort, number>> | null;
  /** False when the impact report was incomplete. */
  readonly complete: boolean | null;
  /** The sorted entries, incompatible and behaviour changes first, at most CONTRACT_WORK_ENTRIES. */
  readonly entries: readonly ContractSortEntry[];
  readonly omitted: number;
  readonly split: ContractSplitView | null;
  /** The feature's next step, in one paragraph. */
  readonly nextStep: string;
}

/** The most sorted entries a ContractWorkView lists. */
export const CONTRACT_WORK_ENTRIES = 100;
