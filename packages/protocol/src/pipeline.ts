// A feature's merge as a pipeline of stages (PRD 0.5 sections 4.1 to 4.5), derived from facts Penguin
// already holds: the feature's signed records, its overlap locks, its plan's parts as the routing
// keeps them, the reviews, the fix writes, the newest block checks and the protected-path
// confirmations. Nothing here is stored; the ProjectAgent derives the pipeline on each read of the team
// view and the feature page (services/project-agent/src/dashboard-views.ts).
//
// Two paths, as GitLab's pipelines run stages in sequence with the jobs of a stage in parallel
// (docs/research/gitlab-pipelines.txt):
//
// - **Split** (PRD 4.2 step 2), for an incompatible contract change: Open, Expand, Migrate, Contract,
//   Done. A feature is on this path once it asked for an expand promotion or declared retiring symbols.
// - **Plan** (PRD 4.2 step 3 to 4.5), for a behaviour change: Open, Plan, Review, Fixes written, Block
//   checks, Promoted.
//
// A stage's status follows its jobs: failed when any job failed, needing a person when any job does,
// running when any job runs, passed when every job passed. A stage with no job passes once the stage
// before it passed, since nothing in it waits. A failed stage stops every stage after it, which then
// waits, as in GitLab: "If any job in a stage fails, the next stage" does not run. The current stage is
// the first that has not passed.
//
// A branch is the work reaching another person or their agent: a start waiting on their approval, a
// plan part sent to them, a fix written into their fork, a migration group of theirs, a protected-path
// confirmation. A branch is settled once approved, written or confirmed, and then rejoins the bar.
//
// Every value is data; the dashboard words it (apps/dashboard/src/pipeline-view.ts).

import type { BlockCheck } from "./block-check.ts";
import type { RunKind } from "./run-failure.ts";
import type { PlanPartState, PlanPlace } from "./plan.ts";

export const SPLIT_STAGES = ["open", "expand", "migrate", "contract", "done"] as const;
export const PLAN_STAGES = ["open", "plan", "review", "fixes", "checks", "promoted"] as const;
export type SplitStage = (typeof SPLIT_STAGES)[number];
export type PlanStage = (typeof PLAN_STAGES)[number];
export type PipelineStageKey = SplitStage | PlanStage;
export type PipelinePath = "split" | "plan";

/** One job's status, and a stage's from its jobs. `person`: a person must decide before it moves. */
export const JOB_STATUSES = ["waiting", "running", "passed", "failed", "person"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Where a part's review stands, read from the newest review of its scopes. */
export type PartReviewState = "none" | "pending" | "accepted" | "refused";

/** What a job shows, as data. */
export type JobFact =
  /** An overlapping start, waiting on `person` or approved by `by` (PRD 4.1 step 3). */
  | { readonly kind: "start"; readonly feature: string; readonly person: string; readonly by: string | null }
  /** The plan facts run on the check runner. */
  | { readonly kind: "facts"; readonly state: "pending" | "reported" | "superseded" }
  /** The newest plan: stored with its parts, or returned over the break limit with the parts needing a person. */
  | { readonly kind: "plan"; readonly planId: string | null; readonly parts: number; readonly returned: boolean; readonly inPerson: number }
  /** One plan part in review. */
  | {
      readonly kind: "part";
      readonly partId: string;
      readonly place: PlanPlace;
      readonly owner: string;
      readonly state: PlanPartState;
      readonly approvedBy: string | null;
      readonly review: PartReviewState;
      readonly reviewer: string | null;
    }
  /**
   * One fix written into a running feature's fork. `none`: no write asked yet; `waiting`: it waits for
   * its turn on the fork (another write holds it, one approved earlier goes first, or the part is tried
   * again on the head another fix left); `refused`: Penguin refused the pushed fix.
   */
  | { readonly kind: "write"; readonly partId: string; readonly feature: string; readonly owner: string; readonly state: "none" | "waiting" | "queued" | "granted" | "written" | "withdrawn" | "refused" }
  /** One check kind of the newest block checks, over its targets. */
  | {
      readonly kind: "check";
      readonly check: string;
      readonly targets: number;
      readonly failed: number;
      readonly failing: readonly string[];
      /**
       * What a passing check still names on its targets, such as the dependency diff's changed library
       * and each place the target imports it, up to CHECK_FINDINGS_SHOWN.
       */
      readonly findings: readonly { readonly target: string; readonly path: string | null; readonly message: string }[];
    }
  /** A check run the runner has claimed and not reported. */
  | { readonly kind: "check-run" }
  /** A block run asked by `land`: running until checked, failed when its checks fail. */
  | { readonly kind: "block"; readonly state: "running" | "passed" | "failed" }
  /** Main's move to the feature's checkpoint. */
  | { readonly kind: "promotion"; readonly state: "waiting" | "running" | "promoted" | "refused" | "returned"; readonly mainAfter: string | null }
  /** A person's confirmation of the feature's own lines under a path they protect. */
  | { readonly kind: "protected"; readonly owner: string; readonly state: "pending" | "confirmed" }
  /** One expand checkpoint promoted on its own (PRD 4.2 step 2). */
  | { readonly kind: "expand"; readonly checkpoint: string | null; readonly state: "waiting" | "running" | "promoted" | "returned" }
  /** One owner's migration group: its parts and how many are approved. */
  | { readonly kind: "group"; readonly owner: string; readonly parts: number; readonly approved: number; readonly partId: string | null }
  /** The retiring symbols the contract step removes. */
  | { readonly kind: "contract"; readonly symbols: number; readonly state: "waiting" | "running" | "promoted" }
  /** A run the check runner failed as often as the failure limit, with its last reason (run-failure.ts). */
  | { readonly kind: "stopped"; readonly run: RunKind; readonly runId: string; readonly failures: number; readonly reason: string };

export interface PipelineJob {
  readonly key: string;
  readonly status: JobStatus;
  readonly fact: JobFact;
}

export interface PipelineStage {
  readonly key: PipelineStageKey;
  readonly status: JobStatus;
  readonly jobs: readonly PipelineJob[];
}

export const BRANCH_LABELS = ["sent", "reviewing", "waiting", "fix written", "approved", "needs a person"] as const;
export type BranchLabel = (typeof BRANCH_LABELS)[number];

/** The feature's work reaching another person or their agent, at the stage where it happened. */
export interface PipelineBranch {
  readonly key: string;
  readonly stage: PipelineStageKey;
  readonly person: string;
  /** The other person's agent that took the work, such as the reviewer; null when none has yet. */
  readonly agent: string | null;
  readonly label: BranchLabel;
  /** The part whose diff the branch links to, or null for a start or a confirmation. */
  readonly partId: string | null;
  readonly settled: boolean;
}

/** A checkpoint an agent reported, with the newest block checks run on it. */
export interface PipelineActivity {
  readonly agent: string;
  readonly checkpoint: string;
  readonly at: string;
  /** Checks run on the checkpoint and how many failed; null when none ran on it. */
  readonly checks: { readonly total: number; readonly failed: number } | null;
}

/** The stage strip alone, as the team view shows it beside each feature. */
export interface PipelineStrip {
  readonly path: PipelinePath;
  /** Index into `stages` of the current stage. */
  readonly current: number;
  readonly stages: readonly { readonly key: PipelineStageKey; readonly status: JobStatus; readonly passed: number; readonly jobs: number }[];
}

/** The pipeline as the feature page shows it. */
export interface FeaturePipeline {
  readonly path: PipelinePath;
  readonly current: number;
  readonly stages: readonly PipelineStage[];
  readonly branches: readonly PipelineBranch[];
  /** The newest checkpoints the feature's agents reported, newest first. */
  readonly activity: readonly PipelineActivity[];
}

/** A signed record as the pipeline reads it: its type, its author and its payload. */
export interface PipelineRecord {
  readonly type: string;
  /** A person's id, an identity's handle or `penguin`. */
  readonly author: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What the pipeline is derived from: facts the ProjectAgent holds, none of them stored for it. */
export interface PipelineFacts {
  readonly person: string;
  /** `closed`: a block feature Penguin opened that was left with no part; nothing landed. */
  readonly state: "opening" | "building" | "landing" | "landed" | "closed";
  /** The feature's signed records, oldest first. */
  readonly records: readonly PipelineRecord[];
  /** The plan facts run of the latest checkpoint, or undefined for none. */
  readonly factsRun: "pending" | "reported" | "superseded" | undefined;
  readonly locks: readonly { readonly feature: string; readonly person: string; readonly state: "open" | "approved"; readonly approvedBy: string | null }[];
  /** The locks an expand checkpoint opened on other owners' scopes (`owner:<person>`). */
  readonly expandLocks: PipelineFacts["locks"];
  /** The parts of the newest plan, as the routing keeps them. */
  readonly parts: readonly { readonly partId: string; readonly owner: string; readonly place: PlanPlace; readonly scopes: readonly string[]; readonly revision: number; readonly state: PlanPartState }[];
  /** The reviews submitted on the feature, oldest first. */
  readonly reviews: readonly { readonly reviewId: number; readonly scope: string; readonly reviewer: string; readonly state: "pending" | "accepted" | "refused" }[];
  /** The write of each part's current revision into another fork; `waiting` while it waits for the fork's turn. */
  readonly writes: ReadonlyMap<string, "waiting" | "queued" | "granted" | "written" | "withdrawn">;
  /**
   * Writes of other features' plans into this feature's fork that wait for their turn there, oldest
   * first: each part, the originating feature and its person. Absent, none.
   */
  readonly incoming?: readonly { readonly partId: string; readonly feature: string; readonly person: string }[];
  /** The newest `check` run: its checks once reported, and whether the runner still holds it. */
  readonly checks: { readonly checks: readonly BlockCheck[]; readonly waiting: boolean; readonly checkpoint: string | null } | null;
  /** Every reported `check` run with the checkpoint it ran on, for the agents' activity. */
  readonly checkRuns: readonly { readonly checkpoint: string | null; readonly checks: readonly BlockCheck[] }[];
  readonly protectedChanges: readonly { readonly owner: string; readonly state: "pending" | "confirmed" }[];
  /** The feature's runs the check runner stopped at the failure limit, each with its last reason. */
  readonly stopped: readonly { readonly run: RunKind; readonly runId: string; readonly failures: number; readonly reason: string }[];
  /** The feature's split (ContractSplitView in contract-sort.ts), or null when Penguin did not split it. */
  readonly split: { readonly state: "expand_first" | "retiring"; readonly entries: number; readonly promotion: string | null; readonly retiring: number } | null;
}

const ACTIVITY_LIMIT = 5;

/** Findings of passing checks a check job carries. */
export const CHECK_FINDINGS_SHOWN = 5;

const failing = (check: BlockCheck) => check.result === "failed" || check.result === "error";

/** A stage's status from its jobs. */
export function stageStatus(jobs: readonly PipelineJob[]): JobStatus {
  const has = (status: JobStatus) => jobs.some((job) => job.status === status);
  if (has("failed")) return "failed";
  if (has("person")) return "person";
  if (has("running")) return "running";
  if (jobs.length > 0 && jobs.every((job) => job.status === "passed")) return "passed";
  // Some passed and the rest wait: the stage has started.
  return has("passed") ? "running" : "waiting";
}

const last = <T>(items: readonly T[], test: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index] as T)) return items[index];
  return undefined;
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Who approved each part's current revision, from the signed `approve_plan_part` records. */
function approvers(facts: PipelineFacts): Map<string, string> {
  const by = new Map<string, string>();
  for (const record of facts.records) {
    if (record.type !== "approve_plan_part") continue;
    const part = text(record.payload["part_id"]);
    const approved = text(record.payload["approved_by"]) ?? record.author;
    const revision = record.payload["revision"];
    const current = facts.parts.find((each) => each.partId === part);
    if (part !== null && current !== undefined && revision === current.revision) by.set(part, approved);
  }
  return by;
}

/** The newest review of any of `scopes`. */
function newestReview(facts: PipelineFacts, scopes: readonly string[]) {
  return last(facts.reviews, (review) => scopes.includes(review.scope));
}

function startJobs(locks: PipelineFacts["locks"]): PipelineJob[] {
  return locks.map((lock) => ({
    key: `start:${lock.feature}`,
    status: lock.state === "approved" ? "passed" : "person",
    fact: { kind: "start", feature: lock.feature, person: lock.person, by: lock.state === "approved" ? (lock.approvedBy ?? lock.person) : null },
  }));
}

function planJobs(facts: PipelineFacts): PipelineJob[] {
  const jobs: PipelineJob[] = [];
  if (facts.factsRun !== undefined) {
    const status: JobStatus = facts.factsRun === "pending" ? "running" : facts.factsRun === "reported" ? "passed" : "waiting";
    jobs.push({ key: "facts", status, fact: { kind: "facts", state: facts.factsRun } });
  }
  const plan = last(facts.records, (record) => record.type === "propose_plan" || record.type === "plan_returned");
  if (plan !== undefined) {
    const returned = plan.type === "plan_returned";
    const places = plan.payload["in_person"] ?? plan.payload["behavioural"];
    const inPerson = returned && Array.isArray(places) ? places.length : 0;
    jobs.push({
      key: "plan",
      status: returned ? "failed" : "passed",
      fact: { kind: "plan", planId: text(plan.payload["plan_id"]), parts: returned ? 0 : facts.parts.length, returned, inPerson },
    });
  }
  return jobs;
}

/** A part's job in review: approved passes, a submitted review leaves the decision to a person. */
function partJob(facts: PipelineFacts, part: PipelineFacts["parts"][number], approvedBy: string | null): PipelineJob {
  const review = newestReview(facts, part.scopes);
  const reviewState: PartReviewState = review?.state ?? "none";
  const status: JobStatus =
    part.state === "approved"
      ? "passed"
      : part.state === "round_limit"
        ? "failed"
        : part.state === "change_requested" || reviewState === "pending"
          ? "running"
          : reviewState === "none"
            ? "waiting"
            : "person";
  return {
    key: `part:${part.partId}`,
    status,
    fact: { kind: "part", partId: part.partId, place: part.place, owner: part.owner, state: part.state, approvedBy, review: reviewState, reviewer: review?.reviewer ?? null },
  };
}

function writeJobs(facts: PipelineFacts): PipelineJob[] {
  const refused = new Set(facts.records.filter((record) => record.type === "fix_write_refused").map((record) => text(record.payload["part_id"])));
  return facts.parts.flatMap((part): PipelineJob[] => {
    if (part.place.kind !== "feature") return [];
    const write = facts.writes.get(part.partId);
    const state = write ?? (refused.has(part.partId) ? "refused" : "none");
    const status: JobStatus = state === "written" ? "passed" : state === "queued" || state === "granted" ? "running" : state === "refused" ? "failed" : "waiting";
    return [{ key: `write:${part.partId}`, status, fact: { kind: "write", partId: part.partId, feature: part.place.feature, owner: part.owner, state } }];
  });
}

/** One job per check kind of the newest block checks, then the block run `land` asked for. */
function checkJobs(facts: PipelineFacts): PipelineJob[] {
  const jobs: PipelineJob[] = [];
  if (facts.checks !== null && facts.checks.waiting) jobs.push({ key: "check-run", status: "running", fact: { kind: "check-run" } });
  const kinds = new Map<string, BlockCheck[]>();
  for (const check of facts.checks?.checks ?? []) kinds.set(check.check, [...(kinds.get(check.check) ?? []), check]);
  for (const [check, checks] of kinds) {
    const failed = checks.filter(failing).length;
    const findings = checks
      .filter((each) => !failing(each))
      .flatMap((each) => each.findings.map((finding) => ({ target: each.target, path: finding.path, message: finding.message })))
      .slice(0, CHECK_FINDINGS_SHOWN);
    jobs.push({
      key: `check:${check}`,
      status: failed > 0 ? "failed" : "passed",
      fact: { kind: "check", check, targets: checks.length, failed, failing: checks.filter(failing).map((each) => each.target), findings },
    });
  }
  const land = last(facts.records, (record) => record.type === "land_requested");
  if (land !== undefined) {
    const run = land.payload["run_id"];
    const checked = last(facts.records, (record) => record.type === "block_checked" && record.payload["run_id"] === run);
    const state = checked === undefined ? "running" : checked.payload["passed"] === true ? "passed" : "failed";
    jobs.push({ key: "block", status: state, fact: { kind: "block", state } });
  }
  return jobs;
}

function promotionJobs(facts: PipelineFacts): PipelineJob[] {
  const jobs: PipelineJob[] = facts.protectedChanges.map((change) => ({
    key: `protected:${change.owner}`,
    status: change.state === "confirmed" ? "passed" : "person",
    fact: { kind: "protected", owner: change.owner, state: change.state },
  }));
  const promoted = last(facts.records, (record) => record.type === "promotion");
  const land = last(facts.records, (record) => record.type === "land_requested");
  const stopped = last(facts.records, (record) => (record.type === "promotion_refused" || record.type === "land_returned") && record.payload["purpose"] !== "expand");
  if (promoted !== undefined || facts.state === "landed") {
    jobs.push({ key: "promotion", status: "passed", fact: { kind: "promotion", state: "promoted", mainAfter: text(promoted?.payload["main_after"]) } });
  } else if (land !== undefined && stopped !== undefined && facts.records.indexOf(stopped) > facts.records.indexOf(land)) {
    const state = stopped.type === "promotion_refused" ? "refused" : "returned";
    jobs.push({ key: "promotion", status: "failed", fact: { kind: "promotion", state, mainAfter: null } });
  } else if (facts.state === "landing") {
    jobs.push({ key: "promotion", status: "running", fact: { kind: "promotion", state: "running", mainAfter: null } });
  }
  return jobs;
}

/** Each expand promotion asked for, by its run: promoted, returned or still running. */
function expandJobs(facts: PipelineFacts): PipelineJob[] {
  const runs = expandRuns(facts);
  // A split whose agent has not asked for its expand promotion yet waits on the expand checkpoint.
  if (runs.length === 0 && facts.split !== null) {
    const promoted = facts.split.promotion !== null;
    return [{ key: "expand", status: promoted ? "passed" : "waiting", fact: { kind: "expand", checkpoint: null, state: promoted ? "promoted" : "waiting" } }];
  }
  return runs;
}

function expandRuns(facts: PipelineFacts): PipelineJob[] {
  return facts.records
    .filter((record) => record.type === "expand_requested")
    .map((request) => {
      const run = request.payload["run_id"];
      const promoted = facts.records.some((record) => record.type === "expand_promotion" && record.payload["run_id"] === run);
      const returned = facts.records.some((record) => record.type === "land_returned" && record.payload["purpose"] === "expand" && record.payload["run_id"] === run);
      const state = promoted ? "promoted" : returned ? "returned" : "running";
      return {
        key: `expand:${String(run)}`,
        status: promoted ? "passed" : returned ? "failed" : "running",
        fact: { kind: "expand", checkpoint: text(request.payload["checkpoint"]), state },
      } satisfies PipelineJob;
    });
}

/** The migration groups: the plan's parts by owner, each approved once every part of it is. */
function groupJobs(facts: PipelineFacts, partJobs: readonly PipelineJob[]): PipelineJob[] {
  const owners = new Map<string, PipelineJob[]>();
  for (const job of partJobs) {
    if (job.fact.kind !== "part") continue;
    owners.set(job.fact.owner, [...(owners.get(job.fact.owner) ?? []), job]);
  }
  return [...owners].map(([owner, jobs]) => {
    const first = jobs[0]?.fact;
    return {
      key: `group:${owner}`,
      status: stageStatus(jobs),
      fact: { kind: "group", owner, parts: jobs.length, approved: jobs.filter((job) => job.status === "passed").length, partId: first?.kind === "part" ? first.partId : null },
    };
  });
}

/** The contract step: the retiring symbols, removed once every migration group moved over. */
function contractJobs(facts: PipelineFacts, migrated: boolean): PipelineJob[] {
  const retire = last(facts.records, (record) => record.type === "retire_symbols");
  const from = retire ?? last(facts.records, (record) => record.type === "expand_promotion");
  if (from === undefined && (facts.split === null || facts.split.promotion === null)) return [];
  const declared = retire !== undefined && Array.isArray(retire.payload["symbols"]) ? retire.payload["symbols"].length : 0;
  const symbols = Math.max(declared, facts.split?.retiring ?? 0);
  const after = from === undefined ? [] : facts.records.slice(facts.records.indexOf(from) + 1);
  // Penguin approves the contract step once no caller is left (contract_proposed), withdraws it when a
  // caller comes back (contract_withdrawn) and records the removal once its block reaches main.
  const step = last(after, (record) => record.type === "contract_proposed" || record.type === "contract_withdrawn");
  const promoted = after.some((record) => record.type === "promotion" || record.type === "symbols_removed") || facts.state === "landed";
  const running = !promoted && (step?.type === "contract_proposed" || (migrated && after.some((record) => record.type === "land_requested")));
  const state = promoted ? "promoted" : running ? "running" : "waiting";
  return [{ key: "contract", status: promoted ? "passed" : running ? "running" : "waiting", fact: { kind: "contract", symbols, state } }];
}

const SPLIT_RECORDS = new Set(["contract_split", "expand_requested", "expand_promotion", "retire_symbols"]);

/** The stage whose jobs a stopped run of `run` belongs to on each path. */
function stoppedStage(run: RunKind, path: PipelinePath): PipelineStageKey {
  if (path === "split") return run === "plan-facts" ? "expand" : "migrate";
  if (run === "plan-facts") return "plan";
  if (run === "review" || run === "part-trial") return "review";
  if (run === "fix-write") return "fixes";
  return "checks";
}

/** Each stopped run as a failed job of the stage it served, which stops the stages after it. */
function withStopped(stages: readonly { readonly key: PipelineStageKey; readonly jobs: readonly PipelineJob[] }[], facts: PipelineFacts, path: PipelinePath) {
  return stages.map((stage) => ({
    key: stage.key,
    jobs: [
      ...stage.jobs,
      ...facts.stopped
        .filter((run) => stoppedStage(run.run, path) === stage.key)
        .map((run): PipelineJob => ({ key: `stopped:${run.run}:${run.runId}`, status: "failed", fact: { kind: "stopped", run: run.run, runId: run.runId, failures: run.failures, reason: run.reason } })),
    ],
  }));
}

/** Whether the feature is on the split path: it asked for an expand promotion or declared retiring symbols. */
export function isSplit(records: readonly Pick<PipelineRecord, "type">[]): boolean {
  return records.some((record) => SPLIT_RECORDS.has(record.type));
}

/**
 * Each stage's status in order. A stage with no job passes once the stage before it passed; every
 * stage after a failed one waits.
 */
function sequence(stages: readonly { readonly key: PipelineStageKey; readonly jobs: readonly PipelineJob[] }[]): PipelineStage[] {
  const out: PipelineStage[] = [];
  let before: JobStatus = "passed";
  let stopped = false;
  for (const stage of stages) {
    const own: JobStatus = stage.jobs.length === 0 ? (before === "passed" ? "passed" : "waiting") : stageStatus(stage.jobs);
    const status: JobStatus = stopped ? "waiting" : own;
    out.push({ key: stage.key, status, jobs: stage.jobs });
    if (own === "failed") stopped = true;
    before = status;
  }
  return out;
}

/** The branches of a part, a start, a group or a confirmation that reached another person. */
function branches(facts: PipelineFacts, stages: readonly PipelineStage[], path: PipelinePath): PipelineBranch[] {
  const out: PipelineBranch[] = [];
  const jobs = (key: PipelineStageKey) => stages.find((stage) => stage.key === key)?.jobs ?? [];
  for (const stage of ["open", "expand"] as const) {
    for (const job of jobs(stage)) {
      if (job.fact.kind !== "start" || job.fact.person === facts.person) continue;
      out.push({ key: job.key, stage, person: job.fact.person, agent: null, label: job.status === "passed" ? "approved" : "needs a person", partId: null, settled: job.status === "passed" });
    }
  }
  if (path === "split") {
    for (const job of jobs("migrate")) {
      if (job.fact.kind !== "group" || job.fact.owner === facts.person) continue;
      out.push({ key: job.key, stage: "migrate", person: job.fact.owner, agent: null, label: groupLabel(job.status), partId: job.fact.partId, settled: job.status === "passed" });
    }
  } else {
    const writes = new Map(jobs("fixes").map((job) => [job.fact.kind === "write" ? job.fact.partId : "", job]));
    for (const job of jobs("review")) {
      if (job.fact.kind !== "part" || job.fact.owner === facts.person) continue;
      const { partId, owner, reviewer } = job.fact;
      const write = writes.get(partId);
      // An approved part whose write waits for its fork's turn stays out as a waiting branch.
      if (job.status === "passed" && write?.fact.kind === "write" && write.fact.state === "waiting") {
        out.push({ key: job.key, stage: "fixes", person: owner, agent: reviewer, label: "waiting", partId, settled: false });
        continue;
      }
      if (job.status === "passed" && write !== undefined) {
        const written = write.status === "passed";
        out.push({ key: job.key, stage: "fixes", person: owner, agent: reviewer, label: written ? "fix written" : "approved", partId, settled: true });
        continue;
      }
      out.push({ key: job.key, stage: "review", person: owner, agent: reviewer, label: partLabel(job), partId, settled: job.status === "passed" });
    }
  }
  // Another plan's write into this fork waiting for its turn hangs at the current stage, under the
  // person whose plan it is. Its part belongs to that plan's page, so the branch links no diff here.
  const current = stages.find((stage) => stage.status !== "passed") ?? stages.at(-1);
  for (const write of facts.incoming ?? []) {
    if (current === undefined) break;
    out.push({ key: `incoming:${write.partId}`, stage: current.key, person: write.person, agent: null, label: "waiting", partId: null, settled: false });
  }
  // A stopped run needs the feature's own person, who has its run_failed inbox item.
  for (const stage of stages) {
    for (const job of stage.jobs) {
      if (job.fact.kind === "stopped") out.push({ key: job.key, stage: stage.key, person: facts.person, agent: null, label: "needs a person", partId: null, settled: false });
    }
  }
  const last = path === "split" ? "done" : "promoted";
  for (const job of jobs(last)) {
    if (job.fact.kind !== "protected" || job.fact.owner === facts.person) continue;
    out.push({ key: job.key, stage: last, person: job.fact.owner, agent: null, label: job.status === "passed" ? "approved" : "needs a person", partId: null, settled: job.status === "passed" });
  }
  return out;
}

function groupLabel(status: JobStatus): BranchLabel {
  if (status === "passed") return "approved";
  if (status === "person" || status === "failed") return "needs a person";
  return status === "running" ? "reviewing" : "sent";
}

function partLabel(job: PipelineJob): BranchLabel {
  if (job.status === "passed") return "approved";
  if (job.status === "person" || job.status === "failed") return "needs a person";
  return job.status === "running" ? "reviewing" : "sent";
}

/** The checkpoints the feature's agents reported, newest first, with the checks run on each. */
function activity(facts: PipelineFacts): PipelineActivity[] {
  return facts.records
    .filter((record) => record.type === "checkpoint_area" && record.author.startsWith("@"))
    .slice(-ACTIVITY_LIMIT)
    .reverse()
    .map((record) => {
      const checkpoint = text(record.payload["checkpoint"]) ?? "";
      const run = last(facts.checkRuns, (each) => each.checkpoint === checkpoint && each.checks.length > 0);
      return { agent: record.author, checkpoint, at: record.at, checks: run === undefined ? null : { total: run.checks.length, failed: run.checks.filter(failing).length } };
    });
}

/** The feature's pipeline: its path, each stage with its jobs, the current stage, its branches and its agents' checkpoints. */
export function featurePipeline(facts: PipelineFacts): FeaturePipeline {
  const path: PipelinePath = facts.split !== null || isSplit(facts.records) ? "split" : "plan";
  const approved = approvers(facts);
  const parts = facts.parts.map((part) => partJob(facts, part, approved.get(part.partId) ?? null));
  let stages: PipelineStage[];
  if (path === "split") {
    const groups = groupJobs(facts, parts);
    const migrated = groups.length > 0 && groups.every((job) => job.status === "passed");
    // Done once main moved to the feature's last checkpoint; a protected-path confirmation gates it.
    const landed = facts.state === "landed";
    const done: PipelineJob[] = promotionJobs(facts).filter((job) => job.fact.kind === "protected");
    done.push({ key: "promotion", status: landed ? "passed" : "waiting", fact: { kind: "promotion", state: landed ? "promoted" : "waiting", mainAfter: null } });
    stages = sequence(withStopped([
      { key: "open", jobs: startJobs(facts.locks) },
      { key: "expand", jobs: [...startJobs(facts.expandLocks), ...expandJobs(facts)] },
      { key: "migrate", jobs: groups },
      { key: "contract", jobs: contractJobs(facts, migrated) },
      { key: "done", jobs: done },
    ], facts, path));
  } else {
    const plan = planJobs(facts);
    stages = sequence(withStopped([
      { key: "open", jobs: startJobs(facts.locks) },
      // A feature with no plan yet has nothing past Plan: it waits there.
      { key: "plan", jobs: plan.length === 0 ? [{ key: "plan", status: "waiting", fact: { kind: "plan", planId: null, parts: 0, returned: false, inPerson: 0 } }] : plan },
      { key: "review", jobs: parts },
      { key: "fixes", jobs: writeJobs(facts) },
      { key: "checks", jobs: checkJobs(facts) },
      { key: "promoted", jobs: promotionJobs(facts) },
    ], facts, path));
    // Without a promotion job the last stage passes only once main moved.
    const final = stages.at(-1) as PipelineStage;
    if (final.jobs.length === 0) stages[stages.length - 1] = { ...final, status: "waiting" };
  }
  // Main moved to the feature's checkpoint, or Penguin closed a block left with nothing to carry:
  // every stage is settled, whatever its own jobs recorded.
  if (facts.state === "landed" || facts.state === "closed") stages = stages.map((stage) => ({ ...stage, status: "passed" }));
  const index = stages.findIndex((stage) => stage.status !== "passed");
  return { path, current: index === -1 ? stages.length - 1 : index, stages, branches: branches(facts, stages, path), activity: activity(facts) };
}

/** The strip alone, for the team view. */
export function pipelineStrip(pipeline: FeaturePipeline): PipelineStrip {
  return {
    path: pipeline.path,
    current: pipeline.current,
    stages: pipeline.stages.map((stage) => ({ key: stage.key, status: stage.status, passed: stage.jobs.filter((job) => job.status === "passed").length, jobs: stage.jobs.length })),
  };
}
