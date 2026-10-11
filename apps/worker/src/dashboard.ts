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
 *   - GET /api/board: every issue without its timeline, and each owner's identities and sessions.
 *   - GET /api/inbox: the signed-in person's inbox.
 *   - POST /api/inbox/read: marks one of the signed-in person's inbox items read, named by its
 *     `issueId` and `reason`. Another person's item is never found.
 *   - GET /api/identities: every identity with its charter, sessions and issue history, and the
 *     scopes a charter may name.
 *   - POST /api/identities, /api/identities/<id> and /api/identities/<id>/duplicate: create, edit
 *     and duplicate an identity as the signed-in person. The ProjectAgent refuses an edit or a
 *     duplicate of an identity that person does not own. The body is capped at 256 KiB.
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

/** What marking an inbox item read returns: the ProjectAgent's outcome. */
export type InboxReadOutcome =
  | { readonly status: "ok"; readonly item: unknown }
  | { readonly status: "rejected"; readonly reason: "invalid" | "not_found"; readonly message: string };

/** What creating, editing or duplicating an identity returns (IdentityWriteOutcome in @penguin/protocol). */
export type IdentityWriteOutcome =
  | { readonly status: "ok"; readonly id: string; readonly handle: string }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "handle_taken"; readonly message: string };

/** The ProjectAgent's dashboard surface, reached over Durable Object RPC in the Worker. */
export interface DashboardBackend {
  /** The issue page as plain JSON (IssuePage in @penguin/protocol), or undefined for no such issue. */
  readIssue(issueId: string): Promise<unknown>;
  /** The board as plain JSON (Board in @penguin/protocol). */
  board(): Promise<unknown>;
  /** The person's inbox as plain JSON (Inbox in @penguin/protocol). */
  inbox(owner: string): Promise<unknown>;
  /** Marks one of the person's own inbox items read. */
  markInboxRead(owner: string, issueId: string, reason: string): Promise<InboxReadOutcome>;
  submit(owner: string, operation: unknown): Promise<DashboardWriteOutcome>;
  /** The identities page as plain JSON (IdentitiesPage in @penguin/protocol). */
  identities(): Promise<unknown>;
  /** Creates a personal identity, or a team identity when `input` names `owners`, owned by `owner`. */
  createIdentity(owner: string, input: unknown): Promise<IdentityWriteOutcome>;
  /** Edits an identity; the ProjectAgent refuses unless `owner` owns it. */
  editIdentity(owner: string, id: string, changes: unknown): Promise<IdentityWriteOutcome>;
  /** Duplicates an identity under a new handle; the ProjectAgent refuses unless `owner` owns it. */
  duplicateIdentity(owner: string, id: string, copy: unknown): Promise<IdentityWriteOutcome>;
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
const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

async function markInboxRead(
  request: Request,
  url: URL,
  session: DashboardSession,
  handlers: DashboardHandlers,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  const body = await readJsonObject(request);
  const { issueId, reason } = body ?? {};
  if (typeof issueId !== "string" || !ISSUE_ID.test(issueId) || typeof reason !== "string") {
    return json({ error: "invalid request", message: "send the item's issueId and reason" }, 400);
  }
  const outcome = await (await handlers.dashboard()).markInboxRead(session.owner, issueId, reason);
  const status = outcome.status === "ok" ? 200 : outcome.reason === "not_found" ? 404 : 400;
  return json(outcome, status);
}

/**
 * The largest identity request body: every text field at its cap plus a 64 KiB avatar in base64 fits
 * well under it, and a larger body is refused before it is parsed.
 */
const MAX_IDENTITY_BODY_BYTES = 256 * 1024;

/** An identity request's JSON object with its avatar's base64 decoded to bytes, or a 4xx answer. */
async function readIdentityBody(request: Request): Promise<Record<string, unknown> | Response> {
  const invalid = (message: string, status = 400) => json({ error: "invalid request", message }, status);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_IDENTITY_BODY_BYTES) {
    return invalid("the identity is too large", 413);
  }
  const text = await request.text();
  if (text.length > MAX_IDENTITY_BODY_BYTES) return invalid("the identity is too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalid("the identity must be a JSON object");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid("the identity must be a JSON object");
  const fields = body as Record<string, unknown>;
  const avatar = fields["avatar"];
  if (avatar === undefined || avatar === null) return fields;
  const { mediaType, data } = avatar as { mediaType?: unknown; data?: unknown };
  const bytes = typeof data === "string" ? fromBase64(data) : undefined;
  if (bytes === undefined) return invalid("the avatar must carry its image as base64");
  return { ...fields, avatar: { mediaType, data: bytes } };
}

function fromBase64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function identityAnswer(outcome: IdentityWriteOutcome, created = false): Response {
  if (outcome.status === "ok") return json(outcome, created ? 201 : 200);
  const status = { forbidden: 403, not_found: 404, invalid: 422, handle_taken: 422 }[outcome.reason] ?? 422;
  return json(outcome, status);
}

/**
 * The identity routes. GET /api/identities reads the page; POST /api/identities creates an identity,
 * POST /api/identities/<id> edits one and POST /api/identities/<id>/duplicate copies one. A write
 * acts as the session's person only; the ProjectAgent refuses one on an identity they do not own.
 */
async function identityRoute(
  request: Request,
  url: URL,
  session: DashboardSession,
  handlers: DashboardHandlers,
): Promise<Response | undefined> {
  if (url.pathname === "/api/identities" && request.method === "GET") {
    return json(await (await handlers.dashboard()).identities());
  }
  const match = /^\/api\/identities(?:\/([A-Za-z0-9_-]{1,128})(\/duplicate)?)?$/.exec(url.pathname);
  if (match === null) return undefined;
  if (request.method !== "POST") return methodNotAllowed(match[1] === undefined ? "GET, POST" : "POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  const body = await readIdentityBody(request);
  if (body instanceof Response) return body;
  const backend = await handlers.dashboard();
  const [, id, duplicate] = match;
  if (id === undefined) return identityAnswer(await backend.createIdentity(session.owner, body), true);
  if (duplicate !== undefined) return identityAnswer(await backend.duplicateIdentity(session.owner, id, body), true);
  return identityAnswer(await backend.editIdentity(session.owner, id, body));
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
    return json(await (await handlers.dashboard()).inbox(session.owner));
  }
  if (url.pathname === "/api/inbox/read") return markInboxRead(request, url, session, handlers);
  if (url.pathname === "/api/identities" || url.pathname.startsWith("/api/identities/")) {
    const answer = await identityRoute(request, url, session, handlers);
    if (answer !== undefined) return answer;
  }
  if (url.pathname === "/api/board") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(await (await handlers.dashboard()).board());
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
