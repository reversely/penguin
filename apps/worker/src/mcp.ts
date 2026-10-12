/**
 * The MCP endpoint for agent sessions and the issuing of the MCP tokens (K3) it accepts.
 *
 * - POST /mcp/tokens, deployer only: issues an MCP token for one owner and returns it, once. The
 *   deployer hands it to the owner, who puts it in each agent's MCP config. Issuing waits on the
 *   deployer until dashboard sign-in (open decision 7, ticket #28) can show the token to the owner.
 * - DELETE /mcp/tokens/<id>, deployer only: revokes a token.
 * - /mcp, MCP token: the session tools, acting as the token's owner.
 * - /mcp, task token: the review tools alone, for the one review task the token was issued to when the
 *   owner's bridge claimed it (#138). The token expires with the task's claim.
 *
 * Responses that carry a token are marked `Cache-Control: no-store`.
 */

import type { IssuedMcpToken, McpCaller } from "@penguin/project-agent";

import { bearerToken, isDeployer } from "./auth.ts";
import { isValidRepoName } from "./repos.ts";

/** The ProjectAgent's MCP tokens, reached over Durable Object RPC in the Worker. */
export interface McpTokenDirectory {
  issueMcpToken(ownerId: string): Promise<IssuedMcpToken>;
  authenticateMcpToken(token: string): Promise<McpCaller | undefined>;
  revokeMcpToken(tokenId: string): Promise<boolean> | boolean;
}

/** Answers one /mcp request as `owner`, the person whose token the gateway accepted. */
export type McpServe = (request: Request, owner: string) => Promise<Response>;

/** Answers one /mcp request on the task token of `owner`'s review task `taskId`. */
export type McpTaskServe = (request: Request, owner: string, taskId: number) => Promise<Response>;

export interface McpHandlers {
  readonly mcpTokens: () => McpTokenDirectory | Promise<McpTokenDirectory>;
  readonly serveMcp: McpServe;
  /** Absent, a task token is refused. */
  readonly serveReviewTaskMcp?: McpTaskServe;
}

export interface McpOptions {
  readonly deployerToken?: string;
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers });
}

const unauthorized = () => json({ error: "unauthorized" }, 401);

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

async function issueToken(request: Request, options: McpOptions, handlers: McpHandlers): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) return unauthorized();
  if (request.method !== "POST") return methodNotAllowed("POST");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const owner = typeof body === "object" && body !== null ? (body as { owner?: unknown }).owner : undefined;
  if (typeof owner !== "string" || !isValidRepoName(owner)) {
    return json(
      { error: "invalid request", issues: [{ field: "owner", message: "must be an owner id that starts with a letter or digit" }] },
      400,
    );
  }
  const issued = await (await handlers.mcpTokens()).issueMcpToken(owner);
  return json({ tokenId: issued.tokenId, owner: issued.ownerId, token: issued.token, issuedAt: issued.issuedAt }, 201, NO_STORE);
}

async function revokeToken(
  request: Request,
  tokenId: string,
  options: McpOptions,
  handlers: McpHandlers,
): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) return unauthorized();
  if (request.method !== "DELETE") return methodNotAllowed("DELETE");
  const revoked = await (await handlers.mcpTokens()).revokeMcpToken(tokenId);
  return revoked ? new Response(null, { status: 204 }) : json({ error: "not found" }, 404);
}

async function serve(request: Request, handlers: McpHandlers): Promise<Response> {
  const token = bearerToken(request);
  const caller = token === undefined ? undefined : await (await handlers.mcpTokens()).authenticateMcpToken(token);
  if (caller === undefined) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="penguin"' });
  }
  if (caller.task !== undefined) {
    if (handlers.serveReviewTaskMcp === undefined) return json({ error: "forbidden", message: "review task tokens are not served here" }, 403);
    return handlers.serveReviewTaskMcp(request, caller.ownerId, caller.task.taskId);
  }
  return handlers.serveMcp(request, caller.ownerId);
}

/** Answers an MCP route, or returns null when the path is not one. */
export async function handleMcpRoute(
  request: Request,
  url: URL,
  options: McpOptions,
  handlers: McpHandlers,
): Promise<Response | null> {
  if (url.pathname === "/mcp") return serve(request, handlers);
  if (url.pathname === "/mcp/tokens") return issueToken(request, options, handlers);
  const tokenId = /^\/mcp\/tokens\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (tokenId !== undefined) return revokeToken(request, tokenId, options, handlers);
  return null;
}
