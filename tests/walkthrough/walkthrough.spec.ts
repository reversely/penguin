/**
 * The three use cases of PRD section 1, each run through the real system: the Worker and both agents
 * under `wrangler dev`, the real Artifacts service under a repo prefix unique to the run, a bridge per
 * owner publishing checkpoints, a runner bridge running the combined and verification tests, scripted
 * agent sessions over MCP and the dashboard in Google Chrome. `npm run walkthrough` runs it.
 *
 * Every owner, handle, scope, SHA and test ID is read from the use case's fixture files at runtime
 * (support/fixture.ts); issue numbers and op ids come from the system's responses.
 * tests/walkthrough/no-literals.test.ts fails when this source names any of them.
 *
 * Each use case is one serial group of seven steps. Each step writes screenshots named
 * `<use case>/<step>-<view>.png`, and each use case writes one video, `<use case>/<use case>.webm`,
 * under the Playwright output directory (test-results/walkthrough).
 */

import { expect, test, type BrowserContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Runner } from "../e2e/support/runner.ts";
import { Dashboard } from "./support/dashboard.ts";
import { BASE_BRANCH, ownerBranch, UseCaseFixture, type ExpectedFix, type FixtureIdentity } from "./support/fixture.ts";
import { ok, OwnerMachine, type AgentSession } from "./support/owner.ts";
import { LocalStack } from "./support/stack.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = join(VENV_BIN, "python");
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);
// Playwright sets FORCE_COLOR for its workers, and pytest then colours its `FAILED <node id>` summary
// lines, which the runner reads the failing tests from. An operator's runner shell has no such setting.
delete process.env.FORCE_COLOR;

/** The use cases of PRD section 1, in order, by fixture folder. */
const USE_CASES = ["identity-unification", "helpful-fix", "dependency-bump"] as const;
const RUN_ID = randomBytes(3).toString("hex");
/** How long a step waits for the runner or the agents to reach the state it expects. */
const WAIT_MS = 8 * 60_000;
/** The runner's options for its test jobs: combined runs, verification runs and approved branches. */
const TEST_JOBS = ["--combined"];

/** Runs `step` until it returns a value other than undefined, or throws after `timeoutMs`. */
async function poll<T>(what: string, timeoutMs: number, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

for (const useCase of USE_CASES) {
  test.describe.serial(useCase, () => {
    const fixture = new UseCaseFixture(REPO_ROOT, useCase);
    const fixes: ExpectedFix[] = fixture.expectedFixes;
    const trigger = fixture.triggerOwner;

    let outDir: string;
    let fixtureRepo: string;
    let stack: LocalStack;
    let runner: Runner;
    let context: BrowserContext;
    let dashboard: Dashboard;
    const machines = new Map<string, OwnerMachine>();
    const sessions = new Map<string, AgentSession>();
    /** Each runner pass's printed summary, kept for the step that fails. */
    const runnerLog: string[] = [];
    let huddleId: string;
    /** The fix sub-issue of each expected fix, by node ID. */
    const subIssueOf = new Map<string, string>();

    const machine = (ownerId: string) => machines.get(ownerId) as OwnerMachine;
    const session = (identity: FixtureIdentity) => sessions.get(identity.handle) as AgentSession;
    const shot = (step: string, view: string) =>
      dashboard.page.screenshot({ path: join(outDir, `${step}-${view}.png`), fullPage: true });
    const runnerPass = async () => {
      try {
        runnerLog.push(await runner.pass(TEST_JOBS));
      } catch (error) {
        runnerLog.push((error as Error).message);
      }
    };
    const huddle = () => dashboard.get(`/api/issues/${huddleId}`);

    test.beforeAll(async ({ browser }, info) => {
      info.setTimeout(10 * 60_000);
      outDir = join(info.project.outputDir, useCase);
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      fixtureRepo = join(await mkdtemp(join(tmpdir(), "penguin-walkthrough-fixture-")), "repo");
      await fixture.build(PYTHON, fixtureRepo);

      const owners = fixture.owners.map((owner) => owner.id);
      stack = await LocalStack.start({
        repoRoot: REPO_ROOT,
        prefix: `wt37-${RUN_ID}-${USE_CASES.indexOf(useCase) + 1}-`,
        owners,
        login: UseCaseFixture.login,
        logFile: join(outDir, "worker.log"),
      });
      // The deployer sets the project up: the base repo holds the fixture's base commit, and each
      // owner's fork is made from it.
      await stack.deployer.setUp(owners);
      await stack.seedBase(fixtureRepo, fixture.baseSha, BASE_BRANCH);
      const setUp = await stack.deployer.setUp(owners);
      expect(setUp.complete, JSON.stringify(setUp.repos)).toBe(true);
      runner = await Runner.register(stack.url, "runner", await stack.deployer.bridgeCode("runner", "runner"));

      context = await browser.newContext({ recordVideo: { dir: join(outDir, "video"), size: { width: 1440, height: 900 } } });
      dashboard = new Dashboard(await context.newPage(), stack.url);
    });

    test.afterAll(async () => {
      const video = dashboard?.page.video();
      await context?.close();
      if (video) await rename(await video.path(), join(outDir, `${useCase}.webm`)).catch(() => undefined);
      await writeFile(join(outDir, "runner.log"), runnerLog.join("\n"));
      for (const owner of machines.values()) await owner.dispose(stack.deployer);
      if (runner) {
        await stack.deployer.revokeBridge(runner.bridgeId).catch(() => undefined);
        await runner.dispose();
      }
      const deleted = stack ? await stack.stop() : [];
      await writeFile(join(outDir, "cleanup.json"), JSON.stringify({ deletedRepos: deleted }, null, 2));
      if (fixtureRepo) await rm(join(fixtureRepo, ".."), { recursive: true, force: true });
    });

    test("1. the bridge publishes each owner's checkpoint", async () => {
      // Each owner signs in, creates the identities the fixture names, and starts one scripted
      // session per identity in the owner's own worktree.
      for (const owner of fixture.owners) {
        await dashboard.signIn(owner.id);
        for (const identity of fixture.identities.filter((candidate) => candidate.owner === owner.id)) {
          const created = await dashboard.post("/api/identities", {
            handle: identity.handle,
            name: identity.handle.split("/")[1],
            job: identity.job,
            charterScopes: identity.charter_scopes,
            autoAccept: true,
          });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
        }
        machines.set(owner.id, await OwnerMachine.set(stack.url, stack.deployer, useCase, owner.id, fixtureRepo, fixture.baseSha));
        for (const identity of fixture.identities.filter((candidate) => candidate.owner === owner.id)) {
          sessions.set(identity.handle, await machine(owner.id).startSession(identity));
        }
      }

      // Dependent owners publish first, so the provider's checkpoint meets their unfinished work.
      for (const owner of fixture.publishOrder) {
        const checkpoint = fixture.checkpointOf(owner.id);
        if (checkpoint === undefined) continue;
        const identity = fixture.identities.find((candidate) => candidate.owner === owner.id);
        const printed = await machine(owner.id).publish(checkpoint, identity);
        expect(printed).toContain(checkpoint);
      }

      await dashboard.open(trigger.id, "/board");
      const board = await dashboard.get("/api/board");
      for (const identity of fixture.identities) {
        const onBoard = board.owners
          .find((owner: { id: string }) => owner.id === identity.owner)
          ?.identities.find((candidate: { handle: string }) => candidate.handle === identity.handle);
        expect(onBoard?.sessions.map((s: { id: string }) => s.id), `${identity.handle}'s session on the board`).toContain(
          session(identity).sessionId,
        );
      }
      await shot("1-checkpoints", "board");
    });

    test("2. the combined run fails on the expected tests", async () => {
      huddleId = await poll("the runner's combined run opening a Huddle", WAIT_MS, async () => {
        await runnerPass();
        const board = await dashboard.get("/api/board");
        const found = board.issues.find(
          (entry: { issue: { labels: string[]; parentId: string | null } }) =>
            entry.issue.labels.includes("huddle") && entry.issue.parentId === null,
        );
        return found?.issue.id as string | undefined;
      });
      const page = await huddle();
      const failing = page.issue.checks.filter((check: { result: string }) => check.result === "fail");
      expect(failing.map((check: { test: string }) => check.test).sort(), "the failing tests").toEqual(
        fixes.map((fix) => fix.testId).sort(),
      );
      const triggerCommit = page.issue.commits.find((commit: { kind: string }) => commit.kind === "trigger");
      expect(triggerCommit?.sha, "the trigger commit").toBe(fixture.checkpointOf(trigger.id));
      await dashboard.open(trigger.id, `/issues/${huddleId}`);
      await expect(dashboard.page.getByRole("heading", { name: "Checks" })).toBeVisible();
      await shot("2-combined-run", "huddle-checks");
    });

    test("3. a Huddle issue opens with one fix sub-issue per affected session", async () => {
      const page = await huddle();
      expect(page.subIssues.length, "fix sub-issues").toBe(fixes.length);
      for (const fix of fixes) {
        const sub = page.subIssues.find((candidate: { checks: { test: string }[] }) =>
          candidate.checks.some((check) => check.test === fix.testId),
        );
        expect(sub, `the fix sub-issue for ${fix.testId}`).toBeDefined();
        subIssueOf.set(fix.nodeId, sub.id);
        expect(sub.assignees.map((assignee: { id: string }) => assignee.id), `#${sub.id}'s assignee`).toEqual([
          fix.firstAssignee.handle,
        ]);
      }
      const expectedLabels = ["huddle", ...new Set([...fixture.changedProviderScopes, ...fixes.map((fix) => fix.scope.id)])].map(
        (label) => (label === "huddle" ? label : `scope:${label}`),
      );
      expect([...page.issue.labels].sort(), "the Huddle's labels").toEqual(expectedLabels.sort());
      await dashboard.open(trigger.id, `/issues/${huddleId}`);
      await shot("3-huddle-open", "huddle");

      // Every affected owner hears of it in the inbox: the trigger's owner and each failing test's owner.
      const affected = new Set([trigger.id, ...fixes.map((fix) => fix.scope.owner)]);
      const huddleIssues = new Set([huddleId, ...subIssueOf.values()]);
      for (const ownerId of affected) {
        await dashboard.open(ownerId, "/inbox");
        const { items } = await dashboard.get("/api/inbox");
        expect(
          items.some((item: { issueId: string }) => huddleIssues.has(item.issueId)),
          `${ownerId}'s inbox lists the Huddle`,
        ).toBe(true);
        await shot("3-huddle-open", `inbox-${fixture.owners.findIndex((owner) => owner.id === ownerId) + 1}`);
      }
    });

    test("4. scripted agent sessions pick up the fix sub-issues and replay the fixture's fix commits", async () => {
      // Each first assignee's session reaches a safe checkpoint and reads its fix tasks.
      for (const fix of fixes) {
        const agent = session(fix.firstAssignee);
        await agent.reportCheckpoint(fixture.checkpointOf(fix.firstAssignee.owner) ?? fixture.baseSha);
        const work = await agent.getWork();
        const item = work.issues.find((entry: { id: string }) => entry.id === subIssueOf.get(fix.nodeId));
        expect(item, `${fix.firstAssignee.handle} receives #${subIssueOf.get(fix.nodeId)}`).toBeDefined();
        expect(item.failingTests.map((t: { nodeId: string }) => t.nodeId)).toEqual([fix.nodeId]);
      }

      // A fix that lies in another owner's scope goes upstream, and Penguin reassigns it.
      for (const fix of fixes.filter((candidate) => candidate.upstream)) {
        const issue = subIssueOf.get(fix.nodeId) as string;
        const sent = ok(
          "send_upstream",
          await session(fix.firstAssignee).update(issue, {
            type: "send_upstream",
            reason: "The fix belongs in the scope the trigger changed, outside this identity's charter.",
          }),
        );
        expect(sent.reassignment, JSON.stringify(sent)).toEqual({ status: "reassigned", assignee: { identity: fix.finalAssignee.handle } });
        const agent = session(fix.finalAssignee);
        await agent.reportCheckpoint(fixture.checkpointOf(fix.finalAssignee.owner) ?? fixture.baseSha);
        const work = await agent.getWork();
        expect(work.issues.map((entry: { id: string }) => entry.id), `${fix.finalAssignee.handle}'s work`).toContain(issue);
        await dashboard.open(fix.scope.owner, `/issues/${issue}`);
        await shot("4-fix", `upstream-${issue}`);
      }

      // Each owner's agent reaches the fixture's fix commit; the bridge publishes it, and the session
      // reports the checkpoint and links the commit to its fix sub-issues.
      for (const owner of fixture.publishOrder) {
        const head = fixture.headOf(owner.id);
        if (head === undefined || head === fixture.checkpointOf(owner.id)) continue;
        const own = fixes.filter((fix) => fix.fixOwner.id === owner.id);
        const identity = own[0]?.finalAssignee ?? fixture.identityFor(owner.id, fixture.changedProviderScopes);
        expect(await machine(owner.id).publish(head, identity)).toContain(head);
        await session(identity).reportCheckpoint(head);
        for (const fix of own) {
          ok(
            "link_commit",
            await session(fix.finalAssignee).update(subIssueOf.get(fix.nodeId) as string, {
              type: "link_commit",
              commit: `${ownerBranch(owner.id)}@${head}`,
              kind: "fix",
            }),
          );
        }
      }
      await dashboard.open(trigger.id, `/issues/${huddleId}`);
      await shot("4-fix", "huddle");
    });

    test("5. verification passes on the Huddle repo's integration branch", async () => {
      const page = await poll("verification reaching review", WAIT_MS, async () => {
        await runnerPass();
        const current = await huddle();
        return current.issue.state === "in_review" ? current : undefined;
      });
      const current = page.issue.checks.filter((check: { supersededBy: string | null }) => check.supersededBy === null);
      expect(current.length, "current checks").toBeGreaterThan(0);
      for (const check of current) {
        expect(check.result, `${check.test} on ${check.repo}@${check.sha}`).toBe("pass");
        expect(check.repo, "the check's repo").toMatch(/^huddle-/u);
      }
      await dashboard.open(trigger.id, `/issues/${huddleId}`);
      await shot("5-verified", "huddle");
    });

    test("6. owners review the fixes on the dashboard", async () => {
      const page = await huddle();
      for (const fix of fixes) {
        const issue = subIssueOf.get(fix.nodeId) as string;
        const { approval } = page.subIssues.find((sub: { id: string }) => sub.id === issue);
        expect(approval?.head, `#${issue}'s head`).toContain(fix.fixSha);
        const reviewers: string[] = approval.owners.map((entry: { owner: string }) => entry.owner);
        expect(reviewers, `#${issue}'s reviewers`).toContain(fix.scope.owner);
        // On a fix sent upstream, the owner whose test it fixes asks for a change first.
        const asking = fix.upstream ? fix.scope.owner : undefined;
        for (const reviewer of reviewers.filter((owner) => owner !== asking)) {
          await dashboard.open(reviewer, `/issues/${issue}`);
          await dashboard.write(issue, "review", { verdict: "approve", commit: approval.head });
        }
        if (asking === undefined) continue;

        await dashboard.open(asking, `/issues/${issue}`);
        await dashboard.write(issue, "review", {
          verdict: "request_changes",
          commit: approval.head,
          reason: "Before I approve, confirm the change keeps every case my failing test covers.",
        });
        const [thread] = (await dashboard.issue(issue)).issue.threads;
        expect(thread?.status, "the thread the request for changes opened").toBe("open");
        expect(thread.needsPersonIds, "who the thread needs").toContain(fix.fixOwner.id);
        await dashboard.page.reload();
        await shot("6-review", `changes-requested-${issue}`);

        // The fix's session sees the thread through get_work, tells its developer and replies.
        const agent = session(fix.finalAssignee);
        const work = await agent.getWork();
        expect(work.threadsNeedingYou.map((t: { id: string }) => t.id), "threads needing the developer").toContain(thread.id);
        ok("reply_thread", await agent.update(issue, { type: "reply_thread", thread: thread.id, body: "My developer has seen this thread." }));

        // The fix owner answers in the thread on the issue page.
        await dashboard.open(fix.fixOwner.id, `/issues/${issue}`);
        await dashboard.page.locator(`#thread-reply-${thread.id}`).fill("Confirmed: the combined tests cover every case, and they pass.");
        await dashboard.page.getByRole("button", { name: "Reply" }).click();
        await expect(dashboard.page.getByText("Confirmed: the combined tests cover every case")).toBeVisible();
        await shot("6-review", `thread-reply-${issue}`);

        // The reviewer approves and resolves the thread on the issue page.
        await dashboard.open(asking, `/issues/${issue}`);
        await dashboard.write(issue, "review", { verdict: "approve", commit: approval.head });
        await dashboard.page.reload();
        await dashboard.page.getByRole("button", { name: "Resolve" }).click();
        await expect(dashboard.page.getByText(/Resolved by/u)).toBeVisible();
        await shot("6-review", `thread-resolved-${issue}`);
      }
      const after = await huddle();
      for (const sub of after.subIssues) expect(sub.approval?.approved, `#${sub.id} approved`).toBe(true);
    });

    test("7. the issue closes as approved", async () => {
      const page = await poll("the Huddle closing as approved", WAIT_MS, async () => {
        await runnerPass();
        const current = await huddle();
        return current.issue.state === "closed" ? current : undefined;
      });
      expect(page.issue.closeOut.resolution).toBe("approved");
      expect(page.issue.closeOut.approvedCommit, "the approved branch's commit").toMatch(/^huddle-/u);
      for (const sub of page.subIssues) expect(sub.approval?.approved, `#${sub.id} approved`).toBe(true);
      const current = page.issue.checks.filter((check: { supersededBy: string | null }) => check.supersededBy === null);
      for (const check of current) expect(check.result).toBe("pass");
      for (const id of [huddleId, ...subIssueOf.values()]) {
        const { issue } = await dashboard.issue(id);
        for (const thread of issue.threads) expect(thread.status, `thread ${thread.id} on #${id}`).toBe("resolved");
      }
      await dashboard.open(trigger.id, `/issues/${huddleId}`);
      await shot("7-closed", "huddle");
      await dashboard.open(trigger.id, "/board?done=all");
      await shot("7-closed", "board");
    });
  });
}
