// Advance notice of a merge plan (PRD 0.4 section 4.3): when a part needs its author in person, and
// what GET /api/plan-parts returns to the dashboard.
//
// Every author approves their own part once (PRD section 7, "A plan touches code in an author's
// scope"). `partRouting` says when the decision also needs the author in person, from three facts
// only (PRD 4.3 step 4): the review form of a scope the part touches reports a broken invariant, that
// review's side-by-side run differs on a protected invariant, or the part's diff touches a path a
// scope's owner protects in `penguin/scopes.json`. With none of them, the author's agent review stands
// and the author approves without a further exception.
//
// The ProjectAgent builds the dashboard answer (services/project-agent/src/plan-approval.ts); the
// Worker checks it against PLAN_INBOX_SCHEMA before answering, so a malformed field never reaches the
// page.

import { BREAK_VIEW_SCHEMA, REVIEW_VIEW_SCHEMA, type BreakView, type ReviewView } from "./dashboard.ts";
import { FEATURE_ID_MAX_LENGTH } from "./overlap.ts";
import { PERSON_ID_MAX_LENGTH, PERSON_ID_PATTERN, SEGMENT_PATTERN } from "./operation-schema.ts";
import { PLAN_LIMITS, PLAN_PART_KINDS, PLAN_PART_STATES, type PlanPart, type PlanPartKind, type PlanPartState, type PlanPlace } from "./plan.ts";
import type { ReviewException } from "./review.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/** One review of a scope as the routing reads it: the runner's verdict and the exceptions it raised. */
export interface PartReviewResult {
  readonly reviewId: number;
  readonly scope: string;
  /** `pending` until the check runner reports; a pending review raises nothing yet. */
  readonly state: "pending" | "accepted" | "refused";
  readonly exceptions: readonly ReviewException[];
}

/** A protected path that covers a file, with the scope that protects it and that scope's owner. */
export interface ProtectedPathHit {
  readonly scope: string;
  readonly owner: string;
  readonly path: string;
}

/** Why a part needs a person in person. */
export type PartRoutingReason =
  | { readonly kind: "broken_invariant"; readonly scope: string; readonly invariant: string; readonly reviewId: number }
  | {
      readonly kind: "protected_difference";
      readonly scope: string;
      readonly invariant: string;
      readonly contract: string;
      readonly differing: number;
      readonly reviewId: number;
    }
  | { readonly kind: "protected_path"; readonly scope: string; readonly owner: string; readonly path: string; readonly file: string };

export interface PartRouting {
  /** True when any reason holds: the decision needs a person, not only the agent's review. */
  readonly inPerson: boolean;
  readonly reasons: readonly PartRoutingReason[];
}

/**
 * The routing of PRD 4.3 step 4 for one part. `reviews` are the reviews submitted on the originating
 * feature; only the newest one of each scope the part touches counts, since a newer form replaces an
 * older one. `protectedFor` names the protected path covering a repository path, or undefined.
 */
export function partRouting(
  part: Pick<PlanPart, "scopes" | "diff">,
  reviews: readonly PartReviewResult[],
  protectedFor: (path: string) => ProtectedPathHit | undefined,
): PartRouting {
  const scopes = new Set(part.scopes);
  const newest = new Map<string, PartReviewResult>();
  for (const review of reviews) {
    if (!scopes.has(review.scope)) continue;
    const known = newest.get(review.scope);
    if (known === undefined || review.reviewId > known.reviewId) newest.set(review.scope, review);
  }
  const reasons: PartRoutingReason[] = [];
  for (const review of [...newest.values()].sort((a, b) => a.reviewId - b.reviewId)) {
    if (review.state === "pending") continue;
    for (const exception of review.exceptions) {
      reasons.push(
        exception.kind === "broken_invariant"
          ? { kind: "broken_invariant", scope: exception.scope, invariant: exception.invariant, reviewId: review.reviewId }
          : {
              kind: "protected_difference",
              scope: exception.scope,
              invariant: exception.invariant,
              contract: exception.contract,
              differing: exception.differing,
              reviewId: review.reviewId,
            },
      );
    }
  }
  for (const file of part.diff.files) {
    const hit = protectedFor(file.path);
    if (hit !== undefined) reasons.push({ kind: "protected_path", scope: hit.scope, owner: hit.owner, path: hit.path, file: file.path });
  }
  return { inPerson: reasons.length > 0, reasons };
}

/**
 * Why a part is in a person's list. `approve`: the person approves it, as its owner or the owner's
 * delegate. `protected_path`: it touches a path the person protects in a scope another person's part
 * covers, so they confirm the lines with that person. `round_limit`: it is a part of the person's own
 * plan that went past the round limit.
 */
export const PLAN_PART_ASKS = ["approve", "protected_path", "round_limit"] as const;
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
  /** The revision an approval or a requested change must name. */
  readonly revision: number;
  readonly place: PlanPlace;
  readonly owner: string;
  readonly kind: PlanPartKind;
  /** Why Penguin classified the fix this way. */
  readonly kindReason: string;
  readonly state: PlanPartState;
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

/** A plan of the person's feature returned over the break limit (`plan_returned`, PRD 4.2 step 5). */
export interface ReturnedPlanRequest {
  readonly feature: string;
  readonly breakLimit: number;
  /** The behavioural places the plan held, as `scope <id>` or `feature <id>`. */
  readonly behavioural: readonly string[];
  readonly read: boolean;
  readonly raisedAt: string;
}

export interface PlanInbox {
  readonly parts: readonly PlanPartRequest[];
  readonly reviewExceptions: readonly ReviewExceptionRequest[];
  readonly returnedPlans: readonly ReturnedPlanRequest[];
}

const FEATURE_ID: JsonSchema = { type: "string", pattern: `^${SEGMENT_PATTERN}$`, maxLength: FEATURE_ID_MAX_LENGTH };
const PERSON: JsonSchema = { type: "string", pattern: PERSON_ID_PATTERN, maxLength: PERSON_ID_MAX_LENGTH };
const TEXT: JsonSchema = { type: "string", maxLength: 1_024 };
const COUNT: JsonSchema = { type: "integer", minimum: 0 };
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
const REASON: JsonSchema = {
  anyOf: [
    record({ kind: { const: "broken_invariant" }, scope: TEXT, invariant: TEXT, reviewId: COUNT }),
    record({ kind: { const: "protected_difference" }, scope: TEXT, invariant: TEXT, contract: TEXT, differing: COUNT, reviewId: COUNT }),
    record({ kind: { const: "protected_path" }, scope: TEXT, owner: PERSON, path: TEXT, file: TEXT }),
  ],
};

/** JSON Schema (draft 2020-12) for the GET /api/plan-parts answer. */
export const PLAN_INBOX_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin plan parts",
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
        behavioural: { type: "array", items: TEXT },
        read: { type: "boolean" },
        raisedAt: { type: "string" },
      }),
    },
  }),
};

/** Where an answer breaks PLAN_INBOX_SCHEMA; empty when it conforms. */
export function checkPlanInbox(value: unknown): SchemaError[] {
  return checkSchema(PLAN_INBOX_SCHEMA, value);
}
