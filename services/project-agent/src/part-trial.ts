// Penguin's half of part trials (PRD 0.5 sections 4.3 and 6, @penguin/protocol part-trial.ts): which
// tree each revision of a plan part is tested on, and the evidence its report gives the approval checks.
//
// - Queue. A trial is asked for each part when a plan is stored, for a part when it is revised, and
//   for each part covering a scope when that scope's agent submits a form. A new trial of a part
//   supersedes every older one of the part, and a newer plan supersedes the older plan's trials, so
//   only the newest trial of the current revision counts.
// - Target. A part for a running feature starts from the fork head its patch was written against,
//   which is the head the fix is written onto once approved. A part for a scope on main starts from
//   main at the plan's baseline and applies the part's fix commit from the originating fork. A verify
//   part, a place that needs no change, has no fix: its trial is the checkpoint merged onto the
//   place and runs the scope's tests, with no form.
// - Newest revision. The originating change merged into a trial is the originating fork's newest
//   revision of the part: when the originating agent revised a part for code on main covering one of
//   the part's scopes, the fix commit of the most revised such part, which holds the plan's
//   checkpoint; otherwise the plan's checkpoint. A revision gets a new trial, which supersedes the
//   part's older trials.
// - Reviews. Each trial carries the newest form of each of the part's scopes submitted on the plan's
//   checkpoint, whichever revision it merges. The runner runs the review harness for it on the trial tree against the target, so the
//   evidence check, the stored data rule and the side-by-side run read the affected code with the fix
//   in place, and a running feature's own declared examples run. A form
//   still pending when its trial reports is completed with the trial's record; until then the review
//   claim leaves it to the trial (review-submit.ts).
// - Side-by-side with no form. A rule-written migration part needs no form (migration-plans.ts): its
//   trial names its scopes in `sideBySide`, and the report must carry one side-by-side run of each,
//   on the trial tree against the target.
// - Claim and report. The runner claims trials under a lease, as it claims reviews, and reports each
//   to POST /part-trials/<id>. The report must name its trial's part, revision, checkpoint and target,
//   run exactly its test commands and review exactly its forms on the tree it built.

import {
  parsePartTrialReport,
  partTrialEvidence,
  reviewExceptions,
  type PartTrialEvidence,
  type PartTrialReport,
  type PartTrialRequest,
  type Plan,
  type PlanPart,
} from "@penguin/protocol";

import type { BridgeCaller, SqlDatabase, SqlValue } from "./issue-index.ts";
import type { PartTrialStanding } from "./part-checks.ts";
import type { ReviewStore, StoredReview } from "./review-submit.ts";
import { notStopped, RUN_FAILURE_SCHEMA, type StoreRelease } from "./run-failures.ts";

type Row = Record<string, SqlValue>;

export const PART_TRIAL_TABLE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS PartTrial (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, plan_id TEXT NOT NULL, part_id TEXT NOT NULL,
    revision INTEGER NOT NULL, checkpoint TEXT NOT NULL, scopes TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
    claimed_by TEXT, claimed_at INTEGER, report TEXT, created_at INTEGER NOT NULL, recorded_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS PartTrial_part ON PartTrial (feature_id, part_id, id)`,
  `CREATE INDEX IF NOT EXISTS PartTrial_state ON PartTrial (state, id)`,
];

/** How long a claimed trial stays with its runner before another claim may take it again. */
export const PART_TRIAL_LEASE_MS = 30 * 60_000;

/** The most trials one claim hands out. */
export const PART_TRIAL_CLAIM_LIMIT = 8;

/** `pending` until the runner reports, then `recorded`; `superseded` once a newer trial of the part or plan exists. */
export type PartTrialState = "pending" | "recorded" | "superseded";

/** A trial as Penguin asks for it, before the store gives it its id. */
export type TrialSpec = Omit<PartTrialRequest, "trialId">;

export interface StoredPartTrial {
  readonly id: number;
  readonly featureId: string;
  readonly planId: string;
  readonly partId: string;
  readonly revision: number;
  /** The checkpoint the trial's forms were submitted on: the plan's, even when the trial merges a newer revision. */
  readonly checkpoint: string;
  readonly scopes: readonly string[];
  readonly request: PartTrialRequest;
  readonly state: PartTrialState;
  readonly report: PartTrialReport | null;
  readonly claimedBy: string | null;
}

function trial(row: Row): StoredPartTrial {
  const id = Number(row.id);
  return {
    id,
    featureId: String(row.feature_id),
    planId: String(row.plan_id),
    partId: String(row.part_id),
    revision: Number(row.revision),
    checkpoint: String(row.checkpoint),
    scopes: JSON.parse(String(row.scopes)) as string[],
    request: { trialId: id, ...(JSON.parse(String(row.request)) as TrialSpec) },
    state: row.state as PartTrialState,
    report: typeof row.report === "string" ? (JSON.parse(row.report) as PartTrialReport) : null,
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
  };
}

export class PartTrialStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #leaseMs: number;

  constructor(db: SqlDatabase, now: () => number = Date.now, leaseMs: number = PART_TRIAL_LEASE_MS) {
    this.#db = db;
    this.#now = now;
    this.#leaseMs = leaseMs;
    for (const statement of [...PART_TRIAL_TABLE_SCHEMA, ...RUN_FAILURE_SCHEMA]) db.exec(statement);
  }

  /**
   * Asks for a trial of `spec`'s part revision, whose forms were submitted on `formsOn`; every older
   * trial of the part, and of another plan of the feature, stops counting.
   */
  queue(spec: TrialSpec, scopes: readonly string[], formsOn: string = spec.checkpoint): StoredPartTrial {
    return this.#db.transaction(() => {
      this.#db.exec(
        `UPDATE PartTrial SET state = 'superseded' WHERE feature_id = ? AND state != 'superseded' AND (plan_id != ? OR part_id = ?)`,
        spec.feature,
        spec.planId,
        spec.partId,
      );
      const [row] = this.#db.exec(
        `INSERT INTO PartTrial (feature_id, plan_id, part_id, revision, checkpoint, scopes, request, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`,
        spec.feature,
        spec.planId,
        spec.partId,
        spec.revision,
        formsOn,
        JSON.stringify(scopes),
        JSON.stringify(spec),
        this.#now(),
      );
      return trial(row as Row);
    });
  }

  get(id: number): StoredPartTrial | undefined {
    const [row] = this.#db.exec(`SELECT * FROM PartTrial WHERE id = ?`, id);
    return row === undefined ? undefined : trial(row);
  }

  /** The trials of a feature that still count, pending or recorded, oldest first. */
  current(featureId: string): StoredPartTrial[] {
    return this.#db.exec(`SELECT * FROM PartTrial WHERE feature_id = ? AND state != 'superseded' ORDER BY id`, featureId).map(trial);
  }

  /** The trial of one part that still counts, or undefined. */
  ofPart(featureId: string, partId: string): StoredPartTrial | undefined {
    const [row] = this.#db.exec(
      `SELECT * FROM PartTrial WHERE feature_id = ? AND part_id = ? AND state != 'superseded' ORDER BY id DESC LIMIT 1`,
      featureId,
      partId,
    );
    return row === undefined ? undefined : trial(row);
  }

  /** Hands a runner up to PART_TRIAL_CLAIM_LIMIT pending trials, oldest first; a lease that ran out is handed out again. */
  claim(caller: BridgeCaller): { readonly status: "ok"; readonly trials: readonly StoredPartTrial[] } | { readonly status: "forbidden"; readonly message: string } {
    if (caller.role !== "runner") return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    const now = this.#now();
    return this.#db.transaction(() => {
      const rows = this.#db.exec(
        `SELECT id FROM PartTrial WHERE state = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?) AND ${notStopped("part-trial", "id")} ORDER BY id LIMIT ?`,
        now - this.#leaseMs,
        PART_TRIAL_CLAIM_LIMIT,
      );
      const trials: StoredPartTrial[] = [];
      for (const row of rows) {
        const id = Number(row["id"]);
        this.#db.exec(`UPDATE PartTrial SET claimed_by = ?, claimed_at = ? WHERE id = ?`, caller.bridgeId, now, id);
        trials.push(this.get(id) as StoredPartTrial);
      }
      return { status: "ok" as const, trials };
    });
  }

  /** Frees pending trial `id` from the claim `runnerId` holds, for the next claim of any runner. */
  release(id: number, runnerId: string): StoreRelease {
    const found = this.get(id);
    if (found === undefined) return { status: "rejected", reason: "not_found", message: `no part trial ${id}` };
    if (found.state !== "pending") return { status: "rejected", reason: "conflict", message: `part trial ${id} is ${found.state}` };
    if (found.claimedBy !== runnerId) return { status: "rejected", reason: "forbidden", message: `part trial ${id} is not claimed by this runner` };
    this.#db.exec(`UPDATE PartTrial SET claimed_by = NULL, claimed_at = NULL WHERE id = ?`, id);
    return { status: "released", featureId: found.featureId };
  }

  /** Keeps the report of pending trial `id`; undefined when it is no longer pending. */
  record(id: number, report: PartTrialReport): StoredPartTrial | undefined {
    const [row] = this.#db.exec(
      `UPDATE PartTrial SET state = 'recorded', report = ?, recorded_at = ? WHERE id = ? AND state = 'pending' RETURNING *`,
      JSON.stringify(report),
      this.#now(),
      id,
    );
    return row === undefined ? undefined : trial(row);
  }
}

/** The newest form of each of `scopes` submitted on `checkpoint` that passed its check at submission. */
export function trialForms(reviews: readonly StoredReview[], scopes: readonly string[], checkpoint: string): StoredReview[] {
  const wanted = new Set(scopes);
  const newest = new Map<string, StoredReview>();
  for (const review of reviews) {
    if (!wanted.has(review.scopeId) || review.baseSha === null || review.forkSha !== checkpoint) continue;
    const known = newest.get(review.scopeId);
    if (known === undefined || review.id > known.id) newest.set(review.scopeId, review);
  }
  return [...newest.values()].sort((a, b) => a.id - b.id);
}

/**
 * The originating fork's newest revision of `part`: the fix commit of the most revised part for code
 * on main covering one of its scopes, once the originating agent revised one, or else the plan's
 * checkpoint. A revision commit is written on top of the checkpoint, so it holds it.
 */
export function newestRevision(plan: Plan, part: Pick<PlanPart, "scopes">): string {
  const scopes = new Set(part.scopes);
  let newest: PlanPart | undefined;
  for (const each of plan.parts) {
    if (each.revision < 2 || each.diff.source !== "commit" || each.diff.commit === null || !each.scopes.some((scope) => scopes.has(scope))) continue;
    if (newest === undefined || each.revision > newest.revision) newest = each;
  }
  return newest?.diff.commit ?? plan.facts.change.checkpoint;
}

/**
 * The trial of one part revision, or undefined when the part's fix has no base to apply against (a
 * fix commit with no parent). `reviews` are the feature's stored reviews.
 */
export function trialSpec(plan: Plan, part: PlanPart, reviews: readonly StoredReview[]): TrialSpec | undefined {
  const { diff, place } = part;
  let target: PartTrialRequest["target"];
  let fix: PartTrialRequest["fix"];
  if (diff.source === "none") {
    // A verify part: the checkpoint merged onto main at the baseline, or onto the feature's fork head.
    if (place.kind === "feature") {
      if (diff.base === null) return undefined;
      target = { id: place.feature, repo: diff.repo, sha: diff.base };
    } else {
      target = { id: "main", repo: "base", sha: plan.facts.change.baseline };
    }
    fix = { kind: "none" };
  } else if (diff.source === "patch") {
    if (place.kind !== "feature" || diff.base === null || diff.patch === null) return undefined;
    target = { id: place.feature, repo: diff.repo, sha: diff.base };
    fix = { kind: "patch", patch: diff.patch };
  } else {
    if (diff.commit === null || diff.base === null) return undefined;
    target = { id: "main", repo: "base", sha: plan.facts.change.baseline };
    fix = { kind: "commit", repo: diff.repo, commit: diff.commit, base: diff.base };
  }
  return {
    feature: plan.featureId,
    planId: plan.planId,
    partId: part.partId,
    revision: part.revision,
    fork: `feature-${plan.featureId}`,
    checkpoint: newestRevision(plan, part),
    target,
    fix,
    commandIds: [...part.scopes].sort().map((scope) => `test:${scope}`),
    // A verify part needs no form, so its trial reviews none.
    reviews:
      part.kind === "verify"
        ? []
        : trialForms(reviews, part.scopes, plan.facts.change.checkpoint).map((review) => ({ reviewId: review.id, scope: review.scopeId, form: review.form })),
  };
}

export interface TrialQueueDeps {
  readonly trials: PartTrialStore;
  readonly reviews: ReviewStore;
}

/**
 * Asks for a trial of each of `parts` of `plan` (every part when omitted), and of each other part whose
 * trial merges an older revision than the originating fork's newest, as after a revision; answers the
 * trials queued.
 */
export function queueTrials(deps: TrialQueueDeps, plan: Plan, parts: readonly PlanPart[] = plan.parts): StoredPartTrial[] {
  const reviews = deps.reviews.list(plan.featureId);
  const asked = new Set(parts.map((part) => part.partId));
  const behind = plan.parts.filter((part) => {
    const current = asked.has(part.partId) ? undefined : deps.trials.ofPart(plan.featureId, part.partId);
    return current !== undefined && current.planId === plan.planId && current.request.checkpoint !== newestRevision(plan, part);
  });
  return [...parts, ...behind].flatMap((part) => {
    const spec = trialSpec(plan, part, reviews);
    return spec === undefined ? [] : [deps.trials.queue(spec, part.scopes, plan.facts.change.checkpoint)];
  });
}

/**
 * Asks for a trial of one part revision on `head` of its fork instead of the head its patch was
 * written against: another fix written into the fork moved it there (fix-retrial.ts). Undefined when
 * the part has no trial.
 */
export function queueTrialOn(deps: TrialQueueDeps, plan: Plan, part: PlanPart, head: string): StoredPartTrial | undefined {
  const spec = trialSpec(plan, part, deps.reviews.list(plan.featureId));
  if (spec === undefined || spec.target.id === "main") return undefined;
  return deps.trials.queue({ ...spec, target: { ...spec.target, sha: head } }, part.scopes, plan.facts.change.checkpoint);
}

/** After a form of `scope` is submitted on the plan's checkpoint, asks again for each part covering the scope. */
export function queueTrialsForReview(deps: TrialQueueDeps, plan: Plan | undefined, scope: string, checkpoint: string): StoredPartTrial[] {
  if (plan === undefined || plan.facts.change.checkpoint !== checkpoint) return [];
  return queueTrials(deps, plan, plan.parts.filter((part) => part.scopes.includes(scope)));
}

/**
 * Whether a pending review waits for a trial instead of the review claim: a trial that still counts
 * covers its scope on the checkpoint it was submitted on and is still running or carried the form.
 * A trial that built no tree runs no review, so the claim runs that form on the checkpoint.
 */
export function trialHolds(trials: PartTrialStore, review: Pick<StoredReview, "id" | "featureId" | "scopeId" | "forkSha">): boolean {
  return trials.current(review.featureId).some(
    (each) =>
      each.checkpoint === review.forkSha &&
      each.scopes.includes(review.scopeId) &&
      (each.state === "pending" || (each.report?.reviews ?? []).some((run) => run.reviewId === review.id)),
  );
}

export type PartTrialClaim =
  | { readonly status: "ok"; readonly trials: readonly PartTrialRequest[] }
  | { readonly status: "forbidden"; readonly message: string };

export function claimPartTrials(trials: PartTrialStore, caller: BridgeCaller): PartTrialClaim {
  const listing = trials.claim(caller);
  return listing.status === "forbidden" ? listing : { status: "ok", trials: listing.trials.map((each) => each.request) };
}

export type PartTrialOutcome =
  | { readonly status: "recorded"; readonly trial: StoredPartTrial; readonly evidence: PartTrialEvidence; readonly completedReviews: readonly number[] }
  /** A newer trial of the part, or a newer plan, took its place; the report is not kept. */
  | { readonly status: "superseded"; readonly trial: StoredPartTrial }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "conflict"; readonly message: string };

export interface PartTrialRecordDeps {
  readonly trials: PartTrialStore;
  readonly reviews: ReviewStore;
  /** Puts a review with exceptions before its scope's owner, as a review's own report does. */
  readonly routeToOwner: (ownerId: string, review: StoredReview) => void;
  /** Who a review exception goes to, as for a review's own report (review-record.ts). */
  readonly personFor?: (review: StoredReview) => string | undefined;
  /** Called once a trial is kept, such as to let Penguin approve the parts whose checks are now clean. */
  readonly recorded?: (featureId: string, trial: StoredPartTrial) => Promise<void> | void;
}

const rejected = (reason: Extract<PartTrialOutcome, { status: "rejected" }>["reason"], message: string): PartTrialOutcome => ({ status: "rejected", reason, message });

async function sha256Ref(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Why a report is not of its trial, or null when it is. */
function mismatch(request: PartTrialRequest, report: PartTrialReport): string | null {
  const { trialId, partId, revision, checkpoint, target } = report;
  if (trialId !== request.trialId || partId !== request.partId || revision !== request.revision || checkpoint !== request.checkpoint || target !== request.target.sha) {
    return "it must name its trial, part, revision, checkpoint and target";
  }
  if ((report.status === "built") !== (report.tree !== null)) return "a built trial names its tree and a conflict names none";
  const commands = report.tests.map((test) => test.commandId).sort();
  if (commands.join("\n") !== [...request.commandIds].sort().join("\n")) return "it must run each of the trial's test commands once";
  if (report.tests.some((test) => test.scopeId !== test.commandId.slice("test:".length))) return "each test result must name its command's scope";
  const asked = new Map(request.reviews.map((review) => [review.reviewId, review.scope]));
  const ran = report.reviews.map((review) => review.reviewId);
  if (report.status === "built" && (ran.length !== asked.size || new Set(ran).size !== ran.length)) return "it must review each of the trial's forms once";
  if (report.status === "conflict" && ran.length > 0) return "a trial with no tree reviews nothing";
  for (const review of report.reviews) {
    if (asked.get(review.reviewId) !== review.scope || review.record.base !== request.target.sha) return `review ${review.reviewId} is not of a form the trial carries, against the trial's target`;
  }
  // A rule-written migration part's trial runs the side-by-side run of each scope it names, with no form.
  const formless = report.status === "built" ? [...(request.sideBySide ?? [])].sort() : [];
  if ((report.sideBySide ?? []).map((run) => run.scope).sort().join("\n") !== formless.join("\n")) {
    return "it must run the side-by-side run of each scope the trial names once, and only on a built tree";
  }
  return null;
}

/**
 * Keeps the runner's report of trial `trialId` against its part revision. Each form the trial checked
 * that still waits as pending is completed with the trial's record, and an exception goes to the
 * scope's owner, as when the review claim reports it. The first report wins.
 */
export async function recordPartTrial(deps: PartTrialRecordDeps, caller: BridgeCaller, trialId: number, body: unknown): Promise<PartTrialOutcome> {
  if (caller.role !== "runner") return rejected("forbidden", `bridge ${caller.bridgeId} does not hold the runner role`);
  const stored = deps.trials.get(trialId);
  if (stored === undefined) return rejected("not_found", `no part trial ${trialId}`);
  if (stored.state === "superseded") return { status: "superseded", trial: stored };
  if (stored.state === "recorded") return rejected("conflict", `part trial ${trialId} is already recorded`);
  const parsed = parsePartTrialReport(body);
  if (!parsed.ok) return rejected("invalid", parsed.problems.join("; "));
  const problem = mismatch(stored.request, parsed.report);
  if (problem !== null) return rejected("invalid", `the report is not of part trial ${trialId}: ${problem}`);
  const kept = deps.trials.record(trialId, parsed.report);
  if (kept === undefined) {
    const now = deps.trials.get(trialId) as StoredPartTrial;
    return now.state === "superseded" ? { status: "superseded", trial: now } : rejected("conflict", `part trial ${trialId} was recorded by another report`);
  }
  const completedReviews: number[] = [];
  const sources: StoredReview[] = [];
  for (const { reviewId, record } of parsed.report.reviews) {
    const review = deps.reviews.get(reviewId);
    if (review === undefined) continue;
    sources.push(review);
    if (review.state !== "pending" || review.forkSha !== stored.checkpoint) continue;
    const exceptions = reviewExceptions(record.state === "accepted" ? review.form : null, review.invariants, record.sideBySide);
    const completed = deps.reviews.complete(reviewId, { state: record.state, refusals: record.refusals, record, sideBySideRef: await sha256Ref(JSON.stringify(record)), exceptions });
    if (completed === undefined) continue;
    completedReviews.push(reviewId);
    const person = exceptions.length > 0 ? (deps.personFor?.(completed) ?? completed.ownerId) : null;
    if (person !== null) deps.routeToOwner(person, completed);
  }
  const evidence = partTrialEvidence(stored.request.target.id, parsed.report, sources);
  await deps.recorded?.(stored.featureId, kept);
  return { status: "recorded", trial: kept, evidence, completedReviews };
}

/**
 * Where the trial of a part's current revision stands for the approval checks (part-checks.ts):
 * running with the forms it carries, or recorded with its evidence. Undefined when no trial of that
 * revision counts, so the checks read the plan's facts run.
 */
export function trialStanding(trials: PartTrialStore, reviews: ReviewStore, featureId: string, part: Pick<PlanPart, "partId" | "revision">): PartTrialStanding | undefined {
  const found = trials.ofPart(featureId, part.partId);
  if (found === undefined || found.revision !== part.revision) return undefined;
  if (found.state === "pending") return { state: "running", reviewIds: found.request.reviews.map((review) => review.reviewId) };
  const evidence = trialEvidence(trials, reviews, featureId, part);
  return evidence === undefined ? undefined : { state: "recorded", evidence };
}

/**
 * The recorded trial of one part revision as the approval checks read it, or undefined while none
 * counts: no trial yet, one still running, or one of another revision.
 */
export function trialEvidence(trials: PartTrialStore, reviews: ReviewStore, featureId: string, part: Pick<PlanPart, "partId" | "revision">): PartTrialEvidence | undefined {
  const found = trials.ofPart(featureId, part.partId);
  if (found === undefined || found.state !== "recorded" || found.report === null || found.revision !== part.revision) return undefined;
  const sources = found.report.reviews.flatMap((review) => reviews.get(review.reviewId) ?? []);
  return partTrialEvidence(found.request.target.id, found.report, sources);
}
