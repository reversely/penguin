import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

import { runGit } from "@penguin/git-analysis";
import { signOperation } from "@penguin/issues";
import {
  bridgeSpool,
  CheckpointPublisher,
  drainSpool,
  loadSigningKey,
  MemoryKeyStore,
  RetryLoop,
  runCli,
  signingKeyAccount,
  Spool,
  WorktreeRegistry,
  type OwnerFork,
} from "@penguin/local-bridge";
import { formatOpId, OPERATION_SCHEMA_VERSION, operationPath } from "@penguin/protocol";

import { createFixtureRepo } from "../../../tests/fixtures/git-repo.ts";

const OWNER = "jun";
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let root: string;
let bare: string;
let away: string;
let stateDir: string;
let store: MemoryKeyStore;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-spool-")));
  bare = join(root, "issues.git");
  away = join(root, "issues.git.away");
  stateDir = join(root, "state");
  store = new MemoryKeyStore();
  await runGit(root, ["init", "--quiet", "--bare", "-b", "main", bare]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Phase 1 remotes are local paths, so moving the bare repo away makes the remote unreachable. */
const goOffline = () => rename(bare, away);
const goOnline = () => rename(away, bare);
const spool = () => bridgeSpool(stateDir);

async function issue(...args: string[]) {
  const out: string[] = [];
  const code = await runCli(
    ["issue", args[0]!, "--owner", OWNER, "--repo", bare, "--clone", join(root, "clone"), ...args.slice(1)],
    { write: (text) => out.push(text), ask: async () => "" },
    { keyStore: store, stateDir },
  );
  return { code, out: out.join("") };
}

/** Every operation file on the remote's main branch, with how many commits added each. */
async function remoteOps(): Promise<{ files: string[]; adds: Map<string, number> }> {
  const files = (await runGit(bare, ["ls-tree", "-r", "--name-only", "main", "issues/"]).catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .sort();
  const log = await runGit(bare, ["log", "--format=", "--name-only", "--diff-filter=A", "main"]).catch(() => "");
  const adds = new Map<string, number>();
  for (const path of log.split("\n").filter(Boolean)) adds.set(path, (adds.get(path) ?? 0) + 1);
  return { files, adds };
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Queues a create and two comments with the remote unreachable. */
async function queueThree(): Promise<string[]> {
  const paths = [];
  const created = await issue("create", "--title", "Queued while offline");
  assert.equal(created.code, 0, created.out);
  paths.push(queuedPath(created.out));
  for (const body of ["first", "second"]) {
    const comment = await issue("comment", "--issue", "jun-0001", "--body", body);
    assert.equal(comment.code, 0, comment.out);
    paths.push(queuedPath(comment.out));
  }
  return paths;
}

/** The `git` executable the bridge would run. */
function gitOnPath(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return assert.fail("git is not on PATH");
}

function queuedPath(out: string): string {
  return /^Queued (\S+) /m.exec(out)?.[1] ?? assert.fail(`not queued: ${out}`);
}

describe("an unreachable issues remote", () => {
  test("an issue command exits 0, reports the operation as queued and pushes nothing", async () => {
    await goOffline();
    const created = await issue("create", "--title", "Written on a plane");
    assert.equal(created.code, 0, created.out);
    assert.match(created.out, /^Queued issues\/jun-0001\/ops\/jun-0001\.json \(\d+ ms\): /m);
    assert.match(created.out, /spool drain\|watch/);

    // A follow-up on the queued issue counts the queued create in its base version.
    const comment = await issue("comment", "--issue", "jun-0001", "--body", "Still offline.");
    assert.equal(comment.code, 0, comment.out);
    const pending = await spool().pending();
    assert.deepEqual(
      pending.map((entry) => entry.id),
      ["jun-0001", "jun-0002"],
    );
    const [, second] = pending;
    assert.equal(second?.kind === "operation" && second.operation.base_version, 1);

    await goOnline();
    assert.deepEqual((await remoteOps()).files, []);
  });

  test("the spool file is created with mode 0600 and holds no secret", async () => {
    await goOffline();
    await queueThree();
    const info = await stat(spool().path);
    assert.equal(info.mode & 0o777, 0o600);
    const text = await readFile(spool().path, "utf8");
    const secret: string = JSON.parse((await store.get(signingKeyAccount(OWNER))) ?? "{}").d;
    assert.ok(secret.length > 20);
    assert.ok(!text.includes(secret), "the private key is in the spool");
    assert.ok(!/"d"\s*:/.test(text), "a JWK private member is in the spool");

    // A spool file someone widened is narrowed again on the next append.
    await chmod(spool().path, 0o644);
    await issue("comment", "--issue", "jun-0001", "--body", "third");
    assert.equal((await stat(spool().path)).mode & 0o777, 0o600);
  });

  test("the retry loop pushes queued operations once the remote is reachable, without owner action", async () => {
    await goOffline();
    const paths = await queueThree();
    const drains: number[] = [];
    const loop = new RetryLoop({
      spool: spool(),
      minDelayMs: 20,
      maxDelayMs: 80,
      idleDelayMs: 50,
      onDrain: (result) => drains.push(result.waiting.length),
    });
    loop.start();
    try {
      await waitFor(() => drains.length >= 2, "two drains while offline");
      assert.deepEqual((await remoteOps()).files, [], "nothing reaches a remote that is not there");
      await goOnline();
      await waitFor(async () => (await remoteOps()).files.length === 3, "the queued operations on the remote");
    } finally {
      await loop.stop();
    }
    const { files, adds } = await remoteOps();
    assert.deepEqual(files, [...paths].sort());
    for (const path of paths) assert.equal(adds.get(path), 1, path);
    assert.deepEqual(await spool().pending(), []);
    // One commit per operation, as when the remote was reachable all along.
    assert.equal((await runGit(bare, ["rev-list", "--count", "main"])).trim(), "3");
  });

  test("the next issue command pushes what was queued before it, in order", async () => {
    await goOffline();
    await queueThree();
    await goOnline();
    const label = await issue("label", "--issue", "jun-0001", "--label", "scope:analytics");
    assert.equal(label.code, 0, label.out);
    assert.match(label.out, /^Pushed issues\/jun-0001\/ops\/jun-0004\.json/m);
    const subjects = (await runGit(bare, ["log", "--reverse", "--format=%s", "main"])).trim().split("\n");
    assert.deepEqual(subjects, [
      "issue jun-0001: create jun-0001",
      "issue jun-0001: comment jun-0002",
      "issue jun-0001: comment jun-0003",
      "issue jun-0001: add_label jun-0004",
    ]);
  });
});

describe("a bridge killed during a push", () => {
  /**
   * Runs `penguin-bridge spool drain` in its own process group with a `git` wrapper first on PATH.
   * The wrapper signals at the push and hangs, so the test kills the whole group mid-push. With
   * `landed`, the real push completes before the wrapper hangs.
   */
  async function killDuringPush(landed: boolean): Promise<void> {
    const bin = join(root, "bin");
    const marker = join(root, "pushing");
    const realGit = gitOnPath();
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        "for arg in \"$@\"; do",
        "  if [ \"$arg\" = push ]; then",
        landed ? `    "${realGit}" "$@"` : "    :",
        `    : > "${marker}"`,
        "    exec sleep 30",
        "  fi",
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [CLI, "spool", "drain", "--state-dir", stateDir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await waitFor(() => existsSync(marker), "the bridge to reach the push");
    } finally {
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    }
  }

  for (const landed of [false, true]) {
    test(`each operation appears exactly once after a restart (push ${landed ? "landed" : "lost"})`, async () => {
      await goOffline();
      const paths = await queueThree();
      await goOnline();
      await killDuringPush(landed);

      assert.ok(existsSync(`${spool().path}.lock`), "the killed bridge left its lock behind");
      assert.equal((await spool().pending()).length, 3, "no acknowledgement was written before the kill");
      assert.equal((await remoteOps()).files.length, landed ? 3 : 0);

      // The restarted bridge takes over the stale lock and drains.
      const result = await drainSpool(spool());
      assert.deepEqual(result.waiting, []);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.pushed.map((item) => item.id).sort(), ["jun-0001", "jun-0002", "jun-0003"]);
      const { files, adds } = await remoteOps();
      assert.deepEqual(files, [...paths].sort());
      for (const path of paths) assert.equal(adds.get(path), 1, `${path} was added more than once`);
      assert.equal((await runGit(bare, ["rev-list", "--count", "main"])).trim(), "3");
      assert.deepEqual(await spool().pending(), []);

      // A further drain finds nothing to do.
      assert.deepEqual((await drainSpool(spool())).pushed, []);
    });
  }
});

describe("the spool file", () => {
  test("only grows: a drain of one hundred operations keeps every earlier byte", async () => {
    // Signed and spooled directly, as the issue command does offline, to keep the test fast.
    const key = await loadSigningKey(store, OWNER);
    for (let seq = 1; seq <= 100; seq++) {
      const opId = formatOpId({ person: OWNER }, seq);
      const operation = await signOperation(
        {
          schema_version: OPERATION_SCHEMA_VERSION,
          op_id: opId,
          issue: "jun-0001",
          type: seq === 1 ? "create" : "comment",
          author: { person: OWNER },
          base_version: seq - 1,
          payload: seq === 1 ? { title: "Bulk" } : { body: `comment ${seq}` },
        },
        key.privateKey,
      );
      await spool().enqueue({
        kind: "operation",
        id: opId,
        remote: bare,
        clone: join(root, "clone"),
        branch: "main",
        path: operationPath(operation),
        operation,
      });
    }
    const before = await readFile(spool().path);
    assert.equal((await spool().pending()).length, 100);

    const started = performance.now();
    const result = await drainSpool(spool());
    const elapsed = Math.round(performance.now() - started);
    // On failure, name why the drain held the operations back.
    assert.equal(result.pushed.length, 100, JSON.stringify([...result.waiting, ...result.failed][0]));
    // Recorded for the ticket's time check: one drain of 100 queued operations, local bare repo.
    process.stdout.write(`# spool drain of 100 queued operations (ms): ${elapsed}\n`);

    const after = await readFile(spool().path);
    assert.ok(after.length > before.length);
    assert.ok(after.subarray(0, before.length).equals(before), "a drain rewrote earlier spool bytes");
    assert.equal((await remoteOps()).files.length, 100);
    assert.equal((await runGit(bare, ["rev-list", "--count", "main"])).trim(), "100");
  });

  test("a line torn by a crash is skipped and the next entry starts on its own line", async () => {
    await goOffline();
    await issue("create", "--title", "Before the crash");
    await appendFile(spool().path, '{"v":1,"kind":"operation","id":"jun-00');
    const comment = await issue("comment", "--issue", "jun-0001", "--body", "after the crash");
    assert.equal(comment.code, 0, comment.out);
    assert.deepEqual(
      (await spool().pending()).map((entry) => entry.id),
      ["jun-0001", "jun-0002"],
    );
    await goOnline();
    assert.equal((await drainSpool(spool())).pushed.length, 2);
  });

  test("a lock held by a live process is waited for, not taken over", async () => {
    const shared = new Spool(join(root, "locked.jsonl"), { lockTimeoutMs: 100 });
    await writeFile(`${shared.path}.lock`, String(process.pid));
    await assert.rejects(shared.withLock(async () => undefined), /locked by process/);
  });
});

describe("a checkpoint push with the fork unreachable", () => {
  test("is queued after consent and pushed by a later drain", async () => {
    const repo = await createFixtureRepo();
    try {
      for (const [key, value] of [
        ["user.name", "Penguin Fixture"],
        ["user.email", "fixture@penguin.invalid"],
        ["commit.gpgsign", "false"],
        ["core.hooksPath", "/dev/null"],
      ]) {
        await repo.git(repo.main, "config", key!, value!);
      }
      const forkPath = join(repo.root, "owner-priya.git");
      const forkAway = `${forkPath}.away`;
      await repo.git(repo.root, "init", "--quiet", "--bare", forkPath);
      await repo.git(repo.main, "push", "--quiet", forkPath, "main");
      await rename(forkPath, forkAway);

      const registry = new WorktreeRegistry({ repoPath: repo.main, bridgeId: "bridge-1", ownerId: "priya" });
      const records = await registry.refresh();
      const id = records.find((record) => record.branch === "feature-a")?.id ?? assert.fail("no feature-a");
      await repo.write(repo.worktreeA, "a.txt", "offline edit\n");
      const fork: OwnerFork = {
        owner_id: "priya",
        project_id: "p",
        repo: forkPath,
        latest_checkpoint_sha: null,
        publishing_consent: "worktree",
      };
      const output: string[] = [];
      const checkpointSpool = new Spool(join(repo.root, "state", "spool.jsonl"));
      const publisher = new CheckpointPublisher({
        registry,
        fork,
        spool: checkpointSpool,
        write: (text) => output.push(text),
        confirm: async () => true,
      });

      const result = await publisher.publish(id);
      assert.equal(result.status, "queued");
      assert.match(output.join(""), /The fork is unreachable, so every tracked file is listed/);
      assert.match(output.join(""), /^Queued [0-9a-f]{40} for refs\/heads\/feature-a: /m);
      assert.equal(fork.latest_checkpoint_sha, null);
      const [entry] = await checkpointSpool.pending();
      assert.equal(entry?.kind, "checkpoint");

      await rename(forkAway, forkPath);
      const drained = await drainSpool(checkpointSpool);
      assert.deepEqual(drained.pushed.map((item) => item.id), [entry!.id]);
      assert.equal(await repo.git(forkPath, "show", "refs/heads/feature-a:a.txt"), "offline edit\n");
      // Draining again does not push a second time.
      assert.deepEqual((await drainSpool(checkpointSpool)).pushed, []);
    } finally {
      await repo.cleanup();
    }
  });
});

test("the drain command reports what it pushed", async () => {
  await goOffline();
  await queueThree();
  await goOnline();
  const out: string[] = [];
  const code = await runCli(["spool", "drain"], { write: (text) => out.push(text), ask: async () => "" }, { stateDir });
  assert.equal(code, 0);
  assert.match(out.join(""), /^3 pushed, 0 queued, 0 failed\.$/m);
});
