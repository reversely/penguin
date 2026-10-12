/**
 * One person's machine in the walkthrough: a bridge registered for the person, a clone of the
 * fixture repository their agents work in, and one scripted agent session per feature the person
 * runs. A session is an MCP client standing in for Claude Code or Codex: it registers as the
 * feature's identity, opens or joins the feature, pushes the fixture's commits to the feature's fork
 * with the fork token Penguin minted, and calls the tools a live agent would. Tokens stay in memory
 * and reach Git through the environment only; nothing here prints one.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  ARTIFACTS_PUSH_OPTIONS,
  bridgeRemotes,
  MemoryKeyStore,
  penguinRemote,
  runCli,
  runFixWriteCommand,
  tokenEnvironment,
  type CliIo,
} from "@penguin/local-bridge";

import type { Deployer } from "../../e2e/support/deployer.ts";
import { McpClient, type ToolResult } from "../../e2e/support/mcp-client.ts";
import type { CaseFeature, FixtureIdentity } from "./fixture.ts";

const run = promisify(execFile);

function quietIo(output: string[]): CliIo {
  return { write: (text) => output.push(text), ask: async () => "y" };
}

/** A write token on a fork with its Git remote, as open_feature, feature_token and fix_token answer it. */
interface ForkToken {
  readonly token: string;
  readonly remote: string;
}

/** Tool calls that only read or heartbeat, left out of the agent-calls metric. */
export const POLLING_TOOLS: ReadonlySet<string> = new Set(["get_work"]);

export class AgentSession {
  readonly feature: CaseFeature;
  readonly identity: FixtureIdentity;
  readonly #person: Person;
  sessionId = "";
  #forkToken: ForkToken | null = null;
  /** Every tool call this session made, in order, with the time it was made. */
  readonly calls: { readonly tool: string; readonly at: number }[] = [];

  constructor(person: Person, feature: CaseFeature, identity: FixtureIdentity) {
    this.#person = person;
    this.feature = feature;
    this.identity = identity;
  }

  get fork(): string {
    return `feature-${this.feature.id}`;
  }

  /** Registers the session as the feature's identity in the feature's own worktree. */
  async register(): Promise<void> {
    const registered = await this.#raw("register_session", {
      identity: this.identity.handle,
      vendor: this.identity.vendor,
      worktreeId: `wt_${this.feature.id}`,
      branch: "main",
    });
    if (registered.isError) throw new Error(`${this.identity.handle}'s register_session was refused: ${JSON.stringify(registered.value)}`);
    this.sessionId = registered.value["sessionId"];
  }

  /** Opens the feature with its declared area; returns the answer, keeping its fork token in memory. */
  async open(): Promise<Record<string, any>> {
    const opened = await this.call("open_feature", { feature: this.feature.id, area: this.feature.area });
    this.#forkToken = opened["token"] ?? null;
    return opened;
  }

  async #raw(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool: name, at: Date.now() });
    return this.#person.mcp.call(name, args);
  }

  /** Registers again after the session went offline between steps, and joins its feature again, as an agent does. */
  async #rejoin(): Promise<void> {
    await this.register();
    const joined = await this.#raw("open_feature", { sessionId: this.sessionId, feature: this.feature.id });
    if (joined.isError) throw new Error(`${this.identity.handle} could not rejoin ${this.feature.id}: ${JSON.stringify(joined.value).slice(0, 400)}`);
  }

  async #withSession(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let result = await this.#raw(name, { sessionId: this.sessionId, ...args });
    if (result.isError && result.value["error"] === "offline") {
      await this.#rejoin();
      result = await this.#raw(name, { sessionId: this.sessionId, ...args });
    }
    return result;
  }

  /** A tool call that must succeed: its structured result. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.#withSession(name, args);
    if (result.isError) throw new Error(`${this.identity.handle}'s ${name} was refused: ${JSON.stringify(result.value).slice(0, 1_500)}`);
    return result.value;
  }

  /** A tool call whose answer may be marked as an error, such as a plan with gaps: the answer either way. */
  async answer(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.#withSession(name, args);
  }

  /** A tool call whose refusal is the expected answer. */
  async refused(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.#withSession(name, args);
    if (!result.isError) throw new Error(`${name} was expected to be refused: ${JSON.stringify(result.value).slice(0, 400)}`);
    return result.value;
  }

  async #push(sha: string): Promise<void> {
    const token = this.#forkToken as ForkToken;
    await runGit(this.#person.work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", token.remote, `${sha}:refs/heads/main`], {
      env: tokenEnvironment(token.token),
    });
  }

  /** Pushes `sha` to the feature's fork with the fork token, without reporting a checkpoint. */
  async push(sha: string): Promise<void> {
    if (this.#forkToken === null) this.#forkToken = (await this.call("feature_token", { feature: this.feature.id }))["token"];
    try {
      await this.#push(sha);
    } catch {
      // The fork token ran out; a fresh one comes from feature_token.
      this.#forkToken = (await this.call("feature_token", { feature: this.feature.id }))["token"];
      await this.#push(sha);
    }
  }

  /** Pushes `sha` to the feature's fork and reports it as a checkpoint; returns the checkpoint's answer. */
  async publish(sha: string): Promise<Record<string, any>> {
    await this.push(sha);
    return this.report(sha);
  }

  /** Reports `sha` on the feature's fork again: a safe checkpoint that delivers what waits for the session. */
  report(sha: string): Promise<Record<string, any>> {
    return this.call("report_checkpoint", { sha, fork: this.fork });
  }

  async work(): Promise<Record<string, any>> {
    return this.call("get_work");
  }

  /**
   * Writes an approved part's fix into the affected fork, as the originating agent does: fix_token,
   * `penguin-bridge fix-write` on its answer, then report_fix_write. Returns the report's answer.
   */
  async writeFix(part: string, revision: number): Promise<Record<string, any>> {
    const granted = await this.call("fix_token", { feature: this.feature.id, part, revision });
    const output: string[] = [];
    const code = await runFixWriteCommand(["--state-dir", this.#person.stateDir], quietIo(output), this.#person.stateDir, async () => JSON.stringify(granted));
    if (code !== 0) throw new Error(`fix-write for ${part} exited ${code}: ${output.join("")}`);
    const written = JSON.parse(output.join("").trim().split("\n").at(-1) as string) as { commit: string };
    return this.call("report_fix_write", { feature: this.feature.id, part, revision, commit: written.commit });
  }

  /** Whether a push to `repo` with this feature's fork token is refused: an agent token never writes elsewhere. */
  async pushRefusedOn(repo: string, sha: string): Promise<string> {
    const token = this.#forkToken ?? (await this.call("feature_token", { feature: this.feature.id }))["token"];
    const remote = (token as ForkToken).remote.replace(this.fork, repo);
    if (remote === (token as ForkToken).remote) throw new Error(`the fork remote does not name ${this.fork}`);
    return runGit(this.#person.work, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", remote, `${sha}:refs/heads/main`], {
      env: tokenEnvironment((token as ForkToken).token),
    }).then(
      () => "pushed",
      // Git's refusal without the remote's URL, which names the account.
      (error: Error) =>
        error.message
          .split("\n")
          .filter((line) => /^(?:fatal|error|remote):/u.test(line.trim()))
          .join(" ")
          .replace(/'?https?:\/\/\S+/gu, "<repo>")
          .slice(0, 200) || "refused",
    );
  }
}

export class Person {
  readonly id: string;
  readonly stateDir: string;
  readonly work: string;
  readonly keyStore = new MemoryKeyStore();
  readonly sessions = new Map<string, AgentSession>();
  bridgeId = "";
  mcpTokenId = "";
  mcp!: McpClient;

  private constructor(id: string, stateDir: string) {
    this.id = id;
    this.stateDir = stateDir;
    this.work = join(stateDir, "work");
  }

  /** Registers the person's bridge, clones the fixture repository and issues the person's MCP token. */
  static async set(url: string, deployer: Deployer, id: string, fixtureRepo: string): Promise<Person> {
    const person = new Person(id, await mkdtemp(join(tmpdir(), "penguin-walkthrough-person-")));
    const output: string[] = [];
    const code = await deployer.bridgeCode(id, "owner");
    const exit = await runCli(["register", "--server", url, "--owner", id, "--code", code], quietIo(output), { keyStore: person.keyStore, stateDir: person.stateDir });
    const bridgeId = /Registered bridge (\S+)/u.exec(output.join(""))?.[1];
    if (exit !== 0 || bridgeId === undefined) throw new Error(`registering ${id}'s bridge failed: ${output.join("")}`);
    person.bridgeId = bridgeId;
    await runGit(person.stateDir, ["clone", "--quiet", "--no-checkout", fixtureRepo, person.work]);
    const issued = await deployer.issueMcpToken(id);
    person.mcpTokenId = issued.tokenId;
    person.mcp = new McpClient(url, issued.token);
    await person.mcp.initialize();
    return person;
  }

  /** Starts the scripted session of `feature`'s agent. */
  async startSession(feature: CaseFeature, identity: FixtureIdentity): Promise<AgentSession> {
    const session = new AgentSession(this, feature, identity);
    await session.register();
    this.sessions.set(feature.id, session);
    return session;
  }

  session(featureId: string): AgentSession {
    const session = this.sessions.get(featureId);
    if (session === undefined) throw new Error(`${this.id} runs no session on ${featureId}`);
    return session;
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

  /** The head of `repo`'s main, fetched with the bridge's read token. */
  async headOf(repo: string): Promise<string> {
    await this.fetchRepo(repo);
    return (await runGit(this.work, ["rev-parse", `refs/remotes/${repo}/main`])).trim();
  }

  /** The tree of a commit in the work clone. */
  async treeOf(sha: string): Promise<string> {
    return (await runGit(this.work, ["rev-parse", `${sha}^{tree}`])).trim();
  }

  /** Every scope's test command on `sha`, in a throwaway worktree; the scopes that failed. */
  async redScopes(sha: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "penguin-walkthrough-tree-"));
    await runGit(this.work, ["worktree", "add", "--quiet", "--detach", dir, sha]);
    try {
      const scopes = JSON.parse(await readFile(join(dir, "penguin", "scopes.json"), "utf8")) as { scopes: { id: string; test_command: string }[] };
      const red: string[] = [];
      for (const scope of scopes.scopes) {
        try {
          await run("sh", ["-c", scope.test_command], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 16 * 1024 * 1024 });
        } catch {
          red.push(scope.id);
        }
      }
      return red;
    } finally {
      await runGit(this.work, ["worktree", "remove", "--force", dir]);
    }
  }

  async dispose(deployer: Deployer): Promise<void> {
    if (this.mcpTokenId !== "") await deployer.revokeMcpToken(this.mcpTokenId).catch(() => undefined);
    if (this.bridgeId !== "") await deployer.revokeBridge(this.bridgeId).catch(() => undefined);
    await rm(this.stateDir, { recursive: true, force: true });
  }
}

/** Makes `dir` if missing; the walkthrough's output folders. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
