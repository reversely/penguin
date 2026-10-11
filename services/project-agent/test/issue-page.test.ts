import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { generateSigningKeyPair, signOperation, type FixApproval } from "@penguin/issues";
import { operationPath, RUNNER_INTERVAL_MS, type Author, type Operation } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { IdentityStore } from "../src/identity-store.ts";
import { IssueIndex, type OperationKeys } from "../src/issue-index.ts";
import { buildIssuePage } from "../src/issue-page.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { SessionStore } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

const penguin: Author = { penguin: true };
const jun: Author = { person: "jun" };

let service: ServiceKey;
let stranger: CryptoKeyPair;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  stranger = await generateSigningKeyPair();
});

/** The index and the session router over one database, wired as the ProjectAgent wires them. */
function project() {
  const { sql } = sqlite();
  const identities = new IdentityStore(sql, () => "identity-1");
  const timelineChanges: string[] = [];
  let sessions: SessionStore | undefined;
  const index = new IssueIndex(sql, {
    assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
    timelineChanged: (issueId) => timelineChanges.push(issueId),
  });
  sessions = new SessionStore(sql, identities, {
    newId: () => "session-1",
    assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
  });
  const keys: OperationKeys = { bridges: [], serviceKey: service.publicKey, scopeMap, identities };
  const store = sessions;
  const approvals = new Map<string, FixApproval>();
  const page = (id: string) =>
    buildIssuePage(
      {
        read: (issueId) => index.read(issueId),
        issue: (issueId) => index.issue(issueId),
        routes: (issueId) => store.routes(issueId),
        session: (sessionId) => store.get(sessionId),
        approval: (issueId) => approvals.get(issueId),
      },
      id,
    );
  const submit = async (author: Author, issue: number, type: string, payload: Record<string, unknown>) => {
    const outcome = await index.submit({
      operation: { issue, type, base_version: index.issue(String(issue))?.version ?? 0, payload },
      author,
      source: "penguin" in author ? "penguin" : "dashboard",
      signingKey: service.privateKey,
      keys,
    });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  };
  return { index, identities, sessions: store, keys, page, submit, timelineChanges, approvals };
}

test("the page carries the issue, its sub-issues with sessions and reviews, and its timeline as plain JSON", async () => {
  const { identities, sessions, page, submit } = project();
  identities.create("jun", { handle: "@jun/reports", name: "Reports", job: "Fix reports", charterScopes: ["analytics"], autoAccept: true }, scopeMap);
  const session = sessions.register("jun", {
    identity: "@jun/reports",
    vendor: "codex",
    worktreeId: "wt_0123456789abcdef",
    branch: "reports/retention",
  });
  assert.equal(session.status, "ok");

  await submit(penguin, 31, "create", { title: "Identity map change breaks analytics", body: "<script>x</script>" });
  await submit(penguin, 31, "add_label", { label: "scope:analytics" });
  await submit(penguin, 31, "link_commit", { commit: "owner-priya@7c41e2", kind: "trigger" });
  await submit(penguin, 31, "attach_check", {
    command_id: "analytics",
    commit: "huddle-031@7c41e2",
    test: "test_retention::dau_stable",
    result: "fail",
  });
  await submit(penguin, 32, "create", { title: "Retention metrics" });
  await submit(penguin, 32, "add_label", { label: "scope:analytics" });
  await submit(penguin, 32, "assign", { assignee: { identity: "@jun/reports" } });
  await submit(penguin, 32, "attach_check", {
    command_id: "analytics",
    commit: "huddle-031@9d0e11",
    test: "test_retention::dau_stable",
    result: "pass",
  });
  await submit(jun, 32, "review", { verdict: "approve", commit: "owner-jun@9d0e11" });
  await submit(penguin, 31, "open_sub_issue", { sub_issue: 32 });

  const read = page("31");
  assert.ok(read !== undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), read, "no Map or other value JSON would drop");
  assert.equal(read.issue.body, "<script>x</script>");
  assert.deepEqual(read.issue.labels, ["scope:analytics"]);
  assert.deepEqual(
    read.issue.commits.map((commit) => [commit.kind, commit.repo, commit.sha, commit.linkedBy]),
    [["trigger", "owner-priya", "7c41e2", "penguin"]],
  );
  assert.deepEqual(
    read.issue.checks.map((check) => [check.commandId, check.test, check.result, check.sha]),
    [["analytics", "test_retention::dau_stable", "fail", "7c41e2"]],
  );
  assert.equal(read.subIssues.length, 1);
  const [child] = read.subIssues;
  assert.equal(child?.title, "Retention metrics");
  assert.deepEqual(child?.assignees, [
    {
      kind: "identity",
      id: "@jun/reports",
      session: { id: "session-1", vendor: "codex", branch: "reports/retention", status: "running" },
      waitingFor: null,
    },
  ]);
  assert.deepEqual(
    child?.reviews.map((review) => [review.reviewer, review.verdict, review.counts]),
    [["jun", "approve", true]],
  );
  assert.deepEqual(
    child?.checks.map((check) => check.result),
    ["pass"],
  );
  // No HuddleAgent reported an approval for this sub-issue.
  assert.equal(child?.approval, null);
  assert.deepEqual(
    read.timeline.map((entry) => [entry.type, entry.status, entry.waitingForGitLog]),
    [
      ["create", "applied", true],
      ["add_label", "applied", true],
      ["link_commit", "applied", true],
      ["attach_check", "applied", true],
      ["open_sub_issue", "applied", true],
    ],
  );
  assert.equal(page("99"), undefined);
});

test("a rejected file and a pushed pending operation each change the timeline and are announced", async () => {
  const { index, keys, page, submit, timelineChanges } = project();
  await submit(jun, 40, "create", { title: "Board filter drops identities" });
  await submit(jun, 40, "comment", { body: "Seen on the tablet too" });

  const forged = await signOperation(
    {
      schema_version: 1,
      op_id: "jun-b3f2-0001",
      issue: 40,
      type: "comment",
      author: jun,
      base_version: 2,
      payload: { body: "Signed by a key Penguin never registered" },
    },
    stranger.privateKey,
  );
  const rejected = await index.apply({ file: JSON.stringify(forged), gitCommit: "c0ffee", path: operationPath(forged), keys });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(timelineChanges, ["40"]);

  const listing = index.pendingFiles({ bridgeId: "runner", role: "runner" });
  assert.equal(listing.status, "ok");
  const comment = listing.status === "ok" ? listing.files[1] : undefined;
  assert.ok(comment !== undefined);
  const pushed = JSON.parse(comment.file) as Operation;
  assert.equal((await index.apply({ file: comment.file, gitCommit: "d00d", path: comment.path, keys })).status, "duplicate");
  assert.equal(pushed.type, "comment");
  assert.deepEqual(timelineChanges, ["40", "40"]);

  const timeline = page("40")?.timeline ?? [];
  assert.deepEqual(
    timeline.map((entry) => [entry.type, entry.status, entry.rejectReason, entry.waitingForGitLog]),
    [
      ["create", "applied", null, true],
      ["comment", "applied", null, false],
      ["comment", "rejected", "bad_signature", false],
    ],
  );
});

test("each unpushed operation carries how long it has waited for the runner", async () => {
  const { index, keys, page } = project();
  const at = Date.parse("2026-10-11T09:00:00Z");
  const write = async (type: string, payload: Record<string, unknown>, now: number) =>
    index.submit({
      operation: { issue: 40, type, base_version: index.issue("40")?.version ?? 0, payload },
      author: jun,
      source: "dashboard",
      signingKey: service.privateKey,
      keys,
      now,
    });
  await write("create", { title: "Board filter drops identities" }, at);
  await write("comment", { body: "Seen on the tablet too" }, at + 4000);
  const listing = index.pendingFiles({ bridgeId: "runner", role: "runner" });
  const created = listing.status === "ok" ? listing.files[0] : undefined;
  assert.ok(created !== undefined);
  await index.apply({ file: created.file, gitCommit: "c0ffee", path: created.path, keys });

  const read = buildIssuePage(
    {
      read: (issueId) => index.read(issueId),
      issue: (issueId) => index.issue(issueId),
      routes: () => [],
      session: () => undefined,
      now: () => at + 15_000,
    },
    "40",
  );
  assert.deepEqual(
    read?.timeline.map((entry) => [entry.type, entry.waitingForGitLog, entry.waitedMs]),
    [
      ["create", false, null],
      ["comment", true, 11_000],
    ],
  );
  assert.equal(read?.runnerInterval, RUNNER_INTERVAL_MS);
  assert.equal(page("40")?.runnerInterval, RUNNER_INTERVAL_MS);
});

test("a sub-issue carries the approval its HuddleAgent recorded", async () => {
  const { page, submit, approvals } = project();
  await submit(penguin, 31, "create", { title: "Identity map change breaks analytics" });
  await submit(penguin, 32, "create", { title: "Shared-device merge" });
  await submit(penguin, 31, "open_sub_issue", { sub_issue: 32 });
  const approval: FixApproval = {
    head: "owner-priya@9b2f10",
    owners: [
      { owner: "jun", state: "approved", reviewer: "jun", reviewOpId: "jun-web-0001", reason: null },
      { owner: "priya", state: "pending", reviewer: null, reviewOpId: null, reason: null },
    ],
    approved: false,
  };
  approvals.set("32", approval);
  assert.deepEqual(page("31")?.subIssues[0]?.approval, approval);
});
