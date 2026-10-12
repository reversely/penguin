/**
 * The check runner fetching many forks into one repository from real Artifacts (issue #119). Over Git
 * protocol v1, each fetch failed with `fetch-pack: protocol error: bad band #78` once the runner's
 * repository held 14 forks; the runner now fetches over protocol v2 and pushes over v1.
 *
 * The Worker runs under local `wrangler dev` with every repo under a prefix unique to the run. Project
 * setup forks one repo per owner from the base repo, which holds the money-minor-units fixture's main,
 * as Penguin forks every fork. Each fork then gets one of the fixture's feature branches, pushed with
 * the bridge's push options. The runner fetches the base repo and every fork with read tokens into one
 * repository through `fetchRepoBranches`, the function every runner job fetches with, then fetches them
 * all again as its next pass does. The test prints each fetch's time and deletes every repo it made.
 * Tokens stay in memory and reach Git through the environment only. Skipped unless
 * PENGUIN_FETCH_E2E=1; docs/bridge-and-runner.md says how to run it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  ARTIFACTS_PUSH_OPTIONS,
  fetchedBranch,
  fetchRepoBranches,
  penguinRepoOf,
  tokenEnvironment,
  tokenRemote,
  type RemoteResolver,
} from "@penguin/local-bridge";

import { LocalStack, NAMESPACE, reposWithPrefix, retried, wranglerJson } from "../walkthrough/support/stack.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "money-minor-units");
const PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const FORKS = Number(process.env.PENGUIN_FETCH_E2E_FORKS ?? "20");
const RUN_ID = randomBytes(3).toString("hex");
const PREFIX = `p119-${RUN_ID}-`;
const OUT = process.env.PENGUIN_FETCH_E2E_OUT ?? join(tmpdir(), `penguin-fetch-e2e-${RUN_ID}`);

interface Grant {
  readonly token: string;
  readonly remote: string;
}

/** A token of `scope` on the repo `repo` under the run's prefix, with its remote; kept in memory only. */
async function issueToken(repo: string, scope: "read" | "write"): Promise<Grant> {
  const name = `${PREFIX}${repo}`;
  const got = await wranglerJson(REPO_ROOT, ["artifacts", "repos", "get", name, "--namespace", NAMESPACE]);
  const issued = await wranglerJson(REPO_ROOT, ["artifacts", "repos", "issue-token", name, "--namespace", NAMESPACE, "--scope", scope, "--ttl", "1800"]);
  const token: unknown = issued.plaintext ?? issued.token ?? issued.result?.plaintext;
  if (typeof token !== "string") throw new Error(`issue-token answered without a token (fields: ${Object.keys(issued).join(", ")})`);
  return { token, remote: got.remote };
}

/** Fetches every repo into `repoPath` in order and returns each fetch's time in milliseconds. */
async function fetchAll(repoPath: string, remotes: RemoteResolver, repos: readonly string[]): Promise<number[]> {
  const times: number[] = [];
  for (const repo of repos) {
    const started = performance.now();
    await fetchRepoBranches(repoPath, remotes, repo);
    times.push(Math.round(performance.now() - started));
  }
  return times;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

test(`the runner fetches ${FORKS} forks from Artifacts into one repository`, { skip: process.env.PENGUIN_FETCH_E2E !== "1", timeout: 60 * 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "penguin-fetch-e2e-"));
  await mkdir(OUT, { recursive: true });
  const fixture = join(root, "fixture");
  await run(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  const pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as { branches: Record<string, string> };
  const branches = Object.keys(pins.branches).filter((branch) => branch.startsWith("feature-")).sort();
  assert.ok(branches.length >= FORKS, `the fixture has ${branches.length} feature branches`);
  const owners = Array.from({ length: FORKS }, (_, i) => `o${String(i).padStart(2, "0")}`);
  const forks = owners.map((owner) => `owner-${owner}`);

  const stack = await LocalStack.start({ repoRoot: REPO_ROOT, prefix: PREFIX, owners, login: (owner) => `${owner}-gh`, logFile: join(OUT, "worker.log") });
  try {
    // The base repo first, then its fork per owner once it holds main.
    await stack.deployer.setUp(owners);
    await stack.seedBase(fixture, pins.branches["main"] as string, "main");
    const setup = await stack.deployer.setUp(owners);
    assert.equal(setup.complete, true, JSON.stringify(setup.repos));

    const pushStarted = performance.now();
    const tips = new Map<string, string>();
    for (const [index, fork] of forks.entries()) {
      const branch = branches[index] as string;
      const grant = await retried(() => issueToken(fork, "write"));
      await runGit(fixture, [...ARTIFACTS_PUSH_OPTIONS, "push", "--quiet", "--end-of-options", grant.remote, `${pins.branches[branch]}:refs/heads/${branch}`], {
        env: tokenEnvironment(grant.token),
      });
      tips.set(fork, `${branch} ${pins.branches[branch]}`);
    }
    const pushMs = Math.round(performance.now() - pushStarted);

    // The runner reaches each repo with a read token, as `penguin:<repo>`.
    const repos = ["base", ...forks];
    const grants = new Map<string, Grant>();
    for (const repo of repos) grants.set(repo, await retried(() => issueToken(repo, "read")));
    const remotes: RemoteResolver = (name) => tokenRemote(name, grants.get(penguinRepoOf(name) as string) as Grant);
    const runnerRepo = join(root, "runner");
    await runGit(root, ["init", "--quiet", runnerRepo]);

    const first = await fetchAll(runnerRepo, remotes, repos);
    for (const fork of forks) {
      const [branch, sha] = (tips.get(fork) as string).split(" ") as [string, string];
      assert.equal(await fetchedBranch(runnerRepo, fork, branch), sha);
      assert.equal(await fetchedBranch(runnerRepo, fork, "main"), pins.branches["main"]);
    }
    const again = await fetchAll(runnerRepo, remotes, repos);

    const timings = { forks: FORKS, pushMs, firstPassMs: sum(first), secondPassMs: sum(again), first, again };
    console.log(JSON.stringify(timings));
  } finally {
    const deleted = await stack.stop();
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ deleted: deleted.length }));
  }
  assert.deepEqual(await retried(() => reposWithPrefix(REPO_ROOT, PREFIX)), [], "repos under the run's prefix remain");
});
