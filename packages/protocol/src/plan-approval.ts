// Advance notice of a merge plan (PRD 0.5 sections 4.2 step 4, 4.3 and 7): who approves each part, and
// what GET /api/plan-parts returns to the dashboard.
//
// `partRouting` checks one part against the five conditions of PRD 4.3 step 3, from facts Penguin
// already holds. Penguin approves the part when every check is clean; any reason sends the part to its
// author in person. A check whose result is absent is a reason too: Penguin never approves on a
// missing result.
//
// 1. Tests. The plan's facts run reports each of the part's scopes as `passed` on the merged tree of
//    the part's place, and that tree holds the part's fix (PartTestEvidence.fixInTree).
// 2. Review. The newest review of each of the part's scopes was submitted on the plan's checkpoint,
//    the check runner accepted it, and every row of its form says the invariant holds.
// 3. Side by side. That review's run shows no difference on a protected invariant.
// 4. Protected paths. The part's diff touches no path a scope's owner protects in `penguin/scopes.json`.
// 5. Place. Every file the diff changes lies in the part's scopes, and a fix commit changes no file
//    outside them.
//
// The stored data rule (PRD 0.5 section 6 item 5, #132) adds one more. A review whose scope only reads
// a stored shape the change reshapes, one another scope owns, is covered by the migration or backfill
// the plan declares in the originating change (`Plan.storeMarker`). Without one the part needs a
// person, and that person is the originating feature's, not the reader: the missing work is in the
// originator's change (`routesToOriginator`). A scope that persists data derived from the store owns
// that shape itself, and its own form names its cutover marker (review.ts storedDataProblem).
//
// Admin mode, a project setting, makes every part need a person, and an author's reversal of
// Penguin's approval makes that revision need them. The break limit (PRD 4.2 step 4) counts the parts
// needing a person (`needsPerson`): a review not yet submitted, pending or of an older checkpoint is
// waited for, not counted. The originating feature's own change to a protected path is not a part:
// it reaches the protecting person as a `ProtectedChangeRequest`.
//
// The ProjectAgent builds the dashboard answer (services/project-agent/src/plan-approval.ts); the
// Worker checks it against PLAN_INBOX_SCHEMA before answering, so a malformed field never reaches the
// page.

import { BREAK_VIEW_SCHEMA, REVIEW_VIEW_SCHEMA, type BreakView, type ReviewView } from "./dashboard.ts";
import { FEATURE_ID_MAX_LENGTH } from "./overlap.ts";
import { PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN, SEGMENT_PATTERN } from "./operation-schema.ts";
import {
  PLAN_LIMITS,
  PLAN_PART_KINDS,
  PLAN_PART_STATES,
  PLAN_RESULT_STATUSES,
  type PlanPart,
  type PlanPartKind,
  type PlanPartState,
  type PlanPlace,
  type PlanResultStatus,
} from "./plan.ts";
import type { ReviewException, StoredShapeChange } from "./review.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/** One review of a scope as the routing reads it: the runner's verdict and the exceptions it raised. */
export interface PartReviewResult {
  readonly reviewId: number;
  readonly scope: string;
  /** The originating feature's checkpoint the form was checked against. */
  readonly forkSha: string;
  /** `pending` until the check runner reports; a pending review raises nothing yet. */
  readonly state: "pending" | "accepted" | "refused";
  readonly exceptions: readonly ReviewException[];
  /** The invariants whose row in the form says `breaks` or `unknown`. */
  readonly notHolding: readonly string[];
  /**
   * The changed stored shapes the scope only reads, each owned by another scope (review.ts
   * readOnlyShapes); absent is none.
   */
  readonly readShapes?: readonly StoredShapeChange[];
}

/** A protected path that covers a file, with the scope that protects it and that scope's owner. */
export interface ProtectedPathHit {
  readonly scope: string;
  readonly owner: string;
  readonly path: string;
}

/**
 * Where a review stands when it stops Penguin's approval. `missing`, `pending` and `stale` (a form on an
 * older checkpoint) wait for the author's agent; `refused` and `not_holding` fail the check.
 */
export const REVIEW_CHECK_STATES = ["missing", "pending", "stale", "refused", "not_holding"] as const;
export type ReviewCheckState = (typeof REVIEW_CHECK_STATES)[number];

/**
 * A test check that is not clean: a facts-run status other than `passed`, `missing` for a scope with no
 * result, or `fix_not_run` when the tested tree does not hold the part's fix.
 */
export type TestCheckStatus = Exclude<PlanResultStatus, "passed"> | "missing" | "fix_not_run";

/** Why a part needs a person in person. */
export type PartRoutingReason =
  | { readonly kind: "admin_mode" }
  | { readonly kind: "reversed"; readonly by: string }
  | { readonly kind: "tests"; readonly scope: string | null; readonly status: TestCheckStatus; readonly breaks: number }
  | { readonly kind: "review"; readonly scope: string; readonly state: ReviewCheckState; readonly reviewId: number | null; readonly invariant: string | null }
  | { readonly kind: "broken_invariant"; readonly scope: string; readonly invariant: string; readonly reviewId: number }
  | {
      readonly kind: "protected_difference";
      readonly scope: string;
      readonly invariant: string;
      readonly contract: string;
      readonly differing: number;
      readonly reviewId: number;
    }
  | { readonly kind: "protected_path"; readonly scope: string; readonly owner: string; readonly path: string; readonly file: string }
  /** `file` is null when the part's files outside its scopes were never recorded. */
  | { readonly kind: "outside_place"; readonly file: string | null }
  /**
   * The review's scope only reads `symbol`, a stored shape `store` owns that the change reshapes, and
   * the plan declares no migration or backfill for it. Goes to the originating feature's person.
   */
  | {
      readonly kind: "stored_data_unmarked";
      readonly scope: string;
      readonly symbol: string;
      readonly path: string;
      readonly store: string | null;
      readonly reviewId: number;
    };

export interface PartRouting {
  /** True when any reason holds: a person decides the part, and Penguin does not approve it. */
  readonly inPerson: boolean;
  readonly reasons: readonly PartRoutingReason[];
}

/** What the routing reads besides the part: the plan's checkpoint, its reviews and the project's mode. */
export interface PartEvidence {
  /** The reviews submitted on the originating feature, any scope, any order. */
  readonly reviews: readonly PartReviewResult[];
  /** The originating checkpoint the plan was proposed on; a review of another checkpoint is stale. */
  readonly checkpoint: string;
  /** The project requires a person for every part. */
  readonly adminMode: boolean;
  /** The plan declares a migration or backfill in the originating change (`Plan.storeMarker`). */
  readonly storeMarked?: boolean;
}

function testReasons(part: Pick<PlanPart, "scopes" | "tests" | "breaks">): PartRoutingReason[] {
  const tests = part.tests;
  if (tests === undefined || tests === null) {
    return part.scopes.map((scope) => ({ kind: "tests", scope, status: "missing", breaks: 0 }));
  }
  const reasons: PartRoutingReason[] = [];
  if (!tests.fixInTree) reasons.push({ kind: "tests", scope: null, status: "fix_not_run", breaks: part.breaks.length });
  for (const scope of part.scopes) {
    const results = tests.results.filter((result) => result.scopeId === scope);
    if (results.length === 0) reasons.push({ kind: "tests", scope, status: "missing", breaks: 0 });
    for (const result of results) {
      if (result.status !== "passed") reasons.push({ kind: "tests", scope, status: result.status, breaks: result.breaks });
    }
  }
  return reasons;
}

function reviewReasons(scopes: readonly string[], evidence: PartEvidence): PartRoutingReason[] {
  const reasons: PartRoutingReason[] = [];
  for (const scope of scopes) {
    const newest = evidence.reviews.filter((review) => review.scope === scope).sort((a, b) => b.reviewId - a.reviewId)[0];
    if (newest === undefined) {
      reasons.push({ kind: "review", scope, state: "missing", reviewId: null, invariant: null });
      continue;
    }
    if (newest.state === "pending") {
      reasons.push({ kind: "review", scope, state: newest.forkSha === evidence.checkpoint ? "pending" : "stale", reviewId: newest.reviewId, invariant: null });
      continue;
    }
    const broken = new Set<string>();
    for (const exception of newest.exceptions) {
      if (exception.kind === "broken_invariant") {
        broken.add(exception.invariant);
        reasons.push({ kind: "broken_invariant", scope: exception.scope, invariant: exception.invariant, reviewId: newest.reviewId });
      } else {
        reasons.push({
          kind: "protected_difference",
          scope: exception.scope,
          invariant: exception.invariant,
          contract: exception.contract,
          differing: exception.differing,
          reviewId: newest.reviewId,
        });
      }
    }
    if (newest.forkSha !== evidence.checkpoint) reasons.push({ kind: "review", scope, state: "stale", reviewId: newest.reviewId, invariant: null });
    else if (newest.state === "refused") reasons.push({ kind: "review", scope, state: "refused", reviewId: newest.reviewId, invariant: null });
    if (newest.forkSha === evidence.checkpoint && evidence.storeMarked !== true) {
      for (const shape of newest.readShapes ?? []) {
        reasons.push({ kind: "stored_data_unmarked", scope, symbol: shape.symbol, path: shape.path, store: shape.scope ?? null, reviewId: newest.reviewId });
      }
    }
    for (const invariant of newest.notHolding) {
      if (!broken.has(invariant)) reasons.push({ kind: "review", scope, state: "not_holding", reviewId: newest.reviewId, invariant });
    }
  }
  return reasons;
}

/**
 * The files the part may change: its place's scopes. For code on main that is the scope's paths, tests
 * included, since a fix that moves a scope's own tests onto the new API stays inside the scope. For a
 * running feature it is the scopes the feature's own changes reach, where its patch must lie. A
 * commit that changes anything outside them, or a part whose outside files were never recorded,
 * leaves its place.
 */
function placeReasons(part: Pick<PlanPart, "scopes" | "diff">): PartRoutingReason[] {
  const outside = part.diff.outside;
  if (outside === undefined) return [{ kind: "outside_place", file: null }];
  const scopes = new Set(part.scopes);
  const reasons: PartRoutingReason[] = outside.map((file) => ({ kind: "outside_place", file }));
  for (const file of part.diff.files) {
    if (file.scopeId === null || !scopes.has(file.scopeId)) reasons.push({ kind: "outside_place", file: file.path });
  }
  return reasons;
}

/**
 * PRD 4.3 for one part: every reason it needs its author in person, or none when Penguin approves it.
 * Only the newest review of each scope the part touches counts, since a newer form replaces an older
 * one. `protectedFor` names the protected path covering a repository path, or undefined.
 */
export function partRouting(
  part: Pick<PlanPart, "scopes" | "diff" | "breaks" | "tests" | "revision" | "reversal">,
  evidence: PartEvidence,
  protectedFor: (path: string) => ProtectedPathHit | undefined,
): PartRouting {
  const reasons: PartRoutingReason[] = [];
  if (evidence.adminMode) reasons.push({ kind: "admin_mode" });
  const reversal = part.reversal;
  if (reversal !== undefined && reversal !== null && reversal.revision === part.revision) reasons.push({ kind: "reversed", by: reversal.by });
  reasons.push(...testReasons(part), ...reviewReasons(part.scopes, evidence));
  for (const file of part.diff.files) {
    const hit = protectedFor(file.path);
    if (hit !== undefined) reasons.push({ kind: "protected_path", scope: hit.scope, owner: hit.owner, path: hit.path, file: file.path });
  }
  reasons.push(...placeReasons(part));
  return { inPerson: reasons.length > 0, reasons };
}

/** A review the author's agent has yet to submit, or the runner has yet to record: waited for, not failed. */
export function isWaitingReason(reason: PartRoutingReason): boolean {
  return reason.kind === "review" && (reason.state === "missing" || reason.state === "pending" || reason.state === "stale");
}

/** PRD 4.2 step 4: the part fails a condition of section 4.3, so it counts against the break limit. */
export function needsPerson(routing: PartRouting): boolean {
  return routing.reasons.some((reason) => !isWaitingReason(reason));
}

/**
 * Whether the part waits on the originating feature's person rather than its author: its one failing
 * condition is stored data it only reads, which the originating change reshapes with no migration or
 * backfill (#132). The author is not asked; the originating person adds one, or approves without it.
 */
export function routesToOriginator(routing: PartRouting): boolean {
  const failing = routing.reasons.filter((reason) => !isWaitingReason(reason));
  return failing.length > 0 && failing.every((reason) => reason.kind === "stored_data_unmarked");
}

/**
 * Why a part is in a person's list. `approve`: the person approves it, as its owner or the owner's
 * delegate. `penguin_approved`: Penguin approved the person's part, which they may reverse until the
 * block lands. `protected_path`: it touches a path the person protects in a scope another person's
 * part covers, so they confirm the lines with that person. `round_limit`: it is a part of the person's
 * own plan that went past the round limit. `stored_data`: it is a part of the person's own plan that
 * waits on them, because their change reshapes stored data the part's scope only reads and the plan
 * declares no migration or backfill (`routesToOriginator`); they approve it, or add one and propose again.
 */
export const PLAN_PART_ASKS = ["approve", "penguin_approved", "protected_path", "round_limit", "stored_data"] as const;
export type PlanPartAsk = (typeof PLAN_PART_ASKS)[number];

/** One file of a part's proposed fix, with its diff lines, each prefixed with " ", "-" or "+". */
export interface PlanPartFile {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified";
  readonly lines: readonly string[];
}

/** One plan part as the dashboard lists it for the signed-in person. */
export interface PlanPartRequest {
  readonly ask: PlanPartAsk;
  /** The originating feature and its person. */
  readonly feature: string;
  readonly person: string;
  readonly partId: string;
  /** The revision an approval, a reversal or a requested change must name. */
  readonly revision: number;
  readonly place: PlanPlace;
  readonly owner: string;
  readonly kind: PlanPartKind;
  /** Why Penguin classified the fix this way. */
  readonly kindReason: string;
  readonly state: PlanPartState;
  /** Who approved the current revision: a person, `penguin`, or null. */
  readonly approvedBy: string | null;
  readonly changeRequests: number;
  readonly roundLimit: number;
  readonly files: readonly PlanPartFile[];
  /** The tests that break in the part's place once the change merges, as the plan states them. */
  readonly breaks: readonly BreakView[];
  /** The newest review of each scope the part touches, with its form and side-by-side run. */
  readonly reviews: readonly ReviewView[];
  readonly routing: PartRouting;
  /** The latest requested change: who asked, for which revision, and their words as data. */
  readonly changeRequest: { readonly by: string; readonly revision: number; readonly text: string } | null;
  readonly read: boolean;
  readonly raisedAt: string;
}

/** A review of the person's scope whose record raised an exception (`review_exception`). */
export interface ReviewExceptionRequest {
  readonly feature: string;
  readonly scope: string;
  readonly reviewId: number;
  readonly state: "accepted" | "refused";
  readonly exceptions: readonly ReviewException[];
  /** The review with its form and side-by-side run. */
  readonly review: ReviewView;
  readonly read: boolean;
  readonly raisedAt: string;
}

/** A plan of the person's feature returned over the break limit (`plan_returned`, PRD 4.2 step 4). */
export interface ReturnedPlanRequest {
  readonly feature: string;
  readonly breakLimit: number;
  /** The places of the parts needing a person, as `scope <id>` or `feature <id>`. */
  readonly inPerson: readonly string[];
  readonly read: boolean;
  readonly raisedAt: string;
}

/**
 * A feature's own change since its merge base with main that touches paths the person protects
 * (`protected_path`, PRD 4.3 step 4). The feature cannot land until the person, or their delegate,
 * confirms the lines at the feature's latest checkpoint. A person's own features raise none.
 */
export interface ProtectedChangeRequest {
  /** The feature whose own change touches the paths, and its person. */
  readonly feature: string;
  readonly person: string;
  /** The person who protects the paths and confirms the lines. */
  readonly owner: string;
  /** The checkpoint whose change the lines are, and the merge base they are measured from. */
  readonly checkpoint: string;
  readonly mergeBase: string;
  readonly state: ProtectedChangeState;
  readonly confirmedBy: string | null;
  /** Each changed file under a protected path, with its lines; `lines` is null for a viewer the line rule (PRD 13) leaves out. */
  readonly files: readonly ProtectedChangeFile[];
  readonly read: boolean;
  readonly raisedAt: string;
}

export const PROTECTED_CHANGE_STATES = ["pending", "confirmed"] as const;
export type ProtectedChangeState = (typeof PROTECTED_CHANGE_STATES)[number];

export interface ProtectedChangeFile {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified";
  readonly scope: string;
  /** The protected path in `penguin/scopes.json` that covers the file. */
  readonly protectedPath: string;
  readonly lines: readonly string[] | null;
}

export const TEAM_EXCEPTION_KINDS = ["plan_part", "protected_path", "review_exception"] as const;
export type TeamExceptionKind = (typeof TEAM_EXCEPTION_KINDS)[number];

/**
 * One exception in a scope of a team the viewer leads (#135), read-only: the lead sees it and decides
 * nothing. It names who it waits on, not the changed lines.
 */
export interface TeamExceptionView {
  readonly kind: TeamExceptionKind;
  /** The declared team whose scope it is in. */
  readonly team: string;
  readonly feature: string;
  /** The part id, the checkpoint a protected change waits at, or the review's inbox reference. */
  readonly ref: string;
  /** The team's scopes it concerns. */
  readonly scopes: readonly string[];
  /** The person it is routed to: the scope's DRI, or the fallback standing in. */
  readonly waitingOn: string;
  /** A part's state, `pending` for a protected change, `read` or `unread` for a review exception. */
  readonly state: string;
  readonly raisedAt: string;
}

export interface PlanInbox {
  readonly parts: readonly PlanPartRequest[];
  readonly protectedChanges: readonly ProtectedChangeRequest[];
  readonly reviewExceptions: readonly ReviewExceptionRequest[];
  readonly returnedPlans: readonly ReturnedPlanRequest[];
  /** The exceptions in the scopes of the teams the viewer leads, read-only. Absent from an older Worker. */
  readonly teamExceptions?: readonly TeamExceptionView[];
}

const FEATURE_ID: JsonSchema = { type: "string", pattern: `^${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH };
const PERSON: JsonSchema = { type: "string", pattern: PERSON_ID_PATTERN, maxLength: PERSON_ID_MAX_LENGTH };
const TEXT: JsonSchema = { type: "string", maxLength: 1_024 };
const COUNT: JsonSchema = { type: "integer", minimum: 0 };
const SHA: JsonSchema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const NULLABLE = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const EXCEPTION: JsonSchema = {
  anyOf: [
    record({ kind: { const: "broken_invariant" }, invariant: TEXT, scope: TEXT }),
    record({ kind: { const: "protected_difference" }, invariant: TEXT, scope: TEXT, contract: TEXT, differing: COUNT }),
  ],
};
const TEST_STATUSES = [...PLAN_RESULT_STATUSES.filter((status) => status !== "passed"), "missing", "fix_not_run"];
const REASON: JsonSchema = {
  anyOf: [
    record({ kind: { const: "admin_mode" } }),
    record({ kind: { const: "reversed" }, by: PERSON }),
    record({ kind: { const: "tests" }, scope: NULLABLE(TEXT), status: { type: "string", enum: TEST_STATUSES }, breaks: COUNT }),
    record({ kind: { const: "review" }, scope: TEXT, state: { type: "string", enum: [...REVIEW_CHECK_STATES] }, reviewId: NULLABLE(COUNT), invariant: NULLABLE(TEXT) }),
    record({ kind: { const: "broken_invariant" }, scope: TEXT, invariant: TEXT, reviewId: COUNT }),
    record({ kind: { const: "protected_difference" }, scope: TEXT, invariant: TEXT, contract: TEXT, differing: COUNT, reviewId: COUNT }),
    record({ kind: { const: "protected_path" }, scope: TEXT, owner: PERSON, path: TEXT, file: TEXT }),
    record({ kind: { const: "outside_place" }, file: NULLABLE(TEXT) }),
    record({ kind: { const: "stored_data_unmarked" }, scope: TEXT, symbol: TEXT, path: TEXT, store: NULLABLE(TEXT), reviewId: COUNT }),
  ],
};

/** The plan inbox fields every Worker answers with, all required. */
const INBOX_FIELDS = {
  ...record({
    parts: {
      type: "array",
      items: record({
        ask: { type: "string", enum: [...PLAN_PART_ASKS] },
        feature: FEATURE_ID,
        person: PERSON,
        partId: { type: "string", maxLength: 128 },
        revision: { type: "integer", minimum: 1 },
        place: {
          anyOf: [record({ kind: { const: "scope" }, scope: TEXT }), record({ kind: { const: "feature" }, feature: FEATURE_ID })],
        },
        owner: PERSON,
        kind: { type: "string", enum: [...PLAN_PART_KINDS] },
        kindReason: TEXT,
        state: { type: "string", enum: [...PLAN_PART_STATES] },
        approvedBy: NULLABLE(PERSON),
        changeRequests: COUNT,
        roundLimit: { type: "integer", minimum: 1 },
        files: {
          type: "array",
          maxItems: PLAN_LIMITS.diffFiles,
          items: record({
            path: TEXT,
            status: { type: "string", enum: ["added", "deleted", "modified"] },
            lines: { type: "array", items: { type: "string", maxLength: PLAN_LIMITS.diffLineLength + 1 } },
          }),
        },
        breaks: { type: "array", items: BREAK_VIEW_SCHEMA },
        reviews: { type: "array", items: REVIEW_VIEW_SCHEMA },
        routing: record({ inPerson: { type: "boolean" }, reasons: { type: "array", items: REASON } }),
        changeRequest: {
          anyOf: [
            record({ by: PERSON, revision: { type: "integer", minimum: 1 }, text: { type: "string", maxLength: PLAN_LIMITS.changeRequestLength } }),
            { type: "null" },
          ],
        },
        read: { type: "boolean" },
        raisedAt: { type: "string" },
      }),
    },
    protectedChanges: {
      type: "array",
      items: record({
        feature: FEATURE_ID,
        person: PERSON,
        owner: PERSON,
        checkpoint: SHA,
        mergeBase: SHA,
        state: { type: "string", enum: [...PROTECTED_CHANGE_STATES] },
        confirmedBy: { anyOf: [PERSON, { type: "null" }] },
        files: {
          type: "array",
          maxItems: PLAN_LIMITS.diffFiles,
          items: record({
            path: TEXT,
            status: { type: "string", enum: ["added", "deleted", "modified"] },
            scope: TEXT,
            protectedPath: TEXT,
            lines: {
              anyOf: [{ type: "array", items: { type: "string", maxLength: PLAN_LIMITS.diffLineLength + 1 } }, { type: "null" }],
            },
          }),
        },
        read: { type: "boolean" },
        raisedAt: { type: "string" },
      }),
    },
    reviewExceptions: {
      type: "array",
      items: record({
        feature: FEATURE_ID,
        scope: TEXT,
        reviewId: COUNT,
        state: { type: "string", enum: ["accepted", "refused"] },
        exceptions: { type: "array", items: EXCEPTION },
        review: REVIEW_VIEW_SCHEMA,
        read: { type: "boolean" },
        raisedAt: { type: "string" },
      }),
    },
    returnedPlans: {
      type: "array",
      items: record({
        feature: FEATURE_ID,
        breakLimit: { type: "integer", minimum: 1 },
        inPerson: { type: "array", items: TEXT },
        read: { type: "boolean" },
        raisedAt: { type: "string" },
      }),
    },
  }),
} as { readonly properties: Record<string, JsonSchema> };

/** JSON Schema (draft 2020-12) for the GET /api/plan-parts answer. `teamExceptions` may be absent. */
export const PLAN_INBOX_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin plan parts",
  ...INBOX_FIELDS,
  properties: {
    ...INBOX_FIELDS.properties,
    teamExceptions: {
      type: "array",
      items: record({
        kind: { type: "string", enum: [...TEAM_EXCEPTION_KINDS] },
        team: TEXT,
        feature: FEATURE_ID,
        ref: TEXT,
        scopes: { type: "array", items: TEXT },
        waitingOn: PERSON,
        state: TEXT,
        raisedAt: { type: "string" },
      }),
    },
  },
};

/** Where an answer breaks PLAN_INBOX_SCHEMA; empty when it conforms. */
export function checkPlanInbox(value: unknown): SchemaError[] {
  return checkSchema(PLAN_INBOX_SCHEMA, value);
}
