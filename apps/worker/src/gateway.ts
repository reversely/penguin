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
 *
 * POST /index/rebuild, deployer only, rebuilds the issue index from the issues repo into shadow
 * tables and returns their comparison with the live tables.
 *
 * The bridge routes (/bridges, /bridges/codes, /bridges/<id> and /tokens) carry their own
 * credentials; see bridges.ts.
 */

import type { RebuildReport } from "@penguin/project-agent";

import { isDeployer } from "./auth.ts";
import { handleBridgeRoute, type BridgeHandlers } from "./bridges.ts";
import {
  artifactsErrorCode,
  parseSetupRequest,
  type ProjectSetupReport,
  type ProjectSetupRequest,
} from "./repos.ts";

export type AgentRouter = (request: Request) => Promise<Response | null>;
export type ProjectSetup = (request: ProjectSetupRequest) => Promise<ProjectSetupReport>;
export type IndexRebuild = () => Promise<RebuildReport>;

export interface GatewayHandlers extends BridgeHandlers {
  readonly routeAgents: AgentRouter;
  readonly setUpProject: ProjectSetup;
  readonly rebuildIndex: IndexRebuild;
}

export interface GatewayOptions {
  /** Value of the PENGUIN_LOCAL_DEV_UNAUTHENTICATED variable, if set. */
  localDevUnauthenticated?: string;
  /** Value of the PENGUIN_DEPLOYER_TOKEN secret. When unset, deployer routes reject every caller. */
  deployerToken?: string;
  /** Lifetime of minted Artifacts tokens; undefined when PENGUIN_TOKEN_TTL_SECONDS is invalid. */
  tokenTtlSeconds?: number | undefined;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isOpenForLocalDev(url: URL, options: GatewayOptions): boolean {
  return options.localDevUnauthenticated === "true" && LOOPBACK_HOSTNAMES.has(url.hostname);
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

async function handleRebuild(request: Request, options: GatewayOptions, rebuildIndex: IndexRebuild): Promise<Response> {
  if (!(await isDeployer(request, options.deployerToken))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  try {
    return Response.json(await rebuildIndex());
  } catch (error) {
    // A missing Git object or key fails the whole rebuild; the deployer runs it again. The live
    // index only ever catches up, which a repeat does safely.
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: "rebuild failed", code: artifactsErrorCode(error) ?? null, message },
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

  if (url.pathname === "/index/rebuild") {
    return handleRebuild(request, options, handlers.rebuildIndex);
  }

  const bridgeResponse = await handleBridgeRoute(
    request,
    url,
    { deployerToken: options.deployerToken, tokenTtlSeconds: options.tokenTtlSeconds },
    handlers,
  );
  if (bridgeResponse) return bridgeResponse;

  if (!isOpenForLocalDev(url, options)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const routed = await handlers.routeAgents(request);
  return routed ?? Response.json({ error: "not found" }, { status: 404 });
}
