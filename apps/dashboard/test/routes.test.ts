import assert from "node:assert/strict";
import { test } from "node:test";

import { identityPath, issueAllPath, NAVIGATION, ORG_PATH, parseRoute, personPath, signInProblem, teamPath } from "../src/routes.ts";

test("each page path maps to its route and other paths to none", () => {
  assert.deepEqual(parseRoute("/"), { page: "team", team: null });
  assert.deepEqual(parseRoute("/org"), { page: "org" });
  assert.deepEqual(parseRoute("/teams/payments"), { page: "team", team: "payments" });
  assert.deepEqual(parseRoute("/teams/person:ines"), { page: "team", team: "person:ines" });
  assert.deepEqual(parseRoute("/people/ines"), { page: "person", person: "ines" });
  assert.deepEqual(parseRoute("/inbox"), { page: "inbox" });
  assert.deepEqual(parseRoute("/identities"), { page: "identities" });
  assert.deepEqual(parseRoute("/issues/40"), { page: "issue", issueId: "40", showAll: false });
  assert.deepEqual(parseRoute("/issues/new"), { page: "new-issue" });
  for (const path of ["/issues/", "/issues/40/ops", "/board/", "/api/session", "/nowhere", "/teams/", "/teams/Pay ments", "/teams/team:x", "/people/", "/people/a&b", "/org/x"]) {
    assert.equal(parseRoute(path), undefined, path);
  }
});

test("the viewer's team is home, the hierarchy has its paths and the retired board and person query still open", () => {
  assert.deepEqual(NAVIGATION.map((entry) => [entry.label, entry.path]), [
    ["Org", "/org"],
    ["Team", "/"],
    ["Inbox", "/inbox"],
    ["Identities", "/identities"],
  ]);
  const route = (path: string) => {
    const url = new URL(path, "https://penguin.test");
    return parseRoute(url.pathname, url.search);
  };
  assert.equal(ORG_PATH, "/org");
  assert.equal(personPath("jun"), "/people/jun");
  assert.deepEqual(route(personPath("jun")), { page: "person", person: "jun" });
  assert.equal(teamPath("person:ines"), "/teams/person:ines");
  assert.deepEqual(route(teamPath("payments")), { page: "team", team: "payments" });
  // A link from before people had their own path still opens the person.
  assert.deepEqual(route("/?person=jun"), { page: "person", person: "jun" });
  assert.deepEqual(route("/?person="), { page: "team", team: null });
  assert.deepEqual(route("/board?done=all"), { page: "team", team: null });
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
