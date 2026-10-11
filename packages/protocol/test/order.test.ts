import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareWithinCommit, coordinationOrder, readBaseVersion } from "../src/index.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("coordination order", () => {
  test("commits keep first-parent order; files in one commit sort by base_version, then path", () => {
    const order = coordinationOrder([
      {
        sha: "c1",
        files: [
          { path: "issues/33/ops/jun-web-0001.json", baseVersion: 1 },
          { path: "issues/33/ops/penguin-web-0001.json", baseVersion: 0 },
          { path: "issues/32/ops/jun-web-0002.json", baseVersion: 1 },
        ],
      },
      { sha: "c2", files: [{ path: "issues/31/ops/amy-web-0001.json", baseVersion: 0 }] },
    ]);
    assert.deepEqual(
      order.map(({ commit, file }) => `${commit} ${file.path}`),
      [
        "c1 issues/33/ops/penguin-web-0001.json",
        "c1 issues/32/ops/jun-web-0002.json",
        "c1 issues/33/ops/jun-web-0001.json",
        "c2 issues/31/ops/amy-web-0001.json",
      ],
    );
  });

  test("a file without a readable base_version sorts last within its commit", () => {
    const files = [
      { path: "issues/1/ops/a-web-0001.json", baseVersion: undefined },
      { path: "issues/1/ops/b-web-0001.json", baseVersion: 7 },
      { path: "issues/1/ops/c-web-0001.json", baseVersion: undefined },
    ];
    assert.deepEqual(
      [...files].sort(compareWithinCommit).map((file) => file.path),
      ["issues/1/ops/b-web-0001.json", "issues/1/ops/a-web-0001.json", "issues/1/ops/c-web-0001.json"],
    );
  });

  test("readBaseVersion reads only a non-negative integer from a JSON object", () => {
    assert.equal(readBaseVersion(bytes('{"base_version": 4}')), 4);
    assert.equal(readBaseVersion(bytes('{"base_version": -1}')), undefined);
    assert.equal(readBaseVersion(bytes('{"base_version": 1.5}')), undefined);
    assert.equal(readBaseVersion(bytes('{"base_version": "4"}')), undefined);
    assert.equal(readBaseVersion(bytes("[4]")), undefined);
    assert.equal(readBaseVersion(bytes("not json")), undefined);
    assert.equal(readBaseVersion(new Uint8Array([0xff, 0xfe])), undefined);
  });
});
