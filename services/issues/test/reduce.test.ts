import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatOpId, type Author, type IssueId, type Operation } from "@penguin/protocol";

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

const noIssues: ReduceContext = { parentOf: () => undefined };

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

  test("a create may use a string issue id only when it is its own op_id", () => {
    const create = op(priya, "create", { title: "Offline" }, "x");
    rejected(reduce(undefined, { ...create, issue: "priya-web-9999" }, noIssues), "create_id_mismatch");
    assert.equal(ok(reduce(undefined, { ...create, issue: create.op_id }, noIssues)).id, create.op_id);
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

  test("open_sub_issue rejects itself, unknown issues, issues with a parent, and cycles", () => {
    const parents = new Map<string, string | null>([
      ["31", null],
      ["32", "31"],
      ["33", "32"],
      ["40", null],
    ]);
    const context: ReduceContext = { parentOf: (id) => parents.get(id) };
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
});
