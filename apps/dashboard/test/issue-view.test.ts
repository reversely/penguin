import assert from "node:assert/strict";
import { test } from "node:test";

import type { IssuePage, IssuePageCheck, IssuePageReview, IssuePageTimelineEntry } from "@penguin/protocol";

import {
  authorName,
  checkSignal,
  describeEntry,
  entrySignal,
  fixedIn,
  latestChecks,
  penguinState,
  reasonLabel,
  watchedIssues,
} from "../src/issue-view.ts";
import { latestChange, recordChange, type LiveChanges } from "../src/live-changes.ts";

function entry(fields: Partial<IssuePageTimelineEntry>): IssuePageTimelineEntry {
  return {
    seq: 1,
    opId: "jun-web-0001",
    author: "jun",
    type: "comment",
    payload: { body: "hello" },
    status: "applied",
    rejectReason: null,
    message: null,
    gitCommit: null,
    waitingForGitLog: false,
    ...fields,
  };
}

function check(fields: Partial<IssuePageCheck>): IssuePageCheck {
  return {
    opId: "penguin-web-0001",
    commandId: "analytics",
    repo: "huddle-031",
    sha: "7c41e2a9",
    test: "test_retention::dau_stable",
    result: "fail",
    logRef: null,
    fingerprint: null,
    supersededBy: null,
    ...fields,
  };
}

function review(fields: Partial<IssuePageReview>): IssuePageReview {
  return {
    opId: "jun-web-0002",
    reviewer: "jun",
    verdict: "approve",
    reason: null,
    repo: "owner-jun",
    sha: "9d0e11f2",
    counts: true,
    uncountedReason: null,
    ...fields,
  };
}

function page(issue: Partial<IssuePage["issue"]>, subIssues: IssuePage["subIssues"] = []): IssuePage {
  return {
    issue: {
      id: "31",
      alias: null,
      title: "Identity map change",
      body: "",
      state: "open",
      stateReason: null,
      labels: [],
      parentId: null,
      version: 1,
      assignees: [],
      commits: [],
      checks: [],
      reviews: [],
      threads: [],
      ...issue,
    },
    subIssues,
    timeline: [],
  };
}

const sub = (id: string, fields: Partial<IssuePage["subIssues"][number]> = {}) => ({
  id,
  title: `Fix ${id}`,
  state: "in_review" as const,
  assignees: [],
  reviews: [],
  checks: [],
  ...fields,
});

test("claims, alerts, verified results, failures, warnings and reviews each get their own signal", () => {
  assert.equal(entrySignal(entry({ author: "jun.reports", type: "change_state", payload: { state: "in_review" } })), "claim");
  assert.equal(entrySignal(entry({ author: "jun.reports", type: "link_commit", payload: { commit: "a@b" } })), "claim");
  assert.equal(entrySignal(entry({ author: "penguin", type: "change_state" })), "alert");
  assert.equal(entrySignal(entry({ author: "penguin", type: "add_label" })), undefined);
  assert.equal(entrySignal(entry({ author: "penguin", type: "attach_check", payload: { result: "pass" } })), "verified");
  assert.equal(entrySignal(entry({ author: "penguin", type: "attach_check", payload: { result: "fail" } })), "failure");
  assert.equal(entrySignal(entry({ author: "penguin", type: "attach_check", payload: { result: "error" } })), "warning");
  assert.equal(entrySignal(entry({ type: "review", payload: { verdict: "approve" } })), "review");
  assert.equal(entrySignal(entry({ author: "jun", type: "change_state" })), undefined);
  assert.equal(entrySignal(entry({ author: null, type: null, payload: null, status: "rejected" })), undefined);
  assert.notEqual(checkSignal({ result: "fail" }), checkSignal({ result: "error" }));
});

test("each operation reads as one line, with its text kept apart and never parsed", () => {
  assert.deepEqual(describeEntry(entry({ payload: { body: "<script>x</script>" } })), {
    summary: "commented",
    text: "<script>x</script>",
  });
  assert.deepEqual(
    describeEntry(entry({ type: "review", payload: { verdict: "request_changes", commit: "owner-priya@a1b2c3d4e5", reason: "too loose" } })),
    { summary: "requested changes on owner-priya@a1b2c3d", text: "too loose" },
  );
  assert.deepEqual(describeEntry(entry({ type: "change_state", payload: { state: "in_review", reason: "tests pass" } })), {
    summary: "moved the issue to In review",
    text: "tests pass",
  });
  assert.equal(describeEntry(entry({ type: "assign", payload: { assignee: { identity: "@jun/reports" } } })).summary, "assigned @jun/reports");
  assert.deepEqual(describeEntry(entry({ type: "send_upstream", payload: { reason: "belongs in the merge rules" } })), {
    summary: "sent the fix upstream",
    text: "belongs in the merge rules",
  });
  assert.equal(describeEntry(entry({ type: null, payload: null })).summary, "unreadable operation");
  assert.equal(reasonLabel("bad_signature"), "bad signature");
  assert.equal(authorName("jun.reports"), "@jun/reports");
  assert.equal(authorName("penguin"), "Penguin");
  assert.equal(authorName(null), "Unknown author");
});

test("a failing check is fixed in the sub-issue whose latest check of the same test passes", () => {
  const failing = check({});
  const subs = [
    sub("32", { checks: [check({ result: "pass", sha: "9d0e11" })] }),
    sub("33", { checks: [check({ result: "pass", test: "other" })] }),
  ];
  assert.equal(fixedIn(failing, subs), "32");
  assert.equal(fixedIn(failing, [sub("32", { checks: [check({ result: "pass" }), check({ result: "fail" })] })]), undefined);
  assert.equal(fixedIn(check({ result: "pass" }), subs), undefined);
});

test("a superseded check never counts as the latest result", () => {
  const old = check({ opId: "penguin-web-0003", result: "fail", supersededBy: "penguin-web-0009" });
  const current = check({ opId: "penguin-web-0010", result: "pass", test: null });
  assert.deepEqual(latestChecks([old, current]), [current]);
  assert.deepEqual(latestChecks([old]), []);
});

test("the Penguin character follows the issue's state, its checks and its reviews", () => {
  assert.equal(penguinState(page({ state: "open" })), "observing");
  assert.equal(penguinState(page({ state: "closed" })), "observing");
  assert.equal(penguinState(page({ state: "detected" })), "coordinating");
  assert.equal(penguinState(page({ state: "fixing", checks: [check({})] })), "fixing");
  assert.equal(penguinState(page({ state: "verifying", checks: [check({})] })), "verification failed");
  assert.equal(penguinState(page({ state: "verifying", checks: [check({}), check({ result: "pass" })] })), "coordinating");

  const approvedFix = sub("32", { reviews: [review({})] });
  assert.equal(penguinState(page({ state: "in_review" }, [approvedFix])), "ready to approve");
  assert.equal(penguinState(page({ state: "in_review" }, [approvedFix, sub("33")])), "awaiting review");
  const changes = sub("33", { reviews: [review({}), review({ reviewer: "priya", verdict: "request_changes" })] });
  assert.equal(penguinState(page({ state: "in_review" }, [approvedFix, changes])), "awaiting review");
  const approvedAfterChanges = sub("33", { reviews: [review({ verdict: "request_changes" }), review({})] });
  assert.equal(penguinState(page({ state: "in_review" }, [approvedFix, approvedAfterChanges])), "ready to approve");
  const uncounted = sub("33", { reviews: [review({ counts: false, uncountedReason: "no review rights" })] });
  assert.equal(penguinState(page({ state: "in_review" }, [uncounted])), "awaiting review");
  const openThread = { id: "jun-web-0009", status: "open" as const, needsPersonIds: ["priya"] };
  assert.equal(penguinState(page({ state: "in_review", threads: [openThread] }, [approvedFix])), "awaiting review");
  assert.equal(penguinState(page({ state: "in_review", reviews: [review({})] })), "ready to approve");
});

test("the page reads again when its issue, its temporary ID or a sub-issue changes, and only then", () => {
  const read = page({ alias: "jun-b3f2-0001" }, [sub("32")]);
  const watched = watchedIssues(read, "31");
  let changes: LiveChanges = { revision: 0, changed: new Map() };
  assert.equal(latestChange(changes, watched), 0);
  changes = recordChange(changes, ["40"]);
  assert.equal(latestChange(changes, watched), 0);
  changes = recordChange(changes, ["32", "41"]);
  assert.equal(latestChange(changes, watched), 2);
  changes = recordChange(changes, ["jun-b3f2-0001"]);
  assert.equal(latestChange(changes, watched), 3);
  assert.deepEqual(watchedIssues(undefined, "31"), ["31"]);
});
