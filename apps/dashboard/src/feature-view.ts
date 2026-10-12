// What the team view, the feature page and the approvals inbox derive from their API answers, as
// pure functions so the rules are tested without a browser (test/feature-view.test.ts). Labels here
// are bare data labels: a state, a count, a place, a tool and what it found.

import type {
  BlockCheck,
  FeatureException,
  FeatureStateWord,
  PartRoutingReason,
  PlanPartRequest,
  PlanPartState,
  PlanPlace,
  ReviewException,
  ReviewView,
} from "@penguin/protocol";

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
  retire_symbols: "Symbols retiring",
  approve_plan_part: "Part approved",
  request_plan_change: "Change requested",
  revise_plan_part: "Part revised",
  plan_round_limit: "Past the round limit",
  confirm_protected_change: "Protected lines confirmed",
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

const NUMBER = new Intl.NumberFormat("en-US");

/** A count as the dashboard prints it, grouped by thousands: `1,633`. */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/** A count with its noun, singular for one: `1 input`, `3 inputs`, `1,633 inputs`. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** One merge plan's parts in a person's approvals, with what the parts share said once. */
export interface PlanGroup {
  /** The plan's id, `money-minor-units/v1`, taken from its parts' ids. */
  readonly planId: string;
  readonly feature: string;
  readonly person: string;
  readonly parts: readonly PlanPartRequest[];
  /** Each review the parts carry, once, in the order the parts first name them. */
  readonly reviews: readonly ReviewView[];
  /** Why the plan needs the person in person, each line once. */
  readonly reasons: readonly string[];
  readonly unread: boolean;
}

/** The plan a part belongs to: its id up to the part number. */
function planOf(partId: string): string {
  const hash = partId.lastIndexOf("#");
  return hash === -1 ? partId : partId.slice(0, hash);
}

/**
 * The person's plan parts grouped by plan, in the order each plan first appears. Several parts of one
 * plan often touch the same scope, so they carry the same review and the same reasons; the group holds
 * each once (#107: three parts of the money plan repeated one review and its 1,633-input run).
 */
export function planGroups(parts: readonly PlanPartRequest[]): PlanGroup[] {
  interface Building {
    readonly feature: string;
    readonly person: string;
    readonly parts: PlanPartRequest[];
    readonly reviews: Map<number, ReviewView>;
    readonly reasons: Set<string>;
    unread: boolean;
  }
  const groups = new Map<string, Building>();
  for (const part of parts) {
    const planId = planOf(part.partId);
    const group: Building = groups.get(planId) ?? { feature: part.feature, person: part.person, parts: [], reviews: new Map(), reasons: new Set(), unread: false };
    group.parts.push(part);
    for (const review of part.reviews) if (!group.reviews.has(review.reviewId)) group.reviews.set(review.reviewId, review);
    for (const reason of part.routing.reasons) group.reasons.add(reasonText(reason));
    group.unread ||= !part.read;
    groups.set(planId, group);
  }
  return [...groups.entries()].map(([planId, group]) => ({
    planId,
    feature: group.feature,
    person: group.person,
    parts: group.parts,
    reviews: [...group.reviews.values()],
    reasons: [...group.reasons],
    unread: group.unread,
  }));
}

/** The element id of a review's card, which a review exception shown with its plan links to. */
export function reviewAnchor(reviewId: number): string {
  return `review-${reviewId}`;
}

/** The round of a part against the project's limit: `round 2 of 3`. */
export function roundText(changeRequests: number, roundLimit: number): string {
  return `round ${changeRequests} of ${roundLimit}`;
}
