// Where a feature's merge plans are kept (PRD 0.4 section 9, FeatureAgent storage):
// `Plan(feature_id, version, state)` and `PlanPart(plan_id, target_feature_id or scope_id, kind,
// proposed_diff_ref, approval_state, approved_by)`. Each plan's facts and each part's facts are kept
// beside the row as JSON, as Penguin assembled them.
//
// The store runs on one SQL database. The per-feature Durable Object (the HuddleAgent class until
// #96 renames it FeatureAgent) owns one instance per feature, so moving plans to the FeatureAgent
// moves this module only. Nothing here signs or checks a plan: propose-plan.ts does both on the
// ProjectAgent, which holds the service key.

import type { Plan, PlanPart } from "@penguin/protocol";

export type { Plan };

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

export const PLAN_STORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS Plan (
    plan_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
    record_id TEXT NOT NULL, plan TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (feature_id, version))`,
  `CREATE TABLE IF NOT EXISTS PlanPart (
    part_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, target_feature_id TEXT, scope_id TEXT,
    kind TEXT NOT NULL, proposed_diff_ref TEXT NOT NULL, approval_state TEXT NOT NULL,
    approved_by TEXT, part TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS PlanPart_plan ON PlanPart (plan_id)`,
];

/** What the ProjectAgent asks of a feature's plan store, over Durable Object RPC in the Worker. */
export interface PlanKeeper {
  /** The feature's newest plan version, or 0 before its first plan. */
  planVersion(featureId: string): number | Promise<number>;
  /** Keeps a plan with every part. False, keeping nothing, when that version already exists. */
  keepPlan(plan: Plan): boolean | Promise<boolean>;
  /** The feature's newest plan, or undefined. */
  latestPlan(featureId: string): Plan | undefined | Promise<Plan | undefined>;
}

export class PlanStore implements PlanKeeper {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PLAN_STORE_SCHEMA) db.exec(statement);
  }

  planVersion(featureId: string): number {
    const [row] = this.#db.exec(`SELECT COALESCE(MAX(version), 0) AS version FROM Plan WHERE feature_id = ?`, featureId);
    return Number(row?.["version"] ?? 0);
  }

  keepPlan(plan: Plan): boolean {
    return this.#db.transaction(() => {
      const [existing] = this.#db.exec(`SELECT plan_id FROM Plan WHERE feature_id = ? AND version = ?`, plan.featureId, plan.version);
      if (existing !== undefined) return false;
      this.#db.exec(
        `INSERT INTO Plan (plan_id, feature_id, version, state, record_id, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        plan.planId,
        plan.featureId,
        plan.version,
        plan.state,
        plan.recordId,
        // The parts live in their own rows.
        JSON.stringify({ ...plan, parts: [] }),
        this.#now(),
      );
      for (const part of plan.parts) this.#insertPart(plan.planId, part);
      return true;
    });
  }

  latestPlan(featureId: string): Plan | undefined {
    const [row] = this.#db.exec(`SELECT plan FROM Plan WHERE feature_id = ? ORDER BY version DESC LIMIT 1`, featureId);
    return row === undefined ? undefined : this.#withParts(JSON.parse(row["plan"] as string) as Plan);
  }

  /** A plan's parts as their rows hold them, in part order. */
  parts(planId: string): PlanPart[] {
    return this.#db
      .exec(`SELECT part FROM PlanPart WHERE plan_id = ? ORDER BY rowid`, planId)
      .map((row: Record<string, SqlValue>) => JSON.parse(row["part"] as string) as PlanPart);
  }

  #withParts(plan: Plan): Plan {
    return { ...plan, parts: this.parts(plan.planId) };
  }

  #insertPart(planId: string, part: PlanPart): void {
    this.#db.exec(
      `INSERT INTO PlanPart (part_id, plan_id, target_feature_id, scope_id, kind, proposed_diff_ref, approval_state, approved_by, part)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      part.partId,
      planId,
      part.place.kind === "feature" ? part.place.feature : null,
      part.place.kind === "scope" ? part.place.scope : null,
      part.kind,
      part.diff.ref,
      part.approvalState,
      part.approvedBy,
      JSON.stringify(part),
    );
  }
}
