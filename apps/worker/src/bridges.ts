/**
 * Bridge registration and the token route.
 *
 * - POST /bridges/codes, deployer only: issues a one-time registration code for one owner and role.
 *   The deployer hands the code to the owner, who registers their bridge with it.
 * - POST /bridges: spends a code and records the bridge's public signing key. Returns the bridge
 *   token, once.
 * - DELETE /bridges/<id>, deployer only: revokes a bridge.
 * - POST /tokens, bridge token: returns a short-lived Artifacts token on one project repo, with the
 *   repo's Git remote.
 * - GET /operations/pending, bridge token of a runner bridge: lists the operations from MCP, the
 *   dashboard and Penguin that wait for the runner to push them to the issues repo.
 * - POST /checkpoints, bridge token: records a checkpoint the bridge pushed to its owner's fork as
 *   that fork's latest checkpoint. The owner comes from the token; the body carries only the SHA
 *   and the fork, which must be the owner's own. A checkpoint that changes a scope other scopes
 *   depend on schedules one combined run per dependent owner. A checkpoint on `feature-<id>`, a
 *   feature the bridge's owner opened, instead updates that feature's declared area with the paths
 *   the checkpoint changed (features.ts).
 * - POST /combined-runs/claim, bridge token of a runner bridge: claims the scheduled combined runs.
 *   Each run names its checkpoints and allowlisted command IDs, never a shell command.
 * - POST /combined-runs, bridge token of a runner bridge: reports a combined run. When its tests
 *   failed on a published checkpoint, the ProjectAgent opens a Huddle issue and the Worker forks the
 *   Huddle repo. A second report of the same trigger opens nothing.
 * - POST /sessions/checkpoint, bridge token: a safe checkpoint in one of the owner's worktrees, sent
 *   by the bridge's hook before an agent's next tool action or as an explicit bridge checkpoint. The
 *   owner's running sessions in that worktree receive their waiting fix tasks, and hear of the
 *   threads and overlapping starts that newly wait for the owner, of each lock on their feature
 *   that was approved or withdrawn, of each merge plan part revision that waits on the owner, of
 *   each decision on a part of their feature's plan and of the runner's verdict on each review they
 *   submitted. The body carries only the worktree id.
 * - GET /verifications, bridge token of a runner bridge: lists the verification runs waiting for the
 *   runner: the checkpoints to merge onto a Huddle repo's `integration` branch and the commands to run.
 * - POST /verifications/<run id>, bridge token of a runner bridge: reports a verification run. Penguin
 *   attaches its checks to the Huddle issue; a run a newer checkpoint superseded answers 409.
 * - GET /plan-facts, bridge token of a runner bridge: lists the merge-plan facts runs waiting for the
 *   runner: a feature checkpoint, its baseline and the targets to merge it onto, with test command IDs.
 * - POST /plan-facts/<run id>, bridge token of a runner bridge: reports a facts run's impact report and
 *   test results. Penguin keeps them for the feature's merge plan; a run a newer checkpoint superseded
 *   answers 409.
 * - GET /approvals, bridge token of a runner bridge: lists the approved branches to record: for each
 *   Huddle whose fixes are approved, whose combined tests pass and whose threads are resolved, the
 *   verified `integration` commit to point the Huddle repo's `approved` branch at.
 * - POST /approvals/<issue id>, bridge token of a runner bridge: reports the Huddle repo's `approved`
 *   branch at the requested commit. Penguin links it on the Huddle issue and closes the issue as
 *   approved; a report of a commit no longer requested answers 409.
 * - POST /reviews/claim, bridge token of a runner bridge: claims the pending reviews (submit_review).
 *   Each names its feature's fork, the checkpoint, its baseline on main, the scope and the form.
 * - POST /reviews/<review id>, bridge token of a runner bridge: reports a claimed review's record from
 *   the review harness. The review becomes accepted or refused with the record attached; an exception
 *   goes to the scope's owner. A review already completed answers 409.
 * - POST /tool-runs/claim, bridge token of a runner bridge: claims the waiting `impact`, `check` and
 *   `apply_fix` requests. Each names its feature's fork, the checkpoint, its baseline on main, the
 *   caller's charter and the other running features' forks.
 * - POST /tool-runs/<run id>, bridge token of a runner bridge: reports a claimed request's result. The
 *   requesting session hears of it at its next safe checkpoint. A request already completed answers 409.
 * - POST /fix-writes/claim, bridge token of a runner bridge: claims the writes of approved mechanical
 *   plan parts. Each names the affected feature's fork, the head to fast-forward, the patch, its paths
 *   and the commit message, with a write token minted for that part alone on that fork alone, for
 *   PENGUIN_FIX_TOKEN_TTL_MINUTES.
 * - POST /fix-writes/<write id>, bridge token of the runner that claimed it: reports the pushed commit.
 *   Penguin reads it from the fork and keeps it as a signed `fix_write` record only when it is the
 *   approved patch applied to the granted head; anything else answers 400.
 *
 * Responses that carry a code or token are marked `Cache-Control: no-store`.
 */

import type {
  ApprovalOutcome,
  ApprovalSpec,
  BridgeCaller,
  BridgeIdentity,
  BridgeRole,
  CheckpointOutcome,
  ClaimListing,
  FixWriteOutcome,
  Delivery,
  FeatureCheckpointOutcome,
  Huddle,
  HuddleOpenOutcome,
  PendingListing,
  PlanFactsReportOutcome,
  ProjectRepos,
  RegisterOutcome,
  RegistrationCode,
  ReviewClaim,
  ReviewReportOutcome,
  ToolReportOutcome,
  ToolRunClaim,
  VerificationOutcome,
} from "@penguin/project-agent";

import { planNoticeFields } from "@penguin/mcp";
import { REVIEW_LIMITS, TOOL_RESULT_LIMITS } from "@penguin/protocol";
import type { FixWriteSpec, PlanFactsRequest } from "@penguin/protocol";

import { bearerToken, isDeployer } from "./auth.ts";
import { checkpointFields, FEATURE_FORK, fixWriteFields, settledFields, toolResultFields } from "./features.ts";
import { artifactsErrorCode, huddleRepoId, isValidRepoName } from "./repos.ts";
import {
  allowedScope,
  isPermitted,
  parseProjectRepo,
  RepoNotFoundError,
  type MintedToken,
  type TokenScope,
} from "./tokens.ts";

type MaybePromise<T> = T | Promise<T>;

/** How long a registration code stays usable. */
export const REGISTRATION_CODE_TTL_SECONDS = 900;

/** The ProjectAgent's bridge registry, reached over Durable Object RPC in the Worker. */
export interface BridgeDirectory {
  issueBridgeRegistrationCode(ownerId: string, role: BridgeRole, ttlSeconds: number): Promise<RegistrationCode>;
  registerBridge(code: string, publicKey: unknown): Promise<RegisterOutcome>;
  authenticateBridge(bridgeToken: string): Promise<BridgeIdentity | undefined>;
  revokeBridge(bridgeId: string): Promise<boolean> | boolean;
  /** The operations waiting for the runner; refused unless `caller` holds the runner role. */
  pendingOperations(caller: BridgeCaller): Promise<PendingListing> | PendingListing;
  /**
   * Records `sha` as `owner`'s latest checkpoint once the commit is found in `fork`, an Artifacts repo
   * name, and schedules the combined runs it calls for and the verification of its owner's open Huddles.
   */
  reportBridgeCheckpoint(owner: string, sha: string, fork: string, repos: ProjectRepos): Promise<CheckpointOutcome>;
  /** Records `sha` on feature `featureId`'s fork for `owner`, who must own the feature; see features.ts. */
  reportFeatureCheckpoint(
    owner: string,
    sessionId: null,
    featureId: string,
    sha: string,
    repos: ProjectRepos,
  ): Promise<FeatureCheckpointOutcome>;
  /** Claims the scheduled combined runs; refused unless `caller` holds the runner role. */
  claimCombinedRuns(caller: BridgeCaller): Promise<ClaimListing> | ClaimListing;
  /** A safe checkpoint of `owner`'s running sessions in the worktree `worktreeId`. */
  sessionCheckpoint(owner: string, worktreeId: string): Promise<Delivery[]> | Delivery[];
  /** Claims the pending reviews; refused unless `caller` holds the runner role. */
  claimReviews(caller: BridgeCaller): Promise<ReviewClaim> | ReviewClaim;
  /** Attaches the runner's record to review `reviewId`; refused unless `caller` holds the runner role. */
  reportReview(caller: BridgeCaller, reviewId: number, record: unknown): Promise<ReviewReportOutcome>;
  /** The merge-plan facts runs waiting for the runner; refused unless `caller` holds the runner role. */
  planFactsRuns(
    caller: BridgeCaller,
  ): MaybePromise<{ readonly status: "ok"; readonly runs: readonly PlanFactsRequest[] } | { readonly status: "forbidden"; readonly message: string }>;
  /** Records the runner's report of facts run `runId`; refused unless `caller` holds the runner role. */
  reportPlanFacts(caller: BridgeCaller, runId: string, report: unknown): MaybePromise<PlanFactsReportOutcome>;
  /** Claims the waiting agent tool requests; refused unless `caller` holds the runner role. */
  claimToolRuns(caller: BridgeCaller): Promise<ToolRunClaim> | ToolRunClaim;
  /** Attaches the runner's result to tool request `runId`; refused unless `caller` holds the runner role. */
  reportToolRun(caller: BridgeCaller, runId: number, result: unknown): Promise<ToolReportOutcome> | ToolReportOutcome;
  /** Claims the writes of approved mechanical plan parts; refused unless `caller` holds the runner role. */
  claimFixWrites(
    caller: BridgeCaller,
    repos: ProjectRepos,
  ): Promise<{ readonly status: "ok"; readonly writes: readonly { readonly spec: FixWriteSpec }[] } | { readonly status: "forbidden"; readonly message: string }>;
  /** Checks and keeps the commit the runner pushed for write `writeId`, which it claimed. */
  reportRunnerFixWrite(caller: BridgeCaller, writeId: number, body: unknown, repos: ProjectRepos): Promise<FixWriteOutcome>;
}

/** Opening Huddle issues: the ProjectAgent's side over Durable Object RPC, and the Huddle repo fork. */
export interface HuddleDirectory {
  /** Opens the Huddle issue for a combined run; `triggerFork` is the trigger owner's fork. */
  open(event: unknown, triggerFork: string): Promise<HuddleOpenOutcome>;
  /** Records the Huddle repo forked for the Huddle opened by `triggerCommit`. */
  recordRepo(triggerCommit: string, huddleRepo: string): Promise<Huddle | undefined>;
  /** Forks `huddle-<id>` from the base repo (`forkHuddleRepo` in repos.ts); an existing repo is kept. */
  forkRepo(huddleId: string): Promise<{ readonly name: string }>;
  /** The verification runs waiting for the runner. */
  pendingVerifications(): Promise<readonly unknown[]>;
  /** Records a runner's report of run `runId`; `runnerId` is the reporting bridge. */
  reportVerification(runId: string, runnerId: string, report: unknown): Promise<VerificationOutcome>;
  /** The approved branches waiting for the runner. */
  pendingApprovals(): Promise<readonly ApprovalSpec[]>;
  /** Records a runner's report of Huddle issue `issueId`'s approved branch; `runnerId` is the reporting bridge. */
  reportApproval(issueId: string, runnerId: string, report: unknown): Promise<ApprovalOutcome>;
}

/** Mints a token on a repo named without the deployment's prefix, such as `owner-jun`. */
export type TokenMinter = (repo: string, scope: TokenScope, ttlSeconds: number) => Promise<MintedToken>;

export interface BridgeHandlers {
  readonly bridges: () => BridgeDirectory | Promise<BridgeDirectory>;
  readonly mintToken: TokenMinter;
  /** The Artifacts repo name of an owner's fork, with the deployment's repo prefix. */
  readonly ownerForkRepo: (ownerId: string) => string;
  readonly huddles: () => HuddleDirectory | Promise<HuddleDirectory>;
  /** The project's issues and base repos, with the deployment's repo prefix. */
  readonly projectRepos: ProjectRepos;
}

export interface BridgeOptions {
  readonly deployerToken?: string;
  /** The parsed PENGUIN_TOKEN_TTL_SECONDS, or undefined when the configured value is invalid. */
  readonly tokenTtlSeconds: number | undefined;
  /** The parsed PENGUIN_FIX_TOKEN_TTL_MINUTES in seconds, or undefined when the configured value is invalid. */
  readonly fixTokenTtlSeconds?: number | undefined;
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers });
}

const unauthorized = () => json({ error: "unauthorized" }, 401);

function invalid(field: string, message: string): Response {
  return json({ error: "invalid request", issues: [{ field, message }] }, 400);
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

async function readObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function issueCode(request: Request, options: BridgeOptions, handlers: BridgeHandlers): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const { owner, role = "owner" } = body;
  if (typeof owner !== "string" || !isValidRepoName(owner)) {
    return invalid("owner", "must be an owner id that starts with a letter or digit");
  }
  if (role !== "owner" && role !== "runner") return invalid("role", "must be owner or runner");
  const directory = await handlers.bridges();
  const code = await directory.issueBridgeRegistrationCode(owner, role, REGISTRATION_CODE_TTL_SECONDS);
  return json({ code: code.code, owner: code.ownerId, role: code.role, expiresAt: code.expiresAt }, 201, NO_STORE);
}

async function register(request: Request, handlers: BridgeHandlers): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  if (typeof body.code !== "string" || body.code === "") return invalid("code", "must be a registration code");
  const outcome = await (await handlers.bridges()).registerBridge(body.code, body.publicKey);
  switch (outcome.status) {
    case "invalid_key":
      return invalid("publicKey", outcome.message);
    case "invalid_code":
      return json({ error: "the registration code is unknown, used or expired" }, 401);
    case "registered": {
      const { bridgeId, ownerId, role, bridgeToken } = outcome.bridge;
      return json({ bridgeId, owner: ownerId, role, bridgeToken }, 201, NO_STORE);
    }
  }
}

async function revoke(
  request: Request,
  bridgeId: string,
  options: BridgeOptions,
  handlers: BridgeHandlers,
): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) return unauthorized();
  if (request.method !== "DELETE") return methodNotAllowed("DELETE");
  const revoked = await (await handlers.bridges()).revokeBridge(bridgeId);
  return revoked ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
}

async function issueToken(request: Request, options: BridgeOptions, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const bridge = token === undefined ? undefined : await (await handlers.bridges()).authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");

  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const { repo: repoName, scope } = body;
  if (scope !== "read" && scope !== "write") return invalid("scope", "must be read or write");
  const repo = typeof repoName === "string" ? parseProjectRepo(repoName) : undefined;
  if (repo === undefined || typeof repoName !== "string") {
    return invalid("repo", "must be base, issues, owner-<id>, huddle-<id> or feature-<id>");
  }
  if (!isPermitted(scope, allowedScope(bridge, repo))) {
    return json({ error: "forbidden", message: `this bridge may not hold ${scope} on ${repoName}` }, 403);
  }
  if (options.tokenTtlSeconds === undefined) {
    return json({ error: "misconfigured", message: "PENGUIN_TOKEN_TTL_SECONDS is out of range" }, 500);
  }

  try {
    const minted = await handlers.mintToken(repoName, scope, options.tokenTtlSeconds);
    const { scope: mintedScope, token, remote, expiresAt } = minted;
    return json({ repo: repoName, scope: mintedScope, token, remote, expiresAt }, 200, NO_STORE);
  } catch (error) {
    if (error instanceof RepoNotFoundError) return json({ error: "not found", repo: repoName }, 404);
    return json({ error: "artifacts", code: artifactsErrorCode(error) ?? null }, 502);
  }
}

async function listPending(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const directory = await handlers.bridges();
  const bridge = token === undefined ? undefined : await directory.authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "GET") return methodNotAllowed("GET");
  // The role comes from the registry record the token authenticated, never from the request.
  const listing = await directory.pendingOperations({ bridgeId: bridge.bridgeId, role: bridge.role });
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  const files = listing.files.map(({ opId, path, file, source, createdAt }) => ({ opId, path, file, source, createdAt }));
  return json({ files }, 200, NO_STORE);
}

const CHECKPOINT_FORK = /^(?:penguin:)?(owner-[A-Za-z0-9][A-Za-z0-9._-]*)$/u;

async function reportCheckpoint(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const directory = await handlers.bridges();
  const bridge = token === undefined ? undefined : await directory.authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");

  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const { sha, fork } = body;
  if (typeof sha !== "string") return invalid("sha", "must be the checkpoint commit's full SHA");
  const feature = typeof fork === "string" ? FEATURE_FORK.exec(fork)?.[1] : undefined;
  if (feature !== undefined) return reportFeatureCheckpoint(directory, bridge, feature, sha, handlers);
  const forkRepo = typeof fork === "string" ? CHECKPOINT_FORK.exec(fork)?.[1] : undefined;
  if (forkRepo === undefined) return invalid("fork", "must be owner-<id>, feature-<id> or either with the penguin: prefix");
  // The owner comes from the registry record the token authenticated, never from the request.
  const own = `owner-${bridge.ownerId}`;
  if (forkRepo !== own) {
    return json({ error: "forbidden", message: `this bridge reports checkpoints only for ${own}, not ${forkRepo}` }, 403);
  }

  let outcome: CheckpointOutcome;
  try {
    const fork = handlers.ownerForkRepo(bridge.ownerId);
    outcome = await directory.reportBridgeCheckpoint(bridge.ownerId, sha, fork, handlers.projectRepos);
  } catch (error) {
    return json({ error: "artifacts", code: artifactsErrorCode(error) ?? null }, 502);
  }
  if (outcome.status === "rejected") {
    // 422, not 404, for a commit missing from the fork, so a bridge can tell it from a missing route.
    const status = outcome.reason === "invalid" ? 400 : outcome.reason === "not_found" ? 422 : 403;
    return json({ error: outcome.reason, message: outcome.message }, status);
  }
  const { ownerId, latestCheckpointSha, reportedAt } = outcome.fork;
  return json({ fork: own, ownerId, latestCheckpointSha, reportedAt }, 200);
}

const FEATURE_REJECTION_STATUS: Readonly<Record<string, number>> = { invalid: 400, forbidden: 403, not_found: 422 };

/**
 * Records a checkpoint the bridge pushed to a feature's fork. The feature must be the bridge owner's;
 * the ProjectAgent checks that, confirms the commit is in the fork and updates the declared area.
 */
async function reportFeatureCheckpoint(
  directory: BridgeDirectory,
  bridge: BridgeIdentity,
  feature: string,
  sha: string,
  handlers: BridgeHandlers,
): Promise<Response> {
  let outcome: FeatureCheckpointOutcome;
  try {
    // The owner comes from the registry record the token authenticated, never from the request.
    outcome = await directory.reportFeatureCheckpoint(bridge.ownerId, null, feature, sha, handlers.projectRepos);
  } catch (error) {
    return json({ error: "artifacts", code: artifactsErrorCode(error) ?? null }, 502);
  }
  if (outcome.status === "rejected") {
    return json({ error: outcome.reason, message: outcome.message }, FEATURE_REJECTION_STATUS[outcome.reason] ?? 409);
  }
  const {
    newWork: _work,
    newThreads: _threads,
    newOverlaps: _overlaps,
    locksSettled: _settled,
    toolResults: _results,
    newPlanParts: _parts,
    planDecisions: _decisions,
    reviewResults: _reviews,
    ...fields
  } = checkpointFields(outcome);
  return json(fields, 200);
}

/** A worktree id as sessions register it (SESSION_LIMITS.worktreeIdLength in the ProjectAgent). */
const WORKTREE_ID = /^[A-Za-z0-9_.-]{1,128}$/u;

async function sessionCheckpoint(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const directory = await handlers.bridges();
  const bridge = token === undefined ? undefined : await directory.authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");

  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const { worktreeId } = body;
  if (typeof worktreeId !== "string" || !WORKTREE_ID.test(worktreeId)) {
    return invalid("worktreeId", "must be a worktree id of letters, digits, '.', '_' and '-', at most 128 characters");
  }
  // The owner comes from the registry record the token authenticated, never from the request.
  const deliveries = await directory.sessionCheckpoint(bridge.ownerId, worktreeId);
  return json(
    {
      worktreeId,
      sessions: deliveries.map(({ sessionId, handle, delivered, threads, overlaps, settled, toolResults, planNotices }) => ({
        sessionId,
        identity: handle,
        delivered,
        threads: threads.map(({ issueId, threadId }) => ({ issueId, threadId })),
        overlaps: overlaps.map(({ featureId, blockedFeatureId }) => ({ feature: featureId, blockedFeature: blockedFeatureId })),
        locksSettled: settledFields(settled),
        toolResults: toolResultFields(toolResults ?? []),
        ...planNoticeFields(planNotices),
      })),
    },
    200,
  );
}

/** Hands a runner bridge the scheduled combined runs, each marked claimed by that bridge. */
async function claimCombinedRuns(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const directory = await handlers.bridges();
  const bridge = token === undefined ? undefined : await directory.authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");
  // The role comes from the registry record the token authenticated, never from the request.
  const listing = await directory.claimCombinedRuns({ bridgeId: bridge.bridgeId, role: bridge.role });
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  const runs = listing.runs.map(({ runId, trigger, target, fork, ownerId, ownerCheckpoint, commandIds }) => ({
    runId,
    trigger,
    target,
    fork,
    ownerId,
    ownerCheckpoint,
    commandIds,
  }));
  return json({ runs }, 200, NO_STORE);
}

/**
 * Opens a Huddle issue from a combined run the runner reports, then forks the Huddle repo when the
 * Huddle has none yet. The fork runs again on a later report of the same trigger until it succeeds;
 * an existing repo counts as forked.
 */
async function reportCombinedRun(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const token = bearerToken(request);
  const directory = await handlers.bridges();
  const bridge = token === undefined ? undefined : await directory.authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (bridge.role !== "runner") {
    return json({ error: "forbidden", message: `bridge ${bridge.bridgeId} does not hold the runner role` }, 403);
  }

  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const trigger = body.trigger;
  const owner =
    typeof trigger === "object" && trigger !== null ? (trigger as Record<string, unknown>).ownerId : undefined;
  if (typeof owner !== "string" || !isValidRepoName(owner)) return invalid("trigger.ownerId", "must be an owner id");

  const huddles = await handlers.huddles();
  let outcome: HuddleOpenOutcome;
  try {
    // The fork the trigger must be in is named from the owner id, never taken from the request.
    outcome = await huddles.open(body, handlers.ownerForkRepo(owner));
  } catch (error) {
    return json({ error: "artifacts", code: artifactsErrorCode(error) ?? null }, 502);
  }
  switch (outcome.status) {
    case "rejected": {
      const status = outcome.reason === "invalid" ? 400 : outcome.reason === "unpublished" ? 422 : 409;
      return json({ error: outcome.reason, message: outcome.message }, status);
    }
    case "no_failures":
      return json({ status: outcome.status, message: outcome.message }, 200);
    case "opened":
    case "existing": {
      let huddle = outcome.huddle;
      if (huddle.huddleRepo === null && huddle.issueId !== null) {
        try {
          const forked = await huddles.forkRepo(huddleRepoId(huddle.issueId));
          huddle = (await huddles.recordRepo(huddle.triggerCommit, forked.name)) ?? huddle;
        } catch (error) {
          // The issue is open; the next report of the trigger forks the repo again.
          return json({ ...huddleBody(outcome.status, huddle), forkError: artifactsErrorCode(error) ?? "failed" }, 502);
        }
      }
      return json(huddleBody(outcome.status, huddle), outcome.status === "opened" ? 201 : 200);
    }
  }
}

/** Authenticates a runner bridge, or answers 401 or 403. */
async function runnerBridge(request: Request, handlers: BridgeHandlers): Promise<BridgeIdentity | Response> {
  const token = bearerToken(request);
  const bridge = token === undefined ? undefined : await (await handlers.bridges()).authenticateBridge(token);
  if (bridge === undefined) return unauthorized();
  if (bridge.role !== "runner") {
    return json({ error: "forbidden", message: `bridge ${bridge.bridgeId} does not hold the runner role` }, 403);
  }
  return bridge;
}

async function listVerifications(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "GET") return methodNotAllowed("GET");
  const runs = await (await handlers.huddles()).pendingVerifications();
  return json({ runs }, 200, NO_STORE);
}

async function reportVerification(request: Request, runId: string, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  let outcome: VerificationOutcome;
  try {
    outcome = await (await handlers.huddles()).reportVerification(runId, bridge.bridgeId, body);
  } catch (error) {
    return json({ error: "artifacts", code: artifactsErrorCode(error) ?? null }, 502);
  }
  switch (outcome.status) {
    case "rejected": {
      const status = outcome.reason === "invalid" ? 400 : outcome.reason === "not_found" ? 404 : 409;
      return json({ error: outcome.reason, message: outcome.message }, status);
    }
    case "superseded":
      return json({ error: "superseded", message: outcome.message }, 409);
    case "existing":
      return json({ status: outcome.status, issueId: outcome.issueId }, 200);
    case "recorded":
      return json({ status: outcome.status, issueId: outcome.issueId, state: outcome.state, commit: outcome.commit }, 200);
  }
}

async function listApprovals(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "GET") return methodNotAllowed("GET");
  const approvals = await (await handlers.huddles()).pendingApprovals();
  return json({ approvals }, 200, NO_STORE);
}

async function reportApproval(request: Request, issueId: string, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const outcome = await (await handlers.huddles()).reportApproval(issueId, bridge.bridgeId, body);
  if (outcome.status === "recorded") {
    return json({ status: outcome.status, issueId: outcome.issueId, state: outcome.state, commit: outcome.commit }, 200);
  }
  const status = outcome.reason === "invalid" ? 400 : outcome.reason === "not_found" ? 404 : 409;
  return json({ error: outcome.reason, message: outcome.message }, status);
}

/** Hands a runner bridge the pending reviews, each marked claimed by that bridge. */
async function claimReviews(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  // The role comes from the registry record the token authenticated, never from the request.
  const listing = await (await handlers.bridges()).claimReviews({ bridgeId: bridge.bridgeId, role: bridge.role });
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  const reviews = listing.reviews.map(({ reviewId, feature, fork, scope, base, forkSha, form }) => ({
    reviewId,
    feature,
    fork,
    scope,
    base,
    forkSha,
    form,
  }));
  return json({ reviews }, 200, NO_STORE);
}

/** A review record body over twice the record cap is refused before it is parsed. */
const MAX_REVIEW_BODY_BYTES = 2 * REVIEW_LIMITS.recordBytes;

const REVIEW_REJECTION_STATUS: Readonly<Record<string, number>> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

async function reportReview(request: Request, reviewId: number, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_REVIEW_BODY_BYTES) {
    return json({ error: "too large", message: `the record is over ${REVIEW_LIMITS.recordBytes} bytes` }, 413);
  }
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const outcome = await (await handlers.bridges()).reportReview({ bridgeId: bridge.bridgeId, role: bridge.role }, reviewId, body);
  if (outcome.status === "rejected") {
    return json({ error: outcome.reason, message: outcome.message }, REVIEW_REJECTION_STATUS[outcome.reason] ?? 409);
  }
  const { review, routedTo } = outcome;
  return json(
    {
      status: outcome.status,
      reviewId: review.id,
      state: review.state,
      sideBySideRef: review.sideBySideRef,
      exceptions: review.exceptions,
      routedTo,
    },
    200,
  );
}

/** Hands a runner bridge the merge-plan facts runs waiting for it. */
async function listPlanFacts(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "GET") return methodNotAllowed("GET");
  // The role comes from the registry record the token authenticated, never from the request.
  const listing = await (await handlers.bridges()).planFactsRuns({ bridgeId: bridge.bridgeId, role: bridge.role });
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  return json({ runs: listing.runs }, 200, NO_STORE);
}

/** Records a runner's facts for a merge plan; a run a newer checkpoint superseded answers 409. */
async function reportPlanFacts(request: Request, runId: string, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const outcome = await (await handlers.bridges()).reportPlanFacts({ bridgeId: bridge.bridgeId, role: bridge.role }, runId, body);
  if (outcome.status === "recorded") return json({ status: outcome.status, runId: outcome.runId }, 200);
  const status = { invalid: 400, not_found: 404, forbidden: 403, superseded: 409 }[outcome.reason];
  return json({ error: outcome.reason, message: outcome.message }, status);
}

/** Hands a runner bridge the waiting `impact`, `check` and `apply_fix` requests, each marked claimed by it. */
async function claimToolRuns(request: Request, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  // The role comes from the registry record the token authenticated, never from the request.
  const listing = await (await handlers.bridges()).claimToolRuns({ bridgeId: bridge.bridgeId, role: bridge.role });
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  const runs = listing.runs.map(({ runId, tool, feature, fork, base, checkpoint, input, charter, forks }) => ({
    runId,
    tool,
    feature,
    fork,
    base,
    checkpoint,
    input,
    charter,
    forks,
  }));
  return json({ runs }, 200, NO_STORE);
}

/** A tool result body over twice the result cap is refused before it is parsed. */
const MAX_TOOL_RESULT_BODY_BYTES = 2 * TOOL_RESULT_LIMITS.resultBytes;

async function reportToolRun(request: Request, runId: number, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_TOOL_RESULT_BODY_BYTES) {
    return json({ error: "too large", message: `the result is over ${TOOL_RESULT_LIMITS.resultBytes} bytes` }, 413);
  }
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const outcome = await (await handlers.bridges()).reportToolRun({ bridgeId: bridge.bridgeId, role: bridge.role }, runId, body);
  if (outcome.status === "rejected") {
    return json({ error: outcome.reason, message: outcome.message }, REVIEW_REJECTION_STATUS[outcome.reason] ?? 409);
  }
  const { run } = outcome;
  return json({ status: outcome.status, runId: run.id, tool: run.tool, result: run.result, summary: run.summary }, 200);
}

async function claimFixWrites(request: Request, options: BridgeOptions, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const ttl = options.fixTokenTtlSeconds;
  if (ttl === undefined) {
    return json({ error: "misconfigured", message: "PENGUIN_FIX_TOKEN_TTL_MINUTES must be a whole number of minutes from 1 to 60" }, 500);
  }
  const listing = await (await handlers.bridges()).claimFixWrites({ bridgeId: bridge.bridgeId, role: bridge.role }, handlers.projectRepos);
  if (listing.status === "forbidden") return json({ error: "forbidden", message: listing.message }, 403);
  const writes = [];
  for (const { spec } of listing.writes) {
    // One token per part, on the affected fork alone; the plaintext goes to this answer only.
    const token = await handlers.mintToken(spec.fork, "write", ttl);
    writes.push({ ...fixWriteFields(spec), token: { token: token.token, remote: token.remote, scope: token.scope, expiresAt: token.expiresAt } });
  }
  return json({ writes }, 200, NO_STORE);
}

async function reportFixWrite(request: Request, writeId: number, handlers: BridgeHandlers): Promise<Response> {
  const bridge = await runnerBridge(request, handlers);
  if (bridge instanceof Response) return bridge;
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readObject(request);
  if (body === undefined) return invalid("", "must be a JSON object");
  const outcome = await (await handlers.bridges()).reportRunnerFixWrite({ bridgeId: bridge.bridgeId, role: bridge.role }, writeId, body, handlers.projectRepos);
  if (outcome.status === "rejected") {
    return json({ error: outcome.reason, message: outcome.message }, REVIEW_REJECTION_STATUS[outcome.reason] ?? 409);
  }
  const { write, durationMs } = outcome;
  return json({ status: "written", writeId, part: write.partId, revision: write.revision, fork: write.targetRepo, commit: write.commitSha, recordId: write.recordId, durationMs }, 200);
}

function huddleBody(status: "opened" | "existing", huddle: Huddle): Record<string, unknown> {
  const { issueId, triggerCommit, baselineSha, huddleRepo, openedAt } = huddle;
  return { status, issueId, triggerCommit, baselineSha, huddleRepo, openedAt };
}

/** Answers a bridge route, or returns null when the path is not one. */
export async function handleBridgeRoute(
  request: Request,
  url: URL,
  options: BridgeOptions,
  handlers: BridgeHandlers,
): Promise<Response | null> {
  if (url.pathname === "/tokens") return issueToken(request, options, handlers);
  if (url.pathname === "/operations/pending") return listPending(request, handlers);
  if (url.pathname === "/checkpoints") return reportCheckpoint(request, handlers);
  if (url.pathname === "/combined-runs") return reportCombinedRun(request, handlers);
  if (url.pathname === "/combined-runs/claim") return claimCombinedRuns(request, handlers);
  if (url.pathname === "/sessions/checkpoint") return sessionCheckpoint(request, handlers);
  if (url.pathname === "/verifications") return listVerifications(request, handlers);
  const runId = /^\/verifications\/([0-9]{1,15})$/.exec(url.pathname)?.[1];
  if (runId !== undefined) return reportVerification(request, runId, handlers);
  if (url.pathname === "/plan-facts") return listPlanFacts(request, handlers);
  const factsRunId = /^\/plan-facts\/([0-9]{1,15})$/.exec(url.pathname)?.[1];
  if (factsRunId !== undefined) return reportPlanFacts(request, factsRunId, handlers);
  if (url.pathname === "/approvals") return listApprovals(request, handlers);
  const approvalIssue = /^\/approvals\/([1-9][0-9]{0,8})$/.exec(url.pathname)?.[1];
  if (approvalIssue !== undefined) return reportApproval(request, approvalIssue, handlers);
  if (url.pathname === "/reviews/claim") return claimReviews(request, handlers);
  const reviewId = /^\/reviews\/([1-9][0-9]{0,14})$/.exec(url.pathname)?.[1];
  if (reviewId !== undefined) return reportReview(request, Number(reviewId), handlers);
  if (url.pathname === "/tool-runs/claim") return claimToolRuns(request, handlers);
  const toolRunId = /^\/tool-runs\/([1-9][0-9]{0,14})$/.exec(url.pathname)?.[1];
  if (toolRunId !== undefined) return reportToolRun(request, Number(toolRunId), handlers);
  if (url.pathname === "/fix-writes/claim") return claimFixWrites(request, options, handlers);
  const fixWriteId = /^\/fix-writes\/([1-9][0-9]{0,14})$/.exec(url.pathname)?.[1];
  if (fixWriteId !== undefined) return reportFixWrite(request, Number(fixWriteId), handlers);
  if (url.pathname === "/bridges/codes") return issueCode(request, options, handlers);
  if (url.pathname === "/bridges") return register(request, handlers);
  const bridgeId = /^\/bridges\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (bridgeId !== undefined) return revoke(request, bridgeId, options, handlers);
  return null;
}
