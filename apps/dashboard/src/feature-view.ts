// What the team view, the feature page and the approvals inbox derive from their API answers, as
// pure functions so the rules are tested without a browser (test/feature-view.test.ts). Labels here
// are bare data labels: a state, a count, a place, a tool and what it found.

import type { BlockCheck, FeatureException, FeatureStateWord, PartRoutingReason, PlanPartState, PlanPlace, ReviewException } from "@penguin/protocol";

/** The CSS classes of a feature's state tag, a neutral tag for every state. */
export function stateClass(state: FeatureStateWord): string {
  return `feature-state feature-state-${state.replaceAll(" ", "-")}`;
}

/** The part's number within its plan: `money-minor-units/v1#9` is `#9`. */
export function partNumber(partId: string): string {
  const hash = partId.lastIndexOf("#");
  return hash === -1 ? partId : partId.slice(hash);
}

/** A plan place as a label: `scope tax` or `feature japan-launch`. */
export function placeText(place: PlanPlace): string {
  return place.kind === "scope" ? `scope ${place.scope}` : `feature ${place.feature}`;
}

export const PART_STATE_LABEL: Readonly<Record<PlanPartState, string>> = {
  pending: "Waiting for approval",
  approved: "Approved",
  change_requested: "Change requested",
  round_limit: "Past the round limit",
};

/** An exception PRD section 7 routes to a person, as one highlighted line on its feature. */
export function exceptionText(exception: FeatureException): string {
  switch (exception.kind) {
    case "round_limit":
      return `Part ${partNumber(exception.partId)} past the round limit`;
    case "plan_returned":
      return `Plan returned: ${exception.behavioural} behavioural parts over the limit of ${exception.breakLimit}`;
    case "broken_invariant":
      return `${exception.invariant} reported broken in ${exception.scope}`;
    case "protected_difference":
      return `${exception.differing} inputs differ on protected ${exception.invariant}`;
  }
}

/** Why a part needs its author in person, as one line. */
export function reasonText(reason: PartRoutingReason): string {
  switch (reason.kind) {
    case "broken_invariant":
      return `The review reports ${reason.invariant} broken in ${reason.scope}`;
    case "protected_difference":
      return `${reason.differing} inputs of ${reason.contract} differ on protected ${reason.invariant}`;
    case "protected_path":
      return `Writes ${reason.file} under ${reason.path}, which ${reason.owner} protects`;
  }
}

/** A review's exception as one line. */
export function reviewExceptionText(exception: ReviewException): string {
  return exception.kind === "broken_invariant"
    ? `${exception.invariant} reported broken`
    : `${exception.differing} inputs of ${exception.contract} differ on protected ${exception.invariant}`;
}

const RECORD_LABEL: Readonly<Record<string, string>> = {
  open_feature: "Opened",
  declare_area: "Area declared",
  checkpoint_area: "Checkpoint",
  overlap_check: "Overlap check",
  approve_overlap: "Start approved",
  propose_plan: "Plan proposed",
  plan_returned: "Plan returned",
  approve_plan_part: "Part approved",
  request_plan_change: "Change requested",
  revise_plan_part: "Part revised",
  plan_round_limit: "Past the round limit",
};

/** A signed record's type as a label; a type the dashboard does not know shows as stored. */
export function recordLabel(type: string): string {
  return RECORD_LABEL[type] ?? type;
}

/** The first 12 characters of a commit, as the record and the tools print it. */
export function shortSha(sha: string | null): string {
  return sha === null ? "" : sha.slice(0, 12);
}

/** One tool's checks on a block: the tool, what it ran and its result on each target. */
export interface ToolChecks {
  readonly key: string;
  /** The tool's name with its version when it reports one, such as `pyright 1.1.414`. */
  readonly tool: string;
  readonly commandId: string;
  readonly check: string;
  readonly checks: readonly BlockCheck[];
  /** Checks that failed or could not run. */
  readonly failing: number;
}

/** Block checks grouped by the tool that ran them, in the order the runner reported each tool. */
export function checksByTool(checks: readonly BlockCheck[]): ToolChecks[] {
  const groups = new Map<string, { tool: string; commandId: string; check: string; checks: BlockCheck[] }>();
  for (const check of checks) {
    const key = `${check.tool.commandId}\u0000${check.check}`;
    const tool = check.tool.version === null ? check.tool.name : `${check.tool.name} ${check.tool.version}`;
    const group = groups.get(key) ?? { tool, commandId: check.tool.commandId, check: check.check, checks: [] };
    group.checks.push(check);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    ...group,
    failing: group.checks.filter((check) => check.result === "failed" || check.result === "error").length,
  }));
}

/** A count with its noun, singular for one: `1 input`, `3 inputs`. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The round of a part against the project's limit: `round 2 of 3`. */
export function roundText(changeRequests: number, roundLimit: number): string {
  return `round ${changeRequests} of ${roundLimit}`;
}
