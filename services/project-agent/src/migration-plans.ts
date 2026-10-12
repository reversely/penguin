// The migration plans of a split, and the contract step of a feature that no longer runs (PRD 0.5
// section 4.2 step 2, Migrate and Contract; @penguin/protocol migration.ts).
//
// 1. **Proposing.** Each complete count of the callers of retiring symbols after a promotion
//    (retiring-count.ts) reaches `migrationsCounted`. For each originating feature, Penguin groups the
//    remaining callers of that feature's own retiring symbols by owner (`migrationGroups`): code on
//    main by the scope's DRI, a running feature's own changes by its person. Each group becomes one
//    plan of the originating feature, with one part per place, under a signed `migration_proposed`
//    record. A plan carries only that feature's declarations and their rewrite rules.
// 2. **A later caller.** A place found later, at a later count or at a checkpoint's retiring-calls
//    check (`migrationsChecked`), joins its owner's plan while that plan has not landed, under a
//    signed `migration_joined` record. Once the owner's plan landed, the place opens the owner's next
//    plan. A place whose callers are all gone at a complete count is dropped.
// 3. **Who writes a part.** A part whose contracts have declared rules waits for one rewrite request
//    of Penguin's own per proposal round (`search: "rewrite"`): the check runner applies the rules to
//    each such place's files in a throwaway worktree, keeps the patch and counts the uses the patched
//    tree still holds. A part the rules rewrite whole is the runner's: its patch is the part's fix and
//    its trial is asked for at once. Any other part becomes an edit task (edit-work.ts
//    `openEditTask`): a running feature's own changes go to that feature's builder, then the
//    steward of the scope's DRI; code on main goes to the steward of the scope's DRI, in the plan's
//    block feature. One signed `migration_routed` record per plan lists each part's writer and why.
// 4. **Trial and approval of a rule-written part.** Its trial (part-trial.ts) applies its patch to its
//    place: main at the count for code on main, the feature's fork head for a running feature, merged
//    with main. A rule-written part is mechanical and needs no review form, so the trial runs its
//    scopes' tests and, in the same run, the side-by-side run of each scope over its declared
//    examples with no form. The checks of PRD 4.3 read the trial (`partRouting`, then
//    `ruleWrittenRouting`): Penguin approves the part when the tests pass and no protected invariant
//    differs. A failing trial makes the part an edit task for the target's builder or the steward of
//    the scope's DRI, with the failing check attached. A check no edit settles, such as a protected
//    path or admin mode, sends it to its owner in person. Each decision is a signed
//    `migration_part_decided` record.
// 5. **Written.** Penguin's check runner writes an approved part's patch into its target fork through
//    the fix-write checks (fix-write.ts `MigrationWrites`): the running feature's fork, or the plan's
//    block feature for code on main. An edit task's kept commit writes its part. Either is a signed
//    `migration_part_written` record. An edit task whose run failed sends its part to a person:
//    the only way a migration part reaches one besides a check no edit settles.
// 6. **Closing and the block.** A plan whose live parts are all approved or written is `approved`.
//    A plan whose places are all running features opens no block: once every live part is written it
//    is `closed` under a signed `migration_closed` record, with nothing to promote, and a caller found
//    later opens the owner's next plan. Each plan with code on main names its own block feature,
//    `migrate-<owner>-<feature>`, which Penguin opens from main as the fork that part's fix is written
//    into. Once every live part on main is written, Penguin lands that feature itself (penguin-land.ts).
//    When its block reaches main, the plan is `landed` (`migrationBlockLanded`).
// 7. **Contract after the originating feature landed.** A landed fork is read-only, so when no caller
//    of a retiring symbol is left and its originating feature no longer runs, `carryContract` opens a
//    short-lived feature from main for the DRI of each scope that defines the symbols,
//    `contract-<owner>-<feature>`. It signs the contract proposal there: its plan has no places, so
//    Penguin approves it. The removal becomes a `contract` edit task for that DRI's steward. Once that
//    task is done, Penguin lands the carrier itself (penguin-land.ts). When the carrying feature's
//    block reaches main, retiring-count.ts `closeRemoved` closes the symbols.
//
// Features Penguin opens go through the overlap lock like any other feature (overlap-lock.ts): while
// a lock holds a block or carrier's start, no edit task into its fork is claimed and the runner
// writes nothing there. They have no builder in routing: their edits go to the steward of the
// scope's DRI. Every value reaches SQL as a bound parameter. Nothing here runs code.

import {
  contractCarrierId,
  contractPath,
  migrationBlockId,
  migrationGroups,
  migrationPlaceKey,
  migrationPlanId,
  migrationWriter,
  parsePatch,
  partRouting,
  retiringUses,
  reviewExceptions,
  ruleWrittenRouting,
  isMigrationPlanId,
  type EditRoutingContext,
  type ImpactReport,
  type ImpactUse,
  type InvariantView,
  type MigrationGroup,
  type MigrationPartState,
  type MigrationPartView,
  type MigrationPlanState,
  type MigrationPlanView,
  type MigrationRewritePlace,
  type MigrationWriter,
  type PartRoutingReason,
  type PartTrialTarget,
  type PlanPart,
  type PlanPlace,
  type RetiringDeclaration,
  type RetiringSymbol,
} from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import { retiringInput, type AgentToolRun, type AgentToolStore } from "./agent-tools.ts";
import type { EditSource, EditTask, EditTaskStore } from "./edit-tasks.ts";
import type { Feature, FeatureArea, FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { ApprovedWrite, FixGrantStore, FixRejection, MigrationWrites } from "./fix-write.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import { protectedLookup } from "./part-checks.ts";
import { trialEvidence, type PartTrialStore, type StoredPartTrial } from "./part-trial.ts";
import { CALLERS_SEARCH, PENGUIN_SESSION, REWRITE_SEARCH } from "./retiring-count.ts";
import type { RetiringStore } from "./retiring-store.ts";
import type { ReviewStore } from "./review-submit.ts";

export const MIGRATION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS MigrationPlan (
    plan_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, owner TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL,
    block TEXT NOT NULL, promotion TEXT NOT NULL, record_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (feature_id, owner, seq))`,
  `CREATE INDEX IF NOT EXISTS MigrationPlan_block ON MigrationPlan (block)`,
  `CREATE TABLE IF NOT EXISTS MigrationPart (
    part_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, place_key TEXT NOT NULL, place TEXT NOT NULL, scopes TEXT NOT NULL,
    uses INTEGER NOT NULL, files TEXT NOT NULL, contracts TEXT NOT NULL, rules TEXT NOT NULL, writer TEXT, reason TEXT,
    state TEXT NOT NULL, patch TEXT, target_sha TEXT, rewrite_run INTEGER, approved_by TEXT, updated_at INTEGER NOT NULL,
    UNIQUE (plan_id, place_key))`,
  `CREATE INDEX IF NOT EXISTS MigrationPart_plan ON MigrationPart (plan_id)`,
  // Features Penguin opened from main: a migration plan's block, or the carrier of a contract step.
  `CREATE TABLE IF NOT EXISTS PenguinFeature (
    feature_id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, person TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

/** One part as the store keeps it. */
export interface MigrationPart extends MigrationPartView {
  readonly planId: string;
  /** The runner's patch for a part it writes, against `targetSha`; null otherwise. */
  readonly patch: string | null;
  readonly targetSha: string | null;
  /** The rewrite request the part waits on, or null. */
  readonly rewriteRun: number | null;
}

type Row = Record<string, SqlValue>;
const json = <T>(value: SqlValue): T => JSON.parse(String(value)) as T;
const nullable = (value: SqlValue | undefined): string | null => (value === null || value === undefined ? null : String(value));

function partOf(row: Row): MigrationPart {
  return {
    partId: String(row["part_id"]),
    planId: String(row["plan_id"]),
    place: json<PlanPlace>(row["place"]),
    scopes: json<string[]>(row["scopes"]),
    uses: Number(row["uses"]),
    files: json<string[]>(row["files"]),
    contracts: json<string[]>(row["contracts"]),
    rules: json<string[]>(row["rules"]),
    writer: nullable(row["writer"]) as MigrationWriter | null,
    reason: nullable(row["reason"]),
    state: String(row["state"]) as MigrationPartState,
    approvedBy: nullable(row["approved_by"]),
    patch: nullable(row["patch"]),
    targetSha: nullable(row["target_sha"]),
    rewriteRun: row["rewrite_run"] === null || row["rewrite_run"] === undefined ? null : Number(row["rewrite_run"]),
  };
}

/** The states in which a part still waits on something before its plan can land. */
const LIVE: readonly MigrationPartState[] = ["rewriting", "task", "trial", "approved", "written", "in_person"];

export class MigrationStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of MIGRATION_SCHEMA) db.exec(statement);
  }

  /** Every plan of an originating feature, or of every feature, with its parts, oldest first. */
  plans(featureId?: string): MigrationPlanView[] {
    const rows =
      featureId === undefined
        ? this.#db.exec(`SELECT * FROM MigrationPlan ORDER BY feature_id, owner, seq`)
        : this.#db.exec(`SELECT * FROM MigrationPlan WHERE feature_id = ? ORDER BY owner, seq`, featureId);
    return rows.map((row) => this.#planOf(row));
  }

  plan(planId: string): MigrationPlanView | undefined {
    const [row] = this.#db.exec(`SELECT * FROM MigrationPlan WHERE plan_id = ?`, planId);
    return row === undefined ? undefined : this.#planOf(row);
  }

  /** The plan whose block is `featureId`, or undefined. */
  planOfBlock(featureId: string): MigrationPlanView | undefined {
    const [row] = this.#db.exec(`SELECT * FROM MigrationPlan WHERE block = ?`, featureId);
    return row === undefined ? undefined : this.#planOf(row);
  }

  /** The owner's newest plan of `featureId` that has neither landed nor closed, or undefined. */
  openPlan(featureId: string, owner: string): MigrationPlanView | undefined {
    const [row] = this.#db.exec(
      `SELECT * FROM MigrationPlan WHERE feature_id = ? AND owner = ? AND state NOT IN ('landed', 'closed') ORDER BY seq DESC LIMIT 1`,
      featureId,
      owner,
    );
    return row === undefined ? undefined : this.#planOf(row);
  }

  /** The owner's highest plan number for `featureId`, 0 before the first. */
  lastSeq(featureId: string, owner: string): number {
    const [row] = this.#db.exec(`SELECT COALESCE(MAX(seq), 0) AS seq FROM MigrationPlan WHERE feature_id = ? AND owner = ?`, featureId, owner);
    return Number(row?.["seq"] ?? 0);
  }

  createPlan(plan: { planId: string; feature: string; owner: string; seq: number; block: string; promotion: string; recordId: string }): void {
    const now = this.#now();
    this.#db.exec(
      `INSERT INTO MigrationPlan (plan_id, feature_id, owner, seq, state, block, promotion, record_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      plan.planId,
      plan.feature,
      plan.owner,
      plan.seq,
      plan.block,
      plan.promotion,
      plan.recordId,
      now,
      now,
    );
  }

  setPlan(planId: string, state: MigrationPlanState, promotion?: string, recordId?: string): void {
    this.#db.exec(
      `UPDATE MigrationPlan SET state = ?, promotion = COALESCE(?, promotion), record_id = COALESCE(?, record_id), updated_at = ? WHERE plan_id = ?`,
      state,
      promotion ?? null,
      recordId ?? null,
      this.#now(),
      planId,
    );
  }

  addPart(planId: string, part: Pick<MigrationPart, "place" | "scopes" | "uses" | "files" | "contracts" | "rules" | "state">): MigrationPart {
    const [count] = this.#db.exec(`SELECT COUNT(*) AS n FROM MigrationPart WHERE plan_id = ?`, planId);
    const partId = `${planId}#${Number(count?.["n"] ?? 0) + 1}`;
    this.#db.exec(
      `INSERT INTO MigrationPart (part_id, plan_id, place_key, place, scopes, uses, files, contracts, rules, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      partId,
      planId,
      migrationPlaceKey(part.place),
      JSON.stringify(part.place),
      JSON.stringify(part.scopes),
      part.uses,
      JSON.stringify(part.files),
      JSON.stringify(part.contracts),
      JSON.stringify(part.rules),
      part.state,
      this.#now(),
    );
    return this.part(partId) as MigrationPart;
  }

  part(partId: string): MigrationPart | undefined {
    const [row] = this.#db.exec(`SELECT * FROM MigrationPart WHERE part_id = ?`, partId);
    return row === undefined ? undefined : partOf(row);
  }

  /** Updates a part's fields; absent fields keep their value. */
  updatePart(
    partId: string,
    fields: Partial<Pick<MigrationPart, "uses" | "files" | "scopes" | "writer" | "reason" | "state" | "patch" | "targetSha" | "rewriteRun" | "approvedBy">>,
  ): void {
    const current = this.part(partId);
    if (current === undefined) return;
    const next = { ...current, ...fields };
    this.#db.exec(
      `UPDATE MigrationPart SET uses = ?, files = ?, scopes = ?, writer = ?, reason = ?, state = ?, patch = ?, target_sha = ?,
         rewrite_run = ?, approved_by = ?, updated_at = ? WHERE part_id = ?`,
      next.uses,
      JSON.stringify(next.files),
      JSON.stringify(next.scopes),
      next.writer,
      next.reason,
      next.state,
      next.patch,
      next.targetSha,
      next.rewriteRun,
      next.approvedBy,
      this.#now(),
      partId,
    );
  }

  /** Every part in `state`, oldest first. */
  partsIn(state: MigrationPartState): MigrationPart[] {
    return this.#db.exec(`SELECT * FROM MigrationPart WHERE state = ? ORDER BY rowid`, state).map(partOf);
  }

  /** The parts waiting on rewrite request `runId`. */
  waitingOn(runId: number): MigrationPart[] {
    return this.#db.exec(`SELECT * FROM MigrationPart WHERE rewrite_run = ? AND state = 'rewriting' ORDER BY part_id`, runId).map(partOf);
  }

  rememberFeature(featureId: string, kind: "block" | "contract", origin: string, person: string): void {
    this.#db.exec(
      `INSERT OR IGNORE INTO PenguinFeature (feature_id, kind, origin, person, created_at) VALUES (?, ?, ?, ?, ?)`,
      featureId,
      kind,
      origin,
      person,
      this.#now(),
    );
  }

  /** Every feature Penguin opened from main, oldest first: a plan's block or a contract carrier. */
  penguinFeatures(): { readonly featureId: string; readonly kind: "block" | "contract"; readonly origin: string; readonly person: string }[] {
    return this.#db.exec(`SELECT * FROM PenguinFeature ORDER BY created_at, feature_id`).map((row) => ({
      featureId: String(row["feature_id"]),
      kind: String(row["kind"]) as "block" | "contract",
      origin: String(row["origin"]),
      person: String(row["person"]),
    }));
  }

  /** Whether Penguin opened `featureId` from main. */
  openedByPenguin(featureId: string): boolean {
    return this.#db.exec(`SELECT 1 AS one FROM PenguinFeature WHERE feature_id = ?`, featureId).length > 0;
  }

  #planOf(row: Row): MigrationPlanView {
    const planId = String(row["plan_id"]);
    return {
      planId,
      feature: String(row["feature_id"]),
      owner: String(row["owner"]),
      seq: Number(row["seq"]),
      state: String(row["state"]) as MigrationPlanState,
      block: String(row["block"]),
      promotion: String(row["promotion"]),
      recordId: String(row["record_id"]),
      parts: this.#db.exec(`SELECT * FROM MigrationPart WHERE plan_id = ? ORDER BY rowid`, planId).map((part) => view(partOf(part))),
    };
  }
}

/** A part as views list it, without the runner's patch. */
function view(part: MigrationPart): MigrationPartView {
  const { partId, place, scopes, uses, files, contracts, rules, writer, reason, state, approvedBy } = part;
  return { partId, place, scopes, uses, files, contracts, rules, writer, reason, state, approvedBy };
}

export interface MigrationDeps {
  readonly store: MigrationStore;
  readonly features: FeatureStore;
  readonly runs: AgentToolStore;
  readonly retiring: RetiringStore;
  readonly trials: PartTrialStore;
  readonly reviews: ReviewStore;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** Opens one edit task (edit-work.ts `openEditTask`) with the routing narrowed by `adjust`. */
  readonly openTask: (source: EditSource, adjust: (routing: EditRoutingContext) => EditRoutingContext) => Promise<readonly EditTask[]>;
  /** The edit tasks, read to see whether a migration part's task was done or failed. */
  readonly tasks: Pick<EditTaskStore, "forSource">;
  /** The writes the check runner makes (fix-write.ts): an approved part's patch into its target fork. */
  readonly grants: Pick<FixGrantStore, "open">;
  /** The project's invariants on main, every scope's: which ones are protected. */
  readonly invariants: () => Promise<readonly InvariantView[]>;
  /** The overlap lock's check of a feature Penguin opened or widened (overlap-lock.ts `checkOverlap`). */
  readonly checkOverlap: (feature: Feature) => Promise<unknown>;
  /** The project requires a person for every part (PENGUIN_PLAN_ADMIN_MODE). */
  readonly adminMode: boolean;
  /** Forks main into the feature's repo and answers its name, or null when no fork can be made here. */
  readonly fork?: (featureId: string) => Promise<string | null>;
  readonly notify?: (person: string) => void;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const short = (sha: string): string => sha.slice(0, 12);
const placeWords = (place: PlanPlace): string => (place.kind === "scope" ? `scope ${place.scope} on main` : `feature ${place.feature}'s own changes`);

/** Routing that leaves out the builder of each feature Penguin opened, so its edits reach a steward. */
export function stewardsFor(store: MigrationStore): (routing: EditRoutingContext) => EditRoutingContext {
  return (routing) => ({ ...routing, builderOf: (featureId) => (store.openedByPenguin(featureId) ? undefined : routing.builderOf(featureId)) });
}

/** One place's facts at a count: the uses there, their files, scopes and contracts. */
interface PlaceFacts {
  readonly place: PlanPlace;
  readonly uses: readonly ImpactUse[];
}

function placeFields(facts: PlaceFacts, declarations: readonly RetiringDeclaration[], scopeMap: ScopeMap) {
  const found = retiringUses(facts.uses, declarations);
  const contracts = [...new Set(found.map(({ declaration }) => declaration.contract))].sort();
  const rules = [...new Set(found.flatMap(({ declaration }) => declaration.rules.map((rule) => rule.id)))].sort();
  const files = [...new Set(facts.uses.map((use) => use.path))].sort();
  const scopes =
    facts.place.kind === "scope"
      ? [facts.place.scope]
      : [...new Set(facts.uses.map((use) => use.scope ?? scopeForPath(scopeMap, use.path)).filter((scope): scope is string => scope !== null && scope !== undefined))].sort();
  return { contracts, rules, files, scopes, uses: facts.uses.length };
}

/**
 * Penguin's count after a promotion reported (retiring-count.ts): each owner group of each
 * originating feature's remaining callers becomes, or joins, a migration plan. Only a complete count
 * proposes; a place with no caller left is dropped. Answers the plans changed.
 */
export async function migrationsCounted(deps: MigrationDeps, run: AgentToolRun): Promise<string[]> {
  if (run.tool !== "impact" || run.input["search"] !== CALLERS_SEARCH || run.outcome?.result !== "found") return [];
  const impact = run.outcome.impact;
  if (impact === null || !impact.complete || impact.truncated || impact.errors.length > 0 || impact.forks.some((fork) => fork.errors.length > 0)) return [];
  const promotion = String(run.input["promotion"] ?? run.checkpointSha);
  return syncMigrations(deps, impact, { promotion, countRun: run.id, featureId: run.featureId as string, baseSha: run.baseSha as string, complete: true });
}

/**
 * A checkpoint's retiring-calls check reported (agent-tools.ts `requestRetiringCheck`): a caller its
 * own changes add joins its person's migration plan, or opens their next one. Nothing is dropped.
 */
export async function migrationsChecked(deps: MigrationDeps, run: AgentToolRun): Promise<string[]> {
  if (run.tool !== "impact" || run.input["search"] !== "own" || run.outcome?.result !== "found") return [];
  const impact = run.outcome.impact;
  const own = impact?.forks.find((fork) => fork.id === run.featureId);
  if (impact == null || own === undefined || own.errors.length > 0) return [];
  // Only the checkpoint's own changes count here; its head uses are main's, which a count after a promotion sees.
  const narrowed: ImpactReport = { ...impact, headUses: [], forks: [own] };
  return syncMigrations(deps, narrowed, { promotion: run.baseSha as string, countRun: run.id, featureId: run.featureId as string, baseSha: run.baseSha as string, complete: false });
}

interface SyncContext {
  readonly promotion: string;
  readonly countRun: number;
  /** The feature whose fork holds `baseSha`, under which the rewrite request is recorded. */
  readonly featureId: string;
  readonly baseSha: string;
  /** Whether the report saw every caller, so a place with none left can be dropped. */
  readonly complete: boolean;
}

async function syncMigrations(deps: MigrationDeps, impact: ImpactReport, context: SyncContext): Promise<string[]> {
  const scopeMap = await deps.scopeMap();
  const declarations = deps.retiring.list();
  const changed: string[] = [];
  for (const origin of [...new Set(declarations.map((each) => each.feature))].sort()) {
    // A plan carries only its originating feature's own declarations and rules.
    const own = declarations.filter((each) => each.feature === origin);
    const { groups } = migrationGroups(
      impact,
      own,
      (scope) => scopeMap.scopes.get(scope)?.driId,
      (feature) => deps.features.get(feature)?.personId,
    );
    const rewriting: { part: MigrationPart; target: string; paths: readonly string[] }[] = [];
    for (const group of groups) {
      const planId = await syncGroup(deps, origin, group, own, scopeMap, context, rewriting);
      if (planId !== null) changed.push(planId);
    }
    if (context.complete) changed.push(...(await dropGone(deps, origin, groups, context)));
    if (rewriting.length > 0) askRewrite(deps, origin, own, rewriting, context);
  }
  return [...new Set(changed)];
}

/** Brings one owner group into its plan; answers the plan id when the plan was made or gained parts. */
async function syncGroup(
  deps: MigrationDeps,
  origin: string,
  group: MigrationGroup,
  declarations: readonly RetiringDeclaration[],
  scopeMap: ScopeMap,
  context: SyncContext,
  rewriting: { part: MigrationPart; target: string; paths: readonly string[] }[],
): Promise<string | null> {
  let plan = deps.store.openPlan(origin, group.owner);
  const known = new Map((plan?.parts ?? []).map((part) => [migrationPlaceKey(part.place), part]));
  const fresh = group.places.filter((each) => {
    const part = known.get(migrationPlaceKey(each.place));
    return part === undefined || part.state === "dropped";
  });
  // A known place keeps its part; its uses follow the count.
  for (const each of group.places) {
    const part = known.get(migrationPlaceKey(each.place));
    if (part !== undefined && part.state !== "dropped") {
      const fields = placeFields(each, declarations, scopeMap);
      deps.store.updatePart(part.partId, { uses: fields.uses, files: fields.files, scopes: fields.scopes });
    }
  }
  if (fresh.length === 0) return null;
  const places = fresh.map((each) => ({ each, fields: placeFields(each, declarations, scopeMap) }));
  const listed = places.map(({ each, fields }) => ({ place: each.place, uses: fields.uses, contracts: fields.contracts, rules: fields.rules }));
  if (plan === undefined) {
    const seq = deps.store.lastSeq(origin, group.owner) + 1;
    const planId = migrationPlanId(origin, group.owner, seq);
    const block = migrationBlockId(origin, group.owner, seq);
    const record = await deps.sign(
      deps.features.draftRecord(origin, "migration_proposed", { penguin: true }, {
        plan: planId,
        owner: group.owner,
        seq,
        block,
        promotion: context.promotion,
        count_run: context.countRun,
        rules: [...new Set(declarations.flatMap((each) => each.rules.map((rule) => rule.id)))].sort(),
        places: listed,
      }),
    );
    deps.features.addRecord(record);
    deps.store.createPlan({ planId, feature: origin, owner: group.owner, seq, block, promotion: context.promotion, recordId: record.record_id });
    plan = deps.store.plan(planId) as MigrationPlanView;
  } else {
    const record = await deps.sign(
      deps.features.draftRecord(origin, "migration_joined", { penguin: true }, { plan: plan.planId, promotion: context.promotion, count_run: context.countRun, places: listed }),
    );
    deps.features.addRecord(record);
    // A plan that gains a part waits for it again.
    deps.store.setPlan(plan.planId, "open", context.promotion, record.record_id);
  }
  for (const { each, fields } of places) {
    const dropped = known.get(migrationPlaceKey(each.place));
    const state: MigrationPartState = fields.rules.length > 0 ? "rewriting" : "task";
    let part: MigrationPart;
    if (dropped !== undefined) {
      deps.store.updatePart(dropped.partId, { ...fields, state, writer: null, reason: null, patch: null, targetSha: null, rewriteRun: null, approvedBy: null });
      part = deps.store.part(dropped.partId) as MigrationPart;
    } else {
      part = deps.store.addPart(plan.planId, { place: each.place, ...fields, state });
    }
    if (state === "rewriting") rewriting.push({ part, target: each.place.kind === "scope" ? "main" : each.place.feature, paths: fields.files });
    else await routeToTask(deps, plan, part, "no rewrite rule is declared for the contracts the place uses", context.promotion);
  }
  deps.notify?.(group.owner);
  return plan.planId;
}

/** At a complete count, each live part whose place has no caller left is dropped. */
async function dropGone(deps: MigrationDeps, origin: string, groups: readonly MigrationGroup[], context: SyncContext): Promise<string[]> {
  const present = new Set(groups.flatMap((group) => group.places.map((each) => `${group.owner}\0${migrationPlaceKey(each.place)}`)));
  const changed: string[] = [];
  for (const plan of deps.store.plans(origin)) {
    if (plan.state === "landed" || plan.state === "closed") continue;
    for (const part of plan.parts) {
      if (part.state === "dropped" || part.state === "landed" || present.has(`${plan.owner}\0${migrationPlaceKey(part.place)}`)) continue;
      deps.store.updatePart(part.partId, { state: "dropped", uses: 0, reason: `no caller is left in ${placeWords(part.place)} at promotion ${short(context.promotion)}` });
      changed.push(plan.planId);
    }
    await settlePlan(deps, plan.planId);
  }
  return changed;
}

/** One rewrite request of Penguin's own for the places of `origin` whose contracts have rules. */
function askRewrite(
  deps: MigrationDeps,
  origin: string,
  declarations: readonly RetiringDeclaration[],
  rewriting: readonly { part: MigrationPart; target: string; paths: readonly string[] }[],
  context: SyncContext,
): void {
  const run = deps.runs.insert({
    featureId: context.featureId,
    sessionId: PENGUIN_SESSION,
    caller: "penguin",
    tool: "impact",
    input: {
      feature: context.featureId,
      search: REWRITE_SEARCH,
      origin,
      promotion: context.promotion,
      retiring: declarations.map(retiringInput),
      places: rewriting.map(({ part, target, paths }) => ({ place: part.place, target, paths: [...paths] })),
    },
    result: "waiting",
    summary: `Penguin's rewrite of ${plural(rewriting.length, "migration place")} of feature ${origin} by its declared rules waits for the check runner`,
    checkpointSha: context.baseSha,
    durationMs: 0,
    baseSha: context.baseSha,
  });
  for (const { part } of rewriting) deps.store.updatePart(part.partId, { rewriteRun: run.id });
}

/**
 * The runner reported a rewrite request: each part it waited on is the runner's when the rules wrote
 * it whole, and its trial is asked for; any other becomes an edit task. One signed `migration_routed`
 * record per plan. Answers the plans changed.
 */
export async function rewritesReported(deps: MigrationDeps, run: AgentToolRun): Promise<string[]> {
  if (run.tool !== "impact" || run.input["search"] !== REWRITE_SEARCH || run.outcome === null) return [];
  const waiting = deps.store.waitingOn(run.id);
  if (waiting.length === 0) return [];
  const rewrites = new Map((run.outcome.rewrites ?? []).map((each) => [migrationPlaceKey(each.place), each]));
  const byPlan = new Map<string, { part: MigrationPart; writer: MigrationWriter; reason: string; rewrite: MigrationRewritePlace | undefined }[]>();
  for (const part of waiting) {
    const rewrite = run.outcome.result === "found" ? rewrites.get(migrationPlaceKey(part.place)) : undefined;
    const { writer, reason } = migrationWriter(part.rules, rewrite);
    byPlan.set(part.planId, [...(byPlan.get(part.planId) ?? []), { part, writer, reason, rewrite }]);
  }
  for (const [planId, parts] of byPlan) {
    const plan = deps.store.plan(planId);
    if (plan === undefined) continue;
    const record = await deps.sign(
      deps.features.draftRecord(plan.feature, "migration_routed", { penguin: true }, {
        plan: planId,
        rewrite_run: run.id,
        parts: parts.map(({ part, writer, reason }) => ({ part: part.partId, place: part.place, writer, reason })),
      }),
    );
    deps.features.addRecord(record);
    for (const { part, writer, reason, rewrite } of parts) {
      if (writer === "task" || rewrite === undefined || rewrite.patch === null) {
        await routeToTask(deps, plan, part, reason, plan.promotion);
        continue;
      }
      deps.store.updatePart(part.partId, { writer, reason, state: "trial", patch: rewrite.patch, targetSha: rewrite.sha });
      queueMigrationTrial(deps, plan, deps.store.part(part.partId) as MigrationPart);
    }
    deps.notify?.(plan.owner);
  }
  return [...byPlan.keys()];
}

/**
 * Opens a feature from main for Penguin's own work and records its fork; an existing feature keeps its
 * fork and gains the scopes of `area` it lacks. Its opening is a signed `open_feature` record authored
 * by Penguin, a wider area a signed `declare_area` one. Either goes through the overlap lock, as any
 * feature's opening and declaration do (PRD 0.5 section 4.2 step 2).
 */
async function openPenguinFeature(
  deps: MigrationDeps,
  featureId: string,
  kind: "block" | "contract",
  origin: string,
  person: string,
  area: FeatureArea,
  reason: string,
): Promise<Feature | undefined> {
  deps.store.rememberFeature(featureId, kind, origin, person);
  const existing = deps.features.get(featureId);
  if (existing !== undefined) {
    const missing = area.scopes.filter((scope) => !existing.area.scopes.includes(scope));
    if (missing.length === 0 || existing.state === "landed") return existing;
    const wider: FeatureArea = { ...existing.area, scopes: [...existing.area.scopes, ...missing].sort() };
    const record = await deps.sign(deps.features.draftRecord(featureId, "declare_area", { penguin: true }, { area: { ...wider } }));
    const widened = deps.features.setArea(featureId, wider, record, null);
    if (widened !== undefined) await deps.checkOverlap(widened);
    return widened;
  }
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "open_feature", { penguin: true }, { person, area: { ...area }, opened_by: "penguin", origin, reason }),
  );
  if (!deps.features.insert(featureId, person, area, record)) return deps.features.get(featureId);
  const repo = (await deps.fork?.(featureId)) ?? null;
  if (repo !== null) deps.features.setRepo(featureId, repo);
  const opened = deps.features.get(featureId);
  if (opened !== undefined) await deps.checkOverlap(opened);
  deps.notify?.(person);
  return deps.features.get(featureId);
}

/** The fork a part's fix goes into: its running feature's, or the plan's block feature for code on main. */
async function writeTarget(deps: MigrationDeps, plan: MigrationPlanView, part: MigrationPart): Promise<Feature | undefined> {
  if (part.place.kind === "feature") {
    const feature = deps.features.get(part.place.feature);
    return feature !== undefined && RUNNING_STATES.has(feature.state) ? feature : undefined;
  }
  // Code on main is written in the plan's own block feature, which Penguin opens from main.
  return openPenguinFeature(
    deps,
    plan.block,
    "block",
    plan.feature,
    plan.owner,
    { scopes: [part.place.scope], paths: [], contracts: [] },
    `the block of migration plan ${plan.planId}`,
  );
}

/**
 * A part an agent writes: an edit task for the place's builder or the steward of its scope's DRI.
 * `failing` lists the failing checks of a rule-written part's trial, attached to the task.
 */
async function routeToTask(
  deps: MigrationDeps,
  plan: MigrationPlanView,
  part: MigrationPart,
  reason: string,
  promotion: string,
  failing: readonly string[] = [],
): Promise<void> {
  const target = await writeTarget(deps, plan, part);
  if (target === undefined) {
    if (part.place.kind === "feature") deps.store.updatePart(part.partId, { writer: "task", reason: `feature ${part.place.feature} no longer runs`, state: "dropped" });
    return;
  }
  const targetPerson = part.place.kind === "feature" ? target.personId : plan.owner;
  const scope = part.place.kind === "scope" ? part.place.scope : null;
  const source: EditSource = {
    key: `migrate:${part.partId}`,
    kind: "migration",
    feature: plan.feature,
    target: target.id,
    targetPerson,
    places: part.files.map((path) => (scope === null ? { path } : { path, scope })),
    instructions:
      `Move ${placeWords(part.place)} off feature ${plan.feature}'s retiring symbols ${part.contracts.join(", ")}: ` +
      `${plural(part.uses, "use")} in ${part.files.join(", ")} as counted after promotion ${short(promotion)}. ` +
      `Call each replacement get_work lists under the split's retiring symbols, keep the behaviour, and report the change as a checkpoint. ${reason}.`,
    verifier: "Penguin's retiring-calls check finds no use of a retiring symbol in these files, and the part's trial runs the scope's tests on the merged tree.",
    evidence: [...failing, ...part.files],
    ref: { plan: plan.planId, part: part.partId },
  };
  deps.store.updatePart(part.partId, { writer: "task", reason, state: "task" });
  await deps.openTask(source, stewardsFor(deps.store));
}

/**
 * The trial of a runner-written part: its patch applied to its place's target, merged with main at the
 * count. It carries no form: a rule-written part needs none, so each of its scopes gets the
 * side-by-side run alone in the same trial.
 */
function queueMigrationTrial(deps: MigrationDeps, plan: MigrationPlanView, part: MigrationPart, on?: PartTrialTarget): StoredPartTrial | undefined {
  if (part.patch === null || part.targetSha === null) return undefined;
  const target =
    on ??
    (part.place.kind === "scope" ? { id: "main", repo: "base", sha: part.targetSha } : { id: part.place.feature, repo: `feature-${part.place.feature}`, sha: part.targetSha });
  const scopes = [...part.scopes].sort();
  return deps.trials.queue(
    {
      feature: plan.block,
      planId: plan.planId,
      partId: part.partId,
      revision: 1,
      fork: "base",
      checkpoint: plan.promotion,
      target,
      fix: { kind: "patch", patch: part.patch },
      commandIds: scopes.map((scope) => `test:${scope}`),
      reviews: [],
      sideBySide: scopes,
    },
    part.scopes,
  );
}

/** One routing reason in words, for a part's record and its reason. */
function reasonWords(reason: PartRoutingReason): string {
  switch (reason.kind) {
    case "admin_mode":
      return "the project asks a person for every part";
    case "reversed":
      return `${reason.by} reversed Penguin's approval`;
    case "tests":
      return reason.status === "fix_not_run" ? "the trial tree does not hold the fix" : `test:${reason.scope} ${reason.status} on the trial tree`;
    case "review":
      return `the review form of ${reason.scope} is ${reason.state}`;
    case "broken_invariant":
      return `the form of ${reason.scope} reports ${reason.invariant} broken`;
    case "protected_difference":
      return `${reason.differing} inputs of ${reason.contract} differ on protected ${reason.invariant}`;
    case "protected_path":
      return `${reason.file} lies under ${reason.owner}'s protected ${reason.path}`;
    case "outside_place":
      return `${reason.file ?? "a file"} lies outside the part's scopes`;
    case "stored_data_unmarked":
      return `${reason.scope} reads ${reason.symbol} reshaped with no backfill`;
  }
}

/**
 * The protected invariants the trial's formless side-by-side runs show differing, as routing reasons.
 * The project's invariants say which are protected. `reviewId` is 0: no form is involved.
 */
function protectedDifferences(trial: StoredPartTrial, invariants: readonly InvariantView[]): PartRoutingReason[] {
  return (trial.report?.sideBySide ?? []).flatMap((run) =>
    reviewExceptions(
      null,
      invariants.filter((invariant) => invariant.scopeId === run.scope),
      run.record,
    ).flatMap((exception): PartRoutingReason[] =>
      exception.kind === "protected_difference"
        ? [{ kind: "protected_difference", scope: exception.scope, invariant: exception.invariant, contract: exception.contract, differing: exception.differing, reviewId: 0 }]
        : [],
    ),
  );
}

/** The failing checks of a trial as evidence lines: each reason, each failing test and each differing input. */
function failingChecks(trial: StoredPartTrial, reasons: readonly PartRoutingReason[]): string[] {
  const lines = reasons.map(reasonWords);
  for (const test of trial.report?.tests ?? []) {
    if (test.status === "passed") continue;
    lines.push(...(test.breaks.length > 0 ? test.breaks.map((name) => `${test.commandId} fails ${name}`) : [`${test.commandId} ${test.status}: ${test.reason ?? "no test named"}`]));
  }
  const protectedOnes = new Set(reasons.flatMap((reason) => (reason.kind === "protected_difference" ? [`${reason.scope}\0${reason.contract}`] : [])));
  for (const run of trial.report?.sideBySide ?? []) {
    for (const set of run.record.sets) {
      if (!protectedOnes.has(`${run.scope}\0${set.contract}`)) continue;
      for (const difference of set.differing.slice(0, 5)) {
        lines.push(`${set.contract} ${difference.name}: main ${JSON.stringify(difference.main)}, patched ${JSON.stringify(difference.fork)}`);
      }
    }
  }
  return lines;
}

/**
 * A part trial reported (part-trial.ts): the checks of PRD 4.3 on a rule-written migration part's
 * trial, read by `ruleWrittenRouting` (PRD 0.5 section 4.2 step 2). The part needs no review form.
 * Penguin approves it when its tests pass and no protected invariant differs, and asks the check
 * runner to write it into its target fork. A failing trial makes it an edit task for the target's
 * builder or steward with the failing checks attached. A check no edit settles sends it to its owner
 * in person. Answers the part's new state, or undefined for a trial of another kind of plan.
 */
export async function migrationTrialReported(deps: MigrationDeps, trial: StoredPartTrial): Promise<MigrationPartState | undefined> {
  if (!isMigrationPlanId(trial.planId)) return undefined;
  const plan = deps.store.plan(trial.planId);
  const part = deps.store.part(trial.partId);
  if (plan === undefined || part === undefined || part.state !== "trial") return undefined;
  const evidence = trialEvidence(deps.trials, deps.reviews, plan.block, { partId: part.partId, revision: 1 });
  if (evidence === undefined || evidence.trialId !== trial.id) return undefined;
  const scopeMap = await deps.scopeMap();
  const parsed = part.patch === null ? null : parsePatch(part.patch);
  const files = parsed?.ok === true ? parsed.files.map((file) => ({ ...file, scopeId: scopeForPath(scopeMap, file.path) ?? null })) : [];
  const repo = part.place.kind === "scope" ? "base" : `feature-${part.place.feature}`;
  const diff: PlanPart["diff"] = { source: "patch", repo, ref: `${repo}@${part.targetSha}+migration`, commit: null, base: part.targetSha, patch: part.patch, files, truncated: false, outside: [] };
  const routing = partRouting(
    { scopes: part.scopes, diff, breaks: [], tests: evidence.tests, revision: 1, reversal: null },
    { reviews: [], checkpoint: plan.promotion, adminMode: deps.adminMode },
    protectedLookup(scopeMap),
  );
  const decided = ruleWrittenRouting([...routing.reasons, ...protectedDifferences(trial, await deps.invariants())]);
  const words = decided.reasons.map(reasonWords);
  const state: MigrationPartState = decided.route === "approve" ? "approved" : decided.route === "task" ? "task" : "in_person";
  const reason = words.length === 0 ? "the trial's tests pass and no protected invariant differs; a rule-written part needs no review form" : words.join("; ");
  const record = await deps.sign(
    deps.features.draftRecord(plan.feature, "migration_part_decided", { penguin: true }, {
      plan: plan.planId,
      part: part.partId,
      trial: trial.id,
      decision: state,
      approved_by: state === "approved" ? "penguin" : null,
      reasons: words.slice(0, 20),
    }),
  );
  deps.features.addRecord(record);
  if (state === "approved") {
    deps.store.updatePart(part.partId, { state, reason, approvedBy: "penguin" });
    const target = await writeTarget(deps, plan, part);
    if (target !== undefined) deps.grants.open(plan.feature, plan.planId, { partId: part.partId, revision: 1 }, target.id, "runner");
  } else if (state === "task") {
    await routeToTask(deps, plan, part, `the rules' patch failed its trial: ${reason}`, plan.promotion, failingChecks(trial, decided.reasons));
  } else {
    deps.store.updatePart(part.partId, { state, reason, approvedBy: null });
  }
  await settlePlan(deps, plan.planId);
  deps.notify?.(plan.owner);
  return deps.store.part(part.partId)?.state;
}

/** Why an edit task's run counts as failed: it failed, timed out or stopped reporting. */
const FAILED_RUNS: ReadonlySet<string> = new Set(["run_failed", "run_timeout", "lease_expired"]);

/** A part's fix is in its target fork, under a signed `migration_part_written` record. */
async function markWritten(
  deps: MigrationDeps,
  plan: MigrationPlanView,
  part: MigrationPart,
  written: { readonly by: string; readonly commit: string | null; readonly task?: number; readonly fixWrite?: string },
): Promise<void> {
  const record = await deps.sign(
    deps.features.draftRecord(plan.feature, "migration_part_written", { penguin: true }, {
      plan: plan.planId,
      part: part.partId,
      place: part.place,
      written_by: written.by,
      commit: written.commit,
      task: written.task ?? null,
      fix_write: written.fixWrite ?? null,
    }),
  );
  deps.features.addRecord(record);
  deps.store.updatePart(part.partId, { state: "written" });
  await settlePlan(deps, plan.planId);
  deps.notify?.(plan.owner);
}

/**
 * The edit tasks of migration parts moved on (edit-work.ts): a task done with a kept commit writes its
 * part; a task whose run failed, timed out or stopped reporting sends its part to a person under a
 * signed `migration_part_decided` record. Answers the plans changed.
 */
export async function migrationTasksSettled(deps: MigrationDeps): Promise<string[]> {
  const changed = new Set<string>();
  for (const part of deps.store.partsIn("task")) {
    const tasks = deps.tasks.forSource(`migrate:${part.partId}`);
    const done = tasks.find((task) => task.state === "done");
    const failed = tasks.find((task) => task.state === "asked" && FAILED_RUNS.has(task.askReason ?? ""));
    const plan = deps.store.plan(part.planId);
    if (plan === undefined || (done === undefined && failed === undefined)) continue;
    changed.add(plan.planId);
    if (done !== undefined) {
      await markWritten(deps, plan, part, { by: done.handle ?? done.person, commit: done.commit, task: done.id });
      continue;
    }
    const task = failed as EditTask;
    const reason = `the edit task for ${task.handle ?? task.person} failed (${task.askReason}): ${task.outcome ?? "no outcome reported"}`;
    const record = await deps.sign(
      deps.features.draftRecord(plan.feature, "migration_part_decided", { penguin: true }, {
        plan: plan.planId,
        part: part.partId,
        task: task.id,
        decision: "in_person",
        approved_by: null,
        reasons: [reason],
      }),
    );
    deps.features.addRecord(record);
    deps.store.updatePart(part.partId, { state: "in_person", reason });
    await settlePlan(deps, plan.planId);
    deps.notify?.(plan.owner);
  }
  return [...changed];
}

const refused = (reason: FixRejection["reason"], message: string): FixRejection => ({ status: "rejected", reason, message });

/**
 * What the check runner's fix writes read and tell about approved migration parts (fix-write.ts): the
 * part's patch and its target fork, a target that moved past the patch, and a kept commit.
 */
export function migrationWrites(deps: MigrationDeps): MigrationWrites {
  return {
    approved: async (partId): Promise<ApprovedWrite | FixRejection> => {
      const part = deps.store.part(partId);
      const plan = part === undefined ? undefined : deps.store.plan(part.planId);
      if (part === undefined || plan === undefined) return refused("not_found", `no migration part ${partId}`);
      if (part.state !== "approved" || part.patch === null || part.targetSha === null) {
        return refused("not_approved", `migration part ${partId} is ${part.state.replaceAll("_", " ")}, not approved; nothing is written`);
      }
      const target = deps.features.get(part.place.kind === "feature" ? part.place.feature : plan.block);
      if (target?.repo == null) return refused("not_found", `feature ${target?.id ?? plan.block} has no fork`);
      if (target.state === "landed") return refused("conflict", `feature ${target.id} has landed; its fork is read-only`);
      const parsed = parsePatch(part.patch);
      if (!parsed.ok) return refused("invalid", `the rules' patch no longer parses: ${parsed.message}`);
      const scopeMap = await deps.scopeMap();
      const repo = part.place.kind === "scope" ? "base" : `feature-${part.place.feature}`;
      return {
        featureId: plan.feature,
        plan: { planId: plan.planId, proposedBy: "penguin", person: plan.owner },
        part: {
          partId,
          revision: 1,
          kind: "mechanical",
          scopes: part.scopes,
          approvedBy: "penguin",
          diff: { files: parsed.files.map((file) => ({ ...file, scopeId: scopeForPath(scopeMap, file.path) ?? null })), ref: `${repo}@${part.targetSha}+migration` },
        },
        patch: part.patch,
        base: part.targetSha,
        target: target as Feature & { readonly repo: string },
      };
    },
    headMoved: async (partId, head, problem) => {
      const part = deps.store.part(partId);
      const plan = part === undefined ? undefined : deps.store.plan(part.planId);
      if (part === undefined || plan === undefined || part.state !== "approved") return;
      const reason = `the rules' patch no longer applies at the target fork's head ${short(head)}: ${problem}`;
      await routeToTask(deps, plan, part, reason, plan.promotion, [reason]);
      await settlePlan(deps, plan.planId);
    },
    written: async (partId, commit, recordId) => {
      const part = deps.store.part(partId);
      const plan = part === undefined ? undefined : deps.store.plan(part.planId);
      if (part === undefined || plan === undefined || part.state !== "approved") return;
      await markWritten(deps, plan, part, { by: "penguin", commit, fixWrite: recordId });
    },
    // Another write moved the target fork: the part's trial runs again on that head before its write.
    retry: async (partId, head) => {
      const part = deps.store.part(partId);
      const plan = part === undefined ? undefined : deps.store.plan(part.planId);
      if (part === undefined || plan === undefined || part.state !== "approved") return null;
      const target = part.place.kind === "feature" ? part.place.feature : plan.block;
      return queueMigrationTrial(deps, plan, part, { id: target, repo: `feature-${target}`, sha: head })?.id ?? null;
    },
  };
}

/**
 * Settles a plan from its live parts: `approved` when every one is approved or written, `open` while
 * one waits. A plan with no code on main whose live parts are all written is `closed` under a signed
 * `migration_closed` record: every fix is in its running feature's fork, and nothing is promoted.
 */
async function settlePlan(deps: MigrationDeps, planId: string): Promise<void> {
  const plan = deps.store.plan(planId);
  if (plan === undefined || plan.state === "landed" || plan.state === "closed") return;
  const live = plan.parts.filter((part) => LIVE.includes(part.state));
  if (live.length > 0 && live.every((part) => part.state === "written") && live.every((part) => part.place.kind === "feature")) {
    const record = await deps.sign(
      deps.features.draftRecord(plan.feature, "migration_closed", { penguin: true }, {
        plan: plan.planId,
        parts: live.map((part) => ({ part: part.partId, place: part.place })),
        reason: "every place is a running feature and every part is written into its fork; there is nothing to promote",
      }),
    );
    deps.features.addRecord(record);
    deps.store.setPlan(planId, "closed", undefined, record.record_id);
    deps.notify?.(plan.owner);
    return;
  }
  const state: MigrationPlanState = live.length > 0 && live.every((part) => part.state === "approved" || part.state === "written") ? "approved" : "open";
  if (state !== plan.state) deps.store.setPlan(planId, state);
}

/**
 * A feature's block reached main: when it is a migration plan's block, the plan is landed under a
 * signed `migration_landed` record, so a caller found later opens the owner's next plan.
 */
export async function migrationBlockLanded(deps: MigrationDeps, featureId: string, promotion: string): Promise<string | undefined> {
  const plan = deps.store.planOfBlock(featureId);
  if (plan === undefined || plan.state === "landed") return undefined;
  const record = await deps.sign(
    deps.features.draftRecord(plan.feature, "migration_landed", { penguin: true }, {
      plan: plan.planId,
      block: featureId,
      promotion,
      parts: plan.parts.map((part) => ({ part: part.partId, state: part.state })),
    }),
  );
  deps.features.addRecord(record);
  for (const part of plan.parts) if (part.state === "approved" || part.state === "written") deps.store.updatePart(part.partId, { state: "landed" });
  deps.store.setPlan(plan.planId, "landed", promotion, record.record_id);
  deps.notify?.(plan.owner);
  return plan.planId;
}

/**
 * The contract step of symbols with no caller left whose originating feature `origin` no longer runs:
 * for the DRI of each scope that defines them, a short-lived feature from main carries the removal.
 * Its plan has no places, so Penguin approves it under a signed `contract_proposed` record there, and
 * the removal is a `contract` edit task for that DRI's steward. A symbol in no scope, or in a scope
 * with no owner, stays retiring.
 */
export async function carryContract(
  deps: MigrationDeps,
  origin: string,
  symbols: readonly RetiringSymbol[],
  count: { readonly promotion: string; readonly runId: number },
): Promise<{ feature: string; contracts: string[]; recordId: string }[]> {
  const scopeMap = await deps.scopeMap();
  const byOwner = new Map<string, { scopes: Set<string>; symbols: RetiringSymbol[] }>();
  for (const symbol of symbols) {
    const scope = scopeForPath(scopeMap, contractPath(symbol.contract));
    const owner = scope === undefined ? undefined : scopeMap.scopes.get(scope)?.driId;
    if (scope === undefined || owner === undefined) continue;
    const entry = byOwner.get(owner) ?? { scopes: new Set<string>(), symbols: [] };
    entry.scopes.add(scope);
    entry.symbols.push(symbol);
    byOwner.set(owner, entry);
  }
  const carried: { feature: string; contracts: string[]; recordId: string }[] = [];
  for (const [owner, { scopes, symbols: owned }] of [...byOwner].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const carrierId = contractCarrierId(origin, owner);
    const contracts = owned.map((each) => each.contract);
    const scopeList = [...scopes].sort();
    const carrier = await openPenguinFeature(
      deps,
      carrierId,
      "contract",
      origin,
      owner,
      { scopes: scopeList, paths: [], contracts },
      `the contract step of feature ${origin}, which no longer runs`,
    );
    if (carrier === undefined) continue;
    const record = await deps.sign(
      deps.features.draftRecord(carrierId, "contract_proposed", { penguin: true }, {
        origin,
        promotion: count.promotion,
        count_run: count.runId,
        symbols: owned.map(({ contract, replacement }) => ({ contract, replacement })),
        callers: 0,
        places: [],
        approved_by: "penguin",
        reason:
          `no caller is left on main or in any running feature's own changes and feature ${origin} no longer runs, so Penguin opened ${carrierId} from main ` +
          "to carry the removal; the plan has no places and no part needs a person",
      }),
    );
    deps.features.addRecord(record);
    deps.retiring.approveRemoval(origin, owned, record.record_id, count.runId, count.promotion, carrierId);
    const listed = contracts.join(", ");
    await deps.openTask(
      {
        key: `contract:${carrierId}`,
        kind: "contract",
        feature: origin,
        target: carrierId,
        targetPerson: owner,
        places: scopeList.map((scope) => ({ scope })),
        instructions:
          `Remove ${listed} from feature ${carrierId}'s fork: no caller is left on main or in any running feature's own changes (counted after promotion ${short(count.promotion)}), ` +
          `and feature ${origin}, which retired them, no longer runs. Commit the removal in one commit; Penguin approved it, and once Penguin keeps the commit it lands the block itself.`,
        verifier: "The removal's facts run shows each symbol removed; the block checks run every scope's tests on the merged trees before main moves.",
        evidence: owned.map(({ contract, replacement }) => `${contract}, replaced by ${replacement}`),
        ref: { origin, carrier: carrierId },
      },
      stewardsFor(deps.store),
    );
    carried.push({ feature: carrierId, contracts, recordId: record.record_id });
    deps.notify?.(owner);
  }
  return carried;
}
