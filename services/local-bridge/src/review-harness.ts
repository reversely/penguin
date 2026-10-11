// The review harness on the check runner (PRD 0.4 section 6): one review of one plan part by the
// reviewing scope's agent. It reads the scope's invariants from `penguin/invariants.json` on main,
// checks the form and its evidence against the fork's Git objects, applies the stored data rule to
// the contract diff, runs the scope's public functions side by side on main and on the fork, and
// names the exceptions that go to the scope's owner. Every step is deterministic; no step calls a
// model. The result is a record a feature page or a demo can show as it is.

import {
  evidencePaths,
  parseReviewForm,
  reviewExceptions,
  validateReviewForm,
  formatSideBySide,
  REVIEW_SCHEMA_VERSION,
  type InvariantView,
  type ReviewException,
  type ReviewForm,
  type ReviewRefusal,
  type SideBySideRecord,
  type StoredShapeChange,
} from "@penguin/protocol";

import type { ImpactAnalyzer } from "./impact-analysis.ts";
import { loadReviewConfig, readCommittedFile, runSideBySide, type SideBySideOptions } from "./side-by-side.ts";

export interface ReviewRequest {
  /** Main: the commit the change is made against. */
  readonly base: string;
  /** The fork's commit holding the change, where evidence must exist. */
  readonly fork: string;
  /** The reviewing scope. */
  readonly scope: string;
  /** The review form as submitted; checked here, never trusted. */
  readonly form: unknown;
}

export interface ReviewOptions extends SideBySideOptions {
  /** Supplies the contract diff's stored data shapes. Without it the stored data rule is not checked. */
  readonly analyzer?: ImpactAnalyzer;
}

export interface ReviewResult {
  readonly schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  readonly base: string;
  readonly fork: string;
  readonly scope: string;
  readonly state: "accepted" | "refused";
  readonly refusals: readonly ReviewRefusal[];
  /** The scope's invariants the form was checked against. */
  readonly invariants: readonly InvariantView[];
  /** The stored data shapes the contract diff shows changed; null when no diff was made. */
  readonly storedShapes: readonly StoredShapeChange[] | null;
  readonly sideBySide: SideBySideRecord;
  /** What goes to the scope's owner in person; empty when the agent's review stands. */
  readonly exceptions: readonly ReviewException[];
  readonly timings: { readonly impactMs: number; readonly sideBySideMs: number; readonly totalMs: number };
}

/** Reads each evidence file from the fork; a missing, unreadable or oversized file counts as missing. */
async function forkFiles(repoPath: string, fork: string, form: ReviewForm): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  for (const path of evidencePaths(form)) {
    files.set(path, await readCommittedFile(repoPath, fork, path).catch(() => null));
  }
  return files;
}

/** Runs one review on the check runner and returns its record. */
export async function runReview(options: ReviewOptions, request: ReviewRequest): Promise<ReviewResult> {
  const started = performance.now();
  const config = await loadReviewConfig(options.repoPath, request.base);
  const invariants = config.invariants.invariants.filter((invariant) => invariant.scopeId === request.scope);
  const parsed = parseReviewForm(request.form);

  let storedShapes: StoredShapeChange[] | null = null;
  const impactStarted = performance.now();
  if (options.analyzer !== undefined) {
    const report = await options.analyzer({ base: request.base, head: request.fork, forks: [] });
    storedShapes = report.dataShapes.map((shape) => ({ symbol: shape.symbol, path: shape.path }));
  }
  const impactMs = performance.now() - impactStarted;

  let refusals: readonly ReviewRefusal[];
  let form: ReviewForm | null = null;
  if (parsed.ok) {
    const files = await forkFiles(options.repoPath, request.fork, parsed.form);
    const validation = validateReviewForm({ form: parsed.form, invariants, files, storedShapes });
    refusals = validation.refusals;
    if (validation.accepted) form = parsed.form;
  } else {
    refusals = parsed.refusals;
  }

  // The run goes ahead for a refused form too: its differences are what the reviewer needs next.
  const sideStarted = performance.now();
  const sideBySide = await runSideBySide(options, {
    base: request.base,
    fork: request.fork,
    scope: request.scope,
    riskyInputs: parsed.ok ? parsed.form.riskyInputs : [],
  });
  const sideBySideMs = performance.now() - sideStarted;

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    base: request.base,
    fork: request.fork,
    scope: request.scope,
    state: refusals.length === 0 ? "accepted" : "refused",
    refusals,
    invariants: invariants.map(({ id, scopeId, statement, protected: isProtected }) => ({ id, scopeId, statement, protected: isProtected })),
    storedShapes,
    sideBySide,
    exceptions: reviewExceptions(form, invariants, sideBySide),
    timings: { impactMs, sideBySideMs, totalMs: performance.now() - started },
  };
}

/** The review as text: the verdict and each refusal, the exceptions, then the side-by-side run. */
export function formatReviewResult(result: ReviewResult): string {
  const lines = [`review of scope ${result.scope} on fork ${result.fork.slice(0, 12)}: ${result.state}`];
  for (const refusal of result.refusals) {
    const about = [refusal.invariant, refusal.evidence].filter((part) => part !== undefined).join(", ");
    lines.push(`  refused (${refusal.code})${about === "" ? "" : ` ${about}`}: ${refusal.message}`);
  }
  if (result.storedShapes === null) lines.push("  stored data rule: not checked, no contract diff");
  else for (const shape of result.storedShapes) lines.push(`  stored shape changed: ${shape.symbol} (${shape.path})`);
  for (const exception of result.exceptions) {
    lines.push(
      exception.kind === "broken_invariant"
        ? `  to the owner of ${exception.scope}: invariant ${exception.invariant} reported broken`
        : `  to the owner of ${exception.scope}: ${exception.contract} differs on ${exception.differing} inputs for protected invariant ${exception.invariant}`,
    );
  }
  return `${lines.join("\n")}\n${formatSideBySide(result.sideBySide)}`;
}
