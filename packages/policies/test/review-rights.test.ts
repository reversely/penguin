import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fixApproval, fixHead, labelledScopes, reviewOwners, reviewRight, type ReviewRecord } from "@penguin/policies";
import { parseScopeMap } from "@penguin/scope-map";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(new URL("../../../examples/identity-unification/base/penguin/scopes.json", import.meta.url), "utf8"),
  ),
);

test("labelledScopes reads scope:<id> labels only, once each", () => {
  assert.deepEqual(labelledScopes(["huddle", "scope:analytics", "scope:messaging", "scope:analytics"]), [
    "analytics",
    "messaging",
  ]);
});

test("the owner of a labelled scope may review", () => {
  const right = reviewRight({ person: "priya" }, ["scope:identity-map", "scope:analytics"], scopeMap);
  assert.deepEqual(right, { allowed: true, owner: "priya", scopes: ["identity-map"], countsFor: ["priya"] });
});

test("an owner of no labelled scope may not review", () => {
  const right = reviewRight({ person: "sam" }, ["scope:identity-map", "scope:analytics"], scopeMap);
  assert.equal(right.allowed, false);
  assert.match(!right.allowed ? right.message : "", /sam owns no scope labelled on this issue/u);
});

test("an issue without scope labels grants no review right", () => {
  assert.equal(reviewRight({ person: "priya" }, ["huddle"], scopeMap).allowed, false);
});

test("a label naming a scope missing from the map grants nothing", () => {
  assert.equal(reviewRight({ person: "priya" }, ["scope:ghost"], scopeMap).allowed, false);
});

test("identities and Penguin hold no review right", () => {
  assert.equal(reviewRight({ identity: "@priya/merge-rules" }, ["scope:identity-map"], scopeMap).allowed, false);
  assert.equal(reviewRight({ penguin: true }, ["scope:identity-map"], scopeMap).allowed, false);
});

test("the owners whose review a fix needs are the owners of its labelled scopes", () => {
  assert.deepEqual(reviewOwners(["huddle", "scope:identity-map", "scope:analytics", "scope:ghost"], scopeMap), ["jun", "priya"]);
  assert.deepEqual(reviewOwners(["huddle"], scopeMap), []);
});

test("a delegate's review stands for the owner who named the delegate, and only that owner", () => {
  const delegates = new Map([["priya", "sam"]]);
  const labels = ["scope:analytics", "scope:identity-map"];
  assert.deepEqual(reviewRight({ person: "sam" }, labels, scopeMap, delegates), {
    allowed: true,
    owner: "sam",
    scopes: ["identity-map"],
    countsFor: ["priya"],
  });
  // Without the delegation, or on a fix outside the delegating owner's scopes, Sam holds no right.
  assert.equal(reviewRight({ person: "sam" }, labels, scopeMap).allowed, false);
  assert.equal(reviewRight({ person: "sam" }, ["scope:analytics"], scopeMap, delegates).allowed, false);
  // An owner who is also another owner's delegate stands for both.
  const both = reviewRight({ person: "jun" }, labels, scopeMap, new Map([["priya", "jun"]]));
  assert.deepEqual(both.allowed ? both.countsFor : [], ["jun", "priya"]);
});

const reviewOf = (fields: Partial<ReviewRecord>): ReviewRecord => ({
  opId: "jun-web-0001",
  reviewerOwnerId: "jun",
  verdict: "approve",
  reason: null,
  repo: "owner-priya",
  sha: "b2",
  counts: true,
  countsFor: ["jun"],
  ...fields,
});

const fix = (reviews: ReviewRecord[], links: [string, "fix" | "related"][] = [["owner-priya@b2", "fix"]]) => ({
  labels: ["scope:analytics", "scope:identity-map"],
  linkedCommits: new Map(
    links.map(([commit, kind], i) => {
      const [repo, sha] = commit.split("@") as [string, string];
      return [`link-${i}`, { repo, sha, kind }] as const;
    }),
  ),
  reviews: new Map(reviews.map((review) => [review.opId, review])),
});

test("the fix's head is the commit last linked as a fix", () => {
  assert.equal(fixHead(fix([], [["owner-priya@a1", "fix"], ["owner-jun@c3", "related"], ["owner-priya@b2", "fix"]])), "owner-priya@b2");
  assert.equal(fixHead(fix([], [["owner-jun@c3", "related"]])), null);
});

test("a fix is approved when every needed owner's latest counting review of the head approves", () => {
  const jun = reviewOf({});
  const priya = reviewOf({ opId: "priya-web-0001", reviewerOwnerId: "priya", countsFor: ["priya"] });
  const changes = reviewOf({ opId: "jun-web-0002", verdict: "request_changes", reason: "Too loose." });
  assert.deepEqual(fixApproval(fix([jun]), scopeMap), {
    head: "owner-priya@b2",
    owners: [
      { owner: "jun", state: "approved", reviewer: "jun", reviewOpId: "jun-web-0001", reason: null },
      { owner: "priya", state: "pending", reviewer: null, reviewOpId: null, reason: null },
    ],
    approved: false,
  });
  assert.equal(fixApproval(fix([jun, priya]), scopeMap).approved, true);
  // A later request for changes replaces the approval; a later approval replaces the request.
  const changed = fixApproval(fix([jun, priya, changes]), scopeMap);
  assert.deepEqual([changed.owners[0]?.state, changed.owners[0]?.reason, changed.approved], ["changes_requested", "Too loose.", false]);
  assert.equal(fixApproval(fix([changes, jun, priya]), scopeMap).approved, true);
});

test("a review of an older commit, or one that does not count, leaves the owner pending", () => {
  const older = reviewOf({ sha: "a1" });
  const uncounted = reviewOf({ opId: "sam-web-0001", reviewerOwnerId: "sam", counts: false, countsFor: [] });
  const approval = fixApproval(fix([older, uncounted]), scopeMap);
  assert.deepEqual(approval.owners.map((owner) => owner.state), ["pending", "pending"]);
  assert.equal(fixApproval(fix([reviewOf({})], [["owner-jun@c3", "related"]]), scopeMap).approved, false);
});

test("a delegate's review of the head approves for the owner and names the delegate", () => {
  const jun = reviewOf({});
  const delegate = reviewOf({ opId: "sam-web-0001", reviewerOwnerId: "sam", countsFor: ["priya"] });
  const approval = fixApproval(fix([jun, delegate]), scopeMap);
  assert.deepEqual(approval.owners[1], { owner: "priya", state: "approved", reviewer: "sam", reviewOpId: "sam-web-0001", reason: null });
  assert.equal(approval.approved, true);
});
