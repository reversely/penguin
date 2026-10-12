/**
 * The Phase E exit check (PRD 0.4 section 12): main is never red across a scripted run with several
 * concurrent features. It runs the helpful-fix fixture end to end against real Artifacts: the Worker
 * and both agents under local `wrangler dev`, every repo under a prefix unique to the run, a bridge per
 * person, a runner bridge, and scripted agent sessions over MCP. Skipped unless PENGUIN_BLOCK_E2E=1;
 * docs/bridge-and-runner.md says how to run it.
 *
 * 1. Jun, Sam and Priya open their features and push their checkpoints to their forks.
 * 2. Priya's agent proposes the plan; the runner's facts run fills it in. Landing is refused until every
 *    part is approved. A checkpoint of Jun's in the plan's area asks for the plan's check, which fails on
 *    Jun's and Sam's forks and leaves main where it was.
 * 3. Jun and Sam approve their parts; Priya's agent writes each fix into their forks.
 * 4. Jun previews Priya's checkpoint with a read token. Priya lands: the block passes and main moves to
 *    her checkpoint in one push. Her fork then refuses pushes. Main's tests pass, and Jun's and Sam's
 *    forks merge main cleanly with their tests passing.
 * 5. Jun and Sam take main. Jun lands with a deliberate failing test: the block fails, main stays.
 * 6. Jun drops it; Jun and Sam land at once. One promotion wins; the other is refused as raced and
 *    returned to take main again, then lands.
 *
 * After every promotion every scope's tests run on main. Every repo the run made is deleted at the end.
 * Nothing here prints a token: tokens stay in memory and reach Git through the environment only.
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  ARTIFACTS_PUSH_OPTIONS,
  bridgeRemotes,
  MemoryKeyStore,
  penguinRemote,
  runCli,
  runFixWriteCommand,
  runPreviewCommand,
  tokenEnvironment,
  type CliIo,
} from "@penguin/local-bridge";

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
const PREFIX = `p96-${RUN_ID}-`;
const OUT = process.env.PENGUIN_BLOCK_E2E_OUT ?? join(tmpdir(), `penguin-block-e2e-${RUN_ID}`);
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

interface FixtureFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: "originating" | "running";
  readonly fork: string;
  readonly area: Record<string, string[]>;
  readonly commits: readonly { readonly tag?: string }[];
}
const FEATURES = (JSON.parse(await readFile(join(FIXTURE, "features.json"), "utf8")) as { features: FixtureFeature[] }).features;
const PINS = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as { branches: Record<string, string>; tags: Record<string, string> };
const IDENTITIES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "identities.json"), "utf8")) as {
  identities: { handle: string; owner: string; vendor: string; job: string; charter_scopes: string[] }[];
}).identities;
const SCOPES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "scopes.json"), "utf8")) as { scopes: { id: string; owner: string; paths: string[]; contracts: string[] }[] }).scopes;
/** A feature's declared area, naming only the contracts main's scope map already declares. */
const declared = (feature: FixtureFeature): Record<string, string[]> => {
  const known = new Set(SCOPES.flatMap((scope) => scope.contracts));
  return { ...feature.area, contracts: (feature.area["contracts"] ?? []).filter((contract) => known.has(contract)) };
};
const ORIGIN = FEATURES.find((feature) => feature.role === "originating") as FixtureFeature;
const RUNNING = FEATURES.filter((feature) => feature.role === "running");
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** One person's machine: a bridge, a dashboard session, an MCP session of their identity and a work clone. */
class Person {
  readonly id: string;
  readonly handle: string;
  readonly feature: FixtureFeature;
  readonly stateDir: string;
  readonly keyStore = new MemoryKeyStore();
  readonly work: string;
  bridgeId = "";
  mcpTokenId = "";
  sessionId = "";
  cookie = "";
  /** The feature's fork token from open_feature or feature_token; in memory only. */
  forkToken: { token: string; remote: string } | null = null;
  mcp!: McpClient;

  constructor(feature: FixtureFeature, root: string) {
    this.id = feature.owner;
    this.feature = feature;
    this.handle = (IDENTITIES.find((identity) => identity.handle === `@${feature.owner}/${feature.id}`) as { handle: string }).handle;
    this.stateDir = join(root, this.id);
    this.work = join(this.stateDir, "work");
  }

  /** Registers the session again after it went offline between steps, and joins the feature again, as an agent does. */
  async rejoin(): Promise<void> {
    const identity = IDENTITIES.find((candidate) => candidate.handle === this.handle) as (typeof IDENTITIES)[number];
    const registered = await this.mcp.call("register_session", { identity: identity.handle, vendor: identity.vendor, worktreeId: `wt_${this.id}`, branch: "main" });
    assert.equal(registered.isError, false, JSON.stringify(registered.value));
    this.sessionId = registered.value["sessionId"];
    const joined = await this.mcp.call("open_feature", { sessionId: this.sessionId, feature: this.feature.id });
    assert.equal(joined.isError, false, JSON.stringify(joined.value).slice(0, 400));
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    let result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    if (result.isError && result.value["error"] === "offline") {
      await this.rejoin();
      result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    }
    if (result.isError) throw new Error(`${this.handle}'s ${name} was refused: ${JSON.stringify(result.value).slice(0, 600)}`);
    return result.value;
  }

  /** A tool call whose refusal is the expected answer. */
  async refused(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    let result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    if (result.isError && result.value["error"] === "offline") {
      await this.rejoin();
      result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    }
    assert.equal(result.isError, true, `${name} was expected to be refused: ${JSON.stringify(result.value).slice(0, 400)}`);
    return result.value;
  }

  async api(method: "GET" | "POST", origin: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Cookie: `${SESSION_COOKIE}=${this.cookie}`, Origin: origin, Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** Fetches a project repo with this bridge's read token into the work clone, under refs/remotes/<repo>/. */
  async fetchRepo(repo: string): Promise<void> {
    await bridgeRemotes(this.stateDir, this.keyStore, undefined, "read")(penguinRemote(repo)).git(this.work, (url) => [
      "fetch",
      "--quiet",
      "--no-tags",
      "--end-of-options",
      url,
      `+refs/heads/*:refs/remotes/${repo}/*`,
    ]);
  }

  /** Pushes `sha` to the feature fork's main with the feature's write token, as the agent does. */
  async pushToFork(sha: string): Promise<void> {
    const token = this.forkToken as { token: string; remote: string };
    await runGit(this.work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", token.remote, `${sha}:refs/heads/main`], { env: tokenEnvironment(token.token) });
  }

  async commit(files: Record<string, string | null>, message: string): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) await runGit(this.work, ["rm", "--quiet", "--", path]);
      else {
        await mkdir(join(this.work, path, ".."), { recursive: true });
        await writeFile(join(this.work, path), content);
        await runGit(this.work, ["add", "--", path]);
      }
    }
    await runGit(this.work, ["-c", `user.name=${this.id}`, "-c", `user.email=${this.id}@penguin.invalid`, "commit", "--quiet", "-m", message]);
    return (await runGit(this.work, ["rev-parse", "HEAD"])).trim();
  }

  /** Merges main into the fork's head in the work clone, pushes it and reports it: the agent takes main. */
  async takeMain(): Promise<string> {
    await this.fetchRepo("base");
    await this.fetchRepo(`feature-${this.feature.id}`);
    await runGit(this.work, ["checkout", "--quiet", "--detach", `refs/remotes/feature-${this.feature.id}/main`]);
    await runGit(this.work, ["-c", `user.name=${this.id}`, "-c", `user.email=${this.id}@penguin.invalid`, "merge", "--quiet", "--no-edit", "refs/remotes/base/main"]);
    return this.publish((await runGit(this.work, ["rev-parse", "HEAD"])).trim());
  }

  async publish(sha: string): Promise<string> {
    if (this.forkToken === null) this.forkToken = (await this.call("feature_token", { feature: this.feature.id })).token;
    try {
      await this.pushToFork(sha);
    } catch {
      // The fork token ran out; a fresh one comes from feature_token.
      this.forkToken = (await this.call("feature_token", { feature: this.feature.id })).token;
      await this.pushToFork(sha);
    }
    await this.call("report_checkpoint", { sha, fork: `feature-${this.feature.id}` });
    return sha;
  }

  async landing(): Promise<Record<string, any>> {
    return (await this.call("get_work", {})).landing;
  }
}

/** Every scope's test command on `sha`, in a throwaway worktree of `repo`; the scopes that failed. */
async function redScopes(repo: string, sha: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "penguin-block-e2e-tree-"));
  await runGit(repo, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  try {
    const scopes = JSON.parse(await readFile(join(dir, "penguin", "scopes.json"), "utf8")) as { scopes: { id: string; test_command: string }[] };
    const red: string[] = [];
    for (const scope of scopes.scopes) {
      try {
        await run("sh", ["-c", scope.test_command], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
      } catch {
        red.push(scope.id);
      }
    }
    return red;
  } finally {
    await runGit(repo, ["worktree", "remove", "--force", dir]);
  }
}

const enabled = process.env.PENGUIN_BLOCK_E2E === "1";

test("the block exit check: main is never red across a scripted run with several concurrent features", { skip: enabled ? false : "set PENGUIN_BLOCK_E2E=1 to run it against real Artifacts", timeout: 60 * 60_000 }, async () => {
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "penguin-block-e2e-"));
  const fixtureRepo = join(root, "fixture");
  await run(PYTHON, [join(FIXTURE, "build.py"), fixtureRepo]);
  const evidence: Record<string, unknown> = { prefix: PREFIX, steps: [] as unknown[] };
  const step = (name: string, facts: Record<string, unknown>) => (evidence["steps"] as unknown[]).push({ step: name, at: new Date().toISOString(), ...facts });
  const owners = [...new Set(FEATURES.map((feature) => feature.owner))];
  const stack = await LocalStack.start({ repoRoot: REPO_ROOT, prefix: PREFIX, owners, login, logFile: join(OUT, "worker.log") });
  const people = new Map(FEATURES.map((feature) => [feature.owner, new Person(feature, root)]));
  const person = (id: string) => people.get(id) as Person;
  const priya = person(ORIGIN.owner);
  const [jun, sam] = RUNNING.map((feature) => person(feature.owner)) as [Person, Person];
  let runner: Runner | undefined;
  const runnerLog: string[] = [];
  const mainShas: string[] = [];
  const greenChecks: { main: string; red: string[] }[] = [];

  const pass = async () => {
    runnerLog.push(await (runner as Runner).pass(["--combined", "--repo", join(root, "runner-repo"), "--python", PYTHON]));
    return runnerLog.at(-1) as string;
  };
  /** Main's head on the base repo, and every scope's tests on it. */
  const checkMainGreen = async (label: string): Promise<string> => {
    await jun.fetchRepo("base");
    const head = (await runGit(jun.work, ["rev-parse", "refs/remotes/base/main"])).trim();
    if (!mainShas.includes(head)) mainShas.push(head);
    const red = await redScopes(jun.work, head);
    greenChecks.push({ main: head, red });
    step(`main after ${label}`, { main: head, redScopes: red });
    assert.deepEqual(red, [], `main ${head} is red after ${label}`);
    return head;
  };

  try {
    // Setup: the base repo holds the fixture's base commit; each person signs in, creates the
    // identity the fixture names, registers a bridge and starts a session.
    await stack.deployer.setUp(owners);
    await stack.seedBase(fixtureRepo, PINS.branches["main"] as string, "main");
    runner = await Runner.register(stack.url, "runner", await stack.deployer.bridgeCode("runner", "runner"));
    for (const each of people.values()) {
      await mkdir(each.stateDir, { recursive: true });
      const output: string[] = [];
      const code = await stack.deployer.bridgeCode(each.id, "owner");
      assert.equal(await runCli(["register", "--server", stack.url, "--owner", each.id, "--code", code], quietIo(output), { keyStore: each.keyStore, stateDir: each.stateDir }), 0, output.join(""));
      each.bridgeId = /Registered bridge (\S+)/u.exec(output.join(""))?.[1] as string;
      await runGit(each.stateDir, ["clone", "--quiet", fixtureRepo, each.work]);
      each.cookie = await signInThroughDouble(stack.url, login(each.id));
      const identity = IDENTITIES.find((candidate) => candidate.handle === each.handle) as (typeof IDENTITIES)[number];
      const created = await each.api("POST", stack.url, "/api/identities", {
        handle: identity.handle,
        name: identity.handle.split("/")[1],
        job: identity.job,
        charterScopes: identity.charter_scopes,
        autoAccept: true,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const issued = await stack.deployer.issueMcpToken(each.id);
      each.mcpTokenId = issued.tokenId;
      each.mcp = new McpClient(stack.url, issued.token);
      await each.mcp.initialize();
      const registered = await each.mcp.call("register_session", { identity: identity.handle, vendor: identity.vendor, worktreeId: `wt_${each.id}`, branch: "main" });
      assert.equal(registered.isError, false, JSON.stringify(registered.value));
      each.sessionId = registered.value["sessionId"];
    }
    const initialMain = await checkMainGreen("setup");

    // 1. Running features open first, then Priya's; each pushes its checkpoint to its fork.
    for (const each of [jun, sam, priya]) {
      const opened = await each.call("open_feature", { feature: each.feature.id, area: declared(each.feature) });
      assert.notEqual(opened.token, null, `${each.feature.id} starts at once: ${JSON.stringify(opened.waitingOn)}`);
      each.forkToken = opened.token;
    }
    for (const each of [jun, sam]) await each.publish(PINS.tags[each.feature.commits[0]?.tag as string] as string);
    const priyaCheckpoint = await priya.publish(PINS.branches[ORIGIN.fork] as string);
    step("features opened", { features: FEATURES.map((feature) => feature.id), forks: FEATURES.map((feature) => `${PREFIX}feature-${feature.id}`) });

    // 2. The plan: one part per running feature, each the fixture's own fix as a patch on the fork head.
    const parts = [];
    for (const each of [jun, sam]) {
      const head = PINS.tags[each.feature.commits[0]?.tag as string] as string;
      const paths = each.feature.area["scopes"]!.flatMap((scope) => SCOPES.find((candidate) => candidate.id === scope)?.paths ?? []);
      const diff = execFileSync("git", ["-C", fixtureRepo, "diff", head, PINS.branches[each.feature.fork] as string, "--", ...paths], { encoding: "utf8" });
      parts.push({ place: { feature: each.feature.id }, patch: { base: head, diff } });
    }
    // The first proposal answers what is missing: the runner's facts run.
    const first = await priya.mcp.call("propose_plan", { sessionId: priya.sessionId, feature: ORIGIN.id, parts });
    assert.equal(first.value["status"], "missing", JSON.stringify(first.value).slice(0, 600));
    await pass();
    const plan = await priya.call("propose_plan", { feature: ORIGIN.id, parts });
    assert.equal(plan.status, "stored", JSON.stringify(plan).slice(0, 2_000));
    const refusedLand = await priya.refused("land_feature", { feature: ORIGIN.id });
    assert.equal(refusedLand["error"], "plan_not_approved");
    step("plan stored; land refused until approved", { planId: plan.planId, parts: plan.parts.map((part: any) => part.partId), refusal: refusedLand["error"] });

    // A checkpoint of Jun's in the plan's area asks for the plan's check; with no fix written it fails.
    const juns = await jun.call("report_checkpoint", { sha: PINS.tags[jun.feature.commits[0]?.tag as string], fork: `feature-${jun.feature.id}` });
    assert.equal(juns.planChecks?.length, 1, JSON.stringify(juns.planChecks));
    await pass();
    const checked = (await priya.landing()).runs.find((each: any) => each.runId === juns.planChecks[0].runId);
    assert.equal(checked.state, "failed", JSON.stringify(checked).slice(0, 1_000));
    assert.deepEqual(new Set(checked.failing.map((each: any) => each.target)), new Set([jun.feature.id, sam.feature.id]));
    assert.equal(await checkMainGreen("a failing plan check"), initialMain, "a failing block never moves main");
    step("plan check failed on the unfixed forks", { runId: checked.runId, failing: checked.failing, nextSteps: checked.nextSteps.map((each: any) => ({ target: each.target, step: each.step })) });

    // 3. Jun and Sam approve; Priya's agent writes each fix into their forks.
    for (const [each, part] of [[jun, plan.parts[0]], [sam, plan.parts[1]]] as const) {
      const approved = await each.api("POST", stack.url, "/api/plan-parts/approve", { feature: ORIGIN.id, part: part.partId, revision: part.revision });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
    }
    for (const part of plan.parts) {
      const answer = await priya.call("fix_token", { feature: ORIGIN.id, part: part.partId, revision: part.revision });
      const output: string[] = [];
      const code = await runFixWriteCommand(["--state-dir", priya.stateDir], quietIo(output), priya.stateDir, async () => JSON.stringify(answer));
      assert.equal(code, 0, output.join(""));
      const written = JSON.parse(output.join("").trim().split("\n").at(-1) as string);
      const reported = await priya.call("report_fix_write", { feature: ORIGIN.id, part: part.partId, revision: part.revision, commit: written.commit });
      step(`fix written for ${part.partId}`, { fork: reported.fork, commit: reported.commit, durationMs: reported.durationMs });
    }

    // 4. Jun previews Priya's checkpoint with a read token; nothing new is made in Artifacts.
    const reposBefore = await reposWithPrefix(REPO_ROOT, PREFIX);
    const previewOut: string[] = [];
    const previewDir = join(root, "preview");
    assert.equal(
      await runPreviewCommand(["--feature", ORIGIN.id, "--commit", priyaCheckpoint, "--dir", previewDir], quietIo(previewOut), jun.stateDir, (dir) => bridgeRemotes(dir, jun.keyStore, undefined, "read")),
      0,
      previewOut.join(""),
    );
    assert.equal((await runGit(previewDir, ["rev-parse", "HEAD"])).trim(), priyaCheckpoint);
    assert.deepEqual((await reposWithPrefix(REPO_ROOT, PREFIX)).sort(), reposBefore.sort(), "a preview creates no repo");
    step("preview", { feature: ORIGIN.id, commit: priyaCheckpoint, repos: reposBefore.length });

    // Priya lands: the block passes and main moves to her checkpoint in one push.
    const asked = await priya.call("land_feature", { feature: ORIGIN.id });
    assert.equal(asked.status, "checking");
    assert.equal(asked.mainBefore, initialMain);
    await pass();
    const landed = await priya.landing();
    assert.equal(landed.state, "landed", JSON.stringify(landed).slice(0, 2_000));
    assert.deepEqual([landed.promotion.mainBefore, landed.promotion.mainAfter], [initialMain, priyaCheckpoint]);
    assert.equal(await checkMainGreen(`${ORIGIN.id} landed`), priyaCheckpoint);
    step(`${ORIGIN.id} promoted`, { runId: landed.promotion.runId, mainBefore: initialMain, mainAfter: priyaCheckpoint, recordId: landed.promotion.recordId, checkMs: landed.promotion.checkMs, promoteMs: landed.promotion.promoteMs, runnerMs: landed.runs[0]?.runnerMs });

    // The originating fork refuses pushes: its write tokens were revoked and no new one is minted.
    await runGit(priya.work, ["checkout", "--quiet", "--detach", priyaCheckpoint]);
    const extra = await priya.commit({ "shared/after_landing.py": "x = 1\n" }, "After landing");
    // A fast-forward of the fork's main with the token open_feature gave: refused for its credentials.
    const pushRefusal = await priya.pushToFork(extra).then(
      () => "pushed",
      (error: Error) => error.message.split("\n").filter((line) => /^(?:fatal|error|remote):/u.test(line.trim())).join(" ").slice(0, 200),
    );
    assert.notEqual(pushRefusal, "pushed", "the landed fork refused the push");
    const tokenRefusal = await priya.refused("feature_token", { feature: ORIGIN.id });
    step("landed fork refuses pushes", { push: pushRefusal, featureToken: tokenRefusal["error"] });

    // Every affected fork merges main cleanly, and its tests pass on the merged tree.
    for (const each of [jun, sam]) {
      await each.fetchRepo("base");
      await each.fetchRepo(`feature-${each.feature.id}`);
      const merged = (await runGit(each.work, ["merge-tree", "--write-tree", "refs/remotes/base/main", `refs/remotes/feature-${each.feature.id}/main`])).trim().split("\n")[0] as string;
      const commit = (await runGit(each.work, ["commit-tree", merged, "-p", "refs/remotes/base/main", "-p", `refs/remotes/feature-${each.feature.id}/main`, "-m", "merge check"])).trim();
      const red = await redScopes(each.work, commit);
      assert.deepEqual(red, [], `${each.feature.id} merged with main is red`);
      step(`${each.feature.id} merges main cleanly`, { mergedTree: merged, redScopes: red });
    }

    // 5. Jun and Sam take main. Jun lands with a deliberate failing test: main does not move.
    for (const each of [jun, sam]) await each.takeMain();
    const gate = "analytics/tests/test_block_gate.py";
    await jun.publish(await jun.commit({ [gate]: "def test_block_gate():\n    assert False, 'a deliberate break'\n" }, "A deliberate failing test"));
    await jun.call("land_feature", { feature: jun.feature.id });
    await pass();
    const failedLand = await jun.landing();
    assert.equal(failedLand.runs[0].state, "failed", JSON.stringify(failedLand.runs[0]).slice(0, 1_000));
    assert.equal(failedLand.state, "building");
    assert.equal(await checkMainGreen("a failing land"), priyaCheckpoint, "a block with a failing target does not move main");
    step("a failing land leaves main", { runId: failedLand.runs[0].runId, failing: failedLand.runs[0].failing, nextSteps: failedLand.runs[0].nextSteps });

    // 6. Jun drops the failing test; Jun and Sam land at once. One push wins, the other is refused as raced.
    await jun.publish(await jun.commit({ [gate]: null }, "Drop the deliberate failing test"));
    await jun.call("land_feature", { feature: jun.feature.id });
    await sam.call("land_feature", { feature: sam.feature.id });
    await pass();
    const [junLanding, samLanding] = [await jun.landing(), await sam.landing()];
    const winner = junLanding.state === "landed" ? jun : sam;
    const loser = winner === jun ? sam : jun;
    const lost = winner === jun ? samLanding : junLanding;
    assert.equal((winner === jun ? junLanding : samLanding).state, "landed");
    assert.equal(lost.state, "building", JSON.stringify(lost).slice(0, 1_500));
    assert.equal(lost.runs[0].state, "raced");
    const afterWinner = await checkMainGreen(`${winner.feature.id} landed`);
    step("concurrent lands: one promoted, one raced", { promoted: winner.feature.id, raced: loser.feature.id, racedRun: lost.runs[0].runId, outcome: lost.runs[0].outcome, main: afterWinner });

    // The raced feature takes main again and lands.
    await loser.takeMain();
    await loser.call("land_feature", { feature: loser.feature.id });
    await pass();
    const second = await loser.landing();
    assert.equal(second.state, "landed", JSON.stringify(second).slice(0, 1_500));
    const finalMain = await checkMainGreen(`${loser.feature.id} landed`);
    step(`${loser.feature.id} promoted after taking main`, { main: finalMain, checkMs: second.promotion.checkMs, promoteMs: second.promotion.promoteMs });

    // Main moved only to the promoted checkpoints, and every scope's tests passed on each.
    evidence["mainHeads"] = mainShas;
    evidence["greenChecks"] = greenChecks;
    assert.ok(greenChecks.every((each) => each.red.length === 0), "main was never red");
  } finally {
    await writeFile(join(OUT, "runner.log"), runnerLog.join("\n"));
    for (const each of people.values()) {
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
