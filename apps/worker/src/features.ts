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
  ProjectRepos,
  ReviewInput,
  ReviewOutcome,
  TokenGrant,
} from "@penguin/project-agent";

import type { FeatureCallResult, McpFeatures } from "@penguin/mcp";
import { REVIEW_SCHEMA_VERSION, SEGMENT_PATTERN } from "@penguin/protocol";

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
}

export interface FeatureConfig {
  /** Undefined when PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY is missing or invalid. */
  readonly forkOptions: FeatureForkOptions | undefined;
  /** Undefined when PENGUIN_FEATURE_TOKEN_TTL_MINUTES is missing or out of range. */
  readonly tokenTtlSeconds: number | undefined;
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

export type FeatureOpenResult =
  | {
      readonly status: "opened" | "existing";
      readonly feature: FeatureView;
      /** The opening session's write token, or null when a person opened the feature. */
      readonly token: MintedToken | null;
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
  if (sessionId !== null && tokenTtlSeconds !== undefined) {
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
    timings: { totalMs: now() - started, forkMs, tokenMs },
  };
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
        return { status: "ok", value: { status: opened.status, feature: opened.feature, token, timings: opened.timings } };
      }),
    token: (sessionId, feature) =>
      guarded(async () => {
        const issued = await issueFeatureToken(ports, owner, sessionId, feature);
        if (issued.status !== "ok") return failure(issued);
        return { status: "ok", value: { token: tokenFields(issued.fork, issued.token) } };
      }),
    declare: async (sessionId, feature, area) => {
      const declared = await (await ports.directory()).declareFeatureArea(owner, feature, area, sessionId, ports.repos);
      return declared.status === "ok" ? { status: "ok", value: { feature: featureView(declared.feature) } } : declared;
    },
    review: (sessionId, feature, scope, form) =>
      guarded(async () => {
        const outcome = await (await ports.directory()).submitReview(owner, sessionId, { feature, scope, form }, ports.repos);
        return outcome.status === "ok" ? { status: "ok", value: reviewFields(outcome) } : outcome;
      }),
    checkpoint: (sessionId, feature, sha) =>
      guarded(async () => {
        const reported = await (await ports.directory()).reportFeatureCheckpoint(owner, sessionId, feature, sha, ports.repos);
        if (reported.status === "rejected") return reported;
        return { status: "ok", value: checkpointFields(reported) };
      }),
  };
}

/** A recorded feature checkpoint as the MCP tool and the bridge route answer it. */
export function checkpointFields(reported: Extract<FeatureCheckpointOutcome, { status: "ok" }>): Record<string, unknown> {
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
  };
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
    // Both need the check runner: the contract diff, and running the scope's code.
    storedDataRule: "waiting for the contract diff on the check runner",
    sideBySide: "waiting for the check runner",
  };
}
