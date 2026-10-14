// Advance notice of a merge plan (PRD 0.4 sections 4.3 and 7): each part goes to its author and their
// running agents, the author approves it or asks for a change, a requested change goes back to the
// originating agent, which revises that part, and a part asked to change past the round limit goes to
// the originating feature's person.
//
// - Delivery. A stored plan reaches every author at once (announcePlan): a `plan_part` inbox item for
//   each part's owner, and each running session of that owner hears of the part at its next safe
//   checkpoint (session-store.ts PlanNotice). A part whose fix touches a path a scope's owner protects
//   in `penguin/scopes.json` also gives that owner a `protected_path` item. A newer plan of the feature
//   withdraws the older plan's items. The originating feature's own change to a protected path is
//   checked at each of its checkpoints instead (protected-change.ts).
// - Penguin's approval (PRD 0.5 section 4.3 step 3, #175). Penguin approves a pending part when the
//   sandbox's review policy routes it to Penguin (`policyRoute`, @penguin/protocol validation.ts): its
//   tests passed and every check of partRouting that flags it is a type the policy sets to Penguin.
//   Under Dev, the default, that is every check clean; admin mode sends every part to a person
//   (approveCleanParts). It looks after the plan is announced, after a review of the feature is
//   recorded and after a revision. The approval is a signed `approve_plan_part` record authored by
//   Penguin, naming each check's evidence. The author's `plan_part` item gives way to a
//   `penguin_approved` item, and the author may reverse the approval until the block reaches main
//   (reversePenguinApproval): the part then waits on them in person and Penguin never approves that
//   revision again.
// - Decisions. A person decides every other part, on the dashboard: the part's owner, or the delegate
//   that owner names in `penguin/owners.json`. Agents submit reviews (review-submit.ts) and never
//   approve. A decision names the part and the revision it saw. A decision by anyone else, on a part
//   outside the feature's newest plan, on another revision, or on a part already decided is refused.
//   Each approval, reversal and request is a signed record on the originating feature, and the
//   request's text is kept as data of at most PLAN_LIMITS.changeRequestLength characters. A part whose
//   one failing check is stored data its scope only reads, which the originating change reshapes with
//   no migration or backfill, waits on the originating person instead (#132): they see it as a
//   `stored_data` ask and may approve it, and its author is not asked.
// - Rounds. Each requested change is one round. The originating agent answers it with
//   `revise_plan_part`, which makes the part's next revision and asks its author again. The request
//   that would start round `roundLimit + 1` instead moves the part to `round_limit`: the agent may not
//   revise it, the originating person gets a `round_limit` item and a signed record says why. The
//   author may still approve the revision they have.
//
// The parts themselves live in the feature's own Durable Object (plan-store.ts), which takes each
// change only while the part still stands where the decision read it. PlanPartRoute keeps beside the
// ProjectAgent's inbox the copy each checkpoint and listing reads: which revision of which part waits
// on whom.

import {
  partRouting,
  policyInForce,
  policyRoute,
  policyRoutePayload,
  routesToOriginator,
  PENGUIN_APPROVER,
  PLAN_LIMITS,
  PLAN_ROUND_LIMIT_DEFAULT,
  type BreakView,
  type PartRouting,
  type Plan,
  type PlanBreakFact,
  type PlanInbox,
  type PlanPart,
  type PlanPartAsk,
  type PlanPartFile,
  type PlanPartRequest,
  type PlanPartState,
  type PlanPlace,
  type PolicyInForce,
  type PolicyRoute,
  type ProtectedChangeRequest,
  type ProtectedPathHit,
  type ReturnedPlanRequest,
  type ReviewExceptionRequest,
  type TeamExceptionView,
  type CallerItemRequest,
} from "@penguin/protocol";
import type { Delegates } from "@penguin/issues";
import { answerers, ledScopes, routeScope, scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejection } from "./feature-open.ts";
import { parseFeatureId, type FeatureRecord, type FeatureStore, type StoredFeatureRecord, type UnsignedFeatureRecord } from "./feature-store.ts";
import { parsePartRef, type InboxItem, type InboxStore } from "./inbox-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { protectedLookup, reviewResult, trialPart, trialReviews, type PartTrialStanding } from "./part-checks.ts";
import type { PlanFactsStore } from "./plan-facts.ts";
import type { PlanKeeper } from "./plan-store.ts";
import { classifyPart, parseFixFields, readFix, type AffectedPlace, type RepoReading } from "./propose-plan.ts";
import type { ReviewStore, StoredReview } from "./review-submit.ts";
import { reviewView } from "./review-view.ts";
import type { PlanDecisionNotice, PlanNoticeSources, PlanPartNotice, ReviewResultNotice, SessionOutcome } from "./session-store.ts";

type Row = Record<string, SqlValue>;

export const PLAN_ROUTE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS PlanPartRoute (
    part_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, feature_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    place TEXT NOT NULL, scopes TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
    updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS PlanPartRoute_owner ON PlanPartRoute (owner_id, state)`,
  `CREATE INDEX IF NOT EXISTS PlanPartRoute_feature ON PlanPartRoute (feature_id)`,
];

/** Columns added since the table was first made, each added to an older table when missing. */
const ROUTE_COLUMNS: readonly (readonly [string, string])[] = [["kind", "kind TEXT NOT NULL DEFAULT ''"]];

/** Where one part of a feature's newest plan stands, as the routing reads it. */
export interface PartRoute {
  readonly partId: string;
  readonly planId: string;
  readonly featureId: string;
  readonly ownerId: string;
  readonly place: PlanPlace;
  readonly scopes: readonly string[];
  readonly revision: number;
  readonly state: PlanPartState;
  /** A verify part, a place that needs no change: it gets no review task and no fix task. */
  readonly verify: boolean;
  readonly updatedAt: string;
}

function route(row: Row): PartRoute {
  return {
    partId: row["part_id"] as string,
    planId: row["plan_id"] as string,
    featureId: row["feature_id"] as string,
    ownerId: row["owner_id"] as string,
    place: JSON.parse(row["place"] as string) as PlanPlace,
    scopes: JSON.parse(row["scopes"] as string) as string[],
    revision: Number(row["revision"]),
    state: row["state"] as PlanPartState,
    verify: row["kind"] === "verify",
    updatedAt: new Date(Number(row["updated_at"])).toISOString(),
  };
}

/** The parts of each feature's newest plan, with the revision and state each one stands at. */
export class PlanRouteStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PLAN_ROUTE_SCHEMA) db.exec(statement);
    // Column names and definitions come from the constant above, never from input.
    const present = new Set(db.exec(`PRAGMA table_info(PlanPartRoute)`).map((row) => row["name"]));
    for (const [name, definition] of ROUTE_COLUMNS) {
      if (!present.has(name)) db.exec(`ALTER TABLE PlanPartRoute ADD COLUMN ${definition}`);
    }
  }

  /** Routes the parts of a newly kept plan and returns the routes of the older plan it replaces. */
  announce(plan: Plan): PartRoute[] {
    return this.#db.transaction(() => {
      const withdrawn = this.#db
        .exec(`DELETE FROM PlanPartRoute WHERE feature_id = ? AND plan_id != ? RETURNING *`, plan.featureId, plan.planId)
        .map(route);
      for (const part of plan.parts) this.set(plan.featureId, part);
      return withdrawn;
    });
  }

  /** Records where a part of feature `featureId`'s newest plan now stands. */
  set(featureId: string, part: PlanPart): void {
    this.#db.exec(
      `INSERT INTO PlanPartRoute (part_id, plan_id, feature_id, owner_id, place, scopes, revision, state, kind, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (part_id) DO UPDATE SET owner_id = excluded.owner_id, revision = excluded.revision,
         state = excluded.state, kind = excluded.kind, updated_at = excluded.updated_at`,
      part.partId,
      part.partId.slice(0, part.partId.lastIndexOf("#")),
      featureId,
      part.owner,
      JSON.stringify(part.place),
      JSON.stringify(part.scopes),
      part.revision,
      part.approvalState,
      // Only a verify part is marked: the routing tells it apart from parts with a fix.
      part.kind === "verify" ? "verify" : "",
      this.#now(),
    );
  }

  get(partId: string): PartRoute | undefined {
    const [row] = this.#db.exec(`SELECT * FROM PlanPartRoute WHERE part_id = ?`, partId);
    return row === undefined ? undefined : route(row);
  }

  /**
   * The parts owned by one of `owners` that stand in one of `states`, oldest change first: by default
   * the parts whose current revision waits on them.
   */
  waitingOn(owners: readonly string[], states: readonly PlanPartState[] = ["pending"]): PartRoute[] {
    if (owners.length === 0 || states.length === 0) return [];
    // Only placeholders are built into the query; every owner and state is a bound value.
    return this.#db
      .exec(
        `SELECT * FROM PlanPartRoute WHERE state IN (${states.map(() => "?").join(", ")})
           AND owner_id IN (${owners.map(() => "?").join(", ")})
         ORDER BY updated_at, rowid`,
        ...states,
        ...owners,
      )
      .map(route);
  }

  /** The features with a part of their newest plan waiting on a decision, in the order they were announced. */
  pendingFeatures(): string[] {
    return this.#db.exec(`SELECT feature_id FROM PlanPartRoute WHERE state = 'pending' GROUP BY feature_id ORDER BY MIN(rowid)`).map((row) => row["feature_id"] as string);
  }

  /** The parts of feature `featureId`'s newest plan, in part order. */
  ofFeature(featureId: string): PartRoute[] {
    return this.#db.exec(`SELECT * FROM PlanPartRoute WHERE feature_id = ? ORDER BY rowid`, featureId).map(route);
  }
}

/**
 * Reads a round limit from configuration: unset is the PRD default, a positive whole number is the
 * limit, and anything else is undefined, which refuses every requested change as misconfigured.
 */
export function parseRoundLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return PLAN_ROUND_LIMIT_DEFAULT;
  if (!/^[1-9][0-9]{0,3}$/u.test(value)) return undefined;
  return Number(value);
}

/**
 * Reads the project's admin mode setting: unset, empty or `off` is off and `on` is on. Any other value
 * also counts as on, so a mistyped setting never lets Penguin approve.
 */
export function parseAdminMode(value: string | undefined): boolean {
  return !(value === undefined || value === "" || value === "off");
}

/** The inbox calls advance notice makes (inbox-store.ts). */
export type PlanInboxWrites = Pick<
  InboxStore,
  "planPartAsked" | "planPartSettled" | "protectedPathTouched" | "roundLimitReached" | "partWithdrawn" | "penguinApproved" | "penguinApprovalSettled"
>;

export interface PlanApprovalDeps {
  readonly features: FeatureStore;
  readonly routes: PlanRouteStore;
  readonly inbox: PlanInboxWrites;
  /** The plan store of one feature: its Durable Object (plan-store.ts). */
  readonly keeper: (featureId: string) => PlanKeeper;
  /** Each owner's delegate, from `penguin/owners.json` on the base repo, read fresh. */
  readonly delegates: () => Promise<Delegates>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** The project's round limit; undefined when its configuration is invalid. */
  readonly roundLimit: number | undefined;
  /** Tells a person's open dashboards that their inbox changed. */
  readonly notify: (personId: string) => void;
  /**
   * Called once a revision is approved, after its record is kept: queues the check runner's write of
   * a mechanical part on a running feature (fix-write.ts). Absent, nothing is queued.
   */
  readonly approved?: (featureId: string, plan: Plan, part: PlanPart) => void;
  /**
   * Called once an author reversed Penguin's approval of a revision: withdraws the write of that
   * revision when it has not happened yet (fix-write.ts). Absent, nothing is withdrawn.
   */
  readonly reversed?: (featureId: string, part: PlanPart) => void;
  /**
   * What Penguin's approval checks beyond the part: the feature's reviews, the scope map's protected
   * paths and the project's admin mode. Absent, Penguin approves no part.
   */
  readonly checks?: PartCheckDeps;
  readonly now?: () => number;
  /**
   * Whether a person can take a decision now (edit-work.ts `availability`): a protected path a
   * revision writes goes down its scope's fallback order while the DRI is not. Absent, the DRI is asked.
   */
  readonly available?: () => (person: string) => boolean;
}

export interface PartCheckDeps {
  /** The reviews submitted on the originating feature (ReviewStore.list). */
  readonly reviews: (featureId: string) => readonly StoredReview[];
  readonly scopeMap: () => Promise<ScopeMap>;
  /** PENGUIN_PLAN_ADMIN_MODE: a person approves every part. */
  readonly adminMode: boolean;
  /** The trial of a part's current revision (part-trial.ts `trialStanding`); absent, none is read. */
  readonly trial?: (featureId: string, part: PlanPart) => PartTrialStanding | undefined;
  /** The sandbox's review policy in force (review-policy.ts); absent, Dev, or Production locked in admin mode. */
  readonly policy?: () => Promise<PolicyInForce>;
}

/** The policy in force for `checks`: their own, or the default under their admin mode. */
export async function checksPolicy(checks: Pick<PartCheckDeps, "adminMode" | "policy">): Promise<PolicyInForce> {
  return checks.policy === undefined ? policyInForce(undefined, checks.adminMode) : checks.policy();
}

export interface ReviseDeps extends PlanApprovalDeps {
  readonly facts: PlanFactsStore;
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly readRepo: RepoReading;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
}

/** The part a decision names: the originating feature, the part id and the revision the person saw. */
export interface PartDecisionInput {
  readonly feature: unknown;
  readonly part: unknown;
  readonly revision: unknown;
}

export interface ChangeRequestInput extends PartDecisionInput {
  /** What the author asks for. */
  readonly text: unknown;
}

/** The originating agent's revision: a new fix for the part in the form `propose_plan` takes. */
export interface RevisionInput extends PartDecisionInput {
  readonly diff?: unknown;
  readonly patch?: unknown;
  readonly note?: unknown;
}

export type PartRejection =
  | FeatureRejection
  | { readonly status: "rejected"; readonly reason: "misconfigured" | "round_limit"; readonly message: string };

export type PartDecisionOutcome =
  | {
      readonly status: "ok";
      readonly part: PlanPart;
      /** The signed record of the decision or revision. */
      readonly recordId: string;
      /** The signed record that sent the part to the originating person, when this request went past the limit. */
      readonly roundLimitRecordId: string | null;
    }
  | PartRejection;

const rejected = (reason: PartRejection["reason"], message: string): PartRejection => ({ status: "rejected", reason, message }) as PartRejection;

/** The longest part id: a feature id, `/v`, a version and `#`, a part number. */
const PART_ID_MAX_LENGTH = 128;

export { protectedLookup };

/**
 * One part's routing against the plan it belongs to (PRD 4.3): every reason it needs a person. With
 * `trial`, the part revision's trial supplies the tests and the reviews it ran (part-checks.ts).
 */
export function routePart(
  plan: Plan,
  part: PlanPart,
  reviews: readonly StoredReview[],
  scopeMap: ScopeMap,
  adminMode: boolean,
  trial?: PartTrialStanding,
): PartRouting {
  return partRouting(
    trialPart(part, trial),
    {
      reviews: trialReviews(reviews.map(reviewResult), trial),
      checkpoint: plan.facts.change.checkpoint,
      adminMode,
      storeMarked: plan.storeMarker != null,
    },
    protectedLookup(scopeMap),
  );
}

/**
 * The people asked to confirm the protected paths the part's fix writes: each protecting scope's DRI,
 * or down its fallback order while the DRI is away (#135).
 */
function protectingOwners(part: PlanPart, scopeMap: ScopeMap, available: (person: string) => boolean): Set<string> {
  const lookup = protectedLookup(scopeMap);
  return new Set(part.diff.files.flatMap((file) => {
    const hit = lookup(file.path);
    return hit === undefined ? [] : (routeScope(scopeMap, hit.scope, available) ?? []);
  }));
}

/**
 * Sends a stored plan to every author at once: each part's owner gets a `plan_part` item, the person
 * who answers for each protected path a part writes gets a `protected_path` item, and the older plan's
 * items go. `available` says who can take work now; absent, every DRI is asked.
 */
export function announcePlan(
  deps: Pick<PlanApprovalDeps, "routes" | "inbox" | "notify">,
  plan: Plan,
  scopeMap: ScopeMap,
  available: (person: string) => boolean = () => true,
): void {
  const told = new Set<string>();
  for (const old of deps.routes.announce(plan)) for (const person of deps.inbox.partWithdrawn(old.partId)) told.add(person);
  for (const part of plan.parts) {
    deps.inbox.planPartAsked(part.owner, part.partId);
    told.add(part.owner);
    for (const owner of protectingOwners(part, scopeMap, available)) {
      deps.inbox.protectedPathTouched(owner, part.partId);
      told.add(owner);
    }
  }
  for (const person of told) deps.notify(person);
}

interface LoadedPart {
  readonly featureId: string;
  readonly plan: Plan;
  readonly part: PlanPart;
}

/** The part a decision names in the feature's newest plan, at the revision the caller saw. */
async function loadPart(deps: Pick<PlanApprovalDeps, "features" | "keeper">, input: PartDecisionInput): Promise<LoadedPart | PartRejection> {
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  if (deps.features.get(featureId) === undefined) return rejected("not_found", `no feature ${featureId}`);
  const partId = input.part;
  if (typeof partId !== "string" || partId.length > PART_ID_MAX_LENGTH || !partId.startsWith(`${featureId}/v`)) {
    return rejected("invalid", `the part must be the id of a part of feature ${featureId}'s plan`);
  }
  const revision = input.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return rejected("invalid", "the revision must be the part's revision number");
  }
  const plan = await deps.keeper(featureId).latestPlan(featureId);
  const part = plan?.parts.find((each) => each.partId === partId);
  if (plan === undefined || part === undefined) return rejected("not_found", `part ${partId} is not in feature ${featureId}'s newest plan`);
  if (part.revision !== revision) {
    return rejected("conflict", `part ${partId} is at revision ${part.revision}, not ${revision}; read it again`);
  }
  return { featureId, plan, part };
}

/** Refuses anyone but the part's owner and that owner's delegate. */
async function decider(deps: Pick<PlanApprovalDeps, "delegates">, caller: string, part: PlanPart): Promise<PartRejection | undefined> {
  if (caller === part.owner) return undefined;
  const delegate = (await deps.delegates()).get(part.owner);
  if (delegate !== undefined && delegate === caller) return undefined;
  return rejected("forbidden", `only ${part.owner}, who owns part ${part.partId}, or their delegate decides it`);
}

/**
 * Whether `caller` decides the part as the originating feature's person: the part routes to them,
 * because its one failing check is stored data their change reshapes with no migration or backfill
 * (#132). Without the checks Penguin cannot tell, so only the owner decides.
 */
async function originatorDecides(deps: Pick<PlanApprovalDeps, "checks">, caller: string, featureId: string, plan: Plan, part: PlanPart): Promise<boolean> {
  const checks = deps.checks;
  if (checks === undefined || caller !== plan.person || caller === part.owner) return false;
  const routing = routePart(plan, part, checks.reviews(featureId), await checks.scopeMap(), checks.adminMode, checks.trial?.(featureId, part));
  return routesToOriginator(routing);
}

/** Why a part in `state` takes no decision, or undefined when it waits on its author. */
function undecidable(part: PlanPart, approving: boolean): PartRejection | undefined {
  switch (part.approvalState) {
    case "pending":
      return undefined;
    case "round_limit":
      // Past the limit the agents stop; the author may still approve what they have.
      return approving ? undefined : rejected("conflict", `part ${part.partId} is past the round limit; it waits on the originating person`);
    case "approved":
      return rejected("conflict", `revision ${part.revision} of part ${part.partId} is already approved`);
    case "change_requested":
      return rejected("conflict", `a change to revision ${part.revision} of part ${part.partId} is already asked for; it waits on the originating agent`);
  }
}

/**
 * `caller`, the person the dashboard session names, approves one revision of a part. Only the part's
 * owner or their delegate may, once per revision; the approval is a signed record.
 */
export async function approvePlanPart(deps: PlanApprovalDeps, caller: string, input: PartDecisionInput): Promise<PartDecisionOutcome> {
  const loaded = await loadPart(deps, input);
  if ("status" in loaded) return loaded;
  const { featureId, plan, part } = loaded;
  const byOriginator = await originatorDecides(deps, caller, featureId, plan, part);
  const refusal = (byOriginator ? undefined : await decider(deps, caller, part)) ?? undecidable(part, true);
  if (refusal !== undefined) return refusal;
  const route = await currentRoute(deps.checks, featureId, plan, part);
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "approve_plan_part", { person: caller }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      place: part.place,
      diff: part.diff.ref,
      owner: part.owner,
      approved_by: caller,
      // The originating person approved a part whose one failing check is their own change's stored data.
      ...(byOriginator ? { routed_to: "originating_person" } : {}),
      ...(route === undefined ? {} : { review_policy: policyRoutePayload(route) }),
    }),
  );
  const next: PlanPart = { ...part, approvalState: "approved", approvedBy: caller, route: route ?? null };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: part.approvalState }))) {
    return rejected("conflict", `part ${part.partId} changed while it was approved; read it again`);
  }
  deps.features.addRecord(record);
  deps.routes.set(featureId, next);
  deps.inbox.planPartSettled(part.owner, part.partId);
  deps.notify(part.owner);
  deps.approved?.(featureId, plan, next);
  return { status: "ok", part: next, recordId: record.record_id, roundLimitRecordId: null };
}

/** The policy's route for a part as it stands now, or undefined without the checks to read it. */
async function currentRoute(checks: PartCheckDeps | undefined, featureId: string, plan: Plan, part: PlanPart): Promise<PolicyRoute | undefined> {
  if (checks === undefined) return undefined;
  const routing = routePart(plan, part, checks.reviews(featureId), await checks.scopeMap(), false, checks.trial?.(featureId, part));
  return policyRoute(await checksPolicy(checks), routing);
}

/**
 * `caller` asks for a change to one revision of a part. The part goes back to the originating agent,
 * or, past the round limit, to the originating person. The request and its text are a signed record.
 */
export async function requestPlanChange(deps: PlanApprovalDeps, caller: string, input: ChangeRequestInput): Promise<PartDecisionOutcome> {
  const text = input.text;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > PLAN_LIMITS.changeRequestLength) {
    return rejected("invalid", `the request must say what to change, in at most ${PLAN_LIMITS.changeRequestLength} characters`);
  }
  if (deps.roundLimit === undefined) return rejected("misconfigured", "PENGUIN_PLAN_ROUND_LIMIT must be a positive whole number");
  const loaded = await loadPart(deps, input);
  if ("status" in loaded) return loaded;
  const { featureId, plan, part } = loaded;
  const refusal = (await decider(deps, caller, part)) ?? undecidable(part, false);
  if (refusal !== undefined) return refusal;

  const round = part.changeRequests + 1;
  const pastLimit = round > deps.roundLimit;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "request_plan_change", { person: caller }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      requested_by: caller,
      round,
      round_limit: deps.roundLimit,
      text,
    }),
  );
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const next: PlanPart = {
    ...part,
    approvalState: pastLimit ? "round_limit" : "change_requested",
    approvedBy: null,
    route: null,
    changeRequests: round,
    changeRequest: { by: caller, revision: part.revision, text, at, recordId: record.record_id },
  };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: part.approvalState }))) {
    return rejected("conflict", `part ${part.partId} changed while the change was asked for; read it again`);
  }
  deps.features.addRecord(record);
  let limitRecord: FeatureRecord | null = null;
  if (pastLimit) {
    limitRecord = await deps.sign(
      deps.features.draftRecord(featureId, "plan_round_limit", { penguin: true }, {
        plan_id: plan.planId,
        part_id: part.partId,
        revision: part.revision,
        round,
        round_limit: deps.roundLimit,
        person: plan.person,
        request: record.record_id,
      }),
    );
    deps.features.addRecord(limitRecord);
    deps.inbox.roundLimitReached(plan.person, part.partId);
    deps.notify(plan.person);
  }
  deps.routes.set(featureId, next);
  deps.inbox.planPartSettled(part.owner, part.partId);
  deps.notify(part.owner);
  return { status: "ok", part: next, recordId: record.record_id, roundLimitRecordId: limitRecord?.record_id ?? null };
}

/**
 * Penguin approves each pending part of feature `featureId`'s newest plan that the review policy routes
 * to Penguin (PRD 4.3 step 3, #175, #177): under Central development every check clean, under Local
 * development every part whose tests passed. Never in admin mode or once the block has landed. Each approval is a signed record authored
 * by Penguin that names the evidence and the policy's rule. The author gets a `penguin_approved` item
 * in place of the `plan_part` one. Returns the parts approved.
 */
export async function approveCleanParts(deps: PlanApprovalDeps, featureId: string): Promise<PlanPart[]> {
  const checks = deps.checks;
  if (checks === undefined || checks.adminMode || deps.features.get(featureId)?.state === "landed") return [];
  const inForce = await checksPolicy(checks);
  if (inForce.locked) return [];
  const plan = await deps.keeper(featureId).latestPlan(featureId);
  const pending = plan?.parts.filter((part) => part.approvalState === "pending") ?? [];
  if (plan === undefined || pending.length === 0) return [];
  const scopeMap = await checks.scopeMap();
  const reviews = checks.reviews(featureId);
  const approved: PlanPart[] = [];
  for (const part of pending) {
    const trial = checks.trial?.(featureId, part);
    // A verify part is approved on its own trial's tests, never on the facts run alone.
    if (part.kind === "verify" && trial?.state !== "recorded") continue;
    const route = policyRoute(inForce, routePart(plan, part, reviews, scopeMap, false, trial));
    if (route.decider !== "penguin") continue;
    const tests = trialPart(part, trial).tests;
    const record = await deps.sign(
      deps.features.draftRecord(featureId, "approve_plan_part", { penguin: true }, {
        plan_id: plan.planId,
        part_id: part.partId,
        revision: part.revision,
        place: part.place,
        diff: part.diff.ref,
        owner: part.owner,
        approved_by: PENGUIN_APPROVER,
        // The evidence of each clean check: the tests on the tree holding the fix (the part's trial, or the
        // facts run when the fix is under the checkpoint) and the reviews.
        checks: {
          checkpoint: plan.facts.change.checkpoint,
          facts_run: tests?.runId ?? null,
          ...(trial?.state === "recorded" ? { trial_tree: trial.evidence.tree } : {}),
          tests: (tests?.results ?? []).map(({ scopeId, commandId, status }) => ({ scope: scopeId, command: commandId, status })),
          reviews: newestReviews(reviews, part.scopes).map((review) => review.id),
        },
        review_policy: policyRoutePayload(route),
      }),
    );
    const next: PlanPart = { ...part, approvalState: "approved", approvedBy: PENGUIN_APPROVER, route };
    if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: "pending" }))) continue;
    deps.features.addRecord(record);
    deps.routes.set(featureId, next);
    deps.inbox.planPartSettled(part.owner, part.partId);
    deps.inbox.penguinApproved(part.owner, part.partId);
    deps.notify(part.owner);
    deps.approved?.(featureId, plan, next);
    approved.push(next);
  }
  return approved;
}

/**
 * `caller` reverses Penguin's approval of one revision of a part, until the block lands. Only the
 * part's owner or their delegate may. The part then waits on its author in person; the reversal is a
 * signed record, and Penguin never approves that revision again.
 */
export async function reversePenguinApproval(deps: PlanApprovalDeps, caller: string, input: PartDecisionInput): Promise<PartDecisionOutcome> {
  const loaded = await loadPart(deps, input);
  if ("status" in loaded) return loaded;
  const { featureId, plan, part } = loaded;
  const refusal = await decider(deps, caller, part);
  if (refusal !== undefined) return refusal;
  if (part.approvalState !== "approved" || part.approvedBy !== PENGUIN_APPROVER) {
    return rejected("conflict", `Penguin did not approve revision ${part.revision} of part ${part.partId}, so there is no approval of Penguin's to reverse`);
  }
  if (deps.features.get(featureId)?.state === "landed") {
    return rejected("conflict", `feature ${featureId}'s block has landed, so its approvals stand`);
  }
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "reverse_penguin_approval", { person: caller }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      owner: part.owner,
      reversed_by: caller,
    }),
  );
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const next: PlanPart = {
    ...part,
    approvalState: "pending",
    approvedBy: null,
    route: null,
    reversal: { by: caller, revision: part.revision, at, recordId: record.record_id },
  };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: "approved" }))) {
    return rejected("conflict", `part ${part.partId} changed while its approval was reversed; read it again`);
  }
  deps.features.addRecord(record);
  deps.routes.set(featureId, next);
  deps.inbox.penguinApprovalSettled(part.owner, part.partId);
  deps.inbox.planPartAsked(part.owner, part.partId);
  deps.notify(part.owner);
  deps.reversed?.(featureId, next);
  return { status: "ok", part: next, recordId: record.record_id, roundLimitRecordId: null };
}

/**
 * The originating agent's revision of a part whose author asked for a change: a new fix, read and
 * checked as `propose_plan` checks it and classified again, which becomes the part's next revision
 * and waits on its author once more.
 */
export async function revisePlanPart(deps: ReviseDeps, caller: string, sessionId: string, input: RevisionInput): Promise<PartDecisionOutcome> {
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if (feature.personId !== caller || deps.features.featureOfSession(sessionId) !== featureId) {
    return rejected("forbidden", `only an agent of feature ${featureId} revises its plan`);
  }
  const loaded = await loadPart(deps, input);
  if ("status" in loaded) return loaded;
  const { plan, part } = loaded;
  if (part.approvalState === "round_limit") {
    return rejected("round_limit", `part ${part.partId} is past the round limit of ${deps.roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT}; it waits on ${plan.person}`);
  }
  if (part.approvalState !== "change_requested") {
    return rejected("conflict", `no change to revision ${part.revision} of part ${part.partId} is asked for`);
  }
  const fields: Record<string, unknown> = {};
  for (const key of ["diff", "patch", "note"] as const) if (input[key] !== undefined) fields[key] = input[key];
  const fix = parseFixFields(part.place, fields, "the revision");
  if (typeof fix === "string") return rejected("invalid", fix);
  const report = plan.facts.run === null ? null : (deps.facts.get(plan.facts.run.runId)?.report ?? null);
  const impact = report?.impact ?? null;
  if (impact === null || feature.repo === null) {
    return rejected("not_found", `the facts of plan ${plan.planId} are gone; propose a new plan`);
  }
  const scopeMap = await deps.scopeMap();
  const place: AffectedPlace = {
    place: part.place,
    owner: part.owner,
    // Penguin's own request names the fork head the revised patch applies to; an author's keeps the base.
    head: part.place.kind === "feature" ? (part.changeRequest?.forkHead ?? part.diff.base) : null,
    scopes: new Set(part.scopes),
    callers: [...part.callers],
    breaks: [...part.breaks],
  };
  const read = await readFix(deps, { place: part.place, ...fix }, place, feature.repo, scopeMap, {}, plan.facts.change.checkpoint);
  if ("code" in read) return rejected("invalid", `${read.code}: ${read.message}`);
  const kind = classifyPart(read, impact, part.place, plan.rules ?? [], report?.rewrites, (path) => {
    const scope = scopeForPath(scopeMap, path);
    return scope !== undefined && part.scopes.includes(scope);
  });
  const revision = part.revision + 1;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "revise_plan_part", { identity: live.session.handle }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision,
      answers: part.changeRequest?.recordId ?? null,
      place: part.place,
      diff: read.diff.ref,
      kind: kind.kind,
    }),
  );
  const next: PlanPart = {
    ...part,
    revision,
    kind: kind.kind,
    kindReason: kind.reason,
    diff: read.diff,
    note: fix.note,
    approvalState: "pending",
    approvedBy: null,
    route: null,
    // The facts run's results stand; whether the tested tree holds the new fix is read again.
    tests: part.tests === undefined || part.tests === null ? part.tests : { ...part.tests, fixInTree: read.fixInTree },
  };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: part.approvalState }))) {
    return rejected("conflict", `part ${part.partId} changed while it was revised; read it again`);
  }
  deps.features.addRecord(record);
  deps.routes.set(featureId, next);
  deps.inbox.planPartAsked(part.owner, part.partId);
  const told = new Set([part.owner]);
  for (const owner of protectingOwners(next, scopeMap, deps.available?.() ?? (() => true))) {
    deps.inbox.protectedPathTouched(owner, part.partId);
    told.add(owner);
  }
  for (const person of told) deps.notify(person);
  return { status: "ok", part: next, recordId: record.record_id, roundLimitRecordId: null };
}

/** A recorded review as a session hears of it. */
export function reviewResultNotice(review: StoredReview): ReviewResultNotice {
  return {
    reviewId: review.id,
    featureId: review.featureId,
    scopeId: review.scopeId,
    // Only a recorded review is told, and the runner's record makes it accepted or refused.
    state: review.state === "refused" ? "refused" : "accepted",
    refusals: review.refusals,
    exceptions: review.exceptions,
  };
}

/** Where a session's checkpoint reads its advance notice from. */
export function planNoticeSources(routes: PlanRouteStore, features: FeatureStore, reviews: ReviewStore): PlanNoticeSources {
  return {
    partsWaitingOn: (person): PlanPartNotice[] =>
      routes.waitingOn([person]).map(({ featureId, partId, revision, scopes }) => ({ featureId, partId, revision, scopes })),
    decisionsFor: (sessionId): PlanDecisionNotice[] => {
      const featureId = features.featureOfSession(sessionId);
      if (featureId === undefined) return [];
      return routes.ofFeature(featureId).flatMap(({ partId, revision, state }) =>
        state === "pending" ? [] : [{ featureId, partId, revision, state }],
      );
    },
    reviewsFor: (sessionId) => reviews.recordedFor(sessionId).map(reviewResultNotice),
  };
}

export interface PlanWorkDeps {
  readonly features: FeatureStore;
  readonly routes: PlanRouteStore;
  readonly reviews: ReviewStore;
  readonly keeper: (featureId: string) => PlanKeeper;
  /** The review policy in force and each part's route under it; absent, get_work names neither. */
  readonly policy?: PolicyInForce;
  readonly routeOf?: (plan: Plan, part: PlanPart) => Promise<PolicyRoute>;
}

/** A part of the session's own plan as `get_work` reports it. */
export interface OwnPlanPart {
  readonly partId: string;
  readonly revision: number;
  readonly place: PlanPlace;
  readonly owner: string;
  readonly kind: PlanPart["kind"];
  readonly state: PlanPartState;
  /** Who approved the current revision: its author, their delegate or `penguin`; null before. */
  readonly approvedBy: string | null;
  readonly changeRequests: number;
  readonly changeRequest: PlanPart["changeRequest"];
  /** The review policy's rule that sent the part to Penguin or a person, when known. */
  readonly route?: PolicyRoute;
}

/** What `get_work` reports of advance notice for one session. */
export interface PlanWork {
  /** The sandbox's review policy in force, when known. */
  readonly policy?: PolicyInForce;
  /** Parts whose current revision waits on the session's developer, each with its policy route when known. */
  readonly partsNeedingYou: readonly (PartRoute & { readonly route?: PolicyRoute })[];
  /** The newest plan of the feature the session works on, with where each part stands. */
  readonly ownPlan: { readonly planId: string; readonly roundLimit: number; readonly parts: readonly OwnPlanPart[] } | null;
  /** The runner's verdicts on the reviews the session submitted. */
  readonly reviews: readonly ReviewResultNotice[];
}

/** Advance notice for `get_work`: `person` owns session `sessionId`, which the caller checked. */
export async function planWork(deps: PlanWorkDeps, person: string, sessionId: string, roundLimit: number | undefined): Promise<PlanWork> {
  const featureId = deps.features.featureOfSession(sessionId);
  const plan = featureId === undefined ? undefined : await deps.keeper(featureId).latestPlan(featureId);
  const plans = new Map<string, Plan | undefined>();
  const routeOf = async (featureId: string, partId: string): Promise<{ readonly route?: PolicyRoute }> => {
    if (deps.routeOf === undefined) return {};
    if (!plans.has(featureId)) plans.set(featureId, await deps.keeper(featureId).latestPlan(featureId));
    const found = plans.get(featureId);
    const part = found?.parts.find((each) => each.partId === partId);
    if (found === undefined || part === undefined) return {};
    return { route: part.approvalState === "approved" && part.route ? part.route : await deps.routeOf(found, part) };
  };
  const waiting = deps.routes.waitingOn([person]);
  return {
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    partsNeedingYou: await Promise.all(waiting.map(async (route) => ({ ...route, ...(await routeOf(route.featureId, route.partId)) }))),
    ownPlan:
      plan === undefined
        ? null
        : {
            planId: plan.planId,
            roundLimit: roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT,
            parts: await Promise.all(
              plan.parts.map(async ({ partId, revision, place, owner, kind, approvalState, approvedBy, changeRequests, changeRequest }) => ({
                partId,
                revision,
                place,
                owner,
                kind,
                state: approvalState,
                approvedBy,
                changeRequests,
                changeRequest,
                ...(await routeOf(plan.featureId, partId)),
              })),
            ),
          },
    reviews: deps.reviews.recordedFor(sessionId).map(reviewResultNotice),
  };
}

export interface PlanInboxDeps {
  readonly routes: PlanRouteStore;
  readonly reviews: ReviewStore;
  readonly keeper: (featureId: string) => PlanKeeper;
  /** The person's inbox items, newest first (InboxStore.items). */
  readonly items: (person: string) => readonly InboxItem[];
  readonly scopeMap: () => Promise<ScopeMap>;
  readonly delegates: () => Promise<Delegates>;
  readonly roundLimit: number | undefined;
  /** PENGUIN_PLAN_ADMIN_MODE, which each part's routing names; off when absent. */
  readonly adminMode?: boolean;
  /** The sandbox's review policy in force; absent, Dev, or Production locked in admin mode. */
  readonly policy?: () => Promise<PolicyInForce>;
  /** The trial of a part's current revision, which the routing reads (part-trial.ts `trialStanding`). */
  readonly trial?: (featureId: string, part: PlanPart) => PartTrialStanding | undefined;
  /** Whether a feature's block has landed, after which Penguin's approvals stand; never when absent. */
  readonly landed?: (featureId: string) => boolean;
  /** The feature's signed records, which hold each returned plan (FeatureStore.records). */
  readonly records: (featureId: string) => readonly StoredFeatureRecord[];
  /**
   * The ids of the features `person` runs, whose plans' parts may route to them (#132). Absent, no
   * part of their own plan is listed for its stored data.
   */
  readonly ownFeatures?: (person: string) => readonly string[];
  /**
   * The features' own changes to paths one of `owners` protects (protected-change.ts
   * protectedChangeRequests), with `items` the viewer's inbox. Absent, none are listed.
   */
  readonly protectedChanges?: (owners: readonly string[], items: readonly InboxItem[], delegates: Delegates, scopeMap: ScopeMap) => readonly ProtectedChangeRequest[];
  /** The caller items on the person's worktrees the stage shows them (caller-items.ts ownerCallerItems); absent, none. */
  readonly callerItems?: (person: string, delegates: Delegates) => Promise<readonly CallerItemRequest[]>;
}

const REVIEW_REF = /^([^/]+)\/([^/]+)$/u;

/** The inbox reason behind each ask. */
const ASK_REASON: Readonly<Record<PlanPartAsk, InboxItem["reason"]>> = {
  approve: "plan_part",
  penguin_approved: "penguin_approved",
  protected_path: "protected_path",
  round_limit: "round_limit",
  // Listed from the caller's own plans, not from an inbox item.
  stored_data: "plan_part",
};

/**
 * The dashboard's plan parts for `caller`: the parts waiting on them as owner or delegate, the parts
 * Penguin approved for them, the parts that write a path they protect, the features whose own change
 * writes such a path, the parts of their own plans past the round limit, and the reviews of their
 * scopes that raised an exception, each with the facts behind it.
 */
export async function buildPlanInbox(deps: PlanInboxDeps, caller: string): Promise<PlanInbox> {
  const [scopeMap, delegates] = await Promise.all([deps.scopeMap(), deps.delegates()]);
  const inForce = deps.policy === undefined ? policyInForce(undefined, deps.adminMode ?? false) : await deps.policy();
  const items = deps.items(caller);
  const owners = [caller, ...[...delegates].flatMap(([owner, delegate]) => (delegate === caller && owner !== caller ? [owner] : []))];
  const asks = new Map<string, PlanPartAsk>();
  // Past the round limit the author may still approve the revision they have.
  for (const waiting of deps.routes.waitingOn(owners, ["pending", "round_limit"])) asks.set(waiting.partId, "approve");
  // An approved part is listed when Penguin approved it, below, and its block has not landed.
  for (const approved of deps.routes.waitingOn(owners, ["approved"])) {
    if (deps.landed?.(approved.featureId) !== true) asks.set(approved.partId, "penguin_approved");
  }
  for (const item of items) {
    const partId = parsePartRef(item.issueId);
    if (partId === undefined || asks.has(partId)) continue;
    if (item.reason === "protected_path") asks.set(partId, "protected_path");
    else if (item.reason === "round_limit") asks.set(partId, "round_limit");
  }

  const plans = new Map<string, Plan | undefined>();
  const planOf = async (featureId: string): Promise<Plan | undefined> => {
    if (!plans.has(featureId)) plans.set(featureId, await deps.keeper(featureId).latestPlan(featureId));
    return plans.get(featureId);
  };
  const routingOf = (plan: Plan, part: PlanPart): PartRouting =>
    routePart(plan, part, deps.reviews.list(plan.featureId), scopeMap, deps.adminMode ?? false, deps.trial?.(plan.featureId, part));
  // A pending part of the caller's own plan that routes to them for their change's stored data (#132).
  for (const featureId of deps.ownFeatures?.(caller) ?? []) {
    const plan = await planOf(featureId);
    for (const part of plan?.parts ?? []) {
      if (plan === undefined || asks.has(part.partId) || part.approvalState !== "pending") continue;
      if (routesToOriginator(routingOf(plan, part))) asks.set(part.partId, "stored_data");
    }
  }

  const parts: PlanPartRequest[] = [];
  for (const [partId, ask] of asks) {
    const routed = deps.routes.get(partId);
    const plan = routed === undefined ? undefined : await planOf(routed.featureId);
    const part = plan?.parts.find((each) => each.partId === partId);
    if (routed === undefined || plan === undefined || part === undefined) continue;
    // A part a person approved has left the list; only Penguin's approval stays, for its reversal.
    if (ask === "penguin_approved" && part.approvedBy !== PENGUIN_APPROVER) continue;
    const routing = routingOf(plan, part);
    // A part waiting on the originating person is not its author's to decide.
    if (ask === "approve" && part.approvalState === "pending" && plan.person !== part.owner && routesToOriginator(routing)) continue;
    const stored = deps.reviews.list(plan.featureId);
    const item = items.find((each) => each.issueId === `part:${partId}` && each.reason === ASK_REASON[ask]);
    parts.push({
      ask,
      feature: plan.featureId,
      person: plan.person,
      partId,
      revision: part.revision,
      place: part.place,
      owner: part.owner,
      kind: part.kind,
      kindReason: part.kindReason,
      state: part.approvalState,
      approvedBy: part.approvedBy,
      changeRequests: part.changeRequests,
      roundLimit: deps.roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT,
      files: partFiles(part),
      breaks: part.breaks.map(breakView),
      reviews: newestReviews(stored, part.scopes).map(reviewView),
      routing,
      route: part.approvalState === "approved" && part.route ? part.route : policyRoute(inForce, routing),
      changeRequest:
        part.changeRequest === null ? null : { by: part.changeRequest.by, revision: part.changeRequest.revision, text: part.changeRequest.text },
      read: item?.read ?? false,
      raisedAt: item?.raisedAt ?? routed.updatedAt,
    });
  }

  const reviewExceptions: ReviewExceptionRequest[] = items.flatMap((item) => {
    const ref = item.reason === "review_exception" ? REVIEW_REF.exec(item.issueId) : null;
    if (ref === null) return [];
    const [, featureId, scopeId] = ref;
    const review = deps.reviews
      .list(featureId as string)
      .filter((each) => each.scopeId === scopeId && each.state !== "pending" && each.exceptions.length > 0)
      .at(-1);
    if (review === undefined) return [];
    return [
      {
        feature: review.featureId,
        scope: review.scopeId,
        reviewId: review.id,
        state: review.state === "refused" ? "refused" : "accepted",
        exceptions: review.exceptions,
        review: reviewView(review),
        read: item.read,
        raisedAt: item.raisedAt,
      },
    ];
  });

  const returnedPlans: ReturnedPlanRequest[] = items.flatMap((item) => {
    const featureId = item.reason === "plan_returned" ? item.issueId.slice("plan:".length) : undefined;
    if (featureId === undefined) return [];
    const returned = deps
      .records(featureId)
      .map((kept) => JSON.parse(kept.file) as FeatureRecord)
      .filter((each) => each.type === "plan_returned")
      .at(-1);
    if (returned === undefined) return [];
    return [{ feature: featureId, ...returnedPayload(returned.payload), read: item.read, raisedAt: item.raisedAt }];
  });
  const protectedChanges = [...(deps.protectedChanges?.(owners, items, delegates, scopeMap) ?? [])];
  const callerItems = await deps.callerItems?.(caller, delegates);
  return { parts, protectedChanges, reviewExceptions, returnedPlans, teamExceptions: teamExceptions(deps, caller, scopeMap, delegates), ...(callerItems === undefined ? {} : { callerItems }) };
}

/**
 * Every exception in the scopes of the teams `lead` leads (#135), read-only: parts waiting on a
 * person, protected paths waiting for a confirmation and reviews that raised an exception, whoever
 * they wait on. Only a declared team counts; the lead of a one-person team is its owner, who sees
 * their own items already. Nothing here grants a decision: deciding stays with the person asked and
 * their delegate. Lines are left out; `mayReadPartLines` governs them where the person asked reads.
 */
export function teamExceptions(
  deps: Pick<PlanInboxDeps, "routes" | "reviews" | "items" | "protectedChanges">,
  lead: string,
  scopeMap: ScopeMap,
  delegates: Delegates,
): TeamExceptionView[] {
  const led = new Map(
    ledScopes(scopeMap, lead).flatMap((id) => {
      const team = scopeMap.teams.get(scopeMap.scopes.get(id)?.teamId ?? "");
      return team === undefined || team.implicit ? [] : [[id, team.id] as const];
    }),
  );
  if (led.size === 0) return [];
  const people = answerers({ ...scopeMap, scopes: new Map([...scopeMap.scopes].filter(([id]) => led.has(id))) });
  const teamOf = (scopes: readonly string[]): string | undefined => scopes.map((scope) => led.get(scope)).find((team) => team !== undefined);
  const out: TeamExceptionView[] = [];
  for (const route of deps.routes.waitingOn(people, ["pending", "round_limit"])) {
    const team = teamOf(route.scopes);
    if (team === undefined) continue;
    out.push({ kind: "plan_part", team, feature: route.featureId, ref: route.partId, scopes: route.scopes.filter((scope) => led.has(scope)), waitingOn: route.ownerId, state: route.state, raisedAt: route.updatedAt });
  }
  for (const request of deps.protectedChanges?.(people, [], delegates, scopeMap) ?? []) {
    const scopes = [...new Set(request.files.map((file) => file.scope))].filter((scope) => led.has(scope));
    const team = teamOf(scopes);
    if (team === undefined || request.state !== "pending") continue;
    out.push({ kind: "protected_path", team, feature: request.feature, ref: request.checkpoint, scopes, waitingOn: request.owner, state: request.state, raisedAt: request.raisedAt });
  }
  for (const person of people) {
    for (const item of deps.items(person)) {
      const ref = item.reason === "review_exception" ? REVIEW_REF.exec(item.issueId) : null;
      const team = ref === null ? undefined : led.get(ref[2] as string);
      if (ref === null || team === undefined) continue;
      out.push({ kind: "review_exception", team, feature: ref[1] as string, ref: item.issueId, scopes: [ref[2] as string], waitingOn: person, state: item.read ? "read" : "unread", raisedAt: item.raisedAt });
    }
  }
  return out.sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : 0));
}

/**
 * A `plan_returned` record's limit and the places it counted. A record from before #114 counted the
 * behavioural parts, under `behavioural`.
 */
export function returnedPayload(payload: Record<string, unknown>): { readonly breakLimit: number; readonly inPerson: readonly string[] } {
  const places = payload["in_person"] ?? payload["behavioural"];
  return { breakLimit: payload["break_limit"] as number, inPerson: Array.isArray(places) ? (places as string[]) : [] };
}

/** A part's diff as each file's lines, the way the dashboard shows changed lines. */
export function partFiles(part: Pick<PlanPart, "diff">): PlanPartFile[] {
  return part.diff.files.map((file) => ({ path: file.path, status: file.status, lines: file.hunks.flatMap((hunk) => hunk.lines) }));
}

export function breakView({ target, statement, nodeId, assertion, error }: PlanBreakFact): BreakView {
  return { target, statement, nodeId, assertion, error };
}

/** The newest review of each of `scopes`, in scope order: a newer form replaces an older one. */
export function newestReviews(reviews: readonly StoredReview[], scopes: readonly string[]): StoredReview[] {
  return scopes.flatMap((scope) => reviews.filter((review) => review.scopeId === scope).at(-1) ?? []);
}
