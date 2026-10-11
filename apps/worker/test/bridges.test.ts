import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair } from "@penguin/issues";
// The registry module directly: the package entry point loads the Agents SDK, which needs workerd.
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import type { SqlDatabase } from "../../../services/project-agent/src/issue-index.ts";

import { type GatewayHandlers, handleRequest } from "../src/gateway.ts";
import { RepoNames } from "../src/repos.ts";
import {
  artifactsRepoName,
  mintRepoToken,
  parseProjectRepo,
  parseTokenTtl,
  type TokenArtifacts,
  type TokenScope,
} from "../src/tokens.ts";

const DEPLOYER_TOKEN = "deployer-secret-for-tests";
const TTL = 600;
const OPTIONS = { deployerToken: DEPLOYER_TOKEN, tokenTtlSeconds: TTL };
const names = new RepoNames("test-");

class ArtifactsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** An Artifacts namespace holding `repos` whose tokens expire exactly `ttl` seconds from now. */
function fakeArtifacts(repos: readonly string[]): TokenArtifacts & { minted: { repo: string; scope: TokenScope }[] } {
  const existing = new Set(repos);
  const minted: { repo: string; scope: TokenScope }[] = [];
  return {
    minted,
    async get(name) {
      if (!existing.has(name)) throw new ArtifactsError("NOT_FOUND", `repository not found: ${name}`);
      return {
        async createToken(scope, ttl) {
          minted.push({ repo: name, scope });
          const plaintext = `art_${crypto.randomUUID()}`;
          return { plaintext, scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
        },
        [Symbol.dispose]() {},
      };
    },
  };
}

function sqlite(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as Record<string, string | number | null>[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const PROJECT_REPOS = ["base", "issues", "owner-jun", "owner-priya", "huddle-031"].map((repo) => `test-${repo}`);

function gateway(artifacts = fakeArtifacts(PROJECT_REPOS)) {
  const registry = new BridgeRegistry(sqlite());
  const handlers: GatewayHandlers = {
    routeAgents: async () => null,
    setUpProject: async () => {
      throw new Error("not used");
    },
    // The ProjectAgent's RPC methods delegate to its registry the same way.
    bridges: () => ({
      issueBridgeRegistrationCode: (owner, role, ttl) => registry.issueCode(owner, role, ttl),
      registerBridge: (code, publicKey) => registry.register(code, publicKey),
      authenticateBridge: (token) => registry.authenticate(token),
      revokeBridge: (bridgeId) => registry.revoke(bridgeId),
    }),
    mintToken: (repo, scope, ttl) => {
      const parsed = parseProjectRepo(repo);
      assert.ok(parsed);
      return mintRepoToken(artifacts, artifactsRepoName(parsed, names), scope, ttl);
    },
  };
  const call = (path: string, init: { method?: string; token?: string; body?: unknown }, options = OPTIONS) =>
    handleRequest(
      new Request(`https://penguin.example${path}`, {
        method: init.method ?? "POST",
        headers: init.token ? { Authorization: `Bearer ${init.token}` } : {},
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      options,
      handlers,
    );
  return { artifacts, call, registry };
}

type Call = ReturnType<typeof gateway>["call"];

async function registerBridge(call: Call, owner: string, role?: string): Promise<{ bridgeId: string; bridgeToken: string }> {
  const codeResponse = await call("/bridges/codes", { token: DEPLOYER_TOKEN, body: { owner, role } });
  assert.equal(codeResponse.status, 201);
  assert.equal(codeResponse.headers.get("Cache-Control"), "no-store");
  const { code } = (await codeResponse.json()) as { code: string };
  const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
  const response = await call("/bridges", { body: { code, publicKey } });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { bridgeId: string; bridgeToken: string; owner: string; role: string };
  assert.equal(body.owner, owner);
  assert.equal(body.role, role ?? "owner");
  return body;
}

function requestToken(call: Call, bridgeToken: string | undefined, repo: string, scope: TokenScope, options = OPTIONS) {
  return call("/tokens", { ...(bridgeToken ? { token: bridgeToken } : {}), body: { repo, scope } }, options);
}

test("jun's bridge gets write on owner-jun and issues and read on owner-priya", async () => {
  const { call, artifacts } = gateway();
  const jun = await registerBridge(call, "jun");
  const started = Date.now();
  for (const [repo, scope] of [
    ["owner-jun", "write"],
    ["issues", "write"],
    ["owner-priya", "read"],
    ["base", "read"],
    ["huddle-031", "read"],
  ] as const) {
    const response = await requestToken(call, jun.bridgeToken, repo, scope);
    assert.equal(response.status, 200, `${repo} ${scope}`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = (await response.json()) as { repo: string; scope: string; token: string; expiresAt: string };
    assert.equal(body.repo, repo);
    assert.equal(body.scope, scope);
    assert.match(body.token, /^art_/);
    // Every token expires no later than the configured TTL.
    assert.ok(Date.parse(body.expiresAt) <= Date.now() + TTL * 1000, body.expiresAt);
    assert.ok(Date.parse(body.expiresAt) >= started + TTL * 1000 - 1000, body.expiresAt);
  }
  assert.deepEqual(
    artifacts.minted.map((token) => token.repo),
    ["test-owner-jun", "test-issues", "test-owner-priya", "test-base", "test-huddle-031"],
  );
});

test("jun's bridge is refused write on another owner's fork, the base repo and a Huddle repo", async () => {
  const { call, artifacts } = gateway();
  const jun = await registerBridge(call, "jun");
  for (const repo of ["owner-priya", "base", "huddle-031"]) {
    const response = await requestToken(call, jun.bridgeToken, repo, "write");
    assert.equal(response.status, 403, repo);
  }
  assert.equal(artifacts.minted.length, 0);
});

test("a runner bridge gets write on a Huddle repo", async () => {
  const { call } = gateway();
  const runner = await registerBridge(call, "sam", "runner");
  assert.equal((await requestToken(call, runner.bridgeToken, "huddle-031", "write")).status, 200);
  assert.equal((await requestToken(call, runner.bridgeToken, "issues", "write")).status, 200);
  assert.equal((await requestToken(call, runner.bridgeToken, "owner-jun", "write")).status, 403);
});

test("an unregistered or revoked bridge gets 401", async () => {
  const { call, artifacts } = gateway();
  assert.equal((await requestToken(call, undefined, "issues", "read")).status, 401);
  assert.equal((await requestToken(call, "pgb_unregistered", "issues", "read")).status, 401);
  assert.equal((await requestToken(call, DEPLOYER_TOKEN, "issues", "read")).status, 401);

  const jun = await registerBridge(call, "jun");
  assert.equal((await call(`/bridges/${jun.bridgeId}`, { method: "DELETE" })).status, 401);
  assert.equal((await call(`/bridges/${jun.bridgeId}`, { method: "DELETE", token: DEPLOYER_TOKEN })).status, 204);
  assert.equal((await call(`/bridges/${jun.bridgeId}`, { method: "DELETE", token: DEPLOYER_TOKEN })).status, 404);
  assert.equal((await requestToken(call, jun.bridgeToken, "owner-jun", "write")).status, 401);
  assert.equal(artifacts.minted.length, 0);
});

test("registration codes need the deployer credential and work once", async () => {
  const { call } = gateway();
  for (const token of [undefined, "wrong"]) {
    const response = await call("/bridges/codes", { ...(token ? { token } : {}), body: { owner: "jun" } });
    assert.equal(response.status, 401);
  }
  const noDeployer = await call("/bridges/codes", { token: DEPLOYER_TOKEN, body: { owner: "jun" } }, { tokenTtlSeconds: TTL, deployerToken: "" });
  assert.equal(noDeployer.status, 401);
  assert.equal((await call("/bridges/codes", { token: DEPLOYER_TOKEN, body: { owner: "../jun" } })).status, 400);
  assert.equal((await call("/bridges/codes", { token: DEPLOYER_TOKEN, body: { owner: "jun", role: "admin" } })).status, 400);

  const { code } = (await (await call("/bridges/codes", { token: DEPLOYER_TOKEN, body: { owner: "jun" } })).json()) as {
    code: string;
  };
  const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
  assert.equal((await call("/bridges", { body: { code, publicKey: { kty: "OKP" } } })).status, 400);
  assert.equal((await call("/bridges", { body: { code, publicKey } })).status, 201);
  assert.equal((await call("/bridges", { body: { code, publicKey } })).status, 401);
  assert.equal((await call("/bridges", { body: { code: "pgr_guess", publicKey } })).status, 401);
});

test("the token route rejects malformed requests and reports a missing repo", async () => {
  const { call } = gateway();
  const jun = await registerBridge(call, "jun");
  assert.equal((await requestToken(call, jun.bridgeToken, "owner-jun", "admin" as TokenScope)).status, 400);
  assert.equal((await requestToken(call, jun.bridgeToken, "../owner-jun", "read")).status, 400);
  assert.equal((await requestToken(call, jun.bridgeToken, "test-owner-jun", "read")).status, 400);
  assert.equal((await requestToken(call, jun.bridgeToken, "owner-sam", "read")).status, 404);
  assert.equal((await call("/tokens", { method: "GET", token: jun.bridgeToken })).status, 405);
  const misconfigured = await requestToken(call, jun.bridgeToken, "issues", "read", {
    deployerToken: DEPLOYER_TOKEN,
    tokenTtlSeconds: undefined as unknown as number,
  });
  assert.equal(misconfigured.status, 500);
});

test("the token TTL setting defaults to an hour and must fall in the range Artifacts accepts", () => {
  assert.equal(parseTokenTtl(undefined), 3600);
  assert.equal(parseTokenTtl(""), 3600);
  assert.equal(parseTokenTtl("60"), 60);
  assert.equal(parseTokenTtl("31536000"), 31_536_000);
  for (const value of ["59", "31536001", "1.5", "-60", "ten"]) assert.equal(parseTokenTtl(value), undefined, value);
});

test("project repo names parse by role", () => {
  assert.deepEqual(parseProjectRepo("issues"), { role: "issues" });
  assert.deepEqual(parseProjectRepo("owner-jun-2"), { role: "owner", ownerId: "jun-2" });
  assert.deepEqual(parseProjectRepo("huddle-031"), { role: "huddle", huddleId: "031" });
  for (const name of ["owner-", "owner-.x", "huddles", "other", ""]) assert.equal(parseProjectRepo(name), undefined, name);
});
