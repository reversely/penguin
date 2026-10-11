import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, BoardIdentity, BoardIssue, InboxEntry, IssuePageAssignee, IssuePageState } from "@penguin/protocol";

import {
  boardFacts,
  CLOSED_WINDOW,
  INBOX_GROUPS,
  groupInbox,
  isOnline,
  itemKey,
  markedRead,
  newest,
  raisedLabel,
  unreadCount,
  WAITING_PREVIEW,
  waitingFor,
} from "../src/inbox-view.ts";

function entry(issueId: string, reason: InboxEntry["reason"], read = false): InboxEntry {
  const raisedAt = "2026-10-10T12:00:00.000Z";
  return { issueId, reason, read, raisedAt, title: `Issue ${issueId}`, state: "open", assigneeHandles: [] };
}

const keys = (items: readonly InboxEntry[]) => items.map(itemKey);

test("the inbox has the five lists in the PRD's order, under noun headings", () => {
  assert.deepEqual(
    INBOX_GROUPS.map((group) => group.label),
    ["Review requests", "Assignments", "Mentions", "Threads", "Closed issues"],
  );
});

test("each item goes to its reason's list, keeping the inbox's newest-first order", () => {
  const items = [
    entry("42", "closed"),
    entry("43", "review_requested"),
    entry("44", "thread"),
    entry("41", "start_session"),
    entry("40", "mentioned"),
    entry("41", "assigned", true),
    entry("40", "assigned"),
  ];
  const groups = groupInbox(items);
  assert.deepEqual(keys(groups.assigned), ["start_session:41", "assigned:41", "assigned:40"]);
  assert.deepEqual(keys(groups.mentioned), ["mentioned:40"]);
  assert.deepEqual(keys(groups.closed), ["closed:42"]);
  assert.deepEqual(keys(groups.review), ["review_requested:43"]);
  assert.deepEqual(keys(groups.threads), ["thread:44"]);
});

test("an item with an unknown reason is left out of every list", () => {
  const unknown = { ...entry("40", "assigned"), reason: "toString" } as unknown as InboxEntry;
  const groups = groupInbox([unknown, entry("41", "mentioned")]);
  assert.deepEqual(Object.values(groups).flat().map(itemKey), ["mentioned:41"]);
});

function assignee(handle: string, waiting: IssuePageAssignee["waitingFor"] = null): IssuePageAssignee {
  return { kind: "identity", id: handle, session: null, waitingFor: waiting };
}

function boardIssue(
  id: string,
  state: IssuePageState,
  assignees: IssuePageAssignee[] = [],
  laneOwners: Record<string, string[]> = {},
  needs: string[] = [],
): BoardIssue {
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
      threads: needs.length === 0 ? [] : [{ id: "op-thread", status: "open" as const, needsPersonIds: needs, body: "", anchor: null, openedBy: "priya", participants: ["priya"], resolvedBy: null, resolveReason: null }],
    },
    subIssues: [],
    laneOwners,
  };
}

test("the four waiting previews read as the identity plan words them", () => {
  assert.deepEqual(WAITING_PREVIEW, {
    review: "Waiting for your review",
    reply: "Waiting for your reply",
    start_session: "Waiting for you to start a session",
    acceptance: "Waiting for your acceptance",
  });
});

test("a review request and a session request wait on the person by their reason alone", () => {
  assert.equal(waitingFor(entry("43", "review_requested"), undefined, "jun"), "review");
  assert.equal(waitingFor(entry("41", "start_session"), undefined, "jun"), "start_session");
  assert.equal(waitingFor(entry("40", "assigned"), undefined, "jun"), null, "unknown until the board is read");
});

test("an item waits for the person's reply while an open thread on its issue needs them", () => {
  const needsJun = boardIssue("40", "open", [], {}, ["jun"]);
  assert.equal(waitingFor(entry("40", "mentioned"), needsJun, "jun"), "reply");
  assert.equal(waitingFor(entry("40", "assigned"), needsJun, "jun"), "reply");
  assert.equal(waitingFor(entry("40", "mentioned"), needsJun, "priya"), null);
  const resolved = { ...needsJun, issue: { ...needsJun.issue, threads: needsJun.issue.threads.map((thread) => ({ ...thread, status: "resolved" as const })) } };
  assert.equal(waitingFor(entry("40", "mentioned"), resolved, "jun"), null);
  assert.equal(waitingFor(entry("40", "closed"), needsJun, "jun"), null, "a closed item waits for nothing");
  assert.equal(waitingFor(entry("40", "mentioned"), boardIssue("40", "closed", [], {}, ["jun"]), "jun"), null);
});

test("an assignment waits for the person's acceptance only when the awaiting identity is in their swimlane", () => {
  const awaiting = boardIssue("40", "open", [assignee("@jun/reports", "acceptance")], { "@jun/reports": ["jun"] });
  assert.equal(waitingFor(entry("40", "assigned"), awaiting, "jun"), "acceptance");
  assert.equal(waitingFor(entry("40", "assigned"), awaiting, "priya"), null);
  assert.equal(waitingFor(entry("40", "mentioned"), awaiting, "jun"), null, "a mention is not the assignment");
  const routed = boardIssue("40", "open", [assignee("@jun/reports", "session")], { "@jun/reports": ["jun"] });
  assert.equal(waitingFor(entry("40", "assigned"), routed, "jun"), null);
});

function boardIdentity(handle: string, sessions: number): BoardIdentity {
  const session = { id: "s", vendor: "codex", branch: "main", lastSeen: "2026-10-10T12:00:00.000Z" };
  return { handle, name: handle, avatar: null, team: false, sessions: Array.from({ length: sessions }, () => session) };
}

test("the board's facts find each issue by id and each identity by handle; a session makes it online", () => {
  const team = boardIdentity("@sam/on-call", 1);
  const board: Board = {
    owners: [
      { id: "jun", identities: [boardIdentity("@jun/reports", 0), team] },
      { id: "sam", identities: [team] },
    ],
    issues: [boardIssue("40", "open")],
    waiting: [],
  };
  const facts = boardFacts(board);
  assert.equal(facts.issues.get("40")?.issue.id, "40");
  assert.deepEqual([...facts.identities.keys()], ["@jun/reports", "@sam/on-call"]);
  assert.equal(isOnline(facts.identities.get("@sam/on-call")), true);
  assert.equal(isOnline(facts.identities.get("@jun/reports")), false);
  assert.equal(isOnline(undefined), false);
});

test("the raised time is the time today, the weekday this past week and the date before", () => {
  const now = new Date(2026, 9, 11, 15, 0);
  assert.equal(raisedLabel(new Date(2026, 9, 11, 9, 5).toISOString(), now, "en-US"), "9:05 AM");
  assert.equal(raisedLabel(new Date(2026, 9, 10, 23, 59).toISOString(), now, "en-US"), "Sat");
  assert.equal(raisedLabel(new Date(2026, 9, 5, 0, 0).toISOString(), now, "en-US"), "Mon");
  assert.equal(raisedLabel(new Date(2026, 9, 4, 23, 59).toISOString(), now, "en-US"), "Oct 4");
  assert.equal(raisedLabel(new Date(2025, 11, 31, 12, 0).toISOString(), now, "en-US"), "Dec 31, 2025");
  assert.equal(raisedLabel("not a time", now, "en-US"), "");
});

test("the unread count counts unread items; marking one read changes only that item", () => {
  const items = [entry("40", "assigned"), entry("40", "closed"), entry("41", "mentioned", true)];
  assert.equal(unreadCount(items), 2);
  const after = markedRead(items, itemKey(entry("40", "closed")));
  assert.equal(unreadCount(after), 1);
  assert.deepEqual(
    after.map((item) => [itemKey(item), item.read]),
    [
      ["assigned:40", false],
      ["closed:40", true],
      ["mentioned:41", true],
    ],
  );
  assert.equal(items[1]?.read, false, "the list it came from is unchanged");
});

test("a list shows its newest items up to the window, or every item on request", () => {
  const closed = Array.from({ length: CLOSED_WINDOW + 2 }, (_, n) => entry(String(50 - n), "closed"));
  assert.equal(CLOSED_WINDOW, 10);
  assert.deepEqual(keys(newest(closed, CLOSED_WINDOW, false)), keys(closed.slice(0, CLOSED_WINDOW)));
  assert.deepEqual(keys(newest(closed, CLOSED_WINDOW, true)), keys(closed));
  assert.deepEqual(keys(newest(closed.slice(0, 3), CLOSED_WINDOW, false)), keys(closed.slice(0, 3)));
});
