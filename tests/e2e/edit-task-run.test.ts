/**
 * The live check of #129 (PRD 0.5 section 4.4a): one edit task on the helpful-fix fixture, run by
 * `claude -p` from the person's bridge against real Artifacts. The Worker and both agents run under
 * local `wrangler dev`; every repo sits under a prefix unique to the run and is deleted at the end.
 * Skipped unless PENGUIN_EDIT_E2E=1; docs/bridge-and-runner.md says how to run it.
 *
 * 1. Priya and Jun open their features and push their checkpoints. Jun's session then stops.
 * 2. Priya lands her UTC change with no plan. The runner's block run fails Jun's tests on Jun's fork:
 *    ladder step 5, outside Priya's charter, so Penguin opens a next-step task for Jun's builder.
 * 3. Jun's bridge runs `penguin-bridge edits --once`: it claims the task, runs `claude -p` in a fresh
 *    worktree of Jun's fork, publishes the result after consent and reports a one-line outcome.
 *
 * Tokens stay in memory and reach Git through the environment only; nothing prints one.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { ARTIFACTS_PUSH_OPTIONS, bridgeRemotes, MemoryKeyStore, penguinRemote, runCli, tokenEnvironment, type CliIo } from "@penguin/local-bridge";

import { LocalStack, reposWithPrefix } from "../walkthrough/support/stack.ts";
import { signInThroughDouble, SESSION_COOKIE } from "./support/dashboard-client.ts";
import { McpClient } from "./support/mcp-client.ts";
import { Runner } from "./support/runner.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = join(VENV_BIN, "python");
const RUN_ID = randomBytes(3).toString("hex");
const PREFIX = `p129-${RUN_ID}-`;
const OUT = process.env.PENGUIN_EDIT_E2E_OUT ?? join(tmpdir(), `penguin-edit-e2e-${RUN_ID}`);
const MODEL = process.env.PENGUIN_EDIT_E2E_MODEL ?? "sonnet";
/** Jun's session goes offline this many seconds after its last call, so the bridge takes the task. */
const OFFLINE_SECONDS = 10;
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

interface FixtureFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: string;
  readonly area: Record<string, string[]>;
  readonly commits: readonly { readonly tag?: string }[];
}
const FEATURES = (JSON.parse(await readFile(join(FIXTURE, "features.json"), "utf8")) as { features: FixtureFeature[] }).features;
const PINS = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as { branches: Record<string, string>; tags: Record<string, string> };
const IDENTITIES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "identities.json"), "utf8")) as {
  identities: { handle: string; owner: string; vendor: string; job: string; charter_scopes: string[] }[];
}).identities;
const login = (person: string) => `${person}-gh`;
const quietIo = (output: string[]): CliIo => ({ write: (text) => output.push(text), ask: async () => "y" });

class Person {
  readonly feature: FixtureFeature;
  readonly identity: (typeof IDENTITIES)[number];
  readonly keyStore = new MemoryKeyStore();
  readonly stateDir: string;
  readonly work: string;
  bridgeId = "";
  mcpTokenId = "";
  sessionId = "";
  cookie = "";
  mcp!: McpClient;

  constructor(feature: FixtureFeature, root: string) {
    this.feature = feature;
    this.identity = IDENTITIES.find((identity) => identity.handle === `@${feature.owner}/${feature.id}`) as (typeof IDENTITIES)[number];
    this.stateDir = join(root, feature.owner);
    this.work = join(this.stateDir, "work");
  }

  get id(): string {
    return this.feature.owner;
  }

  /** Registers a session, and joins the feature again once it is open, as an agent does after going offline. */
  async register(joined: boolean): Promise<void> {
    const registered = await this.mcp.call("register_session", { identity: this.identity.handle, vendor: this.identity.vendor, worktreeId: `wt_${this.id}`, branch: "main" });
    this.sessionId = registered.value["sessionId"];
    if (joined) await this.mcp.call("open_feature", { sessionId: this.sessionId, feature: this.feature.id });
  }

  async call(name: string, args: Record<string, unknown>, joined = true): Promise<Record<string, any>> {
    let result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    if (result.isError && result.value["error"] === "offline") {
      await this.register(joined);
      result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    }
    if (result.isError) throw new Error(`${this.identity.handle}'s ${name} was refused: ${JSON.stringify(result.value).slice(0, 600)}`);
    return result.value;
  }

  async api(origin: string, path: string): Promise<any> {
    const response = await fetch(`${origin}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${this.cookie}`, Accept: "application/json" } });
    return response.json();
  }
}

const enabled = process.env.PENGUIN_EDIT_E2E === "1";

test("a queued edit task runs headless from the person's bridge with claude -p", { skip: enabled ? false : "set PENGUIN_EDIT_E2E=1 to run it against real Artifacts and claude -p", timeout: 30 * 60_000 }, async () => {
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "penguin-edit-e2e-"));
  const fixtureRepo = join(root, "fixture");
  await run(PYTHON, [join(FIXTURE, "build.py"), fixtureRepo]);
  const evidence: Record<string, unknown> = { prefix: PREFIX, model: MODEL };
  const priyaFeature = FEATURES.find((feature) => feature.role === "originating") as FixtureFeature;
  const junFeature = FEATURES.find((feature) => feature.owner === "jun") as FixtureFeature;
  const stack = await LocalStack.start({
    repoRoot: REPO_ROOT,
    prefix: PREFIX,
    owners: ["priya", "jun"],
    login,
    logFile: join(OUT, "worker.log"),
    vars: { PENGUIN_SESSION_OFFLINE_SECONDS: String(OFFLINE_SECONDS) },
  });
  const priya = new Person(priyaFeature, root);
  const jun = new Person(junFeature, root);
  let runner: Runner | undefined;
  try {
    await stack.deployer.setUp(["priya", "jun"]);
    await stack.seedBase(fixtureRepo, PINS.branches["main"] as string, "main");
    runner = await Runner.register(stack.url, "runner", await stack.deployer.bridgeCode("runner", "runner"));
    for (const each of [priya, jun]) {
      await mkdir(each.stateDir, { recursive: true });
      const output: string[] = [];
      const code = await stack.deployer.bridgeCode(each.id, "owner");
      assert.equal(await runCli(["register", "--server", stack.url, "--owner", each.id, "--code", code], quietIo(output), { keyStore: each.keyStore, stateDir: each.stateDir }), 0, output.join(""));
      each.bridgeId = /Registered bridge (\S+)/u.exec(output.join(""))?.[1] as string;
      await runGit(each.stateDir, ["clone", "--quiet", fixtureRepo, each.work]);
      each.cookie = await signInThroughDouble(stack.url, login(each.id));
      const created = await fetch(`${stack.url}/api/identities`, {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${each.cookie}`, Origin: stack.url, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: each.identity.handle, name: each.identity.handle.split("/")[1], job: each.identity.job, charterScopes: each.identity.charter_scopes, autoAccept: true }),
      });
      assert.equal(created.status, 201);
      const issued = await stack.deployer.issueMcpToken(each.id);
      each.mcpTokenId = issued.tokenId;
      each.mcp = new McpClient(stack.url, issued.token);
      await each.mcp.initialize();
      await each.register(false);
    }

    // 1. Both features open and push their first checkpoint.
    for (const each of [jun, priya]) {
      const opened = await each.call("open_feature", { feature: each.feature.id, area: { scopes: each.feature.area["scopes"], paths: each.feature.area["paths"] } }, false);
      const token = opened.token as { token: string; remote: string };
      const sha = PINS.tags[each.feature.commits[0]?.tag as string] as string;
      await runGit(each.work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", token.remote, `${sha}:refs/heads/main`], { env: tokenEnvironment(token.token) });
      await each.call("report_checkpoint", { sha, fork: `feature-${each.feature.id}` });
    }
    const junHead = PINS.tags[junFeature.commits[0]?.tag as string] as string;

    // 2. Priya lands with no plan; the block run fails Jun's tests and opens a task for Jun's builder.
    const land = await priya.call("land_feature", { feature: priyaFeature.id });
    assert.equal(land.status, "checking", JSON.stringify(land));
    await runner.pass(["--combined", "--repo", join(root, "runner-repo"), "--python", PYTHON]);
    await new Promise((resolve) => setTimeout(resolve, (OFFLINE_SECONDS + 2) * 1000));
    const before = await jun.api(stack.url, `/api/features/${junFeature.id}/page`);
    const task = (before.editTasks as any[]).find((each) => each.kind === "next_step" && each.target === junFeature.id);
    assert.ok(task !== undefined, JSON.stringify(before.editTasks));
    evidence["task"] = { id: task.id, handle: task.handle, via: task.via, files: task.files, state: task.state, askReason: task.askReason };
    assert.equal(task.handle, `@jun/${junFeature.id}`);
    assert.equal(task.via, "builder");

    // 3. Jun's bridge claims and runs it with claude -p, publishes after consent and reports.
    const output: string[] = [];
    const started = Date.now();
    const code = await runCli(
      ["edits", "--once", "--vendor", "claude", "--model", MODEL, "--timeout-minutes", "10", "--project", "helpful-fix", "--state-dir", jun.stateDir],
      quietIo(output),
      { keyStore: jun.keyStore, stateDir: jun.stateDir },
    );
    const printed = output.join("");
    evidence["bridgeOutput"] = printed.split("\n").filter((line) => /^Edit task|^Edit tasks for|^Standing consent|Publish it/u.test(line));
    evidence["runMs"] = Date.now() - started;
    assert.doesNotMatch(printed, /art_|Bearer /u, "no token is printed");
    assert.equal(code, 0, printed);
    assert.match(printed, /Edit tasks for jun: \d+ running, \d+ queued, \d+ asked \(cap 2\)\./u);

    const after = await jun.api(stack.url, `/api/features/${junFeature.id}/page`);
    const done = (after.editTasks as any[]).find((each) => each.id === task.id);
    evidence["after"] = { state: done.state, outcome: done.outcome, commit: done.commit };
    assert.equal(done.state, "done", JSON.stringify(done));
    // The commit sits on Jun's fork on top of Jun's checkpoint and changes only Jun's analytics files.
    await bridgeRemotes(jun.stateDir, jun.keyStore, undefined, "read")(penguinRemote(`feature-${junFeature.id}`)).git(jun.work, (url) => ["fetch", "--quiet", "--no-tags", "--end-of-options", url, "+refs/heads/main:refs/remotes/jun-fork/main"]);
    assert.equal((await runGit(jun.work, ["rev-parse", "refs/remotes/jun-fork/main"])).trim(), done.commit);
    assert.equal((await runGit(jun.work, ["rev-parse", `${done.commit}^`])).trim(), junHead);
    const changed = (await runGit(jun.work, ["diff", "--name-only", junHead, done.commit])).trim().split("\n");
    evidence["changed"] = changed;
    assert.ok(changed.every((path) => path.startsWith("analytics/")), changed.join(", "));
    const team = await jun.api(stack.url, "/api/team");
    evidence["steward"] = team.people.find((person: any) => person.id === "jun")?.steward;
  } finally {
    for (const each of [priya, jun]) {
      if (each.mcpTokenId !== "") await stack.deployer.revokeMcpToken(each.mcpTokenId).catch(() => undefined);
      if (each.bridgeId !== "") await stack.deployer.revokeBridge(each.bridgeId).catch(() => undefined);
    }
    if (runner !== undefined) {
      await stack.deployer.revokeBridge(runner.bridgeId).catch(() => undefined);
      await runner.dispose();
    }
    evidence["deletedRepos"] = await stack.stop();
    evidence["remainingRepos"] = await reposWithPrefix(REPO_ROOT, PREFIX).catch((error: unknown) => [`could not list: ${String(error)}`]);
    await writeFile(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
