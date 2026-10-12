// Phase 4's fix delivery (#39) on the identity-unification fixture, without the network: the
// runner's combined run opens the Huddle (#38), each fix sub-issue routes to a session of its
// identity, and a running session reads it through the MCP get_work tool only from its next safe
// checkpoint on. The agent sessions are JSON-RPC calls to the real MCP tools over the ProjectAgent's
// real stores.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { combinedRunEvent, CombinedRunner, hookAnswer, TestRunner, worktreeAt } from "@penguin/local-bridge";
import { serveMcp, type McpProject } from "@penguin/mcp";

import { fixTask } from "../../services/project-agent/src/fix-task.ts";
import { reportCheckpoint } from "../../services/project-agent/src/owner-forks.ts";
import { SESSION_OFFLINE_AFTER_MS } from "../../services/project-agent/src/session-store.ts";
import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

let root: string;
let repo: string;
let tags: Record<string, string>;
/** The runner's combined-run event for Priya's checkpoint, as it crosses the network. */
let event: unknown;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-fix-delivery-")));
  repo = join(root, "main");
  await mkdir(join(root, "bridge"));
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  const pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as {
    branches: Record<string, string>;
    tags: Record<string, string>;
  };
  tags = { ...pins.tags, main: pins.branches.main as string };
  const report = await new CombinedRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "bridge"), consent: () => true }),
  }).run({
    checkpointSha: tags["owner-priya-checkpoint"] as string,
    baselineSha: tags.main as string,
    latestCheckpoints: { jun: tags["owner-jun-checkpoint"] as string, sam: tags["owner-sam-checkpoint"] as string },
  });
  event = JSON.parse(JSON.stringify(combinedRunEvent(report, "priya")));
});

after(() => rm(root, { recursive: true, force: true }));

/** The MCP tools' view of the ProjectAgent, wired as the agent's RPC methods wire its stores. */
function mcpProject(project: HuddleProject): McpProject {
  return {
    registerSession: (caller, input) => project.sessions.register(caller, input),
    sessionHeartbeat: (caller, id) => project.sessions.heartbeat(caller, id),
    sessionWork: (caller, id) => project.sessions.work(caller, id),
    readIdentity: (id) => project.identities.get(id),
    readFixTask: (id) => fixTask(project.huddles, project.index.resolve(id), project.index.issue(id)),
    issueRoutes: (id) => project.sessions.routes(project.index.resolve(id)),
    readIssue: (id) => project.index.read(id),
    threadsNeeding: (person) => project.index.threadsNeeding(person),
    sessionUpdate: () => {
      throw new Error("not used");
    },
    reportCheckpoint: (caller, id, sha, fork) =>
      reportCheckpoint(
        {
          sessions: project.sessions,
          forks: project.forks,
          commitExists: async (forkRepo, commit) =>
            project.published.get(forkRepo.replace(/^owner-/u, ""))?.has(commit) ?? false,
        },
        caller,
        id,
        sha,
        fork,
      ),
  };
}

let nextId = 0;

/** Calls one MCP tool as `owner` and returns its structured result. */
async function call(project: HuddleProject, owner: string, name: string, args: unknown): Promise<any> {
  const request = new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
  });
  const repos = { issues: "issues", base: "base", ownerFork: `owner-${owner}` };
  const response = await serveMcp(request, owner, () => mcpProject(project), repos);
  const text = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length)
    : text;
  const { result } = JSON.parse(data as string);
  assert.equal(result.isError ?? false, false, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

/** Registers a session of `identity` in the fixture's worktree, with the id the bridge gives it. */
async function register(project: HuddleProject, owner: string, identity: string): Promise<string> {
  const { id: worktreeId } = await worktreeAt(repo);
  const args = { identity, vendor: "codex", worktreeId, branch: "main" };
  return (await call(project, owner, "register_session", args)).sessionId;
}

const workIds = async (project: HuddleProject, owner: string, sessionId: string): Promise<string[]> =>
  (await call(project, owner, "get_work", { sessionId })).issues.map((issue: { id: string }) => issue.id);

test("a running @jun/reports session gets its fix sub-issues at its next checkpoint and not before", async () => {
  const project = new HuddleProject();
  project.publish("priya", tags["owner-priya-checkpoint"] as string);
  const jun = await register(project, "jun", "@jun/reports");
  assert.equal((await project.open(event)).status, "opened");
  assert.deepEqual(project.fixes("1").map((fix) => fix.split(" ")[0]), ["@jun/reports", "@jun/reports", "@sam/campaigns"]);

  // Routed to the session, but not delivered: the session is in the middle of other work.
  assert.deepEqual(project.sessions.routes("2"), [{ handle: "@jun/reports", sessionId: jun, waitingFor: null }]);
  assert.deepEqual(await workIds(project, "jun", jun), []);

  // The bridge's PreToolUse hook reports the checkpoint for the session's worktree.
  const { id: worktreeId } = await worktreeAt(repo);
  const deliveries = project.sessions.checkpointWorktree("jun", worktreeId);
  assert.deepEqual(deliveries, [{ sessionId: jun, handle: "@jun/reports", delivered: ["2", "3"], threads: [], overlaps: [], settled: [], toolResults: [], planNotices: { parts: [], decisions: [], reviews: [] } }]);
  const answer = JSON.parse(hookAnswer(deliveries.map(({ handle, sessionId, delivered, threads }) => ({ sessionId, delivered, threads, identity: handle, overlaps: [], locksSettled: [], newPlanParts: [], planDecisions: [], reviewResults: [] }))) ?? "");
  assert.equal(answer.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(answer.hookSpecificOutput.additionalContext, /fix tasks #2, #3 to @jun\/reports/u);

  const work = await call(project, "jun", "get_work", { sessionId: jun });
  assert.deepEqual(
    work.issues.map((issue: { id: string }) => issue.id),
    ["2", "3"],
  );
  const [shared] = work.issues;
  const trigger = `owner-priya@${tags["owner-priya-checkpoint"]}`;
  assert.equal(shared.huddleIssueId, "1");
  assert.deepEqual(shared.pinnedBase, {
    trigger,
    baseline: tags.main,
    checkpoint: `owner-jun@${tags["owner-jun-checkpoint"]}`,
  });
  assert.deepEqual(shared.allowedScopes, ["analytics"]);
  assert.deepEqual(
    shared.failingTests.map((failing: Record<string, unknown>) => [failing.scopeId, failing.commandId, failing.testId]),
    [["analytics", "test:analytics", "test_identity::shared_device_split"]],
  );
  assert.match(shared.failingTests[0].fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(shared.acceptanceCriteria, [
    `test_identity::shared_device_split passes when ${trigger} is merged with your fixed checkpoint of owner-jun.`,
    "`test:analytics` passes in full on that merge.",
  ]);
  // A second checkpoint delivers nothing new.
  assert.deepEqual(project.sessions.checkpointWorktree("jun", worktreeId)[0]?.delivered, []);
});

test("an explicit checkpoint report delivers the fix tasks and names them in its answer", async () => {
  const project = new HuddleProject();
  project.publish("priya", tags["owner-priya-checkpoint"] as string);
  const jun = await register(project, "jun", "@jun/reports");
  await project.open(event);
  assert.deepEqual(await workIds(project, "jun", jun), []);

  // Jun's bridge published a checkpoint of the session's work; the session reports it.
  const sha = tags["owner-jun-checkpoint"] as string;
  project.published.set("jun", new Set([sha]));
  const reported = await call(project, "jun", "report_checkpoint", { sessionId: jun, sha });
  assert.deepEqual(reported.newWork, ["2", "3"]);
  assert.deepEqual(await workIds(project, "jun", jun), ["2", "3"]);
});

test("with no @sam/campaigns session, Sam is asked to start one and the Huddle stays in FIXING", async () => {
  const project = new HuddleProject();
  project.publish("priya", tags["owner-priya-checkpoint"] as string);
  await project.open(event);
  assert.deepEqual(project.sessions.routes("4"), [{ handle: "@sam/campaigns", sessionId: null, waitingFor: "session" }]);
  assert.deepEqual(
    project.inbox
      .items("sam")
      .map((item) => `${item.reason} #${item.issueId}`)
      .sort(),
    ["assigned #4", "mentioned #1", "start_session #4"],
  );
  assert.equal(project.index.issue("1")?.state, "fixing");
  assert.equal(project.index.issue("4")?.state, "open");
});

test("a disconnect leaves the sub-issue open; a later session of the same identity receives it", async () => {
  const project = new HuddleProject();
  project.clock = Date.parse("2026-10-11T12:00:00Z");
  project.publish("priya", tags["owner-priya-checkpoint"] as string);
  await project.open(event);
  const first = await register(project, "sam", "@sam/campaigns");
  // Registering is a safe checkpoint: the new session has nothing in progress.
  assert.deepEqual(await workIds(project, "sam", first), ["4"]);

  // The session stops sending heartbeats mid-fix; its lease runs out.
  project.clock += SESSION_OFFLINE_AFTER_MS + 1;
  assert.equal(project.sessions.get(first)?.status, "offline");
  const sub = project.index.issue("4");
  assert.equal(sub?.state, "open");
  assert.deepEqual([...(sub?.assignments.keys() ?? [])], ["identity:@sam/campaigns"]);
  assert.equal(project.index.issue("1")?.state, "fixing");
  assert.deepEqual(
    project.sessions.requests("sam").map((request) => `${request.kind} #${request.issueId}`),
    ["start #4"],
  );

  const second = await register(project, "sam", "@sam/campaigns");
  assert.deepEqual(await workIds(project, "sam", second), ["4"]);
  assert.deepEqual(project.sessions.requests("sam"), []);
});
