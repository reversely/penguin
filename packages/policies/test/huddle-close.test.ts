import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  approvedCommit,
  closeBlockers,
  closeRefusal,
  openThreadsOf,
  verifiedIntegration,
  type CloseCheckRecord,
  type FixCloseRecord,
  type HuddleCloseRecord,
  type LinkedCommitRecord,
  type ReviewRecord,
} from "@penguin/policies";
import { parseScopeMap } from "@penguin/scope-map";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(new URL("../../../examples/identity-unification/base/penguin/scopes.json", import.meta.url), "utf8"),
  ),
);

const INTEGRATION = `huddle-031@${"c".repeat(40)}`;
const HEAD = "owner-priya@b2";

const check = (fields: Partial<CloseCheckRecord> = {}): CloseCheckRecord => ({
  commandId: "test:analytics",
  repo: "huddle-031",
  sha: "c".repeat(40),
  test: null,
  result: "pass",
  supersededBy: null,
  ...fields,
});

const links = (...commits: [string, LinkedCommitRecord["kind"]][]): Map<string, LinkedCommitRecord> =>
  new Map(
    commits.map(([commit, kind], i) => {
      const [repo, sha] = commit.split("@") as [string, string];
      return [`link-${i}`, { repo, sha, kind }] as const;
    }),
  );

const huddle = (fields: Partial<HuddleCloseRecord> = {}): HuddleCloseRecord => ({
  id: "31",
  state: "in_review",
  checks: new Map([["check-1", check()]]),
  linkedCommits: links(),
  threads: new Map(),
  ...fields,
});

const approval = (owner: string): ReviewRecord => ({
  opId: `${owner}-web-0001`,
  reviewerOwnerId: owner,
  verdict: "approve",
  reason: null,
  repo: "owner-priya",
  sha: "b2",
  counts: true,
  countsFor: [owner],
});

/** The shared-device fix: Jun's test, Priya's merge rules; approved by `approvers`. */
const fix = (approvers: string[], fields: Partial<FixCloseRecord> = {}): FixCloseRecord => ({
  id: "33",
  labels: ["scope:analytics", "scope:identity-map"],
  linkedCommits: links([HEAD, "fix"]),
  reviews: new Map(approvers.map((owner) => [`${owner}-web-0001`, approval(owner)])),
  threads: new Map(),
  ...fields,
});

const input = (issue: HuddleCloseRecord, fixes: FixCloseRecord[]) => ({
  issue,
  fixes,
  openThreads: openThreadsOf(issue, fixes),
  scopeMap,
});

test("the verified integration is the one Huddle repo revision every current check passed on", () => {
  assert.equal(verifiedIntegration(huddle()), INTEGRATION);
  const superseded = check({ result: "fail", supersededBy: "penguin-web-0009", repo: "owner-jun", sha: "a1" });
  assert.equal(verifiedIntegration(huddle({ checks: new Map([["old", superseded], ["new", check()]]) })), INTEGRATION);
  assert.equal(verifiedIntegration(huddle({ checks: new Map([["a", check()], ["b", check({ result: "fail" })]]) })), null);
  assert.equal(verifiedIntegration(huddle({ checks: new Map([["a", check()], ["b", check({ sha: "d".repeat(40) })]]) })), null);
  assert.equal(verifiedIntegration(huddle({ checks: new Map([["a", check({ repo: "owner-jun" })]]) })), null);
  assert.equal(verifiedIntegration(huddle({ checks: new Map() })), null);
});

test("nothing blocks a Huddle in review whose fixes are approved, whose checks pass and whose threads are resolved", () => {
  const resolved = new Map([["jun-web-0003", { id: "jun-web-0003", status: "resolved" as const }]]);
  assert.deepEqual(closeBlockers(input(huddle(), [fix(["jun", "priya"], { threads: resolved })])), []);
});

test("each blocker says what the Huddle waits on", () => {
  const thread = new Map([["jun-web-0003", { id: "jun-web-0003", status: "open" as const }]]);
  const changes = { ...approval("jun"), opId: "jun-web-0002", verdict: "request_changes" as const, reason: "Too loose." };
  const blocked = fix(["priya"], { threads: thread, reviews: new Map([["jun-web-0002", changes], ["priya-web-0001", approval("priya")]]) });
  const failing = huddle({ state: "fixing", checks: new Map([["a", check({ result: "fail", test: "test_retention::dau_stable" })]]) });
  assert.deepEqual(closeBlockers(input(failing, [blocked, fix([], { id: "34", linkedCommits: links() })])), [
    "#31 is fixing, not in review.",
    `test_retention::dau_stable fails on huddle-031@${"c".repeat(12)}.`,
    "#33 lacks approval from jun (changes requested).",
    "#34 has no fix commit to approve.",
    "Thread jun-web-0003 on #33 is open.",
  ]);
});

test("a Huddle whose checks are all superseded, or never ran, waits on the combined tests", () => {
  const superseded = huddle({ state: "verifying", checks: new Map([["a", check({ supersededBy: "penguin-web-0009" })]]) });
  assert.deepEqual(closeBlockers(input(superseded, [fix(["jun", "priya"])])), [
    "#31 is verifying, not in review.",
    "Every check is superseded by a newer checkpoint, and the combined tests have not run on it yet.",
  ]);
  assert.deepEqual(closeBlockers(input(huddle({ checks: new Map() }), [])), ["The combined tests have not run."]);
  const owner = huddle({ checks: new Map([["a", check({ repo: "owner-jun" })]]) });
  assert.deepEqual(closeBlockers(input(owner, [])), [
    "The current checks are not all on one revision of huddle-031's integration branch.",
  ]);
});

test("a close as approved also needs the approved branch linked at the verified integration", () => {
  const fixes = [fix(["jun", "priya"])];
  const author = { penguin: true as const };
  const unlinked = closeRefusal({ ...input(huddle(), fixes), author, startedBy: "priya", resolution: "approved" });
  assert.deepEqual(unlinked, {
    reason: "close_blocked",
    message: `#31 cannot close as approved: The approved branch is not recorded at ${INTEGRATION}.`,
  });
  const older = huddle({ linkedCommits: links([`huddle-031@${"d".repeat(40)}`, "approved"]) });
  assert.equal(closeRefusal({ ...input(older, fixes), author, startedBy: "priya", resolution: undefined })?.reason, "close_blocked");
  const linked = huddle({ linkedCommits: links([INTEGRATION, "approved"]) });
  assert.equal(approvedCommit(linked), INTEGRATION);
  assert.equal(closeRefusal({ ...input(linked, fixes), author, startedBy: "priya", resolution: "approved" }), undefined);
  // Without a resolution, a close is judged as approved.
  assert.equal(closeRefusal({ ...input(huddle(), []), author, startedBy: "priya", resolution: undefined })?.reason, "close_blocked");
});

test("only the owner who started the work cancels, in person, from any state", () => {
  const blocked = huddle({ state: "fixing", checks: new Map() });
  const cancel = (author: Parameters<typeof closeRefusal>[0]["author"]) =>
    closeRefusal({ ...input(blocked, [fix([])]), author, startedBy: "priya", resolution: "cancelled" });
  assert.equal(cancel({ person: "priya" }), undefined);
  const refusal = { reason: "not_starting_owner", message: "only priya, who started the work, may cancel #31" };
  assert.deepEqual(cancel({ person: "jun" }), refusal);
  assert.deepEqual(cancel({ identity: "@priya/merge-rules" }), refusal);
  assert.deepEqual(cancel({ penguin: true }), refusal);
});
