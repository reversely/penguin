import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  IssuePage,
  IssuePageApproval,
  IssuePageCheck,
  IssuePageOwnerApproval,
  IssuePageReview,
  IssuePageThread,
  IssuePageTimelineEntry,
} from "@penguin/protocol";

import {
  APPROVAL_LABEL,
  APPROVAL_STATUS_LABEL,
  approvalFixes,
  approvalStatus,
  assigneeSegment,
  authorKind,
  checkSummary,
  composerRows,
  entryIds,
  entryKind,
  shortCommit,
  threadEntries,
  threadOf,
  authorName,
  checkSignal,
  describeEntry,
  entrySignal,
  fixedIn,
  latestChecks,
  penguinState,
  reasonLabel,
  RESOLUTION_LABEL,
  reviewSuperseded,
  threadOpener,
  showsCloseOut,
  watchedIssues,
} from "../src/issue-view.ts";
import { latestChange, recordChange, type LiveChanges } from "../src/live-changes.ts";

/** An issue page thread Jun opened, with `fields` replacing any of its fields. */
function thread(fields: Partial<IssuePageThread>): IssuePageThread {
  return {
    id: "t1",
    status: "open",
    needsPersonIds: [],
    body: "A limit of five still joins the tablet's users.",
    anchor: null,
    openedBy: "jun",
    participants: ["jun"],
    resolvedBy: null,
    resolveReason: null,
    ...fields,
  };
}

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
  approval: null,
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

test("a close names how the issue ended, and the close-out shows only when it holds something", () => {
  const closing = (resolution?: string) =>
    describeEntry(entry({ type: "change_state", payload: { state: "closed", reason: "done", ...(resolution ? { resolution } : {}) } }));
  assert.deepEqual(closing("approved"), { summary: "closed the issue as approved", text: "done" });
  assert.deepEqual(closing("cancelled"), { summary: "cancelled the issue", text: "done" });
  assert.deepEqual(closing(), { summary: "moved the issue to Closed", text: "done" });

  assert.equal(showsCloseOut(null), false);
  assert.equal(showsCloseOut(undefined), false);
  assert.equal(showsCloseOut({ waitingOn: [], approvedCommit: null, resolution: null }), false);
  assert.equal(showsCloseOut({ waitingOn: ["Thread jun-web-0003 on #33 is open."], approvedCommit: null, resolution: null }), true);
  assert.equal(showsCloseOut({ waitingOn: [], approvedCommit: "huddle-031@c3", resolution: "approved" }), true);
  assert.match(RESOLUTION_LABEL.cancelled, /owner who started the work/u);
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
  const openThread = thread({ id: "jun-web-0009", status: "open", needsPersonIds: ["priya"] });
  assert.equal(penguinState(page({ state: "in_review", threads: [openThread] }, [approvedFix])), "awaiting review");
  assert.equal(penguinState(page({ state: "in_review", reviews: [review({})] })), "ready to approve");
});

test("a fix's recorded approval decides its review, and a review of an older commit is marked superseded", () => {
  const owner = (name: string, state: "approved" | "changes_requested" | "pending") => ({
    owner: name,
    state,
    reviewer: state === "pending" ? null : name,
    reviewOpId: null,
    reason: null,
  });
  const head = "owner-priya@b2";
  const older = review({ reviewer: "jun", repo: "owner-priya", sha: "a1" });
  // Jun's approval of an older commit would pass the review-only rule, but the head still awaits Jun.
  const awaiting = sub("33", { reviews: [older], approval: { head, owners: [owner("jun", "pending")], approved: false } });
  assert.equal(penguinState(page({ state: "in_review" }, [awaiting])), "awaiting review");
  assert.equal(reviewSuperseded(older, awaiting.approval), true);
  assert.equal(reviewSuperseded(review({ repo: "owner-priya", sha: "b2" }), awaiting.approval), false);
  assert.equal(reviewSuperseded(older, null), false);
  const done = sub("33", { approval: { head, owners: [owner("jun", "approved"), owner("priya", "approved")], approved: true } });
  assert.equal(penguinState(page({ state: "in_review" }, [done])), "ready to approve");
  assert.equal(APPROVAL_LABEL.pending, "Awaiting review");
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

test("each timeline entry takes the activity's treatment for its kind and its author", () => {
  const read = page({
    checks: [check({ opId: "penguin-web-0002" })],
    reviews: [review({ opId: "jun-web-0003" })],
    threads: [thread({ id: "priya-web-0004" })],
  });
  const ids = entryIds(read.issue);
  const kind = (fields: Partial<IssuePageTimelineEntry>) => entryKind(entry(fields), "jun", ids);
  assert.equal(kind({ type: "create", author: "penguin" }), "opened");
  assert.equal(kind({ type: "comment", author: "jun" }), "own-comment");
  assert.equal(kind({ type: "comment", author: "priya" }), "comment");
  assert.equal(kind({ type: "edit_comment", author: "jun.reports" }), "comment");
  assert.equal(kind({ type: "comment", author: "penguin" }), "system");
  assert.equal(kind({ type: "change_state", author: "penguin" }), "system");
  assert.equal(kind({ type: "change_state", author: "jun.reports" }), "claim");
  assert.equal(kind({ type: "assign", author: "priya" }), "event");
  assert.equal(kind({ type: "attach_check", opId: "penguin-web-0002", author: "penguin" }), "check");
  assert.equal(kind({ type: "attach_check", opId: "penguin-web-0009", author: "penguin", payload: { result: "pass" } }), "event");
  assert.equal(kind({ type: "review", opId: "jun-web-0003" }), "review");
  assert.equal(kind({ type: "open_thread", opId: "priya-web-0004" }), "thread");
  assert.equal(kind({ type: "reply_thread", payload: { thread: "priya-web-0004", body: "yes" } }), "in-thread");
  assert.equal(kind({ type: "resolve_thread", payload: { thread: "priya-web-0004" } }), "in-thread");
  assert.equal(kind({ type: "reply_thread", payload: { thread: "elsewhere", body: "yes" } }), "event");
  assert.equal(kind({ type: "comment", status: "rejected", rejectReason: "superseded_version" }), "rejected");
});

test("a thread card holds its applied replies and resolution in order, and no rejected one", () => {
  const timeline = [
    entry({ opId: "a", type: "reply_thread", payload: { thread: "t1", body: "one" } }),
    entry({ opId: "b", type: "reply_thread", payload: { thread: "t2", body: "other" } }),
    entry({ opId: "c", type: "reply_thread", payload: { thread: "t1", body: "late" }, status: "rejected" }),
    entry({ opId: "d", type: "comment", payload: { thread: "t1", body: "not a reply" } }),
    entry({ opId: "e", type: "resolve_thread", payload: { thread: "t1" } }),
  ];
  const byThread = threadEntries(timeline);
  assert.deepEqual(
    byThread.get("t1")?.map((e) => e.opId),
    ["a", "e"],
  );
  assert.deepEqual(
    byThread.get("t2")?.map((e) => e.opId),
    ["b"],
  );
  assert.equal(byThread.get("t3"), undefined);
  assert.equal(threadOf(entry({ payload: null })), undefined);
});

test("an approval card waits for the viewer only while a head is linked and the viewer's review is pending", () => {
  const owners = (jun: IssuePageOwnerApproval["state"], priya: IssuePageOwnerApproval["state"]) => [
    { owner: "jun", state: jun, reviewer: jun === "pending" ? null : "jun", reviewOpId: null, reason: null },
    { owner: "priya", state: priya, reviewer: priya === "pending" ? null : "priya", reviewOpId: null, reason: null },
  ];
  const approval = (fields: Partial<IssuePageApproval>): IssuePageApproval => ({ head: "owner-jun@c3d4e5f6", owners: [], approved: false, ...fields });
  assert.equal(approvalStatus(approval({ owners: owners("pending", "approved") }), "jun"), "waiting-for-you");
  assert.equal(approvalStatus(approval({ owners: owners("pending", "approved") }), "priya"), "waiting");
  assert.equal(approvalStatus(approval({ head: null, owners: owners("pending", "pending") }), "jun"), "waiting");
  assert.equal(approvalStatus(approval({ owners: owners("changes_requested", "pending") }), "sam"), "changes-requested");
  assert.equal(approvalStatus(approval({ owners: owners("approved", "approved"), approved: true }), "jun"), "approved");
  assert.equal(APPROVAL_STATUS_LABEL["waiting-for-you"], "Waiting for your review");
  const fixes = approvalFixes([sub("32"), sub("33", { approval: approval({}) })]);
  assert.deepEqual(
    fixes.map((fix) => fix.id),
    ["33"],
  );
});

test("the checks summary counts current results by signal and superseded ones apart", () => {
  const summary = checkSummary([
    check({ opId: "1", result: "pass" }),
    check({ opId: "2", result: "fail" }),
    check({ opId: "3", result: "error" }),
    check({ opId: "4", result: "fail", supersededBy: "penguin-web-0009" }),
    check({ opId: "5", result: "pass", supersededBy: "penguin-web-0009" }),
  ]);
  assert.deepEqual(summary, { verified: 1, failure: 1, warning: 1, superseded: 2 });
});

test("the composer takes one row per line of its draft, up to six", () => {
  assert.equal(composerRows(""), 1);
  assert.equal(composerRows("one\ntwo\nthree"), 3);
  assert.equal(composerRows("\n".repeat(20)), 6);
});

test("authors and assignees read as Penguin, an identity or a person", () => {
  assert.equal(authorKind("penguin"), "penguin");
  assert.equal(authorKind("jun.reports"), "identity");
  assert.equal(authorKind("jun"), "person");
  assert.equal(authorKind(null), "unknown");
  assert.equal(assigneeSegment({ kind: "identity", id: "@jun/reports" }), "jun.reports");
  assert.equal(assigneeSegment({ kind: "person", id: "priya" }), "priya");
  assert.equal(authorName(assigneeSegment({ kind: "identity", id: "@jun/reports" })), "@jun/reports");
  assert.equal(shortCommit("owner-jun@c3d4e5f6a7b8"), "owner-jun@c3d4e5f");
});

test("a thread Penguin opened for a request for changes speaks for the reviewer", () => {
  const changes = review({ opId: "jun-web-0007", verdict: "request_changes", reason: "A limit of five is too high." });
  assert.equal(threadOpener(thread({ openedBy: "penguin", anchor: "review:jun-web-0007" }), [changes]), "jun");
  assert.equal(threadOpener(thread({ openedBy: "penguin", anchor: "review:sam-web-0001" }), [changes]), "penguin");
  assert.equal(threadOpener(thread({ openedBy: "priya", anchor: null }), [changes]), "priya");
});
