import assert from "node:assert/strict";
import { test } from "node:test";

import { BOARD_ALL_PATH, INBOX_ALL_PATH, parseRoute, signInProblem } from "../src/routes.ts";

test("each page path maps to its route and other paths to none", () => {
  assert.deepEqual(parseRoute("/"), { page: "inbox", showAll: false });
  assert.deepEqual(parseRoute("/inbox"), { page: "inbox", showAll: false });
  assert.deepEqual(parseRoute("/board"), { page: "board", showAll: false });
  assert.deepEqual(parseRoute("/identities"), { page: "identities" });
  assert.deepEqual(parseRoute("/issues/40"), { page: "issue", issueId: "40" });
  assert.deepEqual(parseRoute("/issues/new"), { page: "new-issue" });
  for (const path of ["/issues/", "/issues/40/ops", "/board/", "/api/session", "/nowhere"]) {
    assert.equal(parseRoute(path), undefined, path);
  }
});

test("the full closed lists come from their own query parameter only", () => {
  const all = (path: string) => {
    const url = new URL(path, "https://penguin.test");
    return parseRoute(url.pathname, url.search);
  };
  assert.deepEqual(all(INBOX_ALL_PATH), { page: "inbox", showAll: true });
  assert.deepEqual(all("/?closed=all"), { page: "inbox", showAll: true });
  assert.deepEqual(all(BOARD_ALL_PATH), { page: "board", showAll: true });
  assert.deepEqual(all("/board?closed=all"), { page: "board", showAll: false });
  assert.deepEqual(all("/inbox?done=all"), { page: "inbox", showAll: false });
  assert.deepEqual(all("/inbox?closed=yes"), { page: "inbox", showAll: false });
});

test("the sign-in problem comes from the Worker's signin parameter only", () => {
  assert.equal(signInProblem("?signin=no-owner"), "no-owner");
  assert.equal(signInProblem("?signin=failed"), "failed");
  assert.equal(signInProblem("?signin=other"), undefined);
  assert.equal(signInProblem(""), undefined);
});
