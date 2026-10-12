// Fix writes that wait on a fork another write moved (#133, design.md Build step 4).
//
// Writes into one fork are made one at a time, in approval order (fix-write.ts `waitsFor`). When a
// write is kept, the fork's head moves to its commit. Every other write still waiting on that fork was
// tried on a head without that fix, so before its turn its part is tried again on the new head: the
// same part trial (part-trial.ts) with the new head as its target. A passing trial lets the write take
// its turn. A trial that does not build, or whose tests fail, sends the part back to its originating
// agent with the conflict, as a moved head does, and its write is withdrawn. Each decision is a signed
// `plan_part_retrial` record on the originating feature.

import { isMigrationPlanId, type PartTrialReport, type Plan, type PlanPart } from "@penguin/protocol";

import { approvedPart, isRejection, returnToOriginator, type FixGrant, type FixWriteDeps } from "./fix-write.ts";
import type { StoredPartTrial } from "./part-trial.ts";

/** The longest problem a request quotes: the change request's text stays under its limit. */
const PROBLEM_LENGTH = 600;

export interface RetrialDeps extends FixWriteDeps {
  /** Asks for a trial of the part revision on `head` of its fork; answers the trial's id, or null when none can be asked. */
  readonly queueTrial: (plan: Plan, part: PlanPart, head: string) => number | null;
}

/**
 * Write `written` was kept as `commit`: each other write still waiting on the same fork is tried again
 * on that head. A write whose part moved on is withdrawn. Answers the writes asked to wait.
 */
export async function retryWaitingWrites(deps: RetrialDeps, written: FixGrant, commit: string): Promise<FixGrant[]> {
  const waiting: FixGrant[] = [];
  for (const other of deps.grants.openOn(written.targetFeatureId)) {
    // A migration part's write takes its turn but is not tried again here (migration-plans.ts).
    if (other.id === written.id || isMigrationPlanId(other.planId)) continue;
    const approved = await approvedPart(deps, { feature: other.featureId, part: other.partId, revision: other.revision });
    if (isRejection(approved)) {
      deps.grants.withdraw(other.id);
      continue;
    }
    deps.grants.retrial(other.id, commit, deps.queueTrial(approved.plan, approved.part, commit));
    waiting.push(other);
    deps.notify(approved.plan.person);
  }
  return waiting;
}

/** Why a re-trial failed: no tree was built, or a test did not pass; null when it passed. */
export function retrialProblem(report: PartTrialReport): string | null {
  if (report.status !== "built") return `the approved patch does not build there: ${report.reason ?? "a step did not apply"}`;
  const failing = report.tests.filter((test) => test.status !== "passed");
  if (failing.length === 0) return null;
  return failing
    .map((test) => `${test.commandId} ${test.status}${test.breaks.length > 0 ? ` (${test.breaks.slice(0, 3).join(", ")})` : ""}`)
    .join("; ");
}

export type RetrialDecision = "passed" | "returned";

/**
 * A part trial was recorded: when it is a waiting write's re-trial, the write takes its turn on the new
 * head, or its part goes back to the originating agent with the conflict. Undefined for any other trial.
 */
export async function retrialReported(deps: FixWriteDeps, trial: StoredPartTrial): Promise<RetrialDecision | undefined> {
  const grant = deps.grants.byRetrial(trial.id);
  if (grant === undefined || grant.retrialHead === null || trial.report === null) return undefined;
  const head = grant.retrialHead;
  const approved = await approvedPart(deps, { feature: grant.featureId, part: grant.partId, revision: grant.revision });
  if (isRejection(approved)) {
    deps.grants.withdraw(grant.id);
    return undefined;
  }
  const problem = retrialProblem(trial.report);
  const after = deps.grants.writtenAs(head);
  const record = await deps.sign(
    deps.features.draftRecord(grant.featureId, "plan_part_retrial", { penguin: true }, {
      plan_id: approved.plan.planId,
      part_id: grant.partId,
      revision: grant.revision,
      fork: `feature-${grant.targetFeatureId}`,
      fork_head: head,
      after_part: after?.partId ?? null,
      trial: trial.id,
      result: problem === null ? "passed" : "returned",
      problem: problem?.slice(0, PROBLEM_LENGTH) ?? null,
    }),
  );
  if (problem === null) {
    deps.features.addRecord(record);
    deps.grants.trialled(grant.id, head);
    deps.notify(approved.plan.person);
    return "passed";
  }
  const moved = after === undefined ? "another fix was written into it" : `the fix of part ${after.partId} was written into it`;
  const text =
    `Feature ${grant.targetFeatureId}'s fork moved to ${head}: ${moved}. The part's trial on that head failed: ${problem.slice(0, PROBLEM_LENGTH)}. ` +
    `Revise the part as a patch against ${head}.`;
  deps.grants.withdraw(grant.id);
  // The record is kept with the part's return, as for a moved head.
  await returnToOriginator(deps, approved, head, text, record);
  return "returned";
}
