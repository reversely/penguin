// How the dashboard words and lays out a feature's pipeline (pipeline.ts in @penguin/protocol): each
// stage's name and count, each job's label and one fact, and the rows of the branches that hang under
// the timeline bar. Pure, so the rules are tested without a browser (test/pipeline-view.test.ts). Every
// string is a bare label, a count or one clause with no comma.

import { PENGUIN_APPROVER } from "@penguin/protocol";
import type { FeaturePipeline, JobFact, JobStatus, PipelineBranch, PipelineStageKey, PipelineStrip } from "@penguin/protocol";

import { counted, partNumber, PENGUIN_NAME, RUN_KIND_LABEL, shortSha } from "./feature-view.ts";

export const STAGE_LABEL: Readonly<Record<PipelineStageKey, string>> = {
  open: "Open",
  expand: "Expand",
  migrate: "Migrate",
  contract: "Contract",
  done: "Done",
  plan: "Plan",
  review: "Review",
  fixes: "Fixes written",
  checks: "Block checks",
  promoted: "Promoted",
};

export const STATUS_LABEL: Readonly<Record<JobStatus, string>> = {
  waiting: "Waiting",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  person: "Needs a person",
};

/** A stage's count of passed jobs, `7 of 10`, or null for a stage with no job. */
export function stageCount(stage: { readonly passed: number; readonly jobs: number }): string | null {
  return stage.jobs === 0 ? null : `${stage.passed} of ${stage.jobs}`;
}

/** The current stage's name, with its status when it is not simply running: `Review`, `Review needs a person`. */
export function currentStageText(strip: PipelineStrip): string {
  const stage = strip.stages[strip.current];
  if (stage === undefined) return "";
  const name = STAGE_LABEL[stage.key];
  if (stage.status === "person") return `${name} needs a person`;
  if (stage.status === "failed") return `${name} failed`;
  return name;
}

const approver = (by: string | null) => (by === null ? null : by === PENGUIN_APPROVER ? PENGUIN_NAME : by);

/** A place by its name alone: `analytics`, `retention-dashboard`. */
export function placeName(place: { readonly kind: "scope"; readonly scope: string } | { readonly kind: "feature"; readonly feature: string }): string {
  return place.kind === "scope" ? place.scope : place.feature;
}

/** One job as a label and one fact. */
export function jobText(fact: JobFact): { readonly label: string; readonly fact: string } {
  switch (fact.kind) {
    case "start":
      return {
        label: fact.feature.startsWith("owner:") ? `Scopes of ${fact.person}` : fact.feature,
        fact: fact.by === null ? `Waits for ${fact.person}` : `Approved by ${fact.by}`,
      };
    case "facts":
      return { label: "Facts run", fact: fact.state === "pending" ? "With the runner" : fact.state === "reported" ? "Reported" : "Replaced" };
    case "plan":
      if (fact.returned) return { label: "Plan", fact: `Returned with ${fact.inPerson} needing a person` };
      return { label: fact.planId ?? "Plan", fact: fact.planId === null ? "No plan yet" : counted(fact.parts, "part") };
    case "part":
      return { label: `${partNumber(fact.partId)} ${placeName(fact.place)}`, fact: partFact(fact) };
    case "write":
      return { label: fact.feature, fact: WRITE_FACT[fact.state] };
    case "check":
      return {
        label: fact.check,
        fact: fact.failed > 0 ? `Failed on ${fact.failed} of ${counted(fact.targets, "target")}` : `Passed on ${counted(fact.targets, "target")}`,
      };
    case "check-run":
      return { label: "Check run", fact: "With the runner" };
    case "block":
      return { label: "Block run", fact: STATUS_LABEL[fact.state] };
    case "promotion":
      return { label: "Main", fact: PROMOTION_FACT[fact.state] + (fact.mainAfter === null ? "" : ` to ${shortSha(fact.mainAfter)}`) };
    case "protected":
      return { label: `Protected lines of ${fact.owner}`, fact: fact.state === "confirmed" ? "Confirmed" : `Waits for ${fact.owner}` };
    case "expand":
      return { label: fact.checkpoint === null ? "Expand" : `Expand ${shortSha(fact.checkpoint)}`, fact: EXPAND_FACT[fact.state] };
    case "group":
      return { label: fact.owner, fact: `${fact.approved} of ${counted(fact.parts, "part")} approved` };
    case "contract":
      return { label: "Retiring symbols", fact: counted(fact.symbols, "symbol") };
    case "stopped":
      return { label: RUN_KIND_LABEL[fact.run], fact: `Stopped after ${counted(fact.failures, "failure")}` };
  }
}

const WRITE_FACT: Readonly<Record<Extract<JobFact, { kind: "write" }>["state"], string>> = {
  none: "Not written",
  queued: "Queued for the runner",
  granted: "Agent holds the token",
  written: "Written",
  withdrawn: "Withdrawn",
  refused: "Refused",
};

const PROMOTION_FACT: Readonly<Record<Extract<JobFact, { kind: "promotion" }>["state"], string>> = {
  waiting: "Waiting",
  running: "Moving",
  promoted: "Moved",
  refused: "Refused",
  returned: "Returned",
};

const EXPAND_FACT: Readonly<Record<Extract<JobFact, { kind: "expand" }>["state"], string>> = {
  waiting: "Waits for the expand checkpoint",
  running: "Running",
  promoted: "Promoted",
  returned: "Returned",
};

function partFact(fact: Extract<JobFact, { kind: "part" }>): string {
  if (fact.state === "approved") return `Approved by ${approver(fact.approvedBy) ?? fact.owner}`;
  if (fact.state === "round_limit") return "Past the round limit";
  if (fact.state === "change_requested") return "Change requested";
  if (fact.review === "none") return "No review yet";
  if (fact.review === "pending") return "Review with the runner";
  if (fact.review === "refused") return "Review refused";
  return `Waits for ${fact.owner}`;
}

/** A line of the vertical rails beside a branch: `rail` passes by, `tee` meets a branch and goes on, `elbow` ends at one. */
export type RailCell = "none" | "rail" | "tee" | "elbow";

/** One branch hanging under the bar, with the rail cells to the left of its content. */
export interface BranchRow {
  readonly branch: PipelineBranch;
  /** The column of the stage it hangs from, 0-based. */
  readonly column: number;
  /** One cell per column up to and including `column`. */
  readonly cells: readonly RailCell[];
}

/**
 * The unsettled branches as rows under the bar. Rows run from the latest stage to the earliest, so a
 * rail from an earlier stage passes only the rows of later stages, whose content starts to its right.
 * Settled branches have rejoined the bar and get no row.
 */
export function branchRows(pipeline: Pick<FeaturePipeline, "stages" | "branches">): BranchRow[] {
  const column = (stage: PipelineStageKey) => pipeline.stages.findIndex((each) => each.key === stage);
  const open = pipeline.branches
    .filter((branch) => !branch.settled)
    .map((branch, order) => ({ branch, column: column(branch.stage), order }))
    .filter((row) => row.column >= 0)
    .sort((a, b) => b.column - a.column || a.order - b.order);
  return open.map((row, index) => {
    const later = open.slice(index + 1);
    const cells: RailCell[] = [];
    for (let each = 0; each < row.column; each += 1) cells.push(later.some((next) => next.column === each) ? "rail" : "none");
    cells.push(later.some((next) => next.column === row.column) ? "tee" : "elbow");
    return { branch: row.branch, column: row.column, cells };
  });
}

/** The settled branches at each stage: the people who rejoined the bar there. */
export function settledAt(pipeline: Pick<FeaturePipeline, "branches">, stage: PipelineStageKey): string[] {
  return [...new Set(pipeline.branches.filter((branch) => branch.settled && branch.stage === stage).map((branch) => branch.person))];
}

/** The element id of a part's node in the change tree: `part-3` for `money/v1#3`. */
export function partAnchor(partId: string): string {
  return `part-${partNumber(partId).replace("#", "")}`;
}
