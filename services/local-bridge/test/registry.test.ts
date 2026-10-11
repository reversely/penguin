import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { WorktreeRegistry, parseWorktreeList } from "@penguin/local-bridge";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

let repo: FixtureRepo;

before(async () => {
  repo = await createFixtureRepo();
});

after(() => repo.cleanup());

function newRegistry(now = () => new Date("2026-10-10T12:00:00.000Z")) {
  return new WorktreeRegistry({ repoPath: repo.main, bridgeId: "bridge-1", ownerId: "owner-1", now });
}

async function headOf(cwd: string) {
  return (await repo.git(cwd, "rev-parse", "HEAD")).trim();
}

test("lists both added worktrees with their branch and head SHA", async (t) => {
  await repo.write(repo.worktreeB, "c.txt", "b's change\n");
  const headB = await repo.commitAll(repo.worktreeB, "edit c on b");
  const headA = await headOf(repo.worktreeA);

  const registry = newRegistry();
  const started = performance.now();
  const records = await registry.refresh();
  t.diagnostic(`registry refresh took ${(performance.now() - started).toFixed(1)} ms`);

  const byBranch = new Map(records.map((record) => [record.branch, record]));
  assert.equal(records.length, 3);
  assert.equal(byBranch.get("feature-a")?.head_sha, headA);
  assert.equal(byBranch.get("feature-b")?.head_sha, headB);
  assert.equal(byBranch.get("main")?.head_sha, await headOf(repo.main));
  for (const record of records) {
    assert.equal(record.baseline_sha, record.head_sha);
    assert.equal(record.last_seen, "2026-10-10T12:00:00.000Z");
    assert.equal(record.bridge_id, "bridge-1");
    assert.equal(record.owner_id, "owner-1");
  }
});

test("the serialized registry carries path hashes and no absolute path", async () => {
  const registry = newRegistry();
  await registry.refresh();
  const json = registry.serialize();

  assert.ok(!json.includes(repo.root), "serialized registry contains the fixture root path");
  for (const record of JSON.parse(json) as Array<Record<string, unknown>>) {
    assert.match(String(record.path_hash), /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(record).sort(), [
      "baseline_sha",
      "branch",
      "bridge_id",
      "head_sha",
      "id",
      "last_seen",
      "owner_id",
      "path_hash",
    ]);
  }
});

test("a pinned baseline survives refreshes while head and last_seen move", async () => {
  let clock = new Date("2026-10-10T12:00:00.000Z");
  const registry = newRegistry(() => clock);
  const first = await registry.refresh();
  const a = first.find((record) => record.branch === "feature-a");
  assert.ok(a);

  await repo.write(repo.worktreeA, "a.txt", "moved head\n");
  const newHead = await repo.commitAll(repo.worktreeA, "move a");
  clock = new Date("2026-10-10T12:05:00.000Z");
  await registry.refresh();

  const after = registry.get(a.id);
  assert.equal(after?.head_sha, newHead);
  assert.equal(after?.baseline_sha, a.head_sha);
  assert.equal(after?.last_seen, "2026-10-10T12:05:00.000Z");
  assert.deepEqual(await registry.changedPaths(a.id), ["a.txt"]);

  await registry.pinBaseline(a.id, newHead);
  assert.deepEqual(await registry.changedPaths(a.id), []);
  await assert.rejects(registry.pinBaseline(a.id, "f".repeat(40)));
  await assert.rejects(registry.pinBaseline(a.id, "HEAD"), /full object ID/);
});

test("a removed worktree drops out on the next refresh", async () => {
  const registry = newRegistry();
  await registry.refresh();
  await repo.git(repo.main, "worktree", "add", "--quiet", "-b", "temp", `${repo.root}/wt-temp`);
  assert.equal((await registry.refresh()).length, 4);
  await repo.git(repo.main, "worktree", "remove", `${repo.root}/wt-temp`);
  assert.deepEqual((await registry.refresh()).map((r) => r.branch).sort(), ["feature-a", "feature-b", "main"]);
});

test("parses porcelain -z output with bare, detached and prunable entries", () => {
  const sha = "1".repeat(40);
  const output = [
    "worktree /repo.git", "bare", "",
    "worktree /w/one", `HEAD ${sha}`, "branch refs/heads/feat/x", "",
    "worktree /w/two\nline", `HEAD ${sha}`, "detached", "locked reason", "",
    "worktree /w/gone", `HEAD ${sha}`, "branch refs/heads/old", "prunable gitdir file points to non-existent location", "",
  ].join("\0") + "\0";

  assert.deepEqual(parseWorktreeList(output), [
    { path: "/repo.git", headSha: null, branch: null, bare: true, prunable: false },
    { path: "/w/one", headSha: sha, branch: "feat/x", bare: false, prunable: false },
    { path: "/w/two\nline", headSha: sha, branch: null, bare: false, prunable: false },
    { path: "/w/gone", headSha: sha, branch: "old", bare: false, prunable: true },
  ]);
});
