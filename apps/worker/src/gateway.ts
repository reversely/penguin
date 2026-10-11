/**
 * Request routing for the Worker gateway, kept free of the Agents SDK so node:test can run it.
 *
 * Until the authentication tickets add credentials, every route except /health and /setup answers
 * 401. The only exception is local development: with PENGUIN_LOCAL_DEV_UNAUTHENTICATED=true set
 * through `wrangler dev --var` AND a loopback hostname, agent routes are reachable. Requiring
 * both keeps a stray variable on a deployed Worker from opening it.
 *
 * POST /setup is the deployer's project setup. It always requires the deployer credential, the
 * PENGUIN_DEPLOYER_TOKEN secret sent as a Bearer token, local development included.
 */

import {
  artifactsErrorCode,
  parseSetupRequest,
  type ProjectSetupReport,
  type ProjectSetupRequest,
} from "./repos.ts";

export type AgentRouter = (request: Request) => Promise<Response | null>;
export type ProjectSetup = (request: ProjectSetupRequest) => Promise<ProjectSetupReport>;

export interface GatewayHandlers {
  readonly routeAgents: AgentRouter;
  readonly setUpProject: ProjectSetup;
}

export interface GatewayOptions {
  /** Value of the PENGUIN_LOCAL_DEV_UNAUTHENTICATED variable, if set. */
  localDevUnauthenticated?: string;
  /** Value of the PENGUIN_DEPLOYER_TOKEN secret. When unset, /setup rejects every caller. */
  deployerToken?: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isOpenForLocalDev(url: URL, options: GatewayOptions): boolean {
  return options.localDevUnauthenticated === "true" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Compares the request's Bearer token with the deployer token. Both sides are hashed first, so the
 * comparison takes the same time whatever the token lengths and contents.
 */
async function isDeployer(request: Request, deployerToken: string | undefined): Promise<boolean> {
  if (!deployerToken) return false;
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const [given, expected] = await Promise.all([sha256(match[1] ?? ""), sha256(deployerToken)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (given[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

async function handleSetup(
  request: Request,
  options: GatewayOptions,
  setUpProject: ProjectSetup,
): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid request", issues: [{ field: "", message: "must be JSON" }] },
      { status: 400 },
    );
  }
  const parsed = parseSetupRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", issues: parsed.issues }, { status: 400 });
  }

  try {
    return Response.json(await setUpProject(parsed.request));
  } catch (error) {
    // Setup is idempotent: the caller can run it again to resume after a failed Artifacts call.
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: "artifacts", code: artifactsErrorCode(error) ?? null, message },
      { status: 502 },
    );
  }
}

export async function handleRequest(
  request: Request,
  options: GatewayOptions,
  handlers: GatewayHandlers,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return Response.json({ status: "ok" });
  }

  if (url.pathname === "/setup") {
    return handleSetup(request, options, handlers.setUpProject);
  }

  if (!isOpenForLocalDev(url, options)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const routed = await handlers.routeAgents(request);
  return routed ?? Response.json({ error: "not found" }, { status: 404 });
}
