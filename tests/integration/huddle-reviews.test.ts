// Phase 4's review collection (#42) on the identity-unification fixture, without the network: the
// Huddle opens from the owners' unfixed checkpoints, @jun/retention-dashboard sends the shared-device fix
// upstream to Priya, the owners' fixed checkpoints pass on the integration branch, and Penguin asks
// each owner whose review counts to review each fix's head. Reviews then count only from those
// owners or their delegates, and only on the head. Jun's request for changes on the shared-device fix
// opens a thread that reaches Priya's inbox and her running session (#43); the agent sessions are
// JSON-RPC calls to the real MCP tools over the ProjectAgent's real stores.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  combinedRunEvent,
  CombinedRunner,
  hookAnswer,
  localRemote,
  penguinRepoOf,
  TestRunner,
  verificationPass,
  VerificationRunner,
  type RemoteResolver,
  type VerificationReply,
  ownerForkTargets,
} from "@penguin/local-bridge";

import { serveMcp, type McpProject } from "@penguin/mcp";

import { fixTask } from "../../services/project-agent/src/fix-task.ts";
import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const OWNERS = ["priya", "jun", "sam"] as const;
const REASON = "The shared-device fix belongs in the merge rules, outside the analytics charter.";

let root: string;
let fixture: string;
let pins: { branches: Record<string, string>; tags: Record<string, string> };
/** The combined-run event of the owners' unfixed checkpoints, as the runner reported it. */
let opening: unknown;

const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]).then(({ stdout }) => stdout.trim());

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-huddle-reviews-")));
  fixture = join(root, "fixture");
  await mkdir(join(root, "scratch"));
  await run(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8"));
  const report = await new CombinedRunner({ repoPath: fixture, runner: testRunner(fixture) }).run({
    checkpointSha: pins.tags["owner-priya-checkpoint"] as string,
    baselineSha: pins.branches.main as string,
    targets: ownerForkTargets({ jun: pins.tags["owner-jun-checkpoint"] as string, sam: pins.tags["owner-sam-checkpoint"] as string }),
  });
  opening = JSON.parse(JSON.stringify(combinedRunEvent(report, "priya")));
});

after(() => rm(root, { recursive: true, force: true }));

function testRunner(repoPath: string): TestRunner {
  return new TestRunner({ repoPath, env: TEST_ENV, scratchDir: join(root, "scratch"), consent: () => true });
}

/**
 * One project with the Huddle open from the unfixed run, the shared-device fix sent upstream to
 * @priya/person-id-merge-rules, and every owner's fixed checkpoint verified on the integration branch.
 */
async function inReview(name: string) {
  const dir = join(root, name);
  const repos = join(dir, "repos");
  const bare = (repo: string) => join(repos, `${repo}.git`);
  for (const owner of OWNERS) await run("git", ["init", "--quiet", "--bare", bare(`owner-${owner}`)]);
  await run("git", ["init", "--quiet", "--bare", bare("huddle-001")]);
  await git(fixture, "push", "--quiet", bare("huddle-001"), `${pins.branches.main}:refs/heads/main`);
  const runnerRepo = join(dir, "runner");
  await run("git", ["init", "--quiet", runnerRepo]);
  const remotes: RemoteResolver = (remote) => localRemote(bare(penguinRepoOf(remote) as string));

  const project = new HuddleProject();
  const publish = async (owner: string, sha: string) => {
    await git(fixture, "push", "--quiet", bare(`owner-${owner}`), `${sha}:refs/heads/main`);
    return project.checkpoint(owner, sha);
  };
  for (const owner of OWNERS) await publish(owner, pins.tags[`owner-${owner}-checkpoint`] as string);
  const opened = await project.open(opening);
  assert.equal(opened.status, "opened", JSON.stringify(opened));
  project.huddles.setRepo(opened.status === "opened" ? opened.huddle.triggerCommit : "", "huddle-001");

  const fix = (pattern: RegExp): string => {
    const id = [...(project.index.issue("1")?.subIssues.keys() ?? [])].find((sub) =>
      pattern.test(project.index.issue(sub)?.title ?? ""),
    );
    assert.ok(id !== undefined, `a fix sub-issue matching ${pattern}`);
    return id;
  };
  const fixes = { retention: fix(/dau_stable/u), shared: fix(/shared_device_split/u), consent: fix(/unsubscribe/u) };

  const session = project.sessions.register("jun", {
    identity: "@jun/retention-dashboard",
    vendor: "codex",
    worktreeId: "wt-retention",
    branch: "main",
  });
  assert.equal(session.status, "ok", JSON.stringify(session));
  const sent = await project.sessionUpdate("jun", session.status === "ok" ? session.session.id : "", {
    issue: Number(fixes.shared),
    type: "send_upstream",
    payload: { reason: REASON },
  });
  assert.equal(sent.status, "applied", JSON.stringify(sent));

  const runner = new VerificationRunner({
    repoPath: runnerRepo,
    runner: testRunner(runnerRepo),
    readRemotes: remotes,
    writeRemotes: remotes,
  });
  const report = async (runId: string, body: unknown): Promise<VerificationReply> => {
    const outcome = await project.reportVerification(runId, body);
    assert.notEqual(outcome.status, "rejected", JSON.stringify(outcome));
    return outcome as VerificationReply;
  };
  const verify = () =>
    verificationPass({ list: async () => project.verificationSpecs(), run: (spec) => runner.run(spec), report });

  for (const owner of OWNERS) await publish(owner, pins.branches[`owner-${owner}`] as string);
  await verify();
  assert.equal(project.index.issue("1")?.state, "in_review");
  return { project, fixes, publish, verify };
}

/** A newer commit on top of `parent` with the same tree, as Priya's next checkpoint. */
async function newerCheckpoint(parent: string, message: string): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: "Priya", GIT_AUTHOR_EMAIL: "priya@example.com" };
  const env = { ...process.env, ...identity, GIT_COMMITTER_NAME: "Priya", GIT_COMMITTER_EMAIL: "priya@example.com" };
  const { stdout } = await run("git", ["-C", fixture, "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message], { env });
  return stdout.trim();
}

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
    // As the ProjectAgent has it: an operation that changes a fix's threads has its Huddle collect again.
    sessionUpdate: async (caller, id, update) => {
      const outcome = await project.sessionUpdate(caller, id, update);
      await project.collectFor(String(update.issue));
      return outcome;
    },
    reportCheckpoint: () => {
      throw new Error("not used");
    },
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

/** The fix sub-issues the person is asked to review, by number. */
function reviewRequests(project: HuddleProject, person: string): string[] {
  return project.inbox
    .items(person)
    .filter((item) => item.reason === "review_requested")
    .map((item) => item.issueId)
    .sort();
}

/** Each owner's standing on the fix, as "<owner> <state>[ by <reviewer>]". */
function standing(project: HuddleProject, issueId: string): string[] {
  return (project.approval(issueId)?.owners ?? []).map(
    (owner) => `${owner.owner} ${owner.state}${owner.reviewer === null || owner.reviewer === owner.owner ? "" : ` by ${owner.reviewer}`}`,
  );
}

test("passing combined tests request reviews; Jun's review of the shared-device fix counts and an unrelated owner's does not", async () => {
  const { project, fixes } = await inReview("rights");
  const priyaHead = `owner-priya@${pins.branches["owner-priya"]}`;

  // Each fix's head is the fixing owner's checkpoint that passed, and each owner whose review counts
  // is asked: Jun for the test he owns in every analytics fix, Priya for the merge rules, Sam for consent.
  assert.equal(project.approval(fixes.shared)?.head, priyaHead);
  assert.equal(project.approval(fixes.retention)?.head, `owner-jun@${pins.branches["owner-jun"]}`);
  assert.equal(project.approval(fixes.consent)?.head, `owner-sam@${pins.branches["owner-sam"]}`);
  assert.deepEqual(reviewRequests(project, "jun"), [fixes.retention, fixes.shared].sort());
  assert.deepEqual(reviewRequests(project, "priya"), [fixes.shared]);
  assert.deepEqual(reviewRequests(project, "sam"), [fixes.consent]);
  assert.deepEqual(reviewRequests(project, "lee"), []);
  assert.deepEqual(standing(project, fixes.shared), ["jun pending", "priya pending"]);

  // Jun's test is the one the shared-device fix resolves, so Jun's review counts.
  const jun = await project.review("jun", fixes.shared, { verdict: "approve", commit: priyaHead });
  assert.equal(jun.status, "applied", JSON.stringify(jun));
  const junReview = project.index.issue(fixes.shared)?.reviews.get(jun.status === "applied" ? jun.opId : "");
  assert.deepEqual([junReview?.counts, junReview?.countsFor], [true, ["jun"]]);
  assert.deepEqual(standing(project, fixes.shared), ["jun approved", "priya pending"]);

  // Sam owns neither the fix's scope nor the failing test: the review is kept, with why it does not count.
  const sam = await project.review("sam", fixes.shared, {
    verdict: "request_changes",
    commit: priyaHead,
    reason: "A limit of five still joins the tablet's users.",
  });
  assert.equal(sam.status, "applied", JSON.stringify(sam));
  const samReview = project.index.issue(fixes.shared)?.reviews.get(sam.status === "applied" ? sam.opId : "");
  assert.equal(samReview?.counts, false);
  assert.match(samReview?.uncountedReason ?? "", /sam owns no scope labelled on this issue .*analytics, identity-map/u);
  assert.deepEqual(standing(project, fixes.shared), ["jun approved", "priya pending"]);

  // Lee is Priya's delegate in owners.json: Lee's approval counts in Priya's place and names Lee.
  project.delegates.set("priya", "lee");
  const lee = await project.review("lee", fixes.shared, { verdict: "approve", commit: priyaHead });
  assert.equal(lee.status, "applied", JSON.stringify(lee));
  const leeReview = project.index.issue(fixes.shared)?.reviews.get(lee.status === "applied" ? lee.opId : "");
  assert.deepEqual([leeReview?.reviewerOwnerId, leeReview?.counts, leeReview?.countsFor], ["lee", true, ["priya"]]);
  assert.deepEqual(standing(project, fixes.shared), ["jun approved", "priya approved by lee"]);
  assert.equal(project.approval(fixes.shared)?.approved, true);
});

test("a review of a commit older than the fix's head does not count, and the owner is asked again", async () => {
  const { project, fixes, publish, verify } = await inReview("superseded");
  const firstHead = `owner-priya@${pins.branches["owner-priya"]}`;
  await project.review("jun", fixes.shared, { verdict: "approve", commit: firstHead });
  await project.review("priya", fixes.shared, { verdict: "approve", commit: firstHead });
  assert.equal(project.approval(fixes.shared)?.approved, true);
  for (const item of project.inbox.items("jun")) project.inbox.markRead("jun", item.issueId, item.reason);

  // Priya publishes a newer checkpoint on top of her fix; it passes again and becomes the fix's head.
  const newer = await newerCheckpoint(pins.branches["owner-priya"] as string, "Tidy the merge rules");
  await publish("priya", newer);
  assert.equal(project.index.issue("1")?.state, "verifying");
  await verify();
  assert.equal(project.index.issue("1")?.state, "in_review");

  const head = `owner-priya@${newer}`;
  assert.equal(project.approval(fixes.shared)?.head, head);
  assert.deepEqual(standing(project, fixes.shared), ["jun pending", "priya pending"]);
  assert.equal(project.approval(fixes.shared)?.approved, false);
  const unread = project.inbox.items("jun").filter((item) => !item.read).map((item) => `${item.reason} ${item.issueId}`);
  assert.deepEqual(unread, [`review_requested ${fixes.shared}`]);

  // A review still naming the older commit holds the right but not the head, so it does not count.
  await project.review("jun", fixes.shared, { verdict: "approve", commit: firstHead });
  assert.deepEqual(standing(project, fixes.shared), ["jun pending", "priya pending"]);
  await project.review("jun", fixes.shared, { verdict: "approve", commit: head });
  assert.deepEqual(standing(project, fixes.shared), ["jun approved", "priya pending"]);
});

test("Jun's request for changes on the shared-device fix opens a thread that reaches Priya's inbox and session; after a passing rerun and Jun resolving it, the fix is approved again", async () => {
  const { project, fixes, publish, verify } = await inReview("threads");
  const firstHead = `owner-priya@${pins.branches["owner-priya"]}`;
  const reason = "A limit of five still joins the tablet's users.";
  const priya = (
    await call(project, "priya", "register_session", {
      identity: "@priya/person-id-merge-rules",
      vendor: "claude-code",
      worktreeId: "wt-merge",
      branch: "main",
    })
  ).sessionId;
  project.sessions.checkpointWorktree("priya", "wt-merge");
  await project.review("priya", fixes.shared, { verdict: "approve", commit: firstHead });

  // Jun's review counts, so it opens a thread on the shared-device fix that needs Priya.
  const jun = await project.review("jun", fixes.shared, { verdict: "request_changes", commit: firstHead, reason });
  assert.equal(jun.status, "applied", JSON.stringify(jun));
  const [thread, ...others] = project.index.issue(fixes.shared)?.threads.values() ?? [];
  assert.equal(others.length, 0);
  assert.deepEqual([thread?.body, thread?.needsPersonIds, thread?.status], [reason, ["priya"], "open"]);
  const threadId = thread?.id ?? "";
  assert.deepEqual(standing(project, fixes.shared), ["jun changes_requested", "priya approved"]);
  assert.equal(project.index.issue("1")?.state, "in_review");

  // The thread lands in Priya's inbox and reaches her running session at its next safe checkpoint.
  const unread = (person: string) =>
    project.inbox
      .items(person)
      .filter((item) => item.reason === "thread" && !item.read)
      .map((item) => item.issueId);
  assert.deepEqual(unread("priya"), [fixes.shared]);
  assert.deepEqual(unread("jun"), []);
  const [delivery] = project.sessions.checkpointWorktree("priya", "wt-merge");
  assert.deepEqual(delivery?.threads, [{ issueId: fixes.shared, threadId }]);
  const answer = JSON.parse(hookAnswer([{ ...delivery!, identity: delivery!.handle, overlaps: [], locksSettled: [], toolResults: [], newPlanParts: [], planDecisions: [], reviewResults: [] }]) ?? "");
  assert.match(answer.hookSpecificOutput.additionalContext, new RegExp(`a thread on #${fixes.shared} now needs the developer of @priya/person-id-merge-rules`, "u"));
  const work = await call(project, "priya", "get_work", { sessionId: priya });
  assert.deepEqual(
    work.threadsNeedingYou.map((needing: any) => [needing.issueId, needing.id, needing.personWritten.body]),
    [[fixes.shared, threadId, reason]],
  );

  // Priya's agent answers in the thread, and Jun hears of the reply.
  await call(project, "priya", "post_update", {
    sessionId: priya,
    issue: Number(fixes.shared),
    update: { type: "reply_thread", thread: threadId, body: "Lowering the limit to two." },
  });
  assert.deepEqual(unread("jun"), [fixes.shared]);

  // Priya's lower limit passes the combined tests again; the earlier approvals are set aside.
  const newer = await newerCheckpoint(pins.branches["owner-priya"] as string, "Lower the per-device limit");
  await publish("priya", newer);
  assert.equal(project.index.issue("1")?.state, "verifying");
  await verify();
  assert.equal(project.index.issue("1")?.state, "in_review");
  const head = `owner-priya@${newer}`;
  assert.deepEqual(standing(project, fixes.shared), ["jun pending", "priya pending"]);
  assert.equal(project.index.issue(fixes.shared)?.threads.get(threadId)?.status, "open");

  // Only the thread's people resolve it; Jun does, and the Huddle's tracked threads are all resolved.
  const sam = await project.thread("sam", fixes.shared, "resolve_thread", { thread: threadId });
  assert.equal(sam.status === "rejected" && sam.reason, "not_thread_participant");
  const resolved = await project.thread("jun", fixes.shared, "resolve_thread", { thread: threadId, reason: "Two keeps them apart." });
  assert.equal(resolved.status, "applied", JSON.stringify(resolved));
  const [huddle] = project.huddles.open();
  assert.deepEqual(project.threadsOf(huddle?.triggerCommit ?? "").unresolved(), []);
  assert.deepEqual((await call(project, "priya", "get_work", { sessionId: priya })).threadsNeedingYou, []);

  await project.review("jun", fixes.shared, { verdict: "approve", commit: head });
  await project.review("priya", fixes.shared, { verdict: "approve", commit: head });
  assert.equal(project.approval(fixes.shared)?.approved, true);
  assert.equal(project.index.issue(fixes.shared)?.threads.size, 1);
});
