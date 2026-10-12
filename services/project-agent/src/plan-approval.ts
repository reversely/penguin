// Advance notice of a merge plan (PRD 0.4 sections 4.3 and 7): each part goes to its author and their
// running agents, the author approves it or asks for a change, a requested change goes back to the
// originating agent, which revises that part, and a part asked to change past the round limit goes to
// the originating feature's person.
//
// - Delivery. A stored plan reaches every author at once (announcePlan): a `plan_part` inbox item for
//   each part's owner, and each running session of that owner hears of the part at its next safe
//   checkpoint (session-store.ts PlanNotice). A part whose fix touches a path a scope's owner protects
//   in `penguin/scopes.json` also gives that owner a `protected_path` item. A newer plan of the feature
//   withdraws the older plan's items.
// - Decisions. Only a person decides a part, on the dashboard: the part's owner, or the delegate that
//   owner names in `penguin/owners.json`. Agents submit reviews (review-submit.ts) and never approve.
//   A decision names the part and the revision it saw. A decision by anyone else, on a part outside the
//   feature's newest plan, on another revision, or on a part already decided is refused. Each approval
//   and each request is a signed record on the originating feature, and the request's text is kept as
//   data of at most PLAN_LIMITS.changeRequestLength characters.
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
  PLAN_LIMITS,
  PLAN_ROUND_LIMIT_DEFAULT,
  type PartReviewResult,
  type Plan,
  type PlanInbox,
  type PlanPart,
  type PlanPartAsk,
  type PlanPartRequest,
  type PlanPartState,
  type PlanPlace,
  type ProtectedPathHit,
  type ReviewExceptionRequest,
} from "@penguin/protocol";
import type { Delegates } from "@penguin/issues";
import { protectedPathFor, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRejection } from "./feature-open.ts";
import { parseFeatureId, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import { parsePartRef, type InboxItem, type InboxStore } from "./inbox-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { PlanFactsStore } from "./plan-facts.ts";
import type { PlanKeeper } from "./plan-store.ts";
import { classifyFix, classifyFixPlace, parseFixFields, readFix, type AffectedPlace, type RepoReading } from "./propose-plan.ts";
import type { ReviewStore, StoredReview } from "./review-submit.ts";
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
      `INSERT INTO PlanPartRoute (part_id, plan_id, feature_id, owner_id, place, scopes, revision, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (part_id) DO UPDATE SET owner_id = excluded.owner_id, revision = excluded.revision,
         state = excluded.state, updated_at = excluded.updated_at`,
      part.partId,
      part.partId.slice(0, part.partId.lastIndexOf("#")),
      featureId,
      part.owner,
      JSON.stringify(part.place),
      JSON.stringify(part.scopes),
      part.revision,
      part.approvalState,
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

/** The inbox calls advance notice makes (inbox-store.ts). */
export type PlanInboxWrites = Pick<InboxStore, "planPartAsked" | "planPartSettled" | "protectedPathTouched" | "roundLimitReached" | "partWithdrawn">;

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
  readonly now?: () => number;
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

/** A protected-path lookup over `scopeMap`, naming each covering path's scope and that scope's owner. */
export function protectedLookup(scopeMap: ScopeMap): (path: string) => ProtectedPathHit | undefined {
  return (path) => {
    let hit;
    try {
      hit = protectedPathFor(scopeMap, path);
    } catch {
      return undefined;
    }
    const owner = hit === undefined ? undefined : scopeMap.scopes.get(hit.scopeId)?.ownerId;
    return hit === undefined || owner === undefined ? undefined : { scope: hit.scopeId, owner, path: hit.path };
  };
}

/** The people who protect a path the part's fix writes. */
function protectingOwners(part: PlanPart, scopeMap: ScopeMap): Set<string> {
  const lookup = protectedLookup(scopeMap);
  return new Set(part.diff.files.flatMap((file) => lookup(file.path)?.owner ?? []));
}

/**
 * Sends a stored plan to every author at once: each part's owner gets a `plan_part` item, each owner
 * of a protected path a part writes gets a `protected_path` item, and the older plan's items go.
 */
export function announcePlan(deps: Pick<PlanApprovalDeps, "routes" | "inbox" | "notify">, plan: Plan, scopeMap: ScopeMap): void {
  const told = new Set<string>();
  for (const old of deps.routes.announce(plan)) for (const person of deps.inbox.partWithdrawn(old.partId)) told.add(person);
  for (const part of plan.parts) {
    deps.inbox.planPartAsked(part.owner, part.partId);
    told.add(part.owner);
    for (const owner of protectingOwners(part, scopeMap)) {
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
  const refusal = (await decider(deps, caller, part)) ?? undecidable(part, true);
  if (refusal !== undefined) return refusal;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "approve_plan_part", { person: caller }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision: part.revision,
      place: part.place,
      diff: part.diff.ref,
      owner: part.owner,
      approved_by: caller,
    }),
  );
  const next: PlanPart = { ...part, approvalState: "approved", approvedBy: caller };
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
  const impact = plan.facts.run === null ? null : (deps.facts.get(plan.facts.run.runId)?.report?.impact ?? null);
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
  const read = await readFix(deps, { place: part.place, ...fix }, place, feature.repo, scopeMap, {});
  if ("code" in read) return rejected("invalid", `${read.code}: ${read.message}`);
  const kind = classifyFix(read.files, impact, classifyFixPlace(part.place));
  const revision = part.revision + 1;
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "revise_plan_part", { identity: live.session.handle }, {
      plan_id: plan.planId,
      part_id: part.partId,
      revision,
      answers: part.changeRequest?.recordId ?? null,
      place: part.place,
      diff: read.ref,
      kind: kind.kind,
    }),
  );
  const next: PlanPart = {
    ...part,
    revision,
    kind: kind.kind,
    kindReason: kind.reason,
    diff: read,
    note: fix.note,
    approvalState: "pending",
    approvedBy: null,
  };
  if (!(await deps.keeper(featureId).replacePart(featureId, next, { revision: part.revision, state: part.approvalState }))) {
    return rejected("conflict", `part ${part.partId} changed while it was revised; read it again`);
  }
  deps.features.addRecord(record);
  deps.routes.set(featureId, next);
  deps.inbox.planPartAsked(part.owner, part.partId);
  const told = new Set([part.owner]);
  for (const owner of protectingOwners(next, scopeMap)) {
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
}

/** A part of the session's own plan as `get_work` reports it. */
export interface OwnPlanPart {
  readonly partId: string;
  readonly revision: number;
  readonly place: PlanPlace;
  readonly owner: string;
  readonly kind: PlanPart["kind"];
  readonly state: PlanPartState;
  readonly changeRequests: number;
  readonly changeRequest: PlanPart["changeRequest"];
}

/** What `get_work` reports of advance notice for one session. */
export interface PlanWork {
  /** Parts whose current revision waits on the session's developer. */
  readonly partsNeedingYou: readonly PartRoute[];
  /** The newest plan of the feature the session works on, with where each part stands. */
  readonly ownPlan: { readonly planId: string; readonly roundLimit: number; readonly parts: readonly OwnPlanPart[] } | null;
  /** The runner's verdicts on the reviews the session submitted. */
  readonly reviews: readonly ReviewResultNotice[];
}

/** Advance notice for `get_work`: `person` owns session `sessionId`, which the caller checked. */
export async function planWork(deps: PlanWorkDeps, person: string, sessionId: string, roundLimit: number | undefined): Promise<PlanWork> {
  const featureId = deps.features.featureOfSession(sessionId);
  const plan = featureId === undefined ? undefined : await deps.keeper(featureId).latestPlan(featureId);
  return {
    partsNeedingYou: deps.routes.waitingOn([person]),
    ownPlan:
      plan === undefined
        ? null
        : {
            planId: plan.planId,
            roundLimit: roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT,
            parts: plan.parts.map(({ partId, revision, place, owner, kind, approvalState, changeRequests, changeRequest }) => ({
              partId,
              revision,
              place,
              owner,
              kind,
              state: approvalState,
              changeRequests,
              changeRequest,
            })),
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
}

const REVIEW_REF = /^([^/]+)\/([^/]+)$/u;

/**
 * The dashboard's plan parts for `caller`: the parts waiting on them as owner or delegate, the parts
 * that write a path they protect, the parts of their own plans past the round limit, and the reviews
 * of their scopes that raised an exception, each with the facts behind it.
 */
export async function buildPlanInbox(deps: PlanInboxDeps, caller: string): Promise<PlanInbox> {
  const [scopeMap, delegates] = await Promise.all([deps.scopeMap(), deps.delegates()]);
  const items = deps.items(caller);
  const owners = [caller, ...[...delegates].flatMap(([owner, delegate]) => (delegate === caller && owner !== caller ? [owner] : []))];
  const asks = new Map<string, PlanPartAsk>();
  // Past the round limit the author may still approve the revision they have.
  for (const waiting of deps.routes.waitingOn(owners, ["pending", "round_limit"])) asks.set(waiting.partId, "approve");
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
  const lookup = protectedLookup(scopeMap);
  const parts: PlanPartRequest[] = [];
  for (const [partId, ask] of asks) {
    const routed = deps.routes.get(partId);
    const plan = routed === undefined ? undefined : await planOf(routed.featureId);
    const part = plan?.parts.find((each) => each.partId === partId);
    if (routed === undefined || plan === undefined || part === undefined) continue;
    const reviews: PartReviewResult[] = deps.reviews.list(plan.featureId).map((review) => ({
      reviewId: review.id,
      scope: review.scopeId,
      state: review.state,
      exceptions: review.exceptions,
    }));
    const reason = ask === "approve" ? "plan_part" : ask;
    const item = items.find((each) => each.issueId === `part:${partId}` && each.reason === reason);
    parts.push({
      ask,
      feature: plan.featureId,
      person: plan.person,
      partId,
      revision: part.revision,
      place: part.place,
      owner: part.owner,
      kind: part.kind,
      state: part.approvalState,
      changeRequests: part.changeRequests,
      roundLimit: deps.roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT,
      files: part.diff.files.map((file) => ({ path: file.path, status: file.status, lines: file.hunks.flatMap((hunk) => hunk.lines) })),
      routing: partRouting(part, reviews, lookup),
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
        read: item.read,
        raisedAt: item.raisedAt,
      },
    ];
  });
  return { parts, reviewExceptions };
}
