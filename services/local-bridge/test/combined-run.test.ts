import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  CombinedRunner,
  lockfileHash,
  parseFailingTests,
  TestRunner,
  type CombinedRunReport,
  type ConsentRequest,
} from "@penguin/local-bridge";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
// The fixture's commands call `python -m pytest`; the uv environment provides both (T8).
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

const worktreeList = (cwd: string) => runGit(cwd, ["worktree", "list", "--porcelain"]);

/** Hashes every file under a worktree. In a main checkout `.git/` is skipped except HEAD and the index. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name));
    if (path.startsWith(".git/") && path !== ".git/HEAD" && path !== ".git/index") continue;
    hashes.set(path, createHash("sha256").update(await readFile(join(root, path))).digest("hex"));
  }
  return hashes;
}

/**
 * Runs `body` with outbound connections and `fetch` replaced by recorders that refuse, and
 * returns what was attempted. Covers this process only; Git and pytest run as child processes.
 */
async function withoutNetwork<T>(body: () => Promise<T>): Promise<{ value: T; attempts: string[] }> {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    attempts.push(`connect ${JSON.stringify(args[0])}`);
    throw new Error("network access during a combined run");
  } as typeof connect;
  globalThis.fetch = (input) => {
    attempts.push(`fetch ${String(input)}`);
    return Promise.reject(new Error("network access during a combined run"));
  };
  try {
    return { value: await body(), attempts };
  } finally {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = originalFetch;
  }
}

const failing = (report: CombinedRunReport) =>
  report.results.flatMap((result) => (result.status === "failed" ? result.failingTests.map((t) => t.testId) : []));

describe("on the identity-unification fixture", () => {
  let root: string;
  let repo: string;
  let scratch: string;
  let pins: Record<string, string>;
  const ownerWorktrees: string[] = [];

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-combined-fixture-")));
    repo = join(root, "main");
    // The bridge's own directory: the only place a merged tree is checked out.
    scratch = join(root, "bridge");
    await mkdir(scratch);
    await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
    pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")).branches;
    // Each owner's checkpoint checked out in its own worktree, as on the owners' machines.
    for (const owner of ["owner-priya", "owner-jun", "owner-sam"]) {
      const worktree = join(root, owner);
      await runGit(repo, ["worktree", "add", "--quiet", worktree, owner]);
      ownerWorktrees.push(worktree);
    }
  });

  after(() => rm(root, { recursive: true, force: true }));

  const combinedRun = (asked: ConsentRequest[]) =>
    new CombinedRunner({
      repoPath: repo,
      runner: new TestRunner({
        repoPath: repo,
        env: TEST_ENV,
        scratchDir: scratch,
        consent: (request) => {
          asked.push(request);
          return true;
        },
      }),
    }).run({
      checkpointSha: pins["owner-priya"] as string,
      baselineSha: pins.main as string,
      latestCheckpoints: { jun: pins["owner-jun"] as string, sam: pins["owner-sam"] as string },
    });

  test("Priya's checkpoint with Jun's and Sam's fails exactly the three fixture tests", async (t) => {
    const worktreesBefore = await worktreeList(repo);
    const snapshots = await Promise.all([repo, ...ownerWorktrees].map(snapshot));
    const asked: ConsentRequest[] = [];

    const started = performance.now();
    const { value: report, attempts } = await withoutNetwork(() => combinedRun(asked));
    t.diagnostic(`full combined run took ${(performance.now() - started).toFixed(0)} ms`);

    assert.deepEqual(report.changedScopes, ["identity-map"]);
    assert.deepEqual(
      report.results.map((r) => [r.scopeId, r.ownerId, r.status]),
      [
        ["analytics", "jun", "failed"],
        ["messaging", "sam", "failed"],
      ],
    );
    assert.deepEqual(failing(report).sort(), [
      "test_consent::unsubscribe_survives",
      "test_identity::shared_device_split",
      "test_retention::dau_stable",
    ]);
    assert.deepEqual(attempts, []);
    assert.deepEqual(
      asked.map((request) => request.commandId),
      ["test:analytics", "test:messaging"],
    );
    for (const result of report.results) {
      assert.ok(result.status === "failed");
      assert.equal(result.fingerprint.commit, result.mergedCommit);
      assert.equal(result.fingerprint.commandId, result.commandId);
      assert.equal(result.fingerprint.lockfileHash, await lockfileHash(repo, result.mergedCommit));
      const parents = (await runGit(repo, ["rev-list", "--parents", "-n", "1", result.mergedCommit])).trim();
      assert.equal(parents, `${result.mergedCommit} ${pins["owner-priya"]} ${result.ownerCheckpoint}`);
    }
    // Merged trees were checked out only under the bridge's directory, and removed afterwards.
    assert.equal(await worktreeList(repo), worktreesBefore);
    assert.deepEqual(await Promise.all([repo, ...ownerWorktrees].map(snapshot)), snapshots);
    assert.deepEqual(await readdir(scratch), []);
  });

  test("running the same inputs twice returns the same fingerprints", async () => {
    const fingerprints = async () =>
      (await combinedRun([])).results.map((r) => (r.status === "failed" ? r.fingerprint : r.status));
    const first = await fingerprints();
    assert.deepEqual(await fingerprints(), first);
    assert.equal(new Set(first.map((f) => (typeof f === "string" ? f : f.id))).size, 2);
  });
});

describe("on a scratch repository", () => {
  let repo: FixtureRepo;
  let scratch: string;
  let base: string;
  let provider: string;
  let clash: string;
  let clean: string;

  const scopes = {
    scopes: [
      { id: "core", name: "core", owner: "ana", paths: ["core/"], test_command: "exit 0", depends_on: [] },
      ...["app", "web"].map((id, index) => ({
        id,
        name: id,
        owner: ["ben", "cy"][index],
        paths: [`${id}/`],
        test_command: "exit 0",
        depends_on: [{ scope: "core", kind: "imports" }],
      })),
    ],
  };

  before(async () => {
    repo = await createFixtureRepo();
    scratch = await realpath(await mkdtemp(join(tmpdir(), "penguin-scratch-")));
    for (const dir of ["penguin", "core", "app"]) await mkdir(join(repo.main, dir));
    await repo.write(repo.main, "penguin/scopes.json", JSON.stringify(scopes));
    await repo.write(repo.main, "core/lib.txt", "v1\n");
    await repo.write(repo.main, "app/readme.txt", "app\n");
    base = await repo.commitAll(repo.main, "scopes");
    for (const wt of [repo.worktreeA, repo.worktreeB]) await repo.git(wt, "reset", "--quiet", "--hard", base);
    await repo.write(repo.worktreeA, "core/lib.txt", "v2 from ana\n");
    provider = await repo.commitAll(repo.worktreeA, "ana changes core");
    await repo.write(repo.worktreeB, "app/main.txt", "app\n");
    clean = await repo.commitAll(repo.worktreeB, "ben adds app");
    await repo.write(repo.worktreeB, "core/lib.txt", "v2 from ben\n");
    clash = await repo.commitAll(repo.worktreeB, "ben edits core too");
  });

  after(() => Promise.all([repo.cleanup(), rm(scratch, { recursive: true, force: true })]));

  const runner = (asked: ConsentRequest[]) =>
    new CombinedRunner({
      repoPath: repo.main,
      runner: new TestRunner({
        repoPath: repo.main,
        scratchDir: scratch,
        consent: (request) => {
          asked.push(request);
          return true;
        },
      }),
    });

  test("a merge with conflicting edits is a conflict and runs no tests", async () => {
    const asked: ConsentRequest[] = [];
    const report = await runner(asked).run({ checkpointSha: provider, baselineSha: base, latestCheckpoints: { ben: clash } });

    assert.deepEqual(report.results, [
      { ownerId: "ben", scopeId: "app", commandId: "test:app", status: "conflict", ownerCheckpoint: clash, conflictedPaths: ["core/lib.txt"] },
      { ownerId: "cy", scopeId: "web", commandId: "test:web", status: "no-checkpoint" },
    ]);
    assert.deepEqual(asked, []);
    assert.deepEqual(await readdir(scratch), []);
  });

  test("a clean merge whose tests exit 0 is a pass with a fingerprint", async () => {
    const report = await runner([]).run({ checkpointSha: provider, baselineSha: base, latestCheckpoints: { ben: clean } });
    const [app] = report.results;
    assert.equal(app?.status, "passed");
    assert.ok(app?.status === "passed");
    assert.deepEqual(app.failingTests, []);
    assert.match(app.fingerprint.id, /^[0-9a-f]{64}$/);
  });

  test("the lockfile hash changes with a committed lockfile at any depth", async () => {
    const without = await lockfileHash(repo.main, base);
    await repo.write(repo.main, "app/uv.lock", "version = 1\n");
    const withLock = await repo.commitAll(repo.main, "add a lockfile");
    await repo.write(repo.main, "app/notes.txt", "not a lockfile\n");
    const unrelated = await repo.commitAll(repo.main, "add notes");

    assert.notEqual(await lockfileHash(repo.main, withLock), without);
    assert.equal(await lockfileHash(repo.main, unrelated), await lockfileHash(repo.main, withLock));
  });
});

test("parseFailingTests reads pytest's short summary into node IDs and PRD test IDs", () => {
  const log = [
    "=========================== short test summary info ============================",
    "FAILED analytics/tests/test_identity.py::test_shared_device_split - AssertionError: assert 1 == 3",
    "FAILED analytics/tests/test_retention.py::test_dau_stable",
    "FAILED analytics/tests/test_retention.py::test_dau_stable",
    "1 failed, 6 passed in 0.05s",
  ].join("\n");
  assert.deepEqual(parseFailingTests(log), [
    { nodeId: "analytics/tests/test_identity.py::test_shared_device_split", testId: "test_identity::shared_device_split" },
    { nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" },
  ]);
});

test("the bridge depends on no model-provider package", async () => {
  const MODEL_PROVIDER = /anthropic|openai|@google\/(?:genai|generative-ai)|mistral|cohere|ollama|langchain|@ai-sdk|^ai$/i;
  const seen = new Set<string>();
  const visit = async (packageJson: string): Promise<void> => {
    const manifest = JSON.parse(await readFile(packageJson, "utf8"));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (seen.has(name)) continue;
      seen.add(name);
      await visit(join(REPO_ROOT, "node_modules", name, "package.json"));
    }
  };
  await visit(join(REPO_ROOT, "services", "local-bridge", "package.json"));

  assert.ok(seen.has("@penguin/git-analysis"));
  assert.deepEqual([...seen].filter((name) => MODEL_PROVIDER.test(name)), []);
});
