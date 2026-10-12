// Phase 4's close-out (#44) on the identity-unification fixture, without the network: the Huddle
// opens from the owners' unfixed checkpoints, @jun/reports sends the shared-device fix upstream to
// Priya, the owners' fixed checkpoints pass on the integration branch, and every owner whose review
// counts reviews each fix's head. Jun requests changes on the shared-device fix and opens a thread.
// Once every fix is approved and the thread is resolved, the runner points the Huddle repo's
// `approved` branch at the verified integration commit, and Penguin links it and closes the issue.

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
  approvalPass,
  ApprovedBranchWriter,
  combinedRunEvent,
  CombinedRunner,
  localRemote,
  penguinRepoOf,
  TestRunner,
  verificationPass,
  VerificationRunner,
  type ApprovalReply,
  type RemoteResolver,
  type VerificationReply,
  ownerForkTargets,
} from "@penguin/local-bridge";
import { buildIssuePage } from "../../services/project-agent/src/issue-page.ts";
import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const OWNERS = ["priya", "jun", "sam"] as const;
const REASON = "The shared-device fix belongs in the merge rules, outside the analytics charter.";
const HUDDLE = "1";

let root: string;
let fixture: string;
let pins: { branches: Record<string, string>; tags: Record<string, string> };
/** The combined-run event of the owners' unfixed checkpoints, as the runner reported it. */
let opening: unknown;

const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]).then(({ stdout }) => stdout.trim());

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-huddle-close-")));
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
 * @priya/merge-rules, and every owner's fixed checkpoint verified on the integration branch, with
 * the runner that records the approved branch in the bare Huddle repo.
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

  const subIssues = [...(project.index.issue(HUDDLE)?.subIssues.keys() ?? [])];
  const shared = subIssues.find((sub) => /shared_device_split/u.test(project.index.issue(sub)?.title ?? ""));
  assert.ok(shared !== undefined, "the shared-device fix sub-issue");

  const session = project.sessions.register("jun", { identity: "@jun/reports", vendor: "codex", worktreeId: "wt-retention", branch: "main" });
  assert.equal(session.status, "ok", JSON.stringify(session));
  const sent = await project.sessionUpdate("jun", session.status === "ok" ? session.session.id : "", {
    issue: Number(shared),
    type: "send_upstream",
    payload: { reason: REASON },
  });
  assert.equal(sent.status, "applied", JSON.stringify(sent));

  const verifier = new VerificationRunner({ repoPath: runnerRepo, runner: testRunner(runnerRepo), readRemotes: remotes, writeRemotes: remotes });
  const report = async (runId: string, body: unknown): Promise<VerificationReply> => {
    const outcome = await project.reportVerification(runId, body);
    assert.notEqual(outcome.status, "rejected", JSON.stringify(outcome));
    return outcome as VerificationReply;
  };
  const verify = () => verificationPass({ list: async () => project.verificationSpecs(), run: (spec) => verifier.run(spec), report });

  const writer = new ApprovedBranchWriter({ repoPath: runnerRepo, writeRemotes: remotes });
  const approve = () =>
    approvalPass({
      list: async () => project.approvalSpecs(),
      write: (spec) => writer.write(spec),
      report: async (issueId, body) => {
        const outcome = await project.reportApprovedBranch(issueId, body);
        assert.equal(outcome.status, "recorded", JSON.stringify(outcome));
        return outcome as ApprovalReply;
      },
    });

  for (const owner of OWNERS) await publish(owner, pins.branches[`owner-${owner}`] as string);
  await verify();
  assert.equal(project.index.issue(HUDDLE)?.state, "in_review");
  return { project, subIssues, shared, publish, verify, approve, huddleRepo: bare("huddle-001") };
}

/** Every owner whose review counts on the fix approves its head, except `except`. */
async function approveAll(project: HuddleProject, fix: string, except: readonly string[] = []): Promise<void> {
  const approval = project.approval(fix);
  assert.ok(approval?.head != null, `#${fix} has a head`);
  for (const { owner } of approval.owners.filter((o) => !except.includes(o.owner))) {
    const outcome = await project.review(owner, fix, { verdict: "approve", commit: approval.head });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  }
}

/** The Huddle issue's rejected operations as "<author> <reason>: <message>". */
function refusals(project: HuddleProject): string[] {
  return project.index
    .read(HUDDLE)
    .timeline.filter((entry) => entry.status === "rejected")
    .map((entry) => `${entry.author} ${entry.rejectReason}: ${entry.message}`);
}

/** The Huddle issue's close-out as the issue page shows it. */
function closeOutOf(project: HuddleProject) {
  const sources = {
    read: (id: string) => project.index.read(id),
    issue: (id: string) => project.index.issue(id),
    routes: (id: string) => project.sessions.routes(id),
    session: (id: string) => project.sessions.get(id),
    waitingOn: (id: string) => project.closeOuts.get(id),
  };
  return buildIssuePage(sources, HUDDLE)?.issue.closeOut;
}

/** A close of the Huddle issue written on the dashboard by `person`. */
function close(project: HuddleProject, person: string, resolution?: "approved" | "cancelled") {
  const reason = resolution === "cancelled" ? "The trigger is withdrawn." : "Everything is approved.";
  return project.dashboard(person, HUDDLE, "change_state", { state: "closed", reason, ...(resolution ? { resolution } : {}) });
}

test("after every approval, a passing integration run and the resolved thread, the issue closes with the approved branch", async () => {
  const { project, subIssues, shared, approve, huddleRepo } = await inReview("approved");
  const starter = project.huddles.byIssue(HUDDLE)?.triggerOwner as string;
  const [check] = [...(project.index.issue(HUDDLE)?.checks.values() ?? [])].filter((c) => c.supersededBy === null);
  assert.ok(check !== undefined && check.result === "pass");
  const integration = `${check.repo}@${check.sha}`;
  assert.equal(await git(huddleRepo, "rev-parse", "refs/heads/integration"), check.sha);

  // Every fix but the shared-device one is approved. On that one, Jun requests changes, which opens a
  // thread on the fix, and Jun opens a thread of his own on the Huddle issue from the dashboard.
  for (const fix of subIssues.filter((sub) => sub !== shared)) await approveAll(project, fix);
  await approveAll(project, shared, ["jun"]);
  const head = project.approval(shared)?.head as string;
  await project.dashboard("jun", shared, "review", { verdict: "request_changes", commit: head, reason: "A limit of five still joins the tablet's users." });
  const [reviewThread] = [...(project.index.issue(shared)?.threads.values() ?? [])];
  assert.ok(reviewThread !== undefined && reviewThread.status === "open", "the request for changes opened a thread");
  const threadId = reviewThread.id;
  const own = await project.dashboard("jun", HUDDLE, "open_thread", { body: "Check the cohorts once the limit moves.", needs: [starter] });
  assert.equal(own.status, "applied", JSON.stringify(own));
  const ownId = own.status === "applied" ? own.opId : "";

  // Closing now is refused, and the timeline says why.
  const early = await close(project, starter);
  assert.equal(early.status, "rejected");
  const [refusal] = refusals(project);
  assert.match(refusal ?? "", new RegExp(`^${starter} close_blocked: #1 cannot close as approved: `, "u"));
  assert.match(refusal ?? "", new RegExp(`#${shared} lacks approval from jun \\(changes requested\\)`, "u"));
  assert.match(refusal ?? "", new RegExp(`Thread ${threadId} on #${shared} is open`, "u"));
  assert.match(refusal ?? "", new RegExp(`Thread ${ownId} on #1 is open`, "u"));
  assert.deepEqual(project.approvalSpecs(), []);

  // Jun approves after agreeing in the thread; the open threads still hold the close.
  await project.dashboard(starter, shared, "reply_thread", { thread: threadId, body: "Agreed, lowering the limit." });
  await approveAll(project, shared);
  assert.equal(project.approval(shared)?.approved, true);
  assert.deepEqual(project.closeOuts.get(HUDDLE), [`Thread ${ownId} on #1 is open.`, `Thread ${threadId} on #${shared} is open.`]);
  await project.dashboard("jun", HUDDLE, "resolve_thread", { thread: ownId, reason: "The cohorts hold." });
  assert.deepEqual(project.closeOuts.get(HUDDLE), [`Thread ${threadId} on #${shared} is open.`]);
  assert.deepEqual(project.approvalSpecs(), []);

  // Resolving the last thread leaves nothing in the way: the runner is asked for the approved branch.
  await project.dashboard("jun", shared, "resolve_thread", { thread: threadId, reason: "The lower limit splits the tablet's users." });
  assert.deepEqual(project.approvalSpecs(), [{ issueId: HUDDLE, huddleRepo: "huddle-001", sha: check.sha }]);
  assert.equal(project.index.issue(HUDDLE)?.state, "in_review");

  const pass = await approve();
  assert.deepEqual(pass.failed, []);
  assert.equal(await git(huddleRepo, "rev-parse", "refs/heads/approved"), check.sha);

  const issue = project.index.issue(HUDDLE);
  assert.equal(issue?.state, "closed");
  assert.match(issue?.stateReason ?? "", /^All 3 fixes are approved, the combined tests pass on huddle-001@[0-9a-f]{12} and every thread is resolved\./u);
  const approved = [...(issue?.linkedCommits.values() ?? [])].filter((link) => link.kind === "approved");
  assert.deepEqual(approved.map((link) => `${link.repo}@${link.sha}`), [integration]);
  assert.deepEqual(project.approvalSpecs(), []);

  assert.deepEqual(closeOutOf(project), { waitingOn: [], approvedCommit: integration, resolution: "approved" });
  // A repeated report changes nothing.
  assert.equal((await project.reportApprovedBranch(HUDDLE, { sha: check.sha })).status, "recorded");
  assert.equal([...(project.index.issue(HUDDLE)?.linkedCommits.values() ?? [])].filter((l) => l.kind === "approved").length, 1);
});

test("a newer checkpoint supersedes the checks: the approval request is withdrawn and closing is refused", async () => {
  const { project, subIssues, publish, verify } = await inReview("superseded");
  const starter = project.huddles.byIssue(HUDDLE)?.triggerOwner as string;
  for (const fix of subIssues) await approveAll(project, fix);
  assert.equal(project.approvalSpecs().length, 1);

  // The starting owner publishes a newer checkpoint on top of the fix: the checks are superseded.
  const fixed = pins.branches[`owner-${starter}`] as string;
  const env = { ...process.env, GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.com", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.com" };
  const { stdout } = await run("git", ["-C", fixture, "commit-tree", `${fixed}^{tree}`, "-p", fixed, "-m", "Tidy the fix"], { env });
  await publish(starter, stdout.trim());
  assert.equal(project.index.issue(HUDDLE)?.state, "verifying");
  assert.deepEqual(project.approvalSpecs(), []);
  assert.ok(project.closeOuts.get(HUDDLE)?.some((line) => /superseded by a newer checkpoint/u.test(line)));

  const refused = await close(project, starter);
  assert.equal(refused.status, "rejected");
  assert.match(refusals(project).at(-1) ?? "", /close_blocked: .*#1 is verifying, not in review\. Every check is superseded by a newer checkpoint/u);

  // The newer checkpoint passes again, and its fix needs approving on the new head before the close.
  await verify();
  assert.equal(project.index.issue(HUDDLE)?.state, "in_review");
  assert.deepEqual(project.approvalSpecs(), []);
  for (const fix of subIssues) if (project.approval(fix)?.approved !== true) await approveAll(project, fix);
  assert.equal(project.approvalSpecs().length, 1);
});

test("the owner who started the work cancels the Huddle; anyone else's cancel is rejected", async () => {
  const { project, subIssues } = await inReview("cancelled");
  const starter = project.huddles.byIssue(HUDDLE)?.triggerOwner as string;
  const other = OWNERS.find((owner) => owner !== starter) as string;
  for (const fix of subIssues) await approveAll(project, fix);
  assert.equal(project.approvalSpecs().length, 1);
  assert.deepEqual(closeOutOf(project)?.waitingOn, [`The approved branch is being recorded at huddle-001@${project.approvalSpecs()[0]?.sha}.`]);

  const rejected = await close(project, other, "cancelled");
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(refusals(project), [`${other} not_starting_owner: only ${starter}, who started the work, may cancel #1`]);
  assert.equal(project.index.issue(HUDDLE)?.state, "in_review");

  const cancelled = await close(project, starter, "cancelled");
  assert.equal(cancelled.status, "applied", JSON.stringify(cancelled));
  assert.equal(project.index.issue(HUDDLE)?.state, "closed");
  assert.equal(project.index.issue(HUDDLE)?.stateReason, "The trigger is withdrawn.");
  assert.deepEqual(project.approvalSpecs(), []);
  assert.deepEqual(closeOutOf(project), { waitingOn: [], approvedCommit: null, resolution: "cancelled" });
  // Nothing was linked as approved.
  assert.ok(![...(project.index.issue(HUDDLE)?.linkedCommits.values() ?? [])].some((link) => link.kind === "approved"));
});
