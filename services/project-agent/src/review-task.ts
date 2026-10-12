// A review task's headless run on Penguin's MCP server (#138, PRD 0.5 section 4.4a step 3).
//
// When a person's bridge claims a review task, Penguin issues a task token (mcp-tokens.ts) that the
// bridge puts in the CLI's MCP config. /mcp then serves that token only `submit_review`, `whats_near`
// and `impact` (REVIEW_TASK_TOOLS), and every call comes here first:
//
// - the task must be the token owner's, a review, `running` under the bridge's claim and inside its
//   lease, and its part must still wait at the task's revision. A task that was reported, dropped or
//   released, or a part that moved on, refuses every call: the token expires with the task;
// - `submit_review` must name the task's feature and scope, and `impact` the task's feature: the token
//   covers one part revision's review and nothing else;
// - the call then runs the same code an interactive session's call runs (submitReview, whatsNear,
//   requestTool), as the task's identity. The run has no session, so the calls go under the task's
//   own session id, `edit-task-<id>`: the stored form names it, which is how the bridge's report finds
//   the form the run submitted.

import { REVIEW_TASK_TOOLS } from "@penguin/protocol";

import { requestTool, whatsNear, type AgentToolDeps, type AgentToolRun, type ToolRequestOutcome, type WhatsNearOutcome } from "./agent-tools.ts";
import type { EditTask, EditTaskStore } from "./edit-tasks.ts";
import type { FeatureRejection } from "./feature-open.ts";
import type { PlanRouteStore } from "./plan-approval.ts";
import type { ReviewInput, ReviewOutcome } from "./review-submit.ts";
import type { Session, SessionOutcome } from "./session-store.ts";

/** The session id a review task's calls and its stored form go under; no registered session has it. */
export function taskSessionId(taskId: number): string {
  return `edit-task-${taskId}`;
}

/** One call a review run makes with its task token, by tool. */
export type ReviewTaskCall =
  | { readonly tool: "submit_review"; readonly input: ReviewInput }
  | { readonly tool: "whats_near"; readonly input: { readonly paths?: unknown; readonly scopes?: unknown } }
  | { readonly tool: "impact"; readonly input: { readonly feature?: unknown } };

/** What a call answers: the interactive tool's own outcome, or for `impact` the runner's newest report. */
export type ReviewTaskCallOutcome =
  | { readonly status: "called"; readonly tool: "submit_review"; readonly outcome: ReviewOutcome }
  | { readonly status: "called"; readonly tool: "whats_near"; readonly outcome: WhatsNearOutcome }
  | { readonly status: "called"; readonly tool: "impact"; readonly outcome: ToolRequestOutcome }
  | { readonly status: "called"; readonly tool: "impact"; readonly reported: AgentToolRun }
  | FeatureRejection;

/** What a task token may do now: the task, the identity it acts as and the one form it covers. */
export interface ReviewTaskGrant {
  readonly task: EditTask;
  /** The task's identity as the tools read a session: never registered, never routed any work. */
  readonly session: Session;
  readonly feature: string;
  readonly scope: string;
  readonly part: string;
  readonly revision: number;
}

export interface ReviewTaskDeps {
  readonly tasks: EditTaskStore;
  readonly routes: PlanRouteStore;
  /** The id of the identity with this handle, or undefined. */
  readonly identityId: (handle: string) => string | undefined;
  readonly now?: () => number;
}

export type ReviewTaskGrantOutcome = { readonly status: "ok"; readonly grant: ReviewTaskGrant } | FeatureRejection;

const forbidden = (message: string): FeatureRejection => ({ status: "rejected", reason: "forbidden", message });

/** Checks that task `taskId` of `owner` is a review its token may still act for. */
export function reviewTaskGrant(deps: ReviewTaskDeps, owner: string, taskId: number): ReviewTaskGrantOutcome {
  const task = deps.tasks.get(taskId);
  if (task === undefined || task.person !== owner) return { status: "rejected", reason: "not_found", message: `no edit task ${taskId} for ${owner}` };
  if (task.kind !== "review" || task.handle === null) return forbidden(`edit task ${taskId} is not a review form`);
  const now = (deps.now ?? Date.now)();
  if (task.state !== "running" || task.leaseUntil === null || task.leaseUntil <= now) {
    return forbidden(`edit task ${taskId} is ${task.state === "running" ? "past its claim" : task.state}; its token no longer holds`);
  }
  const { part, revision, scope } = task.ref;
  if (typeof part !== "string" || typeof revision !== "number" || typeof scope !== "string") return forbidden(`edit task ${taskId} names no part revision`);
  const route = deps.routes.get(part);
  if (route === undefined || route.revision !== revision || route.state !== "pending") {
    return forbidden(`part ${part} no longer waits for a review at revision ${revision}; the task's token no longer holds`);
  }
  const session: Session = {
    id: taskSessionId(task.id),
    identityId: deps.identityId(task.handle) ?? "",
    handle: task.handle,
    vendor: "penguin-edit-task",
    worktreeId: taskSessionId(task.id),
    branch: "main",
    status: "running",
    currentIssueId: null,
    lastSeen: new Date(now).toISOString(),
  };
  return { status: "ok", grant: { task, session, feature: task.target, scope, part, revision } };
}

/**
 * Refuses a call outside the grant: any tool but the review tools, a form for another feature or
 * scope, an impact on another feature. Null when the call stays inside it.
 */
export function reviewTaskCallProblem(grant: ReviewTaskGrant, tool: string, input: object): FeatureRejection | null {
  const { feature, scope } = input as { readonly feature?: unknown; readonly scope?: unknown };
  if (!(REVIEW_TASK_TOOLS as readonly string[]).includes(tool)) {
    return forbidden(`a review task's token allows submit_review, whats_near and impact, not ${tool}`);
  }
  if ((tool === "submit_review" || tool === "impact") && feature !== grant.feature) {
    return forbidden(`this token covers the review of feature ${grant.feature} alone`);
  }
  if (tool === "submit_review" && scope !== grant.scope) {
    return forbidden(`this token covers the form for scope ${grant.scope} on part ${grant.part} revision ${grant.revision} alone`);
  }
  return null;
}

/** A heartbeat that answers for the grant's task session alone, in place of the session store's. */
export function taskHeartbeat(grant: ReviewTaskGrant, owner: string): (caller: string, sessionId: string) => SessionOutcome {
  return (caller, sessionId) =>
    caller === owner && sessionId === grant.session.id
      ? { status: "ok", session: grant.session }
      : { status: "rejected", reason: "forbidden", message: "the task token acts for its own task alone" };
}

/** What a review task's call runs on: the grant's stores and the same tools a session's call runs. */
export interface ReviewTaskCallDeps extends ReviewTaskDeps {
  /** `submit_review` as the ProjectAgent runs it for a session, with the heartbeat given. */
  readonly submit: (owner: string, sessionId: string, input: ReviewInput, heartbeat: (caller: string, sessionId: string) => SessionOutcome) => Promise<ReviewOutcome>;
  readonly agentTools: AgentToolDeps;
}

/**
 * One call on the MCP server of `owner`'s review task `taskId`: checked against the grant, then run as
 * the interactive tool runs, as the task's identity under its own session id. `impact` answers the
 * check runner's newest report on the feature's latest checkpoint when there is one, so the run can
 * read it within its time, and otherwise records a request as a session's call does.
 */
export async function reviewTaskCall(deps: ReviewTaskCallDeps, owner: string, taskId: number, call: ReviewTaskCall): Promise<ReviewTaskCallOutcome> {
  const granted = reviewTaskGrant(deps, owner, taskId);
  if (granted.status === "rejected") return granted;
  const { grant } = granted;
  const problem = reviewTaskCallProblem(grant, call.tool, call.input);
  if (problem !== null) return problem;
  const heartbeat = taskHeartbeat(grant, owner);
  const session = grant.session.id;
  const tools: AgentToolDeps = { ...deps.agentTools, heartbeat, workingOn: (id) => (id === session ? grant.feature : undefined) };
  switch (call.tool) {
    case "submit_review":
      return { status: "called", tool: "submit_review", outcome: await deps.submit(owner, session, call.input, heartbeat) };
    case "whats_near":
      return { status: "called", tool: "whats_near", outcome: await whatsNear(tools, owner, session, call.input) };
    case "impact": {
      const reported = reportedImpact(tools, grant.feature);
      if (reported !== undefined) return { status: "called", tool: "impact", reported };
      return { status: "called", tool: "impact", outcome: await requestTool(tools, owner, session, "impact", { feature: call.input.feature }) };
    }
  }
}

/** The check runner's newest impact report on `featureId` at its latest checkpoint. */
function reportedImpact(deps: Pick<AgentToolDeps, "features" | "runs">, featureId: string): AgentToolRun | undefined {
  const checkpoint = deps.features.get(featureId)?.latestCheckpointSha;
  if (checkpoint == null) return undefined;
  return deps.runs
    .list(featureId)
    .filter((run) => run.tool === "impact" && run.checkpointSha === checkpoint && run.outcome !== null && run.result !== "error")
    .at(-1);
}
