// The check runner's agent tools end to end (#102, PRD 0.4 section 5.2), without the network. Priya's
// agent calls the real `impact`, `check` and `apply_fix` MCP tools on her feature; runner mode claims
// each request through the Worker's bridge routes, runs it on the helpful-fix fixture and reports the
// result. The result reaches Priya's session at its next safe checkpoint, through the bridge's hook,
// and get_work then lists it. Nobody runs `penguin-bridge check` by hand.
//
// The fixture repo stands in for main and for every feature's fork. Priya's feature is at her
// checkpoint, which makes start_of_day return a UTC midnight; Jun's and Sam's running features are at
// theirs, which still call start_of_day.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { generateSigningKeyPair } from "@penguin/issues";
import {
  BlockChecker,
  checkTools,
  claimToolRuns as claimToolRunsOver,
  CombinedRunner,
  fetchRepoBranches,
  FixApplier,
  hookAnswer,
  localRemote,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  reportToolRun,
  sendSessionCheckpoint,
  TestRunner,
  toolPass,
  type Fetch,
} from "@penguin/local-bridge";
import { serveMcp, type McpProject } from "@penguin/mcp";
import { parseScopeMap } from "@penguin/scope-map";

import { mcpFeatures, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import { handleRequest, type GatewayHandlers } from "../src/gateway.ts";
import { RepoNames } from "../src/repos.ts";
import { claimToolRuns, recordToolResult } from "../../../services/project-agent/src/agent-tool-runner.ts";
import { AgentToolStore, requestTool, type AgentToolDeps } from "../../../services/project-agent/src/agent-tools.ts";
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import { checkpointBaseline } from "../../../services/project-agent/src/combined-run-schedule.ts";
import { FeatureStore, signFeatureRecord } from "../../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { IssueIndex, type BridgeCaller } from "../../../services/project-agent/src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../../../services/project-agent/src/service-key.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";
import { gitHistory } from "../../../services/project-agent/test/huddle-project.ts";
import { sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter), UV_OFFLINE: "1" };
const SERVER = "https://penguin.example";
const OPTIONS = { deployerToken: "deployer-secret-for-tests" };
const PREFIX = "t-";
const WORKTREE = "wt_priya";

/** The fixture's features, as features.json declares them, each at its first checkpoint. */
const FEATURES = [
  { id: "utc-day-start", person: "priya", handle: "@priya/batches", scope: "ingestion", tag: "owner-priya-checkpoint" },
  { id: "weekly-report", person: "jun", handle: "@jun/reports", scope: "analytics", tag: "owner-jun-checkpoint" },
  { id: "reminder-scheduling", person: "sam", handle: "@sam/reminders", scope: "messaging", tag: "owner-sam-checkpoint" },
] as const;
const PRIYA = FEATURES[0];

let root: string;
let fixture: string;
let main: string;
const checkpoints: Record<string, string> = {};
let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-tool-runner-")));
  fixture = join(root, "fixture");
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  main = execGit("rev-parse", "main").trim();
  for (const feature of FEATURES) checkpoints[feature.id] = execGit("rev-parse", `${feature.tag}^{commit}`).trim();
});

after(() => rm(root, { recursive: true, force: true }));

/** A Git command's output in the fixture repo. */
function execGit(...args: string[]): string {
  return execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** The project's stores behind the MCP tools and the Worker's bridge routes, and a runner. */
class Deployment {
  readonly sql = sqlite().sql;
  readonly names = new RepoNames(PREFIX);
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features = new FeatureStore(this.sql);
  readonly runs = new AgentToolStore(this.sql);
  readonly registry = new BridgeRegistry(this.sql);
  readonly scopeMap = parseScopeMap(JSON.parse(execGit("show", "main:penguin/scopes.json")));
  readonly fetchImpl: Fetch;
  readonly tokens = new Map<string, string>();
  readonly deps: AgentToolDeps;
  readonly sessionIds = new Map<string, string>();

  constructor() {
    let next = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++next}`);
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(this.sql, { assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed) });
    // As the ProjectAgent wires it: a tool result reaches its session at the next safe checkpoint.
    sessions = new SessionStore(this.sql, this.identities, {
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      toolResultsFor: (sessionId) => this.runs.deliver(sessionId),
    });
    this.sessions = sessions;
    for (const { person, handle, scope } of FEATURES) {
      this.identities.create(person, { handle, name: handle.split("/")[1] as string, job: "Build", charterScopes: [scope], autoAccept: true }, this.scopeMap);
    }
    const history = gitHistory(fixture);
    this.deps = {
      features: this.features,
      runs: this.runs,
      scopeMap: async () => this.scopeMap,
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
      session: (sessionId) => this.sessions.get(sessionId),
      identity: (identityId) => this.identities.get(identityId),
      // The fixture repo is both the fork and main, as Artifacts holds both in this test.
      baseline: (_repo, sha) => checkpointBaseline(history, history, sha),
    };
    const handlers = {
      bridges: () => ({
        authenticateBridge: (token: string) => this.registry.authenticate(token),
        // As ProjectAgent.claimToolRuns, reportToolRun and sessionCheckpoint.
        claimToolRuns: (caller: BridgeCaller) =>
          claimToolRuns({ runs: this.runs, features: this.features, identity: (id) => this.identities.get(id) }, caller),
        reportToolRun: (caller: BridgeCaller, runId: number, result: unknown) => recordToolResult(this.runs, caller, runId, result),
        sessionCheckpoint: (owner: string, worktreeId: string) => this.sessions.checkpointWorktree(owner, worktreeId),
      }),
      huddles: () => ({}),
      ownerForkRepo: (owner: string) => `owner-${owner}`,
      projectRepos: { issues: "issues", base: "base" },
      mintToken: () => Promise.reject(new Error("no Artifacts in this test")),
    } as unknown as GatewayHandlers;
    this.fetchImpl = async (input, init) => handleRequest(new Request(input, init), OPTIONS, handlers);
  }

  async register(bridge: string, role: "owner" | "runner"): Promise<void> {
    const { code } = await this.registry.issueCode(bridge, role, 600);
    const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
    const outcome = await this.registry.register(code, publicKey);
    assert.equal(outcome.status, "registered");
    if (outcome.status === "registered") this.tokens.set(bridge, outcome.bridge.bridgeToken);
  }

  /** Each fixture feature running at its checkpoint, with a session of its person's identity as its agent. */
  async openFeatures(): Promise<void> {
    for (const { id, person, handle, scope } of FEATURES) {
      const registered = this.sessions.register(person, { identity: handle, vendor: "claude-code", worktreeId: `wt_${person}`, branch: "main" });
      assert.equal(registered.status, "ok");
      const sessionId = registered.status === "ok" ? registered.session.id : "";
      this.sessionIds.set(person, sessionId);
      const area = { scopes: [scope], paths: [], contracts: [] };
      const sign = (type: "open_feature" | "checkpoint_area") => signFeatureRecord(this.features.draftRecord(id, type, { person }, {}), service.privateKey);
      this.features.insert(id, person, area, await sign("open_feature"));
      this.features.setRepo(id, this.names.feature(id));
      this.features.setArea(id, area, await sign("checkpoint_area"), checkpoints[id] as string);
      this.features.join(id, sessionId);
    }
  }

  /** Priya's agent calls MCP tool `name` and gets its structured answer. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const owner = PRIYA.person;
    const sessionId = this.sessionIds.get(owner) as string;
    const directory = {
      features: () => this.features.list(),
      requestAgentTool: (caller, session, tool, input) => requestTool(this.deps, caller, session, tool, input),
    } as FeatureDirectory;
    const ports = { directory: () => directory, repos: { issues: this.names.issues, base: this.names.base } } as unknown as FeaturePorts;
    // get_work's reads, as the ProjectAgent answers them.
    const project = {
      sessionHeartbeat: (caller: string, session: string) => this.sessions.heartbeat(caller, session),
      sessionWork: (caller: string, session: string) => this.sessions.work(caller, session),
      readIdentity: (id: string) => this.identities.get(id),
      threadsNeeding: () => [],
      agentToolResults: (caller: string, session: string) =>
        this.sessions.heartbeat(caller, session).status === "ok" ? this.runs.delivered(session) : [],
    } as unknown as McpProject;
    const request = new Request("https://penguin.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { sessionId, ...args } } }),
    });
    const repos = { issues: this.names.issues, base: this.names.base, ownerFork: this.names.owner(owner) };
    const text = await (await serveMcp(request, owner, () => project, repos, mcpFeatures(ports, owner))).text();
    const data = text.includes("data: ") ? (text.split("\n").find((line) => line.startsWith("data: ")) as string).slice(6) : text;
    const parsed = JSON.parse(data);
    assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
    return parsed.result.structuredContent;
  }

  /** One pass of runner mode's tool requests in its own empty repository. */
  async pass(name: string) {
    const repo = join(root, name);
    const scratch = join(root, `${name}-scratch`);
    if (!existsSync(repo)) {
      await mkdir(scratch, { recursive: true });
      await runGit(root, ["init", "--quiet", repo]);
    }
    const token = this.tokens.get("runner") as string;
    const impact = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV });
    return toolPass({
      claim: () => claimToolRunsOver(SERVER, token, this.fetchImpl),
      report: (runId, result) => reportToolRun(SERVER, token, runId, result, this.fetchImpl),
      // The fixture repo stands in for every `feature-<id>` fork.
      fetchFork: (fork) => {
        assert.match(fork, /^feature-/);
        return fetchRepoBranches(repo, () => localRemote(fixture), fork);
      },
      impact,
      combined: new CombinedRunner({
        repoPath: repo,
        runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
        impact,
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: TEST_ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
        }),
      }),
      fixes: new FixApplier({ repoPath: repo, ruff: RUFF, python: PYTHON, env: TEST_ENV, scratchDir: scratch }),
      repoPath: repo,
    });
  }

  /** The PreToolUse hook's safe checkpoint of Priya's worktree, through the bridge route. */
  async hook(): Promise<{ deliveries: Awaited<ReturnType<typeof sendSessionCheckpoint>>; answer: string | undefined }> {
    const deliveries = await sendSessionCheckpoint(SERVER, this.tokens.get(PRIYA.person) as string, WORKTREE, this.fetchImpl);
    return { deliveries, answer: hookAnswer(deliveries) };
  }
}

describe("the check runner's agent tools", () => {
  let deployment: Deployment;

  beforeEach(async () => {
    deployment = new Deployment();
    await deployment.openFeatures();
    await deployment.register("runner", "runner");
    await deployment.register(PRIYA.person, "owner");
  });

  test("an agent's check returns the recorded block checks, with each failure's next step, at its next safe checkpoint", async () => {
    const answer = await deployment.call("check", { feature: PRIYA.id });
    assert.equal(answer.state, "waiting", JSON.stringify(answer));
    const [waiting] = deployment.runs.list(PRIYA.id);
    assert.equal(waiting?.baseSha, main);
    assert.equal(waiting?.checkpointSha, checkpoints[PRIYA.id]);

    // Before the runner reports, a safe checkpoint delivers nothing.
    assert.equal((await deployment.hook()).answer, undefined);

    const result = await deployment.pass("runner-check");
    assert.equal(result.claimed, 1);
    const [run] = result.runs;
    assert.equal(run?.error, null, run?.error ?? "");
    assert.equal(run?.result?.result, "found");

    const [recorded] = deployment.runs.list(PRIYA.id);
    const outcome = recorded?.outcome;
    assert.equal(recorded?.result, "found");
    const checks = outcome?.checks ?? [];
    // Each running feature is a target of its own, keyed by its id.
    assert.deepEqual([...new Set(checks.map((check) => check.target))].sort(), ["main", "reminder-scheduling", "weekly-report"]);
    assert.ok(checks.every((check) => check.input.origin === checkpoints[PRIYA.id]));
    const failing = checks.filter((check) => check.result === "failed").map((check) => `${check.target} ${check.check}`);
    assert.deepEqual(failing.sort(), ["reminder-scheduling tests", "weekly-report tests"]);
    // The failing tests lie outside @priya/batches's charter: step 5, to the scope owners' agents.
    assert.deepEqual(
      outcome?.decisions.map((decision) => [decision.target, decision.check, decision.step, decision.actor.id]).sort(),
      [
        ["reminder-scheduling", "tests", 5, "@sam/reminders"],
        ["weekly-report", "tests", 5, "@jun/reports"],
      ],
    );
    assert.match(recorded?.summary ?? "", /^\d+ checks, 2 failing: /);

    // The next safe checkpoint names the result once; get_work lists it with the checks.
    const { deliveries, answer: hooked } = await deployment.hook();
    assert.deepEqual(deliveries[0]?.toolResults?.map(({ recordedAs, tool, result: answered }) => [recordedAs, tool, answered]), [
      [answer.recordedAs, "check", "found"],
    ]);
    assert.match(JSON.parse(hooked ?? "{}").hookSpecificOutput.additionalContext, /the check runner answered check \d+ on feature utc-day-start/);
    assert.equal((await deployment.hook()).answer, undefined, "a result is delivered once");
    const work = await deployment.call("get_work", {});
    assert.equal(work.toolResults.length, 1);
    assert.equal(work.toolResults[0].recordedAs, answer.recordedAs);
    assert.deepEqual(work.toolResults[0].outcome.checks, checks);

    // The result is recorded once: the next pass claims nothing.
    assert.equal((await deployment.pass("runner-check")).claimed, 0);
  });

  test("impact reports the contract diff and the running features that use the change", async () => {
    await deployment.call("impact", { feature: PRIYA.id });
    const result = await deployment.pass("runner-impact");
    assert.equal(result.runs[0]?.error, null, result.runs[0]?.error ?? "");
    const [recorded] = deployment.runs.list(PRIYA.id);
    assert.equal(recorded?.outcome?.impact?.head, checkpoints[PRIYA.id]);
    assert.ok(recorded?.outcome?.impact?.contracts.includes("shared/dates.py::start_of_day"));
    assert.match(recorded?.summary ?? "", /used by reminder-scheduling, weekly-report$/);
  });

  test("apply_fix makes the fix commit on the runner and reports it unpushed", async () => {
    const edits = [{ kind: "rename", from: "shared.dates.start_of_day", to: "shared.dates.start_of_local_day" }];
    await deployment.call("apply_fix", { feature: PRIYA.id, kind: "codemod", paths: ["ingestion/batches.py"], edits });
    const refsBefore = execGit("for-each-ref");
    const result = await deployment.pass("runner-fix");
    assert.equal(result.runs[0]?.error, null, result.runs[0]?.error ?? "");
    const [recorded] = deployment.runs.list(PRIYA.id);
    const outcome = recorded?.outcome;
    assert.equal(recorded?.result, "changed", recorded?.summary);
    assert.equal(outcome?.pushed, false);
    assert.deepEqual(outcome?.fix?.changed?.paths, ["ingestion/batches.py"]);
    assert.equal(outcome?.fix?.changed?.before, checkpoints[PRIYA.id]);
    assert.match(recorded?.summary ?? "", /not pushed$/);
    // The commit stays in the runner's repository; the fork is untouched.
    const kept = (await runGit(join(root, "runner-fix"), ["rev-parse", outcome?.fixRef as string])).trim();
    assert.equal(kept, outcome?.fix?.changed?.after);
    assert.equal(execGit("for-each-ref"), refsBefore);
  });

  test("only a runner bridge claims and reports tool requests, and a result must be the request's own", async () => {
    const answer = await deployment.call("check", { feature: PRIYA.id });
    const ownerToken = deployment.tokens.get(PRIYA.person) as string;
    await assert.rejects(claimToolRunsOver(SERVER, ownerToken, deployment.fetchImpl), /only to a runner bridge/);
    assert.equal(deployment.runs.get(answer.recordedAs)?.claimedBy, null);

    const runner = deployment.tokens.get("runner") as string;
    const [claimed] = await claimToolRunsOver(SERVER, runner, deployment.fetchImpl);
    assert.deepEqual(
      [claimed?.fork, claimed?.base, claimed?.checkpoint, claimed?.charter.handle],
      [`feature-${PRIYA.id}`, main, checkpoints[PRIYA.id], PRIYA.handle],
    );
    assert.deepEqual(
      claimed?.forks.map(({ person, fork, checkpoint }) => [person, fork, checkpoint]),
      [
        ["sam", "feature-reminder-scheduling", checkpoints["reminder-scheduling"]],
        ["jun", "feature-weekly-report", checkpoints["weekly-report"]],
      ],
    );
    // Claimed and within its lease, the request is not handed out again.
    assert.deepEqual(await claimToolRunsOver(SERVER, runner, deployment.fetchImpl), []);

    const result = {
      schemaVersion: 1,
      tool: "check",
      base: main,
      checkpoint: checkpoints[PRIYA.id],
      result: "found",
      summary: "0 checks, 0 failing",
      impact: null,
      checks: [],
      decisions: [],
      fix: null,
      fixRef: null,
      pushed: false,
      durationMs: 1,
    };
    await assert.rejects(reportToolRun(SERVER, runner, answer.recordedAs, { ...result, tool: "impact" } as never, deployment.fetchImpl), /HTTP 400/);
    await assert.rejects(reportToolRun(SERVER, runner, answer.recordedAs, { ...result, pushed: true } as never, deployment.fetchImpl), /HTTP 400/);
    await assert.rejects(reportToolRun(SERVER, ownerToken, answer.recordedAs, result as never, deployment.fetchImpl), /only to a runner bridge/);
    await assert.rejects(reportToolRun(SERVER, runner, 999, result as never, deployment.fetchImpl), /HTTP 404/);
    assert.equal(deployment.runs.get(answer.recordedAs)?.result, "waiting");

    // The first report wins; a second answers 409.
    assert.equal((await reportToolRun(SERVER, runner, answer.recordedAs, result as never, deployment.fetchImpl)).result, "found");
    await assert.rejects(reportToolRun(SERVER, runner, answer.recordedAs, result as never, deployment.fetchImpl), /HTTP 409/);
  });
});
