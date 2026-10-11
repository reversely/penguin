/**
 * One owner's machine in the walkthrough: a bridge registered for the owner, a clone of the fixture
 * the owner's agent works in, and one scripted agent session per identity the owner runs. The session
 * is an MCP client standing in for Claude Code or Codex: it calls register_session, get_work,
 * post_update and report_checkpoint with the owner's MCP token, as a live agent would.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { MemoryKeyStore, runCli, worktreeAt, type CliIo } from "@penguin/local-bridge";

import type { Deployer, IssuedToken } from "../../e2e/support/deployer.ts";
import { McpClient, type ToolResult } from "../../e2e/support/mcp-client.ts";
import { BASE_BRANCH, type FixtureIdentity } from "./fixture.ts";

function io(output: string[]): CliIo {
  return { write: (text) => output.push(text), ask: async () => "y" };
}

/** A tool call that must succeed: its structured result, or an error naming the tool's refusal. */
export function ok(what: string, result: ToolResult): Record<string, any> {
  if (result.isError) throw new Error(`${what} was refused: ${JSON.stringify(result.value)}`);
  return result.value;
}

export class AgentSession {
  readonly identity: FixtureIdentity;
  readonly sessionId: string;
  readonly #mcp: McpClient;

  constructor(identity: FixtureIdentity, sessionId: string, mcp: McpClient) {
    this.identity = identity;
    this.sessionId = sessionId;
    this.#mcp = mcp;
  }

  async getWork(): Promise<Record<string, any>> {
    return ok("get_work", await this.#mcp.call("get_work", { sessionId: this.sessionId }));
  }

  async reportCheckpoint(sha: string): Promise<Record<string, any>> {
    return ok("report_checkpoint", await this.#mcp.call("report_checkpoint", { sessionId: this.sessionId, sha }));
  }

  update(issue: string, update: Record<string, unknown>): Promise<ToolResult> {
    return this.#mcp.call("post_update", { sessionId: this.sessionId, issue: Number(issue), update });
  }
}

export class OwnerMachine {
  readonly ownerId: string;
  /** The project id the bridge names in its checkpoints. */
  readonly project: string;
  readonly clone: string;
  readonly worktreeId: string;
  readonly bridgeId: string;
  readonly mcpToken: IssuedToken;
  readonly sessions: AgentSession[] = [];
  readonly #stateDir: string;
  readonly #keyStore: MemoryKeyStore;
  readonly #mcp: McpClient;
  readonly #url: string;

  private constructor(fields: {
    ownerId: string;
    project: string;
    clone: string;
    worktreeId: string;
    bridgeId: string;
    mcpToken: IssuedToken;
    stateDir: string;
    keyStore: MemoryKeyStore;
    url: string;
  }) {
    this.ownerId = fields.ownerId;
    this.project = fields.project;
    this.clone = fields.clone;
    this.worktreeId = fields.worktreeId;
    this.bridgeId = fields.bridgeId;
    this.mcpToken = fields.mcpToken;
    this.#stateDir = fields.stateDir;
    this.#keyStore = fields.keyStore;
    this.#url = fields.url;
    this.#mcp = new McpClient(fields.url, fields.mcpToken.token);
  }

  /**
   * Registers the owner's bridge with a code from the deployer, clones the fixture repository with
   * the base commit checked out, and issues the owner's MCP token.
   */
  static async set(
    url: string,
    deployer: Deployer,
    project: string,
    ownerId: string,
    fixtureRepo: string,
    baseSha: string,
  ): Promise<OwnerMachine> {
    const stateDir = await mkdtemp(join(tmpdir(), `penguin-walkthrough-bridge-`));
    const keyStore = new MemoryKeyStore();
    const output: string[] = [];
    const code = await deployer.bridgeCode(ownerId, "owner");
    const exit = await runCli(["register", "--server", url, "--owner", ownerId, "--code", code], io(output), { keyStore, stateDir });
    const bridgeId = /Registered bridge (\S+)/u.exec(output.join(""))?.[1];
    if (exit !== 0 || bridgeId === undefined) throw new Error(`registering the bridge failed: ${output.join("")}`);

    const clone = join(stateDir, "work");
    await runGit(stateDir, ["clone", "--quiet", "--no-checkout", fixtureRepo, clone]);
    await runGit(clone, ["checkout", "--quiet", "-B", BASE_BRANCH, baseSha]);
    const { id } = await worktreeAt(clone);
    const mcpToken = await deployer.issueMcpToken(ownerId);
    return new OwnerMachine({ ownerId, project, clone, worktreeId: id, bridgeId, mcpToken, stateDir, keyStore, url });
  }

  /** Starts one scripted session of `identity` in this owner's worktree. */
  async startSession(identity: FixtureIdentity): Promise<AgentSession> {
    await this.#mcp.initialize();
    const registered = ok(
      "register_session",
      await this.#mcp.call("register_session", {
        identity: identity.handle,
        vendor: identity.vendor,
        worktreeId: this.worktreeId,
        branch: BASE_BRANCH,
      }),
    );
    const session = new AgentSession(identity, registered.sessionId, this.#mcp);
    this.sessions.push(session);
    return session;
  }

  /**
   * The agent's work reaches `sha`, and the bridge publishes it to the owner's fork as a checkpoint
   * with the owner's consent (`penguin-bridge checkpoint`). Returns the bridge's printed output.
   */
  async publish(sha: string, identity: FixtureIdentity | undefined): Promise<string> {
    await runGit(this.clone, ["reset", "--quiet", "--hard", sha]);
    const output: string[] = [];
    const args = ["checkpoint", "--owner", this.ownerId, "--project", this.project, "--worktree", this.clone];
    const exit = await runCli([...args, ...(identity ? ["--identity", identity.handle] : [])], io(output), {
      keyStore: this.#keyStore,
      stateDir: this.#stateDir,
    });
    const text = output.join("");
    if (exit !== 0 || !/Published|already has checkpoint/u.test(text)) throw new Error(`publishing ${sha} failed: ${text}`);
    return text;
  }

  async dispose(deployer: Deployer): Promise<void> {
    await deployer.revokeMcpToken(this.mcpToken.tokenId).catch(() => undefined);
    await deployer.revokeBridge(this.bridgeId).catch(() => undefined);
    await rm(this.#stateDir, { recursive: true, force: true });
  }
}
