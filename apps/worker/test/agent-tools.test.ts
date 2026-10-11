// The agent tools whats_near, impact, check and apply_fix (#94, PRD 0.4 section 5.2) without the
// network: an agent session calls the real MCP tools, which reach the Worker's feature module and the
// ProjectAgent's real stores. The scope map is the helpful-fix fixture's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { serveMcp, type McpProject } from "@penguin/mcp";
import { parseScopeMap } from "@penguin/scope-map";

import { mcpFeatures, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import { RepoNames } from "../src/repos.ts";
import { AgentToolStore, requestTool, whatsNear, type AgentToolDeps } from "../../../services/project-agent/src/agent-tools.ts";
import { FeatureStore, signFeatureRecord } from "../../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { IssueIndex } from "../../../services/project-agent/src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../../../services/project-agent/src/service-key.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";
import { sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const FIXTURE = join(import.meta.dirname, "../../../examples/helpful-fix/base");
const scopeMap = parseScopeMap(JSON.parse(readFileSync(join(FIXTURE, "penguin/scopes.json"), "utf8")));
const ownerOf = (scope: string) => scopeMap.scopes.get(scope)?.ownerId as string;
const PRIYA = ownerOf("ingestion");
const JUN = ownerOf("analytics");
const SAM = ownerOf("messaging");
const CHECKPOINT = "a".repeat(40);

let service: ServiceKey;
before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

class Project {
  readonly sqlite = sqlite();
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features: FeatureStore;
  readonly runs: AgentToolStore;
  readonly names = new RepoNames("t-");
  readonly ports: FeaturePorts;

  constructor() {
    const sql = this.sqlite.sql;
    let next = 0;
    this.identities = new IdentityStore(sql, () => `identity-${++next}`);
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(sql, { assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed) });
    sessions = new SessionStore(sql, this.identities, { assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle) });
    this.sessions = sessions;
    this.features = new FeatureStore(sql);
    this.runs = new AgentToolStore(sql);
    for (const scope of scopeMap.scopes.values()) {
      this.identities.create(
        scope.ownerId,
        { handle: `@${scope.ownerId}/agent`, name: "agent", job: "Build", charterScopes: [scope.id], autoAccept: true },
        scopeMap,
      );
    }
    const deps: AgentToolDeps = {
      features: this.features,
      runs: this.runs,
      scopeMap: async () => scopeMap,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      session: (sessionId) => this.sessions.get(sessionId),
      identity: (identityId) => this.identities.get(identityId),
    };
    const unused = () => {
      throw new Error("not used");
    };
    const directory = {
      openFeature: unused,
      recordFeatureRepo: unused,
      featureTokenGrant: unused,
      declareFeatureArea: unused,
      reportFeatureCheckpoint: unused,
      submitReview: unused,
      features: () => this.features.list(),
      whatsNear: (owner, sessionId, input) => whatsNear(deps, owner, sessionId, input),
      requestAgentTool: (owner, sessionId, tool, input) => requestTool(deps, owner, sessionId, tool, input),
    } as FeatureDirectory;
    this.ports = {
      directory: () => directory,
      fork: unused,
      mintWrite: unused,
      repos: { issues: this.names.issues, base: this.names.base },
      config: { forkOptions: { defaultBranchOnly: true }, tokenTtlSeconds: 1800 },
    };
  }

  register(owner: string): string {
    const outcome = this.sessions.register(owner, { identity: `@${owner}/agent`, vendor: "codex", worktreeId: `wt_${owner}`, branch: "main" });
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return outcome.status === "ok" ? outcome.session.id : "";
  }

  /** Opens `owner`'s feature over `scope`, with `session` as its agent, at a checkpoint. */
  async open(id: string, owner: string, scope: string, session: string): Promise<void> {
    const area = { scopes: [scope], paths: [], contracts: [] };
    const sign = (type: "open_feature" | "checkpoint_area") =>
      signFeatureRecord(this.features.draftRecord(id, type, { person: owner }, {}), service.privateKey);
    this.features.insert(id, owner, area, await sign("open_feature"));
    this.features.setRepo(id, `t-feature-${id}`);
    this.features.setArea(id, area, await sign("checkpoint_area"), CHECKPOINT);
    this.features.join(id, session);
  }
}

let nextId = 0;

async function call(project: Project, owner: string, name: string, args: unknown): Promise<{ value: any; isError: boolean; text: string }> {
  const request = new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
  });
  const repos = { issues: project.names.issues, base: project.names.base, ownerFork: project.names.owner(owner) };
  const response = await serveMcp(request, owner, () => ({}) as McpProject, repos, mcpFeatures(project.ports, owner));
  const body = await response.text();
  const data = body.includes("data: ") ? (body.split("\n").find((line) => line.startsWith("data: ")) as string).slice(6) : body;
  const parsed = JSON.parse(data);
  assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
  return {
    value: parsed.result.structuredContent,
    isError: parsed.result.isError === true,
    text: (parsed.result.content ?? []).map((item: { text?: string }) => item.text ?? "").join(""),
  };
}

describe("the agent tools", () => {
  let project: Project;
  const sessions: Record<string, string> = {};

  beforeEach(async () => {
    project = new Project();
    for (const owner of [PRIYA, JUN, SAM]) sessions[owner] = project.register(owner);
    await project.open("local-day", PRIYA, "ingestion", sessions[PRIYA] as string);
    await project.open("weekly", JUN, "analytics", sessions[JUN] as string);
    await project.open("reminders", SAM, "messaging", sessions[SAM] as string);
  });

  test("whats_near lists the running features that depend on a shared path, with their people and agents", async () => {
    const answer = await call(project, PRIYA, "whats_near", { sessionId: sessions[PRIYA], paths: ["shared/dates.py"] });
    assert.equal(answer.isError, false, JSON.stringify(answer.value));
    const byFeature = Object.fromEntries(answer.value.features.map((near: { feature: string }) => [near.feature, near]));
    assert.deepEqual(Object.keys(byFeature).sort(), ["reminders", "weekly"], "Priya's own feature is left out");
    assert.deepEqual(byFeature.weekly, {
      feature: "weekly",
      person: JUN,
      state: "building",
      touches: null,
      dependsOn: [{ consumerScope: "analytics", providerScope: "ingestion", kind: "imports" }],
      agents: [{ identity: `@${JUN}/agent`, vendor: "codex", status: "running" }],
    });
    const [run] = project.runs.list("local-day");
    assert.equal(run?.tool, "whats_near");
    assert.equal(run?.caller, `@${PRIYA}/agent`);
    assert.deepEqual(run?.input, { paths: ["shared/dates.py"], scopes: [] });
    assert.match(run?.summary ?? "", /^2 running features near shared\/dates\.py/);
  });

  test("whats_near names a feature that works in the asked scope", async () => {
    const answer = await call(project, PRIYA, "whats_near", { sessionId: sessions[PRIYA], scopes: ["analytics"] });
    assert.deepEqual(answer.value.features.map((near: { feature: string; touches: { scopes: string[] } }) => [near.feature, near.touches.scopes]), [
      ["weekly", ["analytics"]],
    ]);
  });

  test("whats_near refuses a path that leaves the repository and a call that names nothing", async () => {
    const traversal = await call(project, PRIYA, "whats_near", { sessionId: sessions[PRIYA], paths: ["../etc/passwd"] });
    assert.equal(traversal.isError, true);
    assert.equal(traversal.value.error, "invalid");
    const empty = await call(project, PRIYA, "whats_near", { sessionId: sessions[PRIYA] });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /at least one path or scope/);
  });

  test("impact and check record a request at the feature's latest checkpoint for the check runner", async () => {
    for (const tool of ["impact", "check"]) {
      const answer = await call(project, PRIYA, tool, { sessionId: sessions[PRIYA], feature: "local-day" });
      assert.equal(answer.isError, false, JSON.stringify(answer.value));
      assert.equal(answer.value.state, "waiting");
      assert.equal(answer.value.tool, tool);
      assert.equal(answer.value.checkpoint, CHECKPOINT);
      assert.equal(answer.value.message, "waiting for the check runner");
    }
    assert.deepEqual(project.runs.list("local-day").map((run) => [run.tool, run.result, run.checkpointSha]), [
      ["impact", "waiting", CHECKPOINT],
      ["check", "waiting", CHECKPOINT],
    ]);
  });

  test("a session may call impact, check and apply_fix only on its own feature", async () => {
    const answer = await call(project, PRIYA, "check", { sessionId: sessions[PRIYA], feature: "weekly" });
    assert.equal(answer.isError, true);
    assert.equal(answer.value.error, "forbidden");
    assert.equal(project.runs.list("weekly").length, 0);
  });

  test("apply_fix takes a codemod inside the caller's charter and records it with its command", async () => {
    const edits = [{ kind: "rename", from: "shared.dates.start_of_day", to: "shared.dates.start_of_local_day" }];
    const answer = await call(project, PRIYA, "apply_fix", {
      sessionId: sessions[PRIYA],
      feature: "local-day",
      kind: "codemod",
      paths: ["ingestion/batches.py"],
      edits,
    });
    assert.equal(answer.isError, false, JSON.stringify(answer.value));
    assert.equal(answer.value.commandId, "fix:python-codemod");
    assert.deepEqual(answer.value.input, { feature: "local-day", kind: "codemod", paths: ["ingestion/batches.py"], edits });
    assert.equal(project.runs.list("local-day")[0]?.tool, "apply_fix");
  });

  test("apply_fix refuses a file outside the charter, an unknown kind and an edit that is not a Python name", async () => {
    const outside = await call(project, PRIYA, "apply_fix", {
      sessionId: sessions[PRIYA],
      feature: "local-day",
      kind: "format",
      paths: ["analytics/weekly.py"],
    });
    assert.equal(outside.isError, true);
    assert.equal(outside.value.error, "forbidden");
    assert.match(outside.value.message, /outside its charter/);

    const kind = await call(project, PRIYA, "apply_fix", { sessionId: sessions[PRIYA], feature: "local-day", kind: "shell", paths: ["shared/a.py"] });
    assert.equal(kind.isError, true);
    const injected = await call(project, PRIYA, "apply_fix", {
      sessionId: sessions[PRIYA],
      feature: "local-day",
      kind: "codemod",
      paths: ["shared/dates.py"],
      edits: [{ kind: "rename", from: "os; import subprocess", to: "x" }],
    });
    assert.equal(injected.isError, true);
    const lockfileWithPaths = await call(project, PRIYA, "apply_fix", {
      sessionId: sessions[PRIYA],
      feature: "local-day",
      kind: "lockfile",
      paths: ["shared/dates.py"],
    });
    assert.equal(lockfileWithPaths.value.error, "invalid");
    assert.equal(project.runs.list("local-day").length, 0, "a refused call records nothing");
  });
});
