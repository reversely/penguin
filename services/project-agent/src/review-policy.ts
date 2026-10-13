// The sandbox's review policy (#175, docs/review-policies.md): who decides each type of approval,
// Penguin or a person, for this project, its base repo and the forks agents work in.
//
// - Changing it. Only a lead of a team declared in `penguin/teams.json` changes it, from the dashboard
//   (`POST /api/review-policy`). While PENGUIN_PLAN_ADMIN_MODE is on the policy is Production, locked,
//   and every change is refused. A change is a signed `review_policy_changed` record authored by the
//   lead, with the old and new policy, kept in the project's own record folder, PROJECT_RECORDS. It
//   applies to the parts and starts decided after it.
// - Reading it. The policy in force is the newest `review_policy_changed` record whose signature
//   verifies with the service key and whose author is the person it names; a record that fails either
//   check is refused and the one before it stands. With none, the policy is Dev, Penguin's rule
//   before policies existed.
// - The split. Each approval record names who approved and, from #175 on, the policy route that sent
//   the part there. The last 30 days of `approve_plan_part`, approved `migration_part_decided` and
//   `approve_overlap` records give the split: parts Penguin approved and parts people approved,
//   overall and per type of approval that flagged them.
//
// Every value reaches SQL as a bound parameter.

import {
  APPROVAL_TYPES,
  DEFAULT_REVIEW_POLICY,
  parseReviewPolicy,
  PENGUIN_APPROVER,
  policyInForce,
  type ApprovalType,
  type PolicyInForce,
  type ReviewPolicy,
  type ReviewPolicyView,
  type ReviewSplit,
  type SplitCount,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase } from "./issue-index.ts";

/**
 * The record folder of the project's own records, `records/_project/`. A feature id is lowercase
 * letters, digits, dots and hyphens, so no feature can take it.
 */
export const PROJECT_RECORDS = "_project";

/** The days the measured split covers. */
export const SPLIT_DAYS = 30;

/** The policy in force and the record that set it, or nulls for the default. */
export interface StoredPolicy {
  readonly policy: ReviewPolicy;
  readonly changedBy: string | null;
  readonly changedAt: string | null;
  readonly recordId: string | null;
}

export const DEFAULT_STORED_POLICY: StoredPolicy = { policy: DEFAULT_REVIEW_POLICY, changedBy: null, changedAt: null, recordId: null };

/**
 * The newest `review_policy_changed` record of `records` that verifies and whose author is the person
 * it names; the default when none does. `verify` checks a record's signature with the service key.
 */
export async function readReviewPolicy(
  records: readonly { readonly file: string }[],
  verify: (record: FeatureRecord) => Promise<boolean>,
): Promise<StoredPolicy> {
  for (const stored of [...records].reverse()) {
    let record: FeatureRecord;
    try {
      record = JSON.parse(stored.file) as FeatureRecord;
    } catch {
      continue;
    }
    if (record.type !== "review_policy_changed") continue;
    const author = "person" in record.author ? record.author.person : undefined;
    const policy = parseReviewPolicy(record.payload["new"]);
    if (typeof policy === "string" || author === undefined || record.payload["changed_by"] !== author) continue;
    if (!(await verify(record))) continue;
    return { policy, changedBy: author, changedAt: record.created_at, recordId: record.record_id };
  }
  return DEFAULT_STORED_POLICY;
}

/** Whether `person` leads a team declared in `penguin/teams.json`; a one-person team counts for no one. */
export function leadsATeam(scopeMap: ScopeMap, person: string): boolean {
  return [...scopeMap.teams.values()].some((team) => !team.implicit && team.leadId === person);
}

export interface PolicyChangeDeps {
  readonly features: Pick<FeatureStore, "draftRecord" | "addRecord">;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** The policy in force now, which the record names as the old one. */
  readonly current: () => Promise<StoredPolicy>;
  /** PENGUIN_PLAN_ADMIN_MODE: the policy is Production, locked. */
  readonly adminMode: boolean;
}

export type PolicyChangeOutcome =
  | { readonly status: "ok"; readonly policy: ReviewPolicy; readonly recordId: string }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "locked"; readonly message: string };

/**
 * `caller`, the person the dashboard session names, sets the sandbox's review policy. Refused while
 * admin mode locks it, for anyone who leads no declared team and for a policy that does not parse.
 */
export async function changeReviewPolicy(deps: PolicyChangeDeps, caller: string, input: unknown): Promise<PolicyChangeOutcome> {
  if (deps.adminMode) {
    return { status: "rejected", reason: "locked", message: "PENGUIN_PLAN_ADMIN_MODE is on, so every part goes to a person and the policy cannot change here" };
  }
  if (!leadsATeam(await deps.scopeMap(), caller)) {
    return { status: "rejected", reason: "forbidden", message: "only a team lead named in penguin/teams.json changes the review policy" };
  }
  const policy = parseReviewPolicy(input);
  if (typeof policy === "string") return { status: "rejected", reason: "invalid", message: policy };
  const old = (await deps.current()).policy;
  const record = await deps.sign(
    deps.features.draftRecord(PROJECT_RECORDS, "review_policy_changed", { person: caller }, { old, new: policy, changed_by: caller }),
  );
  deps.features.addRecord(record);
  return { status: "ok", policy, recordId: record.record_id };
}

const RECORD_TYPES = ["approve_plan_part", "migration_part_decided", "approve_overlap"] as const;

function emptySplit(): { overall: SplitCount; byType: Record<ApprovalType, SplitCount> } {
  return {
    overall: { penguin: 0, people: 0 },
    byType: Object.fromEntries(APPROVAL_TYPES.map((type) => [type, { penguin: 0, people: 0 }])) as Record<ApprovalType, SplitCount>,
  };
}

/**
 * The split of approvals stored since `since` (epoch milliseconds). `people`, when given, keeps only
 * the approvals of parts and starts owned by one of them, for a team's page.
 */
export function reviewSplit(db: SqlDatabase, since: number, people?: ReadonlySet<string>): ReviewSplit {
  const split = emptySplit();
  const rows = db.exec(
    `SELECT file FROM FeatureRecord WHERE created_at >= ? AND json_extract(file, '$.type') IN (?, ?, ?)`,
    since,
    ...RECORD_TYPES,
  );
  for (const row of rows) {
    const record = JSON.parse(row["file"] as string) as FeatureRecord;
    const payload = record.payload;
    let byPenguin: boolean;
    let owner: unknown;
    let types: readonly ApprovalType[] = [];
    const route = payload["review_policy"] as { readonly types?: readonly ApprovalType[] } | undefined;
    if (record.type === "migration_part_decided") {
      if (payload["decision"] !== "approved") continue;
      byPenguin = true;
      owner = payload["owner"];
    } else if (record.type === "approve_overlap") {
      byPenguin = payload["approved_by"] === PENGUIN_APPROVER;
      owner = payload["owner"] ?? payload["approved_by"];
      types = ["overlapping_starts"];
    } else {
      byPenguin = payload["approved_by"] === PENGUIN_APPROVER;
      owner = payload["owner"];
    }
    if (people !== undefined && (typeof owner !== "string" || !people.has(owner))) continue;
    for (const type of route?.types ?? types) {
      const count = split.byType[type];
      if (count === undefined) continue;
      split.byType[type] = byPenguin ? { ...count, penguin: count.penguin + 1 } : { ...count, people: count.people + 1 };
    }
    split.overall = byPenguin ? { ...split.overall, penguin: split.overall.penguin + 1 } : { ...split.overall, people: split.overall.people + 1 };
  }
  return { days: SPLIT_DAYS, ...split };
}

/**
 * The settings view for `viewer`: the policy in force, who changed it, whether they may change it and
 * the split over the last SPLIT_DAYS days to `now`, for the project and for each declared team.
 */
export function reviewPolicyView(stored: StoredPolicy, adminMode: boolean, scopeMap: ScopeMap, viewer: string, db: SqlDatabase, now: number): ReviewPolicyView {
  const inForce: PolicyInForce = policyInForce(stored.policy, adminMode);
  const since = now - SPLIT_DAYS * 24 * 60 * 60 * 1000;
  const teams = [...scopeMap.teams.values()].filter((team) => !team.implicit).sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    policy: inForce.policy,
    locked: inForce.locked,
    changedBy: stored.changedBy,
    changedAt: stored.changedAt,
    recordId: stored.recordId,
    canChange: !inForce.locked && leadsATeam(scopeMap, viewer),
    split: reviewSplit(db, since),
    teams: teams.map((team) => ({ team: team.id, split: reviewSplit(db, since, new Set(team.memberIds)) })),
  };
}
