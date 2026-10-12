// The task a fix sub-issue becomes in get_work (fix-task.ts), in the dependent owner's terms and,
// once reassigned upstream, in the new assignee's. tests/integration/fix-delivery.test.ts and
// tests/integration/send-upstream.test.ts cover both forms on the identity-unification fixture.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Assignment, IssueRecord } from "@penguin/issues";
import type { CombinedRunEvent } from "@penguin/protocol";

import { fixTask } from "../src/fix-task.ts";
import { fixesOf } from "../src/huddle-open.ts";
import { ownerCommit, type Huddle, type HuddleStore } from "../src/huddle-store.ts";

// Distinct full SHAs and a fingerprint, spelled out so each reads as what it stands for.
const TRIGGER = "a".repeat(40);
const BASELINE = "b".repeat(40);
const JUN_CHECKPOINT = "c".repeat(40);
const FINGERPRINT = "1".repeat(64);

/** Priya's checkpoint merged with Jun's fails analytics' shared-device test. */
const event: CombinedRunEvent = {
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
      fingerprint: { id: FINGERPRINT, commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId: "test:analytics" },
      failingTests: [
        { nodeId: "analytics/tests/test_identity.py::test_shared_device_split", testId: "test_identity::shared_device_split" },
      ],
    },
  ],
};

const trigger = ownerCommit("priya", TRIGGER);
const huddle: Huddle = {
  triggerCommit: trigger,
  triggerOwner: "priya",
  triggerSha: TRIGGER,
  baselineSha: BASELINE,
  triggerScopes: event.changedScopes,
  event,
  issueId: "1",
  status: "open",
  huddleRepo: null,
  openedAt: new Date(0).toISOString(),
};

/** A Huddle store holding sub-issue #2 as the shared-device fix. */
const huddles: Pick<HuddleStore, "fixOf"> = {
  fixOf: (issueId) => (issueId === "2" ? { huddle, fixKey: fixesOf(event)[0]!.key } : undefined),
};

function assigned(...parties: [Assignment["assigneeKind"], string][]): Pick<IssueRecord, "assignments"> {
  return {
    assignments: new Map(
      parties.map(([assigneeKind, assigneeId]) => [`${assigneeKind}:${assigneeId}`, { assigneeKind, assigneeId }]),
    ),
  };
}

const failingTests = [
  {
    scopeId: "analytics",
    commandId: "test:analytics",
    testId: "test_identity::shared_device_split",
    nodeId: "analytics/tests/test_identity.py::test_shared_device_split",
    fingerprint: FINGERPRINT,
  },
];

test("a fix with the dependent owner pins that owner's checkpoint and asks for a fixed checkpoint of it", () => {
  const original = {
    huddleIssueId: "1",
    pinnedBase: { trigger, baseline: BASELINE, checkpoint: ownerCommit("jun", JUN_CHECKPOINT) },
    failingTests,
    acceptanceCriteria: [
      `test_identity::shared_device_split passes when ${trigger} is merged with your fixed checkpoint of owner-jun.`,
      "`test:analytics` passes in full on that merge.",
    ],
  };
  assert.deepEqual(fixTask(huddles, "2", assigned(["identity", "@jun/reports"])), original);
  assert.deepEqual(fixTask(huddles, "2", assigned(["person", "jun"])), original);
  // Before the index holds the sub-issue, the task is the dependent owner's.
  assert.deepEqual(fixTask(huddles, "2", undefined), original);
});

test("a fix reassigned upstream pins the trigger and states acceptance in the new assignee's scope", () => {
  const reassigned = {
    huddleIssueId: "1",
    pinnedBase: { trigger, baseline: BASELINE, checkpoint: trigger },
    failingTests,
    acceptanceCriteria: [
      "analytics test test_identity::shared_device_split passes when your fixed checkpoint of owner-priya is " +
        `merged with ${ownerCommit("jun", JUN_CHECKPOINT)}.`,
      "`test:analytics` passes in full on that merge.",
    ],
  };
  assert.deepEqual(fixTask(huddles, "2", assigned(["identity", "@priya/merge-rules"])), reassigned);
  assert.deepEqual(fixTask(huddles, "2", assigned(["person", "priya"])), reassigned);
  // Between Penguin's assign and unassign both hold it; the task is already the new assignee's.
  const both = assigned(["identity", "@jun/reports"], ["identity", "@priya/merge-rules"]);
  assert.deepEqual(fixTask(huddles, "2", both), reassigned);
});

test("a fix reassigned to an owner other than the trigger's names that owner, preferring the trigger's owner", () => {
  const criterion = (issue: Pick<IssueRecord, "assignments">): string =>
    fixTask(huddles, "2", issue)?.acceptanceCriteria[0] ?? "";
  assert.match(criterion(assigned(["identity", "@sam/campaigns"])), /fixed checkpoint of owner-sam is merged with owner-jun@/u);
  const both = assigned(["identity", "@sam/campaigns"], ["identity", "@priya/merge-rules"]);
  assert.match(criterion(both), /fixed checkpoint of owner-priya is merged/u);
});

test("an issue that is not a fix sub-issue has no task", () => {
  assert.equal(fixTask(huddles, "3", assigned(["identity", "@jun/reports"])), undefined);
});
