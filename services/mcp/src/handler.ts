// Serves the session tools on /mcp through the Agents SDK's stateless createMcpHandler. The gateway
// authenticates the caller's MCP token (K3) first; this module only ever runs for a known owner.

import { createMcpHandler } from "agents/mcp/server";

import { createReviewTaskMcpServer, type McpReviewTask } from "./review-task-tools.ts";
import { createPenguinMcpServer, type McpFeatures, type McpProject, type McpRepos, type McpSettings } from "./tools.ts";

export const MCP_ROUTE = "/mcp";

type MaybePromise<T> = T | Promise<T>;

/**
 * Answers one MCP request as `owner`. A handler is built per request, so the owner is bound in the
 * server factory's closure and never read from the request. `repos` names the project's repos and
 * the owner's own fork, as the Worker derives them from `owner`. `features`, bound to `owner` by the
 * Worker, serves the feature tools. `settings` carries the Worker settings the tools depend on.
 */
export function serveMcp(
  request: Request,
  owner: string,
  project: () => MaybePromise<McpProject>,
  repos: McpRepos,
  features?: McpFeatures,
  settings: McpSettings = {},
): Promise<Response> {
  const handler = createMcpHandler(async () => createPenguinMcpServer(owner, await project(), repos, features, settings), {
    route: MCP_ROUTE,
    // Agents call with a bearer token and send no Origin; a browser page has no business here.
    corsOptions: false,
  });
  return handler.fetch(request);
}

/**
 * Answers one MCP request on a review task's token: only the review tools, bound by the Worker to the
 * task the token names (review-task-tools.ts).
 */
export function serveReviewTaskMcp(request: Request, task: McpReviewTask): Promise<Response> {
  const handler = createMcpHandler(async () => createReviewTaskMcpServer(task), { route: MCP_ROUTE, corsOptions: false });
  return handler.fetch(request);
}
