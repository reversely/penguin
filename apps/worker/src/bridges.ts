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
 *   and the fork, which must be the owner's own.
 * - POST /combined-runs, bridge token of a runner bridge: reports a combined run. When its tests
 *   failed on a published checkpoint, the ProjectAgent opens a Huddle issue and the Worker forks the
 *   Huddle repo. A second report of the same trigger opens nothing.
 * - POST /sessions/checkpoint, bridge token: a safe checkpoint in one of the owner's worktrees, sent
 *   by the bridge's hook before an agent's next tool action or as an explicit bridge checkpoint. The
 *   owner's running sessions in that worktree receive their waiting fix tasks. The body carries only
 *   the worktree id.
 *
 * Responses that carry a code or token are marked `Cache-Control: no-store`.
 */

import type {
  BridgeCaller,
  BridgeIdentity,
  BridgeRole,
  CheckpointOutcome,
  Delivery,
  Huddle,
  HuddleOpenOutcome,
  PendingListing,
  RegisterOutcome,
  RegistrationCode,
} from "@penguin/project-agent";

import { bearerToken, isDeployer } from "./auth.ts";
import { artifactsErrorCode, huddleRepoId, isValidRepoName } from "./repos.ts";
import {
  allowedScope,
  isPermitted,
  parseProjectRepo,
  RepoNotFoundError,
  type MintedToken,
  type TokenScope,
} from "./tokens.ts";

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
  /** Records `sha` as `owner`'s latest checkpoint once the commit is found in `fork`, an Artifacts repo name. */
  reportBridgeCheckpoint(owner: string, sha: string, fork: string): Promise<CheckpointOutcome>;
  /** A safe checkpoint of `owner`'s running sessions in the worktree `worktreeId`. */
  sessionCheckpoint(owner: string, worktreeId: string): Promise<Delivery[]> | Delivery[];
}

/** Opening Huddle issues: the ProjectAgent's side over Durable Object RPC, and the Huddle repo fork. */
export interface HuddleDirectory {
  /** Opens the Huddle issue for a combined run; `triggerFork` is the trigger owner's fork. */
  open(event: unknown, triggerFork: string): Promise<HuddleOpenOutcome>;
  /** Records the Huddle repo forked for the Huddle opened by `triggerCommit`. */
  recordRepo(triggerCommit: string, huddleRepo: string): Promise<Huddle | undefined>;
  /** Forks `huddle-<id>` from the base repo (`forkHuddleRepo` in repos.ts); an existing repo is kept. */
  forkRepo(huddleId: string): Promise<{ readonly name: string }>;
}

/** Mints a token on a repo named without the deployment's prefix, such as `owner-jun`. */
export type TokenMinter = (repo: string, scope: TokenScope, ttlSeconds: number) => Promise<MintedToken>;

export interface BridgeHandlers {
  readonly bridges: () => BridgeDirectory | Promise<BridgeDirectory>;
  readonly mintToken: TokenMinter;
  /** The Artifacts repo name of an owner's fork, with the deployment's repo prefix. */
  readonly ownerForkRepo: (ownerId: string) => string;
  readonly huddles: () => HuddleDirectory | Promise<HuddleDirectory>;
}

export interface BridgeOptions {
  readonly deployerToken?: string;
  /** The parsed PENGUIN_TOKEN_TTL_SECONDS, or undefined when the configured value is invalid. */
  readonly tokenTtlSeconds: number | undefined;
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
    return invalid("repo", "must be base, issues, owner-<id> or huddle-<id>");
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
  const forkRepo = typeof fork === "string" ? CHECKPOINT_FORK.exec(fork)?.[1] : undefined;
  if (forkRepo === undefined) return invalid("fork", "must be owner-<id> or penguin:owner-<id>");
  // The owner comes from the registry record the token authenticated, never from the request.
  const own = `owner-${bridge.ownerId}`;
  if (forkRepo !== own) {
    return json({ error: "forbidden", message: `this bridge reports checkpoints only for ${own}, not ${forkRepo}` }, 403);
  }

  let outcome: CheckpointOutcome;
  try {
    outcome = await directory.reportBridgeCheckpoint(bridge.ownerId, sha, handlers.ownerForkRepo(bridge.ownerId));
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
      sessions: deliveries.map(({ sessionId, handle, delivered }) => ({ sessionId, identity: handle, delivered })),
    },
    200,
  );
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
  if (url.pathname === "/sessions/checkpoint") return sessionCheckpoint(request, handlers);
  if (url.pathname === "/bridges/codes") return issueCode(request, options, handlers);
  if (url.pathname === "/bridges") return register(request, handlers);
  const bridgeId = /^\/bridges\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (bridgeId !== undefined) return revoke(request, bridgeId, options, handlers);
  return null;
}
