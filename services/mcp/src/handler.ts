// Serves the session tools on /mcp through the Agents SDK's stateless createMcpHandler. The gateway
// authenticates the caller's MCP token (K3) first; this module only ever runs for a known owner.

import { createMcpHandler } from "agents/mcp/server";

import { createPenguinMcpServer, type McpProject } from "./tools.ts";

export const MCP_ROUTE = "/mcp";

type MaybePromise<T> = T | Promise<T>;

/**
 * Answers one MCP request as `owner`. A handler is built per request, so the owner is bound in the
 * server factory's closure and never read from the request.
 */
export function serveMcp(request: Request, owner: string, project: () => MaybePromise<McpProject>): Promise<Response> {
  const handler = createMcpHandler(async () => createPenguinMcpServer(owner, await project()), {
    route: MCP_ROUTE,
    // Agents call with a bearer token and send no Origin; a browser page has no business here.
    corsOptions: false,
  });
  return handler.fetch(request);
}
