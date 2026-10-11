import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { formatOpId, type Author, type IssueId, type Operation } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { reduce, type IssueRecord, type ReduceContext, type ReduceResult } from "../src/index.ts";

const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };
const seqs = new Map<string, number>();

/** An operation as the validator passes it on; the reducer never looks at the signature. */
function op(author: Author, type: Operation["type"], payload: Record<string, unknown>, issue: IssueId = 33): Operation {
  const key = JSON.stringify(author);
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  const opId = formatOpId(author, "web", seq);
  return { schema_version: 1, op_id: opId, issue, type, author, base_version: 0, payload, signature: "x".repeat(86) };
}

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

const noIssues: ReduceContext = { parentOf: () => undefined, resolve: (id) => id, nextIssueNumber: () => 1, scopeMap };

function ok(result: ReduceResult): IssueRecord {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { issue: IssueRecord }).issue;
}

function rejected(result: ReduceResult, reason: string): void {
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, reason);
}

const created = (): IssueRecord => ok(reduce(undefined, op(jun, "create", { title: "Shared-device merge" }), noIssues));

describe("reduce", () => {
  test("create starts an open issue at version 1; a second create is rejected", () => {
    const issue = created();
    assert.equal(issue.id, "33");
    assert.equal(issue.state, "open");
    assert.equal(issue.body, "");
    assert.equal(issue.version, 1);
    rejected(reduce(issue, op(jun, "create", { title: "Again" }), noIssues), "issue_exists");
  });

  test("an operation on an issue that does not exist is rejected", () => {
    rejected(reduce(undefined, op(jun, "comment", { body: "hi" }), noIssues), "no_issue");
  });

  test("a create under a temporary ID must name its own op_id, and takes the next number", () => {
    const create = op(priya, "create", { title: "Offline" }, "x");
    rejected(reduce(undefined, { ...create, issue: "priya-web-9999" }, noIssues), "create_id_mismatch");
    const context: ReduceContext = { ...noIssues, nextIssueNumber: () => 34 };
    const issue = ok(reduce(undefined, { ...create, issue: create.op_id }, context));
    assert.equal(issue.id, "34");
    assert.equal(issue.alias, create.op_id);
    // A create that names its number has no alias.
    assert.equal(created().alias, null);
  });

  test("open_sub_issue resolves a temporary ID to the issue's number", () => {
    const context: ReduceContext = {
      ...noIssues,
      parentOf: (id) => (id === "34" ? null : undefined),
      resolve: (id) => (id === "jun-b3f2-0001" ? "34" : id),
    };
    const next = ok(reduce(created(), op(jun, "open_sub_issue", { sub_issue: "jun-b3f2-0001" }), context));
    assert.deepEqual([...next.subIssues.values()].map((sub) => sub.childId), ["34"]);
  });

  test("each applied operation advances the version by one, even when it changes nothing else", () => {
    let issue = created();
    issue = ok(reduce(issue, op(jun, "add_label", { label: "huddle" }), noIssues));
    issue = ok(reduce(issue, op(jun, "add_label", { label: "huddle" }), noIssues));
    assert.deepEqual(issue.labels, ["huddle"]);
    assert.equal(issue.version, 3);
  });

  test("the reducer never mutates its input, and untouched collections keep their identity", () => {
    const before = created();
    const snapshot = structuredClone(before);
    const after = ok(reduce(before, op(jun, "comment", { body: "First" }), noIssues));
    assert.deepEqual(before, snapshot);
    assert.notEqual(after.comments, before.comments);
    assert.equal(after.threads, before.threads);
    assert.equal(after.assignments, before.assignments);
  });

  test("edit_comment keeps the earlier text; an unknown comment is rejected", () => {
    const comment = op(jun, "comment", { body: "A limit of five" });
    let issue = ok(reduce(created(), comment, noIssues));
    issue = ok(reduce(issue, op(jun, "edit_comment", { comment: comment.op_id, body: "A limit of two" }), noIssues));
    const stored = issue.comments.get(comment.op_id);
    assert.equal(stored?.body, "A limit of two");
    assert.deepEqual(
      stored?.revisions.map((r) => r.body),
      ["A limit of five", "A limit of two"],
    );
    rejected(reduce(issue, op(jun, "edit_comment", { comment: "jun-web-9999", body: "x" }), noIssues), "unknown_comment");
    rejected(reduce(issue, op(jun, "mention", { mentioned: priya, comment: "jun-web-9999" }), noIssues), "unknown_comment");
  });

  test("threads take replies until resolved; unknown and resolved threads are rejected", () => {
    const open = op(jun, "open_thread", { body: "Five still joins strangers", needs: ["priya"] });
    let issue = ok(reduce(created(), open, noIssues));
    issue = ok(reduce(issue, op(priya, "reply_thread", { thread: open.op_id, body: "Lowering it" }), noIssues));
    issue = ok(reduce(issue, op(jun, "resolve_thread", { thread: open.op_id, reason: "Limit is two" }), noIssues));
    const thread = issue.threads.get(open.op_id);
    assert.deepEqual(thread?.participants, ["jun", "priya"]);
    assert.equal(thread?.status, "resolved");
    assert.equal(thread?.resolvedBy, "jun");
    rejected(
      reduce(issue, op(priya, "reply_thread", { thread: open.op_id, body: "More" }), noIssues),
      "thread_resolved",
    );
    rejected(reduce(issue, op(priya, "resolve_thread", { thread: "jun-web-9999" }), noIssues), "unknown_thread");
  });

  test("a thread Penguin opened for a request for changes is resolved by its people only", () => {
    let issue = ok(reduce(created(), op(priya, "add_label", { label: "scope:analytics" }), noIssues));
    const review = op(jun, "review", {
      verdict: "request_changes",
      commit: "owner-priya@9b2f10",
      reason: "A limit of five still joins the tablet's users.",
    });
    issue = ok(reduce(issue, review, noIssues));
    const anchor = `review:${review.op_id}`;
    const open = op({ penguin: true }, "open_thread", { body: "A limit of five", anchor, needs: ["priya"] });
    issue = ok(reduce(issue, open, noIssues));
    const resolve = (author: Author) => reduce(issue, op(author, "resolve_thread", { thread: open.op_id }), noIssues);
    rejected(resolve({ person: "sam" }), "not_thread_participant");
    rejected(resolve({ identity: "@priya/merge-rules" }), "not_thread_participant");
    // Jun wrote the review the thread answers; Priya is the person it needs.
    assert.equal(ok(resolve(jun)).threads.get(open.op_id)?.resolvedBy, "jun");
    assert.equal(ok(resolve(priya)).threads.get(open.op_id)?.status, "resolved");
  });

  test("open_sub_issue rejects itself, unknown issues, issues with a parent, and cycles", () => {
    const parents = new Map<string, string | null>([
      ["31", null],
      ["32", "31"],
      ["33", "32"],
      ["40", null],
    ]);
    const context: ReduceContext = { ...noIssues, parentOf: (id) => parents.get(id) };
    const issue = { ...created(), parentId: "32" };
    rejected(reduce(issue, op(jun, "open_sub_issue", { sub_issue: 33 }), context), "sub_issue_self");
    rejected(reduce(issue, op(jun, "open_sub_issue", { sub_issue: 99 }), context), "sub_issue_unknown");
    rejected(reduce(issue, op(jun, "open_sub_issue", { sub_issue: 32 }), context), "sub_issue_has_parent");
    rejected(reduce(issue, op(jun, "open_sub_issue", { sub_issue: 31 }), context), "sub_issue_cycle");
    const next = ok(reduce(issue, op(jun, "open_sub_issue", { sub_issue: 40 }), context));
    assert.deepEqual([...next.subIssues.keys()], ["40"]);
  });

  test("assign and unassign keep one assignment per party; change_state records its reason", () => {
    let issue = created();
    issue = ok(reduce(issue, op(jun, "assign", { assignee: { identity: "@jun/reports" } }), noIssues));
    issue = ok(reduce(issue, op(jun, "assign", { assignee: { identity: "@jun/reports" } }), noIssues));
    assert.equal(issue.assignments.size, 1);
    issue = ok(reduce(issue, op(jun, "unassign", { assignee: { identity: "@jun/reports" } }), noIssues));
    assert.equal(issue.assignments.size, 0);
    issue = ok(reduce(issue, op(jun, "change_state", { state: "closed", reason: "cancelled" }), noIssues));
    assert.equal(issue.state, "closed");
    assert.equal(issue.stateReason, "cancelled");
  });

  test("send_upstream comes only from an assigned identity and changes nothing but the version", () => {
    const reports: Author = { identity: "@jun/reports" };
    const assigned = ok(reduce(created(), op(jun, "assign", { assignee: reports }), noIssues));
    const upstream = (author: Author): Operation => op(author, "send_upstream", { reason: "Belongs in the merge rules." });
    const sent = ok(reduce(assigned, upstream(reports), noIssues));
    assert.deepEqual({ ...sent, version: assigned.version }, assigned);
    assert.equal(sent.version, assigned.version + 1);
    rejected(reduce(assigned, upstream({ identity: "@sam/campaigns" }), noIssues), "not_assignee");
    // A person, even an assigned one, sends nothing upstream: only an agent session does.
    const junAssigned = ok(reduce(assigned, op(jun, "assign", { assignee: jun }), noIssues));
    rejected(reduce(junAssigned, upstream(jun), noIssues), "not_assignee");
  });

  test("a review counts only from the owner of a labelled scope; any other review is kept without counting", () => {
    let issue = ok(reduce(created(), op(jun, "add_label", { label: "scope:identity-map" }), noIssues));
    const review = (author: Author): Operation =>
      op(author, "review", { verdict: "approve", commit: "owner-priya@9b2f10", reason: "Two is the cap." });
    const owner = review(priya);
    const other = review(jun);
    const identity = review({ identity: "@priya/merge-rules" });
    for (const operation of [owner, other, identity]) issue = ok(reduce(issue, operation, noIssues));
    assert.deepEqual(issue.reviews.get(owner.op_id), {
      opId: owner.op_id,
      reviewerOwnerId: "priya",
      verdict: "approve",
      reason: "Two is the cap.",
      repo: "owner-priya",
      sha: "9b2f10",
      counts: true,
      uncountedReason: null,
      countsFor: ["priya"],
    });
    assert.equal(issue.reviews.get(other.op_id)?.counts, false);
    assert.deepEqual(issue.reviews.get(other.op_id)?.countsFor, []);
    assert.match(issue.reviews.get(other.op_id)?.uncountedReason ?? "", /jun owns no scope labelled/u);
    assert.equal(issue.reviews.get(identity.op_id)?.counts, false);
    const identityReason = issue.reviews.get(identity.op_id)?.uncountedReason ?? "";
    assert.match(identityReason, /identity @priya\/merge-rules cannot review/u);
  });

  test("a delegate's review counts for the owner who named the delegate", () => {
    const issue = ok(reduce(created(), op(jun, "add_label", { label: "scope:identity-map" }), noIssues));
    const review = op({ person: "lee" }, "review", { verdict: "approve", commit: "owner-priya@9b2f10" });
    const delegated = { ...noIssues, delegates: new Map([["priya", "lee"]]) };
    const counted = ok(reduce(issue, review, delegated)).reviews.get(review.op_id);
    assert.deepEqual([counted?.reviewerOwnerId, counted?.counts, counted?.countsFor], ["lee", true, ["priya"]]);
    const uncounted = ok(reduce(issue, review, noIssues)).reviews.get(review.op_id);
    assert.deepEqual([uncounted?.counts, uncounted?.countsFor], [false, []]);
  });

  test("a link from Penguin marks the checks it names superseded; nobody else may, and each must exist", () => {
    const penguin: Author = { penguin: true };
    const check = op(penguin, "attach_check", { command_id: "test:analytics", commit: "huddle-031@aaaaaa", result: "fail" });
    let issue = ok(reduce(created(), check, noIssues));
    assert.equal(issue.checks.get(check.op_id)?.supersededBy, null);

    const fromJun = op(jun, "link_commit", { commit: "owner-jun@bbbbbb", kind: "fix", supersedes: [check.op_id] });
    rejected(reduce(issue, fromJun, noIssues), "supersede_forbidden");
    const unknown = op(penguin, "link_commit", { commit: "owner-jun@bbbbbb", supersedes: ["penguin-web-9999"] });
    rejected(reduce(issue, unknown, noIssues), "unknown_check");

    const link = op(penguin, "link_commit", { commit: "owner-jun@bbbbbb", kind: "fix", supersedes: [check.op_id] });
    issue = ok(reduce(issue, link, noIssues));
    assert.equal(issue.checks.get(check.op_id)?.supersededBy, link.op_id);
    // A later link leaves the first marking in place.
    const later = op(penguin, "link_commit", { commit: "owner-jun@cccccc", supersedes: [check.op_id] });
    assert.equal(ok(reduce(issue, later, noIssues)).checks.get(check.op_id)?.supersededBy, link.op_id);
  });
});
