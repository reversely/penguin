// Runner mode's reviews (PRD 0.4 sections 4.3 and 6): claim the reviews Penguin keeps pending after
// `submit_review`, run the review harness on each (as `penguin-bridge review` does) and report the
// record to POST /reviews/<id>. Penguin then makes the review accepted or refused with the record
// attached and routes any exception to the scope's owner.
//
// A claim names the feature's fork, the checkpoint under review and its baseline on main. The runner
// fetches the fork with a read token into its own repository; the baseline is in the fork's history.
// The form is checked again here and never run: only the scope's declared contracts run, in throwaway
// worktrees (side-by-side.ts). A review that fails to run stays claimed until its lease runs out. A
// record over 1 MiB of JSON keeps the first 100 differing and not-run inputs of each set
// (`boundReviewRecord`), so it fits one stored row.

import { boundReviewRecord, type ReviewRecord } from "@penguin/protocol";

import type { ClaimedReview, ReviewReply } from "./penguin-client.ts";
import type { ReviewRequest } from "./review-harness.ts";
import { hasCommit } from "./runner-repo.ts";
import { failureText, noteFailure, type FailRun, type FailureNote } from "./run-failure.ts";

export interface ReviewPassOptions {
  /** Claims the pending reviews, such as `claimReviews` bound to the bridge token. */
  readonly claim: () => Promise<readonly ClaimedReview[]>;
  /** Reports one review's record, such as `reportReview` bound to the bridge token. */
  readonly report: (reviewId: number, record: ReviewRecord) => Promise<ReviewReply>;
  /** Makes every commit of a feature's fork (`feature-<id>`) available in `repoPath`. */
  readonly fetchFork: (fork: string) => Promise<void>;
  /** Runs the review harness in `repoPath`, such as `runReview` bound to the runner's options. */
  readonly review: (request: ReviewRequest) => Promise<ReviewRecord>;
  /** The runner's repository. */
  readonly repoPath: string;
  /** Reports a run the pass stopped on, such as `reportRunFailure` bound to the bridge token; absent, it waits out its lease. */
  readonly fail?: FailRun;
}

export interface ReviewRunResult {
  readonly reviewId: number;
  readonly feature: string;
  readonly scope: string;
  /** The record's verdict, or null when the review did not run. */
  readonly state: "accepted" | "refused" | null;
  /** Inputs that differ between main and the fork. */
  readonly differing: number;
  /** Penguin's answer, or null when nothing was reported. */
  readonly reply: ReviewReply | null;
  /** Why the review stopped; the pass then reports it as failed. */
  readonly error: string | null;
  /** What Penguin did with the stopped review; null when it did not stop or could not be reported. */
  readonly failure: FailureNote | null;
}

export interface ReviewPassResult {
  readonly claimed: number;
  readonly reviews: readonly ReviewRunResult[];
  readonly durationMs: number;
}

/** Claims, runs and reports every pending review once. Each feature's fork is fetched once a pass. */
export async function reviewPass(options: ReviewPassOptions): Promise<ReviewPassResult> {
  const started = performance.now();
  const claimed = await options.claim();
  const fetched = new Map<string, Promise<void>>();
  const fetchOnce = (fork: string) => {
    if (!fetched.has(fork)) fetched.set(fork, options.fetchFork(fork));
    return fetched.get(fork) as Promise<void>;
  };
  const reviews: ReviewRunResult[] = [];
  for (const claim of claimed) reviews.push(await runOne(options, claim, fetchOnce));
  return { claimed: claimed.length, reviews, durationMs: Math.round(performance.now() - started) };
}

async function runOne(options: ReviewPassOptions, claim: ClaimedReview, fetchFork: (fork: string) => Promise<void>): Promise<ReviewRunResult> {
  const base = { reviewId: claim.reviewId, feature: claim.feature, scope: claim.scope };
  try {
    await fetchFork(claim.fork);
    for (const sha of [claim.base, claim.forkSha]) {
      if (!(await hasCommit(options.repoPath, sha))) throw new Error(`commit ${sha} is not in ${claim.fork}`);
    }
    const record = await options.review({ base: claim.base, fork: claim.forkSha, scope: claim.scope, form: claim.form });
    const reply = await options.report(claim.reviewId, boundReviewRecord(record));
    return { ...base, state: record.state, differing: record.sideBySide.totals.differing, reply, error: null, failure: null };
  } catch (error) {
    const reason = (error as Error).message;
    return { ...base, state: null, differing: 0, reply: null, error: reason, failure: await noteFailure(options.fail, "review", String(claim.reviewId), reason) };
  }
}

export function formatReviewPass(result: ReviewPassResult): string {
  const lines: string[] = [];
  for (const review of result.reviews) {
    const name = `Review ${review.reviewId} of ${review.scope} on feature ${review.feature}`;
    if (review.error !== null) {
      lines.push(`${name} stopped; ${failureText(review.failure)}: ${review.error}`);
      continue;
    }
    const routed = review.reply?.routedTo == null ? "" : `, to ${review.reply.routedTo} in person`;
    lines.push(`${name}: ${review.state}, ${review.differing} input${review.differing === 1 ? "" : "s"} differ${review.differing === 1 ? "s" : ""}${routed}.`);
  }
  lines.push(`${result.claimed} review${result.claimed === 1 ? "" : "s"} claimed (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
