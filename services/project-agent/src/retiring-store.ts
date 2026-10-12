// The project's retiring symbols (PRD 0.5 section 4.2 step 2), as signed data. A stored merge plan
// that declares `retiring` symbols records them here and in a signed `retire_symbols` record on its
// feature (propose-plan.ts). Only the plan's originating person declares them: propose_plan takes a
// plan only from an agent session of the feature's own person.
//
// A newer plan of the same feature replaces that feature's declarations. A contract another feature
// already retires keeps its first declaration.
//
// A split feature's expand promotion declares its old names too (contract-split.ts), under the plan id
// `split:<feature>` and with no rules. A later plan of the feature keeps them, except each contract
// it declares itself, which then carries the plan's rules.
//
// Readers: the retiring-calls check at each checkpoint (agent-tools.ts `requestRetiringCheck`), the
// `impact` tool's migration groups and `apply_fix` by a retiring symbol's rewrite rule.
//
// The contract step (retiring-count.ts) keeps two more tables here: each symbol's callers at the last
// count after a promotion, and each symbol Penguin proposed removing. A symbol whose removal reached
// main leaves `RetiringSymbol`, so no check names it as retiring any more; its contract step stays,
// marked removed.

import type { ContractStepEntry, Plan, RetiringCallerCount, RetiringDeclaration, RetiringSymbol, RewriteRule } from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

export const RETIRING_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS RetiringSymbol (
    contract TEXT PRIMARY KEY, replacement TEXT NOT NULL, feature_id TEXT NOT NULL, plan_id TEXT NOT NULL,
    person_id TEXT NOT NULL, rules TEXT NOT NULL, record_id TEXT NOT NULL, declared_at INTEGER NOT NULL)`,
  // Each symbol's callers at the last count after a promotion; null callers is an incomplete count.
  `CREATE TABLE IF NOT EXISTS RetiringCount (
    contract TEXT PRIMARY KEY, callers INTEGER, on_main INTEGER NOT NULL, features TEXT NOT NULL,
    promotion TEXT NOT NULL, run_id INTEGER NOT NULL, counted_at INTEGER NOT NULL)`,
  // Each symbol Penguin proposed removing: approved, then removed once the block reached main.
  `CREATE TABLE IF NOT EXISTS ContractStep (
    contract TEXT PRIMARY KEY, replacement TEXT NOT NULL, feature_id TEXT NOT NULL, state TEXT NOT NULL,
    record_id TEXT NOT NULL, promotion TEXT NOT NULL, run_id INTEGER NOT NULL, proposed_at INTEGER NOT NULL,
    removed_promotion TEXT, removed_record TEXT)`,
];

/** Columns added to ContractStep after its first release; each is added where a stored table lacks it. */
const CONTRACT_STEP_COLUMNS: readonly (readonly [string, string])[] = [
  // The feature Penguin opened from main to carry the removal when the originating feature no longer runs.
  ["carrier_feature", "carrier_feature TEXT"],
];

/** A symbol Penguin proposed removing, as the ContractStep table keeps it. */
export interface ContractStepRow extends RetiringSymbol {
  readonly feature: string;
  /** The feature that carries the removal: the originating feature, or one Penguin opened from main. */
  readonly carrier: string;
  readonly state: "approved" | "removed";
  readonly recordId: string;
  readonly promotion: string;
  readonly runId: number;
  readonly removedPromotion: string | null;
  readonly removedRecordId: string | null;
}

type Row = Record<string, SqlValue>;

function declaration(row: Row): RetiringDeclaration {
  return {
    contract: String(row["contract"]),
    replacement: String(row["replacement"]),
    feature: String(row["feature_id"]),
    planId: String(row["plan_id"]),
    person: String(row["person_id"]),
    rules: JSON.parse(String(row["rules"])) as RewriteRule[],
    recordId: String(row["record_id"]),
    declaredAt: new Date(Number(row["declared_at"])).toISOString(),
  };
}

function stepRow(row: Row): ContractStepRow {
  return {
    contract: String(row["contract"]),
    replacement: String(row["replacement"]),
    feature: String(row["feature_id"]),
    carrier: row["carrier_feature"] === null || row["carrier_feature"] === undefined ? String(row["feature_id"]) : String(row["carrier_feature"]),
    state: String(row["state"]) as ContractStepRow["state"],
    recordId: String(row["record_id"]),
    promotion: String(row["promotion"]),
    runId: Number(row["run_id"]),
    removedPromotion: row["removed_promotion"] === null ? null : String(row["removed_promotion"]),
    removedRecordId: row["removed_record"] === null ? null : String(row["removed_record"]),
  };
}

export class RetiringStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of RETIRING_SCHEMA) db.exec(statement);
    // Column names and definitions come from the constant above, never from input.
    const present = new Set(db.exec(`PRAGMA table_info(ContractStep)`).map((row) => row["name"]));
    for (const [name, definition] of CONTRACT_STEP_COLUMNS) {
      if (!present.has(name)) db.exec(`ALTER TABLE ContractStep ADD COLUMN ${definition}`);
    }
  }

  /** Every retiring symbol of the project, by contract. */
  list(): RetiringDeclaration[] {
    return this.#db.exec(`SELECT * FROM RetiringSymbol ORDER BY contract`).map(declaration);
  }

  /** The contracts of `symbols` another feature already retires. */
  heldElsewhere(featureId: string, symbols: readonly RetiringSymbol[]): string[] {
    const held = new Set(this.#db.exec(`SELECT contract FROM RetiringSymbol WHERE feature_id != ?`, featureId).map((row) => String(row["contract"])));
    return symbols.filter((symbol) => held.has(symbol.contract)).map((symbol) => symbol.contract);
  }

  /**
   * Keeps the stored plan's retiring symbols, each with the plan's rewrite rules for its contract,
   * under the signed record `recordId`. They replace the feature's earlier declarations.
   */
  declare(plan: Plan, symbols: readonly RetiringSymbol[], recordId: string): RetiringDeclaration[] {
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db.exec(`DELETE FROM RetiringSymbol WHERE feature_id = ? AND plan_id != ?`, plan.featureId, splitPlanId(plan.featureId));
      for (const symbol of symbols) {
        this.#db.exec(`DELETE FROM RetiringSymbol WHERE feature_id = ? AND contract = ?`, plan.featureId, symbol.contract);
        const rules = (plan.rules ?? []).filter((rule) => rule.contract === symbol.contract);
        this.#db.exec(
          `INSERT OR IGNORE INTO RetiringSymbol (contract, replacement, feature_id, plan_id, person_id, rules, record_id, declared_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          symbol.contract,
          symbol.replacement,
          plan.featureId,
          plan.planId,
          plan.person,
          JSON.stringify(rules),
          recordId,
          now,
        );
      }
    });
    return this.list().filter((each) => each.feature === plan.featureId);
  }

  /**
   * Keeps the old names a split feature's expand promotion retires (contract-split.ts), with no rules,
   * under the signed record `recordId`. A contract another feature already retires keeps its first
   * declaration.
   */
  declareSplit(featureId: string, person: string, symbols: readonly RetiringSymbol[], recordId: string): RetiringDeclaration[] {
    const now = this.#now();
    this.#db.transaction(() => {
      for (const symbol of symbols) {
        this.#db.exec(
          `INSERT OR IGNORE INTO RetiringSymbol (contract, replacement, feature_id, plan_id, person_id, rules, record_id, declared_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
          symbol.contract,
          symbol.replacement,
          featureId,
          splitPlanId(featureId),
          person,
          recordId,
          now,
        );
      }
    });
    return this.list().filter((each) => each.feature === featureId);
  }

  /**
   * Keeps the count of tool request `runId` after the promotion to `promotion`, for each of
   * `contracts`. `counts` null is an incomplete count: no number of callers is known.
   */
  counted(contracts: readonly string[], counts: readonly RetiringCallerCount[] | null, runId: number, promotion: string): void {
    const now = this.#now();
    const byContract = new Map((counts ?? []).map((each) => [each.contract, each]));
    this.#db.transaction(() => {
      for (const contract of contracts) {
        const count = byContract.get(contract);
        this.#db.exec(
          `INSERT INTO RetiringCount (contract, callers, on_main, features, promotion, run_id, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (contract) DO UPDATE SET callers = excluded.callers, on_main = excluded.on_main, features = excluded.features,
             promotion = excluded.promotion, run_id = excluded.run_id, counted_at = excluded.counted_at`,
          contract,
          count === undefined ? null : count.callers,
          count?.onMain ?? 0,
          JSON.stringify(count?.features ?? []),
          promotion,
          runId,
          now,
        );
      }
    });
  }

  /**
   * The symbols Penguin approved removing whose removal has not reached main, of all or of the one
   * feature that carries the removal: the originating feature, or the feature Penguin opened for it.
   */
  approvedSteps(featureId?: string): ContractStepRow[] {
    const rows =
      featureId === undefined
        ? this.#db.exec(`SELECT * FROM ContractStep WHERE state = 'approved' ORDER BY contract`)
        : this.#db.exec(`SELECT * FROM ContractStep WHERE state = 'approved' AND COALESCE(carrier_feature, feature_id) = ? ORDER BY contract`, featureId);
    return rows.map(stepRow);
  }

  /**
   * Penguin approved removing `symbols` of `featureId`, after the count `runId`, under the signed record
   * `recordId`. `carrier` names the feature Penguin opened from main to carry it, when `featureId` no
   * longer runs.
   */
  approveRemoval(featureId: string, symbols: readonly RetiringSymbol[], recordId: string, runId: number, promotion: string, carrier: string | null = null): void {
    const now = this.#now();
    this.#db.transaction(() => {
      for (const symbol of symbols) {
        this.#db.exec(
          `INSERT OR REPLACE INTO ContractStep (contract, replacement, feature_id, state, record_id, promotion, run_id, proposed_at, removed_promotion, removed_record, carrier_feature)
           VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, NULL, NULL, ?)`,
          symbol.contract,
          symbol.replacement,
          featureId,
          recordId,
          promotion,
          runId,
          now,
          carrier,
        );
      }
    });
  }

  /** A caller of `contracts` came back: Penguin's approvals of their removal are withdrawn. */
  withdrawRemoval(contracts: readonly string[]): void {
    this.#db.transaction(() => {
      for (const contract of contracts) this.#db.exec(`DELETE FROM ContractStep WHERE contract = ? AND state = 'approved'`, contract);
    });
  }

  /**
   * The block that removed `contracts` reached main at `promotion`: each leaves the retiring symbols,
   * and its contract step is marked removed under the signed record `recordId`.
   */
  removed(contracts: readonly string[], promotion: string, recordId: string): void {
    this.#db.transaction(() => {
      for (const contract of contracts) {
        this.#db.exec(`DELETE FROM RetiringSymbol WHERE contract = ?`, contract);
        this.#db.exec(`UPDATE ContractStep SET state = 'removed', removed_promotion = ?, removed_record = ? WHERE contract = ?`, promotion, recordId, contract);
      }
    });
  }

  /**
   * Each symbol `featureId` retires, with its last count and its contract step, in contract order:
   * the symbols it still declares, then those its block removed.
   */
  contractSteps(featureId: string): ContractStepEntry[] {
    const symbols = new Map(
      this.#db.exec(`SELECT contract, replacement FROM RetiringSymbol WHERE feature_id = ?`, featureId).map((row) => [String(row["contract"]), String(row["replacement"])]),
    );
    const steps = new Map(this.#db.exec(`SELECT * FROM ContractStep WHERE feature_id = ?`, featureId).map((row) => [String(row["contract"]), stepRow(row)]));
    for (const step of steps.values()) if (step.state === "removed" && !symbols.has(step.contract)) symbols.set(step.contract, step.replacement);
    return [...symbols.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([contract, replacement]): ContractStepEntry => {
        const [count] = this.#db.exec(`SELECT * FROM RetiringCount WHERE contract = ?`, contract);
        const callers = count === undefined || count["callers"] === null ? null : Number(count["callers"]);
        const step = steps.get(contract);
        return {
          contract,
          replacement,
          state: step?.state ?? (callers === null ? "counting" : callers === 0 ? "no_callers" : "callers_left"),
          callers,
          onMain: count === undefined ? 0 : Number(count["on_main"]),
          features: count === undefined ? [] : (JSON.parse(String(count["features"])) as ContractStepEntry["features"]),
          promotion: count === undefined ? null : String(count["promotion"]),
          countRun: count === undefined ? null : Number(count["run_id"]),
          recordId: step?.recordId ?? null,
          carrier: step === undefined || step.carrier === step.feature ? null : step.carrier,
          removedPromotion: step?.removedPromotion ?? null,
          removedRecordId: step?.removedRecordId ?? null,
        };
      });
  }
}

/** The plan id a split's own retiring declarations carry. */
export const splitPlanId = (featureId: string): string => `split:${featureId}`;
