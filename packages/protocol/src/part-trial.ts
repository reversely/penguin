// Part trials (PRD 0.5 sections 4.3 and 6): each revision of a plan part tested on the tree it would
// land as, before anyone approves it.
//
// The check runner builds the trial tree from the part's place: the affected running feature's fork
// head, or main at the plan's baseline for a scope on main. It applies the part's proposed patch to
// the fork head, merges the originating checkpoint, and applies the part's fix commit on top for a
// scope on main. On that tree it runs each of the part's scopes' tests, and the review harness for the
// newest form each scope's agent submitted: the evidence check, the stored data rule and the
// side-by-side run. The harness compares the place before the part (the target) with the trial
// tree, and reads the scope's invariants and examples at the target, so a running feature's own
// declared examples run. Penguin keeps the report against the part revision, so the approval checks
// of PRD 4.3 step 3 read a fix that a run has tested. A new revision, or a newer form, asks for a new
// trial; the older one no longer counts.
//
// Every string from a repository or a run is length-limited here and kept as data.

import { PLAN_LIMITS, PLAN_RESULT_STATUSES, type PlanResultStatus } from "./plan.ts";
import {
  boundReviewRecord,
  parseReviewRecord,
  reviewExceptions,
  type InvariantView,
  type ReviewException,
  type ReviewForm,
  type ReviewRecord,
} from "./review.ts";
import { checkSchema, type JsonSchema } from "./schema-check.ts";

export const PART_TRIAL_SCHEMA_VERSION = 1;

/**
 * The place a trial tree starts from, and the review harness's base: `main` at the plan's baseline,
 * or a running feature's fork head.
 */
export interface PartTrialTarget {
  /** `main`, or the running feature's id. */
  readonly id: string;
  /** The repo the commit is fetched from, without the deployment's prefix: `base` or `feature-<id>`. */
  readonly repo: string;
  readonly sha: string;
}

/**
 * The part's fix. A commit in the originating fork is applied as its own change against `base`, on top
 * of the merged tree. A patch is applied to the target's fork head, where Penguin would write it.
 */
export type PartTrialFix =
  | { readonly kind: "commit"; readonly repo: string; readonly commit: string; readonly base: string }
  | { readonly kind: "patch"; readonly patch: string };

/** One form the trial checks: the newest a scope's agent submitted on the plan's checkpoint. */
export interface PartTrialReviewRequest {
  readonly reviewId: number;
  readonly scope: string;
  readonly form: ReviewForm;
}

/** What Penguin asks the runner for: one trial of one part revision. */
export interface PartTrialRequest {
  readonly trialId: number;
  readonly feature: string;
  readonly planId: string;
  readonly partId: string;
  readonly revision: number;
  /** The originating feature's fork, which holds the checkpoint. */
  readonly fork: string;
  readonly checkpoint: string;
  readonly target: PartTrialTarget;
  readonly fix: PartTrialFix;
  /** `test:<scope>` for each of the part's scopes. */
  readonly commandIds: readonly string[];
  readonly reviews: readonly PartTrialReviewRequest[];
}

/** One test command's outcome on the trial tree; `breaks` names each failing test. */
export interface PartTrialTest {
  readonly scopeId: string;
  readonly commandId: string;
  readonly status: PlanResultStatus;
  readonly breaks: readonly string[];
  /** Why nothing ran, for `conflict` and `not-run`. */
  readonly reason: string | null;
  readonly durationMs: number;
}

/** The review harness's record for one form, run with the target as base and the trial tree as the fork. */
export interface PartTrialReview {
  readonly reviewId: number;
  readonly scope: string;
  readonly record: ReviewRecord;
}

/** What the runner reports for one trial. */
export interface PartTrialReport {
  readonly schemaVersion: typeof PART_TRIAL_SCHEMA_VERSION;
  readonly trialId: number;
  readonly partId: string;
  readonly revision: number;
  readonly checkpoint: string;
  /** The target commit the tree was built from. */
  readonly target: string;
  /** `built`: the tree holds the fix. `conflict`: the patch, the merge or the fix commit did not apply. */
  readonly status: "built" | "conflict";
  /** The trial tree's commit; null for a conflict. */
  readonly tree: string | null;
  readonly reason: string | null;
  readonly tests: readonly PartTrialTest[];
  readonly reviews: readonly PartTrialReview[];
  readonly durationMs: number;
}

export const PART_TRIAL_LIMITS = {
  /** Failing tests named for one command. */
  breaksPerTest: PLAN_LIMITS.breaksPerResult,
  /** Forms one trial checks: one per scope of the part. */
  reviews: 32,
  /** A report's JSON, reviews included: one bound review record per scope. */
  reportBytes: 8 * 1024 * 1024,
} as const;

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const LINE = { anyOf: [{ type: "string", maxLength: PLAN_LIMITS.failureLineLength }, { type: "null" }] };
const COUNT = { type: "integer", minimum: 0 };
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** JSON Schema (draft 2020-12) for the runner's report of one trial; each review record is checked on its own. */
export const PART_TRIAL_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin part trial",
  ...record({
    schemaVersion: { const: PART_TRIAL_SCHEMA_VERSION },
    trialId: { type: "integer", minimum: 1 },
    partId: { type: "string", minLength: 1, maxLength: 128 },
    revision: { type: "integer", minimum: 1 },
    checkpoint: SHA,
    target: SHA,
    status: { type: "string", enum: ["built", "conflict"] },
    tree: { anyOf: [SHA, { type: "null" }] },
    reason: LINE,
    tests: {
      type: "array",
      maxItems: PLAN_LIMITS.commandsPerTarget,
      items: record({
        scopeId: { type: "string", minLength: 1, maxLength: 128 },
        commandId: { type: "string", pattern: "^test:[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
        status: { type: "string", enum: [...PLAN_RESULT_STATUSES] },
        breaks: { type: "array", maxItems: PART_TRIAL_LIMITS.breaksPerTest, items: { type: "string", minLength: 1, maxLength: 512 } },
        reason: LINE,
        durationMs: COUNT,
      }),
    },
    reviews: {
      type: "array",
      maxItems: PART_TRIAL_LIMITS.reviews,
      items: record({ reviewId: { type: "integer", minimum: 1 }, scope: { type: "string", minLength: 1, maxLength: 128 }, record: { type: "object" } }),
    },
    durationMs: COUNT,
  }),
};

export type ParsedPartTrialReport = { readonly ok: true; readonly report: PartTrialReport } | { readonly ok: false; readonly problems: string[] };

/** Checks a reported trial's size and shape, and each review record in it. Penguin checks it is of its trial. */
export function parsePartTrialReport(value: unknown): ParsedPartTrialReport {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  if (bytes > PART_TRIAL_LIMITS.reportBytes) return { ok: false, problems: [`the report is over ${PART_TRIAL_LIMITS.reportBytes} bytes of JSON`] };
  const errors = checkSchema(PART_TRIAL_REPORT_SCHEMA, value);
  if (errors.length > 0) return { ok: false, problems: errors.slice(0, 5).map((error) => `${error.path || "/"} ${error.message}`) };
  const report = value as PartTrialReport;
  for (const [index, review] of report.reviews.entries()) {
    const parsed = parseReviewRecord(review.record);
    if (!parsed.ok) return { ok: false, problems: parsed.problems.map((problem) => `/reviews/${index}/record${problem.startsWith("/") ? "" : " "}${problem}`) };
    if (review.record.scope !== review.scope || report.tree === null || review.record.fork !== report.tree) {
      return { ok: false, problems: [`/reviews/${index} is not a run of its scope on the trial tree`] };
    }
  }
  return { ok: true, report };
}

/** The report as the runner sends it, each review record bound as a review's own report is. */
export function boundPartTrialReport(report: PartTrialReport): PartTrialReport {
  return { ...report, reviews: report.reviews.map((review) => ({ ...review, record: boundReviewRecord(review.record) })) };
}

/**
 * The tests of a trial as the approval checks read them (PRD 4.3 step 3): the part's scopes on the
 * merged tree of its place. `fixInTree` is true only for a built tree, which holds the part's fix.
 */
export interface PartTrialTests {
  /** The trial's target: `main` or the running feature's id. */
  readonly target: string;
  /** `trial-<id>`: the run the results come from. */
  readonly runId: string;
  readonly fixInTree: boolean;
  readonly results: readonly { readonly scopeId: string; readonly commandId: string; readonly status: PlanResultStatus; readonly breaks: number }[];
}

/** One form's run on a trial tree as the approval checks read it. */
export interface PartTrialReviewResult {
  readonly reviewId: number;
  readonly scope: string;
  /** The originating checkpoint the form was submitted on. */
  readonly forkSha: string;
  readonly state: "accepted" | "refused";
  readonly exceptions: readonly ReviewException[];
  /** The invariants whose row in the form says `breaks` or `unknown`. */
  readonly notHolding: readonly string[];
}

/** A recorded trial of one part revision: what the approval checks read in place of the plan's facts run. */
export interface PartTrialEvidence {
  readonly trialId: number;
  readonly partId: string;
  readonly revision: number;
  readonly tree: string | null;
  readonly tests: PartTrialTests;
  /** One per form the trial checked; a scope with no form has none. */
  readonly reviews: readonly PartTrialReviewResult[];
}

/** A stored form as a trial result needs it: its id, checkpoint, rows and the invariants checked at submission. */
export interface TrialReviewSource {
  readonly id: number;
  readonly scopeId: string;
  readonly forkSha: string;
  readonly form: ReviewForm;
  readonly invariants: readonly InvariantView[];
}

/**
 * The evidence of a recorded trial. Each review's exceptions are derived from the stored form, the
 * invariants checked at submission and the trial's side-by-side run, never taken from the runner.
 */
export function partTrialEvidence(targetId: string, report: PartTrialReport, sources: readonly TrialReviewSource[]): PartTrialEvidence {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const reviews: PartTrialReviewResult[] = [];
  for (const review of report.reviews) {
    const source = byId.get(review.reviewId);
    if (source === undefined || source.scopeId !== review.scope) continue;
    const accepted = review.record.state === "accepted";
    reviews.push({
      reviewId: source.id,
      scope: source.scopeId,
      forkSha: source.forkSha,
      state: review.record.state,
      exceptions: reviewExceptions(accepted ? source.form : null, source.invariants, review.record.sideBySide),
      notHolding: source.form.rows.filter((row) => row.verdict !== "holds").map((row) => row.invariant),
    });
  }
  return {
    trialId: report.trialId,
    partId: report.partId,
    revision: report.revision,
    tree: report.tree,
    tests: {
      target: targetId,
      runId: `trial-${report.trialId}`,
      fixInTree: report.status === "built",
      results: report.tests.map(({ scopeId, commandId, status, breaks }) => ({ scopeId, commandId, status, breaks: breaks.length })),
    },
    reviews,
  };
}
