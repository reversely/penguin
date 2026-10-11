import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, BoardIssue, IssuePageAssignee, IssuePageState } from "@penguin/protocol";

import { boardPenguinState, initial, sessionStatus, sessionStatuses, waitsOn } from "../src/board-view.ts";
import { check, identity, issue, person, review, running, thread } from "./board-fixtures.ts";

test("session status comes from the issue's state and routing", () => {
  const routed = identity("@jun/reports");
  assert.equal(sessionStatus(issue("1", "fixing", { assignees: [routed] }), routed), "working");
  assert.equal(sessionStatus(issue("1", "open", { assignees: [routed] }), routed), "working");
  assert.equal(sessionStatus(issue("1", "verifying", { assignees: [routed] }), routed), "waiting at a checkpoint");
  assert.equal(sessionStatus(issue("1", "in_review", { assignees: [routed] }), routed), "waiting at a checkpoint");
  assert.equal(sessionStatus(issue("1", "closed", { assignees: [routed] }), routed), "done");
  const unrouted = identity("@jun/reports", null);
  assert.equal(sessionStatus(issue("1", "fixing", { assignees: [unrouted] }), unrouted), "blocked");
  const offline = identity("@jun/reports", { ...running, status: "offline" });
  assert.equal(sessionStatus(issue("1", "fixing", { assignees: [offline] }), offline), "blocked");
  const threaded = issue("1", "fixing", {
    assignees: [routed],
    threads: [thread({ status: "open", needsPersonIds: ["priya"] })],
  });
  assert.equal(sessionStatus(threaded, routed), "blocked");
  // A person runs no session; an unassigned issue has none.
  assert.equal(sessionStatus(issue("1", "fixing", { assignees: [person("jun")] }), person("jun")), null);
  assert.equal(sessionStatus(issue("1", "fixing"), null), null);
});

test("a running session takes the most pressing status of the issues routed to it", () => {
  const second = identity("@jun/reports", { ...running, id: "session-2" });
  const statuses = sessionStatuses({
    owners: [],
    waiting: [],
    issues: [
      issue("1", "closed", { assignees: [identity("@jun/reports")] }),
      issue("2", "fixing", { assignees: [identity("@jun/reports")] }),
      issue("3", "verifying", { assignees: [identity("@jun/reports")] }),
      issue("4", "closed", { assignees: [second] }),
      issue("5", "fixing", { assignees: [person("jun"), identity("@jun/idle", null)] }),
    ],
  });
  assert.deepEqual(
    [...statuses].sort(),
    [
      ["session-1", "waiting at a checkpoint"],
      ["session-2", "done"],
    ],
  );
  const blocked = sessionStatuses({
    owners: [],
    waiting: [],
    issues: [
      issue("6", "in_review", { assignees: [identity("@jun/reports")] }),
      issue("7", "fixing", { assignees: [identity("@jun/reports")], threads: [{ id: "t1", status: "open", needsPersonIds: ["sam"], body: "", anchor: null, openedBy: "jun", participants: ["jun"], resolvedBy: null, resolveReason: null }] }),
    ],
  });
  assert.equal(blocked.get("session-1"), "blocked");
});

test("what the issue waits on follows its routing, its threads and its state", () => {
  const routed = identity("@jun/reports");
  const on = (state: IssuePageState, fields: Partial<BoardIssue["issue"]> = {}, assignee: IssuePageAssignee | null = routed) =>
    waitsOn(issue("1", state, { assignees: assignee === null ? [] : [assignee], ...fields }), assignee);
  assert.equal(on("closed"), null);
  assert.equal(on("fixing", {}, { ...identity("@sam/campaigns", null), waitingFor: "acceptance" }), "Owner acceptance");
  assert.equal(on("fixing", {}, identity("@jun/reports", null)), "A running session");
  assert.equal(on("fixing", { threads: [thread({ status: "open", needsPersonIds: ["priya", "priya"] })] }), "Reply from priya");
  assert.equal(on("fixing", { threads: [thread({ status: "resolved", needsPersonIds: ["priya"] })] }), "A fix");
  assert.equal(on("open", {}, null), "An assignee");
  assert.equal(on("open", {}, person("jun")), "A fix");
  assert.equal(on("detected", {}, null), "An assignee");
  assert.equal(on("detected"), "A fix");
  const sub = { id: "2", title: "Fix", state: "fixing" as const, assignees: [], reviews: [], checks: [], approval: null };
  assert.equal(waitsOn(issue("1", "detected", {}, { subIssues: [sub] }), null), "Fix sub-issues");
  assert.equal(on("verifying", { checks: [check("fail")] }), "A passing run");
  assert.equal(on("verifying", { checks: [check("fail"), check("pass")] }), "Combined tests");
  assert.equal(on("in_review", { reviews: [review("jun", "approve")] }), "Approval");
  assert.equal(on("in_review", { reviews: [review("jun", "request_changes")] }), "Requested changes");
  assert.equal(on("in_review"), "Reviews");
});


test("the board's Penguin state is the most pressing state of any issue", () => {
  const board = (issues: BoardIssue[]): Board => ({ owners: [], issues, waiting: [] });
  assert.equal(boardPenguinState(board([])), "observing");
  assert.equal(boardPenguinState(board([issue("1", "open"), issue("2", "detected")])), "coordinating");
  assert.equal(boardPenguinState(board([issue("1", "fixing"), issue("2", "in_review")])), "awaiting review");
  assert.equal(
    boardPenguinState(board([issue("1", "in_review"), issue("2", "verifying", { checks: [check("fail")] })])),
    "verification failed",
  );
});

test("an avatar without an image shows the initial of the identity's name", () => {
  assert.equal(initial("@jun/reports"), "R");
  assert.equal(initial("priya"), "P");
  assert.equal(initial("@x/-"), "?");
});
