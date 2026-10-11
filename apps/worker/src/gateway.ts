/**
 * Request routing for the Worker gateway, kept free of the Agents SDK so node:test can run it.
 *
 * Until the authentication tickets add credentials, every route except /health answers 401.
 * The only exception is local development: with PENGUIN_LOCAL_DEV_UNAUTHENTICATED=true set
 * through `wrangler dev --var` AND a loopback hostname, agent routes are reachable. Requiring
 * both keeps a stray variable on a deployed Worker from opening it.
 */

export type AgentRouter = (request: Request) => Promise<Response | null>;

export interface GatewayOptions {
  /** Value of the PENGUIN_LOCAL_DEV_UNAUTHENTICATED variable, if set. */
  localDevUnauthenticated?: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isOpenForLocalDev(url: URL, options: GatewayOptions): boolean {
  return options.localDevUnauthenticated === "true" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

export async function handleRequest(
  request: Request,
  options: GatewayOptions,
  routeAgents: AgentRouter,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return Response.json({ status: "ok" });
  }

  if (!isOpenForLocalDev(url, options)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return (await routeAgents(request)) ?? Response.json({ error: "not found" }, { status: 404 });
}
