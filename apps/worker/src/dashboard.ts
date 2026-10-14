/**
 * The dashboard's routes: the built React app, GitHub sign-in (K6), the dashboard API and the live
 * connection to the ProjectAgent.
 *
 * - GET /, /inbox, /identities, /review-policy, /features/<id> and /issues/<id>: the app's page, with the team view at /. GET /board
 *   redirects to /, which replaced the board. GET /app.js and /app.css: its bundle; GET /fonts/<name>.woff2: the self-hosted Inter and Piazzolla files;
 *   GET /fonts/<name>.txt: their OFL texts. These carry no data, so they need no session: an
 *   unauthenticated visit shows sign-in.
 * - GET /auth/github: starts GitHub sign-in. GET /auth/github/callback: finishes it and sets the
 *   session cookie. POST /auth/signout: clears it.
 * - /api/*: every route checks the session first and answers 401 without one.
 *   - GET /api/session: the signed-in person.
 *   - GET /api/issues/<id>: the issue page: one issue, its sub-issues and its timeline.
 *   - GET /api/board: every issue without its timeline, each owner's identities and sessions, and
 *     the inbox items that ask each person to act.
 *   - GET /api/inbox: the signed-in person's inbox, checked against INBOX_SCHEMA; an inbox that
 *     breaks it answers 500 and is never sent.
 *   - POST /api/inbox/read: marks one of the signed-in person's inbox items read, named by its
 *     `issueId` and `reason`. Another person's item is never found.
 *   - GET /api/identities: every identity with its charter, sessions and issue history, and the
 *     scopes a charter may name.
 *   - POST /api/identities, /api/identities/<id> and /api/identities/<id>/duplicate: create, edit
 *     and duplicate an identity as the signed-in person. The ProjectAgent refuses an edit or a
 *     duplicate of an identity that person does not own. The body is capped at 256 KiB.
 *   - GET /api/features: every feature with its fork, state and declared area.
 *   - POST /api/features: opens a feature, `{ feature, area }`, as the signed-in person: Penguin
 *     forks main into `feature-<id>`. Opening an id already open answers 200 `existing` and forks
 *     nothing. No token is returned: write tokens go to the feature's agent sessions only.
 *   - POST /api/features/<id>/area: replaces the declared area, `{ area }`, of one of the signed-in
 *     person's features.
 *   - GET /api/team: every person with their role in the scope map, their features with each one's
 *     one-word state and agents, and their idle agents (TeamView in @penguin/protocol).
 *   - GET /api/people/<id>/scopes: one person's role with every list in full, each scope with its
 *     call sites, whether the code shows it and whether `depends_on` declares it (PersonScopes in
 *     @penguin/protocol). It carries scope names and counts, no code.
 *   - GET /api/features/<id>/page: the feature page as the signed-in person may see it (FeaturePage in
 *     @penguin/protocol): a part's changed lines only for the feature's person, the part's owner and
 *     that owner's delegate; 404 for no such feature.
 *   - GET /api/features/<id>/records/<record id>: one signed record of the feature as the record repo
 *     holds it, read at the commit that added it, as JSON; 404 for no such record or one not in the
 *     repo yet. Any signed-in person may read it, as the feature page lists every record.
 *   - GET /api/reviews/<id>/differences: every differing input of a review's side-by-side run, with
 *     each side's outcome and no arguments (ReviewDifferences in @penguin/protocol), checked against
 *     REVIEW_DIFFERENCES_SCHEMA; 404 for no such review or one without a run. Any signed-in person
 *     may read it, as the feature page shows every review.
 *   - GET /api/features/<id>/plan: the feature's newest merge plan with its facts and parts, as
 *     JSON (ViewerPlan in @penguin/protocol); 404 when it has none. A part's patch and changed lines
 *     (`diff.patch`, `diff.files`) follow the feature page's rule; for anyone else both are null.
 *     Commit subjects, docstrings, assertion lines and diff lines are plain strings in it, never
 *     markup.
 *   - GET /api/overlaps: the overlapping starts that wait for the signed-in person's approval,
 *     checked against OVERLAP_REQUESTS_SCHEMA; an answer that breaks it answers 500.
 *   - POST /api/overlaps/approve: approves one of them, `{ feature, blockedFeature }`, as the
 *     signed-in person. `feature` is `owner:<person>` for an expand checkpoint that adds to the
 *     person's scopes. The approver is the session's person: a body with any other field, such as
 *     `approved_by`, is refused. The ProjectAgent refuses a lock on another person's feature and a
 *     second approval of the same lock.
 *   - GET /api/plan-parts: the merge plan parts waiting on the signed-in person as owner or
 *     delegate, the parts Penguin approved for them, the parts that write a path they protect, the
 *     features whose own change writes one, the parts of their plans past the round limit and the
 *     reviews of their scopes that raised an
 *     exception, checked against PLAN_INBOX_SCHEMA; an answer that breaks it answers 500.
 *   - POST /api/plan-parts/approve: approves one revision of a part, `{ feature, part, revision }`,
 *     as the signed-in person. POST /api/plan-parts/reverse reverses Penguin's approval of it, with
 *     the same fields, until its block reaches main. POST /api/plan-parts/request-change asks for a change to
 *     it, `{ feature, part, revision, text }`. The decider is the session's person: a body with any other
 *     field is refused. The ProjectAgent refuses anyone but the part's owner or their delegate, a
 *     part outside the feature's newest plan, a stale revision and a part already decided.
 *   - POST /api/plan-parts/confirm-protected: confirms the lines a feature's own change writes under
 *     paths a person protects, `{ feature, owner, checkpoint }`, as the signed-in person. The
 *     ProjectAgent refuses anyone but `owner` or their delegate, a checkpoint other than the
 *     feature's latest and lines already confirmed.
 *   - POST /api/plan-parts/decide-caller: decides one caller item sent to the worktree owner,
 *     `{ item, verdict, text }` with `verdict` approve or request_changes, as the signed-in person.
 *     The ProjectAgent refuses anyone but the receiving feature's person or their delegate and an item
 *     that does not wait on the worktree owner.
 *   - GET /api/review-policy: the sandbox's review policy (docs/review-policies.md): its preset and
 *     rows, whether admin mode locks it, who changed it last, whether the signed-in person may change
 *     it and the split of approvals over the last 30 days, checked against REVIEW_POLICY_VIEW_SCHEMA.
 *   - POST /api/review-policy: sets it, `{ preset, rows }`, as the signed-in person. A body with any
 *     other field is refused. The ProjectAgent refuses anyone who leads no team in penguin/teams.json
 *     and every change while PENGUIN_PLAN_ADMIN_MODE is on.
 *   - POST /api/operations: one issue operation, applied with the signed-in person as author. An
 *     operation that carries `author` is refused: only the session names the author.
 *   - GET /api/live: the WebSocket to the ProjectAgent, which sends a message on each index change
 *     and each change to a feature, its plan, a part's decision or a review.
 *
 * Every response here sends a Content Security Policy that allows scripts, styles and fonts from the
 * Worker's own origin only, so no inline script runs and no third-party origin receives a request. POST routes also require a same-origin
 * `Origin` header, on top of the SameSite=Lax session cookie.
 */

import {
  checkInbox,
  checkOverlapRequests,
  checkPlanInbox,
  checkReviewDifferences,
  checkReviewPolicyView,
  isOwnerLockId,
  SEGMENT_PATTERN,
} from "@penguin/protocol";

import type { FeatureOpenResult, FeatureView } from "./features.ts";
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
  /** Every feature, newest first. */
  features(): Promise<readonly FeatureView[]>;
  /** Opens a feature as `owner` and forks main for it (features.ts); a person gets no token. */
  openFeature(owner: string, input: { readonly feature: unknown; readonly area?: unknown }): Promise<FeatureOpenResult>;
  /** Replaces the declared area of one of `owner`'s features. */
  declareFeatureArea(owner: string, featureId: string, area: unknown): Promise<FeatureAreaResult>;
  /** The feature's newest merge plan as `owner` may see it, as plain JSON (ViewerPlan in @penguin/protocol), or undefined. */
  featurePlan(owner: string, featureId: string): Promise<unknown>;
  /** The team view for `owner` as plain JSON (TeamView in @penguin/protocol). */
  team(owner: string): Promise<unknown>;
  /** One person's full role with every list in full (PersonScopes in @penguin/protocol). */
  personScopes(person: string): Promise<unknown>;
  /** The feature page as `owner` may see it (FeaturePage in @penguin/protocol), or undefined. */
  featurePage(owner: string, featureId: string): Promise<unknown>;
  /** One signed record's file as the record repo holds it, or undefined while it is not there. */
  featureRecord(featureId: string, recordId: string): Promise<string | undefined>;
  /** Every differing input of a review's side-by-side run (ReviewDifferences in @penguin/protocol), or undefined. */
  reviewDifferences(reviewId: number): Promise<unknown>;
  /** The overlapping starts waiting for `owner` as plain JSON (OverlapRequests in @penguin/protocol). */
  overlapRequests(owner: string): Promise<unknown>;
  /** Approves the start of `blockedFeatureId` beside `featureId` as `owner`; the ProjectAgent checks ownership. */
  approveOverlap(owner: string, featureId: string, blockedFeatureId: string): Promise<OverlapApproveResult>;
  /** The plan parts and review exceptions for `owner` as plain JSON (PlanInbox in @penguin/protocol). */
  planParts(owner: string): Promise<unknown>;
  /** Decides one revision of a plan part as `owner`; the ProjectAgent checks who may. */
  decidePlanPart(owner: string, decision: PlanPartDecision): Promise<PlanPartDecisionResult>;
  /** Confirms a feature's own protected lines as `owner`; the ProjectAgent checks who may. */
  confirmProtectedChange(owner: string, input: ProtectedChangeConfirmation): Promise<ProtectedChangeConfirmResult>;
  /** Decides one caller item sent to the worktree owner, as `owner`; the ProjectAgent checks who may. */
  decideCallerItem(owner: string, input: CallerItemDecision): Promise<CallerItemDecisionResult>;
  /** The sandbox's review policy as `owner` sees it (ReviewPolicyView in @penguin/protocol). */
  reviewPolicy(owner: string): Promise<unknown>;
  /** Sets the review policy as `owner`; the ProjectAgent checks that they lead a team. */
  changeReviewPolicy(owner: string, policy: { readonly preset: unknown; readonly rows: unknown }): Promise<ReviewPolicyChangeResult>;
}

export type ReviewPolicyChangeResult =
  | { readonly status: "ok"; readonly policy: unknown; readonly recordId: string }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

/**
 * A confirmation of the lines a feature's own change writes under paths `owner` protects, at the
 * checkpoint the person saw, as the dashboard posts it.
 */
export interface ProtectedChangeConfirmation {
  readonly feature: string;
  readonly owner: string;
  readonly checkpoint: string;
}

/** The worktree owner's decision on one caller item, as the dashboard posts it. */
export interface CallerItemDecision {
  readonly item: string;
  readonly verdict: "approve" | "request_changes";
  readonly text: string;
}

export type CallerItemDecisionResult =
  | { readonly status: "ok"; readonly item: unknown; readonly recordIds: readonly string[] }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

export type ProtectedChangeConfirmResult =
  | { readonly status: "ok"; readonly recordId: string }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

/** A person's decision on one revision of a plan part, as the dashboard posts it. */
export type PlanPartDecision =
  | { readonly kind: "approve" | "reverse"; readonly feature: string; readonly part: string; readonly revision: number }
  | { readonly kind: "request_change"; readonly feature: string; readonly part: string; readonly revision: number; readonly text: string };

export type PlanPartDecisionResult =
  | { readonly status: "ok"; readonly part: unknown; readonly recordId: string }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

export type OverlapApproveResult =
  | { readonly status: "ok"; readonly lock: unknown }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

export type FeatureAreaResult =
  | { readonly status: "ok"; readonly feature: FeatureView }
  | { readonly status: "rejected"; readonly reason: string; readonly message: string };

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
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const OAUTH_COOKIE = "__Host-penguin_oauth";
const OAUTH_TTL_SECONDS = 600;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PAGE_PATH = /^\/(?:|org|review-policy|inbox|identities|teams\/(?:person:)?[a-z0-9-]{1,64}|people\/[a-z0-9-]{1,64}|issues\/[A-Za-z0-9_-]+|features\/[a-z0-9.-]{1,63})$/;
const ASSET_PATH = /^\/(?:app\.(?:js|css)|fonts\/[a-z0-9-]+\.(?:woff2|txt))$/;
const FONT_PATH = /^\/fonts\/[a-z0-9-]+\.woff2$/;
/**
 * Each font file's name carries its upstream version (inter-v20-latin.woff2), so a changed font gets
 * a new URL and a browser keeps each file for a year without asking again.
 */
const FONT_CACHE_CONTROL = "public, max-age=31536000, immutable";
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

const FEATURE_REJECTION_STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  offline: 409,
  round_limit: 409,
  misconfigured: 500,
};

/**
 * The feature routes. GET /api/features lists every feature; POST /api/features opens one as the
 * session's person, forking main for it; POST /api/features/<id>/area replaces the declared area of
 * one of that person's features. The body is capped like an identity's.
 */
async function featureRoute(
  request: Request,
  url: URL,
  session: DashboardSession,
  handlers: DashboardHandlers,
): Promise<Response | undefined> {
  const page = /^\/api\/features\/([a-z0-9.-]{1,63})\/page$/.exec(url.pathname)?.[1];
  if (page !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const found = await (await handlers.dashboard()).featurePage(session.owner, page);
    return found === undefined ? json({ error: "not found", message: `no feature ${page}` }, 404) : json(found);
  }
  const record = /^\/api\/features\/([a-z0-9.-]{1,63})\/records\/([a-z0-9.-]{1,96})$/.exec(url.pathname);
  if (record !== null) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const [, featureId, recordId] = record as unknown as [string, string, string];
    const file = await (await handlers.dashboard()).featureRecord(featureId, recordId);
    if (file === undefined) return json({ error: "not found", message: `record ${recordId} is not in the record repo yet` }, 404);
    return new Response(file, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const plan = /^\/api\/features\/([a-z0-9.-]{1,63})\/plan$/.exec(url.pathname)?.[1];
  if (plan !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const found = await (await handlers.dashboard()).featurePlan(session.owner, plan);
    return found === undefined ? json({ error: "not found", message: `feature ${plan} has no merge plan` }, 404) : json(found);
  }
  const match = /^\/api\/features(?:\/([a-z0-9.-]{1,63})\/area)?$/.exec(url.pathname);
  if (match === null) return undefined;
  const [, featureId] = match;
  if (featureId === undefined && request.method === "GET") return json(await (await handlers.dashboard()).features());
  if (request.method !== "POST") return methodNotAllowed(featureId === undefined ? "GET, POST" : "POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_IDENTITY_BODY_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const backend = await handlers.dashboard();
  if (featureId !== undefined) {
    const declared = await backend.declareFeatureArea(session.owner, featureId, body["area"]);
    return json(declared, declared.status === "ok" ? 200 : (FEATURE_REJECTION_STATUS[declared.reason] ?? 422));
  }
  let opened: FeatureOpenResult;
  try {
    opened = await backend.openFeature(session.owner, { feature: body["feature"], area: body["area"] });
  } catch {
    // The feature stays recorded; opening it again resumes the fork.
    return json({ error: "artifacts", message: "Artifacts did not make the fork; open the feature again" }, 502);
  }
  switch (opened.status) {
    case "opened":
    case "existing":
      return json({ status: opened.status, feature: opened.feature, timings: opened.timings }, opened.status === "opened" ? 201 : 200);
    case "misconfigured":
      return json({ error: "misconfigured", message: opened.message }, 500);
    case "rejected":
      return json(opened, FEATURE_REJECTION_STATUS[opened.reason] ?? 422);
  }
}

const FEATURE_ID = new RegExp(`^${SEGMENT_PATTERN}$`, "u");
const FEATURE_ID_MAX_LENGTH = 63;
const isFeatureId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= FEATURE_ID_MAX_LENGTH && FEATURE_ID.test(value);

/**
 * The overlap routes. GET /api/overlaps lists the starts waiting for the session's person;
 * POST /api/overlaps/approve approves one as that person. The approver comes from the session only.
 */
async function overlapRoute(request: Request, url: URL, session: DashboardSession, handlers: DashboardHandlers): Promise<Response> {
  if (url.pathname === "/api/overlaps") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const requests = await (await handlers.dashboard()).overlapRequests(session.owner);
    return checkOverlapRequests(requests).length === 0 ? json(requests) : json({ error: "invalid overlaps" }, 500);
  }
  if (url.pathname !== "/api/overlaps/approve") return json({ error: "not found" }, 404);
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_IDENTITY_BODY_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const { feature, blockedFeature, ...rest } = body;
  if (Object.keys(rest).length > 0) {
    return json({ error: "invalid", message: "the body takes only feature and blockedFeature; the approver is the signed-in person" }, 400);
  }
  if (!(isFeatureId(feature) || isOwnerLockId(feature)) || !isFeatureId(blockedFeature)) {
    return json({ error: "invalid", message: "feature must be a feature id or owner:<person>, and blockedFeature a feature id" }, 400);
  }
  const approved = await (await handlers.dashboard()).approveOverlap(session.owner, feature, blockedFeature);
  return json(approved, approved.status === "ok" ? 200 : (FEATURE_REJECTION_STATUS[approved.reason] ?? 422));
}

/** The longest change request the route reads; the ProjectAgent applies the exact limit. */
const MAX_PLAN_DECISION_BYTES = 16 * 1024;

/** The decision each plan part route posts. */
const PLAN_DECISION_ROUTES: Readonly<Record<string, PlanPartDecision["kind"]>> = {
  "/api/plan-parts/approve": "approve",
  "/api/plan-parts/reverse": "reverse",
  "/api/plan-parts/request-change": "request_change",
};

/**
 * The plan part routes. GET /api/plan-parts lists what waits on the session's person; the POST routes
 * approve one revision of a part or ask for a change to it as that person. The decider comes from the
 * session only.
 */
async function planPartRoute(request: Request, url: URL, session: DashboardSession, handlers: DashboardHandlers): Promise<Response> {
  if (url.pathname === "/api/plan-parts") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const parts = await (await handlers.dashboard()).planParts(session.owner);
    return checkPlanInbox(parts).length === 0 ? json(parts) : json({ error: "invalid plan parts" }, 500);
  }
  if (url.pathname === "/api/plan-parts/confirm-protected") return confirmProtectedRoute(request, url, session, handlers);
  if (url.pathname === "/api/plan-parts/decide-caller") return decideCallerRoute(request, url, session, handlers);
  const kind = Object.hasOwn(PLAN_DECISION_ROUTES, url.pathname) ? PLAN_DECISION_ROUTES[url.pathname] : undefined;
  if (kind === undefined) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_PLAN_DECISION_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const { feature, part, revision, text, ...rest } = body;
  const fields = kind === "request_change" ? "feature, part, revision and text" : "feature, part and revision";
  if (Object.keys(rest).length > 0 || (kind !== "request_change" && text !== undefined)) {
    return json({ error: "invalid", message: `the body takes only ${fields}; the decider is the signed-in person` }, 400);
  }
  if (!isFeatureId(feature) || typeof part !== "string" || typeof revision !== "number") {
    return json({ error: "invalid", message: "feature must be a feature id, part a part id and revision a number" }, 400);
  }
  if (kind === "request_change" && typeof text !== "string") return json({ error: "invalid", message: "text must say what to change" }, 400);
  const decision: PlanPartDecision =
    kind === "request_change" ? { kind, feature, part, revision, text: text as string } : { kind, feature, part, revision };
  const decided = await (await handlers.dashboard()).decidePlanPart(session.owner, decision);
  return json(decided, decided.status === "ok" ? 200 : (FEATURE_REJECTION_STATUS[decided.reason] ?? 422));
}

/**
 * POST /api/plan-parts/confirm-protected: the session's person confirms the lines a feature's own
 * change writes under paths `owner` protects, `{ feature, owner, checkpoint }`. The confirmer comes
 * from the session only.
 */
async function confirmProtectedRoute(request: Request, url: URL, session: DashboardSession, handlers: DashboardHandlers): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_PLAN_DECISION_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const { feature, owner, checkpoint, ...rest } = body;
  if (Object.keys(rest).length > 0) {
    return json({ error: "invalid", message: "the body takes only feature, owner and checkpoint; the confirmer is the signed-in person" }, 400);
  }
  if (!isFeatureId(feature) || typeof owner !== "string" || typeof checkpoint !== "string" || !/^[0-9a-f]{40}$/u.test(checkpoint)) {
    return json({ error: "invalid", message: "feature must be a feature id, owner a person and checkpoint a full SHA" }, 400);
  }
  const confirmed = await (await handlers.dashboard()).confirmProtectedChange(session.owner, { feature, owner, checkpoint });
  return json(confirmed, confirmed.status === "ok" ? 200 : (FEATURE_REJECTION_STATUS[confirmed.reason] ?? 422));
}

/**
 * POST /api/plan-parts/decide-caller: the session's person decides one caller item sent to the worktree
 * owner, `{ item, verdict, text }`. The decider comes from the session only.
 */
async function decideCallerRoute(request: Request, url: URL, session: DashboardSession, handlers: DashboardHandlers): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_PLAN_DECISION_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const { item, verdict, text, ...rest } = body;
  if (Object.keys(rest).length > 0) {
    return json({ error: "invalid", message: "the body takes only item, verdict and text; the decider is the signed-in person" }, 400);
  }
  if (typeof item !== "string" || (verdict !== "approve" && verdict !== "request_changes") || (text !== undefined && typeof text !== "string")) {
    return json({ error: "invalid", message: "item must be a caller item id, verdict approve or request_changes and text a note" }, 400);
  }
  const decided = await (await handlers.dashboard()).decideCallerItem(session.owner, { item, verdict, text: (text as string | undefined) ?? "" });
  return json(decided, decided.status === "ok" ? 200 : (FEATURE_REJECTION_STATUS[decided.reason] ?? 422));
}

/** The largest review policy body the route reads: six rows and a preset fit well under it. */
const MAX_POLICY_BYTES = 4 * 1024;

/**
 * GET /api/review-policy reads the sandbox's review policy; POST sets it, `{ preset, rows }`, as the
 * session's person. The ProjectAgent checks the rows and who may change them.
 */
async function reviewPolicyRoute(request: Request, url: URL, session: DashboardSession, handlers: DashboardHandlers): Promise<Response> {
  if (request.method === "GET") {
    const view = await (await handlers.dashboard()).reviewPolicy(session.owner);
    return checkReviewPolicyView(view).length === 0 ? json(view) : json({ error: "invalid review policy" }, 500);
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  if (!isSameOrigin(request, url)) return json({ error: "cross-origin request" }, 403);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_POLICY_BYTES) {
    return json({ error: "invalid request", message: "the request is too large" }, 413);
  }
  const body = await readJsonObject(request);
  if (body === undefined) return json({ error: "invalid request", message: "the body must be a JSON object" }, 400);
  const { preset, rows, ...rest } = body;
  if (Object.keys(rest).length > 0) {
    return json({ error: "invalid", message: "the body takes only preset and rows; the person changing it is the signed-in person" }, 400);
  }
  const changed = await (await handlers.dashboard()).changeReviewPolicy(session.owner, { preset, rows });
  const status = changed.status === "ok" ? 200 : changed.reason === "forbidden" || changed.reason === "locked" ? 403 : 422;
  return json(changed, status);
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
    const inbox = await (await handlers.dashboard()).inbox(session.owner);
    return checkInbox(inbox).length === 0 ? json(inbox) : json({ error: "invalid inbox" }, 500);
  }
  if (url.pathname === "/api/inbox/read") return markInboxRead(request, url, session, handlers);
  if (url.pathname === "/api/identities" || url.pathname.startsWith("/api/identities/")) {
    const answer = await identityRoute(request, url, session, handlers);
    if (answer !== undefined) return answer;
  }
  if (url.pathname === "/api/features" || url.pathname.startsWith("/api/features/")) {
    const answer = await featureRoute(request, url, session, handlers);
    if (answer !== undefined) return answer;
  }
  if (url.pathname === "/api/overlaps" || url.pathname.startsWith("/api/overlaps/")) {
    return overlapRoute(request, url, session, handlers);
  }
  if (url.pathname === "/api/plan-parts" || url.pathname.startsWith("/api/plan-parts/")) {
    return planPartRoute(request, url, session, handlers);
  }
  if (url.pathname === "/api/review-policy") return reviewPolicyRoute(request, url, session, handlers);
  if (url.pathname === "/api/team") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json(await (await handlers.dashboard()).team(session.owner));
  }
  const person = personSegment(url.pathname);
  if (person !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (person === null) return json({ error: "not found" }, 404);
    return json(await (await handlers.dashboard()).personScopes(person));
  }
  const reviewId = /^\/api\/reviews\/([1-9][0-9]{0,8})\/differences$/.exec(url.pathname)?.[1];
  if (reviewId !== undefined) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const table = await (await handlers.dashboard()).reviewDifferences(Number(reviewId));
    if (table === undefined) return json({ error: "not found", message: `review ${reviewId} has no side-by-side run` }, 404);
    return checkReviewDifferences(table).length === 0 ? json(table) : json({ error: "invalid review differences" }, 500);
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

/**
 * The person a `/api/people/<id>/scopes` path names: undefined for any other path, null for an id that
 * does not decode. The id is only a key into the scope map; it reaches no query or markup.
 */
function personSegment(pathname: string): string | null | undefined {
  const raw = /^\/api\/people\/([^/]{1,256})\/scopes$/.exec(pathname)?.[1];
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function servePage(request: Request, url: URL, handlers: DashboardHandlers): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  // Every page is the same index.html; the app routes on the path.
  const asset = PAGE_PATH.test(url.pathname) ? new Request(new URL("/", url), { method: request.method }) : request;
  const response = await handlers.serveAsset(asset);
  if (FONT_PATH.test(url.pathname) && response.ok) {
    const font = new Response(response.body, response);
    font.headers.set("Content-Type", "font/woff2");
    font.headers.set("Cache-Control", FONT_CACHE_CONTROL);
    return font;
  }
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
  else if (pathname === "/board") response = redirect("/");
  else if (pathname === "/api" || pathname.startsWith("/api/")) response = await handleApi(request, url, options, handlers);
  else if (PAGE_PATH.test(pathname) || ASSET_PATH.test(pathname)) response = await servePage(request, url, handlers);
  else return null;
  // A WebSocket upgrade response carries the socket and must pass through unchanged.
  return response.status === 101 ? response : secured(response);
}
