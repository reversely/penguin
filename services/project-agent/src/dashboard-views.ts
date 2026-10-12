// The dashboard's PRD 0.4 views (PRD section 10), built from the ProjectAgent's own state: the team of
// people with their features and agents (`buildTeamView`) and one feature's page (`buildFeaturePage`).
//
// A feature's one-word state comes from facts Penguin holds: its overlap locks, its plan's parts as
// PlanPartRoute keeps them, its facts runs waiting for the runner and its signed records
// (`featureState`). The team view reads no plan from the feature's own Durable Object, so one read of
// forty features stays inside the ProjectAgent's SQLite.
//
// What a person may see: the team view and every feature's declaration, plan places, states, checks
// and records, since a person approves overlapping starts and plan parts from them. A part's changed
// lines show only to the feature's person, the part's owner and that owner's delegate (PRD 13: another
// person's work is visible as the affected lines, to the people they affect), on the feature page and
// in the plan the plan route answers alike (`mayReadPartLines`). No view carries an
// agent's session transcript; Penguin holds none.

import {
  PLAN_ROUND_LIMIT_DEFAULT,
  type ContractWorkView,
  type DashboardAgent,
  type DashboardScope,
  type FeatureException,
  type FeaturePage,
  type FeaturePlanView,
  type FeatureStateWord,
  type PersonRole,
  type Plan,
  type TeamPerson,
  type TeamView,
  type ToolRunView,
  type ViewerPlan,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { AgentToolRun, AgentToolStore } from "./agent-tools.ts";
import type { Feature, FeatureRecord, FeatureStore } from "./feature-store.ts";
import type { FixGrant } from "./fix-write.ts";
import type { Identity } from "./identity-store.ts";
import { RUNNING_STATES, type OverlapStore } from "./overlap-lock.ts";
import { breakView, newestReviews, partFiles, returnedPayload, type PartRoute, type PlanRouteStore } from "./plan-approval.ts";
import type { ReviewStore, StoredReview } from "./review-submit.ts";
import { reviewView } from "./review-view.ts";
import type { RunFailure } from "./run-failures.ts";
import type { Session } from "./session-store.ts";

export interface DashboardViewDeps {
  readonly features: FeatureStore;
  readonly overlaps: OverlapStore;
  readonly routes: PlanRouteStore;
  readonly reviews: ReviewStore;
  readonly tools: AgentToolStore;
  readonly session: (sessionId: string) => Session | undefined;
  readonly identities: () => readonly Identity[];
  /** Where the plan facts run of a feature's checkpoint stands (PlanFactsStore.forCheckpoint), or undefined for none. */
  readonly factsRun: (featureId: string, checkpoint: string) => "pending" | "reported" | "superseded" | undefined;
  readonly scopeMap: () => Promise<ScopeMap>;
  /** Owner id to the delegate `penguin/owners.json` names. */
  readonly delegates: () => Promise<ReadonlyMap<string, string>>;
  /** The feature's newest plan, from its own Durable Object. */
  readonly plan: (featureId: string) => Promise<Plan | undefined>;
  readonly roundLimit: number | undefined;
  /** The write of one revision of a part into another fork (FixGrantStore.get), or undefined. */
  readonly fixWrite: (partId: string, revision: number) => Pick<FixGrant, "state" | "writer" | "commitSha" | "rebased"> | undefined;
  /** How Penguin sorted the feature's latest checkpoint (contract-split.ts contractWork); absent, the page shows none. */
  readonly contract?: (feature: Feature) => ContractWorkView;
  /** The feature's runs the check runner failed up to the failure limit (RunFailureStore.stopped); absent, none. */
  readonly stoppedRuns?: (featureId: string) => readonly RunFailure[];
}

/** What a feature's state is read from. */
export interface FeatureStateFacts {
  readonly feature: Pick<Feature, "state">;
  /** The locks this feature's start waits on, open or approved. */
  readonly locks: readonly { readonly state: "open" | "approved" }[];
  readonly parts: readonly Pick<PartRoute, "state">[];
  /** Where the facts run of the feature's latest checkpoint stands: its agent asked for a plan. */
  readonly factsRun: "pending" | "reported" | "superseded" | undefined;
  /** The type of the feature's newest plan record: `propose_plan`, `plan_returned` or undefined. */
  readonly lastPlanRecord: string | undefined;
}

/**
 * The feature's one-word state (FEATURE_STATES). The latest step in the procedure wins: a plan whose
 * every part is approved is promoting, a part or a start waiting on a person is waiting on approvals,
 * and a plan still being made or revised is planning: its facts run waits for the check runner, or
 * Penguin answered it with what it lacks and no plan is stored yet. A feature whose block run is being
 * checked or moving main is promoting; one whose block reached main is promoted (block-land.ts).
 */
export function featureState(facts: FeatureStateFacts): FeatureStateWord {
  if (facts.feature.state === "landed") return "promoted";
  if (facts.feature.state === "landing") return "promoting";
  const { parts } = facts;
  if (parts.length > 0 && parts.every((part) => part.state === "approved")) return "promoting";
  if (facts.locks.some((lock) => lock.state === "open") || parts.some((part) => part.state === "pending" || part.state === "round_limit")) {
    return "waiting on approvals";
  }
  const asked = facts.factsRun === "pending" || (facts.factsRun === "reported" && parts.length === 0);
  if (asked || facts.lastPlanRecord === "plan_returned" || parts.some((part) => part.state === "change_requested")) return "planning";
  return "building";
}

const parsedRecords = (features: FeatureStore, featureId: string): FeatureRecord[] =>
  features.records(featureId).map((stored) => JSON.parse(stored.file) as FeatureRecord);

/** The exceptions PRD section 7 routes to a person that the team view highlights on a feature. */
export function featureExceptions(
  parts: readonly PartRoute[],
  reviews: readonly StoredReview[],
  records: readonly FeatureRecord[],
  stopped: readonly RunFailure[] = [],
): FeatureException[] {
  const exceptions: FeatureException[] = parts.filter((part) => part.state === "round_limit").map((part) => ({ kind: "round_limit", partId: part.partId }));
  const lastPlan = records.filter((record) => record.type === "propose_plan" || record.type === "plan_returned").at(-1);
  if (lastPlan?.type === "plan_returned") {
    const returned = returnedPayload(lastPlan.payload);
    exceptions.push({ kind: "plan_returned", inPerson: returned.inPerson.length, breakLimit: returned.breakLimit });
  }
  const scopes = [...new Set(reviews.map((review) => review.scopeId))];
  for (const review of newestReviews(reviews, scopes)) {
    for (const exception of review.exceptions) {
      exceptions.push(
        exception.kind === "broken_invariant"
          ? { kind: "broken_invariant", scope: exception.scope, invariant: exception.invariant }
          : { kind: "protected_difference", scope: exception.scope, invariant: exception.invariant, differing: exception.differing },
      );
    }
  }
  for (const run of stopped) exceptions.push({ kind: "run_failed", run: run.kind, runId: run.runId, failures: run.failures, reason: run.reason });
  return exceptions;
}

const byName = (a: DashboardScope, b: DashboardScope) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The person's scopes, the scopes that depend on them and the scopes they depend on. */
export function personRole(scopeMap: ScopeMap, person: string): PersonRole {
  const all = [...scopeMap.scopes.values()];
  const ref = ({ id, name, ownerId }: (typeof all)[number]): DashboardScope => ({ id, name, ownerId });
  const own = all.filter((scope) => scope.ownerId === person);
  const ownIds = new Set(own.map((scope) => scope.id));
  const providers = new Set(own.flatMap((scope) => scope.dependsOn.map((dependency) => dependency.providerScopeId)));
  const others = all.filter((scope) => scope.ownerId !== person);
  return {
    scopes: own.map(ref).sort(byName),
    dependents: others.filter((scope) => scope.dependsOn.some((dependency) => ownIds.has(dependency.providerScopeId))).map(ref).sort(byName),
    dependencies: others.filter((scope) => providers.has(scope.id)).map(ref).sort(byName),
  };
}

const identityPerson = (identity: Identity): string => identity.ownerId ?? identity.teamOwners[0] ?? "";

/** The agents whose sessions joined a feature, each once, online when any of its sessions runs. */
function featureAgents(deps: DashboardViewDeps, featureId: string, byHandle: ReadonlyMap<string, Identity>, person: string): DashboardAgent[] {
  const agents = new Map<string, DashboardAgent>();
  for (const sessionId of deps.features.sessions(featureId)) {
    const session = deps.session(sessionId);
    if (session === undefined) continue;
    const identity = byHandle.get(session.handle);
    const online = session.status === "running" || agents.get(session.handle)?.online === true;
    agents.set(session.handle, { handle: session.handle, identityId: identity?.id ?? null, person: identity === undefined ? person : identityPerson(identity), online });
  }
  return [...agents.values()];
}

/** GET /api/team: every person with their role, their features with each state and agents, and their idle agents. */
export async function buildTeamView(deps: DashboardViewDeps, viewer: string): Promise<TeamView> {
  const scopeMap = await deps.scopeMap();
  const identities = deps.identities();
  const byHandle = new Map(identities.map((identity) => [identity.handle, identity]));
  const features = deps.features.list();
  const working = new Set<string>();
  const teamFeatures = features.map((feature) => {
    const parts = deps.routes.ofFeature(feature.id);
    const records = parsedRecords(deps.features, feature.id);
    const agents = featureAgents(deps, feature.id, byHandle, feature.personId);
    if (RUNNING_STATES.has(feature.state)) for (const agent of agents) working.add(agent.handle);
    return {
      id: feature.id,
      person: feature.personId,
      state: featureState({
        feature,
        locks: deps.overlaps.locksOn(feature.id),
        parts,
        factsRun: feature.latestCheckpointSha === null ? undefined : deps.factsRun(feature.id, feature.latestCheckpointSha),
        lastPlanRecord: records.filter((record) => record.type === "propose_plan" || record.type === "plan_returned").at(-1)?.type,
      }),
      exceptions: featureExceptions(parts, deps.reviews.list(feature.id), records, deps.stoppedRuns?.(feature.id)),
      agents,
      openedAt: feature.openedAt,
    };
  });
  const people = new Set<string>([
    ...[...scopeMap.scopes.values()].map((scope) => scope.ownerId),
    ...features.map((feature) => feature.personId),
    ...identities.map(identityPerson).filter((person) => person !== ""),
  ]);
  const ordered = [...people].sort((a, b) => Number(b === viewer) - Number(a === viewer) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    people: ordered.map(
      (id): TeamPerson => ({
        id,
        role: personRole(scopeMap, id),
        features: teamFeatures.filter((feature) => feature.person === id),
        idleAgents: identities
          .filter((identity) => identityPerson(identity) === id && !working.has(identity.handle))
          .map((identity) => ({ handle: identity.handle, identityId: identity.id, person: id, online: false })),
      }),
    ),
  };
}

const CUT_USES = 50;

function toolRunView(run: AgentToolRun): ToolRunView {
  const outcome = run.outcome;
  const impact = outcome?.impact ?? null;
  return {
    id: run.id,
    tool: run.tool,
    caller: run.caller,
    result: run.result,
    summary: run.summary,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    impact:
      impact === null
        ? null
        : {
            tool: impact.tool,
            commandId: impact.commandId,
            contracts: impact.contracts,
            changes: impact.changes.map(({ symbol, change, path, line }) => ({ symbol, change, path, line })),
            forks: impact.forks.map((fork) => ({ id: fork.id, uses: fork.uses.length })),
          },
    checks: outcome?.checks ?? [],
    decisions: (outcome?.decisions ?? []).map(({ target, check, step, nextStep, actor }) => ({ target, check, step, nextStep, actor: actor.id })),
    fix:
      outcome?.fix === null || outcome?.fix === undefined
        ? null
        : { commandId: outcome.fix.commandId, summary: outcome.fix.summary, paths: outcome.fix.changed?.paths ?? [], pushed: outcome.pushed },
  };
}

/**
 * Whether `viewer` may read a part's changed lines and patch: the feature's person, the part's owner
 * and that owner's delegate (PRD 13). The feature page and the plan route both apply it.
 */
export function mayReadPartLines(plan: Pick<Plan, "person">, owner: string, viewer: string, delegates: ReadonlyMap<string, string>): boolean {
  return viewer === plan.person || viewer === owner || delegates.get(owner) === viewer;
}

/** GET /api/features/<id>/plan: the feature's newest plan as `viewer` may see it, or undefined for no feature or no plan. */
export async function buildFeaturePlan(
  deps: Pick<DashboardViewDeps, "features" | "delegates" | "plan">,
  featureId: string,
  viewer: string,
): Promise<ViewerPlan | undefined> {
  if (deps.features.get(featureId) === undefined) return undefined;
  const [plan, delegates] = await Promise.all([deps.plan(featureId), deps.delegates()]);
  if (plan === undefined) return undefined;
  return {
    ...plan,
    parts: plan.parts.map((part) =>
      mayReadPartLines(plan, part.owner, viewer, delegates) ? part : { ...part, diff: { ...part.diff, patch: null, files: null } },
    ),
  };
}

function planView(plan: Plan, viewer: string, delegates: ReadonlyMap<string, string>, roundLimit: number): FeaturePlanView {
  const diff = plan.facts.contractDiff;
  return {
    planId: plan.planId,
    version: plan.version,
    proposedBy: plan.proposedBy,
    proposedAt: plan.proposedAt,
    breakLimit: plan.breakLimit,
    roundLimit,
    change: { subject: plan.facts.change.subject, madeBy: plan.facts.change.madeBy, checkpoint: plan.facts.change.checkpoint },
    sources: plan.facts.sources,
    contractDiff:
      diff === null
        ? null
        : {
            complete: diff.complete,
            contracts: diff.contracts,
            changes: diff.changes.map(({ symbol, kind, change, path, line }) => ({ symbol, kind, change, path, line })),
            signatures: diff.signatures.map(({ symbol, before, after, breaking }) => ({ symbol, before, after, breaking })),
            dataShapes: diff.dataShapes.map(({ symbol, before, after }) => ({ symbol, before, after })),
          },
    mainCallers: plan.facts.mainCallers.slice(0, CUT_USES),
    affectedFeatures: plan.facts.affectedFeatures.map(({ feature, person, uses, breaks }) => ({ feature, person, uses, breaks })),
    parts: plan.parts.map((part) => ({
      partId: part.partId,
      revision: part.revision,
      place: part.place,
      owner: part.owner,
      scopes: part.scopes,
      kind: part.kind,
      kindReason: part.kindReason,
      state: part.approvalState,
      approvedBy: part.approvedBy,
      changeRequests: part.changeRequests,
      changeRequest: part.changeRequest === null ? null : { by: part.changeRequest.by, revision: part.changeRequest.revision, text: part.changeRequest.text },
      callers: part.callers.slice(0, CUT_USES),
      breaks: part.breaks.map(breakView),
      invariants: part.invariants,
      note: part.note,
      files: mayReadPartLines(plan, part.owner, viewer, delegates) ? partFiles(part) : null,
    })),
  };
}

/** A record's author as its record path names it: a person, an identity's handle or Penguin. */
function authorLabel(record: FeatureRecord): string {
  const { author } = record;
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity;
  return "penguin";
}

/** GET /api/features/<id>/page: one feature's page as `viewer` may see it, or undefined for no such feature. */
export async function buildFeaturePage(deps: DashboardViewDeps, featureId: string, viewer: string): Promise<FeaturePage | undefined> {
  const feature = deps.features.get(featureId);
  if (feature === undefined) return undefined;
  const [scopeMap, delegates, plan] = await Promise.all([deps.scopeMap(), deps.delegates(), deps.plan(featureId)]);
  const byHandle = new Map(deps.identities().map((identity) => [identity.handle, identity]));
  const records = parsedRecords(deps.features, featureId);
  const parts = deps.routes.ofFeature(featureId);
  const locks = deps.overlaps.locksOn(featureId);
  const runs = deps.tools.list(featureId);
  const checkRun = runs.filter((run) => run.tool === "check" && run.outcome !== null).at(-1);
  const scope = (id: string): DashboardScope => {
    const found = scopeMap.scopes.get(id);
    return { id, name: found?.name ?? id, ownerId: found?.ownerId ?? "" };
  };
  return {
    feature: {
      id: feature.id,
      person: feature.personId,
      repo: feature.repo,
      state: featureState({
        feature,
        locks,
        parts,
        factsRun: feature.latestCheckpointSha === null ? undefined : deps.factsRun(featureId, feature.latestCheckpointSha),
        lastPlanRecord: records.filter((record) => record.type === "propose_plan" || record.type === "plan_returned").at(-1)?.type,
      }),
      openedAt: feature.openedAt,
      latestCheckpoint: feature.latestCheckpointSha,
      area: { scopes: feature.area.scopes.map(scope), paths: feature.area.paths, contracts: feature.area.contracts },
    },
    agents: featureAgents(deps, featureId, byHandle, feature.personId),
    waitingOn: locks.map((lock) => ({
      feature: lock.featureId,
      person: lock.personId,
      state: lock.state,
      approvedBy: lock.approvedBy,
      overlap: { scopes: lock.overlap.scopes, paths: lock.overlap.paths, contracts: lock.overlap.contracts },
    })),
    dependents: deps.overlaps.dependents(featureId).map((dependent) => ({
      feature: dependent.dependentFeatureId,
      person: deps.features.get(dependent.dependentFeatureId)?.personId ?? "",
      consumerScope: dependent.consumerScopeId,
      providerScope: dependent.providerScopeId,
    })),
    plan: plan === undefined ? null : planView(plan, viewer, delegates, deps.roundLimit ?? PLAN_ROUND_LIMIT_DEFAULT),
    reviews: deps.reviews.list(featureId).map(reviewView),
    fixes: (plan?.parts ?? []).flatMap((part) => {
      if (part.place.kind !== "feature") return [];
      const write = deps.fixWrite(part.partId, part.revision);
      return [
        {
          partId: part.partId,
          feature: part.place.feature,
          person: part.owner,
          state: part.approvalState,
          approvedBy: part.approvedBy,
          revision: part.revision,
          write: write === undefined ? null : { state: write.state, writer: write.writer, commit: write.commitSha, rebased: write.rebased },
        },
      ];
    }),
    checks: checkRun === undefined ? null : toolRunView(checkRun),
    tools: runs.map(toolRunView),
    contract: deps.contract?.(feature) ?? null,
    records: deps.features.records(featureId).map((stored, index) => ({
      recordId: stored.recordId,
      type: records[index]?.type ?? "",
      author: records[index] === undefined ? "" : authorLabel(records[index]),
      createdAt: records[index]?.created_at ?? "",
      path: stored.path,
    })),
  };
}
