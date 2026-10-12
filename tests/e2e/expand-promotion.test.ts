/**
 * Live proof of #115 (PRD 0.5 section 4.2 step 2, 4.5 step 6): Penguin promotes a feature's expand
 * checkpoint on its own, from the feature's fork, through the block landing path, against real
 * Artifacts. The Worker and both agents run under local `wrangler dev`, every repo under a prefix
 * unique to the run, with a bridge per person, a runner bridge and scripted agent sessions over MCP.
 * Skipped unless PENGUIN_EXPAND_E2E=1; docs/bridge-and-runner.md says how to run it.
 *
 * On the helpful-fix fixture, Jun's weekly report runs in analytics, which reads Priya's ingestion
 * scope. Priya's feature then:
 * 1. adds `start_of_local_day` beside `start_of_day` and promotes that checkpoint alone: main moves to
 *    it in one push, the feature keeps building and her fork takes her next push;
 * 2. changes `start_of_day`'s signature, which the Only adds check refuses with the entries that fail;
 * 3. puts the signature back and adds a helper to Jun's analytics scope, which waits on Jun through the
 *    overlap lock until Jun approves on the dashboard, then reaches main.
 *
 * Every scope's tests run on main after each promotion. Every repo the run made is deleted at the end.
 * Nothing here prints a token: tokens stay in memory and reach Git through the environment only.
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
const PREFIX = `p115-${RUN_ID}-`;
const OUT = process.env.PENGUIN_EXPAND_E2E_OUT ?? join(tmpdir(), `penguin-expand-e2e-${RUN_ID}`);
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

const PINS = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as { branches: Record<string, string>; tags: Record<string, string> };
const IDENTITIES = (JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "identities.json"), "utf8")) as {
  identities: { handle: string; owner: string; vendor: string; job: string; charter_scopes: string[] }[];
}).identities;
const login = (person: string) => `${person}-gh`;

const LOCAL_DAY = `

def start_of_local_day(moment: datetime, offset: timedelta) -> datetime:
    """Return midnight at the start of the day of \`\`moment\`\` at the UTC offset \`\`offset\`\`."""
    require_offset(moment)
    local = moment.astimezone(timezone(offset))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)
`;
const LOCAL_DAY_TEST = `from datetime import UTC, datetime, timedelta, timezone

from shared.dates import start_of_local_day


def test_an_evening_west_of_utc_stays_on_its_local_day():
    """An instant early on the UTC day falls on the previous day at a western offset."""
    moment = datetime(2026, 2, 10, 4, 30, tzinfo=UTC)
    start = start_of_local_day(moment, timedelta(hours=-8))
    assert start == datetime(2026, 2, 9, 0, 0, tzinfo=timezone(timedelta(hours=-8)))
`;
const WEEKDAY_HELPER = `"""Helpers for reports grouped by a user's own week."""


def week_label(year: int, week: int) -> str:
    """Return the ISO week label, such as \`\`2026-W07\`\`."""
    return f"{year}-W{week:02d}"
`;

function quietIo(output: string[]): CliIo {
  return { write: (text) => output.push(text), ask: async () => "y" };
}

/** One person's machine: a bridge, a dashboard session, an MCP session of their identity and a work clone. */
class Person {
  readonly handle: string;
  readonly stateDir: string;
  readonly work: string;
  readonly keyStore = new MemoryKeyStore();
  bridgeId = "";
  mcpTokenId = "";
  sessionId = "";
  cookie = "";
  /** The feature's fork token from open_feature or feature_token; in memory only. */
  forkToken: { token: string; remote: string } | null = null;
  mcp!: McpClient;

  readonly id: string;
  readonly feature: string;

  constructor(id: string, feature: string, root: string) {
    this.id = id;
    this.feature = feature;
    this.handle = (IDENTITIES.find((identity) => identity.owner === id && identity.handle !== `@${id}/steward`) as { handle: string }).handle;
    this.stateDir = join(root, id);
    this.work = join(this.stateDir, "work");
  }

  /** A tool call; an `offline` session registers and joins its feature again first, as an agent does. */
  async raw(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: Record<string, any> }> {
    let result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    if (result.isError && result.value["error"] === "offline") {
      const identity = IDENTITIES.find((candidate) => candidate.handle === this.handle) as (typeof IDENTITIES)[number];
      this.sessionId = (await this.mcp.call("register_session", { identity: identity.handle, vendor: identity.vendor, worktreeId: `wt_${this.id}`, branch: "main" })).value["sessionId"];
      await this.mcp.call("open_feature", { sessionId: this.sessionId, feature: this.feature });
      result = await this.mcp.call(name, { sessionId: this.sessionId, ...args });
    }
    return result;
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const result = await this.raw(name, args);
    if (result.isError) throw new Error(`${this.handle}'s ${name} was refused: ${JSON.stringify(result.value).slice(0, 600)}`);
    return result.value;
  }

  /** A tool call whose refusal is the expected answer, with that refusal. */
  async refused(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const result = await this.raw(name, args);
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

  async commit(files: Record<string, string>, message: string): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(this.work, path, ".."), { recursive: true });
      await writeFile(join(this.work, path), content);
      await runGit(this.work, ["add", "--", path]);
    }
    await runGit(this.work, ["-c", `user.name=${this.id}`, "-c", `user.email=${this.id}@penguin.invalid`, "commit", "--quiet", "-m", message]);
    return (await runGit(this.work, ["rev-parse", "HEAD"])).trim();
  }

  /** Pushes `sha` to the fork's main with the feature's write token, then reports it as a checkpoint. */
  async publish(sha: string): Promise<string> {
    if (this.forkToken === null) this.forkToken = (await this.call("feature_token", { feature: this.feature })).token;
    const push = (token: { token: string; remote: string }) =>
      runGit(this.work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", token.remote, `${sha}:refs/heads/main`], { env: tokenEnvironment(token.token) });
    try {
      await push(this.forkToken as { token: string; remote: string });
    } catch {
      // The fork token ran out; a fresh one comes from feature_token.
      this.forkToken = (await this.call("feature_token", { feature: this.feature })).token;
      await push(this.forkToken as { token: string; remote: string });
    }
    await this.call("report_checkpoint", { sha, fork: `feature-${this.feature}` });
    return sha;
  }

  async landing(): Promise<Record<string, any>> {
    return (await this.call("get_work", {})).landing;
  }
}

/** Every scope's test command on `sha`, in a throwaway worktree of `repo`; the scopes that failed. */
async function redScopes(repo: string, sha: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "penguin-expand-e2e-tree-"));
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

const enabled = process.env.PENGUIN_EXPAND_E2E === "1";

test("an expand checkpoint reaches main on its own from the feature's fork", { skip: enabled ? false : "set PENGUIN_EXPAND_E2E=1 to run it against real Artifacts", timeout: 30 * 60_000 }, async () => {
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "penguin-expand-e2e-"));
  const fixtureRepo = join(root, "fixture");
  await run(PYTHON, [join(FIXTURE, "build.py"), fixtureRepo]);
  const evidence: Record<string, unknown> = { prefix: PREFIX, steps: [] as unknown[] };
  const started = Date.now();
  const step = (name: string, facts: Record<string, unknown>) => (evidence["steps"] as unknown[]).push({ step: name, atMs: Date.now() - started, ...facts });
  const stack = await LocalStack.start({ repoRoot: REPO_ROOT, prefix: PREFIX, owners: ["priya", "jun"], login, logFile: join(OUT, "worker.log") });
  const priya = new Person("priya", "local-day", root);
  const jun = new Person("jun", "weekly-report", root);
  let runner: Runner | undefined;
  const runnerLog: string[] = [];
  const greenChecks: { main: string; red: string[] }[] = [];

  /** One runner pass, timed. */
  const pass = async (label: string) => {
    const at = Date.now();
    runnerLog.push(await (runner as Runner).pass(["--combined", "--repo", join(root, "runner-repo"), "--python", PYTHON]));
    step(`runner pass: ${label}`, { wallMs: Date.now() - at });
  };
  const mainHead = async (): Promise<string> => {
    await jun.fetchRepo("base");
    return (await runGit(jun.work, ["rev-parse", "refs/remotes/base/main"])).trim();
  };
  const checkMainGreen = async (label: string): Promise<string> => {
    const head = await mainHead();
    const red = await redScopes(jun.work, head);
    greenChecks.push({ main: head, red });
    step(`main after ${label}`, { main: head, redScopes: red });
    assert.deepEqual(red, [], `main ${head} is red after ${label}`);
    return head;
  };
  /** Asks to promote the latest checkpoint alone, timed; the refusal or the run. */
  const expand = async (label: string) => {
    const at = Date.now();
    const result = await priya.raw("land_feature", { feature: priya.feature, expand: true });
    step(`land_feature expand: ${label}`, { wallMs: Date.now() - at, answer: result.isError ? result.value["error"] : result.value["status"] });
    return result;
  };

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
      const identity = IDENTITIES.find((candidate) => candidate.handle === each.handle) as (typeof IDENTITIES)[number];
      const created = await each.api("POST", stack.url, "/api/identities", { handle: identity.handle, name: identity.handle.split("/")[1], job: identity.job, charterScopes: identity.charter_scopes, autoAccept: true });
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

    // Jun's weekly report runs in analytics, which reads ingestion; then Priya opens her feature.
    const junOpened = await jun.call("open_feature", { feature: jun.feature, area: { scopes: ["analytics"], paths: ["analytics/weekly.py"], contracts: [] } });
    jun.forkToken = junOpened.token;
    await jun.publish(PINS.tags["owner-jun-checkpoint"] as string);
    const priyaOpened = await priya.call("open_feature", { feature: priya.feature, area: { scopes: ["shared-dates", "ingestion"], paths: ["shared/dates.py"], contracts: ["shared/dates.py::start_of_day"] } });
    assert.notEqual(priyaOpened.token, null, JSON.stringify(priyaOpened.waitingOn));
    priya.forkToken = priyaOpened.token;
    step("features opened", { features: [jun.feature, priya.feature] });

    // 1. The expand checkpoint: start_of_local_day beside start_of_day, with its test.
    await runGit(priya.work, ["checkout", "--quiet", "--detach", PINS.branches["main"] as string]);
    const dates = (await readFile(join(priya.work, "shared", "dates.py"), "utf8")).replace("from datetime import date, datetime, timedelta", "from datetime import date, datetime, timedelta, timezone");
    const expanded = await priya.publish(await priya.commit({ "shared/dates.py": dates + LOCAL_DAY, "shared/tests/test_local_day.py": LOCAL_DAY_TEST }, "Add start_of_local_day beside start_of_day"));
    const first = await expand("first ask");
    assert.equal(first.value["error"], "waiting_for_runner", JSON.stringify(first.value));
    await pass("facts run of the expand checkpoint");
    const asked = await expand("after the facts run");
    assert.equal(asked.isError, false, JSON.stringify(asked.value));
    assert.equal(asked.value["mainBefore"], initialMain);
    await pass("expand block run");
    const promoted = await priya.landing();
    assert.equal(promoted.state, "building", "the feature keeps building");
    assert.equal(promoted.promotion, null, "the feature itself has not landed");
    const [expansion] = promoted.expansions;
    assert.deepEqual([expansion?.mainBefore, expansion?.mainAfter], [initialMain, expanded], JSON.stringify(promoted).slice(0, 1_500));
    assert.equal(await checkMainGreen("the expand promotion"), expanded);
    step("expand promoted", { runId: expansion.runId, recordId: expansion.recordId, checkMs: expansion.checkMs, promoteMs: expansion.promoteMs, runnerMs: promoted.runs[0]?.runnerMs });

    // The fork stays writable: Priya's next commit goes to her fork with the token she already holds.
    const sigChange = dates.replace("def start_of_day(moment: datetime) -> datetime:", "def start_of_day(moment: datetime, offset: timedelta) -> datetime:") + LOCAL_DAY;
    await priya.publish(await priya.commit({ "shared/dates.py": sigChange }, "Make start_of_day take the offset"));
    step("fork writable after the expand", { featureToken: (await priya.call("feature_token", { feature: priya.feature })).token !== null });

    // 2. A changed signature does not only add: refused with each entry that fails.
    assert.equal((await expand("signature change, first ask")).value["error"], "waiting_for_runner");
    await pass("facts run of the signature change");
    const notOnlyAdds = await expand("signature change");
    assert.equal(notOnlyAdds.value["error"], "not_only_adds", JSON.stringify(notOnlyAdds.value));
    assert.match(notOnlyAdds.value["message"], /signature of shared\.dates\.start_of_day changed/u);
    assert.equal(await mainHead(), expanded, "a refused expand leaves main");
    step("signature change refused", { message: notOnlyAdds.value["message"] });

    // 3. The signature goes back, and a helper goes into Jun's analytics scope: Jun is asked once.
    const intoJuns = await priya.publish(await priya.commit({ "shared/dates.py": dates + LOCAL_DAY, "analytics/week_labels.py": WEEKDAY_HELPER }, "Add week labels for local-day reports"));
    assert.equal((await expand("Jun's scope, first ask")).value["error"], "waiting_for_runner");
    await pass("facts run of the addition to Jun's scope");
    const waiting = await expand("Jun's scope");
    assert.equal(waiting.value["error"], "waiting_on_owner", JSON.stringify(waiting.value));
    assert.equal((await expand("Jun's scope, asked again")).value["error"], "waiting_on_owner");
    const requests = (await jun.api("GET", stack.url, "/api/overlaps")).body.requests as { feature: string; blockedFeature: string; overlap: { scopes: string[] } }[];
    assert.deepEqual(requests.map(({ feature, blockedFeature, overlap }) => [feature, blockedFeature, overlap.scopes]), [["owner:jun", priya.feature, ["analytics"]]], "Jun is asked once");
    assert.equal((await priya.api("POST", stack.url, "/api/overlaps/approve", { feature: "owner:jun", blockedFeature: priya.feature })).status, 403, "only Jun approves");
    assert.equal((await jun.api("POST", stack.url, "/api/overlaps/approve", { feature: "owner:jun", blockedFeature: priya.feature })).status, 200);
    step("Jun approved the addition to analytics", { requests: requests.length });
    const approved = await expand("after Jun's approval");
    assert.equal(approved.isError, false, JSON.stringify(approved.value));
    await pass("expand block run into Jun's scope");
    const second = await priya.landing();
    assert.deepEqual(second.expansions.map((each: { mainAfter: string }) => each.mainAfter), [expanded, intoJuns]);
    assert.equal(second.state, "building");
    assert.equal(await checkMainGreen("the second expand promotion"), intoJuns);
    const last = second.expansions[1];
    step("second expand promoted", { runId: last.runId, recordId: last.recordId, checkMs: last.checkMs, promoteMs: last.promoteMs, runnerMs: second.runs[0]?.runnerMs });

    evidence["greenChecks"] = greenChecks;
    assert.ok(greenChecks.every((each) => each.red.length === 0), "main was never red");
  } finally {
    await writeFile(join(OUT, "runner.log"), runnerLog.join("\n"));
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
    evidence["totalMs"] = Date.now() - started;
    await writeFile(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
