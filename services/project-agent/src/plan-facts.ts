// The facts runs of merge plans (PRD 0.4 section 4.2 step 2): what Penguin asks the check runner to
// find out about one feature checkpoint, and what the runner reported. The impact graph and contract
// diff need the code parsed, and each break needs the tests run, so neither can be made in the Worker.
//
// propose_plan schedules one run per feature checkpoint and set of rewrite rules the first time a plan
// names them. The runner lists the pending runs on `GET /plan-facts` and reports each on
// `POST /plan-facts/<run id>`. A newer run of the feature, for a newer checkpoint or other rules,
// supersedes a run still pending: its report answers `superseded`.
//
// A run's targets are main, at the checkpoint's baseline, and each running feature that may read what
// the checkpoint changes: one whose area falls in a scope that depends on a scope the feature touches,
// or that the overlap check stored as a dependent. Each feature is a target of its own, keyed by its
// id and carrying its person, so a person with two such features gets two targets. Each target runs the tests of those dependent
// scopes, by command ID only; the runner resolves each ID from `penguin/scopes.json` itself.
//
// When the plan declares rewrite rules, the run also carries them with the places to apply them: main
// at the baseline, inside the dependent scopes' paths, and each running feature at its checkpoint,
// on the files it changed itself inside its scopes. The runner reports each file the rules change.

import {
  checkPlanFactsReport,
  PLAN_LIMITS,
  PLAN_MAIN_TARGET,
  rewriteRulesKey,
  type PlanFactsReport,
  type PlanFactsRequest,
  type PlanFactsTarget,
  type RewriteRule,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { Feature } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { footprint, RUNNING_STATES, type FeatureDependent } from "./overlap-lock.ts";

type Row = Record<string, SqlValue>;

export const PLAN_FACTS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS PlanFactsRun (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
    request TEXT NOT NULL, state TEXT NOT NULL, report TEXT, runner_id TEXT,
    created_at INTEGER NOT NULL, reported_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS PlanFactsRun_feature ON PlanFactsRun (feature_id, checkpoint, id)`,
  `CREATE INDEX IF NOT EXISTS PlanFactsRun_state ON PlanFactsRun (state, id)`,
];

export type PlanFactsState = "pending" | "reported" | "superseded";

export interface PlanFactsRun {
  readonly runId: string;
  readonly featureId: string;
  readonly checkpoint: string;
  readonly request: PlanFactsRequest;
  readonly state: PlanFactsState;
  readonly report: PlanFactsReport | null;
  readonly runnerId: string | null;
  readonly createdAt: string;
  readonly reportedAt: string | null;
}

export type PlanFactsReportOutcome =
  | { readonly status: "recorded"; readonly runId: string }
  | { readonly status: "rejected"; readonly reason: "not_found" | "superseded" | "invalid" | "forbidden"; readonly message: string };

function run(row: Row): PlanFactsRun {
  const reportedAt = row["reported_at"];
  return {
    runId: String(row["id"]),
    featureId: row["feature_id"] as string,
    checkpoint: row["checkpoint"] as string,
    request: JSON.parse(row["request"] as string) as PlanFactsRequest,
    state: row["state"] as PlanFactsState,
    report: row["report"] === null ? null : (JSON.parse(row["report"] as string) as PlanFactsReport),
    runnerId: (row["runner_id"] as string | null) ?? null,
    createdAt: new Date(Number(row["created_at"])).toISOString(),
    reportedAt: reportedAt === null ? null : new Date(Number(reportedAt)).toISOString(),
  };
}

export class PlanFactsStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PLAN_FACTS_SCHEMA) db.exec(statement);
  }

  /**
   * The feature's newest run for `checkpoint` that no newer run superseded, or undefined. With
   * `rules`, only a run that carries exactly those rewrite rules.
   */
  forCheckpoint(featureId: string, checkpoint: string, rules?: readonly RewriteRule[]): PlanFactsRun | undefined {
    const [row] = this.#db.exec(
      `SELECT * FROM PlanFactsRun WHERE feature_id = ? AND checkpoint = ? AND state != 'superseded' ORDER BY id DESC LIMIT 1`,
      featureId,
      checkpoint,
    );
    if (row === undefined) return undefined;
    const found = run(row);
    if (rules !== undefined && rewriteRulesKey(found.request.rewrites?.rules ?? []) !== rewriteRulesKey(rules)) return undefined;
    return found;
  }

  /**
   * Schedules a run for the feature's checkpoint, superseding every run of the feature still pending:
   * one for another checkpoint, or for this one with other rules. `request` is everything but the run
   * id, which the store gives.
   */
  schedule(request: Omit<PlanFactsRequest, "runId">): PlanFactsRun {
    return this.#db.transaction(() => {
      this.#db.exec(
        `UPDATE PlanFactsRun SET state = 'superseded' WHERE feature_id = ? AND state = 'pending'`,
        request.feature,
      );
      const [row] = this.#db.exec(
        `INSERT INTO PlanFactsRun (feature_id, checkpoint, request, state, created_at) VALUES (?, ?, '{}', 'pending', ?) RETURNING id`,
        request.feature,
        request.checkpoint,
        this.#now(),
      );
      const runId = String((row as Row)["id"]);
      this.#db.exec(`UPDATE PlanFactsRun SET request = ? WHERE id = ?`, JSON.stringify({ runId, ...request }), Number(runId));
      return this.get(runId) as PlanFactsRun;
    });
  }

  get(runId: string): PlanFactsRun | undefined {
    if (!/^[0-9]{1,15}$/u.test(runId)) return undefined;
    const [row] = this.#db.exec(`SELECT * FROM PlanFactsRun WHERE id = ?`, Number(runId));
    return row === undefined ? undefined : run(row);
  }

  /** The runs waiting for the runner, oldest first. */
  pending(): PlanFactsRequest[] {
    return this.#db.exec(`SELECT * FROM PlanFactsRun WHERE state = 'pending' ORDER BY id`).map((row) => run(row).request);
  }

  /** Records a runner's report of run `runId`. A report is checked against the schema and taken once. */
  record(runId: string, runnerId: string, report: unknown): PlanFactsReportOutcome {
    const found = this.get(runId);
    if (found === undefined) return { status: "rejected", reason: "not_found", message: `no plan facts run ${runId}` };
    if (found.state === "superseded") {
      return { status: "rejected", reason: "superseded", message: `a newer checkpoint of feature ${found.featureId} superseded run ${runId}` };
    }
    if (found.state === "reported") return { status: "rejected", reason: "superseded", message: `run ${runId} is already reported` };
    const [first] = checkPlanFactsReport(report);
    if (first !== undefined) return { status: "rejected", reason: "invalid", message: `${first.path || "the report"} ${first.message}` };
    const facts = report as PlanFactsReport;
    const wanted = new Set(found.request.targets.flatMap((target) => target.commandIds.map((id) => `${target.id} ${id}`)));
    const stray = facts.results.find((result) => !wanted.has(`${result.target} ${result.commandId}`));
    if (stray !== undefined) {
      return { status: "rejected", reason: "invalid", message: `run ${runId} did not ask for ${stray.commandId} on ${stray.target}` };
    }
    this.#db.exec(
      `UPDATE PlanFactsRun SET state = 'reported', report = ?, runner_id = ?, reported_at = ? WHERE id = ?`,
      JSON.stringify(facts),
      runnerId,
      this.#now(),
      Number(runId),
    );
    return { status: "recorded", runId };
  }
}

/** The scopes a feature's area touches: its declared scopes and the scopes of its paths and contracts. */
export function touchedScopes(feature: Feature, scopeMap: ScopeMap): Set<string> {
  return new Set(footprint(feature.area, scopeMap).touched);
}

/** The scopes that depend on any of `scopes`, other than those scopes themselves. */
export function dependentScopes(scopes: ReadonlySet<string>, scopeMap: ScopeMap): Set<string> {
  const dependents = new Set<string>();
  for (const scope of scopes) for (const consumer of scopeMap.dependents.get(scope) ?? []) dependents.add(consumer);
  for (const scope of scopes) dependents.delete(scope);
  return dependents;
}

const testCommand = (scopeId: string): string => `test:${scopeId}`;

/**
 * The facts run for feature `feature` at its latest checkpoint, built on `baseline`: main and each
 * running feature with a checkpoint that may read what it changes. `features` is every feature and
 * `dependents` the feature's stored dependents. `rules`, the plan's rewrite rules, run in each target.
 */
export function factsRequest(
  feature: Feature,
  baseline: string,
  scopeMap: ScopeMap,
  features: readonly Feature[],
  dependents: readonly FeatureDependent[],
  rules: readonly RewriteRule[] = [],
): Omit<PlanFactsRequest, "runId"> {
  const consumers = dependentScopes(touchedScopes(feature, scopeMap), scopeMap);
  const fork = `feature-${feature.id}`;
  const main: PlanFactsTarget = {
    id: PLAN_MAIN_TARGET,
    person: null,
    repo: fork,
    sha: baseline,
    scopes: [],
    commandIds: [...consumers].sort().map(testCommand),
  };
  const stored = new Map<string, Set<string>>();
  for (const each of dependents) {
    const scopes = stored.get(each.dependentFeatureId) ?? new Set<string>();
    scopes.add(each.consumerScopeId);
    stored.set(each.dependentFeatureId, scopes);
  }
  const targets: PlanFactsTarget[] = [main];
  for (const other of [...features].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (other.id === feature.id || !RUNNING_STATES.has(other.state) || other.repo === null || other.latestCheckpointSha === null) continue;
    const scopes = new Set([...touchedScopes(other, scopeMap)].filter((scope) => consumers.has(scope)));
    for (const scope of stored.get(other.id) ?? []) if (scopeMap.scopes.has(scope)) scopes.add(scope);
    if (scopes.size === 0) continue;
    const sorted = [...scopes].sort().slice(0, PLAN_LIMITS.commandsPerTarget);
    targets.push({
      id: other.id,
      person: other.personId,
      repo: `feature-${other.id}`,
      sha: other.latestCheckpointSha,
      scopes: sorted,
      commandIds: sorted.map(testCommand),
    });
    if (targets.length >= PLAN_LIMITS.targets) break;
  }
  const request = { feature: feature.id, fork, checkpoint: feature.latestCheckpointSha as string, baseline, targets };
  if (rules.length === 0) return request;
  const pathsOf = (scopes: Iterable<string>) => [...new Set([...scopes].flatMap((scope) => scopeMap.scopes.get(scope)?.paths ?? []))].sort();
  const places = targets.map((target) =>
    target.id === PLAN_MAIN_TARGET
      ? { target: target.id, sha: target.sha, paths: pathsOf(consumers), since: null }
      : { target: target.id, sha: target.sha, paths: pathsOf(target.scopes), since: baseline },
  );
  return { ...request, rewrites: { rules, places } };
}
