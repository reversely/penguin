// Where a feature's merge plans are kept (PRD 0.4 section 9, FeatureAgent storage):
// `Plan(feature_id, version, state)`, `PlanPart(plan_id, target_feature_id or scope_id, kind,
// proposed_diff_ref, approval_state, approved_by)` and `FixWrite(plan_part_id, target_repo,
// commit_sha)`. Each plan's facts and each part's facts are kept beside the row as JSON, as Penguin
// assembled them. A part may be added to the newest plan later, for a running feature that started
// touching the plan's area (plan-coverage.ts); a fix written into an affected fork is kept once per
// part revision (fix-write.ts).
//
// The store runs on one SQL database. The feature's FeatureAgent owns one instance per feature,
// beside its block runs (block-store.ts). Nothing here signs or checks a plan: propose-plan.ts does
// both on the ProjectAgent, which holds the service key.

import type { Plan, PlanPart, PlanPartState } from "@penguin/protocol";

export type { Plan, PlanPart };

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
  `CREATE TABLE IF NOT EXISTS FixWrite (
    plan_part_id TEXT NOT NULL, revision INTEGER NOT NULL, target_repo TEXT NOT NULL, commit_sha TEXT NOT NULL,
    parent TEXT NOT NULL, record_id TEXT NOT NULL, written_at INTEGER NOT NULL, PRIMARY KEY (plan_part_id, revision))`,
];

/**
 * One approved fix written into an affected feature's fork (PRD 0.4 section 9, `FixWrite(plan_part_id,
 * target_repo, commit_sha)`), with the revision it wrote, the fork head it fast-forwarded and its
 * signed `fix_write` record.
 */
export interface FixWrite {
  readonly partId: string;
  readonly revision: number;
  /** The fork as bridges name it: `feature-<id>`. */
  readonly targetRepo: string;
  readonly commitSha: string;
  readonly parent: string;
  readonly recordId: string;
  readonly writtenAt: string;
}

/** What the ProjectAgent asks of a feature's plan store, over Durable Object RPC in the Worker. */
export interface PlanKeeper {
  /** The feature's newest plan version, or 0 before its first plan. */
  planVersion(featureId: string): number | Promise<number>;
  /** Keeps a plan with every part. False, keeping nothing, when that version already exists. */
  keepPlan(plan: Plan): boolean | Promise<boolean>;
  /** The feature's newest plan, or undefined. */
  latestPlan(featureId: string): Plan | undefined | Promise<Plan | undefined>;
  /**
   * Replaces one part of the feature's newest plan while that part still stands at `expected`: an
   * approval, a requested change or a revision. False, changing nothing, when the part is not in the
   * newest plan or moved since it was read, so two decisions never both land.
   */
  replacePart(featureId: string, part: PlanPart, expected: PartVersion): boolean | Promise<boolean>;
  /**
   * Adds a part to the feature's newest plan, `planId`, as its next part. False, adding nothing, when
   * that plan is no longer the newest or the part's id is not the next one.
   */
  addPart(featureId: string, planId: string, part: PlanPart): boolean | Promise<boolean>;
  /** Keeps one written fix. False when that revision of the part already has one. */
  keepFixWrite(write: FixWrite): boolean | Promise<boolean>;
  /** The fixes written for the parts of the feature's plans, oldest first. */
  fixWrites(featureId: string): FixWrite[] | Promise<FixWrite[]>;
}

/** The revision and approval state a part stood at when a decision on it was made. */
export interface PartVersion {
  readonly revision: number;
  readonly state: PlanPartState;
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
      .map((row: Record<string, SqlValue>) => storedPart(row["part"] as string));
  }

  replacePart(featureId: string, part: PlanPart, expected: PartVersion): boolean {
    return this.#db.transaction(() => {
      const latest = this.latestPlan(featureId);
      const current = latest?.parts.find((each) => each.partId === part.partId);
      if (latest === undefined || current === undefined) return false;
      if (current.revision !== expected.revision || current.approvalState !== expected.state) return false;
      this.#db.exec(
        `UPDATE PlanPart SET kind = ?, proposed_diff_ref = ?, approval_state = ?, approved_by = ?, part = ? WHERE part_id = ? AND plan_id = ?`,
        part.kind,
        part.diff.ref,
        part.approvalState,
        part.approvedBy,
        JSON.stringify(part),
        part.partId,
        latest.planId,
      );
      return true;
    });
  }

  addPart(featureId: string, planId: string, part: PlanPart): boolean {
    return this.#db.transaction(() => {
      const latest = this.latestPlan(featureId);
      if (latest === undefined || latest.planId !== planId || part.partId !== `${planId}#${latest.parts.length + 1}`) return false;
      this.#insertPart(planId, part);
      return true;
    });
  }

  keepFixWrite(write: FixWrite): boolean {
    const kept = this.#db.exec(
      `INSERT OR IGNORE INTO FixWrite (plan_part_id, revision, target_repo, commit_sha, parent, record_id, written_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING plan_part_id`,
      write.partId,
      write.revision,
      write.targetRepo,
      write.commitSha,
      write.parent,
      write.recordId,
      Date.parse(write.writtenAt),
    );
    return kept.length > 0;
  }

  fixWrites(featureId: string): FixWrite[] {
    // A part id starts with its feature id and `/v`, which no other feature's part id can.
    return this.#db
      .exec(`SELECT * FROM FixWrite WHERE substr(plan_part_id, 1, ?) = ? ORDER BY written_at, rowid`, featureId.length + 2, `${featureId}/v`)
      .map((row: Record<string, SqlValue>) => ({
        partId: row["plan_part_id"] as string,
        revision: Number(row["revision"]),
        targetRepo: row["target_repo"] as string,
        commitSha: row["commit_sha"] as string,
        parent: row["parent"] as string,
        recordId: row["record_id"] as string,
        writtenAt: new Date(Number(row["written_at"])).toISOString(),
      }));
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

/**
 * A part as its row holds it. A row kept before advance notice (#90) has no revision or round count:
 * it is the proposed revision with no change asked for.
 */
function storedPart(json: string): PlanPart {
  const part = JSON.parse(json) as Partial<PlanPart> & Omit<PlanPart, "revision" | "changeRequests" | "changeRequest">;
  return { ...part, revision: part.revision ?? 1, changeRequests: part.changeRequests ?? 0, changeRequest: part.changeRequest ?? null };
}
