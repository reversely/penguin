/**
 * A local Penguin for one use case: the real Worker and agents under `wrangler dev`, with the
 * Artifacts binding pointed at the real namespace under a repo prefix unique to the run, and the
 * loopback GitHub OAuth test double for sign-in (docs/mcp-setup.md, "Against a local Worker").
 *
 * Secrets (the deployer token, the operation signing key, the Artifacts token that seeds the base
 * repo) are generated or fetched in memory, written only to a 0600 env file in a temporary folder
 * that is deleted afterwards, and never printed. Teardown deletes every repo under the prefix.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { ARTIFACTS_GIT_OPTIONS, tokenEnvironment } from "@penguin/local-bridge";

import { startGitHubDouble, DOUBLE_CLIENT, type GitHubDouble } from "../../../apps/worker/test/github-double.ts";
import { Deployer } from "../../e2e/support/deployer.ts";

const run = promisify(execFile);
const NAMESPACE = "penguin";

/** A free loopback port. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Runs wrangler with JSON output and parses the one JSON value it prints after its banner. */
async function wranglerJson(repoRoot: string, args: readonly string[]): Promise<any> {
  const { stdout } = await run("npx", ["wrangler", ...args, "--json"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  const start = stdout.search(/[[{]/u);
  if (start < 0) throw new Error(`wrangler ${args[0]} ${args[1]} ${args[2]} printed no JSON`);
  return JSON.parse(stdout.slice(start));
}

/** The names of the namespace's repos that start with `prefix`. */
export async function reposWithPrefix(repoRoot: string, prefix: string): Promise<string[]> {
  const listed = await wranglerJson(repoRoot, ["artifacts", "repos", "list", "--namespace", NAMESPACE]);
  const repos: { name: string }[] = Array.isArray(listed) ? listed : (listed.repos ?? listed.result ?? []);
  return repos.map((repo) => repo.name).filter((name) => name.startsWith(prefix));
}

export async function deleteRepo(repoRoot: string, name: string): Promise<void> {
  await run("npx", ["wrangler", "artifacts", "repos", "delete", name, "--namespace", NAMESPACE, "-y"], { cwd: repoRoot });
}

/** Runs `step`, retrying up to four more times after a failure such as a dropped connection. */
async function retried<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

/** An Ed25519 private JWK, the form PENGUIN_OP_SIGNING_KEY takes. */
async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

export interface StackOptions {
  readonly repoRoot: string;
  /** The repo prefix this run's repos are created under. */
  readonly prefix: string;
  /** The project's owner ids; each signs in through the double as `login(owner)`. */
  readonly owners: readonly string[];
  readonly login: (owner: string) => string;
  /** Where the Worker's console output goes. */
  readonly logFile: string;
}

export class LocalStack {
  readonly url: string;
  readonly prefix: string;
  readonly deployer: Deployer;
  readonly #repoRoot: string;
  readonly #double: GitHubDouble;
  readonly #worker: ChildProcess;
  readonly #log: WriteStream;
  readonly #tempDir: string;

  private constructor(
    url: string,
    options: StackOptions,
    deployerToken: string,
    double: GitHubDouble,
    worker: ChildProcess,
    log: WriteStream,
    tempDir: string,
  ) {
    this.url = url;
    this.prefix = options.prefix;
    this.#repoRoot = options.repoRoot;
    this.deployer = new Deployer(url, deployerToken);
    this.#double = double;
    this.#worker = worker;
    this.#log = log;
    this.#tempDir = tempDir;
  }

  /** Starts the double and `wrangler dev`, and resolves once the Worker answers /health. */
  static async start(options: StackOptions): Promise<LocalStack> {
    const tempDir = await mkdtemp(join(tmpdir(), "penguin-walkthrough-"));
    const double = await startGitHubDouble(options.login(options.owners[0] as string));
    const port = await freePort();
    const deployerToken = randomBytes(32).toString("base64url");
    const envFile = join(tempDir, "worker.env");
    const env: Record<string, string> = {
      PENGUIN_DEPLOYER_TOKEN: deployerToken,
      PENGUIN_OP_SIGNING_KEY: await signingKey(),
      PENGUIN_REPO_PREFIX: options.prefix,
      PENGUIN_GITHUB_BASE_URL: double.url,
      GITHUB_OAUTH_CLIENT_ID: DOUBLE_CLIENT.clientId,
      GITHUB_OAUTH_CLIENT_SECRET: DOUBLE_CLIENT.clientSecret,
      PENGUIN_DASHBOARD_OWNERS: options.owners.map((owner) => `${options.login(owner)}:${owner}`).join(","),
    };
    // Single quotes keep a value literal in the env file: the signing key is JSON with double quotes.
    const lines = Object.entries(env).map(([key, value]) => `${key}='${value}'`);
    await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });

    const log = createWriteStream(options.logFile);
    const secrets = [deployerToken, env.PENGUIN_OP_SIGNING_KEY as string];
    const redact = (chunk: Buffer) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), chunk.toString());
    const worker = spawn(
      "npx",
      [
        "wrangler", "dev", "-c", "apps/worker/wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port),
        "--env-file", envFile, "--persist-to", join(tempDir, "state"), "--show-interactive-dev-session=false",
      ],
      { cwd: options.repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true },
    );
    worker.stdout?.on("data", (chunk: Buffer) => log.write(redact(chunk)));
    worker.stderr?.on("data", (chunk: Buffer) => log.write(redact(chunk)));

    const url = `http://127.0.0.1:${port}`;
    const stack = new LocalStack(url, options, deployerToken, double, worker, log, tempDir);
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (worker.exitCode !== null) {
        await stack.stop();
        throw new Error(`wrangler dev exited with ${worker.exitCode}; see ${options.logFile}`);
      }
      const healthy = await fetch(`${url}/health`).then((response) => response.status === 200, () => false);
      if (healthy) return stack;
      if (Date.now() > deadline) {
        await stack.stop();
        throw new Error(`the Worker did not answer /health within 180 s; see ${options.logFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /**
   * Seeds the base repo with `sha` from the local repository `source`, as the deployer does once per
   * project: a short-lived write token issued with wrangler, handed to Git in its environment.
   */
  async seedBase(source: string, sha: string, branch: string): Promise<void> {
    const name = `${this.prefix}base`;
    const repo = await wranglerJson(this.#repoRoot, ["artifacts", "repos", "get", name, "--namespace", NAMESPACE]);
    const issued = await wranglerJson(this.#repoRoot, [
      "artifacts", "repos", "issue-token", name, "--namespace", NAMESPACE, "--scope", "write", "--ttl", "600",
    ]);
    const token: string | undefined = issued.plaintext ?? issued.token ?? issued.result?.plaintext;
    if (typeof token !== "string") throw new Error(`issue-token answered without a token (fields: ${Object.keys(issued).join(", ")})`);
    await runGit(source, [...ARTIFACTS_GIT_OPTIONS, "push", "--quiet", repo.remote, `${sha}:refs/heads/${branch}`], {
      env: tokenEnvironment(token),
    });
  }

  /** Stops the Worker and the double, deletes every repo under the prefix and the temporary folder. */
  async stop(): Promise<string[]> {
    if (this.#worker.exitCode === null && this.#worker.pid !== undefined) {
      const exited = new Promise((resolve) => this.#worker.once("exit", resolve));
      process.kill(-this.#worker.pid, "SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (this.#worker.exitCode === null) process.kill(-this.#worker.pid, "SIGKILL");
    }
    this.#log.end();
    await this.#double.close();
    await rm(this.#tempDir, { recursive: true, force: true });
    const repos = await retried(() => reposWithPrefix(this.#repoRoot, this.prefix));
    for (const name of repos) await retried(() => deleteRepo(this.#repoRoot, name));
    return repos;
  }
}
