// Where edit tasks come from and how they leave (PRD 0.5 section 4.4a), on top of the task store
// (edit-tasks.ts) and the roster of stewards and builders (edit-roster.ts).
//
// Sources:
// - `review`: each revision of a plan part waiting on its owner asks for one review form per scope
//   of the part. It is routed to the steward of the scope's DRI, or down the scope's fallback order
//   while the DRI has no bridge online and no session (#135). A review form submitted for that
//   scope on the plan's feature since the revision started waiting does it, unless Penguin refused
//   the form at submission; the part leaving `pending` without one drops it.
// - `fix`: each approved behavioural part whose place is a running feature asks for its patch to be
//   written into that feature's fork. The whole part goes to the target feature's builder, else the
//   steward of the target's person: an approved patch is written whole, as one commit, so it never
//   splits. The write being kept does it. A mechanical part is the check runner's and asks for no task.
// - `next_step`: each failed block check that the resolution ladder gives an agent (steps 4 and 5)
//   asks for an edit to the failing files, in the failing feature's fork, or in the originating fork
//   for a failure on main. Its files route by charter and may split. A newer block run of the same
//   feature replaces the open next steps; a passing one does them.
// - `migration`: a part of a split's migration plan that the declared rewrite rules do not write
//   (migration-plans.ts), through `openEditTask`. A running feature's own changes go to its builder;
//   code on main goes to the steward of the scope's DRI, in the feature Penguin opened for the plan.
// - `contract`: the removal of retiring symbols whose originating feature no longer runs, for the
//   steward of the DRI of the defining scope, in a feature Penguin opened from main (migration-plans.ts).
//
// Penguin syncs the plan sources and settles every task before each read that shows them, so every
// view sees the current state; a source is routed once, when it opens.
//
// A bridge's claim gets each task's spec: the fork, files, allowed paths, instructions and the checks
// that verify it, plus, for a fix, the approved write. A review also gets its part revision and scope,
// the revision's trial tree for the bridge to check out (the target, the checkpoint and the fix, as
// the part's trial builds it, #140), and a task token for Penguin's MCP server that allows that form
// alone (review-task.ts, #138). The claim leaves an edit whose target fork waits on an overlap lock in
// the queue. A task's report of a done run names one commit, which Penguin reads from the fork before keeping it: one
// parent, on the fork's branch, changing only the task's allowed paths. A fix's commit goes through
// the fix-write checks instead. A review's done report names no commit: Penguin keeps it only when
// the run submitted a form Penguin did not refuse. Every report revokes the task's token.

import {
  FIX_WRITE_BRANCH,
  MAIN_TARGET,
  OPEN_EDIT_TASK_STATES,
  type EditPlace,
  type EditQueue,
  type EditRoutingContext,
  type EditTaskReport,
  type EditTaskSpec,
  type EditTaskView,
  type LadderDecision,
  type Plan,
} from "@penguin/protocol";
import { answerers, routeScope, scopeForPath, type ScopeMap } from "@penguin/scope-map";

import type { EditRoster } from "./edit-roster.ts";
import type { EditReportOutcome, EditSource, EditTask, EditTaskStore, SessionFor } from "./edit-tasks.ts";
import type { FeatureStore } from "./feature-store.ts";
import { taskFixGrant, taskFixReport, taskWriteKey, withdrawMovedOn, type FixGrant, type FixGrantStore, type FixWriteDeps } from "./fix-write.ts";
import type { IssuedTaskToken } from "./mcp-tokens.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import type { PartRoute, PlanRouteStore } from "./plan-approval.ts";
import { trialSpec } from "./part-trial.ts";
import { changedFiles } from "./repo-diff.ts";
import { taskSessionId } from "./review-task.ts";
import type { Session } from "./session-store.ts";

export interface EditWorkDeps {
  readonly tasks: EditTaskStore;
  readonly roster: EditRoster;
  readonly features: FeatureStore;
  readonly routes: PlanRouteStore;
  readonly grants: FixGrantStore;
  /** The review forms submitted on a feature (ReviewStore.list). */
  readonly reviews: (featureId: string) => readonly {
    readonly scopeId: string;
    readonly createdAt: string;
    readonly state?: string;
    readonly sessionId?: string | null;
  }[];
  /** Issues and revokes the task tokens of review runs (McpTokenStore); absent, no review is claimed. */
  readonly taskTokens?: {
    issueTask(ownerId: string, taskId: number, expiresAt: number): Promise<IssuedTaskToken>;
    revokeTask(taskId: number): number;
  };
  readonly scopeMap: () => Promise<ScopeMap>;
  /** Every running session. */
  readonly running: () => readonly Session[];
  /** A feature's newest plan, which holds a review's part revision and so its trial tree; absent, a review carries none. */
  readonly plan?: (featureId: string) => Plan | undefined | Promise<Plan | undefined>;
  /** The fix-write checks, for a fix task's write. */
  readonly fix: FixWriteDeps;
  /** Background runs one person holds at once (PENGUIN_BACKGROUND_RUN_CAP). */
  readonly cap: number;
  /** How long a claim holds (PENGUIN_EDIT_RUN_MINUTES). */
  readonly leaseMs: number;
  /** Tells a person's open dashboards that their tasks changed. */
  readonly notify: (person: string) => void;
}

const personOfHandle = (handle: string): string => handle.slice(1, handle.indexOf("/"));

/**
 * Whether a person can take work now (#135): their bridge polled within the online window or one of
 * their sessions runs. Built once per routing pass; each answer is one lookup.
 */
export function availability(deps: { readonly tasks: Pick<EditTaskStore, "bridgeOnline">; readonly running: () => readonly Session[] }): (person: string) => boolean {
  const live = new Set(deps.running().map((session) => personOfHandle(session.handle)));
  return (person) => live.has(person) || deps.tasks.bridgeOnline(person);
}

/**
 * Routing by the roster's charters and the scope map. A scope's work goes to its DRI's steward, or
 * down its fallback order while the DRI is away (`routeScope`); a fallback's steward stands in for the
 * DRI's.
 */
export function editRouting(
  deps: Pick<EditWorkDeps, "roster" | "features">,
  scopeMap: ScopeMap,
  available: (person: string) => boolean,
): EditRoutingContext {
  return {
    scopeOf: (path) => scopeForPath(scopeMap, path),
    ownerOf: (scope) => routeScope(scopeMap, scope, available),
    driOf: (scope) => scopeMap.scopes.get(scope)?.driId,
    builderOf: (featureId) => {
      const feature = deps.features.get(featureId);
      return feature === undefined ? undefined : deps.roster.builderOf(feature.personId, featureId);
    },
    stewardOf: (person) => deps.roster.stewardOf(person),
  };
}

/**
 * Whether a running session counts for a task: a session of the task's identity, or for a builder's
 * task a session of the same person working on the target feature.
 */
export function sessionFor(deps: Pick<EditWorkDeps, "running" | "features">): SessionFor {
  const running = deps.running();
  const handles = new Set(running.map((session) => session.handle));
  const onFeature = new Map<string, Set<string>>();
  for (const session of running) {
    const feature = deps.features.featureOfSession(session.id);
    if (feature === undefined) continue;
    const people = onFeature.get(feature) ?? new Set<string>();
    people.add(personOfHandle(session.handle));
    onFeature.set(feature, people);
  }
  return (task) =>
    (task.handle !== null && handles.has(task.handle)) || (task.via === "builder" && onFeature.get(task.target)?.has(task.person) === true);
}

/** Whether one session counts for a task, by the same rule. */
function counts(deps: Pick<EditWorkDeps, "features">, session: Session): SessionFor {
  const feature = deps.features.featureOfSession(session.id);
  return (task) => task.handle === session.handle || (task.via === "builder" && feature === task.target && personOfHandle(session.handle) === task.person);
}

/**
 * Brings the roster, the plan sources and every task's state up to date. Runs before each read that
 * shows tasks. Returns the routing it used.
 */
export async function syncEditWork(deps: EditWorkDeps): Promise<EditRoutingContext> {
  const scopeMap = await deps.scopeMap();
  deps.roster.sync(scopeMap, deps.features.list());
  const routing = editRouting(deps, scopeMap, availability(deps));
  const routes = deps.routes.waitingOn(owners(deps, scopeMap), ["pending", "approved"]);
  syncReviews(deps, routes.filter((route) => route.state === "pending"), routing);
  syncFixes(deps, routes.filter((route) => route.state === "approved"), routing);
  const running = new Set(deps.running().map((session) => session.id));
  deps.tasks.settle(sessionFor(deps), (sessionId) => running.has(sessionId));
  return routing;
}

/** Every person a plan part may wait on: each scope's DRI and fallback order, and the feature people. */
function owners(deps: Pick<EditWorkDeps, "features">, scopeMap: ScopeMap): string[] {
  return [...new Set([...answerers(scopeMap), ...deps.features.list().map((feature) => feature.personId)])];
}

const reviewKey = (route: PartRoute, scope: string) => `review:${route.partId}@${route.revision}:${scope}`;

function syncReviews(deps: EditWorkDeps, pending: readonly PartRoute[], routing: EditRoutingContext): void {
  const sources: EditSource[] = [];
  for (const route of pending) {
    const feature = deps.features.get(route.featureId);
    if (feature === undefined) continue;
    const since = Date.parse(route.updatedAt);
    // A form Penguin refused at submission is no review: the task stays open for a corrected one.
    const reviewed = new Set(
      deps
        .reviews(route.featureId)
        .filter((review) => review.state !== "refused" && Date.parse(review.createdAt) >= since)
        .map((review) => review.scopeId),
    );
    for (const scope of route.scopes) {
      const key = reviewKey(route, scope);
      if (reviewed.has(scope)) {
        deps.tasks.close(key, "done", `review form for ${scope} submitted`);
        continue;
      }
      sources.push({
        key,
        kind: "review",
        feature: route.featureId,
        target: route.featureId,
        targetPerson: feature.personId,
        places: [{ scope }],
        instructions: `Review part ${route.partId} revision ${route.revision} of feature ${route.featureId}'s merge plan for scope ${scope}: fill in the review form for the scope's invariants and send it with submit_review.`,
        verifier: "The check runner runs the review harness on the form. The part's trial run tests it on the merged tree.",
        ref: { part: route.partId, revision: route.revision, scope },
      });
    }
  }
  deps.tasks.replace("review:", sources, routing, "dropped", "the part was decided or revised");
}

function syncFixes(deps: EditWorkDeps, approved: readonly PartRoute[], routing: EditRoutingContext): void {
  const sources: EditSource[] = [];
  for (const route of approved) {
    if (route.place.kind !== "feature") continue;
    const target = deps.features.get(route.place.feature);
    if (target === undefined || !RUNNING_STATES.has(target.state)) continue;
    const key = `fix:${route.partId}@${route.revision}`;
    const grant = deps.grants.get(route.partId, route.revision);
    if (grant?.writer === "runner") continue;
    if (grant?.state === "written") {
      deps.tasks.close(key, "done", `fix written as ${grant.commitSha?.slice(0, 12)}`, grant.commitSha);
      continue;
    }
    sources.push({
      key,
      kind: "fix",
      feature: route.featureId,
      target: target.id,
      targetPerson: target.personId,
      // The whole approved patch goes to one identity: the part's scopes are routed as one place.
      places: [{ scope: route.scopes[0] ?? null }],
      instructions: `Write approved part ${route.partId} revision ${route.revision} of feature ${route.featureId}'s merge plan into feature ${target.id}'s fork, exactly as approved: penguin-bridge fix-write makes the commit from the fix_token answer.`,
      verifier: "Penguin keeps the commit only when it is the approved patch applied to the fork head; the block check then runs on the merged trees.",
      ref: { part: route.partId, revision: route.revision },
    });
  }
  // A fix routes whole: its one place goes to the target's builder whatever scope it names.
  const whole: EditRoutingContext = {
    ...routing,
    builderOf: (featureId) => {
      const builder = routing.builderOf(featureId);
      return builder === undefined ? undefined : { ...builder, paths: [""] };
    },
  };
  deps.tasks.replace("fix:", sources, whole, "dropped", "the part moved on before its fix was written");
}

/**
 * A block run of `featureId` reported: a failing run's ladder decisions for an agent (steps 4 and 5)
 * replace the feature's open next steps; a passing run does them.
 */
export async function blockReported(
  deps: EditWorkDeps,
  featureId: string,
  run: { readonly runId: string; readonly checkpoint: string; readonly passed: boolean },
  decisions: readonly LadderDecision[],
): Promise<void> {
  const prefix = `next:${featureId}:`;
  if (run.passed) {
    for (const key of deps.tasks.openSources(prefix)) deps.tasks.close(key, "done", `block run ${run.runId} passed`);
    return;
  }
  const scopeMap = await deps.scopeMap();
  deps.roster.sync(scopeMap, deps.features.list());
  const sources = nextStepSources(deps, featureId, run, decisions);
  deps.tasks.replace(prefix, sources, editRouting(deps, scopeMap, availability(deps)), "dropped", `block run ${run.runId} no longer shows the failure`);
  for (const person of new Set(deps.tasks.forFeature(featureId).map((task) => task.person))) deps.notify(person);
}

/** The sources a failed block run's agent steps ask for, one per failing target and check. */
export function nextStepSources(
  deps: Pick<EditWorkDeps, "features">,
  featureId: string,
  run: { readonly runId: string; readonly checkpoint: string },
  decisions: readonly LadderDecision[],
): EditSource[] {
  const sources = new Map<string, EditSource>();
  for (const decision of decisions) {
    if (decision.step !== 4 && decision.step !== 5) continue;
    const targetId = decision.target === MAIN_TARGET ? featureId : decision.target;
    const target = deps.features.get(targetId);
    if (target === undefined || !RUNNING_STATES.has(target.state)) continue;
    const key = `next:${featureId}:${decision.target}:${decision.check}`;
    const paths = [...new Set(decision.evidence.findings.map((finding) => finding.path).filter((path): path is string => path !== null))];
    const places: EditPlace[] = paths.length > 0 ? paths.map((path) => ({ path })) : target.area.scopes.map((scope) => ({ scope }));
    const where =
      decision.target === MAIN_TARGET
        ? `feature ${featureId}'s checkpoint ${run.checkpoint.slice(0, 12)} merged onto main`
        : `feature ${featureId}'s checkpoint ${run.checkpoint.slice(0, 12)} merged onto feature ${targetId}'s fork`;
    sources.set(key, {
      key,
      kind: "next_step",
      feature: featureId,
      target: targetId,
      targetPerson: target.personId,
      places,
      instructions: `The ${decision.check} check failed on ${where}. ${decision.nextStep}. ${decision.reason}.`,
      verifier: `Penguin's block checks run again on the merged trees; the ${decision.check} check on ${decision.target} must pass.`,
      evidence: [decision.evidence.summary, ...decision.evidence.findings.map(findingLine)],
      ref: { run: run.runId, target: decision.target, check: decision.check, step: decision.step },
    });
  }
  return [...sources.values()];
}

/** One finding of a failed check as a line: `path:line code message`. */
function findingLine(finding: LadderDecision["evidence"]["findings"][number]): string {
  const place = finding.path === null ? "" : `${finding.path}${finding.line === null ? "" : `:${finding.line}`} `;
  return `${place}${finding.code === null ? "" : `${finding.code} `}${finding.message}`;
}

/**
 * Opens one source's tasks from outside this module, such as a migration part (migration-plans.ts).
 * `adjust` may narrow the routing, such as leaving out the builder of a feature Penguin opened, so
 * an edit to a scope on main reaches the steward of the scope's DRI.
 */
export async function openEditTask(deps: EditWorkDeps, source: EditSource, adjust?: (routing: EditRoutingContext) => EditRoutingContext): Promise<EditTask[]> {
  const scopeMap = await deps.scopeMap();
  deps.roster.sync(scopeMap, deps.features.list());
  const routing = editRouting(deps, scopeMap, availability(deps));
  const opened = deps.tasks.open(source, adjust === undefined ? routing : adjust(routing));
  for (const person of new Set(opened.map((task) => task.person))) deps.notify(person);
  return opened;
}

/**
 * A feature landed: its own next steps are done, and the open tasks that edit its fork, now
 * read-only, are dropped.
 */
export function featureLandedTasks(tasks: EditTaskStore, featureId: string): void {
  for (const task of tasks.forFeature(featureId)) {
    if (!OPEN_EDIT_TASK_STATES.includes(task.state)) continue;
    if (task.sourceKey.startsWith(`next:${featureId}:`)) tasks.close(task.sourceKey, "done", `feature ${featureId} landed`);
    else if (task.target === featureId && task.kind !== "review") tasks.close(task.sourceKey, "dropped", `feature ${featureId} landed; its fork is read-only`);
  }
}

/** A session's safe checkpoint: the waiting tasks it counts for are delivered to it. */
export function deliverEditTasks(deps: Pick<EditWorkDeps, "tasks" | "features">, session: Session): EditTask[] {
  return deps.tasks.deliver(session.id, counts(deps, session));
}

/** Whether session `sessionId` holds the delivered fix task of this part revision. */
export function holdsFixTask(tasks: EditTaskStore, sessionId: string, partId: string, revision: number): boolean {
  return tasks.forSession(sessionId).some((task) => task.kind === "fix" && task.ref["part"] === partId && task.ref["revision"] === revision);
}

export type EditClaim = {
  readonly status: "ok";
  readonly tasks: readonly EditTaskSpec[];
  /** The task token of each claimed review, by task id; the plaintext goes to this claim alone. */
  readonly mcp: Readonly<Record<number, IssuedTaskToken>>;
  readonly queue: EditQueue;
};

/**
 * The bridge of `person` claims the person's waiting tasks, up to the cap. A fix whose write can no
 * longer be granted is dropped with Penguin's reason instead of being handed out.
 */
export async function claimEditTasks(deps: EditWorkDeps, person: string, bridgeId: string): Promise<EditClaim> {
  await syncEditWork(deps);
  const scopeMap = await deps.scopeMap();
  // Without task tokens a review cannot run headless, so the claim leaves reviews to sessions.
  const headless = deps.taskTokens === undefined ? (task: Pick<EditTask, "kind">) => task.kind !== "review" : () => true;
  // The fork order is read from the table below, so writes whose part or task moved on leave it first.
  settleTaskWrites(deps);
  const open = deps.grants.allOpen();
  if (open.length > 0) await withdrawMovedOn(deps.fix, open);
  // A fork whose start waits on an overlap lock gets no write token yet, so its edits wait in the queue.
  // A fix or migration edit whose write waits for its fork's turn (fix-write.ts) stays queued and takes
  // no run; a migration edit asking for the first time takes its place in the order here.
  const claimable = (task: EditTask) =>
    headless(task) && (task.kind === "review" || deps.fix.locked?.(task.target) !== true) && writeWaitsFor(deps.grants, task, true) === null;
  const claimed = deps.tasks.claim(person, bridgeId, deps.cap, deps.leaseMs, sessionFor(deps), claimable);
  const specs: EditTaskSpec[] = [];
  const mcp: Record<number, IssuedTaskToken> = {};
  for (const task of claimed) {
    let fixWrite: EditTaskSpec["fixWrite"] = null;
    if (task.kind === "fix") {
      // The token lasts the run's lease, so the write holds the fork as long.
      const granted = await taskFixGrant(deps.fix, fixPart(task), task.handle as string, deps.leaseMs);
      if (granted.status === "rejected" && granted.reason === "waiting") {
        // Another write took the fork in this same claim: the task waits for its turn.
        deps.tasks.unclaim(task.id);
        continue;
      }
      if (granted.status !== "ok") {
        deps.tasks.close(task.sourceKey, "dropped", granted.message);
        continue;
      }
      fixWrite = granted.spec;
    }
    if (task.kind === "migration") {
      // The run commits into the fork: it holds the fork's turn for its claim, unless another task of
      // this same claim took the fork first.
      const write = taskWrite(deps.grants, task, false) as FixGrant;
      if (deps.grants.waitsFor(write) !== null) {
        deps.tasks.unclaim(task.id);
        continue;
      }
      deps.grants.hold(write.id, bridgeId, task.leaseUntil as number);
    }
    let review: EditTaskSpec["review"] = null;
    if (task.kind === "review") {
      if (deps.taskTokens !== undefined) mcp[task.id] = await deps.taskTokens.issueTask(person, task.id, task.leaseUntil as number);
      review = reviewTarget(task, await deps.plan?.(task.target));
    }
    specs.push(taskSpec(task, scopeMap, fixWrite, review));
  }
  if (claimed.length > 0) deps.notify(person);
  return { status: "ok", tasks: specs, mcp, queue: deps.tasks.queue(person, deps.cap) };
}

const fixPart = (task: EditTask) => ({ feature: task.feature, part: task.ref["part"], revision: task.ref["revision"] });

/**
 * The write in its fork's order that an edit task makes: a fix task's approved part, or a migration
 * task's own run (`task:<id>`), which `open` places in the order when it is not there yet. Undefined
 * for a task that writes no fork through the order.
 */
function taskWrite(grants: FixGrantStore, task: EditTask, open: boolean): FixGrant | undefined {
  if (task.kind === "fix") {
    const { part, revision } = task.ref;
    return typeof part === "string" && typeof revision === "number" ? grants.get(part, revision) : undefined;
  }
  if (task.kind !== "migration") return undefined;
  const key = { partId: taskWriteKey(task.id), revision: 1 };
  return open ? grants.open(task.feature, String(task.ref["plan"] ?? task.feature), key, task.target, "task") : grants.get(key.partId, key.revision);
}

/** Why an edit task's write waits for its fork's turn, as the grant table stands, or null. */
export function writeWaitsFor(grants: FixGrantStore, task: EditTask, open = false): string | null {
  const grant = taskWrite(grants, task, open);
  if (grant === undefined || (grant.state !== "queued" && grant.state !== "granted")) return null;
  return grants.waitsFor(grant);
}

/** Ask reasons under which a task still waits for a run, so its write keeps its place in the order. */
const STILL_WAITING: ReadonlySet<string> = new Set(["bridge_offline", "needs_session"]);

/**
 * Keeps each migration task's write in step with its task: a task that is done elsewhere, dropped,
 * taken by a session or asked after a failed run gives up its place; one back in the queue keeps its
 * place without a token.
 */
function settleTaskWrites(deps: EditWorkDeps): void {
  for (const grant of deps.grants.allOpen()) {
    if (grant.writer !== "task") continue;
    const task = deps.tasks.get(Number(grant.partId.slice("task:".length)));
    if (task?.state === "running") continue;
    if (task === undefined || task.state === "done" || task.state === "dropped" || task.state === "delivered" || (task.state === "asked" && !STILL_WAITING.has(task.askReason ?? ""))) {
      deps.grants.withdraw(grant.id);
    } else {
      deps.grants.requeue(grant.id);
    }
  }
}

/** The paths a task's change may touch: its files and the paths of its scopes. */
export function allowedPaths(task: Pick<EditTask, "files" | "scopes">, scopeMap: ScopeMap): string[] {
  return [...new Set([...task.files, ...task.scopes.flatMap((scope) => [...(scopeMap.scopes.get(scope)?.paths ?? [])])])].sort();
}

function taskSpec(task: EditTask, scopeMap: ScopeMap, fixWrite: EditTaskSpec["fixWrite"], review: EditTaskSpec["review"]): EditTaskSpec {
  return {
    taskId: task.id,
    kind: task.kind,
    handle: task.handle as string,
    person: task.person,
    feature: task.feature,
    fork: `feature-${task.target}`,
    branch: FIX_WRITE_BRANCH,
    paths: task.files,
    scopes: task.scopes,
    allowed: allowedPaths(task, scopeMap),
    instructions: task.instructions,
    verifier: task.verifier,
    evidence: task.evidence,
    leaseUntil: new Date(task.leaseUntil as number).toISOString(),
    fixWrite,
    review,
  };
}

/**
 * The part revision and scope a review task's form covers, with the revision's trial tree as the
 * part's trial builds it (part-trial.ts), so the run reads the fix it reviews (#140). The trial is null
 * when the newest plan no longer holds that revision or its fix has no base.
 */
export function reviewTarget(task: Pick<EditTask, "target" | "ref" | "scopes">, plan: Plan | undefined): EditTaskSpec["review"] {
  const { part, revision, scope } = task.ref;
  const planned = plan?.parts.find((each) => each.partId === part && each.revision === revision);
  const spec = plan === undefined || planned === undefined ? undefined : trialSpec(plan, planned, []);
  return {
    feature: task.target,
    scope: typeof scope === "string" ? scope : (task.scopes[0] ?? ""),
    part: String(part),
    revision: Number(revision),
    trial: spec === undefined ? null : { checkpoint: spec.checkpoint, target: spec.target, fix: spec.fix },
  };
}

/**
 * The claiming bridge reports a run. A done run's commit is checked first: a fix's through the
 * fix-write checks, any other's against the fork (one parent, on the branch, only allowed paths).
 * A commit that fails the check releases the task to its person with Penguin's reason.
 */
export async function reportEditTask(deps: EditWorkDeps, person: string, bridgeId: string, taskId: number, body: unknown): Promise<EditReportOutcome> {
  const report = (typeof body === "object" && body !== null ? body : {}) as EditTaskReport;
  const task = deps.tasks.get(taskId);
  if (task === undefined || task.person !== person) return { status: "rejected", reason: "not_found", message: `no edit task ${taskId} for ${person}` };
  if (task.kind === "review") return reportReviewTask(deps, person, bridgeId, task, report);
  if (report.status === "done" && task.claimedBy === bridgeId && task.state === "running") {
    const problem = await commitProblem(deps, task, report.commit);
    if (problem !== null) {
      const released = deps.tasks.report(bridgeId, taskId, { status: "failed", outcome: `Penguin did not keep the commit: ${problem}` });
      deps.notify(person);
      return released.status === "ok" ? { status: "rejected", reason: "invalid", message: problem } : released;
    }
  }
  const outcome = deps.tasks.report(bridgeId, taskId, report);
  if (outcome.status === "ok") {
    if (outcome.task.state === "done") deps.tasks.close(outcome.task.sourceKey, "done", outcome.task.outcome ?? "done", outcome.task.commit);
    await taskWriteReported(deps, outcome.task);
    deps.notify(person);
  }
  return outcome;
}

/**
 * A migration task's run reported: a kept commit is its write into the fork, so every other write
 * waiting there is tried again on the new head (fix-retrial.ts); any other end gives up its place.
 */
async function taskWriteReported(deps: EditWorkDeps, task: EditTask): Promise<void> {
  const write = taskWrite(deps.grants, task, false);
  if (write === undefined || (write.state !== "queued" && write.state !== "granted")) return;
  if (task.state !== "done" || task.commit === null) {
    deps.grants.withdraw(write.id);
    return;
  }
  deps.grants.written(write.id, task.commit, `edit-task:${task.id}`);
  await deps.fix.written?.(write, task.commit);
}

/**
 * A review run's report. The run's result is the form it submitted under the task's session id, so a
 * done report counts only when Penguin kept such a form and did not refuse it. A form that arrived
 * may already have closed the task as done at the last sync: the report then confirms it. The task's
 * token is revoked either way.
 */
async function reportReviewTask(deps: EditWorkDeps, person: string, bridgeId: string, task: EditTask, report: EditTaskReport): Promise<EditReportOutcome> {
  deps.taskTokens?.revokeTask(task.id);
  const forms = deps.reviews(task.target).filter((review) => review.sessionId === taskSessionId(task.id));
  const kept = forms.some((review) => review.state !== "refused");
  if (report.status === "done" && task.state === "done" && kept && report.commit === undefined) return { status: "ok", task };
  if (report.status === "done" && task.claimedBy === bridgeId && task.state === "running" && !kept) {
    const why = forms.length === 0 ? "the run submitted no review form" : "Penguin refused every form the run submitted";
    const released = deps.tasks.report(bridgeId, task.id, { status: "failed", outcome: why });
    deps.notify(person);
    return released.status === "ok" ? { status: "rejected", reason: "invalid", message: why } : released;
  }
  const outcome = deps.tasks.report(bridgeId, task.id, report);
  if (outcome.status === "ok") {
    if (outcome.task.state === "done") deps.tasks.close(outcome.task.sourceKey, "done", outcome.task.outcome ?? "done");
    deps.notify(person);
  }
  return outcome;
}

async function commitProblem(deps: EditWorkDeps, task: EditTask, commit: unknown): Promise<string | null> {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) return "the commit must be a full 40-character SHA";
  if (task.kind === "fix") {
    const written = await taskFixReport(deps.fix, fixPart(task), task.handle as string, commit);
    return written.status === "ok" ? null : written.message;
  }
  const target = deps.features.get(task.target);
  if (target?.repo == null) return `feature ${task.target} has no fork`;
  const allowed = allowedPaths(task, await deps.scopeMap());
  return deps.fix.readFork(target.repo, async (reader) => {
    const pushed = await reader.readCommit(commit);
    if (pushed === null) return `commit ${commit} is not in feature ${task.target}'s fork`;
    if (pushed.parents.length !== 1) return "the commit must have one parent, the fork head the run started from";
    const parent = await reader.readCommit(pushed.parents[0] as string);
    if (parent === null) return "the commit's parent is not in the fork";
    const outside = (await changedFiles(reader, parent.treeHash, pushed.treeHash)).find(
      (file) => !allowed.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`)),
    );
    if (outside !== undefined) return `the commit changes ${outside.path}, outside the task's files and scopes`;
    const history = await reader.log({ ref: FIX_WRITE_BRANCH, limit: 50 });
    if (!history.some((entry) => entry.hash === commit)) return `the commit is not on the fork's ${FIX_WRITE_BRANCH} branch`;
    return null;
  });
}

/** One task as the feature view and get_work show it. */
export function editTaskView(task: EditTask, waitsFor: string | null = null): EditTaskView {
  return {
    waitsFor,
    id: task.id,
    kind: task.kind,
    feature: task.feature,
    target: task.target,
    block: task.sourceKey,
    handle: task.handle,
    person: task.person,
    via: task.via,
    state: task.state,
    askReason: task.askReason,
    files: task.files,
    scopes: task.scopes,
    instructions: task.instructions,
    verifier: task.verifier,
    outcome: task.outcome,
    commit: task.commit,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
