/**
 * The Phase 3 exit check (PRD section 11), scripted: JSON-RPC calls to /mcp stand in for Jun's live
 * agent session. Skipped unless PENGUIN_E2E_URL names a Worker; docs/mcp-setup.md says how to run it.
 *
 * 1. Jun's session registers as @jun/reports with Jun's MCP token; Sam's token cannot.
 * 2. Priya opens an issue and assigns @jun/reports with the operations the New issue form sends.
 * 3. Jun's session receives it through get_work, comments and links a commit through post_update.
 * 4. The integration runner pushes those operations to the issues repo.
 * 5. Priya's board and Jun's inbox hear each change over /api/live and show it.
 *
 * The run leaves one closed issue in the project's issues log, and revokes the MCP tokens and the
 * runner bridge it made.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { exitCheckConfig, type ExitCheckConfig } from "./support/config.ts";
import { DashboardClient, type LiveSocket } from "./support/dashboard-client.ts";
import { Deployer, type IssuedToken } from "./support/deployer.ts";
import { McpClient } from "./support/mcp-client.ts";
import { Runner } from "./support/runner.ts";

const HANDLE = "@jun/reports";
/** The handle's author segment, as operations and the timeline name it. */
const AUTHOR_SEGMENT = "jun.reports";
const OWNERS = ["priya", "jun", "sam"];
const TOOLS = ["get_issue", "get_work", "post_update", "register_session", "report_checkpoint"];
// The commit Jun's session links: the identity-unification fixture's fix on Jun's fork.
const PINS = JSON.parse(readFileSync(new URL("../../examples/identity-unification/pins.json", import.meta.url), "utf8"));
const JUN_FIX: string = PINS.branches["owner-jun"];

const configured = exitCheckConfig();

/** Runs `step` until it returns a value other than undefined, or throws after `timeoutMs`. */
async function poll<T>(what: string, timeoutMs: number, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The dashboard's write path: one operation, authored by the signed-in person. */
async function submit(client: DashboardClient, operation: Record<string, unknown>): Promise<{ opId: string; version: number }> {
  const { status, body } = await client.post("/api/operations", operation);
  assert.equal(status, 201, `${operation.type} was not applied: ${JSON.stringify(body)}`);
  return body;
}

/** Jun's @jun/reports, created on the dashboard when the project does not have it yet. */
async function ensureIdentity(jun: DashboardClient): Promise<void> {
  const page = await jun.get("/api/identities");
  const existing = page.identities.find((identity: { handle: string }) => identity.handle === HANDLE);
  if (existing !== undefined) {
    assert.ok(existing.autoAccept, `${HANDLE} must accept assignments automatically for the scripted run`);
    return;
  }
  const charterScopes = page.scopes.filter((scope: { ownerId: string }) => scope.ownerId === "jun").map((scope: { id: string }) => scope.id);
  const { status, body } = await jun.post("/api/identities", {
    handle: HANDLE,
    name: "Reports",
    job: "Build a retention dashboard keyed on user_id",
    charterScopes,
    autoAccept: true,
  });
  assert.equal(status, 201, `creating ${HANDLE}: ${JSON.stringify(body)}`);
}

/** The next free issue number on the board. */
async function nextIssueNumber(priya: DashboardClient): Promise<number> {
  const board = await priya.get("/api/board");
  const numbers = board.issues.map((entry: { issue: { id: string } }) => Number(entry.issue.id)).filter(Number.isInteger);
  return Math.max(0, ...numbers) + 1;
}

async function runExitCheck(t: TestContext, config: ExitCheckConfig): Promise<void> {
  const runId = `e2e-${randomBytes(4).toString("hex")}`;
  const deployer = new Deployer(config.url, config.deployerToken);
  const cleanups: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const timings: Record<string, number> = {};

  // Setup: the repos exist, each owner has an MCP token, the runner's bridge is registered.
  const health = await fetch(`${config.url}/health`);
  assert.equal(health.status, 200);
  const anonymous = await fetch(`${config.url}/mcp`, { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401, "/mcp must refuse a request without a token");
  const setup = await deployer.setUp(OWNERS);
  t.diagnostic(`setup: ${setup.repos.map((repo) => `${repo.name} ${repo.status}`).join(", ")}`);

  const tokens: Record<string, IssuedToken> = {};
  for (const owner of ["jun", "sam"]) {
    tokens[owner] = await deployer.issueMcpToken(owner);
    cleanups.push(() => deployer.revokeMcpToken(tokens[owner]!.tokenId));
  }
  const runner = await Runner.register(config.url, config.runnerOwner, await deployer.bridgeCode(config.runnerOwner, "runner"));
  cleanups.push(() => deployer.revokeBridge(runner.bridgeId));
  cleanups.push(() => runner.dispose());

  const priya = await DashboardClient.signIn(config.url, "priya", config.signIn);
  const jun = await DashboardClient.signIn(config.url, "jun", config.signIn);
  const board: LiveSocket = await priya.openLive();
  const inbox: LiveSocket = await jun.openLive();
  cleanups.push(() => board.close(), () => inbox.close());
  await ensureIdentity(jun);

  // 1. Jun's session connects with Jun's token and registers; Sam's token cannot take the identity.
  const junMcp = new McpClient(config.url, tokens.jun!.token);
  const samMcp = new McpClient(config.url, tokens.sam!.token);
  const init = await junMcp.initialize();
  assert.equal(init.serverInfo.name, "penguin");
  assert.deepEqual(await junMcp.toolNames(), TOOLS);
  const registration = { identity: HANDLE, vendor: "codex", worktreeId: runId, branch: `reports/${runId}` };

  const stolen = await samMcp.call("register_session", registration);
  assert.equal(stolen.isError, true, "Sam's token registered a session as @jun/reports");
  assert.equal(stolen.value.error, "forbidden", JSON.stringify(stolen.value));

  const sessionsBefore = board.messages.length;
  const registered = await junMcp.call("register_session", registration);
  assert.equal(registered.isError, false, JSON.stringify(registered.value));
  const sessionId: string = registered.value.sessionId;
  await board.waitForSession(HANDLE, sessionsBefore, config.timeoutMs);
  const onBoard = (await priya.get("/api/board")).owners
    .find((owner: { id: string }) => owner.id === "jun")
    ?.identities.find((identity: { handle: string }) => identity.handle === HANDLE);
  assert.ok(onBoard?.sessions.some((session: { id: string }) => session.id === sessionId), "the session is not on the board");

  // 2. Priya opens an issue on the dashboard and assigns @jun/reports.
  const number = await nextIssueNumber(priya);
  const issueId = String(number);
  const created = await submit(priya, {
    issue: number,
    type: "create",
    base_version: 0,
    payload: {
      title: `Retention dashboard counts merged users twice (${runId})`,
      body: "Acceptance: daily active users stay stable when two user_ids merge into one person_id.",
    },
  });
  const boardFrom = board.messages.length;
  const inboxFrom = inbox.messages.length;
  const assignedAt = performance.now();
  const assigned = await submit(priya, {
    issue: number,
    type: "assign",
    base_version: created.version,
    payload: { assignee: { identity: HANDLE } },
  });
  await Promise.all([
    board.waitForIssue(issueId, boardFrom, config.timeoutMs),
    inbox.waitForIssue(issueId, inboxFrom, config.timeoutMs),
  ]);
  timings.assignmentToLiveMs = performance.now() - assignedAt;
  const inboxItems = (await jun.get("/api/inbox")).items;
  assert.ok(
    inboxItems.some((item: { issueId: string; reason: string }) => item.issueId === issueId && item.reason === "assigned"),
    `Jun's inbox does not list issue ${issueId} as assigned`,
  );

  // 3. Jun's session receives the issue through get_work, comments and links a commit.
  const work = await junMcp.call("get_work", { sessionId });
  assert.equal(work.isError, false, JSON.stringify(work.value));
  const item = work.value.issues.find((entry: { id: string }) => entry.id === issueId);
  assert.ok(item, `get_work did not return issue ${issueId}`);
  timings.assignmentToGetWorkMs = performance.now() - assignedAt;

  const boardUpdatesFrom = board.messages.length;
  const inboxUpdatesFrom = inbox.messages.length;
  const comment = await junMcp.call("post_update", {
    sessionId,
    issue: number,
    update: { type: "comment", body: "Reproduced: the merge counts a returning user as two daily actives. Fix on owner-jun." },
  });
  assert.equal(comment.isError, false, JSON.stringify(comment.value));
  const link = await junMcp.call("post_update", {
    sessionId,
    issue: number,
    update: { type: "link_commit", commit: `owner-jun@${JUN_FIX}`, kind: "fix" },
  });
  assert.equal(link.isError, false, JSON.stringify(link.value));

  // 5. The board and the inbox hear of the update and show it.
  await Promise.all([
    board.waitForIssue(issueId, boardUpdatesFrom, config.timeoutMs),
    inbox.waitForIssue(issueId, inboxUpdatesFrom, config.timeoutMs),
  ]);
  const page = await priya.get(`/api/issues/${issueId}`);
  const byJun = page.timeline.filter((entry: { author: string | null }) => entry.author === AUTHOR_SEGMENT);
  assert.deepEqual(
    byJun.map((entry: { type: string }) => entry.type),
    ["comment", "link_commit"],
    "the timeline does not show the comment and the linked commit by @jun/reports",
  );
  assert.ok(page.issue.commits.some((commit: { sha: string }) => commit.sha === JUN_FIX), "the linked commit is missing");
  const boardIssue = (await priya.get("/api/board")).issues.find((entry: { issue: { id: string } }) => entry.issue.id === issueId);
  assert.equal(boardIssue?.issue.version, page.issue.version, "the board shows an older version of the issue");

  // 4. The runner pushes the four operations to the issues repo.
  const expected = [created.opId, assigned.opId, comment.value.opId, link.value.opId].map(
    (opId) => `issues/${issueId}/ops/${opId}.json`,
  );
  let assignVisibleMs: number | undefined;
  await poll("the runner's push of every operation", config.timeoutMs, async () => {
    t.diagnostic(`runner: ${(await runner.pass()).trim()}`);
    const files = await runner.remoteOperationFiles(issueId);
    if (assignVisibleMs === undefined && files.includes(expected[1]!)) assignVisibleMs = performance.now() - assignedAt;
    return expected.every((path) => files.includes(path)) ? files : undefined;
  });
  timings.assignmentToAssignInRepoMs = assignVisibleMs!;
  timings.assignmentToAllOpsInRepoMs = performance.now() - assignedAt;

  // Leave the board as it was: Priya closes the issue and the runner pushes the close.
  const closed = await submit(priya, {
    issue: number,
    type: "change_state",
    base_version: (await priya.get(`/api/issues/${issueId}`)).issue.version,
    payload: { state: "closed", reason: `Scripted exit check ${runId} finished.` },
  });
  await poll("the runner's push of the close", config.timeoutMs, async () => {
    await runner.pass();
    return (await runner.remoteOperationFiles(issueId)).includes(`issues/${issueId}/ops/${closed.opId}.json`) || undefined;
  });

  for (const [name, ms] of Object.entries(timings)) t.diagnostic(`${name}: ${Math.round(ms)}`);
  t.diagnostic(`issue ${issueId}, run ${runId}`);
}

test("Phase 3 exit check against a running Worker", { skip: configured.ok ? false : configured.reason, timeout: 600_000 }, async (t) => {
  if (configured.ok) await runExitCheck(t, configured.config);
});
