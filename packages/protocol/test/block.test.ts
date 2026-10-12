// What reaches Git from a block run (#96): run ids, branch names and object IDs are checked here
// before any request names them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { blockRunId, featureOfBlockRun, isBranchName, OBJECT_ID } from "../src/block.ts";

describe("block run names", () => {
  test("a run id is a feature id and a number, and nothing else parses as one", () => {
    assert.equal(blockRunId("money-minor", 3), "money-minor/3");
    assert.equal(featureOfBlockRun("money-minor/3"), "money-minor");
    for (const bad of ["money-minor", "money-minor/0", "Money/1", "../base/1", "a/1/2", "a/1\n", 3, null, `${"a".repeat(80)}/1`]) {
      assert.equal(featureOfBlockRun(bad), undefined, String(bad));
    }
  });

  test("main's branch name and the commits are refs Git reads as data", () => {
    for (const good of ["main", "trunk", "release/2026.10", "team_a/main-1"]) assert.equal(isBranchName(good), true, good);
    for (const bad of ["", "-main", "main..x", "a//b", "main/", "main.lock", "main;rm -rf /", "main\nx", "ma in", "@{1}", "refs/../x", 7]) {
      assert.equal(isBranchName(bad), false, String(bad));
    }
    assert.equal(OBJECT_ID.test("a".repeat(40)), true);
    for (const bad of ["HEAD", "A".repeat(40), "a".repeat(39), `${"a".repeat(40)}\n`]) assert.equal(OBJECT_ID.test(bad), false, bad);
  });
});
