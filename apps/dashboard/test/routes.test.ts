import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRoute, signInProblem } from "../src/routes.ts";

test("each page path maps to its route and other paths to none", () => {
  assert.deepEqual(parseRoute("/"), { page: "inbox" });
  assert.deepEqual(parseRoute("/inbox"), { page: "inbox" });
  assert.deepEqual(parseRoute("/board"), { page: "board" });
  assert.deepEqual(parseRoute("/identities"), { page: "identities" });
  assert.deepEqual(parseRoute("/issues/40"), { page: "issue", issueId: "40" });
  for (const path of ["/issues/", "/issues/40/ops", "/board/", "/api/session", "/nowhere"]) {
    assert.equal(parseRoute(path), undefined, path);
  }
});

test("the sign-in problem comes from the Worker's signin parameter only", () => {
  assert.equal(signInProblem("?signin=no-owner"), "no-owner");
  assert.equal(signInProblem("?signin=failed"), "failed");
  assert.equal(signInProblem("?signin=other"), undefined);
  assert.equal(signInProblem(""), undefined);
});
