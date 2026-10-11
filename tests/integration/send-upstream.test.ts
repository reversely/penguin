// Phase 4's upstream reassignment (#40) on the identity-unification fixture, without the network: the
// runner's combined run opens the Huddle (#38), @jun/reports receives the shared-device sub-issue
// (#39), finds the fix belongs in Priya's merge rules and sends it upstream through the MCP
// post_update tool. Penguin reassigns it to @priya/merge-rules. The agent sessions are JSON-RPC calls
// to the real MCP tools over the ProjectAgent's real stores.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { combinedRunEvent, CombinedRunner, TestRunner } from "@penguin/local-bridge";
import { serveMcp, type McpProject } from "@penguin/mcp";

import { fixTask } from "../../services/project-agent/src/fix-task.ts";
import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const REASON = "The shared-device fix belongs in the merge rules, outside the analytics charter.";

let root: string;
/** The runner's combined-run event for Priya's checkpoint, as it crosses the network. */
let event: unknown;
let priyaCheckpoint: string;
let junCheckpoint: string;
let mainSha: string;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-send-upstream-")));
  const repo = join(root, "main");
  await mkdir(join(root, "bridge"));
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  const pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as {
    branches: Record<string, string>;
    tags: Record<string, string>;
  };
  priyaCheckpoint = pins.tags["owner-priya-checkpoint"] as string;
  junCheckpoint = pins.tags["owner-jun-checkpoint"] as string;
  mainSha = pins.branches.main as string;
  const report = await new CombinedRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "bridge"), consent: () => true }),
  }).run({
    checkpointSha: priyaCheckpoint,
    baselineSha: pins.branches.main as string,
    latestCheckpoints: {
      jun: pins.tags["owner-jun-checkpoint"] as string,
      sam: pins.tags["owner-sam-checkpoint"] as string,
    },
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
    sessionUpdate: (caller, id, update) => project.sessionUpdate(caller, id, update),
    reportCheckpoint: () => {
      throw new Error("not used");
    },
  };
}

let nextId = 0;

/** Calls one MCP tool as `owner` and returns its structured result and whether it is an error. */
async function call(
  project: HuddleProject,
  owner: string,
  name: string,
  args: unknown,
): Promise<{ value: any; isError: boolean }> {
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
  return { value: result.structuredContent, isError: result.isError ?? false };
}

async function register(project: HuddleProject, owner: string, identity: string, worktreeId: string): Promise<string> {
  const args = { identity, vendor: "codex", worktreeId, branch: "main" };
  const { value, isError } = await call(project, owner, "register_session", args);
  assert.equal(isError, false, JSON.stringify(value));
  return value.sessionId;
}

/** The Huddle opened from Priya's checkpoint, with @jun/reports holding the shared-device fix, #2. */
async function opened(project: HuddleProject): Promise<void> {
  project.publish("priya", priyaCheckpoint);
  assert.equal((await project.open(event)).status, "opened");
  const shared = project.index.issue("2");
  assert.match(shared?.title ?? "", /shared_device_split/u);
  assert.deepEqual([...(shared?.assignments.keys() ?? [])], ["identity:@jun/reports"]);
}

/** The issue's timeline from `fromSeq` on, as "<status> <author> <type> <assignee or reason>". */
function timeline(project: HuddleProject, issueId: string, fromSeq: number): string[] {
  return project.index
    .read(issueId)
    .timeline.filter((entry) => entry.seq >= fromSeq)
    .map((entry) => {
      const payload = entry.payload as {
        assignee?: { identity?: string; person?: string };
        label?: string;
        reason?: string;
      };
      const detail =
        payload.assignee?.identity ?? payload.assignee?.person ?? payload.label ?? entry.rejectReason ?? payload.reason;
      return `${entry.status} ${entry.author} ${entry.type} ${detail}`;
    });
}

/** The shared-device sub-issue, #2, as get_work reports it to `owner`'s session. */
async function sharedDeviceTask(project: HuddleProject, owner: string, sessionId: string): Promise<any> {
  const { value, isError } = await call(project, owner, "get_work", { sessionId });
  assert.equal(isError, false, JSON.stringify(value));
  const task = value.issues.find((issue: { id: string }) => issue.id === "2");
  assert.ok(task !== undefined, `#2 is not in ${owner}'s work`);
  return task;
}

const lastSeq = (project: HuddleProject, issueId: string): number =>
  project.index.read(issueId).timeline.at(-1)?.seq ?? 0;

test("@jun/reports sends the shared-device sub-issue upstream and it is reassigned to @priya/merge-rules", async () => {
  const project = new HuddleProject();
  const priya = await register(project, "priya", "@priya/merge-rules", "wt-merge");
  const jun = await register(project, "jun", "@jun/reports", "wt-retention");
  await opened(project);
  project.sessions.checkpointWorktree("jun", "wt-retention");
  const from = lastSeq(project, "2") + 1;
  const junTask = await sharedDeviceTask(project, "jun", jun);
  const history = project.index.read("2").timeline.filter((entry) => entry.seq < from);

  const { value, isError } = await call(project, "jun", "post_update", {
    sessionId: jun,
    issue: 2,
    update: { type: "send_upstream", reason: REASON },
  });
  assert.equal(isError, false, JSON.stringify(value));
  assert.deepEqual(value.reassignment, { status: "reassigned", assignee: { identity: "@priya/merge-rules" } });

  // Both steps are on the timeline: the session's upstream note, then Penguin's reassignment. The
  // changing scope's label comes first, so Priya, its owner, may review the fix beside Jun.
  assert.deepEqual(timeline(project, "2", from), [
    `applied jun.reports send_upstream ${REASON}`,
    "applied penguin add_label scope:identity-map",
    "applied penguin assign @priya/merge-rules",
    "applied penguin unassign @jun/reports",
  ]);
  assert.deepEqual(project.index.issue("2")?.labels, ["scope:analytics", "scope:identity-map"]);
  assert.deepEqual([...(project.index.issue("2")?.assignments.keys() ?? [])], ["identity:@priya/merge-rules"]);

  // Priya's running session holds it and receives it at its next safe checkpoint; Jun's no longer does.
  assert.deepEqual(project.sessions.routes("2"), [{ handle: "@priya/merge-rules", sessionId: priya, waitingFor: null }]);
  assert.deepEqual(project.sessions.work("priya", priya), { status: "ok", issueIds: [] });
  assert.deepEqual(project.sessions.checkpointWorktree("priya", "wt-merge")[0]?.delivered, ["2"]);
  assert.deepEqual(project.sessions.work("priya", priya), { status: "ok", issueIds: ["2"] });
  assert.deepEqual(project.sessions.work("jun", jun), { status: "ok", issueIds: ["3"] });
  assert.ok(project.inbox.items("priya").some((item) => item.reason === "assigned" && item.issueId === "2"));

  // Priya's task pins her checkpoint and states acceptance in her scope, against Jun's checkpoint.
  const trigger = `owner-priya@${priyaCheckpoint}`;
  const priyaTask = await sharedDeviceTask(project, "priya", priya);
  assert.deepEqual(priyaTask.pinnedBase, { trigger, baseline: mainSha, checkpoint: trigger });
  assert.deepEqual(priyaTask.failingTests, junTask.failingTests);
  assert.deepEqual(priyaTask.acceptanceCriteria, [
    `analytics test test_identity::shared_device_split passes when your fixed checkpoint of owner-priya is merged ` +
      `with owner-jun@${junCheckpoint}.`,
    "`test:analytics` passes in full on that merge.",
  ]);

  // Jun's task was in Jun's terms, and the issue's history before the reassignment is untouched.
  assert.equal(junTask.pinnedBase.checkpoint, `owner-jun@${junCheckpoint}`);
  assert.equal(
    junTask.acceptanceCriteria[0],
    `test_identity::shared_device_split passes when ${trigger} is merged with your fixed checkpoint of owner-jun.`,
  );
  assert.deepEqual(project.index.read("2").timeline.filter((entry) => entry.seq < from), history);
  assert.ok(project.index.issue("2")?.body.includes(`fails when ${trigger} is merged with owner-jun@${junCheckpoint}.`));
});

test("with no running Priya session, the sub-issue stays assigned to Priya's identity and Priya is asked to start one", async () => {
  const project = new HuddleProject();
  const jun = await register(project, "jun", "@jun/reports", "wt-retention");
  await opened(project);

  const { value, isError } = await call(project, "jun", "post_update", {
    sessionId: jun,
    issue: 2,
    update: { type: "send_upstream", reason: REASON },
  });
  assert.equal(isError, false, JSON.stringify(value));
  assert.deepEqual(value.reassignment.assignee, { identity: "@priya/merge-rules" });
  assert.deepEqual(project.sessions.routes("2"), [{ handle: "@priya/merge-rules", sessionId: null, waitingFor: "session" }]);
  assert.deepEqual(
    project.inbox
      .items("priya")
      .filter((item) => item.issueId === "2")
      .map((item) => item.reason)
      .sort(),
    ["assigned", "start_session"],
  );
  assert.equal(project.index.issue("1")?.state, "fixing");

  // A session Priya starts later receives it at registration, a safe checkpoint.
  const priya = await register(project, "priya", "@priya/merge-rules", "wt-merge");
  assert.deepEqual(project.sessions.work("priya", priya), { status: "ok", issueIds: ["2"] });
  assert.equal(project.inbox.items("priya").some((item) => item.reason === "start_session"), false);
});

test("a send-upstream from a session that is not the assignee is recorded as rejected with its reason", async () => {
  const project = new HuddleProject();
  const sam = await register(project, "sam", "@sam/campaigns", "wt-reengage");
  await opened(project);
  const from = lastSeq(project, "2") + 1;
  const version = project.index.issue("2")?.version;

  const { value, isError } = await call(project, "sam", "post_update", {
    sessionId: sam,
    issue: 2,
    update: { type: "send_upstream", reason: REASON },
  });
  assert.equal(isError, true);
  assert.deepEqual([value.error, value.recordedAs], ["not_assignee", "sam.campaigns-web-0001"]);
  assert.match(value.message, /@sam\/campaigns is not assigned to issue 2/u);
  assert.deepEqual(timeline(project, "2", from), ["rejected sam.campaigns send_upstream not_assignee"]);

  // Nothing moved: the version, the assignee and its routing are as before.
  assert.equal(project.index.issue("2")?.version, version);
  assert.deepEqual([...(project.index.issue("2")?.assignments.keys() ?? [])], ["identity:@jun/reports"]);
  // The rejection waits for the runner like any submitted operation, so it reaches the Git log.
  const pending = project.index.pendingFiles({ bridgeId: "runner", role: "runner" });
  assert.ok(pending.status === "ok" && pending.files.some((file) => file.opId === "sam.campaigns-web-0001"));
});
