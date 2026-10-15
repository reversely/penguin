// Artifacts binding calls of the check runner's idle pass (#218). Under `wrangler dev` every binding
// call leaves connections open, so a runner pass with nothing to claim calls the binding not at all:
// `/tokens` hands out the token it minted earlier on the same repo and scope until a minute before it
// expires, and a runner write that waits for its receiving worktree reads no fork. The real Worker and
// ProjectAgent answer the 11 requests of a runner pass; the binding is a double that counts each call.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TOKEN_REUSE_MARGIN_MS, TokenCache, type MintedToken } from "../../apps/worker/src/tokens.ts";

const AGENTS_STUB = new URL("./support/agents.ts", import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) => (specifier === "agents" ? { url: AGENTS_STUB, shortCircuit: true } : next(specifier, context)),
});

type Handler = { fetch(request: Request, env: unknown): Promise<Response> };
// Imported by a computed path, so the root typecheck leaves out the Worker's own types.
const root = new URL("../../", import.meta.url).href;
const worker = (await import(`${root}apps/worker/src/index.ts`)).default as Handler;
const { ProjectAgent } = await import(`${root}services/project-agent/src/index.ts`);
const { FeatureStore } = await import(`${root}services/project-agent/src/feature-store.ts`);
const { FixGrantStore } = await import(`${root}services/project-agent/src/fix-write.ts`);

/** The `ARTIFACTS` binding, counting `get`, `create`, `list`, `import`, `delete` and every call on a repo handle. */
function countingArtifacts() {
  const calls: string[] = [];
  const handle = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (method === Symbol.dispose) return () => undefined;
          if (method === "then") return undefined;
          return async (...args: unknown[]) => {
            calls.push(`${String(method)} ${name}`);
            if (method === "createToken") return { plaintext: `token-${calls.length}`, scope: args[0], expiresAt: new Date(Date.now() + (args[1] as number) * 1000).toISOString() };
            if (method === "info") return { remote: `https://artifacts.test/${name}.git` };
            if (method === "log") return [{ hash: "a".repeat(40) }];
            return null;
          };
        },
      },
    );
  const binding = {
    get: async (name: string) => (calls.push(`get ${name}`), handle(name)),
    create: async (name: string) => (calls.push(`create ${name}`), { name }),
    list: async () => (calls.push("list"), { repos: [] }),
    import: async () => (calls.push("import"), {}),
    delete: async () => (calls.push("delete"), true),
  };
  return { binding, calls };
}

/** One in-memory project: the real ProjectAgent on SQLite behind the real Worker, under `prefix`. */
async function project(prefix: string) {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
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
  const artifacts = countingArtifacts();
  const featureAgents = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ARTIFACTS: artifacts.binding,
    PENGUIN_REPO_PREFIX: prefix,
    ProjectAgent: { get: () => agent },
    FeatureAgent: { get: (name: string) => featureAgents.get(name) },
  };
  const agent = new ProjectAgent({ storage }, env);
  agent.onStart();
  const sql = { exec: (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings).toArray(), transaction: storage.transactionSync };

  async function bridge(owner: string, role: "owner" | "runner"): Promise<string> {
    const code = await agent.issueBridgeRegistrationCode(owner, role, 900);
    const { publicKey } = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const registered = await agent.registerBridge(code.code, await crypto.subtle.exportKey("jwk", publicKey));
    return registered.bridge.bridgeToken as string;
  }

  function call(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
    if (method === "POST") init.body = JSON.stringify(body ?? {});
    return worker.fetch(new Request(`https://penguin.test${path}`, init), env);
  }

  return { artifacts, featureAgents, sql, bridge, call };
}

/** The 11 requests of one check runner pass, each answered 200. */
async function runnerPass(call: (method: string, path: string, body?: unknown) => Promise<Response>): Promise<void> {
  const requests: [string, string, unknown?][] = [
    ["POST", "/tokens", { repo: "issues", scope: "write" }],
    ["POST", "/tool-runs/claim"],
    ["POST", "/fix-writes/claim"],
    ["POST", "/blocks/claim"],
    ["POST", "/combined-runs/claim"],
    ["POST", "/reviews/claim"],
    ["POST", "/part-trials/claim"],
    ["GET", "/verifications"],
    ["GET", "/plan-facts"],
    ["GET", "/operations/pending"],
    ["GET", "/approvals"],
  ];
  for (const [method, path, body] of requests) assert.equal((await call(method, path, body)).status, 200, `${method} ${path}`);
}

test("an idle runner pass makes no Artifacts call, with writes waiting for their receiving worktree", async () => {
  const { artifacts, featureAgents, sql, bridge, call } = await project("idle-");
  // Feature a's plan has three approved verify parts in feature b's fork, each a runner write that
  // waits while b's caller item is open.
  const features = new FeatureStore(sql);
  for (const [id, person] of [["a", "priya"], ["b", "jun"]] as const) {
    features.insert(id, person, { scopes: ["ledger"], paths: [], contracts: [] }, { ...features.draftRecord(id, "feature_opened", { person }, {}), signature: "test" });
    features.setRepo(id, `feature-${id}`);
  }
  const part = (n: number) => ({ partId: `a/v1/p${n}`, revision: 1, kind: "verify", approvalState: "approved", approvedBy: "jun", place: { kind: "feature", feature: "b" }, scopes: ["ledger"], diff: { source: "patch", patch: null, base: null, files: [] } });
  const plan = { featureId: "a", planId: "a/v1", person: "priya", parts: [part(1), part(2), part(3)] };
  const grants = new FixGrantStore(sql);
  for (const each of plan.parts) grants.open("a", plan.planId, each, "b", "runner");
  const openItem = { itemId: "a-b-1", feature: "b", state: "open", ownerAsked: null, contract: "ledger.post", caller: { path: "b.py", name: "pay" }, calls: [] };
  featureAgents.set("project-feature-a", { latestPlan: async () => plan, callerItems: async () => [openItem] });

  const runner = await bridge("runner", "runner");
  await runnerPass((method, path, body) => call(runner, method, path, body));
  assert.deepEqual(artifacts.calls, ["get idle-issues", "createToken idle-issues", "info idle-issues"], "the first pass mints the issues token alone");
  artifacts.calls.length = 0;
  await runnerPass((method, path, body) => call(runner, method, path, body));
  assert.deepEqual(artifacts.calls, [], "the next pass calls the binding not at all");
  assert.equal(grants.claimable().length, 3, "each write still waits");
});

test("two token requests for one repo and scope make one mint, kept only for bridges allowed it", async () => {
  const { artifacts, bridge, call } = await project("reuse-");
  const jun = await bridge("jun", "owner");
  const priya = await bridge("priya", "owner");
  const tokenOf = async (token: string, repo: string, scope: string) => (await (await call(token, "POST", "/tokens", { repo, scope })).json()) as { token: string };

  const first = await tokenOf(jun, "issues", "write");
  const second = await tokenOf(priya, "issues", "write");
  assert.equal(second.token, first.token);
  assert.equal(artifacts.calls.filter((entry) => entry.startsWith("createToken")).length, 1);

  // Jun's write token on his fork is never handed to Priya, who may only read it, and her read token is its own mint.
  await tokenOf(jun, "owner-jun", "write");
  assert.equal((await call(priya, "POST", "/tokens", { repo: "owner-jun", scope: "write" })).status, 403);
  const read = await tokenOf(priya, "owner-jun", "read");
  assert.deepEqual(artifacts.calls.filter((entry) => entry.startsWith("createToken")), ["createToken reuse-issues", "createToken reuse-owner-jun", "createToken reuse-owner-jun"]);
  assert.notEqual(read.token, first.token);
});

test("a kept token is checked for expiry before reuse and minted again a minute before it expires", async () => {
  const clock = { now: 0 };
  const cache = new TokenCache(() => clock.now);
  let mints = 0;
  const mint = async (): Promise<MintedToken> => ({ token: `t${++mints}`, remote: "https://artifacts.test/issues.git", scope: "write", expiresAt: new Date(3_600_000).toISOString() });

  assert.equal((await cache.token("issues", "write", mint)).token, "t1");
  clock.now = 3_600_000 - TOKEN_REUSE_MARGIN_MS - 1;
  assert.equal((await cache.token("issues", "write", mint)).token, "t1", "more than a minute left: reused");
  clock.now += 1;
  assert.equal((await cache.token("issues", "write", mint)).token, "t2", "a minute left: minted again");
  assert.equal((await cache.token("issues", "read", mint)).token, "t3", "another scope is its own token");
});
