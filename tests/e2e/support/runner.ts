/**
 * The integration runner as an operator runs it: `penguin-bridge register` with a runner code, then
 * `penguin-bridge runner --once` passes. The bridge's signing key and token sit in a MemoryKeyStore,
 * so the run never touches the OS keychain, and its state folder is a temporary directory.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { bridgeRemotes, MemoryKeyStore, readRegistration, runCli, type CliIo } from "@penguin/local-bridge";

export class Runner {
  readonly bridgeId: string;
  readonly #stateDir: string;
  readonly #keyStore: MemoryKeyStore;
  readonly #output: string[];

  private constructor(bridgeId: string, stateDir: string, keyStore: MemoryKeyStore, output: string[]) {
    this.bridgeId = bridgeId;
    this.#stateDir = stateDir;
    this.#keyStore = keyStore;
    this.#output = output;
  }

  /** Registers a runner bridge with `code`; the registration's output holds no token. */
  static async register(server: string, owner: string, code: string): Promise<Runner> {
    const stateDir = await mkdtemp(join(tmpdir(), "penguin-e2e-runner-"));
    const keyStore = new MemoryKeyStore();
    const output: string[] = [];
    const exit = await runCli(["register", "--server", server, "--owner", owner, "--code", code], io(output), {
      keyStore,
      stateDir,
    });
    const registration = await readRegistration(stateDir);
    if (exit !== 0 || registration === null) throw new Error(`runner registration failed: ${output.join("")}`);
    return new Runner(registration.bridgeId, stateDir, keyStore, output);
  }

  /** One `penguin-bridge runner --once` pass; returns its printed summary. */
  async pass(): Promise<string> {
    const output: string[] = [];
    const exit = await runCli(["runner", "--once"], io(output), { keyStore: this.#keyStore, stateDir: this.#stateDir });
    this.#output.push(...output);
    if (exit !== 0) throw new Error(`runner pass failed: ${output.join("")}`);
    return output.join("");
  }

  /**
   * The operation files under `issues/<issueId>/ops/` on the issues repo's main branch, read from a
   * fresh fetch of the remote rather than the runner's own clone.
   */
  async remoteOperationFiles(issueId: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "penguin-e2e-issues-"));
    try {
      await runGit(dir, ["init", "-q"]);
      const remote = bridgeRemotes(this.#stateDir, this.#keyStore)("penguin:issues");
      await remote.git(dir, (url) => ["fetch", "-q", url, "main"]);
      const listing = await runGit(dir, ["ls-tree", "-r", "--name-only", "FETCH_HEAD", `issues/${issueId}/ops/`]);
      return listing.split("\n").filter((line) => line !== "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    await rm(this.#stateDir, { recursive: true, force: true });
  }
}

function io(output: string[]): CliIo {
  return {
    write: (text) => output.push(text),
    ask: async () => {
      throw new Error("the runner asked a question in an unattended run");
    },
  };
}
