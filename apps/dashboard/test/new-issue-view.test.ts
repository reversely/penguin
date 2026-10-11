import assert from "node:assert/strict";
import { test } from "node:test";

import type { WriteOutcome } from "../src/api.ts";
import {
  assignChoices,
  assignOperation,
  newIssueProblem,
  nextIssueNumber,
  openIssue,
  type DashboardOperation,
} from "../src/new-issue-view.ts";

/** A stand-in for /api/operations over an in-memory set of issues and their versions. */
function fakeProject(existing: readonly string[], options: { rejectAssign?: string; failAssign?: string; raceOnce?: boolean } = {}) {
  const versions = new Map(existing.map((id) => [id, 1]));
  const sent: DashboardOperation[] = [];
  let raced = false;
  let seq = 0;
  const applied = (issueId: string): WriteOutcome => {
    const version = (versions.get(issueId) ?? 0) + 1;
    versions.set(issueId, version);
    return { status: "applied", opId: `priya-web-${String(++seq).padStart(4, "0")}`, issueId, version };
  };
  return {
    sent,
    issueIds: async () => [...versions.keys()],
    submit: async (operation: DashboardOperation): Promise<WriteOutcome> => {
      sent.push(operation);
      const issueId = String(operation.issue);
      const handle = (operation.payload["assignee"] as { identity?: string } | undefined)?.identity;
      if (operation.type === "create") {
        // Someone else opens the same number between the board read and the create.
        if (options.raceOnce && !raced) {
          raced = true;
          versions.set(issueId, 1);
        }
        if (versions.has(issueId)) return { status: "rejected", reason: "issue_exists", message: `issue ${issueId} already exists` };
        return applied(issueId);
      }
      if (handle !== undefined && handle === options.failAssign) throw new Error("network down");
      if (handle !== undefined && handle === options.rejectAssign) return { status: "rejected", reason: "malformed", message: "bad" };
      if (operation.base_version !== versions.get(issueId)) return { status: "rejected", reason: "superseded_version", message: "" };
      return applied(issueId);
    },
  };
}

test("a new issue takes the number after the highest on the board; temporary IDs do not count", () => {
  assert.equal(nextIssueNumber([]), 1);
  assert.equal(nextIssueNumber(["3", "41", "7"]), 42);
  assert.equal(nextIssueNumber(["2", "jun-a1b2-0001"]), 3);
});

test("a title is required; a blank one is refused before anything is sent", () => {
  assert.equal(newIssueProblem({ title: "  " }), "Please enter a title");
  assert.equal(newIssueProblem({ title: "Retention counts" }), undefined);
});

test("Create sends a create, then one assign per identity on the version the last write left", async () => {
  const project = fakeProject(["40"]);
  const opened = await openIssue(
    { title: "  <b>Retention</b> counts  ", body: "Steps", assignees: ["@jun/reports", "@priya/merge-rules"] },
    project,
  );
  assert.deepEqual(opened, {
    status: "opened",
    issueId: "41",
    opIds: ["priya-web-0001", "priya-web-0002", "priya-web-0003"],
    unassigned: [],
  });
  assert.deepEqual(project.sent, [
    { issue: 41, type: "create", base_version: 0, payload: { title: "<b>Retention</b> counts", body: "Steps" } },
    { issue: 41, type: "assign", base_version: 1, payload: { assignee: { identity: "@jun/reports" } } },
    { issue: 41, type: "assign", base_version: 2, payload: { assignee: { identity: "@priya/merge-rules" } } },
  ]);
});

test("a blank body is left out of the create", async () => {
  const project = fakeProject([]);
  await openIssue({ title: "Cohorts", body: " \n", assignees: [] }, project);
  assert.deepEqual(project.sent, [{ issue: 1, type: "create", base_version: 0, payload: { title: "Cohorts" } }]);
});

test("when another person took the number first, the form reads the board again and takes the next", async () => {
  const project = fakeProject(["40"], { raceOnce: true });
  const opened = await openIssue({ title: "Cohorts", body: "", assignees: [] }, project);
  assert.equal(opened.status === "opened" ? opened.issueId : opened.reason, "42");
  assert.deepEqual(
    project.sent.map((operation) => operation.issue),
    [41, 42],
  );
});

test("a create rejected for another reason is reported and nothing is assigned", async () => {
  const project = fakeProject([]);
  project.submit = async (operation) => {
    project.sent.push(operation);
    return { status: "rejected", reason: "malformed", message: "/payload/title too long" };
  };
  const opened = await openIssue({ title: "Cohorts", body: "", assignees: ["@jun/reports"] }, project);
  assert.deepEqual(opened, { status: "rejected", reason: "malformed" });
  assert.equal(project.sent.length, 1);
});

test("an assign that fails leaves the issue open and names the identities left unassigned", async () => {
  const rejected = await openIssue(
    { title: "Cohorts", body: "", assignees: ["@jun/reports", "@sam/on-call"] },
    fakeProject([], { rejectAssign: "@jun/reports" }),
  );
  assert.deepEqual(rejected.status === "opened" ? rejected.unassigned : undefined, ["@jun/reports"]);

  // A write that never answers stops the assigns: the issue exists, so Create must not be pressed again.
  const failed = await openIssue(
    { title: "Cohorts", body: "", assignees: ["@jun/reports", "@sam/on-call"] },
    fakeProject([], { failAssign: "@jun/reports" }),
  );
  assert.deepEqual(failed.status === "opened" ? failed.unassigned : undefined, ["@jun/reports", "@sam/on-call"]);
});

test("the issue page assigns and unassigns people and identities on the issue's version", () => {
  assert.deepEqual(assignOperation("41", 3, "assign", { kind: "identity", id: "@jun/reports" }), {
    issue: 41,
    type: "assign",
    base_version: 3,
    payload: { assignee: { identity: "@jun/reports" } },
  });
  assert.deepEqual(assignOperation("41", 4, "unassign", { kind: "person", id: "jun" }), {
    issue: 41,
    type: "unassign",
    base_version: 4,
    payload: { assignee: { person: "jun" } },
  });
});

test("the assign choices leave out the identities already assigned", () => {
  const assignees = [
    { kind: "identity", id: "@jun/reports" },
    { kind: "person", id: "priya" },
  ] as const;
  assert.deepEqual(assignChoices(["@jun/reports", "@priya/merge-rules", "@sam/on-call"], assignees), [
    "@priya/merge-rules",
    "@sam/on-call",
  ]);
});
