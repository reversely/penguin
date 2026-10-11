import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  CONTENT_SECURITY_POLICY,
  type DashboardBackend,
  type DashboardOptions,
  type DashboardWriteOutcome,
  type IdentityWriteOutcome,
  type InboxReadOutcome,
} from "../src/dashboard.ts";
import { type GatewayHandlers, handleRequest } from "../src/gateway.ts";
import { parseOwnerMap } from "../src/github-oauth.ts";
import { encodeSession, SESSION_COOKIE, sessionKey } from "../src/session.ts";
import { DOUBLE_CLIENT, startGitHubDouble, type GitHubDouble } from "./github-double.ts";

const ORIGIN = "http://127.0.0.1:8787";
const INDEX_HTML = "<!doctype html><title>Penguin</title><div id=root></div>";

let double: GitHubDouble;
before(async () => {
  double = await startGitHubDouble("priya-gh");
});
after(() => double.close());

function options(overrides: Partial<DashboardOptions> = {}): DashboardOptions {
  return {
    githubClientId: DOUBLE_CLIENT.clientId,
    githubClientSecret: DOUBLE_CLIENT.clientSecret,
    owners: parseOwnerMap("Priya-GH:priya, jun-gh:jun"),
    githubBaseUrl: double.url,
    ...overrides,
  };
}

/** A ProjectAgent stand-in that records each call. */
class Backend implements DashboardBackend {
  readonly writes: { owner: string; operation: unknown }[] = [];
  readonly live: { owner: string; upgrade: string | null }[] = [];
  readonly issues = new Map<string, unknown>();

  async readIssue(issueId: string) {
    return this.issues.get(issueId);
  }
  async board() {
    return { owners: [{ id: "jun", identities: [] }], issues: [...this.issues.values()] };
  }
  readonly reads: { owner: string; issueId: string; reason: string }[] = [];

  readonly inboxReads: string[] = [];
  /** The handles every inbox entry carries. */
  assigneeHandles: unknown[] = ["@jun/reports"];

  async inbox(owner: string) {
    this.inboxReads.push(owner);
    const entry = { issueId: "40", reason: "mentioned", read: false, raisedAt: "2026-10-10T12:00:00.000Z", state: "open" };
    return { items: [{ ...entry, title: "<img src=x onerror=alert(1)>", assigneeHandles: this.assigneeHandles }] };
  }
  async markInboxRead(owner: string, issueId: string, reason: string): Promise<InboxReadOutcome> {
    this.reads.push({ owner, issueId, reason });
    if (issueId === "41") return { status: "rejected", reason: "not_found", message: "no item" };
    return { status: "ok", item: { personId: owner, issueId, reason, read: true } };
  }
  async submit(owner: string, operation: unknown): Promise<DashboardWriteOutcome> {
    this.writes.push({ owner, operation });
    return { status: "applied", opId: `${owner}-web-0001`, issueId: "40", version: 1 };
  }
  readonly identityWrites: { action: string; owner: string; id?: string; body: unknown }[] = [];

  async identities() {
    return { identities: [], scopes: [], owners: ["jun", "priya"], limits: {} };
  }
  async createIdentity(owner: string, body: unknown): Promise<IdentityWriteOutcome> {
    this.identityWrites.push({ action: "create", owner, body });
    return { status: "ok", id: "identity-1", handle: `@${owner}/reports` };
  }
  async editIdentity(owner: string, id: string, body: unknown): Promise<IdentityWriteOutcome> {
    this.identityWrites.push({ action: "edit", owner, id, body });
    if (id === "theirs") return { status: "rejected", reason: "forbidden", message: "not yours" };
    if (id === "gone") return { status: "rejected", reason: "not_found", message: "no identity" };
    return { status: "ok", id, handle: `@${owner}/reports` };
  }
  async duplicateIdentity(owner: string, id: string, body: unknown): Promise<IdentityWriteOutcome> {
    this.identityWrites.push({ action: "duplicate", owner, id, body });
    return { status: "ok", id: "identity-2", handle: `@${owner}/reports-copy` };
  }
  async connectLive(request: Request, owner: string) {
    this.live.push({ owner, upgrade: request.headers.get("Upgrade") });
    return new Response("upgraded");
  }
}

function handlers(backend: Backend): GatewayHandlers {
  return {
    serveAsset: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html" } });
      if (path === "/app.js") return new Response("export {};", { headers: { "Content-Type": "text/javascript" } });
      return new Response("not found", { status: 404 });
    },
    dashboard: () => backend,
  } as unknown as GatewayHandlers;
}

/** A browser with a cookie jar that follows nothing on its own. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly backend: Backend;
  readonly dashboardOptions: DashboardOptions;

  constructor(backend = new Backend(), dashboardOptions: DashboardOptions = options()) {
    this.backend = backend;
    this.dashboardOptions = dashboardOptions;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const response = await handleRequest(new Request(url, { ...init, headers }), { dashboard: this.dashboardOptions }, handlers(this.backend));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0/.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /** Signs in through the GitHub double, following each redirect, and returns the final Location. */
  async signIn(login?: string): Promise<string> {
    const start = await this.request(`/auth/github${login === undefined ? "" : `?login=${login}`}`);
    assert.equal(start.status, 303);
    const atGitHub = await fetch(start.headers.get("Location") ?? "", { redirect: "manual" });
    assert.equal(atGitHub.status, 302);
    const callback = await this.request(atGitHub.headers.get("Location") ?? "");
    assert.equal(callback.status, 303);
    return callback.headers.get("Location") ?? "";
  }

  post(path: string, body: unknown, origin = ORIGIN): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  }
}

describe("an unauthenticated visit", () => {
  test("gets the app's page, which carries no data, under a policy that blocks inline scripts", async () => {
    const browser = new Browser();
    for (const path of ["/", "/inbox", "/board", "/identities", "/issues/40"]) {
      const response = await browser.request(path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), INDEX_HTML, path);
      const policy = response.headers.get("Content-Security-Policy") ?? "";
      assert.equal(policy, CONTENT_SECURITY_POLICY);
      assert.match(policy, /script-src 'self'(;|$)/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    }
    const script = await browser.request("/app.js");
    assert.equal(script.status, 200);
    assert.ok(script.headers.get("Content-Security-Policy"));
  });

  test("gets 401 from every dashboard API route", async () => {
    const browser = new Browser();
    const calls: [string, RequestInit?][] = [
      ["/api/session"],
      ["/api/inbox"],
      ["/api/inbox/read", { method: "POST", headers: { Origin: ORIGIN }, body: '{"issueId":"40","reason":"mentioned"}' }],
      ["/api/issues/40"],
      ["/api/board"],
      ["/api/live", { headers: { Upgrade: "websocket" } }],
      ["/api/operations", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }],
      ["/api/identities"],
      ["/api/identities", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }],
      ["/api/identities/identity-1", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }],
      ["/api/anything"],
    ];
    for (const [path, init] of calls) {
      const response = await browser.request(path, init);
      assert.equal(response.status, 401, path);
      assert.ok(response.headers.get("Content-Security-Policy"), path);
    }
    assert.deepEqual(browser.backend.writes, []);
    assert.deepEqual(browser.backend.identityWrites, []);
    assert.deepEqual(browser.backend.reads, []);
    assert.deepEqual(browser.backend.live, []);
  });

  test("leaves the gateway's other unauthenticated answers unchanged", async () => {
    const browser = new Browser();
    assert.equal((await browser.request("/nowhere")).status, 401);
    assert.equal((await browser.request("/index.html")).status, 401);
  });
});

describe("GitHub sign-in", () => {
  test("signs a mapped login in as its owner and the session reads back", async () => {
    const browser = new Browser();
    assert.equal(await browser.signIn(), "/");
    const cookie = browser.cookies.get(SESSION_COOKIE);
    assert.ok(cookie);
    assert.equal(browser.cookies.has("__Host-penguin_oauth"), false);

    const session = await browser.request("/api/session");
    assert.equal(session.status, 200);
    const body = (await session.json()) as { owner: string; login: string };
    assert.deepEqual([body.owner, body.login], ["priya", "priya-gh"]);
  });

  test("sets the session cookie HttpOnly, Secure, SameSite=Lax and host-only", async () => {
    const browser = new Browser();
    const start = await browser.request("/auth/github");
    const atGitHub = await fetch(start.headers.get("Location") ?? "", { redirect: "manual" });
    const callback = await browser.request(atGitHub.headers.get("Location") ?? "");
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.match(cookie, new RegExp(attribute));
    assert.doesNotMatch(cookie, /Domain=/);
  });

  test("passes the login hint on and asks GitHub for PKCE", async () => {
    const browser = new Browser();
    const start = await browser.request("/auth/github?login=jun-gh");
    const location = new URL(start.headers.get("Location") ?? "");
    assert.equal(location.origin, double.url);
    assert.equal(location.searchParams.get("login"), "jun-gh");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/auth/github/callback`);
    assert.equal(location.searchParams.has("scope"), false);
  });

  test("sends a login with no owner back to sign-in without a session", async () => {
    const browser = new Browser();
    assert.equal(await browser.signIn("stranger"), "/?signin=no-owner");
    assert.equal(browser.cookies.has(SESSION_COOKIE), false);
  });

  test("refuses a callback whose state does not match the browser's", async () => {
    const browser = new Browser();
    const start = await browser.request("/auth/github");
    const atGitHub = new URL((await fetch(start.headers.get("Location") ?? "", { redirect: "manual" })).headers.get("Location") ?? "");
    atGitHub.searchParams.set("state", "forged");
    const callback = await browser.request(atGitHub.toString());
    assert.equal(callback.headers.get("Location"), "/?signin=failed");
    assert.equal(browser.cookies.has(SESSION_COOKIE), false);

    // A callback in another browser, which never started sign-in, fails the same way.
    const other = new Browser();
    const replay = await other.request(`/auth/github/callback?code=${atGitHub.searchParams.get("code")}&state=forged`);
    assert.equal(replay.headers.get("Location"), "/?signin=failed");
  });

  test("answers 503 when the OAuth app is not configured", async () => {
    const browser = new Browser(new Backend(), options({ githubClientId: undefined, githubClientSecret: undefined }));
    assert.equal((await browser.request("/auth/github")).status, 503);
    assert.equal((await browser.request("/api/session")).status, 401);
  });

  test("uses the test double only on a loopback hostname", async () => {
    const browser = new Browser();
    const start = await browser.request("https://penguin.example/auth/github");
    assert.equal(new URL(start.headers.get("Location") ?? "").origin, "https://github.com");
  });

  test("rejects a forged, re-signed or expired session cookie", async () => {
    const browser = new Browser();
    await browser.signIn();
    const genuine = browser.cookies.get(SESSION_COOKIE) ?? "";
    const [payload = "", signature = ""] = genuine.split(".");
    const asJun = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), o: "jun" }),
    ).toString("base64url");

    const otherKey = await sessionKey("another-secret");
    const expiredKey = await sessionKey(DOUBLE_CLIENT.clientSecret);
    for (const value of [
      `${asJun}.${signature}`,
      await encodeSession(otherKey, { owner: "jun", login: "jun-gh", expiresAt: Date.now() + 60_000 }),
      await encodeSession(expiredKey, { owner: "priya", login: "priya-gh", expiresAt: Date.now() - 1 }),
      "garbage",
    ]) {
      browser.cookies.set(SESSION_COOKIE, value);
      assert.equal((await browser.request("/api/session")).status, 401, value);
    }
  });

  test("signs out with a same-origin POST only", async () => {
    const browser = new Browser();
    await browser.signIn();
    const crossSite = await browser.request("/auth/signout", { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await browser.request("/api/session")).status, 200);

    const signOut = await browser.request("/auth/signout", { method: "POST", headers: { Origin: ORIGIN } });
    assert.equal(signOut.status, 303);
    assert.equal((await browser.request("/api/session")).status, 401);
  });
});

describe("a signed-in person", () => {
  test("writes an operation that reaches the index with that person as author", async () => {
    const browser = new Browser();
    await browser.signIn();
    const operation = { issue: 40, type: "create", base_version: 0, payload: { title: "Board filter drops identities" } };
    const response = await browser.post("/api/operations", operation);
    assert.equal(response.status, 201);
    assert.deepEqual(browser.backend.writes, [{ owner: "priya", operation }]);
  });

  test("cannot set author, even to themselves", async () => {
    const browser = new Browser();
    await browser.signIn();
    for (const author of [{ person: "jun" }, { person: "priya" }]) {
      const response = await browser.post("/api/operations", { issue: 40, type: "create", base_version: 0, payload: {}, author });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(browser.backend.writes, []);
  });

  test("cannot write from another origin or with a body that is not an operation object", async () => {
    const browser = new Browser();
    await browser.signIn();
    assert.equal((await browser.post("/api/operations", { issue: 40 }, "https://evil.example")).status, 403);
    assert.equal((await browser.request("/api/operations", { method: "POST", body: "{}" })).status, 403);
    for (const body of [[1], "text", null]) assert.equal((await browser.post("/api/operations", body)).status, 400);
    assert.equal((await browser.request("/api/operations")).status, 405);
    assert.deepEqual(browser.backend.writes, []);
  });

  test("reads an issue, the board and their own inbox", async () => {
    const browser = new Browser();
    const page = { issue: { id: "40", title: "Board filter" }, subIssues: [], timeline: [] };
    browser.backend.issues.set("40", page);
    await browser.signIn("jun-gh");
    const read = await browser.request("/api/issues/40");
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), page);
    assert.equal((await browser.request("/api/issues/41")).status, 404);
    const board = await browser.request("/api/board");
    assert.equal(board.status, 200);
    assert.ok(board.headers.get("Content-Security-Policy"));
    assert.deepEqual(await board.json(), { owners: [{ id: "jun", identities: [] }], issues: [page] });
    assert.equal((await browser.request("/api/board", { method: "POST", headers: { Origin: ORIGIN } })).status, 405);
    const inbox = await browser.request("/api/inbox");
    assert.equal(inbox.status, 200);
    assert.deepEqual(browser.backend.inboxReads, ["jun"]);
    assert.deepEqual(
      ((await inbox.json()) as { items: { assigneeHandles: string[] }[] }).items.map((item) => item.assigneeHandles),
      [["@jun/reports"]],
    );
  });

  test("sends an inbox title with markup as JSON text, and never an inbox with a malformed handle", async () => {
    const browser = new Browser();
    await browser.signIn("jun-gh");
    const inbox = await browser.request("/api/inbox");
    assert.match(inbox.headers.get("Content-Type") ?? "", /^application\/json/);
    assert.equal(((await inbox.json()) as { items: { title: string }[] }).items[0]?.title, "<img src=x onerror=alert(1)>");

    for (const handle of ["<b>@jun/reports</b>", "@jun/<script>", "jun/reports", "@Jun/reports", 7]) {
      browser.backend.assigneeHandles = [handle];
      const answer = await browser.request("/api/inbox");
      assert.equal(answer.status, 500, String(handle));
      assert.deepEqual(await answer.json(), { error: "invalid inbox" });
    }
  });

  test("marks only their own inbox items read, from the dashboard's origin", async () => {
    const browser = new Browser();
    await browser.signIn("jun-gh");
    const marked = await browser.post("/api/inbox/read", { issueId: "40", reason: "mentioned", owner: "priya" });
    assert.equal(marked.status, 200);
    assert.deepEqual(((await marked.json()) as { status: string }).status, "ok");
    assert.equal((await browser.post("/api/inbox/read", { issueId: "41", reason: "mentioned" })).status, 404);
    assert.deepEqual(browser.backend.reads, [
      { owner: "jun", issueId: "40", reason: "mentioned" },
      { owner: "jun", issueId: "41", reason: "mentioned" },
    ]);

    assert.equal((await browser.post("/api/inbox/read", { issueId: "40", reason: "mentioned" }, "https://evil.example")).status, 403);
    for (const body of [{ issueId: "40" }, { reason: "mentioned" }, { issueId: "../40", reason: "mentioned" }, { issueId: 40, reason: "mentioned" }, [1]]) {
      assert.equal((await browser.post("/api/inbox/read", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await browser.request("/api/inbox/read")).status, 405);
    assert.equal(browser.backend.reads.length, 2);

    const signedOut = new Browser();
    assert.equal((await signedOut.post("/api/inbox/read", { issueId: "40", reason: "mentioned" })).status, 401);
  });

  test("reads the identities and creates, edits and duplicates them as themselves", async () => {
    const browser = new Browser();
    await browser.signIn("jun-gh");
    const page = await browser.request("/api/identities");
    assert.equal(page.status, 200);
    assert.deepEqual(((await page.json()) as { owners: string[] }).owners, ["jun", "priya"]);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const created = await browser.post("/api/identities", {
      handle: "@jun/reports",
      name: "Reports",
      avatar: { mediaType: "image/png", data: png.toString("base64") },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { status: "ok", id: "identity-1", handle: "@jun/reports" });
    assert.equal((await browser.post("/api/identities/identity-1", { name: "Renamed", avatar: null })).status, 200);
    assert.equal((await browser.post("/api/identities/identity-1/duplicate", { handle: "@jun/reports-copy" })).status, 201);

    const [create, edit, duplicate] = browser.backend.identityWrites;
    assert.equal(create?.owner, "jun");
    // The avatar's base64 reaches the ProjectAgent as bytes.
    const avatar = (create?.body as { avatar: { mediaType: string; data: Uint8Array } }).avatar;
    assert.equal(avatar.mediaType, "image/png");
    assert.ok(avatar.data instanceof Uint8Array);
    assert.deepEqual([...avatar.data], [...png]);
    assert.deepEqual(edit, { action: "edit", owner: "jun", id: "identity-1", body: { name: "Renamed", avatar: null } });
    assert.deepEqual(duplicate, { action: "duplicate", owner: "jun", id: "identity-1", body: { handle: "@jun/reports-copy" } });

    // The ProjectAgent's refusals keep their reason in the status.
    assert.equal((await browser.post("/api/identities/theirs", { name: "Mine" })).status, 403);
    assert.equal((await browser.post("/api/identities/gone", { name: "Mine" })).status, 404);
  });

  test("cannot write an identity from another origin, with a bad body or past the size cap", async () => {
    const browser = new Browser();
    await browser.signIn("jun-gh");
    assert.equal((await browser.post("/api/identities", { handle: "@jun/x" }, "https://evil.example")).status, 403);
    assert.equal((await browser.post("/api/identities/identity-1", { name: "x" }, "https://evil.example")).status, 403);
    for (const body of [[1], "text", null, { avatar: { mediaType: "image/png", data: "not base64!" } }, { avatar: { mediaType: "image/png" } }]) {
      assert.equal((await browser.post("/api/identities", body)).status, 400, JSON.stringify(body));
    }
    const large = await browser.post("/api/identities", { handle: "@jun/x", job: "x".repeat(300 * 1024) });
    assert.equal(large.status, 413);
    assert.equal((await browser.request("/api/identities/identity-1")).status, 405);
    assert.equal((await browser.request("/api/identities", { method: "DELETE", headers: { Origin: ORIGIN } })).status, 405);
    assert.equal((await browser.post("/api/identities/../x", {})).status, 404);
    assert.deepEqual(browser.backend.identityWrites, []);
  });

  test("opens the live connection as themselves, and only as a WebSocket upgrade", async () => {
    const browser = new Browser();
    await browser.signIn("jun-gh");
    assert.equal((await browser.request("/api/live")).status, 426);
    const upgrade = await browser.request("/api/live", { headers: { Upgrade: "websocket", "X-Penguin-Owner": "priya" } });
    assert.equal(upgrade.status, 200);
    assert.deepEqual(browser.backend.live, [{ owner: "jun", upgrade: "websocket" }]);
  });
});

test("the owner map keys logins case-insensitively and skips malformed pairs", () => {
  assert.deepEqual(
    [...parseOwnerMap(" Priya-GH:priya ,jun-gh:jun,broken,sam-gh:../sam,:sam,amy:")],
    [
      ["priya-gh", "priya"],
      ["jun-gh", "jun"],
    ],
  );
  assert.equal(parseOwnerMap(undefined).size, 0);
});
