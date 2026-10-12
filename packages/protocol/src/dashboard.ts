// What the dashboard's PRD 0.4 views read (PRD section 10): the team of people with their features
// and agents (GET /api/team), one feature's page (GET /api/features/<id>/page), the review a plan
// part or a review exception carries in the approvals inbox (GET /api/plan-parts), and a review's
// full table of differing inputs (GET /api/reviews/<id>/differences).
//
// The ProjectAgent builds every view from its own state (services/project-agent/src/dashboard-views.ts
// and review-view.ts). No view carries an agent's session transcript: Penguin never holds one. Every
// string from a repository, a test run, a review form or a person is plain data here and renders as
// text.

import type { BlockCheck } from "./block-check.ts";
import type { ContractWorkView } from "./contract-sort.ts";
import type { EditAskReason, EditQueue, EditRouteVia, EditTaskKind, EditTaskState } from "./edit-task.ts";
import type { ImpactUse } from "./impact.ts";
import type { Plan, PlanFactSource, PlanFileDiff, PlanInvariantFact, PlanPart, PlanPartKind, PlanPartState, PlanPlace } from "./plan.ts";
import type { PlanPartFile } from "./plan-approval.ts";
import type { RunKind } from "./run-failure.ts";
import { REVIEW_REFUSAL_CODES, REVIEW_VERDICTS, type ReviewException, type ReviewRefusalCode, type ReviewVerdict } from "./review.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

/**
 * A feature's one-word state on the team view (PRD section 10). `building`: its agents work on the
 * fork. `planning`: its merge plan waits for the check runner's facts, was returned over the break
 * limit, or has a part its originating agent revises. `waiting on approvals`: its start waits for an
 * overlap approval, or a plan part waits for its author. `promoting`: every part of its plan is
 * approved, so the block goes to its checks. `promoted`: the block reached main.
 */
export const FEATURE_STATES = ["building", "planning", "waiting on approvals", "promoting", "promoted"] as const;
export type FeatureStateWord = (typeof FEATURE_STATES)[number];

/** An exception PRD section 7 routes to a person, which the team view highlights on its feature. */
export type FeatureException =
  | { readonly kind: "round_limit"; readonly partId: string }
  /** `inPerson`: the returned plan's parts that needed a person. */
  | { readonly kind: "plan_returned"; readonly inPerson: number; readonly breakLimit: number }
  | { readonly kind: "broken_invariant"; readonly scope: string; readonly invariant: string }
  | { readonly kind: "protected_difference"; readonly scope: string; readonly invariant: string; readonly differing: number }
  /** The check runner failed one of the feature's runs as often as the failure limit (run-failure.ts). */
  | { readonly kind: "run_failed"; readonly run: RunKind; readonly runId: string; readonly failures: number; readonly reason: string };

/** A scope as the dashboard names it: its name and the person who owns it. */
export interface DashboardScope {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
}

/** A person's role in `penguin/scopes.json`: what they own and how their scopes meet everyone else's. */
export interface PersonRole {
  readonly scopes: readonly DashboardScope[];
  /** Other people's scopes that depend on one of the person's scopes. */
  readonly dependents: readonly DashboardScope[];
  /** Other people's scopes that one of the person's scopes depends on. */
  readonly dependencies: readonly DashboardScope[];
}

/** An agent as every surface outside its agent card names it: its handle and its person. */
export interface DashboardAgent {
  readonly handle: string;
  /** The identity's id, which its agent card opens by; null when no identity holds the handle. */
  readonly identityId: string | null;
  readonly person: string;
  /** Whether a session of the identity runs on the feature (or anywhere, for an idle agent). */
  readonly online: boolean;
}

export interface TeamFeature {
  readonly id: string;
  readonly person: string;
  readonly state: FeatureStateWord;
  readonly exceptions: readonly FeatureException[];
  /** The agents whose sessions joined the feature. */
  readonly agents: readonly DashboardAgent[];
  readonly openedAt: string;
}

/**
 * A person's steward with their queue of edit tasks (PRD 0.5 section 4.4a): the team view shows the
 * counts on the steward. Absent from an older Worker.
 */
export interface StewardView extends EditQueue {
  readonly handle: string;
  readonly identityId: string;
  readonly online: boolean;
}

/** One edit task as the feature page and `get_work` show it (edit-work.ts in the ProjectAgent). */
export interface EditTaskView {
  readonly id: number;
  readonly kind: EditTaskKind;
  /** The feature whose work raised the task. */
  readonly feature: string;
  /** The feature whose fork the task edits, or whose plan a review form reviews. */
  readonly target: string;
  /** The tasks of one source share it; one block check covers them. */
  readonly block: string;
  /** The identity that takes it, or null while its person is asked. */
  readonly handle: string | null;
  readonly person: string;
  readonly via: EditRouteVia;
  readonly state: EditTaskState;
  readonly askReason: EditAskReason | null;
  readonly files: readonly string[];
  readonly scopes: readonly string[];
  readonly instructions: string;
  readonly verifier: string;
  /** The run's one-line outcome; never a transcript. */
  readonly outcome: string | null;
  readonly commit: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamPerson {
  readonly id: string;
  readonly role: PersonRole;
  /** The person's steward and queue; null when the person has none, absent from an older Worker. */
  readonly steward?: StewardView | null;
  /** The person's features, newest first. */
  readonly features: readonly TeamFeature[];
  /** The person's agents with no session on any of the person's features. */
  readonly idleAgents: readonly DashboardAgent[];
}

/** GET /api/team: every person, the signed-in person first. */
export interface TeamView {
  readonly people: readonly TeamPerson[];
}

/** A side-by-side outcome as a line of text: the value as JSON, or the exception raised. */
export interface SideBySideDifferenceView {
  readonly name: string;
  /** The input's keyword arguments as JSON, cut at REVIEW_VIEW_LIMITS.valueLength. */
  readonly args: string;
  readonly main: string;
  readonly fork: string;
}

/**
 * How a set's differing inputs spread over the length of one list in their arguments, such as an
 * order's `lines`. The list is the first one the first differing input holds, counted only when every
 * differing input holds a list at the same place (sideBySideBreakdown in
 * services/project-agent/src/review-view.ts).
 */
export interface SideBySideBreakdown {
  /** The list's key in the arguments, such as `lines`. */
  readonly list: string;
  /** How many differing inputs hold a list of each length, shortest first. */
  readonly counts: readonly { readonly length: number; readonly inputs: number }[];
}

export interface SideBySideSetView {
  readonly source: "examples" | "risky-inputs";
  readonly file: string | null;
  readonly contract: string;
  readonly invariants: readonly string[];
  readonly inputs: number;
  readonly differing: readonly SideBySideDifferenceView[];
  /** Differing inputs left out past REVIEW_VIEW_LIMITS.differencesPerSet. */
  readonly omitted: number;
  readonly invalid: number;
  /** Null when the differing inputs share no list or its lengths spread past REVIEW_VIEW_LIMITS.breakdownLengths. */
  readonly breakdown: SideBySideBreakdown | null;
}

/** The side-by-side run of one review, as the dashboard shows it. */
export interface SideBySideView {
  readonly tool: string;
  readonly commandId: string;
  readonly base: string;
  readonly fork: string;
  readonly totals: { readonly inputs: number; readonly differing: number; readonly invalid: number };
  readonly sets: readonly SideBySideSetView[];
}

export interface ReviewRowView {
  readonly invariant: string;
  /** The invariant's statement from `penguin/invariants.json`, or "" when the scope no longer declares it. */
  readonly statement: string;
  readonly protected: boolean;
  readonly verdict: ReviewVerdict;
  readonly evidence: readonly string[];
  readonly storedData: string;
}

/** One review form of a scope with the check runner's verdict (PRD section 6). */
export interface ReviewView {
  readonly reviewId: number;
  readonly feature: string;
  readonly scope: string;
  /** The reviewing agent's handle. */
  readonly reviewer: string;
  readonly state: "pending" | "accepted" | "refused";
  /** The fork commit the form was checked against. */
  readonly checkpoint: string;
  readonly rows: readonly ReviewRowView[];
  readonly storedDataMarker: { readonly kind: string; readonly evidence: string } | null;
  readonly riskyInputs: readonly { readonly name: string; readonly contract: string }[];
  readonly refusals: readonly { readonly code: ReviewRefusalCode; readonly message: string }[];
  /** Null until the check runner attaches its record. */
  readonly sideBySide: SideBySideView | null;
  readonly exceptions: readonly ReviewException[];
}

export const REVIEW_VIEW_LIMITS = {
  /** Characters kept of an input's arguments or an outcome. */
  valueLength: 300,
  /** Differing inputs shown per set. */
  differencesPerSet: 5,
  /** Distinct list lengths a breakdown counts; a wider spread gets no breakdown. */
  breakdownLengths: 32,
  /** Differing inputs per set in the full table of GET /api/reviews/<id>/differences. */
  differencesInTable: 10_000,
} as const;

/** One differing input in a review's full table: its name, each side's outcome and its list's length. */
export interface ReviewDifferenceRow {
  readonly name: string;
  readonly main: string;
  readonly fork: string;
  /** The length of the set's breakdown list in this input, or null when the set has no breakdown. */
  readonly length: number | null;
}

/** One set of a review's full table. */
export interface ReviewDifferenceSet {
  readonly contract: string;
  readonly file: string | null;
  /** The breakdown list's key, which names the table's length column; null for none. */
  readonly list: string | null;
  readonly differing: readonly ReviewDifferenceRow[];
  /** Differing inputs left out past REVIEW_VIEW_LIMITS.differencesInTable. */
  readonly omitted: number;
}

/**
 * GET /api/reviews/<id>/differences: every differing input of each set of a review's side-by-side
 * run, in the run's order, which a set's summary opens. Arguments are left out and outcomes are cut at
 * REVIEW_VIEW_LIMITS.valueLength, so the answer stays small next to the record.
 */
export interface ReviewDifferences {
  readonly reviewId: number;
  readonly sets: readonly ReviewDifferenceSet[];
}

/** A test that breaks on a merged tree, as a plan states it. */
export interface BreakView {
  readonly target: string;
  readonly statement: string;
  readonly nodeId: string;
  readonly assertion: string | null;
  readonly error: string | null;
}

export interface PlanPartView {
  readonly partId: string;
  readonly revision: number;
  readonly place: PlanPlace;
  readonly owner: string;
  readonly scopes: readonly string[];
  readonly kind: PlanPartKind;
  readonly kindReason: string;
  readonly state: PlanPartState;
  readonly approvedBy: string | null;
  readonly changeRequests: number;
  readonly changeRequest: { readonly by: string; readonly revision: number; readonly text: string } | null;
  readonly callers: readonly ImpactUse[];
  readonly breaks: readonly BreakView[];
  readonly invariants: readonly PlanInvariantFact[];
  readonly note: string | null;
  /**
   * The fix's changed lines, shown to the feature's person, the part's owner and that owner's
   * delegate; null for anyone else, who sees the part's place, state and facts only.
   */
  readonly files: readonly PlanPartFile[] | null;
}

export interface FeaturePlanView {
  readonly planId: string;
  readonly version: number;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly breakLimit: number;
  readonly roundLimit: number;
  readonly change: { readonly subject: string; readonly madeBy: string; readonly checkpoint: string };
  readonly sources: readonly PlanFactSource[];
  readonly contractDiff: {
    readonly complete: boolean;
    readonly contracts: readonly string[];
    readonly changes: readonly { readonly symbol: string; readonly kind: string; readonly change: string; readonly path: string; readonly line: number }[];
    readonly signatures: readonly { readonly symbol: string; readonly before: string; readonly after: string; readonly breaking: boolean }[];
    readonly dataShapes: readonly { readonly symbol: string; readonly before: readonly string[]; readonly after: readonly string[] }[];
  } | null;
  readonly mainCallers: readonly ImpactUse[];
  readonly affectedFeatures: readonly { readonly feature: string; readonly person: string; readonly uses: number; readonly breaks: number }[];
  readonly parts: readonly PlanPartView[];
}

/**
 * A feature's newest merge plan as GET /api/features/<id>/plan answers it to one viewer. A part's
 * patch and changed lines (`diff.patch`, `diff.files`) reach the feature's person, the part's owner
 * and that owner's delegate. For anyone else both are null and the rest of the part stays.
 */
export interface ViewerPlan extends Omit<Plan, "parts"> {
  readonly parts: readonly ViewerPlanPart[];
}

export interface ViewerPlanPart extends Omit<PlanPart, "diff"> {
  readonly diff: Omit<PlanPart["diff"], "files"> & { readonly files: readonly PlanFileDiff[] | null };
}

/** One agent tool call recorded on the feature (PRD 5.2), with what the tool reported. */
export interface ToolRunView {
  readonly id: number;
  readonly tool: string;
  readonly caller: string;
  readonly result: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number;
  /** The impact graph and contract diff, for `impact`. */
  readonly impact: {
    readonly tool: string;
    readonly commandId: string;
    readonly contracts: readonly string[];
    readonly changes: readonly { readonly symbol: string; readonly change: string; readonly path: string; readonly line: number }[];
    readonly forks: readonly { readonly id: string; readonly uses: number }[];
  } | null;
  /** The block checks, for `check`. */
  readonly checks: readonly BlockCheck[];
  /** One next step per failing check, for `check`. */
  readonly decisions: readonly { readonly target: string; readonly check: string; readonly step: number; readonly nextStep: string; readonly actor: string }[];
  /** The fix the runner made, for `apply_fix`. */
  readonly fix: { readonly commandId: string | null; readonly summary: string; readonly paths: readonly string[]; readonly pushed: boolean } | null;
}

/** A part whose fix goes into a running feature's fork (PRD 4.4), with where its write stands. */
export interface FixView {
  readonly partId: string;
  readonly feature: string;
  readonly person: string;
  readonly state: PlanPartState;
  /** Who approved the current revision: the person, their delegate or `penguin`; null before. */
  readonly approvedBy: string | null;
  readonly revision: number;
  /**
   * The write of the current revision: `queued` or `granted` while it waits for its commit, `written`
   * with the commit in the fork, `withdrawn` when the part moved on; null before any write was asked.
   */
  readonly write: {
    readonly state: "queued" | "granted" | "written" | "withdrawn";
    /** `agent` for the originating agent, `runner` for the check runner. */
    readonly writer: string;
    readonly commit: string | null;
    readonly rebased: boolean;
  } | null;
}

/** A feature's start that waits for, or got, another person's approval (PRD 4.1 step 3). */
export interface FeatureLockView {
  readonly feature: string;
  readonly person: string;
  readonly state: "open" | "approved";
  readonly approvedBy: string | null;
  readonly overlap: { readonly scopes: readonly string[]; readonly paths: readonly string[]; readonly contracts: readonly string[] };
}

export interface FeatureRecordView {
  readonly recordId: string;
  readonly type: string;
  /** The person, identity or Penguin that signed the record, as its record path names it. */
  readonly author: string;
  readonly createdAt: string;
  readonly path: string;
}

/** GET /api/features/<id>/page: the feature page (PRD section 10). */
export interface FeaturePage {
  readonly feature: {
    readonly id: string;
    readonly person: string;
    readonly repo: string | null;
    readonly state: FeatureStateWord;
    readonly openedAt: string;
    readonly latestCheckpoint: string | null;
    readonly area: { readonly scopes: readonly DashboardScope[]; readonly paths: readonly string[]; readonly contracts: readonly string[] };
  };
  readonly agents: readonly DashboardAgent[];
  /** The running features whose person approves this feature's start. */
  readonly waitingOn: readonly FeatureLockView[];
  /** Running features that read what this feature changes. */
  readonly dependents: readonly { readonly feature: string; readonly person: string; readonly consumerScope: string; readonly providerScope: string }[];
  readonly plan: FeaturePlanView | null;
  readonly reviews: readonly ReviewView[];
  /** Each part whose fix goes into another feature's fork, with its approval state and its write. */
  readonly fixes: readonly FixView[];
  /** The newest `check` run's block checks and next steps. */
  readonly checks: ToolRunView | null;
  readonly tools: readonly ToolRunView[];
  readonly records: readonly FeatureRecordView[];
  /** How Penguin sorted the latest checkpoint's contract diff, the split and the next step (contract-sort.ts); absent from an older Worker. */
  readonly contract?: ContractWorkView | null;
  /**
   * The edit tasks the feature raised or that edit its fork, oldest first: waiting branches on the
   * feature's timeline (#124). Absent from an older Worker.
   */
  readonly editTasks?: readonly EditTaskView[];
}

const text = (maxLength: number): JsonSchema => ({ type: "string", maxLength });
const COUNT: JsonSchema = { type: "integer", minimum: 0 };
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const SHA: JsonSchema = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const LIST_KEY = text(200);
const BREAKDOWN: JsonSchema = record({
  list: LIST_KEY,
  counts: { type: "array", maxItems: REVIEW_VIEW_LIMITS.breakdownLengths, items: record({ length: COUNT, inputs: COUNT }) },
});

/** JSON Schema (draft 2020-12) of one ReviewView, nested in the GET /api/plan-parts answer. */
export const REVIEW_VIEW_SCHEMA: JsonSchema = record({
  reviewId: COUNT,
  feature: text(63),
  scope: text(128),
  reviewer: text(256),
  state: { type: "string", enum: ["pending", "accepted", "refused"] },
  checkpoint: SHA,
  rows: list(
    record({
      invariant: text(64),
      statement: text(500),
      protected: { type: "boolean" },
      verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
      evidence: list(text(600)),
      storedData: text(2_000),
    }),
  ),
  storedDataMarker: { anyOf: [{ type: "null" }, record({ kind: text(16), evidence: text(600) })] },
  riskyInputs: list(record({ name: text(200), contract: text(512) })),
  refusals: list(record({ code: { type: "string", enum: [...REVIEW_REFUSAL_CODES] }, message: text(4_096) })),
  sideBySide: {
    anyOf: [
      { type: "null" },
      record({
        tool: text(64),
        commandId: text(64),
        base: SHA,
        fork: SHA,
        totals: record({ inputs: COUNT, differing: COUNT, invalid: COUNT }),
        sets: list(
          record({
            source: { type: "string", enum: ["examples", "risky-inputs"] },
            file: { anyOf: [{ type: "null" }, text(1_024)] },
            contract: text(512),
            invariants: list(text(128)),
            inputs: COUNT,
            differing: list(
              record({
                name: text(200),
                args: text(REVIEW_VIEW_LIMITS.valueLength + 1),
                main: text(REVIEW_VIEW_LIMITS.valueLength + 1),
                fork: text(REVIEW_VIEW_LIMITS.valueLength + 1),
              }),
            ),
            omitted: COUNT,
            invalid: COUNT,
            breakdown: { anyOf: [{ type: "null" }, BREAKDOWN] },
          }),
        ),
      }),
    ],
  },
  exceptions: list({
    anyOf: [
      record({ kind: { const: "broken_invariant" }, invariant: text(128), scope: text(128) }),
      record({ kind: { const: "protected_difference" }, invariant: text(128), scope: text(128), contract: text(512), differing: COUNT }),
    ],
  }),
});

/** JSON Schema of one BreakView, nested in the GET /api/plan-parts answer. */
export const BREAK_VIEW_SCHEMA: JsonSchema = record({
  target: text(64),
  statement: text(600),
  nodeId: text(512),
  assertion: { anyOf: [{ type: "null" }, text(300)] },
  error: { anyOf: [{ type: "null" }, text(300)] },
});

/** JSON Schema (draft 2020-12) for the GET /api/reviews/<id>/differences answer. */
export const REVIEW_DIFFERENCES_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin review differences",
  ...record({
    reviewId: COUNT,
    sets: list(
      record({
        contract: text(512),
        file: { anyOf: [{ type: "null" }, text(1_024)] },
        list: { anyOf: [{ type: "null" }, LIST_KEY] },
        differing: {
          type: "array",
          maxItems: REVIEW_VIEW_LIMITS.differencesInTable,
          items: record({
            name: text(200),
            main: text(REVIEW_VIEW_LIMITS.valueLength + 1),
            fork: text(REVIEW_VIEW_LIMITS.valueLength + 1),
            length: { anyOf: [{ type: "null" }, COUNT] },
          }),
        },
        omitted: COUNT,
      }),
    ),
  }),
};

export function checkReviewDifferences(value: unknown): SchemaError[] {
  return checkSchema(REVIEW_DIFFERENCES_SCHEMA, value);
}
