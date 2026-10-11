// `submit_review` (PRD 0.4 sections 4.3 and 6): an affected scope's agent submits the review form for
// the part of a feature's change that touches its scope. Penguin checks it at once against the
// scope's invariants in `penguin/invariants.json` on main and against the feature's fork at its
// latest checkpoint: a missing row, evidence that does not exist in the fork and "unknown" without a
// test are refused with the reason. The stored data rule needs the contract diff and the side-by-side
// run needs the scope's code run, so both are left to the check runner (`penguin-bridge review`);
// the review is kept with both waiting.
//
// Until merge plans exist (#89), a review is keyed by the feature under review and the reviewing
// scope, not by a plan part. Every form string is length-limited and stored as data, never run.

import {
  evidencePaths,
  parseReviewForm,
  validateReviewForm,
  type InvariantView,
  type ReviewForm,
  type ReviewRefusal,
} from "@penguin/protocol";
import { InvariantsFileError, parseInvariantsBytes, type ScopeMap } from "@penguin/scope-map";

import { parseFeatureId, type FeatureStore } from "./feature-store.ts";
import type { FeatureRejection } from "./feature-open.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import type { SessionOutcome } from "./session-store.ts";

type Row = Record<string, SqlValue>;

export const REVIEW_TABLE_SCHEMA: readonly string[] = [
  // `Review(plan_part_id, form, validation_state, side_by_side_ref)` (PRD section 9), keyed by the
  // feature under review and the reviewing scope until plan parts exist. The issue index already
  // has a `Review` table, for Huddle reviews, so this one is `FeatureReview`.
  `CREATE TABLE IF NOT EXISTS FeatureReview (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, scope_id TEXT NOT NULL,
    reviewer TEXT NOT NULL, fork_sha TEXT NOT NULL, form TEXT NOT NULL, validation_state TEXT NOT NULL,
    refusals TEXT NOT NULL, side_by_side_ref TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS FeatureReview_feature ON FeatureReview (feature_id, scope_id, id)`,
];

/** The most bytes of one evidence file read from the fork; a larger file counts as missing. */
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

export type ReviewState = "accepted" | "refused";

export interface StoredReview {
  readonly id: number;
  readonly featureId: string;
  readonly scopeId: string;
  /** The reviewing session's identity handle. */
  readonly reviewer: string;
  /** The fork commit the evidence was checked against. */
  readonly forkSha: string;
  readonly form: ReviewForm;
  readonly state: ReviewState;
  readonly refusals: readonly ReviewRefusal[];
  /** The side-by-side run's record, once the check runner attaches it. */
  readonly sideBySideRef: string | null;
  readonly createdAt: string;
}

function review(row: Row): StoredReview {
  return {
    id: Number(row.id),
    featureId: String(row.feature_id),
    scopeId: String(row.scope_id),
    reviewer: String(row.reviewer),
    forkSha: String(row.fork_sha),
    form: JSON.parse(String(row.form)) as ReviewForm,
    state: row.validation_state as ReviewState,
    refusals: JSON.parse(String(row.refusals)) as ReviewRefusal[],
    sideBySideRef: row.side_by_side_ref === null ? null : String(row.side_by_side_ref),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

/** Every submitted form, accepted or refused, so the record shows each attempt. */
export class ReviewStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of REVIEW_TABLE_SCHEMA) db.exec(statement);
  }

  insert(entry: Omit<StoredReview, "id" | "createdAt" | "sideBySideRef">): StoredReview {
    const [row] = this.#db.exec(
      `INSERT INTO FeatureReview (feature_id, scope_id, reviewer, fork_sha, form, validation_state, refusals, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      entry.featureId,
      entry.scopeId,
      entry.reviewer,
      entry.forkSha,
      JSON.stringify(entry.form),
      entry.state,
      JSON.stringify(entry.refusals),
      this.#now(),
    );
    return review(row as Row);
  }

  /** The reviews of one feature, oldest first. */
  list(featureId: string): StoredReview[] {
    return this.#db.exec(`SELECT * FROM FeatureReview WHERE feature_id = ? ORDER BY id`, featureId).map(review);
  }
}

export interface ReviewDeps {
  readonly features: FeatureStore;
  readonly reviews: ReviewStore;
  /** The base repo's scope map, read fresh. */
  readonly scopeMap: () => Promise<ScopeMap>;
  /** `penguin/invariants.json` on the base repo's branch, or null when there is none. */
  readonly invariantsFile: () => Promise<Uint8Array | null>;
  /** A file in a feature's fork at a commit, or null when there is none. */
  readonly readForkFile: (repo: string, sha: string, path: string) => Promise<Blob | null>;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
}

export interface ReviewInput {
  /** The feature whose change is reviewed. */
  readonly feature: unknown;
  /** The reviewing scope, which the caller owns. */
  readonly scope: unknown;
  readonly form: unknown;
}

export type ReviewOutcome =
  | {
      readonly status: "ok";
      /** The stored review, or null when the form broke the format and was not kept. */
      readonly reviewId: number | null;
      readonly featureId: string;
      readonly scopeId: string;
      readonly forkSha: string;
      readonly state: ReviewState;
      readonly refusals: readonly ReviewRefusal[];
      /** The scope's invariants the form was checked against. */
      readonly invariants: readonly InvariantView[];
    }
  | FeatureRejection;

const rejected = (reason: FeatureRejection["reason"], message: string): FeatureRejection => ({ status: "rejected", reason, message });

/** A fork file's text, or null when it is missing or over the size cap. */
async function forkText(deps: ReviewDeps, repo: string, sha: string, path: string): Promise<string | null> {
  const blob = await deps.readForkFile(repo, sha, path);
  if (blob === null || blob.size > MAX_EVIDENCE_FILE_BYTES) return null;
  return blob.text();
}

/**
 * Checks and keeps a review form from `caller`'s session for scope `input.scope` on feature
 * `input.feature`. A form that breaks a rule is kept as refused and answered with every reason; the
 * agent fixes it and submits again. Rejected without a record: an invalid feature or scope, a scope
 * the caller does not own, a feature with no checkpoint to review, or an unreadable invariants file.
 */
export async function submitReview(deps: ReviewDeps, caller: string, sessionId: string, input: ReviewInput): Promise<ReviewOutcome> {
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  const feature = deps.features.get(featureId);
  if (feature === undefined) return rejected("not_found", `no feature ${featureId}`);
  if (feature.repo === null || feature.latestCheckpointSha === null) {
    return rejected("not_found", `feature ${featureId} has no checkpoint on its fork to review yet`);
  }
  const scopeMap = await deps.scopeMap();
  const scope = typeof input.scope === "string" ? scopeMap.scopes.get(input.scope) : undefined;
  if (scope === undefined) return rejected("invalid", "the scope must be a scope id from penguin/scopes.json");
  if (scope.ownerId !== caller) return rejected("forbidden", `a review covers its own scope; ${scope.id} belongs to another person`);

  let invariants: InvariantView[];
  try {
    const file = parseInvariantsBytes(await deps.invariantsFile(), scopeMap);
    invariants = file.invariants.filter((invariant) => invariant.scopeId === scope.id);
  } catch (error) {
    if (error instanceof InvariantsFileError) return rejected("invalid", error.message);
    throw error;
  }

  const checked = { featureId: feature.id, scopeId: scope.id, forkSha: feature.latestCheckpointSha, invariants };
  const parsed = parseReviewForm(input.form);
  // A form that breaks the format is refused without being kept: it is not a form.
  if (!parsed.ok) return { status: "ok", reviewId: null, state: "refused", refusals: parsed.refusals, ...checked };

  const files = new Map<string, string | null>();
  for (const path of evidencePaths(parsed.form)) {
    files.set(path, await forkText(deps, feature.repo, feature.latestCheckpointSha, path));
  }
  const validation = validateReviewForm({ form: parsed.form, invariants, files, storedShapes: null });
  const stored = deps.reviews.insert({
    featureId: feature.id,
    scopeId: scope.id,
    reviewer: live.session.handle,
    forkSha: feature.latestCheckpointSha,
    form: parsed.form,
    state: validation.accepted ? "accepted" : "refused",
    refusals: validation.refusals,
  });
  return { status: "ok", reviewId: stored.id, state: stored.state, refusals: stored.refusals, ...checked };
}
