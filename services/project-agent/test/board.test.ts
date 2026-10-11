import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { parseIndexChanged, type Author } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { buildBoard } from "../src/board.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { IssueIndex, type OperationKeys } from "../src/issue-index.ts";
import { LiveFeed } from "../src/live-feed.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { SESSION_OFFLINE_AFTER_MS, SessionStore } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const START = Date.parse("2026-10-10T12:00:00Z");
const penguin: Author = { penguin: true };

let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

/**
 * The index, identities and session router over one database, wired to a live feed the way the
 * ProjectAgent wires them. The feed's sends run when the test calls `flush`.
 */
function project() {
  const { sql } = sqlite();
  let clock = START;
  let nextIdentity = 0;
  let nextSession = 0;
  const sent: string[] = [];
  const tasks: (() => void)[] = [];
  const feed = new LiveFeed(
    (message) => sent.push(message),
    (task) => tasks.push(task),
  );
  const identities = new IdentityStore(sql, () => `identity-${++nextIdentity}`);
  let sessions: SessionStore | undefined;
  const index = new IssueIndex(sql, {
    assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
    issueChanged: (change) => feed.issueChanged(change.issueId),
  });
  sessions = new SessionStore(sql, identities, {
    now: () => clock,
    newId: () => `session-${++nextSession}`,
    assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    listener: {
      sessionChanged: (handle) => feed.sessionChanged(handle),
      routeChanged: (issueId) => feed.issueChanged(issueId),
    },
  });
  const store = sessions;
  const keys: OperationKeys = { bridges: [], serviceKey: service.publicKey, scopeMap, identities };
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
  const board = () =>
    buildBoard({
      ids: () => index.ids(),
      issue: (issueId) => index.issue(issueId),
      identities: () => identities.list(),
      running: () => store.running(),
      routes: (issueId) => store.routes(issueId),
      session: (sessionId) => store.get(sessionId),
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    });
  /** The live messages sent since the last call, as issues and sessions. */
  const messages = () => {
    tasks.splice(0).forEach((task) => task());
    return sent.splice(0).map((message) => {
      const parsed = parseIndexChanged(message);
      return { issues: parsed?.issues, sessions: parsed?.sessions };
    });
  };
  return {
    identities,
    sessions: store,
    submit,
    board,
    messages,
    advance: (ms: number) => (clock += ms),
  };
}

function seedIdentities(p: ReturnType<typeof project>) {
  const create = (owner: string, handle: string, scope: string, extra: object = {}) =>
    assert.equal(
      p.identities.create(owner, { handle, name: handle.slice(handle.indexOf("/") + 1), job: "Fix", charterScopes: [scope], autoAccept: true, ...extra }, scopeMap).status,
      "ok",
    );
  create("jun", "@jun/reports", "analytics", { avatar: { mediaType: "image/png", data: PNG } });
  create("priya", "@priya/merge-rules", "identity-map");
  create("sam", "@sam/campaigns", "messaging");
  const team = p.identities.createTeam(
    "jun",
    { handle: "@jun/data-pair", name: "Data pair", job: "Pair", charterScopes: ["analytics", "identity-map"], autoAccept: true, owners: ["jun", "priya"] },
    scopeMap,
  );
  assert.equal(team.status, "ok");
}

test("the board lists every issue and each owner's identities with their running sessions", async () => {
  const p = project();
  seedIdentities(p);
  const session = p.sessions.register("jun", { identity: "@jun/reports", vendor: "codex", worktreeId: "wt_1", branch: "reports/retention" });
  assert.equal(session.status, "ok");
  p.sessions.register("priya", { identity: "@priya/merge-rules", vendor: "claude-code", worktreeId: "wt_2", branch: "rules" });

  await p.submit(penguin, 31, "create", { title: "<img src=x onerror=alert(1)> identity map" });
  await p.submit(penguin, 31, "change_state", { state: "detected", reason: "combined tests fail" });
  await p.submit(penguin, 32, "create", { title: "Retention metrics" });
  await p.submit(penguin, 32, "assign", { assignee: { identity: "@jun/reports" } });
  await p.submit(penguin, 31, "open_sub_issue", { sub_issue: 32 });
  await p.submit({ person: "priya" }, 33, "create", { title: "Pair work" });
  await p.submit({ person: "priya" }, 33, "assign", { assignee: { identity: "@jun/data-pair" } });
  await p.submit({ person: "sam" }, 34, "create", { title: "Consent" });
  await p.submit({ person: "sam" }, 34, "assign", { assignee: { person: "sam" } });

  const board = p.board();
  // Plain JSON: what Durable Object RPC and Response.json send is what the dashboard reads.
  assert.deepEqual(JSON.parse(JSON.stringify(board)), board);
  assert.deepEqual(
    board.issues.map((entry) => [entry.issue.id, entry.issue.state, entry.laneOwners]),
    [
      ["31", "detected", {}],
      ["32", "open", { "@jun/reports": ["jun"] }],
      // A team identity's card goes to the owner who assigned it.
      ["33", "open", { "@jun/data-pair": ["priya"] }],
      ["34", "open", { sam: ["sam"] }],
    ],
  );
  assert.equal(board.issues[0]?.issue.title, "<img src=x onerror=alert(1)> identity map");
  assert.deepEqual(
    board.issues[0]?.subIssues.map((sub) => [sub.id, sub.assignees[0]?.session?.id]),
    [["32", "session-1"]],
  );
  assert.deepEqual(
    board.owners.map((owner) => [
      owner.id,
      owner.identities.map((entry) => [entry.handle, entry.team, entry.sessions.map((s) => s.branch)]),
    ]),
    [
      [
        "jun",
        [
          ["@jun/data-pair", true, []],
          ["@jun/reports", false, ["reports/retention"]],
        ],
      ],
      [
        "priya",
        [
          ["@jun/data-pair", true, []],
          ["@priya/merge-rules", false, ["rules"]],
        ],
      ],
      ["sam", [["@sam/campaigns", false, []]]],
    ],
  );
  const reports = board.owners[0]?.identities.find((entry) => entry.handle === "@jun/reports");
  assert.equal(reports?.avatar, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
});

test("an owner with no identity but an issue in their lane is listed", async () => {
  const p = project();
  await p.submit(penguin, 40, "create", { title: "Board filter" });
  await p.submit(penguin, 40, "assign", { assignee: { person: "lee" } });
  assert.deepEqual(p.board().owners, [{ id: "lee", identities: [] }]);
});

test("a session going online and offline reaches the live feed with the issues it held", async () => {
  const p = project();
  seedIdentities(p);
  await p.submit(penguin, 40, "create", { title: "Board filter" });
  await p.submit(penguin, 40, "assign", { assignee: { identity: "@jun/reports" } });
  p.messages();

  const registered = p.sessions.register("jun", { identity: "@jun/reports", vendor: "codex", worktreeId: "wt_1", branch: "main" });
  assert.equal(registered.status, "ok");
  assert.deepEqual(p.messages(), [{ issues: ["40"], sessions: ["@jun/reports"] }]);

  // A heartbeat changes no status, so nothing is sent.
  p.advance(30_000);
  p.sessions.heartbeat("jun", "session-1");
  assert.deepEqual(p.messages(), []);
  assert.equal(p.sessions.sweep(), START + 30_000 + SESSION_OFFLINE_AFTER_MS);
  assert.deepEqual(p.messages(), []);

  p.advance(SESSION_OFFLINE_AFTER_MS + 1);
  assert.equal(p.sessions.sweep(), undefined);
  assert.deepEqual(p.messages(), [{ issues: ["40"], sessions: ["@jun/reports"] }]);
  assert.equal(p.sessions.get("session-1")?.status, "offline");
  assert.deepEqual(p.board().owners.find((owner) => owner.id === "jun")?.identities.find((i) => i.handle === "@jun/reports")?.sessions, []);
});

test("an owner accepting an assignment reaches the live feed", async () => {
  const p = project();
  assert.equal(
    p.identities.create("sam", { handle: "@sam/campaigns", name: "Campaigns", job: "Fix", charterScopes: ["messaging"], autoAccept: false }, scopeMap).status,
    "ok",
  );
  await p.submit({ person: "sam" }, 40, "create", { title: "Consent" });
  await p.submit({ person: "sam" }, 40, "assign", { assignee: { identity: "@sam/campaigns" } });
  p.messages();
  assert.equal(p.sessions.accept("sam", "40", "@sam/campaigns").status, "ok");
  assert.deepEqual(p.messages(), [{ issues: ["40"], sessions: [] }]);
});

test("the board for one hundred issues builds in well under a second", async () => {
  const p = project();
  seedIdentities(p);
  p.sessions.register("jun", { identity: "@jun/reports", vendor: "codex", worktreeId: "wt_1", branch: "main" });
  for (let n = 1; n <= 100; n += 1) {
    await p.submit(penguin, n, "create", { title: `Issue ${n}` });
    await p.submit(penguin, n, "assign", { assignee: { identity: n % 2 === 0 ? "@jun/reports" : "@priya/merge-rules" } });
  }
  const started = performance.now();
  const board = p.board();
  const elapsed = performance.now() - started;
  assert.equal(board.issues.length, 100);
  assert.ok(elapsed < 1_000, `${elapsed} ms`);
});
