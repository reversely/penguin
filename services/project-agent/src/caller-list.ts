// The caller list (#195): which running features call which of the code's names, kept current at
// each checkpoint so a later change finds the forks it reaches without reading every fork again.
//
// 1. **Request.** Each checkpoint of a feature, an agent's or Penguin's own write, records one
//    `impact` request of Penguin's own (`requestCallerList`). The check runner runs
//    `analysis:python-impact` with `calls: true` on the checkpoint's own changes since main
//    (tool-run.ts `runCallerList` on the bridge) and reports every module and definition those files
//    use, as dotted names such as `accounts.shoppers.ShopperMap.resolve`.
// 2. **Store.** When the runner reports (`callsReported`), CallerListStore replaces the feature's
//    rows with the reported names and keeps the names the checkpoint's own change modifies, which a
//    land of the feature looks up with `callersOf`. A report older than the stored one is ignored, so a late report
//    never overwrites a newer checkpoint's list. The runner reports an incomplete read as an error,
//    which keeps no list: a feature with no list stays a target of every land until one is kept.
//    The report, kept or not, then schedules the checkpoint's combined runs (combined-run-schedule.ts).
// 3. **Read.** `callersOf` answers which features call any of a change's names from the rows alone:
//    a name matches itself and every name inside it, so a changed module matches every use of the
//    module's names, as the impact graph counts a module's uses.
//
// The work grows with the files a checkpoint changed, never with the number of running features.
// The rows hold names only; no path, line or code reaches the ProjectAgent.

import type { ImpactReport } from "@penguin/protocol";

import type { AgentToolRun, AgentToolStore } from "./agent-tools.ts";
import type { Feature } from "./feature-store.ts";
import type { SqlDatabase } from "./issue-index.ts";
import { PENGUIN_SESSION } from "./retiring-count.ts";

/** The `search` of Penguin's request for a checkpoint's caller list. */
export const CALLS_SEARCH = "calls";

export const CALLER_LIST_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ForkCall (
    feature_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (feature_id, name))`,
  `CREATE INDEX IF NOT EXISTS ForkCallByName ON ForkCall (name)`,
  // The report each feature's rows come from: the newest one kept.
  `CREATE TABLE IF NOT EXISTS ForkCallList (
    feature_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, run_id INTEGER NOT NULL,
    listed_at INTEGER NOT NULL, changed TEXT NOT NULL, complete INTEGER NOT NULL)`,
];

/** The checkpoint a feature's stored list was read from, with the names its own change modifies. */
export interface CallerListed {
  readonly checkpoint: string;
  readonly runId: number;
  /** The names the checkpoint's change modifies, removes, renames or moves, with each one's module. */
  readonly changed: readonly string[];
  /** False when the change touches Python files the analysis cannot read or a list was truncated, so its reach is unknown. */
  readonly complete: boolean;
}

export class CallerListStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of CALLER_LIST_SCHEMA) db.exec(statement);
  }

  /**
   * Keeps the names report `runId` read at `checkpoint` of `featureId`, replacing the feature's
   * earlier list. Answers whether the report was kept; false for a report older than the stored one.
   */
  listed(featureId: string, checkpoint: string, runId: number, names: readonly string[], changed: readonly string[] = [], complete = true): boolean {
    const [meta] = this.#db.exec(`SELECT run_id FROM ForkCallList WHERE feature_id = ?`, featureId);
    if (meta !== undefined && Number(meta["run_id"]) > runId) return false;
    this.#db.transaction(() => {
      this.#db.exec(`DELETE FROM ForkCall WHERE feature_id = ?`, featureId);
      for (const name of new Set(names)) this.#db.exec(`INSERT INTO ForkCall (feature_id, name) VALUES (?, ?)`, featureId, name);
      this.#db.exec(
        `INSERT OR REPLACE INTO ForkCallList (feature_id, checkpoint, run_id, listed_at, changed, complete) VALUES (?, ?, ?, ?, ?, ?)`,
        featureId,
        checkpoint,
        runId,
        this.#now(),
        JSON.stringify([...new Set(changed)].sort()),
        complete ? 1 : 0,
      );
    });
    return true;
  }

  /** The checkpoint `featureId`'s list was read from; undefined before its first report. */
  listedAt(featureId: string): CallerListed | undefined {
    const [row] = this.#db.exec(`SELECT * FROM ForkCallList WHERE feature_id = ?`, featureId);
    return row === undefined ? undefined : {
          checkpoint: String(row["checkpoint"]),
          runId: Number(row["run_id"]),
          changed: JSON.parse(String(row["changed"])) as string[],
          complete: Number(row["complete"]) === 1,
        };
  }

  /**
   * The checkpoint of each feature's stored complete list. `callersOf` decides whether a change
   * reaches a feature only while that checkpoint is the feature's latest.
   */
  completeLists(): Map<string, string> {
    return new Map(
      this.#db.exec(`SELECT feature_id, checkpoint FROM ForkCallList WHERE complete = 1`).map((row) => [String(row["feature_id"]), String(row["checkpoint"])]),
    );
  }

  /**
   * The features whose own changes use any of `names`, sorted: a name matches itself and every name
   * inside it (`accounts.shoppers` matches `accounts.shoppers.ShopperMap.resolve`).
   */
  callersOf(names: readonly string[]): string[] {
    const found = new Set<string>();
    for (const name of new Set(names)) {
      const rows = this.#db.exec(`SELECT DISTINCT feature_id FROM ForkCall WHERE name = ? OR (name > ? AND name < ?)`, name, `${name}.`, `${name}/`);
      for (const row of rows) found.add(String(row["feature_id"]));
    }
    return [...found].sort();
  }

  /**
   * Drops the list of a feature that landed or stopped, which no later change can reach. The
   * ProjectAgent's FeatureStore calls it when the feature moves to `landed` or `closed`.
   */
  forget(featureId: string): void {
    this.#db.exec(`DELETE FROM ForkCall WHERE feature_id = ?`, featureId);
    this.#db.exec(`DELETE FROM ForkCallList WHERE feature_id = ?`, featureId);
  }
}

/** Kinds of change that leave a caller pointing at different behaviour or at nothing, as the impact graph counts them. */
const CALLER_CHANGES = new Set(["modified", "removed", "renamed", "moved"]);

/** The dotted module of a Python path: `accounts/shoppers.py` is `accounts.shoppers`, a package's `__init__.py` the package. */
function moduleOf(path: string): string {
  return path.replace(/\.py$/u, "").replace(/\/__init__$/u, "").replaceAll("/", ".");
}

/** The names a change's callers are reached through: each changed symbol and the module that holds it. */
export function changedNames(impact: ImpactReport): string[] {
  const names = new Set<string>();
  for (const change of impact.changes) {
    if (!CALLER_CHANGES.has(change.change)) continue;
    names.add(change.symbol);
    names.add(moduleOf(change.path));
    // A re-export that now points elsewhere reaches the callers of what it pointed to before:
    // `shared.platform.http.Client` moving from `vendor.wire_v1.Client` to `vendor.wire_v2.Client`.
    if (change.origin !== undefined) names.add(change.origin.before);
  }
  return [...names].sort();
}

const isCalls = (run: AgentToolRun): boolean => run.tool === "impact" && run.input["search"] === CALLS_SEARCH;

/** Whether `run` is Penguin's request for a checkpoint's caller list, which the runner claims without an identity. */
export const isCallerListRequest = (run: AgentToolRun): boolean => run.sessionId === PENGUIN_SESSION && isCalls(run);

/**
 * At checkpoint `sha` of `feature`, whose baseline on main is `baseSha`: one request of Penguin's own
 * for the check runner to list the names the checkpoint's own changes use. Undefined when the feature
 * has no fork or this checkpoint was already asked for.
 */
export function requestCallerList(runs: AgentToolStore, feature: Feature, sha: string, baseSha: string): number | undefined {
  if (feature.repo === null) return undefined;
  if (runs.list(feature.id).some((run) => isCalls(run) && run.checkpointSha === sha)) return undefined;
  return runs.insert({
    featureId: feature.id,
    sessionId: PENGUIN_SESSION,
    caller: "penguin",
    tool: "impact",
    input: { feature: feature.id, search: CALLS_SEARCH },
    result: "waiting",
    summary: `Penguin's caller list of ${feature.id}@${sha.slice(0, 12)} waits for the check runner`,
    checkpointSha: sha,
    durationMs: 0,
    baseSha,
  }).id;
}

/**
 * The feature checkpoint whose combined runs wait on `run` (combined-run-schedule.ts): the checkpoint
 * a caller list request read, kept or not, while it is still its feature's latest. Undefined for any
 * other request, a feature with no fork or a checkpoint a newer one replaced.
 */
export function listedCheckpoint(
  features: { get(id: string): Feature | undefined },
  run: AgentToolRun,
): { readonly featureId: string; readonly personId: string; readonly repo: string; readonly sha: string } | undefined {
  if (!isCallerListRequest(run) || run.featureId === null || run.checkpointSha === null) return undefined;
  const feature = features.get(run.featureId);
  if (feature === undefined || feature.repo === null || feature.latestCheckpointSha !== run.checkpointSha) return undefined;
  return { featureId: feature.id, personId: feature.personId, repo: feature.repo, sha: run.checkpointSha };
}

/**
 * The runner reported `run`: when it is a caller list request with a report, the store keeps the
 * feature's names. Answers whether they were kept; false for any other request, an error or an older report.
 */
export function callsReported(store: CallerListStore, run: AgentToolRun): boolean {
  if (!isCalls(run) || run.outcome?.result !== "found" || run.featureId === null || run.checkpointSha === null) return false;
  const impact = run.outcome.impact;
  const calls = impact?.forks.find((fork) => fork.id === run.featureId)?.calls;
  if (impact === null || impact === undefined || calls === undefined) return false;
  return store.listed(run.featureId, run.checkpointSha, run.id, calls, changedNames(impact), listComplete(impact));
}

/**
 * Whether a list answers every caller of the change: nothing was truncated and every changed file the
 * analysis could not read is a file other than Python, such as `penguin/scopes.json`. Python code
 * reaches such a file through no name, so its reach is the forks that change the same file, which a
 * block finds by overlap (block-land.ts `reachedTargets`). A Python file the analysis could not read
 * may have callers, so the list is incomplete.
 */
function listComplete(impact: ImpactReport): boolean {
  return !impact.truncated && impact.unanalysed.every((path) => !path.endsWith(".py"));
}
