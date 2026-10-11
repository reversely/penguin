import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { changedPaths } from "@penguin/git-analysis";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

let repo: FixtureRepo;
let baseline: string;

before(async () => {
  repo = await createFixtureRepo();
  baseline = (await repo.git(repo.worktreeA, "rev-parse", "HEAD")).trim();
});

after(() => repo.cleanup());

test("an unchanged worktree has no changed paths", async () => {
  assert.deepEqual(await changedPaths(baseline, repo.worktreeA), []);
});

test("returns one committed and one uncommitted tracked edit, not untracked files", async (t) => {
  await repo.write(repo.worktreeA, "a.txt", "committed edit\n");
  await repo.commitAll(repo.worktreeA, "edit a");
  await repo.write(repo.worktreeA, "b.txt", "uncommitted edit\n");
  await repo.write(repo.worktreeA, "untracked.txt", "new\n");

  const started = performance.now();
  const paths = await changedPaths(baseline, repo.worktreeA);
  t.diagnostic(`changedPaths took ${(performance.now() - started).toFixed(1)} ms`);

  assert.deepEqual(paths, ["a.txt", "b.txt"]);
});

test("rejects a baseline that is not a full object ID", async () => {
  for (const bad of ["HEAD", "--output=/tmp/x", "abc123", ""]) {
    await assert.rejects(changedPaths(bad, repo.worktreeA), /full object ID/);
  }
});
