import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FixApproval, OwnerApprovalState } from "@penguin/issues";
import type { CombinedRunEvent } from "@penguin/protocol";

import { FixReviewStore } from "../src/huddle-reviews.ts";
import { HuddleProject } from "./huddle-project.ts";
import { sqlite } from "./issues-repo.ts";

const TRIGGER = "a".repeat(40);
const BASELINE = "b".repeat(40);
const JUN_CHECKPOINT = "c".repeat(40);

function approval(head: string | null, states: Record<string, OwnerApprovalState>): FixApproval {
  const owners = Object.entries(states).map(([owner, state]) => ({
    owner,
    state,
    reviewer: state === "pending" ? null : owner,
    reviewOpId: state === "pending" ? null : `${owner}-web-0001`,
    reason: null,
  }));
  return { head, owners, approved: head !== null && owners.every((owner) => owner.state === "approved") };
}

describe("FixReviewStore", () => {
  test("asks each pending owner once per head, and only while requests are on", () => {
    const store = new FixReviewStore(sqlite().sql, () => 1_000);
    const first = "owner-priya@" + "1".repeat(40);
    const second = "owner-priya@" + "2".repeat(40);

    assert.deepEqual(store.record("2", approval(first, { jun: "pending", priya: "pending" }), false), []);
    assert.deepEqual(store.record("2", approval(null, { jun: "pending", priya: "pending" }), true), []);
    assert.deepEqual(store.record("2", approval(first, { jun: "pending", priya: "pending" }), true), ["jun", "priya"]);
    assert.deepEqual(store.record("2", approval(first, { jun: "approved", priya: "pending" }), true), []);
    // A newer head asks again everyone who has not reviewed it, and an owner no longer needed goes.
    assert.deepEqual(store.record("2", approval(second, { jun: "pending" }), true), ["jun"]);
    assert.deepEqual(
      store.of("2").map((review) => [review.ownerId, review.state, review.head, review.requestedHead]),
      [["jun", "pending", second, second]],
    );
  });

  test("keeps the reviewer of each owner's standing review", () => {
    const store = new FixReviewStore(sqlite().sql);
    const head = "owner-jun@" + "3".repeat(40);
    store.record("3", { head, owners: [{ owner: "priya", state: "approved", reviewer: "lee", reviewOpId: "lee-web-0001", reason: null }], approved: true }, true);
    assert.deepEqual(store.of("3").map((review) => [review.ownerId, review.reviewer, review.reviewOpId, review.requestedHead]), [
      ["priya", "lee", "lee-web-0001", null],
    ]);
  });
});

function failingRun(): CombinedRunEvent {
  return {
    trigger: { ownerId: "priya", sha: TRIGGER, baselineSha: BASELINE },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [
      {
        target: "jun",
        ownerId: "jun",
        scopeId: "analytics",
        commandId: "test:analytics",
        status: "failed",
        ownerCheckpoint: JUN_CHECKPOINT,
        fingerprint: { id: "9".repeat(64), commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId: "test:analytics" },
        failingTests: [{ nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" }],
      },
    ],
  };
}

describe("collectReviews", () => {
  test("before the combined tests pass it records each fix's approval but links and asks nothing", async () => {
    const project = new HuddleProject();
    project.publish("priya", TRIGGER);
    project.publish("jun", JUN_CHECKPOINT);
    assert.equal((await project.open(failingRun())).status, "opened");
    assert.equal(project.index.issue("1")?.state, "fixing");
    const before = project.index.issue("2")?.version;

    const collected = await project.collectReviews();
    assert.deepEqual(collected?.requested, []);
    assert.deepEqual(project.approval("2"), {
      head: null,
      owners: [{ owner: "jun", state: "pending", reviewer: null, reviewOpId: null, reason: null }],
      approved: false,
    });
    assert.equal(project.index.issue("2")?.version, before);
    assert.deepEqual(project.inbox.items("jun").filter((item) => item.reason === "review_requested"), []);
  });

  test("a closed Huddle collects nothing", async () => {
    const project = new HuddleProject();
    project.publish("priya", TRIGGER);
    project.publish("jun", JUN_CHECKPOINT);
    assert.equal((await project.open(failingRun())).status, "opened");
    const issue = project.index.issue("1");
    // Priya started the work, so Priya may cancel it.
    const payload = { state: "closed", reason: "cancelled", resolution: "cancelled" };
    const closed = await project.submit(
      { issue: 1, type: "change_state", base_version: issue?.version, payload },
      { person: "priya" },
      "dashboard",
    );
    assert.equal(closed.status, "applied", JSON.stringify(closed));
    assert.equal(await project.collectReviews(), undefined);
    assert.equal(project.approval("2"), undefined);
  });
});
