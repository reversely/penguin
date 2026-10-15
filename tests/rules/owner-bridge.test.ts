// A person's bridge creates their identities and approves their waiting starts (#219), the two things
// the dashboard's identities page and approve button do (PRD section 8: a bridge acts for its own
// person only). Each command is one request signed with the owner's registered bridge key; only an
// owner bridge acting for its own person is served, and input is checked and answered exactly as the
// dashboard routes check and answer it. The real Worker and ProjectAgent run under Node with the Agent
// base class of `tests/rules/support/agents.ts`; the base repo's scope map comes from a binding double.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { signBridgeRequest } from "@penguin/issues";

import { encodeSession, SESSION_COOKIE, sessionKey } from "../../apps/worker/src/session.ts";
import { runCli } from "../../services/local-bridge/src/cli.ts";
import { loadSigningKey, MemoryKeyStore } from "../../services/local-bridge/src/key-store.ts";

const AGENTS_STUB = new URL("./support/agents.ts", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === "agents" ? { url: AGENTS_STUB, shortCircuit: true } : next(specifier, context)),
});

type Handler = { fetch(request: Request, env: unknown): Promise<Response> };
// Imported by a computed path, so the root typecheck leaves out the Worker's own types.
const root = new URL("../../", import.meta.url).href;
const worker = (await import(`${root}apps/worker/src/index.ts`)).default as Handler;
const { ProjectAgent } = await import(`${root}services/project-agent/src/index.ts`);
const { FeatureStore, verifyFeatureRecord } = await import(`${root}services/project-agent/src/feature-store.ts`);
const { OverlapStore } = await import(`${root}services/project-agent/src/overlap-lock.ts`);

const SERVER = "https://penguin.test";
const CLIENT_SECRET = "client-secret-for-tests"; // pragma: allowlist secret
const BASE_FILES: Record<string, unknown> = {
  "penguin/teams.json": { teams: [{ id: "data", name: "Data", lead: "priya", members: ["priya", "jun"] }] },
  "penguin/scopes.json": {
    scopes: [
      { id: "analytics", name: "Analytics", team: "data", dri: "jun", fallback: ["priya"], paths: ["analytics/"], contracts: [], test_command: "true", depends_on: [] },
      { id: "ledger", name: "Ledger", team: "data", dri: "priya", fallback: ["jun"], paths: ["ledger/"], contracts: [], test_command: "true", depends_on: [] },
    ],
  },
};

/** One in-memory project behind the real Worker; the base repo serves the scope map and teams. */
async function project() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[] }) },
    transactionSync: <T>(body: () => T): T => {
      db.exec("SAVEPOINT t");
      try {
        const result = body();
        db.exec("RELEASE t");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO t");
        db.exec("RELEASE t");
        throw error;
      }
    },
  };
  const repo = {
    readFile: async ({ path }: { path: string }) => (path in BASE_FILES ? new Blob([JSON.stringify(BASE_FILES[path])]) : null),
    [Symbol.dispose]: () => undefined,
  };
  const service = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const env: Record<string, unknown> = {
    ARTIFACTS: { get: async () => repo },
    PENGUIN_REPO_PREFIX: "owner-",
    PENGUIN_OP_SIGNING_KEY: JSON.stringify(await crypto.subtle.exportKey("jwk", service.privateKey)),
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    ProjectAgent: { get: () => agent },
  };
  const agent = new ProjectAgent({ storage }, env);
  agent.onStart();
  const sql = { exec: (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings).toArray().map((row) => ({ ...row })), transaction: storage.transactionSync };
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return worker.fetch(request, env);
  }) as typeof fetch;

  /** Registers `owner`'s bridge through `penguin-bridge register`; answers its CLI runner and state. */
  async function bridge(owner: string, role: "owner" | "runner" = "owner") {
    const code = await agent.issueBridgeRegistrationCode(owner, role, 900);
    const keyStore = new MemoryKeyStore();
    const stateDir = await mkdtemp(join(tmpdir(), `penguin-${owner}-`));
    const output: string[] = [];
    const io = { write: (text: string) => void output.push(text), ask: async () => "" };
    const run = (...argv: string[]) => runCli([...argv, "--state-dir", stateDir], io, { keyStore, stateDir, fetch: fetchImpl });
    assert.equal(await run("register", "--server", SERVER, "--owner", owner, "--code", code.code), 0);
    requests.length = 0;
    return { run, output, keyStore, token: (await keyStore.get(`bridge-token:${owner}`)) as string };
  }

  /** A signed request as `penguin-bridge` sends it, with any field overridden. */
  async function signed(token: string, key: CryptoKey, route: string, fields: Record<string, unknown>): Promise<Response> {
    return post(token, route, await signBridgeRequest(route, { signedAt: new Date().toISOString(), ...fields }, key));
  }

  function post(token: string, route: string, body: unknown): Promise<Response> {
    return worker.fetch(new Request(`${SERVER}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  }

  /** The same input posted to the dashboard route as `owner`'s signed-in session. */
  async function dashboard(owner: string, path: string, body: unknown): Promise<Response> {
    const cookie = await encodeSession(await sessionKey(CLIENT_SECRET), { owner, login: owner, expiresAt: Date.now() + 60_000 });
    return worker.fetch(new Request(`${SERVER}${path}`, { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: SERVER, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  }

  /** Jun's running feature `a` covers Priya's feature `b`, whose start waits on Jun (a lock opened before #177). */
  function waitingStart(): void {
    const features = new FeatureStore(sql);
    new OverlapStore(sql);
    for (const [id, person] of [["a", "jun"], ["b", "priya"]] as const) {
      features.insert(id, person, { scopes: ["analytics"], paths: [], contracts: [] }, { ...features.draftRecord(id, "feature_opened", { person }, {}), signature: "test" });
    }
    sql.exec(
      `INSERT INTO OverlapLock (feature_id, blocked_feature_id, person_id, state, approved_by, overlap, opened_at, decided_at)
       VALUES ('a', 'b', 'jun', 'open', NULL, ?, ?, NULL)`,
      JSON.stringify({ scopes: ["analytics"], paths: [], contracts: [], omittedPaths: 0 }),
      Date.now(),
    );
  }

  return { sql, requests, bridge, signed, post, dashboard, waitingStart, servicePublicKey: service.publicKey };
}

const signingKey = async (keyStore: MemoryKeyStore, owner: string) => (await loadSigningKey(keyStore, owner)).privateKey;

test("an owner's bridge creates the owner's identity and approves the owner's waiting start, one request each", async () => {
  const { sql, requests, bridge, waitingStart, servicePublicKey } = await project();
  const jun = await bridge("jun");

  const created = await jun.run("identity", "create", "--owner", "jun", "--handle", "@jun/reports", "--job", "Keeps the weekly report right", "--charter-scope", "analytics", "--charter-path", "analytics/**", "--auto-accept");
  assert.equal(created, 0, jun.output.join(""));
  assert.deepEqual(requests, ["POST /owner/identities"]);
  assert.deepEqual(
    sql.exec(`SELECT owner_id, handle, name, job, charter_scopes, charter_paths, auto_accept FROM Identity`),
    [{ owner_id: "jun", handle: "@jun/reports", name: "reports", job: "Keeps the weekly report right", charter_scopes: '["analytics"]', charter_paths: '["analytics/**"]', auto_accept: 1 }],
  );

  waitingStart();
  requests.length = 0;
  assert.equal(await jun.run("start", "approve", "--owner", "jun", "--feature", "a", "--blocked", "b"), 0, jun.output.join(""));
  assert.deepEqual(requests, ["POST /owner/starts/approve"]);
  assert.deepEqual(sql.exec(`SELECT state, approved_by FROM OverlapLock`), [{ state: "approved", approved_by: "jun" }]);
  const approval = new FeatureStore(sql).records("b").map((stored: { file: string }) => JSON.parse(stored.file)).find((record: { type: string }) => record.type === "approve_overlap");
  assert.deepEqual([approval.author, approval.payload.approved_by], [{ person: "jun" }, "jun"]);
  assert.equal(await verifyFeatureRecord(approval, servicePublicKey), true, "Penguin signs the approval as it does the dashboard's");
});

test("a runner bridge, another owner's bridge and a request not signed by the bridge's key are refused", async () => {
  const { sql, bridge, signed, post, waitingStart } = await project();
  const jun = await bridge("jun");
  const priya = await bridge("priya");
  const runner = await bridge("jun", "runner");
  waitingStart();
  const identity = { handle: "@jun/reports", name: "Reports", job: "Reports", charterScopes: [] };
  const approve = { feature: "a", blockedFeature: "b" };

  const runnerKey = await signingKey(runner.keyStore, "jun");
  assert.equal((await signed(runner.token, runnerKey, "/owner/identities", { owner: "jun", identity })).status, 403, "a runner bridge, even registered for jun");
  const priyaKey = await signingKey(priya.keyStore, "priya");
  assert.equal((await signed(priya.token, priyaKey, "/owner/identities", { owner: "jun", identity })).status, 403, "priya's bridge acting for jun");
  assert.equal((await signed(priya.token, priyaKey, "/owner/starts/approve", { owner: "jun", ...approve })).status, 403, "priya's bridge approving for jun");
  assert.equal((await signed(priya.token, priyaKey, "/owner/starts/approve", { owner: "priya", ...approve })).status, 403, "priya approving jun's start");

  const junKey = await signingKey(jun.keyStore, "jun");
  assert.equal((await signed(jun.token, priyaKey, "/owner/identities", { owner: "jun", identity })).status, 401, "signed with another bridge's key");
  assert.equal((await signed(jun.token, junKey, "/owner/starts/approve", { owner: "jun", ...approve, signedAt: "2026-01-01T00:00:00Z" })).status, 401, "signed long ago");
  const otherRoute = await signBridgeRequest("/owner/identities", { owner: "jun", signedAt: new Date().toISOString(), ...approve }, junKey);
  assert.equal((await post(jun.token, "/owner/starts/approve", otherRoute)).status, 401, "a signature made for another route");

  // Every refusal came before the identity store: it never opened its table.
  assert.deepEqual(sql.exec(`SELECT name FROM sqlite_master WHERE name = 'Identity'`), []);
  assert.deepEqual(sql.exec(`SELECT state FROM OverlapLock`), [{ state: "open" }]);
});

test("invalid input gets the dashboard route's status and answer", async () => {
  const { bridge, signed, dashboard } = await project();
  const jun = await bridge("jun");
  const key = await signingKey(jun.keyStore, "jun");
  const cases: [string, string, Record<string, unknown>][] = [
    ["/owner/identities", "/api/identities", { handle: "@jun/ledger", name: "Ledger", job: "Ledger", charterScopes: ["ledger"] }],
    ["/owner/identities", "/api/identities", { handle: "@priya/reports", name: "Reports", job: "Reports", charterScopes: [] }],
    ["/owner/identities", "/api/identities", { handle: "@jun/reports", name: "Reports\u0007", job: "Reports", charterScopes: [] }],
    ["/owner/starts/approve", "/api/overlaps/approve", { feature: "../a", blockedFeature: "b" }],
    ["/owner/starts/approve", "/api/overlaps/approve", { feature: "a", blockedFeature: "b", approved_by: "priya" }],
  ];
  for (const [route, path, input] of cases) {
    const fields = route === "/owner/identities" ? { identity: input } : input;
    const fromBridge = await signed(jun.token, key, route, { owner: "jun", ...fields });
    const fromDashboard = await dashboard("jun", path, input);
    assert.ok(fromDashboard.status >= 400, `${path} ${JSON.stringify(input)}`);
    assert.deepEqual([fromBridge.status, await fromBridge.json()], [fromDashboard.status, await fromDashboard.json()], JSON.stringify(input));
  }
});
