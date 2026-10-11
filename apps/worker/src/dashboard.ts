/**
 * The dashboard's routes: the built React app, GitHub sign-in (K6), the dashboard API and the live
 * connection to the ProjectAgent.
 *
 * - GET /, /board, /inbox, /identities and /issues/<id>: the app's page; GET /app.js and /app.css:
 *   its bundle. These carry no data, so they need no session: an unauthenticated visit shows sign-in.
 * - GET /auth/github: starts GitHub sign-in. GET /auth/github/callback: finishes it and sets the
 *   session cookie. POST /auth/signout: clears it.
 * - /api/*: every route checks the session first and answers 401 without one.
 *   - GET /api/session: the signed-in person.
 *   - GET /api/issues/<id>: the issue page: one issue, its sub-issues and its timeline.
 *   - GET /api/inbox: the signed-in person's inbox.
 *   - POST /api/operations: one issue operation, applied with the signed-in person as author. An
 *     operation that carries `author` is refused: only the session names the author.
 *   - GET /api/live: the WebSocket to the ProjectAgent, which sends a message on each index change.
 *
 * Every response here sends a Content Security Policy that allows scripts and styles from the
 * Worker's own origin only, so no inline script runs. POST routes also require a same-origin
 * `Origin` header, on top of the SameSite=Lax session cookie.
 */

import {
  authorizeUrl,
  endpointsAt,
  GITHUB_ENDPOINTS,
  randomToken,
  signedInLogin,
  type Fetch,
} from "./github-oauth.ts";
import {
  clearCookie,
  encodeSession,
  readCookie,
  requestSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionKey,
  setCookie,
  type DashboardSession,
} from "./session.ts";

/** What a dashboard write returns: the ProjectAgent's submit outcome. */
export type DashboardWriteOutcome =
  | { readonly status: "applied"; readonly opId: string; readonly issueId: string; readonly version: number }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

/** The ProjectAgent's dashboard surface, reached over Durable Object RPC in the Worker. */
export interface DashboardBackend {
  /** The issue page as plain JSON (IssuePage in @penguin/protocol), or undefined for no such issue. */
  readIssue(issueId: string): Promise<unknown>;
  inbox(owner: string): Promise<unknown>;
  submit(owner: string, operation: unknown): Promise<DashboardWriteOutcome>;
  /** Forwards the WebSocket upgrade to the ProjectAgent with `owner` as the connection's person. */
  connectLive(request: Request, owner: string): Promise<Response>;
}

export interface DashboardHandlers {
  /** Serves a file of the built dashboard (the Workers static assets binding). */
  readonly serveAsset: (request: Request) => Promise<Response>;
  readonly dashboard: () => DashboardBackend | Promise<DashboardBackend>;
}

export interface DashboardOptions {
  /** GITHUB_OAUTH_CLIENT_ID (K8). */
  readonly githubClientId?: string | undefined;
  /** GITHUB_OAUTH_CLIENT_SECRET (K8); also the root of the session signing key. */
  readonly githubClientSecret?: string | undefined;
  /** GitHub login (lowercase) to Penguin owner id, from PENGUIN_DASHBOARD_OWNERS. */
  readonly owners: ReadonlyMap<string, string>;
  /**
   * PENGUIN_GITHUB_BASE_URL: a local GitHub test double serving the three OAuth endpoints. It is
   * honoured only on a loopback hostname, so a stray value on a deployed Worker changes nothing.
   */
  readonly githubBaseUrl?: string | undefined;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const OAUTH_COOKIE = "__Host-penguin_oauth";
const OAUTH_TTL_SECONDS = 600;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PAGE_PATH = /^\/(?:|board|inbox|identities|issues\/[A-Za-z0-9_-]+)$/;
const ASSET_PATH = /^\/app\.(?:js|css)$/;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

function isSameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

let cachedKey: { readonly secret: string; readonly key: Promise<CryptoKey> } | undefined;

function signingKey(secret: string | undefined): Promise<CryptoKey> | undefined {
  if (!secret) return undefined;
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: sessionKey(secret) };
  return cachedKey.key;
}

function endpointsFor(url: URL, options: DashboardOptions) {
  return options.githubBaseUrl && LOOPBACK_HOSTNAMES.has(url.hostname)
    ? endpointsAt(options.githubBaseUrl)
    : GITHUB_ENDPOINTS;
}

const callbackUrl = (url: URL): string => `${url.origin}/auth/github/callback`;

async function startSignIn(request: Request, url: URL, options: DashboardOptions): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!options.githubClientId || !options.githubClientSecret) {
    return json({ error: "sign-in is not configured" }, 503);
  }
  const state = randomToken();
  const verifier = randomToken();
  const hint = url.searchParams.get("login") ?? undefined;
  const location = await authorizeUrl(
    endpointsFor(url, options),
    options.githubClientId,
    callbackUrl(url),
    state,
    verifier,
    hint !== undefined && GITHUB_LOGIN.test(hint) ? hint : undefined,
  );
  return redirect(location, [setCookie(OAUTH_COOKIE, `${state}.${verifier}`, OAUTH_TTL_SECONDS)]);
}

async function finishSignIn(request: Request, url: URL, options: DashboardOptions): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const failed = (reason: string) => redirect(`/?signin=${reason}`, [clearCookie(OAUTH_COOKIE)]);
  const key = signingKey(options.githubClientSecret);
  if (!options.githubClientId || !options.githubClientSecret || key === undefined) return failed("failed");

  const [expectedState, verifier] = (readCookie(request, OAUTH_COOKIE) ?? "").split(".");
  const code = url.searchParams.get("code");
  if (!expectedState || !verifier || !code || url.searchParams.get("state") !== expectedState) return failed("failed");

  const login = await signedInLogin(
    options.fetch ?? fetch,
    endpointsFor(url, options),
    { clientId: options.githubClientId, clientSecret: options.githubClientSecret },
    code,
    callbackUrl(url),
    verifier,
  );
  if (login === undefined) return failed("failed");
  const owner = options.owners.get(login.toLowerCase());
  if (owner === undefined) return failed("no-owner");

  const now = (options.now ?? Date.now)();
  const session: DashboardSession = { owner, login, expiresAt: now + SESSION_TTL_SECONDS * 1000 };
  return redirect("/", [
    clearCookie(OAUTH_COOKIE),
    setCookie(SESSION_COOKIE, await encodeSession(await key, session), SESSION_TTL_SECONDS),
  ]);
}

function signOut(request: Request, url: URL): Response {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  return redirect("/", [clearCookie(SESSION_COOKIE)]);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeOperation(
  request: Request,
  url: URL,
  session: DashboardSession,
  handlers: DashboardHandlers,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  const operation = await readJsonObject(request);
  if (operation === undefined) return json({ error: "invalid request", message: "the operation must be a JSON object" }, 400);
  if ("author" in operation) {
    return json({ error: "invalid request", message: "Penguin sets author from your session" }, 400);
  }
  const outcome = await (await handlers.dashboard()).submit(session.owner, operation);
  return json(outcome, outcome.status === "applied" ? 201 : 422);
}

async function handleApi(
  request: Request,
  url: URL,
  options: DashboardOptions,
  handlers: DashboardHandlers,
): Promise<Response> {
  const session = await requestSession(request, await signingKey(options.githubClientSecret), (options.now ?? Date.now)());
  if (session === undefined) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/api/session") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ owner: session.owner, login: session.login, expiresAt: new Date(session.expiresAt).toISOString() });
  }
  if (url.pathname === "/api/operations") return writeOperation(request, url, session, handlers);
  if (url.pathname === "/api/inbox") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ items: await (await handlers.dashboard()).inbox(session.owner) });
  }
  if (url.pathname === "/api/live") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected a WebSocket upgrade" }, 426);
    }
    return (await handlers.dashboard()).connectLive(request, session.owner);
  }
  const issueId = /^\/api\/issues\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (issueId !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const page = await (await handlers.dashboard()).readIssue(issueId);
    return page === undefined ? json({ error: "not found" }, 404) : json(page);
  }
  return json({ error: "not found" }, 404);
}

async function servePage(request: Request, url: URL, handlers: DashboardHandlers): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  // Every page is the same index.html; the app routes on the path.
  const asset = PAGE_PATH.test(url.pathname) ? new Request(new URL("/", url), { method: request.method }) : request;
  const response = await handlers.serveAsset(asset);
  if (!PAGE_PATH.test(url.pathname)) return response;
  const page = new Response(response.body, response);
  page.headers.set("Cache-Control", "no-cache");
  return page;
}

/** Answers a dashboard route, or returns null when the path is not one. */
export async function handleDashboardRoute(
  request: Request,
  url: URL,
  options: DashboardOptions,
  handlers: DashboardHandlers,
): Promise<Response | null> {
  const { pathname } = url;
  let response: Response;
  if (pathname === "/auth/github") response = await startSignIn(request, url, options);
  else if (pathname === "/auth/github/callback") response = await finishSignIn(request, url, options);
  else if (pathname === "/auth/signout") response = signOut(request, url);
  else if (pathname === "/api" || pathname.startsWith("/api/")) response = await handleApi(request, url, options, handlers);
  else if (PAGE_PATH.test(pathname) || ASSET_PATH.test(pathname)) response = await servePage(request, url, handlers);
  else return null;
  // A WebSocket upgrade response carries the socket and must pass through unchanged.
  return response.status === 101 ? response : secured(response);
}
