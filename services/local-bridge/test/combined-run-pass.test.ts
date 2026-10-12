import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  batchRuns,
  bridgeRemotes,
  claimCombinedRuns,
  combinedRunPass,
  forkFetcher,
  MemoryKeyStore,
  RemoteRefusedError,
  RemoteUnavailableError,
  runCli,
  type ClaimedCombinedRun,
  type ImpactAnalyzer,
  type TestRunner,
} from "@penguin/local-bridge";
import type { CombinedRunEvent, ImpactReport } from "@penguin/protocol";

import { FakePenguin } from "./fake-penguin.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

let root: string;
let repo: string;
let tags: Record<string, string>;
let main: string;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-combined-pass-")));
  repo = join(root, "fixture");
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  const pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as {
    branches: Record<string, string>;
    tags: Record<string, string>;
  };
  tags = pins.tags;
  main = pins.branches.main as string;
});

after(() => rm(root, { recursive: true, force: true }));

function run(runId: string, ownerId: string, commandIds: string[], trigger = "priya"): ClaimedCombinedRun {
  return {
    runId,
    trigger: { ownerId: trigger, sha: tags[`owner-${trigger}-checkpoint`] as string, baselineSha: main },
    target: ownerId,
    fork: `owner-${ownerId}`,
    ownerId,
    ownerCheckpoint: tags[`owner-${ownerId}-checkpoint`] as string,
    commandIds,
  };
}

test("a command ID the repository config does not define is refused and never runs", async () => {
  const started: string[] = [];
  const reported: CombinedRunEvent[] = [];
  // A runner that records any start; nothing may reach it.
  const runner = {
    run: async (request: { commandId: string }) => {
      started.push(request.commandId);
      throw new Error("no command may run");
    },
  } as unknown as TestRunner;
  const result = await combinedRunPass({
    claim: async () => [run("run-1", "jun", ["test:billing", "rm -rf /", "test:analytics; rm -rf /"])],
    report: async (event) => {
      reported.push(event);
      return { status: "no_failures" };
    },
    fetchForks: async () => undefined,
    repoPath: repo,
    runner,
  });
  assert.deepEqual(started, []);
  assert.deepEqual(reported, []);
  const [batch] = result.batches;
  assert.deepEqual(
    batch?.refused.map(({ runId, commandId }) => [runId, commandId]),
    [
      ["run-1", "test:billing"],
      ["run-1", "rm -rf /"],
      ["run-1", "test:analytics; rm -rf /"],
    ],
  );
  assert.match(batch?.refused[0]?.reason ?? "", /defines no such scope/);
  assert.equal(batch?.reply, null);
  assert.equal(batch?.error, null);
});

test("an owner the impact graph leaves out is reported as not affected, so the claimed run completes", async () => {
  const started: string[] = [];
  const reported: CombinedRunEvent[] = [];
  const runner = {
    run: async (request: { commandId: string; sha: string }) => {
      started.push(request.commandId);
      return { commandId: request.commandId, exitCode: 0, signal: null, log: "", timings: { createMs: 0, runMs: 0, removeMs: 0 } };
    },
  } as unknown as TestRunner;
  // Jun's checkpoint calls a changed symbol; Sam's uses nothing the change touches.
  const impact: ImpactAnalyzer = async (request) =>
    ({
      complete: true,
      forks: request.forks.map((fork) => ({
        ...fork,
        uses: fork.id === "jun" ? [{ path: "analytics/models.py", line: 1, kind: "import", symbol: "x", name: "x", scope: "analytics" }] : [],
        errors: [],
      })),
    }) as unknown as ImpactReport;
  const result = await combinedRunPass({
    claim: async () => [run("run-1", "jun", ["test:analytics"]), run("run-2", "sam", ["test:messaging"])],
    report: async (event) => {
      reported.push(event);
      return { status: "no_failures" };
    },
    fetchForks: async () => undefined,
    repoPath: repo,
    runner,
    impact,
  });
  assert.deepEqual(started, ["test:analytics"]);
  assert.deepEqual(
    reported[0]?.results.map((entry) => [entry.ownerId, entry.status, entry.ownerCheckpoint]),
    [
      ["jun", "passed", tags["owner-jun-checkpoint"]],
      ["sam", "not-affected", tags["owner-sam-checkpoint"]],
    ],
  );
  assert.deepEqual(result.batches[0]?.results.map((entry) => entry.status), ["passed", "not-affected"]);
});

test("runs of one trigger share a batch, with one checkpoint per owner in each", () => {
  const runs = [
    run("a", "jun", ["test:analytics"]),
    run("b", "sam", ["test:messaging"]),
    { ...run("c", "jun", ["test:analytics"]), ownerCheckpoint: main },
    run("d", "sam", ["test:messaging"], "jun"),
  ];
  assert.deepEqual(
    batchRuns(runs).map((batch) => batch.map((entry) => entry.runId)),
    [["a", "b"], ["c"], ["d"]],
  );
});

test("claiming posts with the bridge token and refuses a malformed or forbidden answer", async () => {
  let answer: { status: number; body: unknown } = { status: 200, body: { runs: [run("run-1", "jun", ["test:analytics"])] } };
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;

  assert.deepEqual(await claimCombinedRuns("https://penguin.example", "token-1", fetchStub), [run("run-1", "jun", ["test:analytics"])]);
  assert.equal(requests[0]?.url, "https://penguin.example/combined-runs/claim");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(requests[0]?.init?.headers, { Authorization: "Bearer token-1" });

  answer = { status: 403, body: { error: "forbidden" } };
  await assert.rejects(claimCombinedRuns("https://penguin.example", "token-1", fetchStub), RemoteRefusedError);
  answer = { status: 200, body: { runs: [{ ...run("run-1", "jun", []), ownerCheckpoint: "HEAD" }] } };
  await assert.rejects(claimCombinedRuns("https://penguin.example", "token-1", fetchStub), RemoteUnavailableError);
  answer = { status: 200, body: { runs: [{ ...run("run-1", "jun", []), commandIds: "test:analytics" }] } };
  await assert.rejects(claimCombinedRuns("https://penguin.example", "token-1", fetchStub), RemoteUnavailableError);
});

test("the runner fetches another owner's fork with a read token", async () => {
  const penguin = new FakePenguin(join(root, "artifacts"), "ci");
  penguin.role = "runner";
  await mkdir(join(root, "artifacts"));
  await penguin.start(["owner-jun"]);
  try {
    const checkpoint = tags["owner-jun-checkpoint"] as string;
    await runGit(repo, ["push", "--quiet", penguin.repoPath("owner-jun"), `${checkpoint}:refs/heads/main`]);
    const store = new MemoryKeyStore();
    const stateDir = join(root, "runner-state");
    const io = { write: () => undefined, ask: async () => "" };
    const args = ["register", "--server", penguin.origin, "--owner", "ci", "--code", penguin.code];
    assert.equal(await runCli(args, io, { keyStore: store, stateDir }), 0);
    const runnerRepo = join(root, "runner-repo");
    await mkdir(runnerRepo);
    await runGit(runnerRepo, ["init", "--quiet"]);

    // A write token on another owner's fork is refused; the runner asks for read.
    await assert.rejects(forkFetcher(bridgeRemotes(stateDir, store), runnerRepo)(["owner-jun"]), /write to owner-jun/);
    await forkFetcher(bridgeRemotes(stateDir, store, undefined, "read"), runnerRepo)(["owner-jun"]);
    assert.equal((await runGit(runnerRepo, ["rev-parse", "refs/penguin/owner-jun/main"])).trim(), checkpoint);
  } finally {
    await penguin.stop();
  }
});
