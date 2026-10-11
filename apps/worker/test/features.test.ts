// Opening a feature (#87, PRD 0.4 section 4.1 steps 1 and 2) without the network: agent sessions call
// the real MCP tools, which reach the ProjectAgent's real stores and the Worker's feature module. The
// Artifacts binding is a fake that counts forks and mints, and a real Git repo on disk stands in for
// main and the feature's fork when a checkpoint updates the declared area.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";

import { generateSigningKeyPair, verifyOperation } from "@penguin/issues";
import { serveMcp, type McpProject } from "@penguin/mcp";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { mcpFeatures, openFeatureWithFork, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import { forkFeatureRepo, RepoNames, type ArtifactsNamespace, type CreatedRepo } from "../src/repos.ts";
import { checkpointChange } from "../../../services/project-agent/src/combined-run-schedule.ts";
import {
  declareArea,
  featureTokenGrant,
  openFeature,
  recordFeatureRepo,
  reportFeatureCheckpoint,
  type FeatureDeps,
} from "../../../services/project-agent/src/feature-open.ts";
import { FeatureStore, signFeatureRecord, type FeatureRecord } from "../../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { IssueIndex } from "../../../services/project-agent/src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../../../services/project-agent/src/service-key.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";
import { GitRepo, sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const PREFIX = "t-";
const TTL_MINUTES = 30;
const fixture = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json");

/**
 * The fixture's scope map with one contract per scope, `<first path>/api.py::public_api`, since no
 * fixture lists contracts yet.
 */
function scopesWithContracts(): { map: ScopeMap; contracts: Map<string, string> } {
  const file = JSON.parse(readFileSync(fixture, "utf8")) as { scopes: { id: string; paths: string[]; contracts?: string[] }[] };
  const contracts = new Map<string, string>();
  for (const scope of file.scopes) {
    const contract = `${scope.paths[0]?.replace(/\/$/u, "")}/api.py::public_api`;
    scope.contracts = [contract];
    contracts.set(scope.id, contract);
  }
  return { map: parseScopeMap(file), contracts };
}

const { map: scopeMap, contracts: contractOf } = scopesWithContracts();
const [firstScope, secondScope] = [...scopeMap.scopes.values()];
if (firstScope === undefined || secondScope === undefined) throw new Error("the fixture needs two scopes");

let service: ServiceKey;
let servicePublic: CryptoKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  servicePublic = service.publicKey;
});

/** A fake Artifacts namespace: only the base repo, forked through `get(base).fork()`. */
class FakeArtifacts implements ArtifactsNamespace {
  readonly repos = new Set<string>([`${PREFIX}base`]);
  readonly forks: { name: string; defaultBranchOnly: boolean | undefined }[] = [];

  async create(): Promise<CreatedRepo> {
    throw new Error("not used");
  }
  async import(): Promise<CreatedRepo> {
    throw new Error("not used");
  }
  async list() {
    return { repos: [...this.repos].map((name) => ({ name })) };
  }
  async get(name: string) {
    if (!this.repos.has(name)) throw Object.assign(new Error(`ArtifactsError: repository not found: ${name}`), { code: "NOT_FOUND" });
    return {
      log: async () => [{ hash: "base" }],
      fork: async (forkName: string, opts?: { defaultBranchOnly?: boolean }) => {
        this.forks.push({ name: forkName, defaultBranchOnly: opts?.defaultBranchOnly });
        if (this.repos.has(forkName)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
        this.repos.add(forkName);
        return { name: forkName, remote: `https://artifacts.test/git/penguin/${forkName}.git` };
      },
      [Symbol.dispose]() {},
    };
  }
}

/** One project's stores and Worker ports, wired as the ProjectAgent and the Worker wire them. */
class Project {
  readonly sqlite = sqlite();
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features: FeatureStore;
  readonly artifacts = new FakeArtifacts();
  readonly names = new RepoNames(PREFIX);
  /** Every token minted: the repo and TTL. The plaintext is kept only to look for leaks. */
  readonly mints: { repo: string; ttl: number; token: string }[] = [];
  readonly git = new GitRepo();
  readonly ports: FeaturePorts;

  constructor() {
    const sql = this.sqlite.sql;
    let next = 0;
    this.identities = new IdentityStore(sql, () => `identity-${++next}`);
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(sql, {
      assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
    });
    sessions = new SessionStore(sql, this.identities, { assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle) });
    this.sessions = sessions;
    this.features = new FeatureStore(sql);
    for (const scope of scopeMap.scopes.values()) {
      const outcome = this.identities.create(
        scope.ownerId,
        { handle: `@${scope.ownerId}/agent`, name: "agent", job: "Build features", charterScopes: [scope.id], autoAccept: true },
        scopeMap,
      );
      assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    }
    const deps = this.deps();
    const directory: FeatureDirectory = {
      openFeature: (owner, input, sessionId) => openFeature(deps, owner, input, sessionId),
      recordFeatureRepo: (featureId, repo) => recordFeatureRepo(this.features, featureId, repo),
      featureTokenGrant: (owner, sessionId, featureId) => featureTokenGrant(deps, owner, sessionId, featureId),
      declareFeatureArea: (owner, featureId, area, sessionId) => declareArea(deps, owner, featureId, area, sessionId),
      reportFeatureCheckpoint: (owner, sessionId, featureId, sha) => reportFeatureCheckpoint(this.checkpointDeps(), owner, sessionId, featureId, sha),
      features: () => this.features.list(),
    };
    this.ports = {
      directory: () => directory,
      fork: (featureId, options) => forkFeatureRepo(this.artifacts, featureId, this.names, options),
      mintWrite: async (repo, ttl) => {
        const token = `art_${crypto.randomUUID()}`;
        this.mints.push({ repo, ttl, token });
        return { token, remote: `https://artifacts.test/git/penguin/${repo}.git`, scope: "write", expiresAt: "2026-10-11T12:30:00Z" };
      },
      repos: { issues: this.names.issues, base: this.names.base },
      config: { forkOptions: { defaultBranchOnly: true }, tokenTtlSeconds: TTL_MINUTES * 60 },
    };
  }

  deps(): FeatureDeps {
    return {
      features: this.features,
      scopeMap: async () => scopeMap,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      sign: (record) => signFeatureRecord(record, service.privateKey),
    };
  }

  checkpointDeps() {
    const reader = this.git.reader();
    return {
      ...this.deps(),
      // The fork and main live in one repo on disk: main is its `main` branch.
      commitExists: async (_repo: string, sha: string) => {
        try {
          return this.git.git("cat-file", "-t", sha) === "commit";
        } catch {
          return false;
        }
      },
      readChange: (_repo: string, sha: string) => checkpointChange(reader, reader, sha),
      deliver: (caller: string, sessionId: string) => {
        const delivery = this.sessions.checkpoint(caller, sessionId);
        return delivery.status === "ok" ? delivery : undefined;
      },
    };
  }

  register(owner: string): string {
    const outcome = this.sessions.register(owner, {
      identity: `@${owner}/agent`,
      vendor: "claude-code",
      worktreeId: `wt_${crypto.randomUUID().slice(0, 8)}`,
      branch: "feature",
    });
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return outcome.status === "ok" ? outcome.session.id : "";
  }

  /** Every text value stored in any table, to look for token plaintext. */
  storedText(): string {
    const tables = this.sqlite.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    return tables
      .map(({ name }) => JSON.stringify(this.sqlite.db.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n");
  }
}

let nextId = 0;

/** Calls one MCP tool as `owner` and returns its structured result. */
async function call(project: Project, owner: string, name: string, args: unknown): Promise<{ value: any; isError: boolean }> {
  const request = new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
  });
  const repos = { issues: project.names.issues, base: project.names.base, ownerFork: project.names.owner(owner) };
  const unused = {} as McpProject;
  const response = await serveMcp(request, owner, () => unused, repos, mcpFeatures(project.ports, owner));
  const text = await response.text();
  const data = text.includes("data: ") ? (text.split("\n").find((line) => line.startsWith("data: ")) as string).slice(6) : text;
  const parsed = JSON.parse(data);
  assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
  return { value: parsed.result.structuredContent, isError: parsed.result.isError === true };
}

const owner = firstScope.ownerId;
const other = secondScope.ownerId;

describe("opening a feature", () => {
  let project: Project;
  beforeEach(() => {
    project = new Project();
  });

  test("opening the same id twice makes one fork and reports the second call as already open", async () => {
    const first = project.register(owner);
    const second = project.register(owner);
    const area = { scopes: [firstScope.id], contracts: [contractOf.get(firstScope.id)] };
    const opened = await call(project, owner, "open_feature", { sessionId: first, feature: "tax-rounding", area });
    assert.equal(opened.isError, false, JSON.stringify(opened.value));
    assert.equal(opened.value.status, "opened");
    assert.equal(opened.value.feature.fork, "feature-tax-rounding");
    assert.equal(opened.value.feature.state, "building");

    const again = await call(project, owner, "open_feature", { sessionId: second, feature: "tax-rounding" });
    assert.equal(again.value.status, "existing");
    assert.deepEqual(project.artifacts.forks, [{ name: `${PREFIX}feature-tax-rounding`, defaultBranchOnly: true }]);
    assert.equal(again.value.timings.forkMs, null);
    // Both sessions are now the feature's agents, each with its own token.
    assert.deepEqual(project.features.sessions("tax-rounding"), [first, second]);
    assert.notEqual(opened.value.token.token, again.value.token.token);
    const records = project.features.records("tax-rounding").map((stored) => JSON.parse(stored.file) as FeatureRecord);
    assert.deepEqual(records.map((record) => record.type), ["open_feature"]);
  });

  test("the opening record is signed with the service key and names its record repo path", async () => {
    const session = project.register(owner);
    await call(project, owner, "open_feature", { sessionId: session, feature: "tax-rounding", area: { scopes: [firstScope.id] } });
    const [stored] = project.features.records("tax-rounding");
    const record = JSON.parse(stored?.file ?? "{}") as FeatureRecord;
    assert.equal(stored?.path, `records/tax-rounding/${record.record_id}.json`);
    assert.deepEqual(record.author, { identity: `@${owner}/agent` });
    assert.deepEqual(record.payload, { person: owner, area: { scopes: [firstScope.id], paths: [], contracts: [] } });
    // The record is signed over the same canonical JSON as an issue operation.
    assert.equal(await verifyOperation(record as never, servicePublic), true);
    assert.equal(await verifyOperation({ ...record, feature: "other" } as never, servicePublic), false);
  });

  test("a person opens a feature from the dashboard with no session and gets no token", async () => {
    const opened = await openFeatureWithFork(project.ports, owner, { feature: "ledger", area: { paths: ["ledger/"] } }, null);
    assert.equal(opened.status, "opened");
    assert.equal(opened.status === "opened" && opened.token, null);
    assert.equal(project.mints.length, 0);
    assert.deepEqual(project.features.get("ledger")?.area.paths, ["ledger"]);
  });

  test("another person cannot open or join a feature that is already open", async () => {
    await openFeatureWithFork(project.ports, owner, { feature: "ledger" }, null);
    const session = project.register(other);
    const refused = await call(project, other, "open_feature", { sessionId: session, feature: "ledger" });
    assert.equal(refused.isError, true);
    assert.equal(refused.value.error, "forbidden");
    assert.deepEqual(project.features.sessions("ledger"), []);
    assert.equal(project.artifacts.forks.length, 1);
  });

  test("without the fork options or the token lifetime in configuration, opening refuses", async () => {
    const unset = { ...project.ports, config: { forkOptions: undefined, tokenTtlSeconds: TTL_MINUTES * 60 } };
    assert.equal((await openFeatureWithFork(unset, owner, { feature: "ledger" }, null)).status, "misconfigured");
    const noTtl = { ...project.ports, config: { forkOptions: { defaultBranchOnly: false }, tokenTtlSeconds: undefined } };
    const session = project.register(owner);
    assert.equal((await openFeatureWithFork(noTtl, owner, { feature: "ledger" }, session)).status, "misconfigured");
    assert.equal(project.features.get("ledger"), undefined);
    assert.equal(project.artifacts.forks.length, 0);
  });
});

describe("write tokens on a feature's fork", () => {
  let project: Project;
  let session: string;
  beforeEach(async () => {
    project = new Project();
    session = project.register(owner);
    await call(project, owner, "open_feature", { sessionId: session, feature: "tax-rounding" });
    await openFeatureWithFork(project.ports, owner, { feature: "ledger" }, null);
  });

  test("a token is write on exactly the feature's fork, for the configured minutes", async () => {
    const fresh = await call(project, owner, "feature_token", { sessionId: session, feature: "tax-rounding" });
    assert.equal(fresh.isError, false, JSON.stringify(fresh.value));
    assert.equal(fresh.value.token.fork, "feature-tax-rounding");
    assert.equal(fresh.value.token.scope, "write");
    assert.deepEqual(
      project.mints.map(({ repo, ttl }) => [repo, ttl]),
      [
        [`${PREFIX}feature-tax-rounding`, TTL_MINUTES * 60],
        [`${PREFIX}feature-tax-rounding`, TTL_MINUTES * 60],
      ],
    );
  });

  test("a token cannot be requested for main, another feature's fork or the record repo", async () => {
    const before = project.mints.length;
    const another = await call(project, owner, "feature_token", { sessionId: session, feature: "ledger" });
    assert.equal(another.value.error, "forbidden");
    for (const name of ["main", "base", "record", "issues"]) {
      const refused = await call(project, owner, "feature_token", { sessionId: session, feature: name });
      assert.equal(refused.isError, true, name);
      assert.equal(refused.value.error, "not_found", name);
    }
    // A repo name with the prefix or a path is no feature id: the schema refuses it before any call.
    for (const name of [`${PREFIX}base`, "../base", "feature-ledger/../base"]) {
      const refused = await call(project, owner, "feature_token", { sessionId: session, feature: name });
      assert.equal(refused.isError, true, name);
    }
    assert.equal(project.mints.length, before);
  });

  test("a caller who is not an agent of the feature is refused", async () => {
    const before = project.mints.length;
    // Another session of the same person that never joined the feature.
    const bystander = project.register(owner);
    const notJoined = await call(project, owner, "feature_token", { sessionId: bystander, feature: "tax-rounding" });
    assert.equal(notJoined.value.error, "forbidden");
    // Another person's token naming this person's session.
    const stranger = await call(project, other, "feature_token", { sessionId: session, feature: "tax-rounding" });
    assert.equal(stranger.value.error, "forbidden");
    // Another person's own session.
    const theirs = project.register(other);
    const notTheirs = await call(project, other, "feature_token", { sessionId: theirs, feature: "tax-rounding" });
    assert.equal(notTheirs.value.error, "forbidden");
    assert.equal(project.mints.length, before);
  });

  test("a session works on one feature: joining a second is refused", async () => {
    const refused = await call(project, owner, "open_feature", { sessionId: session, feature: "ledger" });
    assert.equal(refused.value.error, "conflict");
    const another = await call(project, owner, "open_feature", { sessionId: session, feature: "payouts" });
    assert.equal(another.value.error, "conflict");
    assert.equal(project.features.get("payouts"), undefined);
  });

  test("token plaintext is returned once and never logged or stored", async () => {
    const logged: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) console[method] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    let tokens: string[];
    try {
      const joiner = project.register(owner);
      await call(project, owner, "open_feature", { sessionId: joiner, feature: "tax-rounding" });
      await call(project, owner, "feature_token", { sessionId: joiner, feature: "tax-rounding" });
      tokens = project.mints.map((mint) => mint.token);
    } finally {
      methods.forEach((method, index) => (console[method] = originals[index] as never));
    }
    const stored = project.storedText();
    for (const token of tokens) {
      assert.equal(stored.includes(token), false, "a token reached the ProjectAgent's tables");
      assert.equal(logged.some((line) => line.includes(token)), false, "a token was logged");
    }
  });
});

describe("feature ids, scope names, paths and contracts are validated before use", () => {
  let project: Project;
  let deps: FeatureDeps;
  beforeEach(() => {
    project = new Project();
    deps = project.deps();
  });

  async function refused(feature: unknown, area?: unknown): Promise<void> {
    const outcome = await openFeature(deps, owner, { feature, area }, null);
    assert.equal(outcome.status, "rejected", JSON.stringify({ feature, area }));
    assert.equal(outcome.status === "rejected" && outcome.reason, "invalid");
  }

  test("ids with '../', a leading dash, shell metacharacters or markup are rejected", async () => {
    for (const id of ["../main", "a/../b", "-rf", "-", "tax;rm -rf /", "tax$(id)", "tax`id`", "tax|cat", "<b>tax</b>", "tax\nx", "Tax", "x".repeat(64), "", 7]) {
      await refused(id);
    }
    assert.equal(project.features.list().length, 0);
  });

  test("scope names not in penguin/scopes.json, or carrying metacharacters or markup, are rejected", async () => {
    for (const scope of ["no-such-scope", "../" + firstScope.id, "-" + firstScope.id, `${firstScope.id};id`, `<i>${firstScope.id}</i>`]) {
      await refused("tax-rounding", { scopes: [scope] });
    }
    await refused("tax-rounding", { scopes: Array.from({ length: 65 }, () => firstScope.id) });
  });

  test("paths with '..', a leading dash, shell metacharacters or markup are rejected", async () => {
    for (const path of ["../etc/passwd", "billing/../../x", "/etc/passwd", "-rf", "billing/-x", "billing/$(id).py", "a;b", "a b", "<img src=x>", "a\0b", "x".repeat(513)]) {
      await refused("tax-rounding", { paths: [path] });
    }
    await refused("tax-rounding", { paths: Array.from({ length: 257 }, (_, i) => `p${i}`) });
    await refused("tax-rounding", { paths: "billing/" });
  });

  test("contracts must be named in penguin/scopes.json; malformed ones are rejected", async () => {
    const known = contractOf.get(firstScope.id) as string;
    for (const contract of ["billing/api.py::unknown", "../x.py::f", "-x.py::f", `${known.split("::")[0]}::<script>`, `${known};id`, known.replace("::", ":")]) {
      await refused("tax-rounding", { contracts: [contract] });
    }
    const opened = await openFeature(deps, owner, { feature: "tax-rounding", area: { contracts: [`./${known}`] } }, null);
    assert.equal(opened.status, "opened");
    assert.deepEqual(opened.status === "opened" && opened.feature.area.contracts, [known]);
  });

  test("an area with fields beyond scopes, paths and contracts is rejected", async () => {
    await refused("tax-rounding", { scopes: [], owner: "someone" });
    await refused("tax-rounding", ["billing/"]);
  });
});

describe("the declared area", () => {
  let project: Project;
  let session: string;
  beforeEach(async () => {
    project = new Project();
    session = project.register(owner);
    await call(project, owner, "open_feature", { sessionId: session, feature: "tax-rounding", area: { scopes: [firstScope.id] } });
  });

  test("the agent declares it and the person edits it; nobody else can", async () => {
    const declared = await call(project, owner, "declare_area", {
      sessionId: session,
      feature: "tax-rounding",
      area: { scopes: [firstScope.id, secondScope.id], paths: ["billing/tax/"] },
    });
    assert.equal(declared.isError, false, JSON.stringify(declared.value));
    assert.deepEqual(declared.value.feature.area.paths, ["billing/tax"]);
    const edited = await declareArea(project.deps(), owner, "tax-rounding", { paths: ["billing/"] }, null);
    assert.equal(edited.status, "ok");
    assert.deepEqual(edited.status === "ok" && edited.feature.area, { scopes: [], paths: ["billing"], contracts: [] });
    const stranger = await declareArea(project.deps(), other, "tax-rounding", { paths: ["x/"] }, null);
    assert.equal(stranger.status === "rejected" && stranger.reason, "forbidden");
    const types = project.features.records("tax-rounding").map((stored) => (JSON.parse(stored.file) as FeatureRecord).type);
    assert.deepEqual(types, ["open_feature", "declare_area", "declare_area"]);
  });

  test("a checkpoint adds the paths it changed and their scopes, and the update is timed", async (t) => {
    const firstPath = firstScope.paths[0] as string;
    const secondPath = secondScope.paths[0] as string;
    project.git.commit({ [`${firstPath}/base.py`]: "base\n" });
    project.git.git("checkout", "--quiet", "-b", "feature-tax-rounding");
    const sha = project.git.commit({
      [`${firstPath}/rounding.py`]: "def round_half_even(): ...\n",
      [`${secondPath}/report.py`]: "total = 1\n",
      "docs/notes with space.md": "unsafe as area text\n",
    });

    const reported = await call(project, owner, "report_checkpoint", { sessionId: session, sha, fork: "penguin:feature-tax-rounding" });
    assert.equal(reported.isError, false, JSON.stringify(reported.value));
    assert.equal(reported.value.fork, "feature-tax-rounding");
    assert.equal(reported.value.latestCheckpointSha, sha);
    assert.equal(reported.value.changedPaths, 3);
    assert.equal(reported.value.omittedPaths, 1);
    assert.deepEqual(reported.value.area.scopes, [firstScope.id, secondScope.id].sort());
    assert.deepEqual(reported.value.area.paths, [`${firstPath}/rounding.py`, `${secondPath}/report.py`].sort());
    t.diagnostic(`checkpoint declaration update: ${reported.value.durationMs} ms`);

    const [, record] = project.features.records("tax-rounding").map((stored) => JSON.parse(stored.file) as FeatureRecord);
    assert.equal(record?.type, "checkpoint_area");
    assert.equal(record?.payload["checkpoint"], sha);
    assert.equal(await verifyOperation(record as never, servicePublic), true);

    // A path under a declared directory adds nothing new.
    await declareArea(project.deps(), owner, "tax-rounding", { paths: [firstPath] }, null);
    const next = project.git.commit({ [`${firstPath}/more.py`]: "x = 2\n" });
    const again = await call(project, owner, "report_checkpoint", { sessionId: session, sha: next, fork: "feature-tax-rounding" });
    assert.deepEqual(again.value.area.paths, [firstPath.replace(/\/$/u, ""), `${secondPath}/report.py`].sort());
  });

  test("a checkpoint missing from the fork, or from a session not on the feature, is refused", async () => {
    const missing = await call(project, owner, "report_checkpoint", { sessionId: session, sha: "a".repeat(40), fork: "feature-tax-rounding" });
    assert.equal(missing.value.error, "not_found");
    const bystander = project.register(owner);
    const sha = project.git.commit({ "x.py": "1\n" });
    const notAgent = await call(project, owner, "report_checkpoint", { sessionId: bystander, sha, fork: "feature-tax-rounding" });
    assert.equal(notAgent.value.error, "forbidden");
    assert.equal(project.features.get("tax-rounding")?.latestCheckpointSha, null);
  });
});
