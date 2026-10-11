import assert from "node:assert/strict";
import { test } from "node:test";

import { identityPath, INBOX_ALL_PATH, NAVIGATION, parseRoute, personPath, signInProblem } from "../src/routes.ts";

test("each page path maps to its route and other paths to none", () => {
  assert.deepEqual(parseRoute("/"), { page: "team", person: null });
  assert.deepEqual(parseRoute("/inbox"), { page: "inbox", showAll: false });
  assert.deepEqual(parseRoute("/identities"), { page: "identities" });
  assert.deepEqual(parseRoute("/issues/40"), { page: "issue", issueId: "40" });
  assert.deepEqual(parseRoute("/issues/new"), { page: "new-issue" });
  for (const path of ["/issues/", "/issues/40/ops", "/board/", "/api/session", "/nowhere"]) {
    assert.equal(parseRoute(path), undefined, path);
  }
});

test("the team map is home, a person's view is its query and the retired board opens the team map", () => {
  assert.deepEqual(NAVIGATION.map((entry) => [entry.label, entry.path]), [
    ["Team", "/"],
    ["Inbox", "/inbox"],
    ["Identities", "/identities"],
  ]);
  const route = (path: string) => {
    const url = new URL(path, "https://penguin.test");
    return parseRoute(url.pathname, url.search);
  };
  assert.deepEqual(route(personPath("jun")), { page: "team", person: "jun" });
  assert.deepEqual(route(personPath("a&b c")), { page: "team", person: "a&b c" });
  assert.deepEqual(route("/?person="), { page: "team", person: null });
  assert.deepEqual(route("/board?done=all"), { page: "team", person: null });
  assert.equal(identityPath("identity-1"), "/identities?identity=identity-1");
  assert.equal(identityPath(null), "/identities");
});

test("the full closed list comes from its own query parameter only", () => {
  const all = (path: string) => {
    const url = new URL(path, "https://penguin.test");
    return parseRoute(url.pathname, url.search);
  };
  assert.deepEqual(all(INBOX_ALL_PATH), { page: "inbox", showAll: true });
  assert.deepEqual(all("/inbox?done=all"), { page: "inbox", showAll: false });
  assert.deepEqual(all("/inbox?closed=yes"), { page: "inbox", showAll: false });
});

test("the sign-in problem comes from the Worker's signin parameter only", () => {
  assert.equal(signInProblem("?signin=no-owner"), "no-owner");
  assert.equal(signInProblem("?signin=failed"), "failed");
  assert.equal(signInProblem("?signin=other"), undefined);
  assert.equal(signInProblem(""), undefined);
});
