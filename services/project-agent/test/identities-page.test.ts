import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import type { Author } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { buildIdentitiesPage, identityWriteOutcome } from "../src/identities-page.ts";
import { IDENTITY_LIMITS, IdentityStore } from "../src/identity-store.ts";
import { IssueIndex, type OperationKeys } from "../src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { SessionStore } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const START = Date.parse("2026-10-10T12:00:00Z");

let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

/** The index, identities and session router over one database, as the ProjectAgent wires them. */
function project() {
  const { sql } = sqlite();
  let clock = START;
  let nextIdentity = 0;
  let nextSession = 0;
  const identities = new IdentityStore(sql, () => `identity-${++nextIdentity}`);
  let sessions: SessionStore | undefined;
  const index = new IssueIndex(sql, {
    assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
  });
  sessions = new SessionStore(sql, identities, {
    now: () => clock,
    newId: () => `session-${++nextSession}`,
    assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
  });
  const store = sessions;
  const keys: OperationKeys = { bridges: [], serviceKey: service.publicKey, scopeMap, identities };
  const submit = async (author: Author, issue: number, type: string, payload: Record<string, unknown>) => {
    const outcome = await index.submit({
      operation: { issue, type, base_version: index.issue(String(issue))?.version ?? 0, payload },
      author,
      source: "person" in author ? "dashboard" : "mcp",
      signingKey: service.privateKey,
      keys,
    });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  };
  const page = (perIdentity = 10) =>
    buildIdentitiesPage({
      identities: () => identities.list(),
      sessions: () => store.byIdentity(perIdentity),
      history: () => index.identityHistory(),
      issue: (issueId) => index.issue(issueId),
      scopeMap,
    });
  return { identities, sessions: store, submit, page, advance: (ms: number) => (clock += ms) };
}

const reports = {
  handle: "@jun/reports",
  name: "Reports",
  job: "Build a retention dashboard keyed on user_id",
  avatar: { mediaType: "image/png" as const, data: PNG },
  charterScopes: ["analytics"],
  charterPaths: ["analytics/retention"],
  charterRules: ["Never change ingestion code", "Ask Priya before a backfill"],
  autoAccept: true,
};

test("lists each identity with every field, its owners and the scopes and owners to choose from", () => {
  const p = project();
  assert.equal(p.identities.create("jun", reports, scopeMap).status, "ok");
  const team = p.identities.createTeam(
    "sam",
    { handle: "@sam/oncall", name: "On call", job: "Triage", charterScopes: ["messaging", "analytics"], owners: ["sam", "jun"] },
    scopeMap,
  );
  assert.equal(team.status, "ok");

  const page = p.page();
  assert.deepEqual(page.identities[0], {
    id: "identity-1",
    handle: "@jun/reports",
    name: "Reports",
    avatar: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    job: reports.job,
    team: false,
    owners: ["jun"],
    charterScopes: ["analytics"],
    charterPaths: ["analytics/retention"],
    charterRules: reports.charterRules,
    autoAccept: true,
    duplicatedFrom: null,
    sessions: [],
    history: [],
  });
  assert.equal(page.identities[1]?.team, true);
  assert.deepEqual(page.identities[1]?.owners, ["sam", "jun"]);
  assert.deepEqual(page.scopes, [
    { id: "identity-map", name: "Ingestion and identity map", ownerId: "priya", testCommand: "python -m pytest ingestion" },
    { id: "analytics", name: "Analytics models", ownerId: "jun", testCommand: "python -m pytest analytics" },
    { id: "messaging", name: "Messaging and CRM sync", ownerId: "sam", testCommand: "python -m pytest messaging" },
  ]);
  assert.deepEqual(page.owners, ["jun", "priya", "sam"]);
  assert.deepEqual(page.limits, IDENTITY_LIMITS);
  // Plain JSON for Durable Object RPC and the API: no bytes, no class instances.
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
});

test("shows each identity's sessions, running and offline, most recent first", () => {
  const p = project();
  p.identities.create("jun", reports, scopeMap);
  const first = p.sessions.register("jun", { identity: "@jun/reports", vendor: "codex", worktreeId: "wt1", branch: "a" });
  assert.equal(first.status, "ok");
  p.advance(200_000); // the first session goes offline
  p.sessions.register("jun", { identity: "@jun/reports", vendor: "claude-code", worktreeId: "wt2", branch: "b" });

  const sessions = p.page().identities[0]?.sessions;
  assert.deepEqual(
    sessions?.map(({ id, vendor, branch, status }) => ({ id, vendor, branch, status })),
    [
      { id: "session-2", vendor: "claude-code", branch: "b", status: "running" },
      { id: "session-1", vendor: "codex", branch: "a", status: "offline" },
    ],
  );
  assert.equal(p.page(1).identities[0]?.sessions.length, 1);
});

test("an identity's issue history holds the issues it was assigned or wrote on, newest first", async () => {
  const p = project();
  p.identities.create("jun", reports, scopeMap);
  p.identities.create("priya", { handle: "@priya/merge-rules", name: "Merge rules", job: "Merge", charterScopes: ["identity-map"] }, scopeMap);
  await p.submit({ person: "priya" }, 1, "create", { title: "Retention shifts" });
  await p.submit({ person: "priya" }, 1, "assign", { assignee: { identity: "@jun/reports" } });
  await p.submit({ person: "priya" }, 2, "create", { title: "Shared device" });
  await p.submit({ person: "priya" }, 2, "assign", { assignee: { identity: "@jun/reports" } });
  await p.submit({ person: "priya" }, 2, "unassign", { assignee: { identity: "@jun/reports" } });
  await p.submit({ person: "priya" }, 3, "create", { title: "Someone else's" });
  await p.submit({ person: "priya" }, 3, "assign", { assignee: { identity: "@priya/merge-rules" } });
  await p.submit({ identity: "@jun/reports" }, 3, "comment", { body: "Seen from analytics" });

  const page = p.page();
  const history = (handle: string) => page.identities.find((identity) => identity.handle === handle)?.history;
  assert.deepEqual(history("@jun/reports"), [
    { issueId: "3", title: "Someone else's", state: "open" },
    { issueId: "2", title: "Shared device", state: "open" },
    { issueId: "1", title: "Retention shifts", state: "open" },
  ]);
  assert.deepEqual(history("@priya/merge-rules")?.map((entry) => entry.issueId), ["3"]);
});

test("a duplicate carries the charter over, names its original and starts with no history", async () => {
  const p = project();
  p.identities.create("jun", reports, scopeMap);
  await p.submit({ person: "priya" }, 1, "create", { title: "Retention shifts" });
  await p.submit({ person: "priya" }, 1, "assign", { assignee: { identity: "@jun/reports" } });
  const copy = p.identities.duplicate("jun", "identity-1", { handle: "@jun/reports-copy" });
  assert.deepEqual(identityWriteOutcome(copy), { status: "ok", id: "identity-2", handle: "@jun/reports-copy" });

  const [original, duplicate] = p.page().identities;
  assert.equal(duplicate?.duplicatedFrom, "@jun/reports");
  assert.deepEqual(
    [duplicate?.charterScopes, duplicate?.charterPaths, duplicate?.charterRules, duplicate?.autoAccept],
    [original?.charterScopes, original?.charterPaths, original?.charterRules, original?.autoAccept],
  );
  assert.deepEqual(duplicate?.history, []);
  assert.equal(original?.history.length, 1);
});

test("a write outcome drops the identity and keeps a rejection as it is", () => {
  const p = project();
  p.identities.create("jun", reports, scopeMap);
  const denied = p.identities.edit("priya", "identity-1", { name: "Mine now" }, scopeMap);
  assert.deepEqual(identityWriteOutcome(denied), denied);
  assert.equal(identityWriteOutcome(denied).status, "rejected");
});
