// Scope dependencies read from the code (#134). Hand-written `depends_on` entries in
// `penguin/scopes.json` drift from the code as a codebase grows, so Penguin reads who uses whom from
// the impact graph of main at each promotion:
//
// 1. **Request.** Each promotion of main records one `impact` request of Penguin's own
//    (`requestScopeEdges`), beside the count of retiring callers (retiring-count.ts). The check runner
//    runs `analysis:python-impact` on main at the promotion with `edges: true` (tool-run.ts on the
//    bridge) and reports `scopeEdges`: for each pair of scopes, how many import, call and reference
//    sites one scope's files hold into the other's modules and definitions.
// 2. **Store.** When the runner reports (`edgesReported`), ScopeEdgeStore keeps one row per pair with
//    its counts and the promotion at which the counts last changed. An edge the new report no longer
//    shows stays as a row with zero counts that is no longer in the code, so a declared edge the code
//    dropped shows when it went. An incomplete report adds and updates edges but removes none.
// 3. **Read.** The team view and the person page build each person's role from the stored rows and
//    the scope map's declared edges in one pass (`roleIndex`, `personRole`), with no runner call.
//
// The rows hold scope ids and counts only; no path, line, symbol or code reaches the ProjectAgent.

import type { DashboardScope, ImpactScopeEdge, PersonRole, RoleDerivation, RoleScope } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { AgentToolRun, AgentToolStore } from "./agent-tools.ts";
import type { FeatureStore } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { PENGUIN_SESSION } from "./retiring-count.ts";

/** The `search` of Penguin's request for the scope dependencies of main after a promotion. */
export const EDGES_SEARCH = "edges";

export const SCOPE_EDGE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ScopeEdge (
    consumer TEXT NOT NULL, provider TEXT NOT NULL, calls INTEGER NOT NULL, imports INTEGER NOT NULL,
    refs INTEGER NOT NULL, in_code INTEGER NOT NULL, updated_promotion TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (consumer, provider))`,
  // The one derivation the rows come from: the newest report.
  `CREATE TABLE IF NOT EXISTS ScopeDerivation (
    id INTEGER PRIMARY KEY CHECK (id = 1), promotion TEXT NOT NULL, run_id INTEGER NOT NULL,
    derived_at INTEGER NOT NULL, complete INTEGER NOT NULL)`,
];

/** One stored edge: a pair of scopes with its counts and when they last changed. */
export interface StoredScopeEdge extends ImpactScopeEdge {
  /** The newest derivation shows the edge; false for an edge the code dropped. */
  readonly inCode: boolean;
  readonly updatedPromotion: string;
  readonly updatedAt: string;
}

/** Every stored edge with the derivation they come from; null before the first report. */
export interface ScopeEdgeSnapshot {
  readonly derivation: RoleDerivation | null;
  readonly edges: readonly StoredScopeEdge[];
}

type Row = Record<string, SqlValue>;

function edgeRow(row: Row): StoredScopeEdge {
  return {
    consumer: String(row["consumer"]),
    provider: String(row["provider"]),
    calls: Number(row["calls"]),
    imports: Number(row["imports"]),
    references: Number(row["refs"]),
    inCode: Number(row["in_code"]) === 1,
    updatedPromotion: String(row["updated_promotion"]),
    updatedAt: new Date(Number(row["updated_at"])).toISOString(),
  };
}

export class ScopeEdgeStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of SCOPE_EDGE_SCHEMA) db.exec(statement);
  }

  /** Every stored edge and the derivation they come from, in two reads. */
  snapshot(): ScopeEdgeSnapshot {
    const [meta] = this.#db.exec(`SELECT * FROM ScopeDerivation WHERE id = 1`);
    return {
      derivation:
        meta === undefined
          ? null
          : { promotion: String(meta["promotion"]), derivedAt: new Date(Number(meta["derived_at"])).toISOString(), complete: Number(meta["complete"]) === 1 },
      edges: this.#db.exec(`SELECT * FROM ScopeEdge ORDER BY consumer, provider`).map(edgeRow),
    };
  }

  /**
   * Keeps the edges report `runId` read from main at `promotion`. An edge whose counts changed, or
   * that came back, takes this promotion as its update. When the report is complete, each edge it no
   * longer shows drops to zero counts out of the code. A report older than the stored one is ignored.
   * Answers whether the report was kept.
   */
  derived(edges: readonly ImpactScopeEdge[], promotion: string, runId: number, complete: boolean): boolean {
    const [meta] = this.#db.exec(`SELECT run_id FROM ScopeDerivation WHERE id = 1`);
    if (meta !== undefined && Number(meta["run_id"]) > runId) return false;
    const now = this.#now();
    this.#db.transaction(() => {
      const stored = new Map(this.snapshot().edges.map((edge) => [`${edge.consumer}\n${edge.provider}`, edge]));
      const seen = new Set<string>();
      for (const edge of edges) {
        const key = `${edge.consumer}\n${edge.provider}`;
        seen.add(key);
        const before = stored.get(key);
        const same = before !== undefined && before.inCode && before.calls === edge.calls && before.imports === edge.imports && before.references === edge.references;
        if (same) continue;
        this.#db.exec(
          `INSERT OR REPLACE INTO ScopeEdge (consumer, provider, calls, imports, refs, in_code, updated_promotion, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          edge.consumer,
          edge.provider,
          edge.calls,
          edge.imports,
          edge.references,
          promotion,
          now,
        );
      }
      if (complete) {
        for (const [key, edge] of stored) {
          if (seen.has(key) || !edge.inCode) continue;
          this.#db.exec(
            `UPDATE ScopeEdge SET calls = 0, imports = 0, refs = 0, in_code = 0, updated_promotion = ?, updated_at = ? WHERE consumer = ? AND provider = ?`,
            promotion,
            now,
            edge.consumer,
            edge.provider,
          );
        }
      }
      this.#db.exec(
        `INSERT OR REPLACE INTO ScopeDerivation (id, promotion, run_id, derived_at, complete) VALUES (1, ?, ?, ?, ?)`,
        promotion,
        runId,
        now,
        complete ? 1 : 0,
      );
    });
    return true;
  }
}

const isEdges = (run: AgentToolRun): boolean => run.tool === "impact" && run.input["search"] === EDGES_SEARCH;

/**
 * After the promotion of `featureId` moved main to `mainAfter`: one request of Penguin's own for the
 * check runner to read main's scope dependencies. Undefined when the feature is unknown or this
 * promotion was already asked for.
 */
export function requestScopeEdges(deps: { readonly features: FeatureStore; readonly runs: AgentToolStore }, featureId: string, mainAfter: string): number | undefined {
  if (deps.features.get(featureId) === undefined) return undefined;
  if (deps.runs.list(featureId).some((run) => isEdges(run) && run.checkpointSha === mainAfter)) return undefined;
  return deps.runs.insert({
    featureId,
    sessionId: PENGUIN_SESSION,
    caller: "penguin",
    tool: "impact",
    input: { feature: featureId, search: EDGES_SEARCH, promotion: mainAfter },
    result: "waiting",
    summary: `Penguin's read of the scope dependencies of main at ${mainAfter.slice(0, 12)} waits for the check runner`,
    checkpointSha: mainAfter,
    durationMs: 0,
    baseSha: mainAfter,
  }).id;
}

/** Whether `run` is Penguin's request for main's scope dependencies, which the runner claims without an identity. */
export const isEdgesRequest = (run: AgentToolRun): boolean => run.sessionId === PENGUIN_SESSION && isEdges(run);

/**
 * The runner reported `run`: when it is an edges request with a report, the store keeps its edges.
 * Answers whether the edges were kept; false for any other request, an error or an older report.
 */
export function edgesReported(store: ScopeEdgeStore, run: AgentToolRun): boolean {
  if (!isEdges(run) || run.outcome?.result !== "found") return false;
  const impact = run.outcome.impact;
  if (impact === null || impact.scopeEdges === undefined) return false;
  return store.derived(impact.scopeEdges, String(run.input["promotion"] ?? run.checkpointSha), run.id, impact.complete);
}

/** The stored edges and the declared ones, indexed once for every person's role. */
export interface RoleIndex {
  readonly scopeMap: ScopeMap;
  readonly derivation: RoleDerivation | null;
  /** Each pair of scopes, `consumer\nprovider`, with its stored edge and whether `depends_on` names it. */
  readonly pairs: ReadonlyMap<string, { readonly consumer: string; readonly provider: string; readonly edge: StoredScopeEdge | null; readonly declared: boolean }>;
  readonly byConsumer: ReadonlyMap<string, readonly string[]>;
  readonly byProvider: ReadonlyMap<string, readonly string[]>;
}

/** Indexes the snapshot's edges and the scope map's declared edges between scopes the map holds. */
export function roleIndex(scopeMap: ScopeMap, snapshot: ScopeEdgeSnapshot): RoleIndex {
  const pairs = new Map<string, { consumer: string; provider: string; edge: StoredScopeEdge | null; declared: boolean }>();
  const known = (id: string) => scopeMap.scopes.has(id);
  for (const edge of snapshot.edges) {
    if (known(edge.consumer) && known(edge.provider)) pairs.set(`${edge.consumer}\n${edge.provider}`, { consumer: edge.consumer, provider: edge.provider, edge, declared: false });
  }
  for (const scope of scopeMap.scopes.values()) {
    for (const { providerScopeId: provider } of scope.dependsOn) {
      if (!known(provider) || provider === scope.id) continue;
      const key = `${scope.id}\n${provider}`;
      pairs.set(key, { consumer: scope.id, provider, edge: pairs.get(key)?.edge ?? null, declared: true });
    }
  }
  const byConsumer = new Map<string, string[]>();
  const byProvider = new Map<string, string[]>();
  for (const [key, pair] of pairs) {
    byConsumer.set(pair.consumer, [...(byConsumer.get(pair.consumer) ?? []), key]);
    byProvider.set(pair.provider, [...(byProvider.get(pair.provider) ?? []), key]);
  }
  return { scopeMap, derivation: snapshot.derivation, pairs, byConsumer, byProvider };
}

/** A scope as the dashboard names it: `ownerId` is its DRI. */
export function dashboardScope(scopeMap: ScopeMap, id: string): DashboardScope {
  const found = scopeMap.scopes.get(id);
  return { id, name: found?.name ?? id, ownerId: found?.driId ?? "", teamId: found?.teamId ?? "", fallbackIds: found?.fallbackIds ?? [] };
}

/** A row being summed: the counts and sources of every pair that names its scope. */
interface Tally {
  calls: number;
  uses: number;
  derived: boolean;
  declared: boolean;
  via: Set<string>;
  updated: StoredScopeEdge | null;
}

const newer = (a: StoredScopeEdge | null, b: StoredScopeEdge | null): StoredScopeEdge | null => (a === null ? b : b === null || a.updatedAt >= b.updatedAt ? a : b);

function add(tally: Tally, edge: StoredScopeEdge | null, declared: boolean, via: string | null): void {
  if (edge?.inCode === true) {
    tally.calls += edge.calls;
    tally.uses += edge.calls + edge.imports + edge.references;
    tally.derived = true;
  }
  tally.declared ||= declared;
  if (via !== null) tally.via.add(via);
  tally.updated = newer(tally.updated, edge);
}

/** Most call sites first, then most use sites, then by name. */
const byCalls = (a: RoleScope, b: RoleScope): number => b.calls - a.calls || b.uses - a.uses || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function rows(index: RoleIndex, tallies: ReadonlyMap<string, Tally>): RoleScope[] {
  return [...tallies.entries()]
    .map(([id, tally]): RoleScope => {
      // A row no stored edge reaches was last checked by the newest derivation, if any.
      const updatedPromotion = tally.updated?.updatedPromotion ?? index.derivation?.promotion ?? null;
      const updatedAt = tally.updated?.updatedAt ?? index.derivation?.derivedAt ?? null;
      return { ...dashboardScope(index.scopeMap, id), calls: tally.calls, uses: tally.uses, derived: tally.derived, declared: tally.declared, via: [...tally.via].sort(), updatedPromotion, updatedAt };
    })
    .sort(byCalls);
}

const tallyOf = (tallies: Map<string, Tally>, id: string): Tally => {
  let tally = tallies.get(id);
  if (tally === undefined) {
    tally = { calls: 0, uses: 0, derived: false, declared: false, via: new Set(), updated: null };
    tallies.set(id, tally);
  }
  return tally;
};

/**
 * The person's role, each list ranked by call sites: the scopes they are DRI for with other people's
 * uses of each, the scopes theirs read and the scopes that read theirs. A dependency counts when the
 * code at the last derivation shows it or `depends_on` declares it. With `top`, each list keeps its
 * first `top` scopes and `counts` keeps each full size.
 */
export function personRole(index: RoleIndex, person: string, top?: number): PersonRole {
  const own = new Set([...index.scopeMap.scopes.values()].filter((scope) => scope.driId === person).map((scope) => scope.id));
  const owns = new Map<string, Tally>();
  const reads = new Map<string, Tally>();
  const readBy = new Map<string, Tally>();
  for (const id of own) {
    const owned = tallyOf(owns, id);
    owned.declared = true;
    for (const key of index.byConsumer.get(id) ?? []) {
      const pair = index.pairs.get(key);
      if (pair === undefined || own.has(pair.provider)) continue;
      if (pair.edge?.inCode !== true && !pair.declared) continue;
      add(tallyOf(reads, pair.provider), pair.edge, pair.declared, id);
    }
    for (const key of index.byProvider.get(id) ?? []) {
      const pair = index.pairs.get(key);
      if (pair === undefined || own.has(pair.consumer)) continue;
      if (pair.edge?.inCode !== true && !pair.declared) continue;
      add(tallyOf(readBy, pair.consumer), pair.edge, pair.declared, id);
      add(owned, pair.edge, false, null);
    }
  }
  const scopes = rows(index, owns);
  const dependencies = rows(index, reads);
  const dependents = rows(index, readBy);
  const cut = <T>(list: T[]): T[] => (top === undefined ? list : list.slice(0, top));
  return {
    scopes: cut(scopes),
    dependents: cut(dependents),
    dependencies: cut(dependencies),
    counts: { owns: scopes.length, reads: dependencies.length, readBy: dependents.length },
    derivation: index.derivation,
  };
}
