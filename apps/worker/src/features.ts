/**
 * Opening a feature (PRD 0.4 section 4.1, steps 1 and 2), the Worker's half. The ProjectAgent records
 * the feature and its declared area (services/project-agent/src/feature-open.ts); this module forks
 * main into `feature-<id>` through the Artifacts binding, as setup forks each owner's repo, and mints
 * the opening session's write token on that fork.
 *
 * - A second open of the same id makes no second fork: the fork is made only while the feature has
 *   none, and an existing repo counts as made.
 * - A write token is minted only on a grant from the ProjectAgent: the session must be running and an
 *   agent of that feature. The grant names the feature's own fork, so no request can reach main,
 *   another feature's fork or the record repo. The token is `write`, for the configured minutes.
 * - The token's plaintext is returned to the caller once. It is never logged and never sent to the
 *   ProjectAgent, so no Durable Object stores it.
 * - While an overlap lock holds the feature's start (PRD 4.1 step 3), the fork is still made but no
 *   token is minted: the answer names the running features the start waits on and their people.
 *
 * - A write token on another person's feature fork is minted only on a fix-write grant from the
 *   ProjectAgent (`fix_token`, services/project-agent/src/fix-write.ts): for the originating agent named
 *   in the plan, on the one fork of an approved part, for PENGUIN_FIX_TOKEN_TTL_MINUTES.
 * - A feature opened after a merge plan was announced receives every announced plan its area meets
 *   (`announcedPlans`). A checkpoint names each plan that gained a part for it (`plansJoined`) and each
 *   announced plan whose block it asked to check again (`planChecks`).
 * - `land_feature` asks the ProjectAgent to land the session's feature (block-land.ts). The answer
 *   names the block run and its targets; no token on main is ever minted here or returned.
 *
 * The fork options and the token lifetime come from the Worker's configuration
 * (PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY, PENGUIN_FEATURE_TOKEN_TTL_MINUTES); the repo prefix from
 * PENGUIN_REPO_PREFIX. Without a valid value, opening refuses as `misconfigured`.
 */

import type {
  Feature,
  FeatureCheckpointOutcome,
  FeatureOpenInput,
  FeatureOpenOutcome,
  FeatureOutcome,
  FixGrantOutcome,
  FixPartInput,
  FixWriteOutcome,
  HandedPlan,
  JoinedPlan,
  LandAnswer,
  OverlapStatus,
  PartDecisionOutcome,
  ProjectRepos,
  ProposePlanInput,
  ProposePlanOutcome,
  ReviewInput,
  ReviewOutcome,
  ReviewTaskCall,
  ReviewTaskCallOutcome,
  RevisionInput,
  TokenGrant,
  ToolRequestOutcome,
  WhatsNearOutcome,
} from "@penguin/project-agent";

import { planNoticeFields, type FeatureCallResult, type McpFeatures, type McpReviewTask } from "@penguin/mcp";
import { REVIEW_SCHEMA_VERSION, SEGMENT_PATTERN, type FixWriteSpec, type Plan, type PlanFacts, type PlanPart } from "@penguin/protocol";

import { artifactsErrorCode, type FeatureForkOptions } from "./repos.ts";
import type { MintedToken } from "./tokens.ts";

type MaybePromise<T> = T | Promise<T>;

/** A feature's fork as a bridge names it, with or without `penguin:`; the group is the feature id. */
export const FEATURE_FORK = new RegExp(`^(?:penguin:)?feature-(${SEGMENT_PATTERN})$`, "u");

/** The ProjectAgent's feature methods, reached over Durable Object RPC in the Worker. */
export interface FeatureDirectory {
  openFeature(owner: string, input: FeatureOpenInput, sessionId: string | null, repos: ProjectRepos): Promise<FeatureOpenOutcome>;
  recordFeatureRepo(featureId: string, repo: string): MaybePromise<Feature | undefined>;
  featureTokenGrant(owner: string, sessionId: string, featureId: string, repos: ProjectRepos): MaybePromise<TokenGrant>;
  declareFeatureArea(
    owner: string,
    featureId: string,
    area: unknown,
    sessionId: string | null,
    repos: ProjectRepos,
  ): Promise<FeatureOutcome>;
  reportFeatureCheckpoint(
    owner: string,
    sessionId: string | null,
    featureId: string,
    sha: string,
    repos: ProjectRepos,
  ): Promise<FeatureCheckpointOutcome>;
  features(): MaybePromise<readonly Feature[]>;
  submitReview(owner: string, sessionId: string, input: ReviewInput, repos: ProjectRepos): Promise<ReviewOutcome>;
  whatsNear(owner: string, sessionId: string, input: { readonly paths?: unknown; readonly scopes?: unknown }, repos: ProjectRepos): Promise<WhatsNearOutcome>;
  /** One call of review task `taskId`'s headless run, made with its task token (review-task.ts). */
  reviewTaskCall(owner: string, taskId: number, call: ReviewTaskCall, repos: ProjectRepos): Promise<ReviewTaskCallOutcome>;
  requestAgentTool(
    owner: string,
    sessionId: string,
    tool: "impact" | "check" | "apply_fix",
    input: Readonly<Record<string, unknown>>,
    repos: ProjectRepos,
  ): Promise<ToolRequestOutcome>;
  proposePlan(owner: string, sessionId: string, input: ProposePlanInput, repos: ProjectRepos): Promise<ProposePlanOutcome>;
  revisePlanPart(owner: string, sessionId: string, input: RevisionInput, repos: ProjectRepos): Promise<PartDecisionOutcome>;
  /** A write of an approved part's fix for the originating agent's session; the token is minted here on its repo alone. */
  fixWriteGrant(owner: string, sessionId: string, input: FixPartInput, repos: ProjectRepos): Promise<FixGrantOutcome>;
  /** Checks and keeps the commit the originating agent pushed for a granted write. */
  reportFixWrite(owner: string, sessionId: string, input: FixPartInput & { readonly commit: unknown }, repos: ProjectRepos): Promise<FixWriteOutcome>;
  /** `land_feature`: checks the feature is ready and opens its block run (block-land.ts). */
  landFeature(
    owner: string,
    sessionId: string,
    input: { readonly feature: unknown; readonly checkpoint?: unknown; readonly expand?: unknown; readonly retiring?: unknown },
    repos: ProjectRepos,
  ): Promise<LandAnswer>;
}

export interface FeatureConfig {
  /** Undefined when PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY is missing or invalid. */
  readonly forkOptions: FeatureForkOptions | undefined;
  /** Undefined when PENGUIN_FEATURE_TOKEN_TTL_MINUTES is missing or out of range. */
  readonly tokenTtlSeconds: number | undefined;
  /** A fix writer's token lifetime; undefined when PENGUIN_FIX_TOKEN_TTL_MINUTES is out of range. */
  readonly fixTokenTtlSeconds?: number | undefined;
}

export interface FeaturePorts {
  readonly directory: () => MaybePromise<FeatureDirectory>;
  /** Forks main into the feature's repo (`forkFeatureRepo`); an existing repo is kept. */
  readonly fork: (featureId: string, options: FeatureForkOptions) => Promise<{ readonly name: string }>;
  /** Mints a write token on one Artifacts repo, named with the deployment's prefix. */
  readonly mintWrite: (repo: string, ttlSeconds: number) => Promise<MintedToken>;
  readonly repos: ProjectRepos;
  readonly config: FeatureConfig;
  readonly now?: () => number;
}

/** A feature as the dashboard and agents see it: its fork named without the deployment's prefix. */
export interface FeatureView {
  readonly id: string;
  readonly person: string;
  readonly fork: string;
  readonly state: string;
  readonly area: Feature["area"];
  readonly openedAt: string;
  readonly latestCheckpointSha: string | null;
}

/** Opening timings in milliseconds: the whole call, the fork and the token mint. */
export interface OpenTimings {
  readonly totalMs: number;
  readonly forkMs: number | null;
  readonly tokenMs: number | null;
}

export type FeatureFailure =
  | { readonly status: "rejected"; readonly reason: string; readonly message: string }
  | { readonly status: "misconfigured"; readonly message: string };

/** The overlap check's answer as agents see it (overlap-lock.ts). */
export interface OverlapView {
  /** The running features whose people must approve before the feature starts. */
  readonly waitingOn: readonly {
    readonly feature: string;
    readonly person: string;
    readonly overlap: OverlapStatus["waitingOn"][number]["overlap"];
  }[];
  readonly approvedBy: readonly { readonly feature: string; readonly person: string | null }[];
  /** Running features of the same person that cover part of the area: no lock, listed only. */
  readonly ownOverlaps: readonly {
    readonly feature: string;
    readonly overlap: OverlapStatus["waitingOn"][number]["overlap"];
  }[];
  /** Running features that read what this feature changes; they go into its merge plan. */
  readonly dependents: readonly {
    readonly feature: string;
    readonly consumerScope: string;
    readonly providerScope: string;
    readonly kind: string;
  }[];
}

export function overlapView(status: OverlapStatus): OverlapView {
  return {
    waitingOn: status.waitingOn.map((lock) => ({
      feature: lock.featureId,
      person: lock.personId,
      overlap: {
        scopes: [...lock.overlap.scopes],
        paths: [...lock.overlap.paths],
        contracts: [...lock.overlap.contracts],
        omittedPaths: lock.overlap.omittedPaths,
      },
    })),
    approvedBy: status.approved.map((lock) => ({ feature: lock.featureId, person: lock.approvedBy })),
    ownOverlaps: status.ownOverlaps.map(({ featureId, overlap }) => ({
      feature: featureId,
      overlap: { scopes: [...overlap.scopes], paths: [...overlap.paths], contracts: [...overlap.contracts], omittedPaths: overlap.omittedPaths },
    })),
    dependents: status.dependents.map((each) => ({
      feature: each.dependentFeatureId,
      consumerScope: each.consumerScopeId,
      providerScope: each.providerScopeId,
      kind: each.kind,
    })),
  };
}

export type FeatureOpenResult =
  | {
      readonly status: "opened" | "existing";
      readonly feature: FeatureView;
      /** The opening session's write token, or null when a person opened it or its start waits. */
      readonly token: MintedToken | null;
      readonly overlap: OverlapView;
      /** The merge plans announced before the feature opened that its area meets (PRD 4.6). */
      readonly announcedPlans: readonly Record<string, unknown>[];
      readonly timings: OpenTimings;
    }
  | FeatureFailure;

export type FeatureTokenResult = { readonly status: "ok"; readonly fork: string; readonly token: MintedToken } | FeatureFailure;

export function featureView(feature: Feature): FeatureView {
  return {
    id: feature.id,
    person: feature.personId,
    fork: `feature-${feature.id}`,
    state: feature.state,
    area: { scopes: [...feature.area.scopes], paths: [...feature.area.paths], contracts: [...feature.area.contracts] },
    openedAt: feature.openedAt,
    latestCheckpointSha: feature.latestCheckpointSha,
  };
}

/**
 * Opens a feature for `owner`: records it, forks main while it has no fork, and, when a session
 * opens it, mints that session's write token on the fork. Raises when an Artifacts call fails; the
 * feature then stays recorded and opening it again resumes the fork.
 */
export async function openFeatureWithFork(
  ports: FeaturePorts,
  owner: string,
  input: FeatureOpenInput,
  sessionId: string | null,
): Promise<FeatureOpenResult> {
  const now = ports.now ?? Date.now;
  const started = now();
  const { forkOptions, tokenTtlSeconds } = ports.config;
  if (forkOptions === undefined) {
    return { status: "misconfigured", message: "PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY must be true or false" };
  }
  if (sessionId !== null && tokenTtlSeconds === undefined) {
    return { status: "misconfigured", message: "PENGUIN_FEATURE_TOKEN_TTL_MINUTES is missing or out of range" };
  }

  const directory = await ports.directory();
  const outcome = await directory.openFeature(owner, input, sessionId, ports.repos);
  if (outcome.status === "rejected") return outcome;

  let feature = outcome.feature;
  let forkMs: number | null = null;
  if (feature.repo === null) {
    const forkStarted = now();
    const forked = await ports.fork(feature.id, forkOptions);
    feature = (await directory.recordFeatureRepo(feature.id, forked.name)) ?? feature;
    forkMs = now() - forkStarted;
  }

  let token: MintedToken | null = null;
  let tokenMs: number | null = null;
  // A start an overlap lock holds gets no token; `feature_token` gives one once every lock is approved.
  if (sessionId !== null && tokenTtlSeconds !== undefined && outcome.overlap.waitingOn.length === 0) {
    const tokenStarted = now();
    const issued = await issueFeatureToken(ports, owner, sessionId, feature.id);
    if (issued.status !== "ok") return issued;
    token = issued.token;
    tokenMs = now() - tokenStarted;
  }
  return {
    status: outcome.status,
    feature: featureView(feature),
    token,
    overlap: overlapView(outcome.overlap),
    announcedPlans: outcome.announcedPlans.map(handedPlanFields),
    timings: { totalMs: now() - started, forkMs, tokenMs },
  };
}

/**
 * An announced plan as a late starter receives it at open. The checkpoint's commit subject came from
 * the repo, so it is echoed only inside `personWritten`.
 */
export function handedPlanFields(plan: HandedPlan): Record<string, unknown> {
  return {
    plan: plan.planId,
    feature: plan.featureId,
    person: plan.person,
    scopes: [...plan.scopes],
    contracts: [...plan.contracts],
    meets: { scopes: [...plan.meets.scopes], contracts: [...plan.meets.contracts] },
    announcedAt: plan.announcedAt,
    personWritten: { change: plan.subject },
  };
}

/** A part an announced plan gained for the reporting feature at its checkpoint. */
export function joinedPlanFields(joined: readonly JoinedPlan[]): Record<string, unknown>[] {
  return joined.map(({ planId, partId, featureId, meets }) => ({
    plan: planId,
    part: partId,
    feature: featureId,
    meets: { scopes: [...meets.scopes], contracts: [...meets.contracts] },
  }));
}

/**
 * What a fix writer needs besides its token: the commit's parent, the files, the message Penguin built
 * from validated fields and the approved patch, which the originating agent wrote and so is echoed
 * only inside `personWritten`, as are a rule write's rules (#209).
 */
export function fixWriteFields(spec: FixWriteSpec): Record<string, unknown> {
  const { patch, rewrite, ...fields } = spec;
  return { ...fields, paths: [...spec.paths], personWritten: { patch, ...(rewrite === undefined ? {} : { rewrite }) } };
}

/** The token fields an agent receives: the plaintext once, the fork's Git remote and its expiry. */
function tokenFields(fork: string, token: MintedToken): Record<string, unknown> {
  return { fork, scope: token.scope, token: token.token, remote: token.remote, expiresAt: token.expiresAt };
}

function failure(result: FeatureFailure): { readonly status: "rejected"; readonly reason: string; readonly message: string } {
  return result.status === "misconfigured" ? { status: "rejected", reason: "misconfigured", message: result.message } : result;
}

/** Runs a feature call; an Artifacts failure becomes a rejection naming only its code, never a token. */
async function guarded(call: () => Promise<FeatureCallResult>): Promise<FeatureCallResult> {
  try {
    return await call();
  } catch (error) {
    return { status: "rejected", reason: "artifacts", message: `Artifacts failed (${artifactsErrorCode(error) ?? "unknown"}); try again` };
  }
}

/** The feature tools' operations for `owner`'s sessions (services/mcp/src/tools.ts). */
export function mcpFeatures(ports: FeaturePorts, owner: string): McpFeatures {
  return {
    open: (sessionId, feature, area) =>
      guarded(async () => {
        const opened = await openFeatureWithFork(ports, owner, { feature, area }, sessionId);
        if (opened.status === "rejected" || opened.status === "misconfigured") return failure(opened);
        const token = opened.token === null ? null : tokenFields(opened.feature.fork, opened.token);
        return {
          status: "ok",
          value: {
            status: opened.status,
            feature: opened.feature,
            token,
            ...opened.overlap,
            announcedPlans: opened.announcedPlans,
            timings: opened.timings,
          },
        };
      }),
    token: (sessionId, feature) =>
      guarded(async () => {
        const issued = await issueFeatureToken(ports, owner, sessionId, feature);
        if (issued.status !== "ok") return failure(issued);
        return { status: "ok", value: { token: tokenFields(issued.fork, issued.token) } };
      }),
    declare: async (sessionId, feature, area) => {
      const declared = await (await ports.directory()).declareFeatureArea(owner, feature, area, sessionId, ports.repos);
      if (declared.status !== "ok") return declared;
      return { status: "ok", value: { feature: featureView(declared.feature), ...overlapView(declared.overlap) } };
    },
    review: (sessionId, feature, scope, form) =>
      guarded(async () => {
        const outcome = await (await ports.directory()).submitReview(owner, sessionId, { feature, scope, form }, ports.repos);
        return outcome.status === "ok" ? { status: "ok", value: reviewFields(outcome) } : outcome;
      }),
    plan: (sessionId, feature, parts, rules, retiring, storeMarker) =>
      guarded(async () => {
        const outcome = await (await ports.directory()).proposePlan(owner, sessionId, { feature, parts, rules, retiring, storeMarker }, ports.repos);
        return outcome.status === "rejected" ? outcome : { status: "ok", value: planAnswer(outcome) };
      }),
    revise: (sessionId, input) =>
      guarded(async () => {
        const outcome = await (await ports.directory()).revisePlanPart(owner, sessionId, input, ports.repos);
        if (outcome.status === "rejected") return outcome;
        return { status: "ok", value: { status: "revised", recordId: outcome.recordId, part: partFields(outcome.part) } };
      }),
    fixToken: (sessionId, input) =>
      guarded(async () => {
        const ttl = ports.config.fixTokenTtlSeconds;
        if (ttl === undefined) return { status: "rejected", reason: "misconfigured", message: "PENGUIN_FIX_TOKEN_TTL_MINUTES must be a whole number of minutes from 1 to 60" };
        const grant = await (await ports.directory()).fixWriteGrant(owner, sessionId, input, ports.repos);
        if (grant.status === "rejected") return grant;
        // The token names the affected fork alone, for minutes, minted only on the grant.
        const token = await ports.mintWrite(grant.repo, ttl);
        return { status: "ok", value: { token: tokenFields(grant.spec.fork, token), write: fixWriteFields(grant.spec) } };
      }),
    reportFixWrite: (sessionId, input) =>
      guarded(async () => {
        const outcome = await (await ports.directory()).reportFixWrite(owner, sessionId, input, ports.repos);
        if (outcome.status === "rejected") return outcome;
        const { write, durationMs } = outcome;
        return {
          status: "ok",
          value: {
            status: "written",
            part: write.partId,
            revision: write.revision,
            fork: write.targetRepo,
            commit: write.commitSha,
            parent: write.parent,
            recordId: write.recordId,
            writtenAt: write.writtenAt,
            durationMs,
          },
        };
      }),
    land: (sessionId, input) =>
      guarded(async () => {
        const landed = await (await ports.directory()).landFeature(owner, sessionId, input, ports.repos);
        if (landed.status === "rejected") return landed;
        return {
          status: "ok",
          value: {
            ...landed,
            targets: landed.targets.map(({ feature, sha }) => ({ feature, sha })),
            message: "waiting for the check runner; read the result in get_work's landing",
          },
        };
      }),
    checkpoint: (sessionId, feature, sha) =>
      guarded(async () => {
        const reported = await (await ports.directory()).reportFeatureCheckpoint(owner, sessionId, feature, sha, ports.repos);
        if (reported.status === "rejected") return reported;
        return { status: "ok", value: checkpointFields(reported) };
      }),
    whatsNear: async (sessionId, input) => {
      const near = await (await ports.directory()).whatsNear(owner, sessionId, input, ports.repos);
      if (near.status === "rejected") return near;
      return { status: "ok", value: { recordedAs: near.runId, features: near.features.map(nearFields) } };
    },
    tool: async (sessionId, tool, input) => {
      const requested = await (await ports.directory()).requestAgentTool(owner, sessionId, tool, input, ports.repos);
      if (requested.status === "rejected") return requested;
      return {
        status: "ok",
        value: {
          state: "waiting",
          recordedAs: requested.runId,
          tool: requested.tool,
          feature: requested.featureId,
          checkpoint: requested.checkpointSha,
          commandId: requested.commandId,
          input: requested.input,
          message: "waiting for the check runner",
        },
      };
    },
  };
}

/**
 * The review tools of `owner`'s review task `taskId`, for the server its task token reaches. Each
 * answer has the fields the same tool gives a session; the ProjectAgent refuses a call outside the task.
 */
export function mcpReviewTask(ports: FeaturePorts, owner: string, taskId: number): McpReviewTask {
  const call = async (each: ReviewTaskCall) => (await ports.directory()).reviewTaskCall(owner, taskId, each, ports.repos);
  return {
    review: (feature, scope, form) =>
      guarded(async () => {
        const called = await call({ tool: "submit_review", input: { feature, scope, form } });
        if (called.status === "rejected") return called;
        const outcome = called.tool === "submit_review" ? called.outcome : unexpected();
        return outcome.status === "ok" ? { status: "ok", value: reviewFields(outcome) } : outcome;
      }),
    whatsNear: async (input) => {
      const called = await call({ tool: "whats_near", input });
      if (called.status === "rejected") return called;
      const near = called.tool === "whats_near" ? called.outcome : unexpected();
      if (near.status === "rejected") return near;
      return { status: "ok", value: { recordedAs: near.runId, features: near.features.map(nearFields) } };
    },
    impact: async (feature) => {
      const called = await call({ tool: "impact", input: { feature } });
      if (called.status === "rejected") return called;
      if (called.tool !== "impact") return unexpected();
      if ("reported" in called) {
        const { id, featureId, checkpointSha, result, summary, outcome } = called.reported;
        return { status: "ok", value: { state: "reported", recordedAs: id, tool: "impact", feature: featureId, checkpoint: checkpointSha, result, summary, report: outcome } };
      }
      const requested = called.outcome;
      if (requested.status === "rejected") return requested;
      return {
        status: "ok",
        value: { state: "waiting", recordedAs: requested.runId, tool: "impact", feature: requested.featureId, checkpoint: requested.checkpointSha, message: "waiting for the check runner" },
      };
    },
  };
}

function unexpected(): never {
  throw new Error("the review task call answered for another tool");
}

/** A running feature near the asked paths or scopes, as `whats_near` answers it. */
function nearFields(near: Extract<WhatsNearOutcome, { status: "ok" }>["features"][number]): Record<string, unknown> {
  return {
    feature: near.featureId,
    person: near.personId,
    state: near.state,
    touches:
      near.touches === null
        ? null
        : { scopes: [...near.touches.scopes], paths: [...near.touches.paths], contracts: [...near.touches.contracts], omittedPaths: near.touches.omittedPaths },
    dependsOn: near.dependsOn.map(({ consumerScopeId, providerScopeId, kind }) => ({ consumerScope: consumerScopeId, providerScope: providerScopeId, kind })),
    agents: near.agents.map(({ handle, vendor, status }) => ({ identity: handle, vendor, status })),
  };
}

/** A recorded feature checkpoint as the MCP tool and the bridge route answer it. */
export function checkpointFields(
  reported: Extract<FeatureCheckpointOutcome, { status: "ok" }> & { readonly planChecks?: readonly { readonly feature: string; readonly runId: string }[] },
): Record<string, unknown> {
  const view = featureView(reported.feature);
  return {
    fork: view.fork,
    latestCheckpointSha: view.latestCheckpointSha,
    baselineSha: reported.baselineSha,
    area: view.area,
    changedPaths: reported.changedPaths,
    omittedPaths: reported.omittedPaths,
    durationMs: reported.durationMs,
    newWork: [...reported.delivered],
    newThreads: reported.threads.map(({ issueId, threadId }) => ({ issueId, threadId })),
    newOverlaps: reported.overlaps.map(({ featureId, blockedFeatureId }) => ({ feature: featureId, blockedFeature: blockedFeatureId })),
    locksSettled: settledFields(reported.settled),
    toolResults: toolResultFields(reported.toolResults ?? []),
    ...planNoticeFields(reported.planNotices),
    plansJoined: joinedPlanFields(reported.plansJoined ?? []),
    planChecks: (reported.planChecks ?? []).map(({ feature, runId }) => ({ feature, runId })),
    contractSort: reported.contractSort ?? null,
  };
}

/** The check runner's results of the session's tool requests, as a safe checkpoint names them. */
export function toolResultFields(
  results: readonly { readonly runId: number; readonly tool: string; readonly featureId: string; readonly result: string; readonly summary: string }[],
): Record<string, unknown>[] {
  return results.map(({ runId, tool, featureId, result, summary }) => ({ recordedAs: runId, tool, feature: featureId, result, summary }));
}

/** Locks on the session's feature that were approved or withdrawn, as the wire names them. */
export function settledFields(
  settled: readonly { readonly featureId: string; readonly blockedFeatureId: string; readonly outcome: string }[],
): Record<string, unknown>[] {
  return settled.map(({ featureId, blockedFeatureId, outcome }) => ({ feature: featureId, blockedFeature: blockedFeatureId, outcome }));
}

/** Mints a fresh write token on feature `featureId`'s fork for `owner`'s session, on a grant only. */
export async function issueFeatureToken(
  ports: FeaturePorts,
  owner: string,
  sessionId: string,
  featureId: string,
): Promise<FeatureTokenResult> {
  const ttl = ports.config.tokenTtlSeconds;
  if (ttl === undefined) {
    return { status: "misconfigured", message: "PENGUIN_FEATURE_TOKEN_TTL_MINUTES is missing or out of range" };
  }
  const grant = await (await ports.directory()).featureTokenGrant(owner, sessionId, featureId, ports.repos);
  if (grant.status === "rejected") return grant;
  return { status: "ok", fork: `feature-${grant.featureId}`, token: await ports.mintWrite(grant.repo, ttl) };
}

/**
 * A plan as the MCP tool answers it. Penguin's own fields (ids, places, kinds, people, commits and
 * counts) stand apart from text that came from the repos and the run (commit subjects, docstrings,
 * assertion lines, file paths, diff lines, invariant statements, the agent's notes), which is echoed
 * only inside `personWritten`.
 */
export function planAnswer(outcome: Exclude<ProposePlanOutcome, { status: "rejected" }>): Record<string, unknown> {
  switch (outcome.status) {
    case "stored":
      return { status: "stored", ...planFields(outcome.plan) };
    case "missing":
      return {
        status: "missing",
        feature: outcome.featureId,
        checkpoint: outcome.checkpoint,
        missing: outcome.missing.map(({ code, message, place, part, rule, detail }) => ({
          code,
          message,
          ...(place === undefined ? {} : { place }),
          ...(part === undefined ? {} : { part }),
          ...(rule === undefined ? {} : { rule }),
          ...(detail === undefined ? {} : { personWritten: { detail } }),
        })),
        facts: factsFields(outcome.facts),
      };
    case "returned":
      return {
        status: "returned",
        feature: outcome.featureId,
        breakLimit: outcome.breakLimit,
        inPerson: outcome.inPerson.map((place) => ({ ...place })),
        recordId: outcome.recordId,
        message: outcome.message,
        facts: factsFields(outcome.facts),
      };
  }
}

function planFields(plan: Plan): Record<string, unknown> {
  const { planId, featureId, version, state, person, proposedBy, proposedAt, recordId, breakLimit, assembledMs } = plan;
  return {
    planId,
    feature: featureId,
    version,
    state,
    person,
    proposedBy,
    proposedAt,
    recordId,
    breakLimit,
    assembledMs,
    facts: factsFields(plan.facts),
    rules: (plan.rules ?? []).map((rule) => rule.id),
    parts: plan.parts.map(partFields),
  };
}

function factsFields(facts: PlanFacts): Record<string, unknown> {
  const { change, contractDiff, mainCallers, invariants, breaks } = facts;
  return {
    checkpoint: change.checkpoint,
    baseline: change.baseline,
    madeBy: change.madeBy,
    contractDiffKnown: contractDiff !== null,
    affectedFeatures: facts.affectedFeatures.map((each) => ({ ...each, scopes: [...each.scopes], dependsOn: [...each.dependsOn] })),
    sources: facts.sources.map((source) => ({ ...source })),
    run: facts.run,
    personWritten: { change: change.subject, contractDiff, mainCallers, invariants, breaks },
  };
}

function partFields(part: PlanPart): Record<string, unknown> {
  const { partId, revision, place, owner, scopes, kind, diff, approvalState, approvedBy, changeRequests } = part;
  return {
    partId,
    revision,
    place,
    owner,
    scopes: [...scopes],
    kind,
    diff: { source: diff.source, repo: diff.repo, ref: diff.ref, commit: diff.commit, base: diff.base, truncated: diff.truncated, files: diff.files.length },
    approvalState,
    approvedBy,
    changeRequests,
    personWritten: {
      note: part.note,
      changeRequest: part.changeRequest,
      kindReason: part.kindReason,
      callers: part.callers,
      breaks: part.breaks,
      invariants: part.invariants,
      files: part.diff.files,
    },
  };
}

/**
 * A review as the MCP tool answers it. Text people wrote (the reviewer's invariant names and evidence,
 * the owner's invariant statements) is echoed only inside `personWritten`.
 */
function reviewFields(outcome: Extract<ReviewOutcome, { status: "ok" }>): Record<string, unknown> {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewId: outcome.reviewId,
    feature: outcome.featureId,
    scope: outcome.scopeId,
    forkSha: outcome.forkSha,
    state: outcome.state,
    refusals: outcome.refusals.map(({ code, message, invariant, evidence }) => ({
      code,
      message,
      personWritten: { ...(invariant === undefined ? {} : { invariant }), ...(evidence === undefined ? {} : { evidence }) },
    })),
    invariants: outcome.invariants.map(({ id, protected: isProtected, statement }) => ({
      id,
      protected: isProtected,
      personWritten: { statement },
    })),
    // Both need the check runner: the contract diff, and running the scope's code. A pending review
    // waits for it; a refused form never reaches it.
    ...(outcome.state === "pending"
      ? { storedDataRule: "waiting for the contract diff on the check runner", sideBySide: "waiting for the check runner" }
      : { storedDataRule: "not checked: the form was refused", sideBySide: "not run: the form was refused" }),
  };
}
