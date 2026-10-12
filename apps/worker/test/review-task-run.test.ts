// A review task run headless from the person's bridge (#138, PRD 0.5 section 4.4a), without the
// network: Jun's bridge claims the review form for part utc-day/v1#1 on the helpful-fix fixture and
// runs a fake `claude` or `codex` in a checkout of Priya's fork. The fake CLI reaches Penguin's MCP
// server where the real CLI would, through the MCP config the bridge wrote, with the task token. The
// server is the real one: the Worker's /mcp route and token check, the review-task MCP server and the
// ProjectAgent's checks and submit_review on its stores (services/project-agent/test/review-project.ts).
// The form submits; any other tool and another scope are refused; the token never reaches the CLI's
// arguments and stops working once the bridge reports the run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { localRemote, MemoryConsentStore, runEditTask, type ClaimedEditTask, type EditRunnerOptions, type EditVendor } from "@penguin/local-bridge";
import { serveReviewTaskMcp } from "@penguin/mcp";

import { mcpReviewTask, type FeaturePorts } from "../src/features.ts";
import { handleMcpRoute, type McpHandlers } from "../src/mcp.ts";
import { claimEditTasks, reportEditTask, syncEditWork } from "../../../services/project-agent/src/edit-work.ts";
import { reviewTaskCall, taskSessionId } from "../../../services/project-agent/src/review-task.ts";
import { FEATURE, ReviewProject } from "../../../services/project-agent/test/review-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE = join(REPO_ROOT, "services", "local-bridge", "test", "fake-agent.ts");
const FORM = join(REPO_ROOT, "examples", "helpful-fix", "reviews", "analytics.json");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Penguin's /mcp on a local port, answering from `project`'s stores as the Worker and the ProjectAgent do. */
class LocalMcp {
  readonly #server: Server;
  url = "";

  constructor(project: ReviewProject) {
    const ports = {
      directory: () => ({ reviewTaskCall: (owner: string, taskId: number, call: Parameters<typeof reviewTaskCall>[3]) => reviewTaskCall(project.callDeps(), owner, taskId, call) }),
      repos: { issues: "t-issues", base: "t-base" },
    } as unknown as FeaturePorts;
    const handlers: McpHandlers = {
      mcpTokens: () => ({
        issueMcpToken: (owner) => project.tokens.issue(owner),
        authenticateMcpToken: (token) => project.tokens.authenticate(token),
        revokeMcpToken: (tokenId) => project.tokens.revoke(tokenId),
      }),
      serveMcp: async () => new Response("an owner token is not used here", { status: 500 }),
      serveReviewTaskMcp: (request, owner, taskId) => serveReviewTaskMcp(request, mcpReviewTask(ports, owner, taskId)),
    };
    this.#server = createServer((incoming, outgoing) => {
      void (async () => {
        const request = await toRequest(incoming, this.url);
        const response = (await handleMcpRoute(request, new URL(request.url), {}, handlers)) ?? new Response(null, { status: 404 });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })().catch((error: unknown) => outgoing.writeHead(500).end(String(error)));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => this.#server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/mcp`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((done) => this.#server.close(done));
  }
}

async function toRequest(incoming: IncomingMessage, url: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
  return new Request(url, { method: incoming.method ?? "POST", headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) });
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Priya's fork as a bare repository with the fixture's base, the bridge's own repository and a fake CLI. */
function setUp(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "penguin-review-run-"));
  roots.push(root);
  const seed = join(root, "seed");
  execFileSync("cp", ["-R", join(REPO_ROOT, "examples", "helpful-fix", "base"), seed]);
  git(root, "init", "--quiet", "--initial-branch=main", seed);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  const fork = join(root, "fork.git");
  git(root, "clone", "--quiet", "--bare", seed, fork);
  const repo = join(root, "repo");
  git(root, "init", "--quiet", repo);
  const program = join(root, "agent");
  writeFileSync(program, `#!/bin/sh\nFAKE_AGENT_MODE=${mode} FAKE_REVIEW_FORM="${FORM}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(program, 0o755);
  return { root, fork, repo, program, record: join(root, "record.json") };
}

interface Record_ {
  readonly args: string[];
  readonly tools: string[];
  readonly tokenEnv: string[];
  readonly otherTool: { isError: boolean; value: unknown };
  readonly submitted?: { isError: boolean; value: Record<string, unknown> };
  readonly otherScope?: { isError: boolean; value: Record<string, unknown> };
}

describe("a review task run headless with a fake CLI against Penguin's MCP server", () => {
  let mcp: LocalMcp;
  let project: ReviewProject;
  let revision = 0;
  before(async () => {
    project = await ReviewProject.load();
    mcp = new LocalMcp(project);
    await mcp.start();
  });
  after(async () => mcp.stop());

  /** Each run reviews a new revision of the part, a second after the last, so it asks for a fresh form. */
  async function claimed(): Promise<ClaimedEditTask> {
    project.now += 1_000;
    project.part(++revision, "pending");
    await syncEditWork(project.editDeps());
    const claim = await claimEditTasks(project.editDeps(), "jun", "bridge-jun");
    const spec = claim.tasks.find((each) => each.kind === "review");
    assert.ok(spec !== undefined, JSON.stringify(claim.tasks));
    return { spec, token: { token: "art_read", remote: "unused", expiresAt: spec.leaseUntil }, mcp: claim.mcp[spec.taskId] ?? null };
  }

  function options(setup: ReturnType<typeof setUp>, vendor: EditVendor): EditRunnerOptions {
    return {
      repoPath: setup.repo,
      worktreeRoot: join(setup.root, "worktrees"),
      vendor: { vendor, program: setup.program, timeoutMs: 30_000 },
      consent: new MemoryConsentStore(),
      confirm: async () => assert.fail("a review publishes nothing, so nobody is asked"),
      write: () => undefined,
      projectId: "p",
      remote: () => localRemote(setup.fork),
      mcpUrl: mcp.url,
    };
  }

  for (const vendor of ["claude", "codex"] as const) {
    test(`${vendor}: the run submits the form for its scope; any other tool or scope is refused`, async () => {
      const setup = setUp("review");
      process.env["FAKE_AGENT_RECORD"] = setup.record;
      const task = await claimed();
      const token = task.mcp?.token as string;
      const result = await runEditTask(options(setup, vendor), task);
      assert.equal(result.report.status, "done", JSON.stringify(result.report));
      assert.equal(result.report.commit, undefined);
      const seen = JSON.parse(readFileSync(setup.record, "utf8")) as Record_;
      assert.deepEqual(seen.tools, ["impact", "submit_review", "whats_near"]);
      assert.equal(seen.otherTool.isError, true);
      assert.equal(seen.submitted?.isError, false, JSON.stringify(seen.submitted));
      assert.equal(seen.submitted?.value["state"], "pending");
      assert.equal(seen.otherScope?.isError, true);
      assert.match(JSON.stringify(seen.otherScope?.value), /scope analytics on part utc-day\/v1#1 revision \d+ alone/u);
      // The token reaches the MCP config only: never the arguments; for codex the variable its settings name.
      assert.equal(seen.args.some((arg) => arg.includes(token)), false);
      assert.deepEqual(seen.tokenEnv, vendor === "codex" ? ["PENGUIN_TASK_TOKEN"] : []);
      if (vendor === "claude") {
        assert.deepEqual(seen.args.slice(seen.args.indexOf("--allowedTools"), seen.args.indexOf("--allowedTools") + 2), [
          "--allowedTools",
          "Read,Glob,Grep,mcp__penguin__submit_review,mcp__penguin__whats_near,mcp__penguin__impact",
        ]);
        assert.ok(seen.args.includes("--strict-mcp-config"));
        // The config file sat outside the worktree and is gone with it.
        const config = seen.args[seen.args.indexOf("--mcp-config") + 1] as string;
        assert.equal(config.startsWith(result.worktree as string), false);
        assert.equal(existsSync(config), false);
      } else {
        assert.deepEqual(seen.args.slice(0, 3), ["exec", "--sandbox", "read-only"]);
      }
      assert.deepEqual(readdirSync(join(setup.root, "worktrees")), []);

      const [stored] = project.reviews.list(FEATURE).filter((review) => review.sessionId === taskSessionId(task.spec.taskId));
      assert.deepEqual([stored?.reviewer, stored?.state], ["@jun/steward", "pending"]);
      const report = await reportEditTask(project.editDeps(), "jun", "bridge-jun", task.spec.taskId, result.report);
      assert.ok(report.status === "ok" && report.task.state === "done", JSON.stringify(report));
      // Reported, the token reaches nothing.
      assert.equal(await project.tokens.authenticate(token), undefined);
    });
  }

  test("a run that sends no form reports done, and Penguin releases the task to its person", async () => {
    const setup = setUp("review-none");
    process.env["FAKE_AGENT_RECORD"] = setup.record;
    const task = await claimed();
    const result = await runEditTask(options(setup, "claude"), task);
    assert.equal(result.report.status, "done");
    const report = await reportEditTask(project.editDeps(), "jun", "bridge-jun", task.spec.taskId, result.report);
    assert.deepEqual(report, { status: "rejected", reason: "invalid", message: "the run submitted no review form" });
    assert.deepEqual([project.tasks.get(task.spec.taskId)?.state, project.tasks.get(task.spec.taskId)?.askReason], ["asked", "run_failed"]);
  });
});
