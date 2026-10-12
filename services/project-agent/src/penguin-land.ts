// Penguin lands the features it opened from main (PRD 0.5 section 4.2 step 2 and section 4.5).
//
// A migration plan's block feature carries the plan's parts on main; a contract carrier carries the
// removal of retiring symbols (migration-plans.ts). Every part already passed its trial and approval,
// so no agent or person asks to land them. Penguin does, once every part the feature carries is written:
//
// - **Block feature:** every live part of its plan whose place is a scope on main is `written`.
// - **Contract carrier:** its `contract` edit task is done and none of its tasks is still open.
//
// Penguin then reads the fork's head. A head that main already holds has nothing to land. Otherwise
// Penguin records the head as the feature's checkpoint under a signed `checkpoint_area` record of its
// own, through the same steps an agent's checkpoint takes: the protected-path confirmations it asks
// for and its contract diff's facts run. A carrier waits until that facts run reports, so the
// promotion can close the symbols the removal took out (retiring-count.ts `closeRemoved`, #117). Then
// Penguin asks for the land itself (block-land.ts `requestPenguinLand`): the block check, then the
// promotion with Penguin's own write token on main, as #96 does for any feature. The block run's
// charter is the steward's of the feature's person, so a failed check goes down the ladder to that
// steward as next-step edit tasks.
//
// Load: one block run per carrier and checkpoint. Each head is landed at most once; a failed block
// waits for a new head, which a kept next-step commit makes. A land refused before its run (main moved,
// a protected path unconfirmed) is kept with its reason under one signed `land_returned` record per
// head and reason, and is asked again at the next sweep. Every value reaches SQL as a bound parameter.

import type { CharterView } from "@penguin/protocol";
import { OPEN_EDIT_TASK_STATES } from "@penguin/protocol";

import type { LandOutcome } from "./block-land.ts";
import type { EditTaskStore } from "./edit-tasks.ts";
import type { Feature, FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase } from "./issue-index.ts";
import type { MigrationStore } from "./migration-plans.ts";

export const PENGUIN_LAND_SCHEMA: readonly string[] = [
  // Each land Penguin asked for: `checking` once a block run opened, else the reason it was refused.
  `CREATE TABLE IF NOT EXISTS PenguinLand (
    feature_id TEXT NOT NULL, checkpoint TEXT NOT NULL, outcome TEXT NOT NULL, run_id TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, checkpoint))`,
];

export class PenguinLandStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PENGUIN_LAND_SCHEMA) db.exec(statement);
  }

  /** The outcome of Penguin's land of `featureId` at `checkpoint`, or undefined before one. */
  outcome(featureId: string, checkpoint: string): string | undefined {
    const [row] = this.#db.exec(`SELECT outcome FROM PenguinLand WHERE feature_id = ? AND checkpoint = ?`, featureId, checkpoint);
    return row === undefined ? undefined : String(row["outcome"]);
  }

  keep(featureId: string, checkpoint: string, outcome: string, runId: string | null): void {
    this.#db.exec(
      `INSERT INTO PenguinLand (feature_id, checkpoint, outcome, run_id, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (feature_id, checkpoint) DO UPDATE SET outcome = excluded.outcome, run_id = excluded.run_id, at = excluded.at`,
      featureId,
      checkpoint,
      outcome,
      runId,
      this.#now(),
    );
  }
}

export interface PenguinLandDeps {
  readonly migrations: Pick<MigrationStore, "penguinFeatures" | "planOfBlock">;
  readonly lands: PenguinLandStore;
  readonly features: FeatureStore;
  readonly tasks: Pick<EditTaskStore, "forSource">;
  /** The head of a fork's branch, where every written part sits; null when the fork has none. */
  readonly forkHead: (repo: string) => Promise<string | null>;
  readonly mainHead: () => Promise<string | null>;
  /** Records `sha` as the feature's checkpoint, authored by Penguin (feature-open.ts `recordPenguinCheckpoint`). */
  readonly checkpoint: (feature: Feature, sha: string) => Promise<Feature | undefined>;
  /** Whether the facts run of the feature's latest checkpoint has yet to report. */
  readonly factsWaiting: (feature: Feature) => boolean;
  /** The charter of the person's steward, which the ladder routes the block's failures by. */
  readonly charter: (person: string) => CharterView | undefined;
  /** Asks for the land (block-land.ts `requestPenguinLand`). */
  readonly land: (featureId: string, charter: CharterView) => Promise<LandOutcome>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  readonly notify?: (person: string) => void;
}

/** One land Penguin asked for at a sweep. */
export interface PenguinLandAttempt {
  readonly feature: string;
  readonly checkpoint: string;
  readonly status: "checking" | "rejected";
  readonly runId: string | null;
  readonly reason: string | null;
}

/** Why a Penguin feature is not ready to land, or null when every part it carries is written. */
export function carriedUnwritten(deps: Pick<PenguinLandDeps, "migrations" | "tasks">, featureId: string, kind: "block" | "contract"): string | null {
  if (kind === "contract") {
    const tasks = deps.tasks.forSource(`contract:${featureId}`);
    if (tasks.some((task) => OPEN_EDIT_TASK_STATES.includes(task.state))) return "the removal's edit task is open";
    return tasks.some((task) => task.state === "done") ? null : "the removal has not been done";
  }
  const plan = deps.migrations.planOfBlock(featureId);
  if (plan === undefined || plan.state === "landed" || plan.state === "closed") return "the block has no plan to land";
  const onMain = plan.parts.filter((part) => part.place.kind === "scope" && part.state !== "dropped" && part.state !== "landed");
  if (onMain.length === 0) return "the block carries no part";
  const waiting = onMain.filter((part) => part.state !== "written");
  return waiting.length === 0 ? null : `${waiting.map((part) => `${part.partId} is ${part.state.replaceAll("_", " ")}`).join(", ")}`;
}

/**
 * Asks for the land of each running feature Penguin opened whose parts are all written (see the module
 * comment). Answers each land asked for at this sweep.
 */
export async function landPenguinFeatures(deps: PenguinLandDeps): Promise<PenguinLandAttempt[]> {
  const attempts: PenguinLandAttempt[] = [];
  for (const { featureId, kind } of deps.migrations.penguinFeatures()) {
    const feature = deps.features.get(featureId);
    if (feature === undefined || feature.state !== "building" || feature.repo === null) continue;
    if (carriedUnwritten(deps, featureId, kind) !== null) continue;
    const attempt = await landOne(deps, feature as Feature & { readonly repo: string }, kind);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts;
}

async function landOne(deps: PenguinLandDeps, found: Feature & { readonly repo: string }, kind: "block" | "contract"): Promise<PenguinLandAttempt | undefined> {
  const head = await deps.forkHead(found.repo);
  if (head === null || head === (await deps.mainHead())) return undefined;
  // A head that had its block run waits for a new head: a failed block is not checked again as it is.
  const before = deps.lands.outcome(found.id, head);
  if (before === "checking") return undefined;
  const feature = found.latestCheckpointSha === head ? found : await deps.checkpoint(found, head);
  if (feature === undefined || feature.latestCheckpointSha !== head) return undefined;
  // A carrier's promotion closes its symbols from the facts run of the landed checkpoint.
  if (kind === "contract" && deps.factsWaiting(feature)) return undefined;
  const charter = deps.charter(feature.personId);
  const outcome: LandOutcome =
    charter === undefined
      ? { status: "rejected", reason: "not_found", message: `${feature.personId} has no steward to route the block's failures to` }
      : await deps.land(feature.id, charter);
  if (outcome.status === "checking") {
    deps.lands.keep(feature.id, head, "checking", outcome.run.runId);
    return { feature: feature.id, checkpoint: head, status: "checking", runId: outcome.run.runId, reason: null };
  }
  // A run already holds the feature: it is landing, and its own outcome decides what comes next.
  if (outcome.reason === "busy") return undefined;
  if (before !== outcome.reason) {
    // Each new reason a land at this head is refused for is on the feature's timeline once.
    const record = await deps.sign(
      deps.features.draftRecord(feature.id, "land_returned", { penguin: true }, { run_id: null, checkpoint: head, reason: outcome.reason, message: outcome.message }),
    );
    deps.features.addRecord(record);
    deps.lands.keep(feature.id, head, outcome.reason, null);
    deps.notify?.(feature.personId);
  }
  return { feature: feature.id, checkpoint: head, status: "rejected", runId: null, reason: outcome.reason };
}
