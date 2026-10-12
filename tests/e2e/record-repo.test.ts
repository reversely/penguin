/**
 * The record repo against real Artifacts (#123): the Worker and both agents under local `wrangler dev`,
 * every repo under a prefix unique to the run. Skipped unless PENGUIN_RECORD_E2E=1; docs/bridge-and-runner.md
 * says how to run it.
 *
 * 1. Project setup makes the record repo beside the base and issues repos.
 * 2. Priya's agent opens the helpful fix's originating feature, pushes its checkpoint and lands it alone:
 *    the runner checks the block and Penguin moves main.
 * 3. Within seconds of each record, Penguin commits it to the record repo. Priya's bridge clones the repo
 *    with an expiring read token: every record the feature page lists is at its path, byte for byte, and
 *    the page links each one. The read token cannot push.
 *
 * Every repo the run made is deleted at the end and the namespace listed again. Nothing here prints a
 * token: tokens stay in memory and reach Git through the environment only.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { ARTIFACTS_PUSH_OPTIONS, bridgeRemotes, MemoryKeyStore, penguinRemote, runCli, tokenEnvironment, type CliIo } from "@penguin/local-bridge";

import { reposWithPrefix, LocalStack } from "../walkthrough/support/stack.ts";
import { signInThroughDouble, SESSION_COOKIE } from "./support/dashboard-client.ts";
import { McpClient } from "./support/mcp-client.ts";
import { Runner } from "./support/runner.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = join(VENV_BIN, "python");
const RUN_ID = randomBytes(3).toString("hex");
const PREFIX = `p123-${RUN_ID}-`;
const OUT = process.env.PENGUIN_RECORD_E2E_OUT ?? join(tmpdir(), `penguin-record-e2e-${RUN_ID}`);
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

interface FixtureFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: Record<string, string[]>;
}
const FEATURES = (JSON.parse(await readFile(join(FIXTURE, "features.json"), "utf8")) as { features: FixtureFeature[] }).features;
const PINS = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as { branches: Record<string, string> };
const IDENTITIES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "identities.json"), "utf8")) as {
  identities: { handle: string; owner: string; vendor: string; job: string; charter_scopes: string[] }[];
}).identities;
const SCOPES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "scopes.json"), "utf8")) as { scopes: { contracts: string[] }[] }).scopes;
const ORIGIN = FEATURES.find((feature) => feature.role === "originating") as FixtureFeature;
const OWNERS = [...new Set(FEATURES.map((feature) => feature.owner))];
const login = (person: string) => `${person}-gh`;

function quietIo(output: string[]): CliIo {
  return { write: (text) => output.push(text), ask: async () => "y" };
}

/** Runs `step` until it returns a value other than undefined, or throws after `timeoutMs`. */
async function poll<T>(what: string, timeoutMs: number, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const enabled = process.env.PENGUIN_RECORD_E2E === "1";

test("a feature's signed records reach the record repo after it lands, and a read token clones them", { skip: enabled ? false : "set PENGUIN_RECORD_E2E=1 to run it against real Artifacts", timeout: 30 * 60_000 }, async () => {
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "penguin-record-e2e-"));
  const fixtureRepo = join(root, "fixture");
  await run(PYTHON, [join(FIXTURE, "build.py"), fixtureRepo]);
  const evidence: Record<string, unknown> = { prefix: PREFIX };
  const stack = await LocalStack.start({ repoRoot: REPO_ROOT, prefix: PREFIX, owners: OWNERS, login, logFile: join(OUT, "worker.log") });
  const stateDir = join(root, "priya");
  const work = join(stateDir, "work");
  const keyStore = new MemoryKeyStore();
  let runner: Runner | undefined;
  let bridgeId = "";
  let mcpTokenId = "";

  try {
    // 1. Setup makes the record repo with the project.
    const setup = await stack.deployer.setUp(OWNERS);
    const recordRepo = setup.repos.find((repo) => repo.role === "record");
    assert.deepEqual(recordRepo && [recordRepo.name, recordRepo.status], [`${PREFIX}record`, "created"]);
    evidence["setup"] = setup.repos.map(({ name, role, status }) => ({ name, role, status }));
    await stack.seedBase(fixtureRepo, PINS.branches["main"] as string, "main");
    runner = await Runner.register(stack.url, "runner", await stack.deployer.bridgeCode("runner", "runner"));

    // Priya's machine: a bridge, a dashboard session, an MCP session of the feature's builder.
    await mkdir(stateDir, { recursive: true });
    const output: string[] = [];
    const code = await stack.deployer.bridgeCode(ORIGIN.owner, "owner");
    assert.equal(await runCli(["register", "--server", stack.url, "--owner", ORIGIN.owner, "--code", code], quietIo(output), { keyStore, stateDir }), 0, output.join(""));
    bridgeId = /Registered bridge (\S+)/u.exec(output.join(""))?.[1] as string;
    await runGit(stateDir, ["clone", "--quiet", fixtureRepo, work]);
    const cookie = await signInThroughDouble(stack.url, login(ORIGIN.owner));
    const api = async (path: string) => {
      const response = await fetch(`${stack.url}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Accept: "application/json" } });
      return { status: response.status, text: await response.text() };
    };
    const identity = IDENTITIES.find((each) => each.handle === `@${ORIGIN.owner}/${ORIGIN.id}`) as (typeof IDENTITIES)[number];
    const created = await fetch(`${stack.url}/api/identities`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: stack.url, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: identity.handle, name: identity.handle.split("/")[1], job: identity.job, charterScopes: identity.charter_scopes, autoAccept: true }),
    });
    assert.equal(created.status, 201, await created.text());
    const issued = await stack.deployer.issueMcpToken(ORIGIN.owner);
    mcpTokenId = issued.tokenId;
    const mcp = new McpClient(stack.url, issued.token);
    await mcp.initialize();
    const registered = await mcp.call("register_session", { identity: identity.handle, vendor: identity.vendor, worktreeId: "wt_priya", branch: "main" });
    assert.equal(registered.isError, false, JSON.stringify(registered.value));
    const sessionId = registered.value["sessionId"];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.call(name, { sessionId, ...args });
      if (result.isError) throw new Error(`${name} was refused: ${JSON.stringify(result.value).slice(0, 600)}`);
      return result.value;
    };

    // 2. The feature opens, takes its checkpoint and lands alone.
    const known = new Set(SCOPES.flatMap((scope) => scope.contracts));
    const area = { ...ORIGIN.area, contracts: (ORIGIN.area["contracts"] ?? []).filter((contract) => known.has(contract)) };
    // A fork Artifacts is still making answers "try again"; opening again resumes it.
    let opened = await mcp.call("open_feature", { sessionId, feature: ORIGIN.id, area });
    for (let attempt = 0; opened.isError && opened.value["error"] === "artifacts" && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      opened = await mcp.call("open_feature", { sessionId, feature: ORIGIN.id, area });
    }
    assert.equal(opened.isError, false, JSON.stringify(opened.value).slice(0, 600));
    const fork = opened.value["token"] as { token: string; remote: string };
    const checkpoint = PINS.branches[ORIGIN.fork] as string;
    await runGit(work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", fork.remote, `${checkpoint}:refs/heads/main`], { env: tokenEnvironment(fork.token) });
    await call("report_checkpoint", { sha: checkpoint, fork: `feature-${ORIGIN.id}` });
    const asked = await call("land_feature", { feature: ORIGIN.id });
    assert.equal(asked.status, "checking", JSON.stringify(asked).slice(0, 600));
    await runner.pass(["--combined", "--repo", join(root, "runner-repo"), "--python", PYTHON]);
    const landing = (await call("get_work", {})).landing;
    assert.equal(landing.state, "landed", JSON.stringify(landing).slice(0, 1_500));
    const landedAt = Date.now();

    // 3. Every record on the feature page reaches the record repo, linked from the page.
    const page = await poll("every record committed to the record repo", 180_000, async () => {
      const read = await api(`/api/features/${ORIGIN.id}/page`);
      assert.equal(read.status, 200, read.text.slice(0, 300));
      const body = JSON.parse(read.text) as { records: { recordId: string; type: string; path: string; commit: string | null }[] };
      return body.records.length > 0 && body.records.every((record) => record.commit !== null) ? body : undefined;
    });
    const committedMs = Date.now() - landedAt;
    assert.ok(page.records.some((record) => record.type === "promotion"), "the promotion is among the records");

    // Priya's bridge clones the record repo with a read token, as any person may.
    const clone = join(root, "record-clone");
    await runGit(root, ["init", "--quiet", clone]);
    await bridgeRemotes(stateDir, keyStore, undefined, "read")(penguinRemote("record")).git(clone, (url) => ["fetch", "--quiet", "--no-tags", "--end-of-options", url, "+refs/heads/main:refs/remotes/record/main"]);
    const listed = (await runGit(clone, ["ls-tree", "-r", "--name-only", "refs/remotes/record/main"])).split("\n").filter((line) => line !== "");
    const ours = listed.filter((path) => path.startsWith(`records/${ORIGIN.id}/`));
    assert.deepEqual([...ours].sort(), page.records.map((record) => record.path).sort(), "each record at its path, and nothing else of the feature's");
    for (const record of page.records) {
      const inRepo = await runGit(clone, ["show", `refs/remotes/record/main:${record.path}`]);
      const linked = await api(`/api/features/${ORIGIN.id}/records/${record.recordId}`);
      assert.equal(linked.status, 200, record.recordId);
      assert.equal(linked.text, inRepo, `${record.recordId}: the page's link opens the file the repo holds`);
      assert.equal(JSON.parse(inRepo).record_id, record.recordId);
    }
    const history = (await runGit(clone, ["log", "--format=%H %an %s", "refs/remotes/record/main"])).split("\n").filter((line) => line !== "");
    evidence["commits"] = history;
    assert.ok(history.length > 0 && history.every((line) => line.includes(" Penguin Add ")), `every commit is Penguin's: ${JSON.stringify(history)}`);

    // The read token cannot write the record repo, and the bridge gets no write token on it.
    await runGit(clone, ["checkout", "--quiet", "-b", "attempt", "refs/remotes/record/main"]);
    await runGit(clone, ["-c", "user.name=priya", "-c", "user.email=priya@penguin.invalid", "commit", "--quiet", "--allow-empty", "-m", "Not Penguin"]);
    const attempt = (scope: "read" | "write") =>
      bridgeRemotes(stateDir, keyStore, undefined, scope)(penguinRemote("record"))
        .git(clone, (url) => [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", url, "HEAD:refs/heads/main"])
        .then(
          () => "pushed",
          (error: Error) => error.message.split("\n").filter((line) => /^(?:fatal|error|remote):|403|forbidden/iu.test(line.trim())).join(" ").slice(0, 200),
        );
    const readPush = await attempt("read");
    const writePush = await attempt("write");
    assert.notEqual(readPush, "pushed", "a read token cannot push to the record repo");
    assert.notEqual(writePush, "pushed", "no bridge holds write on the record repo");

    evidence["records"] = page.records.map(({ recordId, type, path, commit }) => ({ recordId, type, path, commit }));
    evidence["committedWithinMsOfLanding"] = committedMs;
    evidence["readTokenPush"] = readPush;
    evidence["writeTokenPush"] = writePush;
  } finally {
    if (mcpTokenId !== "") await stack.deployer.revokeMcpToken(mcpTokenId).catch(() => undefined);
    if (bridgeId !== "") await stack.deployer.revokeBridge(bridgeId).catch(() => undefined);
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
