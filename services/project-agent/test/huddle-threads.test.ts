import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CombinedRunEvent } from "@penguin/protocol";

import { HuddleThreadStore } from "../src/huddle-threads.ts";
import { HuddleProject } from "./huddle-project.ts";
import { sqlite } from "./issues-repo.ts";

const TRIGGER = "a".repeat(40);
const BASELINE = "b".repeat(40);
const JUN_CHECKPOINT = "c".repeat(40);
const FIX_COMMIT = `owner-jun@${"d".repeat(40)}`;
const REASON = "The cutover marker still counts the merged people twice.";

/** Priya's trigger fails Jun's retention test: one fix sub-issue, #2, assigned to @jun/reports. */
function failingRun(): CombinedRunEvent {
  return {
    trigger: { ownerId: "priya", sha: TRIGGER, baselineSha: BASELINE },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [
      {
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

/** The Huddle open, with Lee as Jun's delegate, whose review counts on Jun's fix in Jun's place. */
async function opened(): Promise<HuddleProject> {
  const project = new HuddleProject();
  project.publish("priya", TRIGGER);
  project.publish("jun", JUN_CHECKPOINT);
  assert.equal((await project.open(failingRun())).status, "opened");
  project.delegates.set("jun", "lee");
  return project;
}

/** The threads the one open Huddle's HuddleAgent tracks. */
function tracked(project: HuddleProject): HuddleThreadStore {
  const [huddle] = project.huddles.open();
  assert.ok(huddle !== undefined, "an open Huddle");
  return project.threadsOf(huddle.triggerCommit);
}

const threadItems = (project: HuddleProject, person: string) =>
  project.inbox
    .items(person)
    .filter((item) => item.reason === "thread")
    .map((item) => `${item.issueId}${item.read ? "" : " unread"}`);

describe("threads on Huddle fixes", () => {
  test("a counting request for changes opens one thread that needs the fixing owner and lands in their inbox", async () => {
    const project = await opened();
    const outcome = await project.review("lee", "2", { verdict: "request_changes", commit: FIX_COMMIT, reason: REASON });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    const reviewOpId = outcome.status === "applied" ? outcome.opId : "";

    const [thread, ...others] = project.index.issue("2")?.threads.values() ?? [];
    assert.equal(others.length, 0);
    assert.deepEqual(
      [thread?.openedBy, thread?.body, thread?.anchor, thread?.needsPersonIds, thread?.status],
      ["penguin", REASON, `review:${reviewOpId}`, ["jun"], "open"],
    );
    assert.deepEqual(threadItems(project, "jun"), ["2 unread"]);
    assert.deepEqual(threadItems(project, "lee"), []);
    // The request leaves the Huddle issue where it was.
    assert.equal(project.index.issue("1")?.state, "fixing");

    // Collecting again opens no second thread for the same review.
    const again = await project.collectReviews();
    assert.deepEqual(again?.openedThreads, []);
    assert.equal(project.index.issue("2")?.threads.size, 1);
    assert.deepEqual(
      tracked(project).unresolved().map((tracked) => [tracked.issueId, tracked.threadId, tracked.reviewOpId, tracked.needs]),
      [["2", thread?.id, reviewOpId, ["jun"]]],
    );
  });

  test("a review without rights, or one that approves, opens no thread", async () => {
    const project = await opened();
    await project.review("sam", "2", { verdict: "request_changes", commit: FIX_COMMIT, reason: REASON });
    await project.review("lee", "2", { verdict: "approve", commit: FIX_COMMIT });
    assert.equal(project.index.issue("2")?.threads.size, 0);
    assert.deepEqual(tracked(project).all(), []);
  });

  test("the thread reaches each running session of the person it needs once, at a safe checkpoint", async () => {
    const project = await opened();
    const registered = project.sessions.register("jun", {
      identity: "@jun/reports",
      vendor: "codex",
      worktreeId: "wt-retention",
      branch: "main",
    });
    assert.equal(registered.status, "ok", JSON.stringify(registered));
    const session = registered.status === "ok" ? registered.session.id : "";
    project.sessions.checkpoint("jun", session);

    await project.review("lee", "2", { verdict: "request_changes", commit: FIX_COMMIT, reason: REASON });
    const threadId = [...(project.index.issue("2")?.threads.keys() ?? [])][0];
    const first = project.sessions.checkpointWorktree("jun", "wt-retention");
    assert.deepEqual(first.map((delivery) => delivery.threads), [[{ issueId: "2", threadId }]]);
    assert.deepEqual(project.sessions.checkpointWorktree("jun", "wt-retention")[0]?.threads, []);
    assert.deepEqual(
      project.index.threadsNeeding("jun").map(({ issueId, thread }) => [issueId, thread.id]),
      [["2", threadId]],
    );
  });

  test("a reply tells the thread's other people; only they resolve it, and the Huddle tracks the resolution", async () => {
    const project = await opened();
    await project.review("lee", "2", { verdict: "request_changes", commit: FIX_COMMIT, reason: REASON });
    const threadId = [...(project.index.issue("2")?.threads.keys() ?? [])][0] ?? "";
    project.inbox.markRead("jun", "2", "thread");

    const reply = await project.thread("jun", "2", "reply_thread", { thread: threadId, body: "Counting each person once now." });
    assert.equal(reply.status, "applied", JSON.stringify(reply));
    assert.deepEqual(threadItems(project, "lee"), ["2 unread"]);
    assert.deepEqual(threadItems(project, "jun"), ["2"]);

    const sam = await project.thread("sam", "2", "resolve_thread", { thread: threadId });
    assert.equal(sam.status === "rejected" && sam.reason, "not_thread_participant");
    assert.equal(tracked(project).unresolved().length, 1);

    const lee = await project.thread("lee", "2", "resolve_thread", { thread: threadId, reason: "Counted once." });
    assert.equal(lee.status, "applied", JSON.stringify(lee));
    assert.deepEqual(tracked(project).unresolved(), []);
    assert.deepEqual(
      tracked(project).all().map((tracked) => [tracked.status, tracked.resolvedBy]),
      [["resolved", "lee"]],
    );
    assert.deepEqual(project.index.threadsNeeding("jun"), []);
  });
});

describe("HuddleThreadStore", () => {
  test("keeps each thread's review and needs from when it was first recorded, and its latest status", () => {
    const store = new HuddleThreadStore(sqlite().sql);
    const thread = {
      id: "penguin-web-0009",
      body: REASON,
      anchor: "review:lee-web-0001",
      openedBy: "penguin",
      participants: ["penguin"],
      needsPersonIds: ["jun"],
      status: "open" as const,
      resolvedBy: null,
      resolveReason: null,
    };
    store.record("2", [thread]);
    store.record("1", [{ ...thread, id: "penguin-web-0003", anchor: "unassigned-impact", needsPersonIds: ["priya"] }]);
    store.record("2", [{ ...thread, status: "resolved", resolvedBy: "lee" }]);
    assert.deepEqual(
      store.all().map((tracked) => [tracked.issueId, tracked.threadId, tracked.reviewOpId, tracked.status, tracked.resolvedBy]),
      [
        ["1", "penguin-web-0003", null, "open", null],
        ["2", "penguin-web-0009", "lee-web-0001", "resolved", "lee"],
      ],
    );
    assert.deepEqual(store.unresolved().map((tracked) => tracked.threadId), ["penguin-web-0003"]);
  });
});
