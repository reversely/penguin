// Retiring symbols (PRD 0.5 section 4.2 step 2). Once a feature's expand step has put the new shape
// beside the old one, its plan may mark the old contracts as retiring, each with its replacement. The
// ProjectAgent keeps every declaration as signed project data. From then on:
//
// - **Retiring calls.** A checkpoint whose own changes (files changed since its merge base with main)
//   use a retiring symbol gets one next step per file and symbol through the resolution ladder: step
//   3 when a rewrite rule the declaring plan holds for that contract rewrites the file there, so
//   Penguin's codemod applies the rule; otherwise step 4 or 5, which names the replacement for the
//   agent to adapt to. This is the
//   review-time check against new uses of a deprecated symbol ("backsliding") in Software Engineering
//   at Google, chapter 22.
// - **Migration groups.** The remaining callers on main and in running features' own changes, grouped
//   by owner: a scope's owner for code on main, the feature's person for a running feature. Each
//   group is one set of migration parts.
//
// The check runner finds the uses: `analysis:python-impact` searches for each retiring symbol as if it
// had changed (`ImpactRequest.symbols`). Everything here reads that report; nothing runs code.

import type { BlockCheck, BlockCheckFinding } from "./block-check.ts";
import type { ImpactReport, ImpactUse } from "./impact.ts";
import type { PlanPlace } from "./plan.ts";
import { classifyFailure, type LadderDecision, type RoutingContext } from "./resolution.ts";
import type { RewriteRule } from "./rewrite-rule.ts";

export const RETIRING_LIMITS = { symbols: 64, findings: 20 } as const;

/** One retiring contract and what replaces it, both `path::symbol`. */
export interface RetiringSymbol {
  /** The retiring contract, `path::symbol`: a module-level name in a Python file. */
  readonly contract: string;
  /** The replacement, `path::name` or `path::Class.member`. */
  readonly replacement: string;
}

/** A retiring symbol as the project keeps it: who declared it, in which plan, and the rules that migrate it. */
export interface RetiringDeclaration extends RetiringSymbol {
  readonly feature: string;
  readonly planId: string;
  readonly person: string;
  /** The declaring plan's rewrite rules whose contract is this one. */
  readonly rules: readonly RewriteRule[];
  /** The signed `retire_symbols` record. */
  readonly recordId: string;
  readonly declaredAt: string;
}

const CONTRACT = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,511}\.py::[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const REPLACEMENT = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,511}\.py::[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})?$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function safePath(path: string): boolean {
  return !path.startsWith("/") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("-"));
}

/** The retiring symbols a plan declares, or a message naming the first that breaks the form. Absent is none. */
export function parseRetiring(value: unknown): RetiringSymbol[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "retiring must be an array";
  if (value.length > RETIRING_LIMITS.symbols) return `a plan retires at most ${RETIRING_LIMITS.symbols} symbols`;
  const symbols: RetiringSymbol[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `retiring[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "contract" && key !== "replacement")) return `${at} takes only contract and replacement`;
    const { contract, replacement } = raw;
    if (typeof contract !== "string" || !CONTRACT.test(contract) || !safePath(contractPath(contract))) {
      return `${at}.contract must be path::symbol, a module-level name in a Python file`;
    }
    if (typeof replacement !== "string" || !REPLACEMENT.test(replacement) || !safePath(contractPath(replacement))) {
      return `${at}.replacement must be path::name or path::Class.member in a Python file`;
    }
    if (replacement === contract) return `${at}: a symbol cannot replace itself`;
    if (symbols.some((each) => each.contract === contract)) return `${at}: ${contract} is listed twice`;
    symbols.push({ contract, replacement });
  }
  return symbols;
}

/** The repository path of a `path::symbol` contract. */
export function contractPath(contract: string): string {
  return contract.slice(0, contract.indexOf("::"));
}

/**
 * The dotted name the impact analysis gives a contract's symbol: `shared/money/__init__.py::price`
 * is `shared.money.price`, `orders/model.py::line_total` is `orders.model.line_total`.
 */
export function contractDottedName(contract: string): string {
  const path = contractPath(contract).replace(/\.py$/u, "");
  const module = path.endsWith("/__init__") ? path.slice(0, -"/__init__".length) : path;
  return `${module.replaceAll("/", ".")}.${contract.slice(contract.indexOf("::") + 2)}`;
}

/** The declaration each use of a retiring symbol reaches, by the analysis's dotted name. */
function byDottedName(declarations: readonly RetiringDeclaration[]): Map<string, RetiringDeclaration> {
  return new Map(declarations.map((each) => [contractDottedName(each.contract), each]));
}

/** The uses in a list that reach a retiring symbol, each with its declaration. */
export function retiringUses(uses: readonly ImpactUse[], declarations: readonly RetiringDeclaration[]): { use: ImpactUse; declaration: RetiringDeclaration }[] {
  const known = byDottedName(declarations);
  return uses.flatMap((use) => {
    const declaration = known.get(use.symbol);
    return declaration === undefined ? [] : [{ use, declaration }];
  });
}

/**
 * One next step per file and retiring symbol that the fork `forkId`'s own changes use, through the
 * resolution ladder: step 3 when a declared rewrite rule rewrites that file (`rewrites` gives the ids
 * of the rules that changed each file on the runner), otherwise step 4 inside the charter of `context`
 * (the checkpoint's identity) or step 5 outside it. Each step names the replacement and lists the uses
 * as findings.
 */
export function retiringCallDecisions(
  impact: ImpactReport,
  forkId: string,
  declarations: readonly RetiringDeclaration[],
  context: RoutingContext,
  checkpoint: string,
  rewrites: (path: string) => readonly string[] = () => [],
): LadderDecision[] {
  const fork = impact.forks.find((each) => each.id === forkId);
  const found = retiringUses(fork?.uses ?? [], declarations);
  const groups = new Map<string, { declaration: RetiringDeclaration; path: string; uses: ImpactUse[] }>();
  for (const { use, declaration } of found) {
    const key = `${use.path}\0${declaration.contract}`;
    const group = groups.get(key) ?? { declaration, path: use.path, uses: [] };
    group.uses.push(use);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.path === b.path ? (a.declaration.contract < b.declaration.contract ? -1 : 1) : a.path < b.path ? -1 : 1))
    .map(({ declaration, path, uses }) => {
      const findings: BlockCheckFinding[] = uses.slice(0, RETIRING_LIMITS.findings).map((use) => ({
        path: use.path,
        line: use.line,
        code: declaration.contract.slice(0, 128),
        message: `${use.kind} of ${use.name}, retiring: use ${declaration.replacement}`.slice(0, 300),
      }));
      const lines = uses.map((use) => use.line).join(", ");
      const check: BlockCheck = {
        planId: declaration.planId,
        target: forkId,
        check: "retiring",
        result: "failed",
        tool: { name: "python-impact", version: null, commandId: "analysis:python-impact" },
        input: { origin: checkpoint, target: checkpoint, merged: null, paths: [path] },
        findings,
        findingCount: uses.length,
        summary: `${path} uses ${declaration.contract} on line${uses.length === 1 ? "" : "s"} ${lines}; it is retiring, use ${declaration.replacement}`.slice(0, 300),
        fingerprint: null,
        logRef: null,
        durationMs: 0,
      };
      const applied = new Set(rewrites(path));
      const rules = declaration.rules.filter((rule) => applied.has(rule.id)).map((rule) => rule.id);
      return classifyFailure(
        { check, targetScopes: [], codemod: null, failedFixes: 0, round: 0, retiring: { contract: declaration.contract, replacement: declaration.replacement, rules } },
        context,
      );
    });
}

/** One place of a migration group: code on main in a scope, or a running feature's own changes. */
export interface MigrationPlace {
  readonly place: PlanPlace;
  /** The uses of retiring symbols there. */
  readonly uses: readonly ImpactUse[];
}

/** The migration parts of one owner: every place whose callers that owner's approval covers. */
export interface MigrationGroup {
  readonly owner: string;
  readonly places: readonly MigrationPlace[];
  /** The uses across the group's places. */
  readonly uses: number;
}

const placeKey = (place: PlanPlace): string => (place.kind === "scope" ? `scope:${place.scope}` : `feature:${place.feature}`);

/**
 * The remaining callers of retiring symbols, grouped by owner, owners in id order and places in place
 * order. A use on main (the report's head uses) is a place of its scope, owned by the scope's owner;
 * a use in a running feature's own changes is a place of that feature, owned by its person. A use on
 * main in no scope, or of a scope or feature with no known owner, is left out and counted.
 */
export function migrationGroups(
  impact: ImpactReport,
  declarations: readonly RetiringDeclaration[],
  ownerOfScope: (scope: string) => string | undefined,
  personOfFeature: (feature: string) => string | undefined,
): { groups: MigrationGroup[]; unowned: number } {
  const places = new Map<string, { owner: string; place: PlanPlace; uses: ImpactUse[] }>();
  let unowned = 0;
  const add = (owner: string | undefined, place: PlanPlace, use: ImpactUse) => {
    if (owner === undefined) {
      unowned += 1;
      return;
    }
    const key = placeKey(place);
    const entry = places.get(key) ?? { owner, place, uses: [] };
    entry.uses.push(use);
    places.set(key, entry);
  };
  for (const { use } of retiringUses(impact.headUses, declarations)) {
    if (use.scope === null) unowned += 1;
    else add(ownerOfScope(use.scope), { kind: "scope", scope: use.scope }, use);
  }
  for (const fork of impact.forks) {
    for (const { use } of retiringUses(fork.uses, declarations)) add(personOfFeature(fork.id), { kind: "feature", feature: fork.id }, use);
  }
  const owners = new Map<string, MigrationPlace[]>();
  for (const [, entry] of [...places.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    owners.set(entry.owner, [...(owners.get(entry.owner) ?? []), { place: entry.place, uses: entry.uses }]);
  }
  const groups = [...owners.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([owner, list]) => ({ owner, places: list, uses: list.reduce((sum, each) => sum + each.uses.length, 0) }));
  return { groups, unowned };
}
