import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import type { Author } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { IdentityStore, type IdentityInput, type IdentityOutcome } from "../src/identity-store.ts";
import { IssueIndex, type OperationKeys, type SubmitOutcome } from "../src/issue-index.ts";
import { IngestLedger, ingestPush } from "../src/push-ingest.ts";
import { rebuildIndex } from "../src/rebuild.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import {
  SESSION_LIMITS,
  SESSION_OFFLINE_AFTER_MS,
  SessionStore,
  type Session,
  type SessionInput,
  type SessionOutcome,
} from "../src/session-store.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";

const fixture = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");
const scopeMap = parseScopeMap(JSON.parse(readFileSync(join(fixture, "scopes.json"), "utf8")));

const START = Date.parse("2026-10-10T12:00:00Z");
const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };

let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

/** One ProjectAgent's stores over one in-memory database, wired the way the agent wires them. */
class Project {
  readonly sqlite = sqlite();
  readonly db = this.sqlite.db;
  readonly sql = this.sqlite.sql;
  now = START;
  identities: IdentityStore;
  index: IssueIndex;
  sessions: SessionStore;
  #nextSession = 0;

  constructor() {
    let nextIdentity = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++nextIdentity}`);
    [this.index, this.sessions] = this.#open();
  }

  /** New store instances over the same database, as after a ProjectAgent restart. */
  restart(): void {
    [this.index, this.sessions] = this.#open();
  }

  #open(): [IssueIndex, SessionStore] {
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(this.sql, {
      assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
    });
    sessions = new SessionStore(this.sql, this.identities, {
      now: () => this.now,
      newId: () => `session-${++this.#nextSession}`,
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    });
    return [index, sessions];
  }

  identity(owner: string, handle: string, autoAccept: boolean, charterScopes = ["analytics"]): string {
    const name = handle.slice(handle.indexOf("/") + 1);
    const input: IdentityInput = { handle, name, job: "Fix reports", charterScopes, autoAccept };
    return ok(this.identities.create(owner, input, scopeMap)).identity.id;
  }

  get keys(): OperationKeys {
    return { bridges: [], serviceKey: service.publicKey, scopeMap, identities: this.identities };
  }

  async submit(author: Author, issue: number, type: string, payload: Record<string, unknown>): Promise<SubmitOutcome> {
    const outcome = await this.index.submit({
      operation: { issue, type, base_version: this.index.issue(String(issue))?.version ?? 0, payload },
      author,
      source: "dashboard",
      signingKey: service.privateKey,
      keys: this.keys,
      now: this.now,
    });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    return outcome;
  }

  createIssue(issue: number, author: Author = jun): Promise<SubmitOutcome> {
    return this.submit(author, issue, "create", { title: `Issue ${issue}` });
  }

  assign(issue: number, handle: string, author: Author = jun): Promise<SubmitOutcome> {
    return this.submit(author, issue, "assign", { assignee: { identity: handle } });
  }

  register(caller: string, identity: string, extra: Partial<SessionInput> = {}): Session {
    const input = { identity, vendor: "codex", worktreeId: "wt_0123456789abcdef", branch: "reports/retention" };
    return session(this.sessions.register(caller, { ...input, ...extra }));
  }

  /** A team identity of Jun and Priya. */
  team(): void {
    const input = { handle: "@jun/pair", name: "Pair", job: "Pair on reports", owners: ["jun", "priya"] };
    ok(this.identities.createTeam("jun", { ...input, charterScopes: ["analytics", "identity-map"] }, scopeMap));
  }

  /** The session on the Assignment row, read straight from SQL. */
  assignedSession(issue: number, handle: string): string | null | undefined {
    const [row] = this.db
      .prepare(
        `SELECT session_id FROM Assignment WHERE issue_id = ? AND assignee_kind = 'identity' AND assignee_id = ?`,
      )
      .all(String(issue), handle);
    return row === undefined ? undefined : ((row["session_id"] as string | null) ?? null);
  }

  work(caller: string, sessionId: string): string[] {
    const work = this.sessions.work(caller, sessionId);
    assert.equal(work.status, "ok", JSON.stringify(work));
    return work.status === "ok" ? work.issueIds : [];
  }

  requests(caller: string): string[] {
    return this.sessions.requests(caller).map((r) => `${r.kind} ${r.handle} #${r.issueId}`);
  }
}

function ok(outcome: IdentityOutcome): Extract<IdentityOutcome, { status: "ok" }> {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  return outcome as Extract<IdentityOutcome, { status: "ok" }>;
}

function session(outcome: SessionOutcome): Session {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  return (outcome as { session: Session }).session;
}

function rejected(
  outcome: { status: string; reason?: string; message?: string },
  reason: string,
  message?: RegExp,
): void {
  assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
  assert.equal(outcome.reason, reason, outcome.message);
  if (message !== undefined) assert.match(outcome.message ?? "", message);
}

describe("sessions: registration and heartbeats", () => {
  test("registering returns an id, and the session shows as running with its vendor, worktree and branch", () => {
    const project = new Project();
    const identityId = project.identity("jun", "@jun/reports", true);
    const registered = project.register("jun", "@jun/reports");
    const expected: Session = {
      id: "session-1",
      identityId,
      handle: "@jun/reports",
      vendor: "codex",
      worktreeId: "wt_0123456789abcdef",
      branch: "reports/retention",
      status: "running",
      currentIssueId: null,
      lastSeen: new Date(START).toISOString(),
    };
    assert.deepEqual(registered, expected);
    project.restart();
    assert.deepEqual(project.sessions.get("session-1"), expected);
    assert.equal(project.sessions.get("session-9"), undefined);
  });

  test("a session registers only as an identity of the owner whose token it presents", () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    project.identity("priya", "@priya/merge-rules", true, ["identity-map"]);
    const input = { vendor: "claude-code", worktreeId: "wt_1", branch: "main" };
    rejected(
      project.sessions.register("jun", { identity: "@priya/merge-rules", ...input }),
      "forbidden",
      /only @priya\/merge-rules's owner \(priya\)/u,
    );
    rejected(project.sessions.register("jun", { identity: "@jun/ghost", ...input }), "not_found");
    session(project.sessions.register("priya", { identity: "@priya/merge-rules", ...input }));
    assert.equal(project.db.prepare(`SELECT COUNT(*) AS n FROM Session`).get()?.["n"], 1);
  });

  test("any owner of a team identity may register a session of it, and no one else", () => {
    const project = new Project();
    project.team();
    project.register("jun", "@jun/pair");
    project.register("priya", "@jun/pair");
    const input = { identity: "@jun/pair", vendor: "codex", worktreeId: "wt_1", branch: "main" };
    rejected(project.sessions.register("sam", input), "forbidden");
  });

  test("registration fields are checked against their formats and caps", () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const base: SessionInput = { identity: "@jun/reports", vendor: "codex", worktreeId: "wt_1", branch: "main" };
    const cases: [unknown, RegExp][] = [
      [null, /must be an object/u],
      [{ ...base, identity: 7 }, /identity must be/u],
      [{ ...base, vendor: "Codex" }, /vendor/u],
      [{ ...base, vendor: "c".repeat(SESSION_LIMITS.vendorLength + 1) }, /vendor/u],
      [{ ...base, worktreeId: "wt 1" }, /worktreeId/u],
      [{ ...base, worktreeId: "w".repeat(SESSION_LIMITS.worktreeIdLength + 1) }, /worktreeId/u],
      [{ ...base, branch: "" }, /branch/u],
      [{ ...base, branch: "a..b" }, /branch/u],
      [{ ...base, branch: "-x" }, /branch/u],
      [{ ...base, branch: "x.lock" }, /branch/u],
      [{ ...base, branch: "fix\nnext" }, /branch/u],
      [{ ...base, branch: "b".repeat(SESSION_LIMITS.branchLength + 1) }, /branch/u],
      [{ ...base, branch: "'; DROP TABLE Session;--" }, /branch/u],
    ];
    for (const [input, message] of cases) {
      rejected(project.sessions.register("jun", input as SessionInput), "invalid", message);
    }
    assert.equal(project.db.prepare(`SELECT COUNT(*) AS n FROM Session`).get()?.["n"], 0);
    const branch = "feature/jun-reports_2.1";
    assert.equal(project.register("jun", "@jun/reports", { branch }).branch, branch);
  });

  test("a heartbeat updates last_seen; without one in the window the session goes offline for good", () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    project.now += SESSION_OFFLINE_AFTER_MS - 1;
    const beat = session(project.sessions.heartbeat("jun", id));
    assert.equal(beat.lastSeen, new Date(project.now).toISOString());
    rejected(project.sessions.heartbeat("priya", id), "forbidden");
    rejected(project.sessions.heartbeat("jun", "session-9"), "not_found");

    project.now += SESSION_OFFLINE_AFTER_MS;
    assert.equal(project.sessions.get(id)?.status, "running");
    project.now += 1;
    assert.equal(project.sessions.get(id)?.status, "offline");
    rejected(project.sessions.heartbeat("jun", id), "offline", /register a new session/u);
    rejected(project.sessions.work("jun", id), "offline");
  });
});

describe("sessions: routing assigned issues", () => {
  test("assigning an issue to @jun/reports while a Jun session runs sets that session on the assignment", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");

    assert.equal(project.assignedSession(40, "@jun/reports"), id);
    assert.deepEqual(project.work("jun", id), ["40"]);
    assert.deepEqual(project.sessions.routes("40"), [{ handle: "@jun/reports", sessionId: id, waitingFor: null }]);
    assert.deepEqual(project.requests("jun"), []);
    rejected(project.sessions.work("priya", id), "forbidden");
  });

  test("time from applied assign operation to routed session, over 200 issues", async (t) => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    const times: number[] = [];
    for (let issue = 1; issue <= 200; issue += 1) {
      await project.createIssue(issue);
      const started = performance.now();
      await project.assign(issue, "@jun/reports");
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    t.diagnostic(
      `assign-to-routed over 200 issues: median ${times[100]?.toFixed(2)} ms, max ${times[199]?.toFixed(2)} ms`,
    );
    assert.equal(project.work("jun", id).length, 200);
  });

  test("assigning while none runs asks Jun to start a session; registering one routes the issue to it", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    await project.createIssue(40, priya);
    await project.assign(40, "@jun/reports", priya);

    assert.equal(project.assignedSession(40, "@jun/reports"), null);
    assert.deepEqual(project.requests("jun"), ["start @jun/reports #40"]);
    assert.deepEqual(project.requests("priya"), []);
    assert.deepEqual(project.sessions.routes("40"), [
      { handle: "@jun/reports", sessionId: null, waitingFor: "session" },
    ]);

    project.now += 5_000;
    const { id } = project.register("jun", "@jun/reports");
    assert.equal(project.assignedSession(40, "@jun/reports"), id);
    assert.deepEqual(project.work("jun", id), ["40"]);
    assert.deepEqual(project.requests("jun"), []);
  });

  test("a session that stops sending heartbeats goes offline; its issue stays open and assigned", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    assert.equal(project.assignedSession(40, "@jun/reports"), id);

    project.now += SESSION_OFFLINE_AFTER_MS + 1;
    assert.equal(project.sessions.get(id)?.status, "offline");
    const issue = project.index.issue("40");
    assert.equal(issue?.state, "open");
    assert.deepEqual([...(issue?.assignments.keys() ?? [])], ["identity:@jun/reports"]);
    assert.equal(project.assignedSession(40, "@jun/reports"), null);
    assert.deepEqual(project.requests("jun"), ["start @jun/reports #40"]);

    // A later session of the same identity receives it.
    const next = project.register("jun", "@jun/reports");
    assert.deepEqual(project.work("jun", next.id), ["40"]);
  });

  test("when a session goes offline, its issue moves to another running session of the identity", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const first = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    project.now += 10_000;
    const second = project.register("jun", "@jun/reports", { worktreeId: "wt_second" });
    assert.equal(project.assignedSession(40, "@jun/reports"), first.id);

    project.now += SESSION_OFFLINE_AFTER_MS - 5_000;
    session(project.sessions.heartbeat("jun", second.id));
    project.now += 5_001;
    assert.deepEqual(project.work("jun", second.id), ["40"]);
    assert.deepEqual(project.requests("jun"), []);
  });

  test("of several running sessions, the most recently seen one gets the issue", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const first = project.register("jun", "@jun/reports");
    project.now += 1_000;
    const second = project.register("jun", "@jun/reports", { worktreeId: "wt_second" });
    project.now += 1_000;
    session(project.sessions.heartbeat("jun", first.id));
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    assert.equal(project.assignedSession(40, "@jun/reports"), first.id);
    assert.deepEqual(project.work("jun", second.id), []);
  });

  test("with auto_accept false the issue waits for Jun's acceptance; with it true it routes at once", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", false);
    project.identity("jun", "@jun/alerts", true);
    const waiting = project.register("jun", "@jun/reports");
    const immediate = project.register("jun", "@jun/alerts");
    await project.createIssue(40);
    await project.createIssue(41);
    await project.assign(40, "@jun/reports", priya);
    await project.assign(41, "@jun/alerts", priya);

    assert.deepEqual(project.work("jun", immediate.id), ["41"]);
    assert.deepEqual(project.work("jun", waiting.id), []);
    assert.equal(project.assignedSession(40, "@jun/reports"), null);
    assert.deepEqual(project.requests("jun"), ["accept @jun/reports #40"]);
    assert.deepEqual(project.sessions.routes("40"), [
      { handle: "@jun/reports", sessionId: null, waitingFor: "acceptance" },
    ]);

    rejected(project.sessions.accept("priya", "40", "@jun/reports"), "forbidden", /only jun can accept/u);
    rejected(project.sessions.accept("jun", "41", "@jun/reports"), "not_found", /not assigned/u);
    assert.deepEqual(project.sessions.accept("jun", "40", "@jun/reports"), { status: "ok", sessionId: waiting.id });
    assert.deepEqual(project.work("jun", waiting.id), ["40"]);
    assert.deepEqual(project.requests("jun"), []);
    // Accepting again changes nothing.
    assert.deepEqual(project.sessions.accept("jun", "40", "@jun/reports"), { status: "ok", sessionId: waiting.id });
  });

  test("an accepted assignment with no running session asks for a session, then routes on registration", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", false);
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    assert.deepEqual(project.requests("jun"), ["accept @jun/reports #40"]);
    assert.deepEqual(project.sessions.accept("jun", "40", "@jun/reports"), { status: "ok", sessionId: null });
    assert.deepEqual(project.requests("jun"), ["start @jun/reports #40"]);
    const { id } = project.register("jun", "@jun/reports");
    assert.deepEqual(project.work("jun", id), ["40"]);
  });

  test("unassigning drops the routing, the requests and the acceptance; a new assign asks again", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", false);
    const { id } = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    project.sessions.accept("jun", "40", "@jun/reports");
    assert.deepEqual(project.work("jun", id), ["40"]);

    await project.submit(jun, 40, "unassign", { assignee: { identity: "@jun/reports" } });
    assert.deepEqual(project.work("jun", id), []);
    assert.deepEqual(project.sessions.routes("40"), []);

    await project.assign(40, "@jun/reports");
    assert.deepEqual(project.requests("jun"), ["accept @jun/reports #40"]);
    assert.deepEqual(project.work("jun", id), []);

    await project.submit(jun, 40, "unassign", { assignee: { identity: "@jun/reports" } });
    assert.deepEqual(project.requests("jun"), []);
  });

  test("one owner's two identities, each with a running session, receive their own assignments", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    project.identity("jun", "@jun/dashboards", true);
    const reports = project.register("jun", "@jun/reports");
    const dashboards = project.register("jun", "@jun/dashboards", {
      worktreeId: "wt_dashboards",
      branch: "dashboards",
    });
    await project.createIssue(40);
    await project.createIssue(41);
    await project.createIssue(42);
    await project.assign(40, "@jun/reports");
    await project.assign(41, "@jun/dashboards");
    await project.assign(42, "@jun/reports");
    await project.assign(42, "@jun/dashboards");

    assert.deepEqual(project.work("jun", reports.id), ["40", "42"]);
    assert.deepEqual(project.work("jun", dashboards.id), ["41", "42"]);

    // One identity's session going offline leaves the other's work alone.
    project.now += SESSION_OFFLINE_AFTER_MS - 1;
    session(project.sessions.heartbeat("jun", dashboards.id));
    project.now += 2;
    assert.equal(project.sessions.get(reports.id)?.status, "offline");
    assert.deepEqual(project.work("jun", dashboards.id), ["41", "42"]);
    assert.deepEqual(project.requests("jun"), ["start @jun/reports #40", "start @jun/reports #42"]);
  });

  test("a team identity's requests go to the owner who assigned it, and only that owner accepts", async () => {
    const project = new Project();
    project.team();
    await project.createIssue(40);
    await project.assign(40, "@jun/pair", priya);
    assert.deepEqual(project.requests("priya"), ["accept @jun/pair #40"]);
    assert.deepEqual(project.requests("jun"), []);
    rejected(project.sessions.accept("jun", "40", "@jun/pair"), "forbidden", /only priya can accept/u);
    assert.deepEqual(project.sessions.accept("priya", "40", "@jun/pair"), { status: "ok", sessionId: null });
    assert.deepEqual(project.requests("priya"), ["start @jun/pair #40"]);
  });

  test("a rebuild from the issues repo matches a live index whose assignments are routed", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    assert.equal(project.assignedSession(40, "@jun/reports"), id);

    // The runner pushes the pending operations and the push event reaches the live index.
    const repo = new GitRepo();
    const ledger = new IngestLedger(project.sql);
    const listing = project.index.pendingFiles({ bridgeId: "bridge-runner", role: "runner" });
    assert.equal(listing.status, "ok");
    const files = listing.status === "ok" ? listing.files : [];
    const head = repo.commit(Object.fromEntries(files.map((file) => [file.path, file.file])));
    await ingestPush(repo.reader(), head, ledger, (file, commit) =>
      project.index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys: project.keys }),
    );

    const report = await rebuildIndex({
      repo: repo.reader(),
      db: project.sql,
      live: { index: project.index, ledger },
      keys: project.keys,
    });
    assert.deepEqual(report.comparison.differences, []);
    assert.equal(report.comparison.equal, true);
    // The rebuild leaves the live routing alone.
    assert.deepEqual(project.work("jun", id), ["40"]);
  });

  test("routing survives a restart, and an assignment to a person or an unknown identity routes nowhere", async () => {
    const project = new Project();
    project.identity("jun", "@jun/reports", true);
    const { id } = project.register("jun", "@jun/reports");
    await project.createIssue(40);
    await project.assign(40, "@jun/reports");
    await project.submit(jun, 40, "assign", { assignee: { person: "sam" } });
    project.restart();
    assert.deepEqual(project.work("jun", id), ["40"]);
    assert.deepEqual(project.sessions.routes("40"), [{ handle: "@jun/reports", sessionId: id, waitingFor: null }]);
    assert.equal(project.db.prepare(`SELECT COUNT(*) AS n FROM OwnerRequest`).get()?.["n"], 0);
  });
});
