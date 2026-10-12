import assert from "node:assert/strict";
import { test } from "node:test";

import { identityPath, issueAllPath, NAVIGATION, parseRoute, personPath, signInProblem } from "../src/routes.ts";

test("each page path maps to its route and other paths to none", () => {
  assert.deepEqual(parseRoute("/"), { page: "team", person: null });
  assert.deepEqual(parseRoute("/inbox"), { page: "inbox" });
  assert.deepEqual(parseRoute("/identities"), { page: "identities" });
  assert.deepEqual(parseRoute("/issues/40"), { page: "issue", issueId: "40", showAll: false });
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

test("the full closed list beside an issue comes from its own query parameter only", () => {
  const all = (path: string) => {
    const url = new URL(path, "https://penguin.test");
    return parseRoute(url.pathname, url.search);
  };
  assert.deepEqual(all(issueAllPath("40")), { page: "issue", issueId: "40", showAll: true });
  assert.deepEqual(all("/issues/40?done=all"), { page: "issue", issueId: "40", showAll: false });
  assert.deepEqual(all("/issues/40?closed=yes"), { page: "issue", issueId: "40", showAll: false });
  // The inbox holds the approvals only, so it takes no list parameter.
  assert.deepEqual(all("/inbox?closed=all"), { page: "inbox" });
});

test("the sign-in problem comes from the Worker's signin parameter only", () => {
  assert.equal(signInProblem("?signin=no-owner"), "no-owner");
  assert.equal(signInProblem("?signin=failed"), "failed");
  assert.equal(signInProblem("?signin=other"), undefined);
  assert.equal(signInProblem(""), undefined);
});
