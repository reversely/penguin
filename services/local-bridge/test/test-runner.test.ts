import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import {
  childEnvironment,
  ConsentRefusedError,
  resolveCommand,
  TestRunner,
  UnknownCommandError,
  type ConsentRequest,
} from "@penguin/local-bridge";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILDER = join(REPO_ROOT, "examples", "identity-unification", "build.py");
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

async function newScratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "penguin-scratch-")));
}

function scopesJson(commands: Record<string, string>): string {
  const scopes = Object.entries(commands).map(([id, command]) => ({
    id,
    name: id,
    owner: "owner-1",
    paths: [`${id}/`],
    test_command: command,
    depends_on: [],
  }));
  return `${JSON.stringify({ scopes }, null, 2)}\n`;
}

describe("on the identity-unification fixture", () => {
  let root: string;
  let main: string;
  let ownerWorktree: string;
  let sha: string;
  let scratch: string;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-run-fixture-")));
    main = join(root, "main");
    ownerWorktree = join(root, "jun-reports");
    const { stdout } = await promisify(execFile)(PYTHON, [BUILDER, main]);
    sha = /^main ([0-9a-f]{40})$/m.exec(stdout)?.[1] ?? assert.fail(`no main SHA in ${stdout}`);
    // An owner worktree with work in progress, which a run must leave untouched.
    await runGit(main, ["worktree", "add", "--quiet", "-b", "jun/reports", ownerWorktree]);
    await mkdir(join(ownerWorktree, "notes"));
    await promisify(execFile)("sh", ["-c", "echo draft > notes/wip.txt; echo '# edit' >> analytics/models.py"], {
      cwd: ownerWorktree,
    });
    scratch = await newScratch();
  });

  after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(scratch, { recursive: true, force: true })]));

  test("runs the analytics test ID in an isolated worktree and returns exit status and log", async (t) => {
    const before = await worktreeList(main);
    const snapshots = await Promise.all([snapshot(main), snapshot(ownerWorktree)]);
    const asked: ConsentRequest[] = [];
    const runner = new TestRunner({
      repoPath: ownerWorktree,
      env: TEST_ENV,
      scratchDir: scratch,
      consent: (request) => {
        asked.push(request);
        return true;
      },
    });

    const result = await runner.run({ commandId: "test:analytics", sha });
    t.diagnostic(
      `worktree create ${result.timings.createMs.toFixed(1)} ms, ` +
        `run ${result.timings.runMs.toFixed(1)} ms, remove ${result.timings.removeMs.toFixed(1)} ms`,
    );

    assert.equal(result.exitCode, 0, result.log);
    assert.equal(result.signal, null);
    assert.equal(result.command, "python -m pytest analytics");
    assert.match(result.log, /passed/);
    assert.deepEqual(asked, [
      { action: "create-worktree-and-run", commandId: "test:analytics", scopeId: "analytics", sha, command: result.command },
    ]);
    assert.equal(await worktreeList(main), before);
    assert.deepEqual(await Promise.all([snapshot(main), snapshot(ownerWorktree)]), snapshots);
    assert.deepEqual(await readdir(scratch), []);
  });

  test("refusing consent creates no worktree", async () => {
    const before = await worktreeList(main);
    const runner = new TestRunner({ repoPath: main, env: TEST_ENV, scratchDir: scratch, consent: () => false });

    await assert.rejects(runner.run({ commandId: "test:analytics", sha }), ConsentRefusedError);
    assert.equal(await worktreeList(main), before);
    assert.deepEqual(await readdir(scratch), []);
  });

  test("an ID absent from the config is refused before consent or any worktree", async () => {
    const before = await worktreeList(main);
    let asked = 0;
    const runner = new TestRunner({
      repoPath: main,
      env: TEST_ENV,
      scratchDir: scratch,
      consent: () => {
        asked += 1;
        return true;
      },
    });

    for (const commandId of ["test:billing", "analytics", "python -m pytest analytics", "test:../x"]) {
      await assert.rejects(runner.run({ commandId, sha }), UnknownCommandError, commandId);
    }
    assert.equal(asked, 0);
    assert.equal(await worktreeList(main), before);
    assert.deepEqual(await readdir(scratch), []);
  });
});

describe("on a scratch repository", () => {
  let repo: FixtureRepo;
  let scratch: string;
  let first: string;
  let second: string;

  before(async () => {
    repo = await createFixtureRepo();
    scratch = await newScratch();
    await mkdir(join(repo.main, "penguin"));
    await repo.write(repo.main, "penguin/scopes.json", scopesJson({ app: "echo first", env: "env", fails: "exit 3" }));
    first = await repo.commitAll(repo.main, "config one");
    await repo.write(repo.main, "penguin/scopes.json", scopesJson({ app: "echo second" }));
    second = await repo.commitAll(repo.main, "config two");
    // An uncommitted edit that a run must ignore.
    await repo.write(repo.main, "penguin/scopes.json", scopesJson({ app: "echo dirty" }));
  });

  after(() => Promise.all([repo.cleanup(), rm(scratch, { recursive: true, force: true })]));

  const runner = (env: NodeJS.ProcessEnv = process.env) =>
    new TestRunner({ repoPath: repo.main, env, scratchDir: scratch, consent: () => true });

  test("the command comes from the config at the pinned commit only", async () => {
    assert.equal((await runner().run({ commandId: "test:app", sha: first })).log, "first\n");
    assert.equal((await runner().run({ commandId: "test:app", sha: second })).log, "second\n");
    await assert.rejects(resolveCommand(repo.main, second, "test:env"), UnknownCommandError);
    await assert.rejects(resolveCommand(repo.main, "HEAD", "test:app"), /full object ID/);
  });

  test("a failing command reports its exit status", async () => {
    const result = await runner().run({ commandId: "test:fails", sha: first });
    assert.equal(result.exitCode, 3);
    assert.deepEqual(await readdir(scratch), []);
  });

  test("the child environment excludes Penguin and Artifacts tokens", async () => {
    const env = {
      ...process.env,
      PENGUIN_TOKEN: "penguin-secret",
      PENGUIN_BRIDGE_TOKEN: "bridge-secret",
      ARTIFACTS_TOKEN: "artifacts-secret",
      artifacts_repo_token: "lowercase-secret",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret",
      KEEP_ME: "kept",
    };
    const { log, exitCode } = await runner(env).run({ commandId: "test:env", sha: first });

    assert.equal(exitCode, 0);
    assert.match(log, /^KEEP_ME=kept$/m);
    assert.doesNotMatch(log, /secret/);
    const leaked = Object.values(childEnvironment(env)).filter((value) => value?.endsWith("-secret"));
    assert.deepEqual(leaked, []);
  });
});
