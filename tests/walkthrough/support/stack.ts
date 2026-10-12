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
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { ARTIFACTS_PUSH_OPTIONS, tokenEnvironment } from "@penguin/local-bridge";

import { startGitHubDouble, DOUBLE_CLIENT, type GitHubDouble } from "./github-double.ts";
import { Deployer } from "../../e2e/support/deployer.ts";

const run = promisify(execFile);
export const NAMESPACE = "penguin";

/** A free loopback port. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Runs wrangler with JSON output and parses the one JSON value it prints after its banner. */
export async function wranglerJson(repoRoot: string, args: readonly string[]): Promise<any> {
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

/**
 * Waits for `step` at most `ms`; past that the clean-up goes on without it. A Worker whose Artifacts
 * binding stopped answering can hold a request, or a server close, open with no end.
 */
export async function bounded(ms: number, step: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([step().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `step`, retrying up to four more times after a failure such as a dropped connection. */
export async function retried<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

/**
 * Builds the dashboard and copies the build to `target`, which the Worker then serves instead of
 * apps/dashboard/dist. Any other build of the dashboard in this working tree while `wrangler dev` runs
 * (another `wrangler dev` starting, `wrangler deploy`, `npm run build -w @penguin/dashboard`)
 * deletes and rewrites dist. Every ASSETS fetch of that `wrangler dev` then answers 500 with an
 * empty body (issue #74, docs/walkthrough.md). Nothing else writes the copy.
 */
async function snapshotDashboard(repoRoot: string, target: string): Promise<string> {
  await run("npm", ["run", "build", "-w", "@penguin/dashboard"], { cwd: repoRoot });
  await cp(join(repoRoot, "apps", "dashboard", "dist"), target, { recursive: true });
  return target;
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
  /** Further Worker settings for this run, such as a shorter session offline window. */
  readonly vars?: Readonly<Record<string, string>>;
}

/** The Worker's settings and secrets as the env file wrangler dev reads holds them, and the secrets to redact. */
interface WorkerEnv {
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}

/** Writes the env file and starts `wrangler dev`, its console going to `log` with the secrets removed. */
async function spawnWorker(
  options: StackOptions,
  tempDir: string,
  assets: string,
  port: number,
  env: WorkerEnv,
  log: WriteStream,
): Promise<ChildProcess> {
  const envFile = join(tempDir, "worker.env");
  // Single quotes keep a value literal in the env file: the signing key is JSON with double quotes.
  const lines = Object.entries(env.values).map(([key, value]) => `${key}='${value}'`);
  await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  const redact = (chunk: Buffer) => env.secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), chunk.toString());
  const worker = spawn(
    "npx",
    [
      "wrangler", "dev", "-c", "wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port),
      "--env-file", envFile, "--persist-to", join(tempDir, "state"), "--show-interactive-dev-session=false",
      "--assets", assets,
    ],
    // From apps/worker, the build's `cwd: "../.."` is the repository root whichever directory Wrangler
    // resolves it against (gn100's Wrangler resolves it against the process's working directory).
    { cwd: join(options.repoRoot, "apps", "worker"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true },
  );
  worker.stdout?.on("data", (chunk: Buffer) => log.write(redact(chunk)));
  worker.stderr?.on("data", (chunk: Buffer) => log.write(redact(chunk)));
  return worker;
}

export class LocalStack {
  readonly url: string;
  readonly prefix: string;
  readonly deployer: Deployer;
  readonly #options: StackOptions;
  readonly #double: GitHubDouble;
  readonly #log: WriteStream;
  readonly #tempDir: string;
  readonly #worker: ChildProcess;

  private constructor(fields: {
    readonly url: string;
    readonly options: StackOptions;
    readonly deployerToken: string;
    readonly double: GitHubDouble;
    readonly worker: ChildProcess;
    readonly log: WriteStream;
    readonly tempDir: string;
  }) {
    this.url = fields.url;
    this.prefix = fields.options.prefix;
    this.deployer = new Deployer(fields.url, fields.deployerToken);
    this.#options = fields.options;
    this.#double = fields.double;
    this.#worker = fields.worker;
    this.#log = fields.log;
    this.#tempDir = fields.tempDir;
  }

  /** Starts the double and `wrangler dev`, and resolves once the Worker answers /health. */
  static async start(options: StackOptions): Promise<LocalStack> {
    const tempDir = await mkdtemp(join(tmpdir(), "penguin-walkthrough-"));
    const assets = await snapshotDashboard(options.repoRoot, join(tempDir, "assets"));
    const double = await startGitHubDouble(options.login(options.owners[0] as string));
    const port = await freePort();
    const deployerToken = randomBytes(32).toString("base64url");
    const signing = await signingKey();
    const env: WorkerEnv = {
      values: {
        PENGUIN_DEPLOYER_TOKEN: deployerToken,
        PENGUIN_OP_SIGNING_KEY: signing,
        PENGUIN_REPO_PREFIX: options.prefix,
        PENGUIN_GITHUB_BASE_URL: double.url,
        GITHUB_OAUTH_CLIENT_ID: DOUBLE_CLIENT.clientId,
        GITHUB_OAUTH_CLIENT_SECRET: DOUBLE_CLIENT.clientSecret,
        PENGUIN_DASHBOARD_OWNERS: options.owners.map((owner) => `${options.login(owner)}:${owner}`).join(","),
        ...options.vars,
      },
      secrets: [deployerToken, signing],
    };
    const log = createWriteStream(options.logFile);
    const worker = await spawnWorker(options, tempDir, assets, port, env, log);
    const stack = new LocalStack({ url: `http://127.0.0.1:${port}`, options, deployerToken, double, worker, log, tempDir });
    await stack.#healthy();
    return stack;
  }

  async #healthy(): Promise<void> {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (this.#worker.exitCode !== null) {
        await this.stop();
        throw new Error(`wrangler dev exited with ${this.#worker.exitCode}; see ${this.#options.logFile}`);
      }
      const healthy = await fetch(`${this.url}/health`).then((response) => response.status === 200, () => false);
      if (healthy) return;
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error(`the Worker did not answer /health within 180 s; see ${this.#options.logFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async #stopWorker(): Promise<void> {
    const worker = this.#worker;
    if (worker.exitCode !== null || worker.pid === undefined) return;
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    process.kill(-worker.pid, "SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (worker.exitCode === null) process.kill(-worker.pid, "SIGKILL");
  }

  /**
   * Seeds the base repo with `sha` from the local repository `source`, as the deployer does once per
   * project: a short-lived write token issued with wrangler, handed to Git in its environment.
   */
  async seedBase(source: string, sha: string, branch: string): Promise<void> {
    const name = `${this.prefix}base`;
    const repo = await wranglerJson(this.#options.repoRoot, ["artifacts", "repos", "get", name, "--namespace", NAMESPACE]);
    const issued = await wranglerJson(this.#options.repoRoot, [
      "artifacts", "repos", "issue-token", name, "--namespace", NAMESPACE, "--scope", "write", "--ttl", "600",
    ]);
    const token: string | undefined = issued.plaintext ?? issued.token ?? issued.result?.plaintext;
    if (typeof token !== "string") throw new Error(`issue-token answered without a token (fields: ${Object.keys(issued).join(", ")})`);
    await runGit(source, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", repo.remote, `${sha}:refs/heads/${branch}`], {
      env: tokenEnvironment(token),
    });
  }

  /**
   * Stops the Worker and the double, deletes every repo under the prefix and the temporary folder.
   * The namespace is listed again after each round of deletes, up to five rounds, since a listing may
   * not hold every repo at once. Answers the repos deleted; `remaining` keeps the final listing under
   * the prefix, which is empty when the clean-up finished.
   */
  async stop(): Promise<string[]> {
    await bounded(30_000, () => this.#stopWorker());
    this.#log.end();
    await bounded(10_000, () => this.#double.close());
    await rm(this.#tempDir, { recursive: true, force: true });
    const deleted: string[] = [];
    let remaining = await retried(() => reposWithPrefix(this.#options.repoRoot, this.prefix));
    for (let round = 0; round < 5 && remaining.length > 0; round++) {
      for (const name of remaining) {
        await retried(() => deleteRepo(this.#options.repoRoot, name));
        deleted.push(name);
      }
      remaining = await retried(() => reposWithPrefix(this.#options.repoRoot, this.prefix));
    }
    this.remaining = remaining;
    return deleted;
  }

  /** The repos under the prefix the last listing in `stop` found; null before `stop`. */
  remaining: string[] | null = null;
}
