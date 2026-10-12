// Features that meet an announced merge plan after it was announced (PRD 0.4 section 4.4 step 3 and
// section 4.6).
//
// A plan's area is where its change reaches: the scopes whose symbols the contract diff changes, the
// scopes of every part and the contracts it changes. A feature meets the plan where its declared area
// (its scopes, the scopes of its paths and of its contracts) shares a scope or a contract with it.
//
// - Late starters. A feature opened after a plan was announced receives at open every announced plan
//   its area meets (handOver). Its agent writes against the planned change from the start, so the plan
//   gains no part for it.
// - Midway. A running feature whose area meets an announced plan only later, through a checkpoint that
//   grows its area or a declaration followed by a checkpoint, is found at that checkpoint
//   (coverMidway). The plan gains a part for it, owned by the feature's person. The part starts with
//   Penguin's request to the originating agent for a fix against the feature's checkpoint, so it
//   follows the approval path every part follows: the originating agent answers with
//   `revise_plan_part`. The feature's person approves the revision. The fix is then written as any
//   other (fix-write.ts).
//
// PlanCoverage keeps, per announced plan, each feature it already accounts for: a feature with a part,
// a feature whose area met the plan when it was announced without being affected, a late starter it
// was handed to and a feature it gained a part for. A feature it accounts for is never added again.

import { PLAN_LIMITS, type Plan, type PlanPart } from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { Feature, FeatureArea, FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { PlanRouteStore } from "./plan-approval.ts";
import type { PlanKeeper } from "./plan-store.ts";

type Row = Record<string, SqlValue>;

export const PLAN_COVERAGE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS AnnouncedPlan (
    feature_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, person TEXT NOT NULL, subject TEXT NOT NULL,
    scopes TEXT NOT NULL, contracts TEXT NOT NULL, announced_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS PlanCoverage (
    plan_id TEXT NOT NULL, feature_id TEXT NOT NULL, how TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, feature_id))`,
];

/** How an announced plan accounts for a feature. */
export type CoverageKind = "part" | "met" | "handed_over" | "added";

/** The newest plan of a feature, with the area its change reaches. */
export interface AnnouncedPlan {
  readonly featureId: string;
  readonly planId: string;
  readonly person: string;
  /** The checkpoint commit's subject; text from the repo, kept as data. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly contracts: readonly string[];
  readonly announcedAt: string;
}

/** Where a feature's area meets a plan's. */
export interface PlanMeeting {
  readonly scopes: readonly string[];
  readonly contracts: readonly string[];
}

/** An announced plan as a late starter receives it at open. */
export interface HandedPlan extends AnnouncedPlan {
  readonly meets: PlanMeeting;
}

/** A part a plan gained for a running feature at that feature's checkpoint. */
export interface JoinedPlan {
  readonly planId: string;
  readonly partId: string;
  /** The originating feature. */
  readonly featureId: string;
  readonly meets: PlanMeeting;
}

function announced(row: Row): AnnouncedPlan {
  return {
    featureId: row["feature_id"] as string,
    planId: row["plan_id"] as string,
    person: row["person"] as string,
    subject: row["subject"] as string,
    scopes: JSON.parse(row["scopes"] as string) as string[],
    contracts: JSON.parse(row["contracts"] as string) as string[],
    announcedAt: new Date(Number(row["announced_at"])).toISOString(),
  };
}

/** The scope a contract `path::symbol` lives in. */
function contractScope(scopeMap: ScopeMap, contract: string): string | undefined {
  const path = contract.split("::", 1)[0] ?? "";
  try {
    return scopeForPath(scopeMap, path);
  } catch {
    return undefined;
  }
}

/** The plan's area: the changed scopes, every part's scopes and the changed contracts. */
export function planArea(plan: Plan, scopeMap: ScopeMap): { scopes: string[]; contracts: string[] } {
  const diff = plan.facts.contractDiff;
  const contracts = [...(diff?.contracts ?? [])];
  const scopes = new Set<string>(plan.parts.flatMap((part) => part.scopes));
  for (const change of diff?.changes ?? []) if (change.scope !== null) scopes.add(change.scope);
  for (const contract of contracts) {
    const scope = contractScope(scopeMap, contract);
    if (scope !== undefined) scopes.add(scope);
  }
  return { scopes: [...scopes].sort(), contracts: contracts.sort() };
}

/** Where `area` meets the plan area, or undefined when it does not. */
export function meeting(area: FeatureArea, plan: { readonly scopes: readonly string[]; readonly contracts: readonly string[] }, scopeMap: ScopeMap): PlanMeeting | undefined {
  const touched = new Set(area.scopes);
  for (const path of area.paths) {
    try {
      const scope = scopeForPath(scopeMap, path);
      if (scope !== undefined) touched.add(scope);
    } catch {
      // A path the scope map cannot place meets no scope.
    }
  }
  for (const contract of area.contracts) {
    const scope = contractScope(scopeMap, contract);
    if (scope !== undefined) touched.add(scope);
  }
  const scopes = plan.scopes.filter((scope) => touched.has(scope));
  const named = new Set(area.contracts);
  const contracts = plan.contracts.filter((contract) => named.has(contract));
  return scopes.length === 0 && contracts.length === 0 ? undefined : { scopes, contracts };
}

/** The announced plans and the features each accounts for, on the ProjectAgent. */
export class PlanCoverageStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PLAN_COVERAGE_SCHEMA) db.exec(statement);
  }

  /**
   * Records a newly kept plan as its feature's announced plan, with the features it accounts for: those
   * with a part and the other running features whose area meets it already.
   */
  announce(plan: Plan, running: readonly Feature[], scopeMap: ScopeMap): void {
    const area = planArea(plan, scopeMap);
    this.#db.transaction(() => {
      this.#db.exec(
        `INSERT INTO AnnouncedPlan (feature_id, plan_id, person, subject, scopes, contracts, announced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (feature_id) DO UPDATE SET plan_id = excluded.plan_id, person = excluded.person, subject = excluded.subject,
           scopes = excluded.scopes, contracts = excluded.contracts, announced_at = excluded.announced_at`,
        plan.featureId,
        plan.planId,
        plan.person,
        plan.facts.change.subject,
        JSON.stringify(area.scopes),
        JSON.stringify(area.contracts),
        this.#now(),
      );
      const withPart = new Set(plan.parts.flatMap((part) => (part.place.kind === "feature" ? [part.place.feature] : [])));
      for (const feature of withPart) this.cover(plan.planId, feature, "part");
      for (const feature of running) {
        if (feature.id === plan.featureId || withPart.has(feature.id)) continue;
        if (meeting(feature.area, area, scopeMap) !== undefined) this.cover(plan.planId, feature.id, "met");
      }
    });
  }

  /** Every announced plan, oldest first. */
  plans(): AnnouncedPlan[] {
    return this.#db.exec(`SELECT * FROM AnnouncedPlan ORDER BY announced_at, feature_id`).map(announced);
  }

  covered(planId: string, featureId: string): boolean {
    return this.#db.exec(`SELECT 1 FROM PlanCoverage WHERE plan_id = ? AND feature_id = ?`, planId, featureId).length > 0;
  }

  cover(planId: string, featureId: string, how: CoverageKind): void {
    this.#db.exec(`INSERT OR IGNORE INTO PlanCoverage (plan_id, feature_id, how, at) VALUES (?, ?, ?, ?)`, planId, featureId, how, this.#now());
  }
}

/**
 * The announced plans a newly opened feature receives (PRD 4.6): each plan of another feature whose
 * area the new feature's declared area meets. Each one then accounts for the feature, so it gains no
 * part for it later.
 */
export function handOver(coverage: PlanCoverageStore, feature: Feature, scopeMap: ScopeMap): HandedPlan[] {
  const handed: HandedPlan[] = [];
  for (const plan of coverage.plans()) {
    if (plan.featureId === feature.id) continue;
    const meets = meeting(feature.area, plan, scopeMap);
    if (meets === undefined) continue;
    coverage.cover(plan.planId, feature.id, "handed_over");
    handed.push({ ...plan, meets });
  }
  return handed;
}

export interface CoverageDeps {
  readonly coverage: PlanCoverageStore;
  readonly features: FeatureStore;
  readonly routes: PlanRouteStore;
  readonly keeper: (featureId: string) => PlanKeeper;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  readonly notify: (personId: string) => void;
  readonly now?: () => number;
}

/**
 * At feature `feature`'s checkpoint (PRD 4.4 step 3): each announced plan of another feature that does
 * not yet account for it and whose area its area now meets gains a part for it. The part waits on the
 * originating agent for a patch against the feature's checkpoint, then on the feature's person.
 */
export async function coverMidway(deps: CoverageDeps, feature: Feature, scopeMap: ScopeMap): Promise<JoinedPlan[]> {
  const head = feature.latestCheckpointSha;
  if (head === null || feature.repo === null) return [];
  const joined: JoinedPlan[] = [];
  for (const announcedPlan of deps.coverage.plans()) {
    if (announcedPlan.featureId === feature.id || deps.coverage.covered(announcedPlan.planId, feature.id)) continue;
    const meets = meeting(feature.area, announcedPlan, scopeMap);
    if (meets === undefined) continue;
    const keeper = deps.keeper(announcedPlan.featureId);
    const plan = await keeper.latestPlan(announcedPlan.featureId);
    if (plan === undefined || plan.planId !== announcedPlan.planId || plan.parts.length >= PLAN_LIMITS.parts) continue;
    if (plan.parts.some((part) => part.place.kind === "feature" && part.place.feature === feature.id)) {
      deps.coverage.cover(plan.planId, feature.id, "part");
      continue;
    }
    const partId = `${plan.planId}#${plan.parts.length + 1}`;
    const scopes = [...new Set([...meets.scopes, ...meets.contracts.flatMap((contract) => contractScope(scopeMap, contract) ?? [])])].sort();
    const record = await deps.sign(
      deps.features.draftRecord(plan.featureId, "plan_part_added", { penguin: true }, {
        plan_id: plan.planId,
        part_id: partId,
        place: { kind: "feature", feature: feature.id },
        owner: feature.personId,
        scopes,
        contracts: [...meets.contracts],
        checkpoint: head,
      }),
    );
    const at = new Date((deps.now ?? Date.now)()).toISOString();
    const repo = `feature-${feature.id}`;
    const wanted = new Set(scopes);
    const part: PlanPart = {
      partId,
      revision: 1,
      place: { kind: "feature", feature: feature.id },
      owner: feature.personId,
      scopes,
      kind: "behavioural",
      kindReason: "no fix is proposed yet: the originating agent writes one against the feature's checkpoint",
      diff: { source: "patch", repo, ref: `${repo}@${head}`, commit: null, base: head, patch: null, files: [], truncated: false },
      callers: [],
      breaks: [],
      invariants: plan.facts.invariants.filter((invariant) => wanted.has(invariant.scopeId)),
      note: null,
      approvalState: "change_requested",
      approvedBy: null,
      changeRequests: 0,
      changeRequest: {
        by: "penguin",
        revision: 1,
        text: `Feature ${feature.id} started touching this plan's area (${[...meets.scopes, ...meets.contracts].join(", ")}) at checkpoint ${head}. Propose its fix as a patch against ${head}.`,
        at,
        recordId: record.record_id,
        forkHead: head,
      },
    };
    if (!(await keeper.addPart(plan.featureId, plan.planId, part))) continue;
    deps.features.addRecord(record);
    deps.routes.set(plan.featureId, part);
    deps.coverage.cover(plan.planId, feature.id, "added");
    deps.notify(plan.person);
    deps.notify(feature.personId);
    joined.push({ planId: plan.planId, partId, featureId: plan.featureId, meets });
  }
  return joined;
}
