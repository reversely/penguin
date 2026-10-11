import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  Board,
  BoardIdentity,
  BoardIssue,
  IssuePageAssignee,
  IssuePageCheck,
  IssuePageReview,
  IssuePageState,
} from "@penguin/protocol";

import {
  boardColumn,
  boardLanes,
  boardPenguinState,
  checkCounts,
  columnCounts,
  initial,
  latestReviews,
  sessionStatus,
  waitsOn,
} from "../src/board-view.ts";

const running = { id: "session-1", vendor: "codex", branch: "reports/retention", status: "running" as const };

function identity(id: string, session: IssuePageAssignee["session"] = running): IssuePageAssignee {
  return { kind: "identity", id, session, waitingFor: session === null ? "session" : null };
}

function person(id: string): IssuePageAssignee {
  return { kind: "person", id, session: null, waitingFor: null };
}

function check(result: IssuePageCheck["result"], test = "test_retention::dau_stable"): IssuePageCheck {
  return { opId: `op-${test}-${result}`, commandId: "analytics", repo: "huddle-031", sha: "7c41e2a9", test, result, logRef: null };
}

function review(reviewer: string, verdict: IssuePageReview["verdict"]): IssuePageReview {
  return {
    opId: `op-${reviewer}-${verdict}`,
    reviewer,
    verdict,
    reason: null,
    repo: "owner-jun",
    sha: "9d0e11f2",
    counts: true,
    uncountedReason: null,
  };
}

function issue(
  id: string,
  state: IssuePageState,
  fields: Partial<BoardIssue["issue"]> = {},
  extra: Partial<Omit<BoardIssue, "issue">> = {},
): BoardIssue {
  const assignees = fields.assignees ?? [];
  return {
    issue: {
      id,
      alias: null,
      title: `Issue ${id}`,
      body: "",
      state,
      stateReason: null,
      labels: [],
      parentId: null,
      version: 1,
      assignees,
      commits: [],
      checks: [],
      reviews: [],
      threads: [],
      ...fields,
    },
    subIssues: [],
    laneOwners: Object.fromEntries(
      assignees.map((assignee) => [assignee.id, [assignee.kind === "person" ? assignee.id : assignee.id.slice(1, assignee.id.indexOf("/"))]]),
    ),
    ...extra,
  };
}

function boardIdentity(handle: string, sessions = 1): BoardIdentity {
  return {
    handle,
    name: handle.slice(handle.indexOf("/") + 1),
    avatar: null,
    team: false,
    sessions: Array.from({ length: sessions }, (_, n) => ({ id: `s${n}`, vendor: "codex", branch: "main", lastSeen: "2026-10-10T12:00:00.000Z" })),
  };
}

test("each Huddle state has its column, and a plain issue sits in Fixing with an assignee and Detected without", () => {
  assert.equal(boardColumn(issue("1", "detected")), "detected");
  assert.equal(boardColumn(issue("1", "fixing")), "fixing");
  assert.equal(boardColumn(issue("1", "verifying")), "verifying");
  assert.equal(boardColumn(issue("1", "in_review")), "in_review");
  assert.equal(boardColumn(issue("1", "closed")), "done");
  assert.equal(boardColumn(issue("1", "open")), "detected");
  assert.equal(boardColumn(issue("1", "open", { assignees: [person("jun")] })), "fixing");
});

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
    threads: [{ id: "t1", status: "open", needsPersonIds: ["priya"] }],
  });
  assert.equal(sessionStatus(threaded, routed), "blocked");
  // A person runs no session; an unassigned issue has none.
  assert.equal(sessionStatus(issue("1", "fixing", { assignees: [person("jun")] }), person("jun")), null);
  assert.equal(sessionStatus(issue("1", "fixing"), null), null);
});

test("what the issue waits on follows its routing, its threads and its state", () => {
  const routed = identity("@jun/reports");
  const on = (state: IssuePageState, fields: Partial<BoardIssue["issue"]> = {}, assignee: IssuePageAssignee | null = routed) =>
    waitsOn(issue("1", state, { assignees: assignee === null ? [] : [assignee], ...fields }), assignee);
  assert.equal(on("closed"), null);
  assert.equal(on("fixing", {}, { ...identity("@sam/campaigns", null), waitingFor: "acceptance" }), "Owner acceptance");
  assert.equal(on("fixing", {}, identity("@jun/reports", null)), "A running session");
  assert.equal(on("fixing", { threads: [{ id: "t1", status: "open", needsPersonIds: ["priya", "priya"] }] }), "Reply from priya");
  assert.equal(on("fixing", { threads: [{ id: "t1", status: "resolved", needsPersonIds: ["priya"] }] }), "A fix");
  assert.equal(on("open", {}, null), "An assignee");
  assert.equal(on("open", {}, person("jun")), "A fix");
  assert.equal(on("detected", {}, null), "An assignee");
  assert.equal(on("detected"), "A fix");
  const sub = { id: "2", title: "Fix", state: "fixing" as const, assignees: [], reviews: [], checks: [] };
  assert.equal(waitsOn(issue("1", "detected", {}, { subIssues: [sub] }), null), "Fix sub-issues");
  assert.equal(on("verifying", { checks: [check("fail")] }), "A passing run");
  assert.equal(on("verifying", { checks: [check("fail"), check("pass")] }), "Combined tests");
  assert.equal(on("in_review", { reviews: [review("jun", "approve")] }), "Approval");
  assert.equal(on("in_review", { reviews: [review("jun", "request_changes")] }), "Requested changes");
  assert.equal(on("in_review"), "Reviews");
});

test("check counts use each command and test's latest result", () => {
  const counted = checkCounts(
    issue("1", "verifying", {
      checks: [check("fail"), check("pass"), check("error", "test_consent"), check("fail", "test_identity")],
    }),
  );
  assert.deepEqual(counted, { passed: 1, failed: 1, errored: 1 });
});

test("reviewers are each reviewer's latest review, with one without review rights kept", () => {
  const reviews = [review("jun", "request_changes"), review("jun", "approve"), { ...review("sam", "approve"), counts: false }];
  assert.deepEqual(
    latestReviews(issue("1", "in_review", { reviews })).map((entry) => [entry.reviewer, entry.verdict, entry.counts]),
    [
      ["jun", "approve", true],
      ["sam", "approve", false],
    ],
  );
});

test("three owners give three swimlanes with their identities, the viewer's first and unowned issues last", () => {
  const board: Board = {
    owners: [
      { id: "jun", identities: [boardIdentity("@jun/reports")] },
      { id: "priya", identities: [boardIdentity("@priya/merge-rules", 2)] },
      { id: "sam", identities: [boardIdentity("@sam/campaigns", 0)] },
    ],
    issues: [
      issue("31", "in_review", { assignees: [person("priya")] }),
      issue("32", "fixing", { assignees: [identity("@jun/reports")] }),
      issue("33", "fixing", { assignees: [identity("@priya/merge-rules"), identity("@jun/reports")] }),
      issue("34", "fixing", { assignees: [identity("@sam/campaigns", null)] }),
      issue("40", "open"),
    ],
  };
  const lanes = boardLanes(board, "priya");
  assert.deepEqual(
    lanes.map((lane) => lane.owner),
    ["priya", "jun", "sam", null],
  );
  const [priya, jun, sam, unowned] = lanes;
  assert.deepEqual(
    priya?.identities.map((entry) => [entry.handle, entry.sessions.length]),
    [["@priya/merge-rules", 2]],
  );
  assert.deepEqual(
    priya?.columns.in_review.map((card) => card.issue.issue.id),
    ["31"],
  );
  assert.deepEqual(
    priya?.columns.fixing.map((card) => card.issue.issue.id),
    ["33"],
  );
  // An issue with identities of two owners has a card in each owner's lane.
  assert.deepEqual(
    jun?.columns.fixing.map((card) => [card.issue.issue.id, card.identity?.handle, card.status]),
    [
      ["32", "@jun/reports", "working"],
      ["33", "@jun/reports", "working"],
    ],
  );
  assert.deepEqual(
    sam?.columns.fixing.map((card) => [card.issue.issue.id, card.status, card.waitsOn]),
    [["34", "blocked", "A running session"]],
  );
  assert.deepEqual(
    unowned?.columns.detected.map((card) => [card.issue.issue.id, card.assignee, card.waitsOn]),
    [["40", null, "An assignee"]],
  );
  assert.equal(new Set(lanes.flatMap((lane) => Object.values(lane.columns).flat().map((card) => card.key))).size, 6);
  assert.deepEqual(columnCounts(board), { detected: 1, fixing: 3, verifying: 0, in_review: 1, done: 0 });
});

test("an identity assignment with no known owner lands in the unowned lane", () => {
  const stray = issue("41", "fixing", { assignees: [identity("@gone/old")] }, { laneOwners: { "@gone/old": [] } });
  const lanes = boardLanes({ owners: [], issues: [stray] }, "jun");
  assert.deepEqual(
    lanes.map((lane) => [lane.owner, lane.columns.fixing.length]),
    [[null, 1]],
  );
});

test("the board's Penguin state is the most pressing state of any issue", () => {
  const board = (issues: BoardIssue[]): Board => ({ owners: [], issues });
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
