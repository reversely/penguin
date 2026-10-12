import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair } from "@penguin/issues";
import { huddleRepoName } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";
// The registry module directly: the package entry point loads the Agents SDK, which needs workerd.
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import { CombinedRunStore } from "../../../services/project-agent/src/combined-run-schedule.ts";
import type { ProjectRepos } from "../../../services/project-agent/src/index.ts";
import type { Huddle } from "../../../services/project-agent/src/huddle-store.ts";
import { IssueIndex } from "../../../services/project-agent/src/issue-index.ts";
import type { SqlDatabase } from "../../../services/project-agent/src/issue-index.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { OwnerForkStore, recordReportedCheckpoint } from "../../../services/project-agent/src/owner-forks.ts";
import { PlanFactsStore } from "../../../services/project-agent/src/plan-facts.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";

import type { HuddleDirectory } from "../src/bridges.ts";
import { type GatewayHandlers, handleRequest } from "../src/gateway.ts";
import { huddleRepoId, RepoNames } from "../src/repos.ts";
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
        async info() {
          return { remote: `https://account.artifacts.example/git/penguin/${name}.git` };
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
  const db = sqlite();
  const registry = new BridgeRegistry(db);
  const issues = new IssueIndex(db);
  const forks = new OwnerForkStore(db);
  const clock = { now: Date.parse("2026-10-11T12:00:00Z") };
  const identities = new IdentityStore(db);
  const sessions = new SessionStore(db, identities, { now: () => clock.now });
  /** The commits each fork holds, by prefixed repo name, as `readCommit` would find them. */
  const commits = new Map<string, Set<string>>();
  const commitExists = async (repo: string, sha: string) => commits.get(repo)?.has(sha) ?? false;
  const huddles = fakeHuddles();
  const runs = new CombinedRunStore(db);
  const planFacts = new PlanFactsStore(db);
  /** The project repos each checkpoint report handed the ProjectAgent. */
  const checkpointRepos: ProjectRepos[] = [];
  const featureReports: { owner: string; sessionId: string | null; featureId: string; sha: string }[] = [];
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
      pendingOperations: (caller) => issues.pendingFiles(caller),
      reportBridgeCheckpoint: (owner, sha, fork, repos) => {
        checkpointRepos.push(repos);
        return recordReportedCheckpoint({ forks, commitExists }, owner, sha, fork, null);
      },
      claimCombinedRuns: (caller) => runs.claim(caller),
      planFactsRuns: (caller) =>
        caller.role === "runner" ? { status: "ok", runs: planFacts.pending() } : { status: "forbidden", message: "not a runner" },
      reportPlanFacts: (caller, runId, report) => planFacts.record(runId, caller.bridgeId, report),
      sessionCheckpoint: (owner, worktreeId) => sessions.checkpointWorktree(owner, worktreeId),
      // Feature checkpoints are covered end to end in features.test.ts; here
      // the route's handling of the owner and the answer.
      reportFeatureCheckpoint: async (owner, sessionId, featureId, sha) => {
        featureReports.push({ owner, sessionId, featureId, sha });
        if (featureId !== "tax-rounding" || owner !== "jun") {
          return { status: "rejected", reason: "forbidden", message: `feature ${featureId} belongs to another person` };
        }
        const area = { scopes: ["analytics"], paths: ["analytics/report.py"], contracts: [] };
        const feature = { id: featureId, personId: owner, repo: "test-feature-tax-rounding", area, state: "building" as const, openedAt: "", latestCheckpointSha: sha, updatedAt: "" };
        return { status: "ok", feature, baselineSha: "b".repeat(40), changedPaths: 1, omittedPaths: 0, delivered: [], threads: [], overlaps: [], settled: [], planNotices: { parts: [], decisions: [], reviews: [] }, durationMs: 3 };
      },
    }),
    ownerForkRepo: (owner) => names.owner(owner),
    projectRepos: { issues: names.issues, base: names.base },
    huddles: () => huddles,
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
  return { artifacts, call, registry, db, forks, commits, huddles, identities, sessions, clock, runs, planFacts, checkpointRepos, featureReports };
}

/**
 * The ProjectAgent's Huddle opening as the route sees it: the first report of a trigger opens issue
 * 31, later ones find it. Forks are recorded; `failForks` makes the next fork calls throw.
 */
function fakeHuddles() {
  let huddle: Huddle | undefined;
  const opened: { event: unknown; triggerFork: string }[] = [];
  const forked: string[] = [];
  const state = { failForks: 0 };
  const reports: { runId: string; runnerId: string; report: unknown }[] = [];
  const approvals: { issueId: string; runnerId: string; report: unknown }[] = [];
  const directory: HuddleDirectory = {
    async open(event, triggerFork) {
      opened.push({ event, triggerFork });
      if (huddle !== undefined) return { status: "existing", huddle };
      huddle = {
        triggerCommit: "owner-priya@" + "a".repeat(40),
        triggerOwner: "priya",
        triggerSha: "a".repeat(40),
        baselineSha: "b".repeat(40),
        triggerScopes: ["identity-map"],
        event: event as Huddle["event"],
        issueId: "31",
        status: "open",
        huddleRepo: null,
        openedAt: "2026-10-11T00:00:00.000Z",
      };
      return { status: "opened", huddle, operations: 20 };
    },
    async recordRepo(triggerCommit, huddleRepo) {
      assert.equal(triggerCommit, huddle?.triggerCommit);
      huddle = { ...(huddle as Huddle), huddleRepo };
      return huddle;
    },
    async forkRepo(huddleId) {
      if (state.failForks > 0) {
        state.failForks -= 1;
        throw new ArtifactsError("FORK_IN_PROGRESS", "fork in progress");
      }
      forked.push(huddleId);
      return { name: names.huddle(huddleId) };
    },
    async pendingVerifications() {
      return [{ runId: "7", issueId: "31", huddleRepo: "huddle-031" }];
    },
    // Run 7 records, run 6 was superseded, run 8 does not exist.
    async reportVerification(runId, runnerId, report) {
      reports.push({ runId, runnerId, report });
      if (runId === "6") return { status: "superseded", message: "run 6 was superseded" };
      if (runId === "8") return { status: "rejected", reason: "not_found", message: "no verification run 8" };
      return { status: "recorded", issueId: "31", state: "in_review", commit: `huddle-031@${"c".repeat(40)}` };
    },
    async pendingApprovals() {
      return [{ issueId: "31", huddleRepo: "huddle-031", sha: "c".repeat(40) }];
    },
    // Issue 31's branch records, issue 30 was requested at another commit, issue 29 is no Huddle.
    async reportApproval(issueId, runnerId, report) {
      approvals.push({ issueId, runnerId, report });
      if (issueId === "30") return { status: "rejected", reason: "stale", message: "requested at another commit" };
      if (issueId === "29") return { status: "rejected", reason: "not_found", message: "no Huddle has issue 29" };
      return { status: "recorded", issueId, state: "closed", commit: `huddle-031@${"c".repeat(40)}` };
    },
  };
  return Object.assign(directory, { opened, forked, state, reports, approvals });
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
    const body = (await response.json()) as { repo: string; scope: string; token: string; remote: string; expiresAt: string };
    assert.equal(body.repo, repo);
    assert.equal(body.scope, scope);
    assert.match(body.token, /^art_/);
    // The remote names the prefixed repo and never carries the token.
    assert.equal(body.remote, `https://account.artifacts.example/git/penguin/test-${repo}.git`);
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

test("a runner bridge reads a feature's fork for its reviews and never writes it", async () => {
  const { call, artifacts } = gateway(fakeArtifacts([...PROJECT_REPOS, "test-feature-person-id"]));
  const runner = await registerBridge(call, "sam", "runner");
  assert.equal((await requestToken(call, runner.bridgeToken, "feature-person-id", "read")).status, 200);
  assert.equal((await requestToken(call, runner.bridgeToken, "feature-person-id", "write")).status, 403);
  assert.deepEqual(artifacts.minted.map((token) => [token.repo, token.scope]), [["test-feature-person-id", "read"]]);
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
  assert.deepEqual(parseProjectRepo("feature-person-id"), { role: "feature", featureId: "person-id" });
  for (const name of ["owner-", "owner-.x", "huddles", "feature-", "other", ""]) assert.equal(parseProjectRepo(name), undefined, name);
});

test("the pending route lists operations to a runner bridge only, by the role its token holds", async () => {
  const { call, db } = gateway();
  // A signed operation file as the ProjectAgent holds it in PendingOp after a submission.
  const file = readFileSync(
    join(import.meta.dirname, "../../../tests/contracts/issue-ops/examples/issues/31/ops/penguin-web-0002.json"),
    "utf8",
  );
  db.exec(`INSERT INTO PendingOp (op_id, source, created_at, file) VALUES (?, ?, ?, ?)`, "penguin-web-0002", "penguin", 1, file);
  const list = (token?: string, method = "GET") => call("/operations/pending", { method, ...(token ? { token } : {}) });

  const runner = await registerBridge(call, "sam", "runner");
  const response = await list(runner.bridgeToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    files: [{ opId: "penguin-web-0002", path: "issues/31/ops/penguin-web-0002.json", file, source: "penguin", createdAt: 1 }],
  });

  // An owner bridge is refused, whatever it claims in the request.
  const jun = await registerBridge(call, "jun");
  assert.equal((await list(jun.bridgeToken)).status, 403);
  assert.equal((await call("/operations/pending?role=runner", { method: "GET", token: jun.bridgeToken })).status, 403);
  assert.equal((await list()).status, 401);
  assert.equal((await list(DEPLOYER_TOKEN)).status, 401);
  assert.equal((await list(runner.bridgeToken, "POST")).status, 405);

  // A revoked runner loses the listing.
  assert.equal((await call(`/bridges/${runner.bridgeId}`, { method: "DELETE", token: DEPLOYER_TOKEN })).status, 204);
  assert.equal((await list(runner.bridgeToken)).status, 401);
});

test("only a runner bridge claims scheduled combined runs, which carry command IDs and no command", async () => {
  const { call, runs } = gateway();
  const trigger = { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) };
  runs.schedule({ trigger, ownerId: "jun", ownerCheckpoint: "c".repeat(40), commandIds: ["test:analytics"] });
  const claim = (token?: string, method = "POST") => call("/combined-runs/claim", { method, ...(token ? { token } : {}) });

  // An owner bridge is refused and the run stays scheduled.
  const jun = await registerBridge(call, "jun");
  const refused = await claim(jun.bridgeToken);
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { message: string }).message, /runner role/);
  assert.equal((await claim()).status, 401);
  assert.equal((await claim(DEPLOYER_TOKEN)).status, 401);

  const runner = await registerBridge(call, "sam", "runner");
  assert.equal((await claim(runner.bridgeToken, "GET")).status, 405);
  const response = await claim(runner.bridgeToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { runs: claimed } = (await response.json()) as { runs: Record<string, unknown>[] };
  assert.equal(claimed.length, 1);
  const { runId, ...run } = claimed[0] as Record<string, unknown>;
  assert.equal(typeof runId, "string");
  assert.deepEqual(run, {
    trigger,
    target: "jun",
    fork: "owner-jun",
    ownerId: "jun",
    ownerCheckpoint: "c".repeat(40),
    commandIds: ["test:analytics"],
  });
  assert.equal(runs.get(runId as string)?.claimedBy, runner.bridgeId);
  // Claimed runs are not handed out twice.
  assert.deepEqual(await (await claim(runner.bridgeToken)).json(), { runs: [] });
});

test("a bridge report records its owner's latest checkpoint with no agent session", async () => {
  const { call, forks, commits, checkpointRepos } = gateway();
  const sha = "4c1d9e0a7b3f2e8d6c5b4a3928170f6e5d4c3b2a"; // pragma: allowlist secret
  commits.set("test-owner-jun", new Set([sha]));
  commits.set("test-owner-priya", new Set([sha]));
  const report = (token: string | undefined, body: unknown, method = "POST") =>
    call("/checkpoints", { method, ...(token ? { token } : {}), body });

  const jun = await registerBridge(call, "jun");
  const response = await report(jun.bridgeToken, { sha, fork: "penguin:owner-jun" });
  assert.equal(response.status, 200);
  const { reportedAt, ...body } = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { fork: "owner-jun", ownerId: "jun", latestCheckpointSha: sha });
  const recorded = forks.get("jun");
  assert.equal(recorded?.reportedAt, reportedAt);
  assert.equal(recorded?.artifactsRepo, "test-owner-jun");
  assert.equal(recorded?.latestCheckpointSha, sha);
  assert.equal(recorded?.reportedBySession, null);
  // The agent reads the scope map and baseline from the deployment's own repos to schedule combined runs.
  assert.deepEqual(checkpointRepos, [{ issues: "test-issues", base: "test-base" }]);

  // Another owner's fork is refused, whatever owner the body claims.
  const priya = await report(jun.bridgeToken, { sha, fork: "owner-priya", owner: "priya" });
  assert.equal(priya.status, 403);
  assert.equal(forks.get("priya"), undefined);

  // A commit the fork does not hold, a malformed SHA or fork, and a missing token are refused.
  const missing = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"; // pragma: allowlist secret
  assert.equal((await report(jun.bridgeToken, { sha: missing, fork: "owner-jun" })).status, 422);
  assert.equal((await report(jun.bridgeToken, { sha: sha.slice(0, 7), fork: "owner-jun" })).status, 400);
  assert.equal((await report(jun.bridgeToken, { sha, fork: "issues" })).status, 400);
  assert.equal((await report(undefined, { sha, fork: "owner-jun" })).status, 401);
  assert.equal((await report(DEPLOYER_TOKEN, { sha, fork: "owner-jun" })).status, 401);
  assert.equal((await call("/checkpoints", { method: "GET", token: jun.bridgeToken })).status, 405);
  assert.equal(forks.get("jun")?.latestCheckpointSha, sha);
});

test("a bridge report on a feature's fork updates the feature as the bridge's owner, never the body's", async () => {
  const { call, featureReports, forks } = gateway();
  const sha = "4c1d9e0a7b3f2e8d6c5b4a3928170f6e5d4c3b2a"; // pragma: allowlist secret
  const jun = await registerBridge(call, "jun");
  const response = await call("/checkpoints", { token: jun.bridgeToken, body: { sha, fork: "penguin:feature-tax-rounding", owner: "priya" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body["fork"], "feature-tax-rounding");
  assert.equal(body["latestCheckpointSha"], sha);
  assert.deepEqual(body["area"], { scopes: ["analytics"], paths: ["analytics/report.py"], contracts: [] });
  assert.deepEqual(featureReports, [{ owner: "jun", sessionId: null, featureId: "tax-rounding", sha }]);

  const priya = await registerBridge(call, "priya");
  assert.equal((await call("/checkpoints", { token: priya.bridgeToken, body: { sha, fork: "feature-tax-rounding" } })).status, 403);
  for (const fork of ["feature-../base", "feature--rf", "feature-<b>x</b>", "feature-Tax"]) {
    assert.equal((await call("/checkpoints", { token: jun.bridgeToken, body: { sha, fork } })).status, 400, fork);
  }
  assert.equal(featureReports.length, 2);
  assert.equal(forks.get("jun"), undefined);
});

test("a bridge's session checkpoint reaches only its owner's running sessions in that worktree", async () => {
  const { call, identities, sessions, clock } = gateway();
  const scopes = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json");
  const scopeMap = parseScopeMap(JSON.parse(readFileSync(scopes, "utf8")));
  for (const [owner, handle, scope] of [
    ["jun", "@jun/reports", "analytics"],
    ["priya", "@priya/merge-rules", "identity-map"],
  ] as const) {
    const input = { handle, name: handle.slice(handle.indexOf("/") + 1), job: "Fix", charterScopes: [scope], autoAccept: true };
    assert.equal(identities.create(owner, input, scopeMap).status, "ok");
  }
  const register = (owner: string, identity: string, worktreeId: string) => {
    const outcome = sessions.register(owner, { identity, vendor: "claude-code", worktreeId, branch: "main" });
    assert.ok(outcome.status === "ok");
    return outcome.session.id;
  };
  const junHere = register("jun", "@jun/reports", "wt_0123456789abcdef");
  register("jun", "@jun/reports", "wt_fedcba9876543210");
  // Another owner's session that happens to use the same worktree id.
  register("priya", "@priya/merge-rules", "wt_0123456789abcdef");
  const jun = await registerBridge(call, "jun");
  const checkpoint = (token: string | undefined, body: unknown, method = "POST") =>
    call("/sessions/checkpoint", { method, ...(token ? { token } : {}), body });

  clock.now += 30_000;
  const response = await checkpoint(jun.bridgeToken, { worktreeId: "wt_0123456789abcdef", owner: "priya" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    worktreeId: "wt_0123456789abcdef",
    sessions: [{ sessionId: junHere, identity: "@jun/reports", delivered: [], threads: [], overlaps: [], locksSettled: [], toolResults: [], newPlanParts: [], planDecisions: [], reviewResults: [] }],
  });
  // The checkpoint counts as that session's heartbeat; the other sessions were not touched.
  const seen = sessions.running().map((session) => [session.id === junHere, Date.parse(session.lastSeen) === clock.now]);
  assert.deepEqual(seen.sort(), [[false, false], [false, false], [true, true]]);

  assert.equal((await checkpoint(jun.bridgeToken, { worktreeId: "wt/0123" })).status, 400);
  assert.equal((await checkpoint(jun.bridgeToken, {})).status, 400);
  assert.equal((await checkpoint(undefined, { worktreeId: "wt_0123456789abcdef" })).status, 401);
  assert.equal((await checkpoint(DEPLOYER_TOKEN, { worktreeId: "wt_0123456789abcdef" })).status, 401);
  assert.equal((await call("/sessions/checkpoint", { method: "GET", token: jun.bridgeToken })).status, 405);
});

test("a runner's combined-run report opens a Huddle and forks its repo once", async () => {
  const { call, huddles } = gateway();
  const event = { trigger: { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) } };
  const report = (token: string | undefined, body: unknown = event) =>
    call("/combined-runs", { ...(token ? { token } : {}), body });

  const runner = await registerBridge(call, "sam", "runner");
  huddles.state.failForks = 1;
  // The issue opens, but the fork fails: the route says so and a later report forks again.
  const failed = await report(runner.bridgeToken);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    status: "opened",
    issueId: "31",
    triggerCommit: `owner-priya@${"a".repeat(40)}`,
    baselineSha: "b".repeat(40),
    huddleRepo: null,
    openedAt: "2026-10-11T00:00:00.000Z",
    forkError: "FORK_IN_PROGRESS",
  });

  const retried = await report(runner.bridgeToken);
  assert.equal(retried.status, 200);
  assert.deepEqual(
    { ...((await retried.json()) as Record<string, unknown>), openedAt: undefined },
    {
      status: "existing",
      issueId: "31",
      triggerCommit: `owner-priya@${"a".repeat(40)}`,
      baselineSha: "b".repeat(40),
      huddleRepo: "test-huddle-031",
      openedAt: undefined,
    },
  );
  const third = await report(runner.bridgeToken);
  assert.equal(third.status, 200);
  assert.deepEqual(huddles.forked, ["031"]);
  // The trigger owner's fork is named by the Worker from the owner id.
  assert.deepEqual(
    huddles.opened.map((entry) => entry.triggerFork),
    ["test-owner-priya", "test-owner-priya", "test-owner-priya"],
  );

  // Only a runner bridge may report; the owner id must be one.
  const jun = await registerBridge(call, "jun");
  assert.equal((await report(jun.bridgeToken)).status, 403);
  assert.equal((await report(undefined)).status, 401);
  assert.equal((await report(DEPLOYER_TOKEN)).status, 401);
  assert.equal((await report(runner.bridgeToken, { trigger: { ownerId: "../x" } })).status, 400);
  assert.equal((await call("/combined-runs", { method: "GET", token: runner.bridgeToken })).status, 405);
  assert.equal(huddles.opened.length, 3);
});

test("only a runner lists and reports verification runs; a superseded run answers 409", async () => {
  const { call, huddles } = gateway();
  const runner = await registerBridge(call, "sam", "runner");
  const jun = await registerBridge(call, "jun");

  const listed = await call("/verifications", { method: "GET", token: runner.bridgeToken });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { runs: [{ runId: "7", issueId: "31", huddleRepo: "huddle-031" }] });
  assert.equal((await call("/verifications", { method: "GET", token: jun.bridgeToken })).status, 403);
  assert.equal((await call("/verifications", { method: "GET" })).status, 401);
  assert.equal((await call("/verifications", { token: runner.bridgeToken, body: {} })).status, 405);

  const report = (runId: string, token = runner.bridgeToken) =>
    call(`/verifications/${runId}`, { token, body: { status: "tested" } });
  const recorded = await report("7");
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), {
    status: "recorded",
    issueId: "31",
    state: "in_review",
    commit: `huddle-031@${"c".repeat(40)}`,
  });
  // The runner is named from its token, never from the request.
  assert.equal(huddles.reports[0]?.runnerId, runner.bridgeId);
  assert.equal((await report("6")).status, 409);
  assert.equal((await report("8")).status, 404);
  assert.equal((await report("7", jun.bridgeToken)).status, 403);
  assert.equal(huddles.reports.length, 3);
});

test("only a runner lists and reports plan facts runs; a report is checked and taken once", async () => {
  const { call, planFacts } = gateway();
  const runner = await registerBridge(call, "sam", "runner");
  const jun = await registerBridge(call, "jun");
  const sha = "a".repeat(40);
  const target = { id: "main", repo: "feature-money", sha, scopes: [], commandIds: ["test:tax"] };
  const run = planFacts.schedule({ feature: "money", fork: "feature-money", checkpoint: sha, baseline: sha, targets: [target] });

  const listed = await call("/plan-facts", { method: "GET", token: runner.bridgeToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await listed.json(), { runs: [run.request] });
  assert.equal((await call("/plan-facts", { method: "GET", token: jun.bridgeToken })).status, 403);
  assert.equal((await call("/plan-facts", { method: "GET" })).status, 401);

  const report = (runId: string, body: unknown, token = runner.bridgeToken) => call(`/plan-facts/${runId}`, { token, body });
  const facts = { impact: null, impactError: "python3 not found", results: [], durationMs: 3 };
  assert.equal((await report(run.runId, { ...facts, log: "raw output" })).status, 400);
  assert.equal((await report(run.runId, facts, jun.bridgeToken)).status, 403);
  const recorded = await report(run.runId, facts);
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), { status: "recorded", runId: run.runId });
  assert.equal(planFacts.get(run.runId)?.runnerId, runner.bridgeId);
  assert.equal((await report(run.runId, facts)).status, 409);
  assert.equal((await report("99", facts)).status, 404);
});

test("only a runner lists and reports approved branches; a commit no longer requested answers 409", async () => {
  const { call, huddles } = gateway();
  const runner = await registerBridge(call, "sam", "runner");
  const jun = await registerBridge(call, "jun");
  const sha = "c".repeat(40);

  const listed = await call("/approvals", { method: "GET", token: runner.bridgeToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await listed.json(), { approvals: [{ issueId: "31", huddleRepo: "huddle-031", sha }] });
  assert.equal((await call("/approvals", { method: "GET", token: jun.bridgeToken })).status, 403);
  assert.equal((await call("/approvals", { method: "GET" })).status, 401);
  assert.equal((await call("/approvals", { token: runner.bridgeToken, body: {} })).status, 405);

  const report = (issueId: string, token = runner.bridgeToken) => call(`/approvals/${issueId}`, { token, body: { sha } });
  const recorded = await report("31");
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), { status: "recorded", issueId: "31", state: "closed", commit: `huddle-031@${sha}` });
  // The runner is named from its token, never from the request.
  assert.equal(huddles.approvals[0]?.runnerId, runner.bridgeId);
  assert.equal((await report("30")).status, 409);
  assert.equal((await report("29")).status, 404);
  assert.equal((await report("31", jun.bridgeToken)).status, 403);
  // An issue is named by its number alone, so a padded one is no approval route.
  assert.notEqual((await call("/approvals/031", { token: runner.bridgeToken, body: { sha } })).status, 200);
  assert.equal(huddles.approvals.length, 3);
});

test("the Worker forks the Huddle repo the runner is told to push to", () => {
  for (const issueId of ["1", "31", "1234"]) assert.equal(`huddle-${huddleRepoId(issueId)}`, huddleRepoName(issueId));
});
