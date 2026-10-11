import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { changedPathsBetween, commitMergedTree, runGit, simulateMerge } from "@penguin/git-analysis";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

let repo: FixtureRepo;
let base: string;
let editA: string;
let editB: string;
let clashA: string;

before(async () => {
  repo = await createFixtureRepo();
  base = (await repo.git(repo.main, "rev-parse", "HEAD")).trim();
  await repo.write(repo.worktreeA, "a.txt", "a from feature-a\n");
  editA = await repo.commitAll(repo.worktreeA, "edit a");
  await repo.write(repo.worktreeB, "b.txt", "b from feature-b\n");
  editB = await repo.commitAll(repo.worktreeB, "edit b");
  await repo.write(repo.worktreeB, "a.txt", "a from feature-b\n");
  clashA = await repo.commitAll(repo.worktreeB, "edit a differently");
});

after(() => repo.cleanup());

test("a clean merge returns the merged tree and leaves refs and worktrees alone", async () => {
  const refs = await runGit(repo.main, ["show-ref"]);
  const status = await Promise.all([repo.worktreeA, repo.worktreeB].map((wt) => runGit(wt, ["status", "--porcelain"])));

  const merge = await simulateMerge(repo.main, editA, editB);

  assert.equal(merge.kind, "clean");
  assert.equal(await runGit(repo.main, ["show", `${merge.tree}:a.txt`]), "a from feature-a\n");
  assert.equal(await runGit(repo.main, ["show", `${merge.tree}:b.txt`]), "b from feature-b\n");
  assert.equal(await runGit(repo.main, ["show-ref"]), refs);
  assert.deepEqual(
    await Promise.all([repo.worktreeA, repo.worktreeB].map((wt) => runGit(wt, ["status", "--porcelain"]))),
    status,
  );
});

test("conflicting edits are reported as a conflict with the conflicted paths", async () => {
  const merge = await simulateMerge(repo.main, editA, clashA);
  assert.equal(merge.kind, "conflict");
  assert.deepEqual(merge.kind === "conflict" && merge.conflictedPaths, ["a.txt"]);
});

test("an unknown commit or a non-object-ID is an error, not a conflict", async () => {
  await assert.rejects(simulateMerge(repo.main, editA, "0".repeat(40)), /not something we can merge/);
  for (const bad of ["HEAD", "--output=/tmp/x", "abc123"]) {
    await assert.rejects(simulateMerge(repo.main, editA, bad), /full object ID/);
  }
});

test("the merge commit for a tree and its parents has the same ID every time", async () => {
  const merge = await simulateMerge(repo.main, editA, editB);
  const first = await commitMergedTree(repo.main, merge.tree, [editA, editB]);
  const second = await commitMergedTree(repo.main, merge.tree, [editA, editB]);

  assert.equal(first, second);
  assert.equal((await runGit(repo.main, ["rev-parse", `${first}^{tree}`])).trim(), merge.tree);
  assert.equal((await runGit(repo.main, ["rev-list", "--parents", "-n", "1", first])).trim(), `${first} ${editA} ${editB}`);
  assert.notEqual(await commitMergedTree(repo.main, merge.tree, [editB, editA]), first);
});

test("changedPathsBetween lists the paths two commits differ in", async () => {
  assert.deepEqual(await changedPathsBetween(repo.main, base, clashA), ["a.txt", "b.txt"]);
  assert.deepEqual(await changedPathsBetween(repo.main, base, base), []);
  await assert.rejects(changedPathsBetween(repo.main, base, "HEAD"), /full object ID/);
});
