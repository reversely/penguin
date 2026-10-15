// Fix writes that wait on a fork another write moved (#133 and #142).
//
// Writes into one fork are made one at a time, in approval order (fix-write.ts `waitsFor`). When a
// write is kept, the fork's head moves to its commit. Every other write still waiting on that fork was
// tried on a head without that fix, so before its turn its part is tried again on the new head: the
// same part trial (part-trial.ts) with the new head as its target. A passing trial lets the write take
// its turn. A trial that does not build, or whose tests fail, withdraws the write: a plan part goes
// back to its originating agent with the conflict, as a moved head sends it, and a rule-written
// migration part becomes an edit task (migration-plans.ts). Each decision is a signed
// `plan_part_retrial` record on the originating feature. A migration edit task's run is not tried
// again: it commits its own change on the head it checks out once its turn comes.

import { isMigrationPlanId, type PartTrialReport, type Plan, type PlanPart } from "@penguin/protocol";

import { copyWriteOf, grantedWrite, isRejection,returnToOriginator, type ApprovedPart, type FixGrant, type FixWriteDeps } from "./fix-write.ts";
import type { StoredPartTrial } from "./part-trial.ts";

/** The longest problem a request quotes: the change request's text stays under its limit. */
const PROBLEM_LENGTH = 600;

export interface RetrialDeps extends FixWriteDeps {
  /** Asks for a trial of the plan part revision on `head` of its fork; answers the trial's id, or null when none can be asked. */
  readonly queueTrial: (plan: Plan, part: PlanPart, head: string) => number | null;
}

/**
 * Write `written` was kept as `commit`: each other write still waiting on the same fork is tried again
 * on that head. A write whose part moved on is withdrawn. Answers the writes asked to wait.
 */
export async function retryWaitingWrites(deps: RetrialDeps, written: FixGrant, commit: string): Promise<FixGrant[]> {
  const waiting: FixGrant[] = [];
  for (const other of deps.grants.openOn(written.targetFeatureId)) {
    // A copy write reads the new head when it is claimed: it copies modules byte for byte and runs no trial.
    if (other.id === written.id || other.writer === "task" || copyWriteOf(other) !== undefined) continue;
    const approved = await grantedWrite(deps, other);
    if (isRejection(approved)) {
      deps.grants.withdraw(other.id);
      continue;
    }
    const trial = isMigrationPlanId(other.planId)
      ? ((await deps.migration?.retry?.(other.partId, commit)) ?? null)
      : deps.queueTrial((approved as ApprovedPart).plan, (approved as ApprovedPart).part, commit);
    // A part with no trial to ask takes its turn as the moved head allows (fix-write.ts `prepare`).
    if (trial === null) continue;
    deps.grants.retrial(other.id, commit, trial);
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
 * head, or its part goes back with the conflict: a plan part to its originating agent, a migration part
 * as an edit task. Undefined for any other trial.
 */
export async function retrialReported(deps: FixWriteDeps, trial: StoredPartTrial): Promise<RetrialDecision | undefined> {
  const grant = deps.grants.byRetrial(trial.id);
  if (grant === undefined || grant.retrialHead === null || trial.report === null) return undefined;
  const head = grant.retrialHead;
  const approved = await grantedWrite(deps, grant);
  if (isRejection(approved)) {
    deps.grants.withdraw(grant.id);
    return undefined;
  }
  const problem = retrialProblem(trial.report);
  const after = deps.grants.writtenAs(head);
  const record = await deps.sign(
    deps.features.draftRecord(approved.featureId, "plan_part_retrial", { penguin: true }, {
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
  const failure = `${moved}. The part's trial on that head failed: ${problem.slice(0, PROBLEM_LENGTH)}`;
  deps.grants.withdraw(grant.id);
  if (isMigrationPlanId(grant.planId)) {
    deps.features.addRecord(record);
    await deps.migration?.headMoved(grant.partId, head, failure);
    return "returned";
  }
  const text = `Feature ${grant.targetFeatureId}'s fork moved to ${head}: ${failure}. Revise the part as a patch against ${head}.`;
  // The record is kept with the part's return, as for a moved head.
  await returnToOriginator(deps, approved as ApprovedPart, head, text, record);
  return "returned";
}
