// How the dashboard words and lays out a feature's pipeline (pipeline.ts in @penguin/protocol): each
// stage's name and count, each job's label and one fact, the branches that hang under the timeline
// bar (one per person per stage, with that person's parts and edit tasks) and a steward's queue. Pure, so the rules are tested without a browser (test/pipeline-view.test.ts). Every
// string is a bare label, a count or one clause with no comma.

import { PENGUIN_APPROVER } from "@penguin/protocol";
import type { EditAskReason, EditQueue, EditTaskKind, EditTaskState, EditTaskView, FeaturePipeline, JobFact, JobStatus, PipelineBranch, PipelineStageKey, PipelineStrip } from "@penguin/protocol";

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

/** The name of a feature that needs no plan and has not asked to land, as its strip and its stage pill read it. */
export const BUILDING_LABEL = "Building";

/** The name of a last stage main has not moved for, as its strip and its stage pill read it. */
export const PROMOTION_LABEL = "Promotion";

/**
 * The current stage's name, with its status when it is not simply running: `Review`, `Review needs a
 * person`. A feature still building reads `Building`. A last stage main has not moved for reads
 * `Promotion`, so only a feature on main reads `Promoted` or `Done`.
 */
export function currentStageText(strip: PipelineStrip): string {
  const stage = strip.stages[strip.current];
  if (stage === undefined) return "";
  if (strip.building === true && stage.status !== "person" && stage.status !== "failed") return BUILDING_LABEL;
  const last = stage.key === "promoted" || stage.key === "done";
  const name = last && stage.status !== "passed" ? PROMOTION_LABEL : STAGE_LABEL[stage.key];
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
      if (fact.needed === false) return { label: "Plan", fact: "No plan needed" };
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
  waiting: "Waits for its turn on the fork",
  queued: "Queued",
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

/** How soon an item needs someone: 0 needs a person, 1 runs, 2 waits, 3 is done and not yet settled. */
export type Urgency = 0 | 1 | 2 | 3;

/** What a branch item is, as its group counts it. */
type ItemNoun = "part" | "task" | "start" | "path" | "run";

/** The order a group's count names its kinds of item in. */
const NOUN_ORDER: readonly ItemNoun[] = ["part", "start", "path", "run", "task"];

/** One piece of work under a branch: a part, a start or a confirmation that reached the person, or an edit task. */
export interface BranchItem {
  readonly key: string;
  /** The agent or identity that took it; null while none has. */
  readonly agent: string | null;
  /** The tag: a branch label, or `running`, `queued` or `asked` for a task. */
  readonly label: string;
  readonly urgency: Urgency;
  /** The part whose diff it links to, or null. */
  readonly partId: string | null;
  readonly noun: ItemNoun;
  /** The edit task it shows, or null for a pipeline branch. */
  readonly task: EditTaskView | null;
}

/** One person's work at one stage: one branch on the timeline, opening to its items. */
export interface BranchGroup {
  readonly key: string;
  readonly stage: PipelineStageKey;
  readonly person: string;
  /** The agent every item shares, or null when the items name none or several. */
  readonly agent: string | null;
  /** The most urgent item's tag. */
  readonly label: string;
  readonly urgency: Urgency;
  /** Most urgent first. */
  readonly items: readonly BranchItem[];
}

/** One branch hanging under the bar, with the rail cells to the left of its content. */
export interface BranchRow {
  readonly group: BranchGroup;
  /** The column of the stage it hangs from, 0-based. */
  readonly column: number;
  /** One cell per column up to and including `column`. */
  readonly cells: readonly RailCell[];
}

const LABEL_URGENCY: Readonly<Record<PipelineBranch["label"], Urgency>> = {
  "needs a person": 0,
  reviewing: 1,
  sent: 2,
  waiting: 2,
  "fix written": 3,
  approved: 3,
};

type OpenTaskState = Exclude<EditTaskState, "done" | "dropped">;

/** An open task's tag: a session took it or the bridge runs it, it waits for one, or its person is asked. */
export const TASK_LABEL: Readonly<Record<OpenTaskState, string>> = { running: "running", delivered: "running", queued: "queued", asked: "asked" };
const TASK_URGENCY: Readonly<Record<OpenTaskState, Urgency>> = { asked: 0, running: 1, delivered: 1, queued: 2 };

export const TASK_KIND_LABEL: Readonly<Record<EditTaskKind, string>> = {
  migration: "Migration",
  contract: "Contract step",
  fix: "Fix",
  next_step: "Next step",
  review: "Review form",
};

export const ASK_REASON_LABEL: Readonly<Record<EditAskReason, string>> = {
  bridge_offline: "Bridge offline",
  needs_session: "Needs a session",
  no_identity: "No identity holds it",
  run_failed: "Run failed",
  run_timeout: "Run timed out",
  lease_expired: "Run stopped reporting",
};

/** The name of the identity that took a task, the handle's part after its slash, or null while its person is asked. */
const takenBy = (task: Pick<EditTaskView, "handle">): string | null => (task.handle === null ? null : task.handle.slice(task.handle.indexOf("/") + 1));

/**
 * A task as its branch item names it: its kind and its scope, its file count or the fork it edits,
 * `Review form analytics`. A builder's fix into its own feature's fork reads `Fix`, since the
 * builder's name already names the fork.
 */
export function taskText(task: Pick<EditTaskView, "kind" | "target" | "scopes" | "files" | "handle">): string {
  const where = task.kind === "fix" ? task.target : (task.scopes[0] ?? (task.files.length > 0 ? counted(task.files.length, "file") : task.target));
  return where === takenBy(task) ? TASK_KIND_LABEL[task.kind] : `${TASK_KIND_LABEL[task.kind]} ${where}`;
}

/** The kind of identity that took a task, `builder` or `steward`, when the identity's name does not say it; else null. */
export function taskVia(task: Pick<EditTaskView, "handle" | "via">): string | null {
  const name = takenBy(task);
  return name === null || name === task.via ? null : task.via;
}

/**
 * The stage a task serves: on a split, Contract for a contract step, else Migrate; on a plan, Review
 * for a review form, Fixes written for a fix, else Block checks.
 */
export function taskStage(path: FeaturePipeline["path"], kind: EditTaskKind): PipelineStageKey {
  if (path === "split") return kind === "contract" ? "contract" : "migrate";
  return kind === "review" ? "review" : kind === "fix" ? "fixes" : "checks";
}

const isOpen = (state: EditTaskState): state is OpenTaskState => state !== "done" && state !== "dropped";

const NOUN: Readonly<Record<JobFact["kind"], ItemNoun>> = {
  start: "start",
  facts: "run",
  plan: "part",
  part: "part",
  write: "part",
  check: "run",
  "check-run": "run",
  block: "run",
  promotion: "run",
  protected: "path",
  expand: "run",
  group: "part",
  contract: "part",
  stopped: "run",
};

/**
 * The open branches grouped by stage and person: one group per person per stage. Items and groups run
 * needs a person, then running, then waiting. Each open edit task the feature raised joins its person's
 * group at the stage it serves; a task another feature raised in this feature's fork shows on that
 * feature's timeline. Settled branches have rejoined the bar and join no group.
 */
export function branchGroups(pipeline: Pick<FeaturePipeline, "path" | "stages" | "branches">, feature: string, tasks: readonly EditTaskView[] = []): BranchGroup[] {
  const kinds = new Map(pipeline.stages.flatMap((stage) => stage.jobs.map((job) => [job.key, job.fact.kind] as const)));
  const groups = new Map<string, { readonly stage: PipelineStageKey; readonly person: string; readonly items: BranchItem[] }>();
  const add = (stage: PipelineStageKey, person: string, item: BranchItem) => {
    const key = `${stage} ${person}`;
    const group = groups.get(key) ?? { stage, person, items: [] };
    group.items.push(item);
    groups.set(key, group);
  };
  for (const branch of pipeline.branches) {
    if (branch.settled) continue;
    const kind = kinds.get(branch.key);
    add(branch.stage, branch.person, { key: branch.key, agent: branch.agent, label: branch.label, urgency: LABEL_URGENCY[branch.label], partId: branch.partId, noun: kind === undefined ? "part" : NOUN[kind], task: null });
  }
  for (const task of tasks) {
    if (task.feature !== feature || !isOpen(task.state)) continue;
    // A queued task whose write waits for its fork's turn is tagged waiting.
    const waits = task.state === "queued" && task.waitsFor != null;
    add(taskStage(pipeline.path, task.kind), task.person, { key: `task:${task.id}`, agent: task.handle, label: waits ? "waiting" : TASK_LABEL[task.state], urgency: TASK_URGENCY[task.state], partId: null, noun: "task", task });
  }
  // Array.prototype.sort is stable, so items and groups of one urgency keep the pipeline's order.
  return [...groups.entries()]
    .map(([key, group]): BranchGroup => {
      const items = [...group.items].sort((a, b) => a.urgency - b.urgency);
      const first = items[0] as BranchItem;
      const agent = new Set(items.map((item) => item.agent)).size === 1 ? first.agent : null;
      return { key, stage: group.stage, person: group.person, agent, label: first.label, urgency: first.urgency, items };
    })
    .sort((a, b) => a.urgency - b.urgency);
}

/** A group's count by kind of item, `2 parts 1 task`, or null for a group of one item. */
export function groupCount(group: Pick<BranchGroup, "items">): string | null {
  if (group.items.length < 2) return null;
  return NOUN_ORDER.flatMap((noun) => {
    const count = group.items.filter((item) => item.noun === noun).length;
    return count === 0 ? [] : [counted(count, noun)];
  }).join(" ");
}

/**
 * The branch groups as rows under the bar. Rows run from the latest stage to the earliest, so a rail
 * from an earlier stage passes only the rows of later stages, whose content starts to its right.
 * Within a stage the groups keep their urgency order.
 */
export function branchRows(pipeline: Pick<FeaturePipeline, "path" | "stages" | "branches">, feature = "", tasks: readonly EditTaskView[] = []): BranchRow[] {
  const column = (stage: PipelineStageKey) => pipeline.stages.findIndex((each) => each.key === stage);
  const open = branchGroups(pipeline, feature, tasks)
    .map((group, order) => ({ group, column: column(group.stage), order }))
    .filter((row) => row.column >= 0)
    .sort((a, b) => b.column - a.column || a.order - b.order);
  return open.map((row, index) => {
    const later = open.slice(index + 1);
    const cells: RailCell[] = [];
    for (let each = 0; each < row.column; each += 1) cells.push(later.some((next) => next.column === each) ? "rail" : "none");
    cells.push(later.some((next) => next.column === row.column) ? "tee" : "elbow");
    return { group: row.group, column: row.column, cells };
  });
}

/** A steward's queue as bare counts: `1 of 2 running`, then queued and asked when any. */
export function queueCounts(queue: EditQueue): { readonly key: "running" | "queued" | "asked"; readonly text: string }[] {
  const out: { readonly key: "running" | "queued" | "asked"; readonly text: string }[] = [{ key: "running", text: `${queue.running} of ${queue.cap} running` }];
  if (queue.queued > 0) out.push({ key: "queued", text: `${queue.queued} queued` });
  if (queue.asked > 0) out.push({ key: "asked", text: `${queue.asked} asked` });
  return out;
}

/** The settled branches at each stage: the people who rejoined the bar there. */
export function settledAt(pipeline: Pick<FeaturePipeline, "branches">, stage: PipelineStageKey): string[] {
  return [...new Set(pipeline.branches.filter((branch) => branch.settled && branch.stage === stage).map((branch) => branch.person))];
}

/** The element id of a part's node in the change tree: `part-3` for `money/v1#3`. */
export function partAnchor(partId: string): string {
  return `part-${partNumber(partId).replace("#", "")}`;
}
