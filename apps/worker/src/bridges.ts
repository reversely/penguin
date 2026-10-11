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
 *
 * Responses that carry a code or token are marked `Cache-Control: no-store`.
 */

import type {
  BridgeCaller,
  BridgeIdentity,
  BridgeRole,
  PendingListing,
  RegisterOutcome,
  RegistrationCode,
} from "@penguin/project-agent";

import { bearerToken, isDeployer } from "./auth.ts";
import { artifactsErrorCode, isValidRepoName } from "./repos.ts";
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
}

/** Mints a token on a repo named without the deployment's prefix, such as `owner-jun`. */
export type TokenMinter = (repo: string, scope: TokenScope, ttlSeconds: number) => Promise<MintedToken>;

export interface BridgeHandlers {
  readonly bridges: () => BridgeDirectory | Promise<BridgeDirectory>;
  readonly mintToken: TokenMinter;
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

/** Answers a bridge route, or returns null when the path is not one. */
export async function handleBridgeRoute(
  request: Request,
  url: URL,
  options: BridgeOptions,
  handlers: BridgeHandlers,
): Promise<Response | null> {
  if (url.pathname === "/tokens") return issueToken(request, options, handlers);
  if (url.pathname === "/operations/pending") return listPending(request, handlers);
  if (url.pathname === "/bridges/codes") return issueCode(request, options, handlers);
  if (url.pathname === "/bridges") return register(request, handlers);
  const bridgeId = /^\/bridges\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (bridgeId !== undefined) return revoke(request, bridgeId, options, handlers);
  return null;
}
