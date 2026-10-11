// Opening a feature (#87, PRD 0.4 section 4.1 steps 1 and 2) and its overlap lock (#88, step 3)
// without the network: agent sessions call the real MCP tools, which reach the ProjectAgent's real
// stores and the Worker's feature module. The Artifacts binding is a fake that counts forks and
// mints, and a real Git repo on disk stands in for main and the feature's fork when a checkpoint
// updates the declared area.

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
import { InboxStore } from "../../../services/project-agent/src/inbox-store.ts";
import {
  approveOverlap,
  checkOverlap,
  OverlapStore,
  settledForSession,
  type OverlapDeps,
} from "../../../services/project-agent/src/overlap-lock.ts";
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
  readonly overlaps: OverlapStore;
  readonly inbox: InboxStore;
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
    this.features = new FeatureStore(sql);
    this.overlaps = new OverlapStore(sql);
    this.inbox = new InboxStore(sql, this.identities);
    sessions = new SessionStore(sql, this.identities, {
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      overlapsNeeding: (person) => this.overlaps.openFor(person),
      settledFor: settledForSession(this.features, this.overlaps),
    });
    this.sessions = sessions;
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
      checkOverlap: (feature) => checkOverlap(this.overlapDeps(), this.features.get(feature.id) ?? feature),
      overlapStatus: (featureId) => this.overlaps.status(featureId),
    };
  }

  /** As the ProjectAgent wires them: each lock opened or settled raises or clears an inbox item. */
  overlapDeps(): OverlapDeps {
    return {
      db: this.sqlite.sql,
      features: this.features,
      overlaps: this.overlaps,
      scopeMap: async () => scopeMap,
      sign: (record) => signFeatureRecord(record, service.privateKey),
      listener: {
        lockOpened: ({ featureId, blockedFeatureId, personId }) => this.inbox.overlapRequested(personId, featureId, blockedFeatureId),
        lockSettled: ({ featureId, blockedFeatureId, personId }) => this.inbox.overlapSettled(personId, featureId, blockedFeatureId),
      },
    };
  }

  approve(caller: string, featureId: string, blockedFeatureId: string) {
    return approveOverlap(this.overlapDeps(), caller, featureId, blockedFeatureId);
  }

  /** The ProjectAgent methods get_work reads, over these stores. */
  mcpProject(): McpProject {
    return {
      sessionHeartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      sessionWork: (caller, sessionId) => this.sessions.work(caller, sessionId),
      readIdentity: (id) => this.identities.get(id),
      threadsNeeding: () => [],
      featureWork: (caller, sessionId) => {
        if (this.sessions.heartbeat(caller, sessionId).status !== "ok") return undefined;
        const feature = this.features.featureOfSession(sessionId);
        return feature === undefined ? undefined : { feature, ...this.overlaps.status(feature) };
      },
      overlapsNeeding: (person) => this.overlaps.openFor(person),
    } as unknown as McpProject;
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
  return callWith(project, {} as McpProject, owner, name, args);
}

async function callWith(
  project: Project,
  mcpProject: McpProject,
  owner: string,
  name: string,
  args: unknown,
): Promise<{ value: any; isError: boolean }> {
  const request = new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
  });
  const repos = { issues: project.names.issues, base: project.names.base, ownerFork: project.names.owner(owner) };
  const response = await serveMcp(request, owner, () => mcpProject, repos, mcpFeatures(project.ports, owner));
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
    // The opening checks the area against running features; the second open joins and checks nothing.
    assert.deepEqual(records.map((record) => record.type), ["open_feature", "overlap_check"]);
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
    assert.deepEqual(types, ["open_feature", "overlap_check", "declare_area", "overlap_check", "declare_area", "overlap_check"]);
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

    const record = project.features
      .records("tax-rounding")
      .map((stored) => JSON.parse(stored.file) as FeatureRecord)
      .find((each) => each.type === "checkpoint_area");
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

describe("the overlap lock", () => {
  const third = [...scopeMap.scopes.values()].map((scope) => scope.ownerId).find((id) => id !== owner && id !== other) as string;
  const coveredPath = `${(firstScope.paths[0] as string).replace(/\/$/u, "")}/ids.py`;
  const freePath = `${(secondScope.paths[0] as string).replace(/\/$/u, "")}/report.py`;
  let project: Project;
  let covering: string;
  beforeEach(async () => {
    project = new Project();
    covering = project.register(owner);
    const opened = await call(project, owner, "open_feature", { sessionId: covering, feature: "identity-rework", area: { scopes: [firstScope.id] } });
    assert.notEqual(opened.value.token, null);
  });

  test("a second feature in a covered area waits until the covering person approves", async () => {
    const session = project.register(other);
    const opened = await call(project, other, "open_feature", { sessionId: session, feature: "merge-ids", area: { paths: [coveredPath] } });
    assert.equal(opened.isError, false, JSON.stringify(opened.value));
    assert.equal(opened.value.token, null);
    assert.deepEqual(
      opened.value.waitingOn.map((lock: any) => [lock.feature, lock.person, lock.overlap.scopes, lock.overlap.paths]),
      [["identity-rework", owner, [firstScope.id], [coveredPath]]],
    );
    // The fork exists; only the write token is withheld while the lock is open.
    assert.equal(project.artifacts.repos.has(`${PREFIX}feature-merge-ids`), true);
    const locked = await call(project, other, "feature_token", { sessionId: session, feature: "merge-ids" });
    assert.equal(locked.value.error, "locked");
    assert.match(locked.value.message, new RegExp(`identity-rework \\(${owner}\\)`, "u"));
    const waiting = await callWith(project, project.mcpProject(), other, "get_work", { sessionId: session });
    assert.deepEqual(waiting.value.feature.waitingOn.map((lock: any) => lock.person), [owner]);

    // The covering person hears of it in the inbox, in get_work and once at the next safe checkpoint.
    assert.deepEqual(
      project.inbox.items(owner).map(({ issueId, reason }) => [issueId, reason]),
      [["identity-rework/merge-ids", "overlap"]],
    );
    const asked = await callWith(project, project.mcpProject(), owner, "get_work", { sessionId: covering });
    assert.deepEqual(asked.value.overlapsNeedingYou.map((each: any) => [each.feature, each.blockedFeature]), [["identity-rework", "merge-ids"]]);
    const told = project.sessions.checkpoint(owner, covering);
    assert.deepEqual(told.status === "ok" && told.overlaps, [{ featureId: "identity-rework", blockedFeatureId: "merge-ids" }]);
    const again = project.sessions.checkpoint(owner, covering);
    assert.deepEqual(again.status === "ok" && again.overlaps, []);

    const quiet = project.sessions.checkpoint(other, session);
    assert.deepEqual(quiet.status === "ok" && quiet.settled, []);
    const approved = await project.approve(owner, "identity-rework", "merge-ids");
    assert.equal(approved.status, "ok", JSON.stringify(approved));
    assert.deepEqual(project.inbox.items(owner), []);
    // The waiting feature's session hears of the approval once, at its next safe checkpoint.
    const heard = project.sessions.checkpoint(other, session);
    assert.deepEqual(heard.status === "ok" && heard.settled, [
      { featureId: "identity-rework", blockedFeatureId: "merge-ids", outcome: "approved" },
    ]);
    const once = project.sessions.checkpoint(other, session);
    assert.deepEqual(once.status === "ok" && once.settled, []);
    const token = await call(project, other, "feature_token", { sessionId: session, feature: "merge-ids" });
    assert.equal(token.isError, false, JSON.stringify(token.value));
    assert.equal(token.value.token.fork, "feature-merge-ids");
    const started = await callWith(project, project.mcpProject(), other, "get_work", { sessionId: session });
    assert.deepEqual(started.value.feature.waitingOn, []);
    assert.deepEqual(started.value.feature.approvedBy, [{ feature: "identity-rework", person: owner }]);

    const records = project.features.records("merge-ids").map((stored) => JSON.parse(stored.file) as FeatureRecord);
    assert.deepEqual(records.map((record) => record.type), ["open_feature", "overlap_check", "approve_overlap"]);
    const [, check, approval] = records;
    assert.deepEqual(check?.author, { penguin: true });
    assert.deepEqual((check?.payload["locks_opened"] as any[]).map((lock) => [lock.feature, lock.person]), [["identity-rework", owner]]);
    assert.deepEqual(approval?.author, { person: owner });
    assert.equal(approval?.payload["approved_by"], owner);
    for (const record of [check, approval]) assert.equal(await verifyOperation(record as never, servicePublic), true);
  });

  test("a feature in a free area starts at once", async () => {
    const session = project.register(other);
    const opened = await call(project, other, "open_feature", { sessionId: session, feature: "reports", area: { paths: [freePath] } });
    assert.equal(opened.isError, false, JSON.stringify(opened.value));
    assert.deepEqual(opened.value.waitingOn, []);
    assert.equal(opened.value.token.fork, "feature-reports");
    assert.deepEqual(project.inbox.items(owner), []);
  });

  test("only the covering person approves, once, and only the lock they hold", async () => {
    const session = project.register(other);
    await call(project, other, "open_feature", { sessionId: session, feature: "merge-ids", area: { paths: [coveredPath] } });
    // The blocked person and a third person cannot approve.
    for (const caller of [other, third]) {
      const refused = await project.approve(caller, "identity-rework", "merge-ids");
      assert.equal(refused.status === "rejected" && refused.reason, "forbidden", caller);
    }
    // A lock that does not exist, such as the pair reversed, is not found.
    const reversed = await project.approve(owner, "merge-ids", "identity-rework");
    assert.equal(reversed.status === "rejected" && reversed.reason, "not_found");
    assert.equal((await project.approve(owner, "identity-rework", "merge-ids")).status, "ok");
    // Replaying the approval is refused and writes no second record.
    const replay = await project.approve(owner, "identity-rework", "merge-ids");
    assert.equal(replay.status === "rejected" && replay.reason, "conflict");
    const types = project.features.records("merge-ids").map((stored) => (JSON.parse(stored.file) as FeatureRecord).type);
    assert.equal(types.filter((type) => type === "approve_overlap").length, 1);
    assert.equal(project.overlaps.get("identity-rework", "merge-ids")?.approvedBy, owner);
  });

  test("declaring the feature out of the covered area withdraws its open lock", async () => {
    const session = project.register(other);
    await call(project, other, "open_feature", { sessionId: session, feature: "merge-ids", area: { paths: [coveredPath] } });
    const declared = await call(project, other, "declare_area", { sessionId: session, feature: "merge-ids", area: { paths: [freePath] } });
    assert.deepEqual(declared.value.waitingOn, []);
    assert.equal(project.overlaps.get("identity-rework", "merge-ids"), undefined);
    const heard = project.sessions.checkpoint(other, session);
    assert.deepEqual(heard.status === "ok" && heard.settled, [
      { featureId: "identity-rework", blockedFeatureId: "merge-ids", outcome: "withdrawn" },
    ]);
    assert.deepEqual(project.inbox.items(owner), []);
    const check = project.features
      .records("merge-ids")
      .map((stored) => JSON.parse(stored.file) as FeatureRecord)
      .filter((record) => record.type === "overlap_check")
      .at(-1);
    assert.deepEqual(check?.payload["locks_withdrawn"], ["identity-rework"]);
  });

  test("a covering feature of the same person makes no lock; the overlap is recorded and listed", async () => {
    const session = project.register(owner);
    const opened = await call(project, owner, "open_feature", { sessionId: session, feature: "merge-ids", area: { paths: [coveredPath] } });
    assert.equal(opened.isError, false, JSON.stringify(opened.value));
    assert.deepEqual(opened.value.waitingOn, []);
    assert.equal(opened.value.token.fork, "feature-merge-ids");
    assert.deepEqual(
      opened.value.ownOverlaps.map((each: any) => [each.feature, each.overlap.scopes, each.overlap.paths]),
      [["identity-rework", [firstScope.id], [coveredPath]]],
    );
    assert.equal(project.overlaps.get("identity-rework", "merge-ids"), undefined);
    assert.deepEqual(project.inbox.items(owner), []);
    const work = await callWith(project, project.mcpProject(), owner, "get_work", { sessionId: session });
    assert.deepEqual(work.value.feature.ownOverlaps.map((each: any) => each.feature), ["identity-rework"]);
    const check = project.features
      .records("merge-ids")
      .map((stored) => JSON.parse(stored.file) as FeatureRecord)
      .find((record) => record.type === "overlap_check");
    assert.deepEqual(check?.payload["locks_opened"], []);
    assert.deepEqual((check?.payload["own_overlaps"] as any[]).map((each) => each.feature), ["identity-rework"]);
    assert.equal(await verifyOperation(check as never, servicePublic), true);
  });

  test("running features that read the new feature's area are listed as dependents and block nothing", async () => {
    // A fresh project: a feature in the consumer scope runs, then one opens in the provider scope.
    project = new Project();
    const reader = project.register(other);
    await call(project, other, "open_feature", { sessionId: reader, feature: "reports", area: { scopes: [secondScope.id] } });
    const session = project.register(owner);
    const opened = await call(project, owner, "open_feature", { sessionId: session, feature: "identity-rework", area: { paths: [coveredPath] } });
    assert.deepEqual(opened.value.waitingOn, []);
    assert.equal(opened.value.token.fork, "feature-identity-rework");
    const kind = secondScope.dependsOn.find((dependency) => dependency.providerScopeId === firstScope.id)?.kind;
    assert.deepEqual(opened.value.dependents, [{ feature: "reports", consumerScope: secondScope.id, providerScope: firstScope.id, kind }]);
    assert.deepEqual(project.overlaps.dependents("identity-rework").map((each) => each.dependentFeatureId), ["reports"]);
  });
});
