// `submit_review` (PRD 0.4 sections 4.3 and 6): an affected scope's agent submits the review form for
// the part of a feature's change that touches its scope. Penguin checks it at once against the
// scope's invariants in `penguin/invariants.json` on main and against the feature's fork at its
// latest checkpoint: a missing row, evidence that does not exist in the fork and "unknown" without a
// test are refused with the reason. The stored data rule needs the contract diff and the side-by-side
// run needs the scope's code run, so both are left to the check runner: a form that passes is kept
// `pending` with the checkpoint's baseline on main, until a runner claims it, runs the review harness
// and reports the record (review-record.ts).
//
// A review is keyed by the feature under review and the reviewing scope. Once the feature's plan has a
// part covering the scope, the evidence is looked up where that part's trial tree has it (PRD 0.5
// section 4.3): in the part's fix, then the checkpoint, then the affected fork's head. The runner checks
// the form again on the trial tree itself (part-trial.ts). Every form string is length-limited and
// stored as data, never run.

import {
  applyPatchFile,
  evidencePaths,
  parsePatch,
  parseReviewForm,
  validateReviewForm,
  type InvariantView,
  type PlanPart,
  type ReviewException,
  type ReviewForm,
  type ReviewRecord,
  type ReviewRefusal,
} from "@penguin/protocol";
import { InvariantsFileError, parseInvariantsBytes, type ScopeMap } from "@penguin/scope-map";

import { parseFeatureId, type FeatureStore } from "./feature-store.ts";
import type { FeatureRejection } from "./feature-open.ts";
import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
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

/**
 * Columns added for the check runner's claim and record (#101). A table an earlier deploy created
 * lacks them, so the store adds each one that is missing.
 */
const RUNNER_COLUMNS: readonly (readonly [string, string])[] = [
  ["owner_id", "owner_id TEXT"],
  ["base_sha", "base_sha TEXT"],
  ["invariants", "invariants TEXT"],
  ["claimed_by", "claimed_by TEXT"],
  ["claimed_at", "claimed_at INTEGER"],
  ["completed_at", "completed_at INTEGER"],
  ["record", "record TEXT"],
  ["exceptions", "exceptions TEXT"],
  // The submitting session, told the runner's verdict at its next safe checkpoint (#90).
  ["session_id", "session_id TEXT"],
];

/** The most bytes of one evidence file read from the fork; a larger file counts as missing. */
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

/** How long a claimed review stays with its runner before another claim may take it again. */
export const REVIEW_LEASE_MS = 30 * 60_000;

/** The most reviews one claim hands out. */
export const REVIEW_CLAIM_LIMIT = 8;

/**
 * `pending` from a form that passed the check at submission until the runner reports its record,
 * then the runner's verdict. A form refused at submission is `refused` at once and never runs.
 */
export type ReviewState = "pending" | "accepted" | "refused";

export interface StoredReview {
  readonly id: number;
  readonly featureId: string;
  readonly scopeId: string;
  /** The scope's owner, who submitted the review through their agent; null on a row from before #101. */
  readonly ownerId: string | null;
  /** The reviewing session's identity handle. */
  readonly reviewer: string;
  /** The session that submitted the form; null on a row from before #90. */
  readonly sessionId: string | null;
  /** The fork commit the evidence was checked against. */
  readonly forkSha: string;
  /** The checkpoint's baseline on main, the runner's base; null for a form refused at submission. */
  readonly baseSha: string | null;
  readonly form: ReviewForm;
  /** The scope's invariants on main the form was checked against at submission. */
  readonly invariants: readonly InvariantView[];
  readonly state: ReviewState;
  readonly refusals: readonly ReviewRefusal[];
  /** `sha256:<hex>` of the runner's review record, once attached. */
  readonly sideBySideRef: string | null;
  /** The runner's review record, once attached. */
  readonly record: ReviewRecord | null;
  /** What goes to the scope's owner in person, derived from the record; empty until it is attached. */
  readonly exceptions: readonly ReviewException[];
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

const json = <T>(value: SqlValue | undefined, empty: T): T => (typeof value === "string" ? (JSON.parse(value) as T) : empty);
const text = (value: SqlValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
const time = (value: SqlValue | undefined): string | null =>
  value === null || value === undefined ? null : new Date(Number(value)).toISOString();

function review(row: Row): StoredReview {
  return {
    id: Number(row.id),
    featureId: String(row.feature_id),
    scopeId: String(row.scope_id),
    ownerId: text(row.owner_id),
    reviewer: String(row.reviewer),
    sessionId: text(row.session_id),
    forkSha: String(row.fork_sha),
    baseSha: text(row.base_sha),
    form: JSON.parse(String(row.form)) as ReviewForm,
    invariants: json<InvariantView[]>(row.invariants, []),
    state: row.validation_state as ReviewState,
    refusals: JSON.parse(String(row.refusals)) as ReviewRefusal[],
    sideBySideRef: text(row.side_by_side_ref),
    record: json<ReviewRecord | null>(row.record, null),
    exceptions: json<ReviewException[]>(row.exceptions, []),
    claimedBy: text(row.claimed_by),
    claimedAt: time(row.claimed_at),
    completedAt: time(row.completed_at),
    createdAt: time(row.created_at) as string,
  };
}

/** What the runner's report sets on a pending review. */
export interface ReviewCompletion {
  readonly state: Exclude<ReviewState, "pending">;
  readonly refusals: readonly ReviewRefusal[];
  readonly record: ReviewRecord;
  readonly sideBySideRef: string;
  readonly exceptions: readonly ReviewException[];
}

export type ReviewClaimListing =
  | { readonly status: "ok"; readonly reviews: readonly StoredReview[] }
  | { readonly status: "forbidden"; readonly message: string };

/** Every submitted form, accepted or refused, so the record shows each attempt. */
export class ReviewStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #leaseMs: number;

  constructor(db: SqlDatabase, now: () => number = Date.now, leaseMs: number = REVIEW_LEASE_MS) {
    this.#db = db;
    this.#now = now;
    this.#leaseMs = leaseMs;
    for (const statement of REVIEW_TABLE_SCHEMA) db.exec(statement);
    // Column names and definitions come from the constant above, never from input.
    const present = new Set(db.exec(`PRAGMA table_info(FeatureReview)`).map((row) => row["name"]));
    for (const [name, definition] of RUNNER_COLUMNS) {
      if (!present.has(name)) db.exec(`ALTER TABLE FeatureReview ADD COLUMN ${definition}`);
    }
  }

  insert(
    entry: Pick<
      StoredReview,
      "featureId" | "scopeId" | "ownerId" | "reviewer" | "sessionId" | "forkSha" | "baseSha" | "form" | "invariants" | "state" | "refusals"
    >,
  ): StoredReview {
    const [row] = this.#db.exec(
      `INSERT INTO FeatureReview (feature_id, scope_id, owner_id, reviewer, session_id, fork_sha, base_sha, form, invariants,
         validation_state, refusals, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      entry.featureId,
      entry.scopeId,
      entry.ownerId,
      entry.reviewer,
      entry.sessionId,
      entry.forkSha,
      entry.baseSha,
      JSON.stringify(entry.form),
      JSON.stringify(entry.invariants),
      entry.state,
      JSON.stringify(entry.refusals),
      this.#now(),
    );
    return review(row as Row);
  }

  get(id: number): StoredReview | undefined {
    const [row] = this.#db.exec(`SELECT * FROM FeatureReview WHERE id = ?`, id);
    return row === undefined ? undefined : review(row);
  }

  /** The reviews of one feature, oldest first. */
  list(featureId: string): StoredReview[] {
    return this.#db.exec(`SELECT * FROM FeatureReview WHERE feature_id = ? ORDER BY id`, featureId).map(review);
  }

  /** The reviews session `sessionId` submitted that the check runner has recorded, oldest first. */
  recordedFor(sessionId: string): StoredReview[] {
    return this.#db
      .exec(`SELECT * FROM FeatureReview WHERE session_id = ? AND completed_at IS NOT NULL ORDER BY id`, sessionId)
      .map(review);
  }

  /**
   * Hands the runner up to REVIEW_CLAIM_LIMIT pending reviews, oldest first, and marks them claimed
   * by `caller`. A review is claimable while pending and unclaimed, or when its claim's lease ran out
   * without a report. A review `held` names waits for a part trial instead, which runs its form on the
   * part's trial tree (part-trial.ts). Only a bridge with the runner role may claim.
   */
  claim(caller: BridgeCaller, held: (review: StoredReview) => boolean = () => false): ReviewClaimListing {
    if (caller.role !== "runner") {
      return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    }
    const now = this.#now();
    return this.#db.transaction((): ReviewClaimListing => {
      const rows = this.#db.exec(
        `SELECT * FROM FeatureReview WHERE validation_state = 'pending' AND base_sha IS NOT NULL
           AND (claimed_at IS NULL OR claimed_at <= ?) ORDER BY id`,
        now - this.#leaseMs,
      );
      const reviews: StoredReview[] = [];
      for (const row of rows) {
        if (reviews.length >= REVIEW_CLAIM_LIMIT) break;
        const pending = review(row);
        if (held(pending)) continue;
        this.#db.exec(`UPDATE FeatureReview SET claimed_by = ?, claimed_at = ? WHERE id = ?`, caller.bridgeId, now, pending.id);
        reviews.push(this.get(pending.id) as StoredReview);
      }
      return { status: "ok", reviews };
    });
  }

  /**
   * Attaches the runner's record to review `id` while it is pending. Returns the completed review,
   * or undefined when it was not pending: a second report of the same review changes nothing.
   */
  complete(id: number, completion: ReviewCompletion): StoredReview | undefined {
    const [row] = this.#db.exec(
      `UPDATE FeatureReview SET validation_state = ?, refusals = ?, record = ?, side_by_side_ref = ?, exceptions = ?,
         completed_at = ?
       WHERE id = ? AND validation_state = 'pending' RETURNING *`,
      completion.state,
      JSON.stringify(completion.refusals),
      JSON.stringify(completion.record),
      completion.sideBySideRef,
      JSON.stringify(completion.exceptions),
      this.#now(),
      id,
    );
    return row === undefined ? undefined : review(row);
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
  /** The checkpoint `sha` of fork `repo`'s baseline on main (`checkpointBaseline`). */
  readonly baseline: (repo: string, sha: string) => Promise<string>;
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  /**
   * The part of the feature's newest plan covering scope `scopeId` on checkpoint `checkpoint`, or
   * undefined. Absent, evidence is looked up in the checkpoint alone.
   */
  readonly coveringPart?: (featureId: string, scopeId: string, checkpoint: string) => Promise<PlanPart | undefined>;
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
 * A file as the part's trial tree has it, as far as Penguin can tell without building the tree: the
 * part's fix (the patched file, or the file at the fix commit when the fix changes it), then the
 * checkpoint, then the affected fork's head. Null when none has it.
 */
async function trialText(deps: ReviewDeps, originRepo: string, checkpoint: string, part: PlanPart | undefined, path: string): Promise<string | null> {
  const { diff, place } = part ?? { diff: undefined, place: undefined };
  const forkRepo = place?.kind === "feature" ? (deps.features.get(place.feature)?.repo ?? null) : null;
  if (diff?.source === "patch" && diff.patch !== null && diff.base !== null && forkRepo !== null) {
    const parsed = parsePatch(diff.patch);
    const file = parsed.ok ? parsed.files.find((each) => each.path === path) : undefined;
    if (file !== undefined) {
      const applied = applyPatchFile(file, await forkText(deps, forkRepo, diff.base, path));
      return applied.ok ? applied.text : null;
    }
  }
  if (diff?.source === "commit" && diff.commit !== null && diff.files.some((file) => file.path === path)) {
    return forkText(deps, originRepo, diff.commit, path);
  }
  const atCheckpoint = await forkText(deps, originRepo, checkpoint, path);
  if (atCheckpoint !== null || forkRepo === null || diff?.base == null) return atCheckpoint;
  return forkText(deps, forkRepo, diff.base, path);
}

/**
 * Checks and keeps a review form from `caller`'s session for scope `input.scope` on feature
 * `input.feature`. A form that breaks a rule is kept as refused and answered with every reason; the
 * agent fixes it and submits again. A form that passes is kept pending for the check runner.
 * Rejected without a record: an invalid feature or scope, a scope
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

  const part = await deps.coveringPart?.(feature.id, scope.id, feature.latestCheckpointSha);
  const files = new Map<string, string | null>();
  for (const path of evidencePaths(parsed.form)) {
    files.set(path, await trialText(deps, feature.repo, feature.latestCheckpointSha, part, path));
  }
  const validation = validateReviewForm({ form: parsed.form, invariants, files, storedShapes: null });
  // Only a form that passed waits for the runner, which compares the checkpoint with its baseline.
  const baseSha = validation.accepted ? await deps.baseline(feature.repo, feature.latestCheckpointSha) : null;
  const stored = deps.reviews.insert({
    featureId: feature.id,
    scopeId: scope.id,
    ownerId: caller,
    reviewer: live.session.handle,
    sessionId,
    forkSha: feature.latestCheckpointSha,
    baseSha,
    form: parsed.form,
    invariants: invariants.map(({ id, scopeId, statement, protected: isProtected }) => ({ id, scopeId, statement, protected: isProtected })),
    state: validation.accepted ? "pending" : "refused",
    refusals: validation.refusals,
  });
  return { status: "ok", reviewId: stored.id, state: stored.state, refusals: stored.refusals, ...checked };
}
