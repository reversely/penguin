// The project's retiring symbols (PRD 0.5 section 4.2 step 2), as signed data. A stored merge plan
// that declares `retiring` symbols records them here and in a signed `retire_symbols` record on its
// feature (propose-plan.ts). Only the plan's originating person declares them: propose_plan takes a
// plan only from an agent session of the feature's own person.
//
// A newer plan of the same feature replaces that feature's declarations. A contract another feature
// already retires keeps its first declaration.
//
// Readers: the retiring-calls check at each checkpoint (agent-tools.ts `requestRetiringCheck`), the
// `impact` tool's migration groups and `apply_fix` by a retiring symbol's rewrite rule.

import type { Plan, RetiringDeclaration, RetiringSymbol, RewriteRule } from "@penguin/protocol";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

export const RETIRING_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS RetiringSymbol (
    contract TEXT PRIMARY KEY, replacement TEXT NOT NULL, feature_id TEXT NOT NULL, plan_id TEXT NOT NULL,
    person_id TEXT NOT NULL, rules TEXT NOT NULL, record_id TEXT NOT NULL, declared_at INTEGER NOT NULL)`,
];

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

export class RetiringStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of RETIRING_SCHEMA) db.exec(statement);
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
      this.#db.exec(`DELETE FROM RetiringSymbol WHERE feature_id = ?`, plan.featureId);
      for (const symbol of symbols) {
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
}
