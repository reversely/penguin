import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { checkInbox, type Author } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { IdentityStore, type IdentityOutcome } from "../src/identity-store.ts";
import { buildInbox } from "../src/inbox-page.ts";
import { InboxStore, type InboxReason } from "../src/inbox-store.ts";
import { sendToOwner } from "../src/live-feed.ts";
import { IssueIndex, type IndexListener, type IssueChange, type OperationKeys } from "../src/issue-index.ts";
import { IngestLedger, ingestPush } from "../src/push-ingest.ts";
import { rebuildIndex } from "../src/rebuild.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { SessionStore } from "../src/session-store.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";

const fixture = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");
const scopeMap = parseScopeMap(JSON.parse(readFileSync(join(fixture, "scopes.json"), "utf8")));

const START = Date.parse("2026-10-10T12:00:00Z");
const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };
const sam: Author = { person: "sam" };

let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

/** One ProjectAgent's stores over one in-memory database, wired the way the agent wires them. */
class Project {
  readonly sqlite = sqlite();
  readonly sql = this.sqlite.sql;
  now = START;
  readonly identities: IdentityStore;
  index!: IssueIndex;
  sessions!: SessionStore;
  inbox!: InboxStore;
  /** Milliseconds spent deriving inbox items, summed over every applied operation. */
  deriveMs = 0;
  #nextSession = 0;

  constructor() {
    let nextIdentity = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++nextIdentity}`);
    this.restart();
    this.identity("jun", "@jun/reports", true, ["analytics"]);
    this.identity("sam", "@sam/campaigns", true, ["messaging"]);
  }

  /** New store instances over the same database, as after a ProjectAgent restart. */
  restart(): void {
    let sessions: SessionStore | undefined;
    let inbox: InboxStore | undefined;
    const listener: IndexListener = {
      assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
      issueChanged: (change: IssueChange) => {
        const started = performance.now();
        inbox?.issueChanged(change);
        this.deriveMs += performance.now() - started;
      },
    };
    const index = new IssueIndex(this.sql, listener);
    inbox = new InboxStore(this.sql, this.identities, {
      now: () => this.now,
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    });
    sessions = new SessionStore(this.sql, this.identities, {
      now: () => this.now,
      newId: () => `session-${++this.#nextSession}`,
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      startRequests: inbox,
    });
    [this.index, this.sessions, this.inbox] = [index, sessions, inbox];
  }

  identity(owner: string, handle: string, autoAccept: boolean, charterScopes: string[]): void {
    const name = handle.slice(handle.indexOf("/") + 1);
    ok(this.identities.create(owner, { handle, name, job: "Fix things", charterScopes, autoAccept }, scopeMap));
  }

  /** A team identity of Jun and Priya. */
  team(): void {
    const input = { handle: "@jun/pair", name: "Pair", job: "Pair on reports", owners: ["jun", "priya"] };
    ok(this.identities.createTeam("jun", { ...input, charterScopes: ["analytics", "identity-map"] }, scopeMap));
  }

  register(caller: string, identity: string): string {
    const input = { identity, vendor: "codex", worktreeId: "wt_0123456789abcdef", branch: "main" };
    const outcome = this.sessions.register(caller, input);
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return outcome.status === "ok" ? outcome.session.id : "";
  }

  get keys(): OperationKeys {
    return { bridges: [], serviceKey: service.publicKey, scopeMap, identities: this.identities };
  }

  async submit(author: Author, issue: number, type: string, payload: Record<string, unknown>): Promise<void> {
    const outcome = await this.index.submit({
      operation: { issue, type, base_version: this.index.issue(String(issue))?.version ?? 0, payload },
      author,
      source: "dashboard",
      signingKey: service.privateKey,
      keys: this.keys,
      now: this.now,
    });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  }

  create(issue: number, author: Author = priya): Promise<void> {
    return this.submit(author, issue, "create", { title: `Issue ${issue}` });
  }

  assign(issue: number, assignee: Record<string, string>, author: Author = priya): Promise<void> {
    return this.submit(author, issue, "assign", { assignee });
  }

  mention(issue: number, mentioned: Record<string, string>, author: Author = priya): Promise<void> {
    return this.submit(author, issue, "mention", { mentioned });
  }

  close(issue: number, author: Author = priya): Promise<void> {
    return this.submit(author, issue, "change_state", { state: "closed", reason: "done" });
  }

  /** The caller's items as "<reason> #<issue>", with " (read)" on read ones, newest first. */
  items(caller: string): string[] {
    return this.inbox.items(caller).map((item) => `${item.reason} #${item.issueId}${item.read ? " (read)" : ""}`);
  }

  markRead(caller: string, issue: number, reason: InboxReason): void {
    const outcome = this.inbox.markRead(caller, String(issue), reason);
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  }
}

function ok(outcome: IdentityOutcome): void {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
}

/** Issue 40, assigned to @jun/reports with a Jun session running, mentioning Sam, then closed. */
async function workedIssue(project: Project): Promise<void> {
  project.register("jun", "@jun/reports");
  await project.create(40);
  project.now += 1_000;
  await project.assign(40, { identity: "@jun/reports" });
  project.now += 1_000;
  await project.mention(40, { person: "sam" });
}

describe("inbox: deriving items from applied operations", () => {
  test("assigning an issue to @jun/reports creates an assigned item for Jun only", async () => {
    const project = new Project();
    project.register("jun", "@jun/reports");
    await project.create(40);
    await project.assign(40, { identity: "@jun/reports" });

    assert.deepEqual(project.items("jun"), ["assigned #40"]);
    for (const person of ["priya", "sam", "lee"]) assert.deepEqual(project.items(person), [], person);
    const [item] = project.inbox.items("jun");
    assert.deepEqual(item, {
      personId: "jun",
      issueId: "40",
      reason: "assigned",
      read: false,
      raisedAt: new Date(START).toISOString(),
    });
  });

  test("mentioning Sam creates a mentioned item for Sam", async () => {
    const project = new Project();
    await workedIssue(project);
    assert.deepEqual(project.items("sam"), ["mentioned #40"]);
    assert.deepEqual(project.items("jun"), ["assigned #40"]);
  });

  test("closing the issue creates recently closed items for Jun and Sam, and for no one else", async () => {
    const project = new Project();
    await workedIssue(project);
    project.now += 1_000;
    await project.close(40);

    assert.deepEqual(project.items("jun"), ["closed #40", "assigned #40"]);
    assert.deepEqual(project.items("sam"), ["closed #40", "mentioned #40"]);
    // Priya closed it and had no item; Lee has no link to the issue.
    assert.deepEqual(project.items("priya"), []);
    assert.deepEqual(project.items("lee"), []);

    // A move between open states is not a close.
    await project.create(41);
    await project.assign(41, { person: "sam" });
    await project.submit(priya, 41, "change_state", { state: "fixing", reason: "started" });
    assert.deepEqual(project.items("sam").slice(0, 1), ["assigned #41"]);
  });

  test("the person who acts gets no item for it", async () => {
    const project = new Project();
    project.register("jun", "@jun/reports");
    await project.create(40, jun);
    await project.assign(40, { identity: "@jun/reports" }, jun);
    await project.mention(40, { person: "jun" }, jun);
    await project.assign(40, { person: "sam" }, jun);
    assert.deepEqual(project.items("jun"), []);
    assert.deepEqual(project.items("sam"), ["assigned #40"]);
    // Sam closes it: Jun has no item for the issue, so gets no closed item either.
    await project.close(40, sam);
    assert.deepEqual(project.items("jun"), []);
    assert.deepEqual(project.items("sam"), ["assigned #40"]);
  });

  test("a mention of an identity reaches its owner; an unknown identity reaches no one", async () => {
    const project = new Project();
    await project.create(40);
    await project.mention(40, { identity: "@sam/campaigns" });
    await project.mention(40, { identity: "@lee/ghost" });
    await project.assign(40, { identity: "@lee/ghost" });
    assert.deepEqual(project.items("sam"), ["mentioned #40"]);
    assert.deepEqual(project.items("lee"), []);
  });

  test("a team identity's assignment reaches the owner who assigned it; its mention reaches every owner", async () => {
    const project = new Project();
    project.team();
    await project.create(40, sam);
    await project.assign(40, { identity: "@jun/pair" });
    // Priya assigned it, so it answers to Priya alone, and she did it herself.
    assert.deepEqual(project.items("priya"), []);
    assert.deepEqual(project.items("jun"), []);
    await project.create(41, sam);
    await project.assign(41, { identity: "@jun/pair" }, sam);
    // Sam is not a team owner, so the assignment answers to every owner.
    assert.deepEqual(project.items("priya"), ["assigned #41"]);
    assert.deepEqual(project.items("jun"), ["assigned #41"]);

    const team = new Project();
    team.team();
    team.register("jun", "@jun/pair");
    team.register("jun", "@jun/reports");
    await team.create(40, sam);
    await team.assign(40, { identity: "@jun/pair" }, jun);
    assert.deepEqual(team.items("jun"), []);
    assert.deepEqual(team.items("priya"), []);
    await team.assign(40, { identity: "@jun/reports" }, priya);
    await team.mention(40, { identity: "@jun/pair" }, sam);
    assert.deepEqual(team.items("jun"), ["mentioned #40", "assigned #40"]);
    assert.deepEqual(team.items("priya"), ["mentioned #40"]);
  });

  test("a new event of the same reason marks a read item unread and raises it", async () => {
    const project = new Project();
    await workedIssue(project);
    project.markRead("sam", 40, "mentioned");
    assert.deepEqual(project.items("sam"), ["mentioned #40 (read)"]);
    project.now += 1_000;
    await project.mention(40, { person: "sam" }, jun);
    assert.deepEqual(project.items("sam"), ["mentioned #40"]);
    assert.equal(project.inbox.items("sam")[0]?.raisedAt, new Date(project.now).toISOString());
  });
});

describe("inbox: requests to start a session", () => {
  test("an assignment with no running session asks Jun to start one; registering clears the item", async () => {
    const project = new Project();
    await project.create(40);
    await project.assign(40, { identity: "@jun/reports" });
    assert.deepEqual(project.items("jun"), ["assigned #40", "start_session #40"]);

    project.now += 1_000;
    project.register("jun", "@jun/reports");
    assert.deepEqual(project.items("jun"), ["assigned #40"]);
  });

  test("the item stays while another identity of the same owner still waits for a session", async () => {
    const project = new Project();
    project.identity("jun", "@jun/dashboards", true, ["analytics"]);
    await project.create(40);
    await project.assign(40, { identity: "@jun/reports" });
    await project.assign(40, { identity: "@jun/dashboards" });
    project.register("jun", "@jun/reports");
    assert.deepEqual(project.items("jun"), ["assigned #40", "start_session #40"]);
    project.register("jun", "@jun/dashboards");
    assert.deepEqual(project.items("jun"), ["assigned #40"]);
  });

  test("a request already waiting is not raised again when routing runs again", async () => {
    const project = new Project();
    project.identity("jun", "@jun/alerts", false, ["analytics"]);
    await project.create(40);
    await project.assign(40, { identity: "@jun/alerts" });
    assert.deepEqual(project.items("jun"), ["assigned #40"]);
    // Accepting with no running session asks for one; accepting again routes again and asks nothing new.
    assert.deepEqual(project.sessions.accept("jun", "40", "@jun/alerts"), { status: "ok", sessionId: null });
    project.markRead("jun", 40, "start_session");
    project.now += 1_000;
    assert.deepEqual(project.sessions.accept("jun", "40", "@jun/alerts"), { status: "ok", sessionId: null });
    assert.deepEqual(project.items("jun"), ["start_session #40 (read)", "assigned #40"]);
  });
});

describe("inbox: reading and marking", () => {
  test("marking an item read persists across a ProjectAgent restart", async () => {
    const project = new Project();
    await workedIssue(project);
    project.markRead("jun", 40, "assigned");
    project.restart();
    assert.deepEqual(project.items("jun"), ["assigned #40 (read)"]);
    assert.deepEqual(project.items("sam"), ["mentioned #40"]);
  });

  test("a person can read and mark only their own items", async () => {
    const project = new Project();
    await workedIssue(project);
    // Each read is scoped to the caller: Sam's inbox never lists Jun's item.
    assert.deepEqual(
      project.inbox.items("sam").map((item) => item.personId),
      ["sam"],
    );
    assert.deepEqual(project.items("jun"), ["assigned #40"]);
    const outcome = project.inbox.markRead("sam", "40", "assigned");
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.status === "rejected" ? outcome.reason : "", "not_found");
    assert.deepEqual(project.items("jun"), ["assigned #40"]);

    const invalid = project.inbox.markRead("jun", "40", "everything" as InboxReason);
    assert.equal(invalid.status === "rejected" ? invalid.reason : "", "invalid");
    assert.deepEqual(project.inbox.items(undefined as unknown as string), []);
    // A caller id is a bound value, never SQL.
    assert.deepEqual(project.inbox.items("' OR 1=1 --"), []);
  });

  test("pushing the pending operations neither repeats items nor resets read flags, and the rebuild still matches", async () => {
    const project = new Project();
    await workedIssue(project);
    project.markRead("jun", 40, "assigned");
    const before = project.sql.exec(`SELECT * FROM InboxItem ORDER BY rowid`);

    const repo = new GitRepo();
    const ledger = new IngestLedger(project.sql);
    const listing = project.index.pendingFiles({ bridgeId: "bridge-runner", role: "runner" });
    const files = listing.status === "ok" ? listing.files : [];
    const head = repo.commit(Object.fromEntries(files.map((file) => [file.path, file.file])));
    await ingestPush(repo.reader(), head, ledger, (file, commit) =>
      project.index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys: project.keys }),
    );
    assert.deepEqual(project.sql.exec(`SELECT * FROM InboxItem ORDER BY rowid`), before);

    const report = await rebuildIndex({
      repo: repo.reader(),
      db: project.sql,
      live: { index: project.index, ledger },
      keys: project.keys,
    });
    assert.equal(report.comparison.equal, true, JSON.stringify(report.comparison.differences));
    assert.deepEqual(project.sql.exec(`SELECT * FROM InboxItem ORDER BY rowid`), before);
  });
});

describe("inbox: time", () => {
  test("time to derive inbox items for 1000 operations", async (t) => {
    const project = new Project();
    project.register("jun", "@jun/reports");
    const started = performance.now();
    // 250 issues, each created, assigned, mentioning Sam and closed: 1000 operations.
    for (let issue = 1; issue <= 250; issue += 1) {
      await project.create(issue);
      await project.assign(issue, { identity: "@jun/reports" });
      await project.mention(issue, { person: "sam" });
      await project.close(issue);
    }
    const total = performance.now() - started;
    const perOperationUs = (project.deriveMs * 1000) / 1000;
    t.diagnostic(
      `1000 operations: inbox derivation ${project.deriveMs.toFixed(1)} ms in all, ` +
        `${perOperationUs.toFixed(1)} µs per operation; submit and apply ${total.toFixed(0)} ms in all`,
    );
    assert.equal(project.inbox.items("jun").length, 500);
    assert.equal(project.inbox.items("sam").length, 500);
  });
});

describe("inbox: the dashboard's inbox", () => {
  const inboxOf = (project: Project, person: string) =>
    buildInbox({ items: (caller) => project.inbox.items(caller), issue: (id) => project.index.issue(id) }, person);

  test("carries each of the person's items with its issue's title and state, newest first", async () => {
    const project = new Project();
    await workedIssue(project);
    project.now += 1_000;
    await project.close(40);

    assert.deepEqual(inboxOf(project, "jun"), {
      items: [
        {
          issueId: "40",
          reason: "closed",
          read: false,
          raisedAt: new Date(START + 3_000).toISOString(),
          title: "Issue 40",
          state: "closed",
          assigneeHandles: ["@jun/reports"],
        },
        {
          issueId: "40",
          reason: "assigned",
          read: false,
          raisedAt: new Date(START + 1_000).toISOString(),
          title: "Issue 40",
          state: "closed",
          assigneeHandles: ["@jun/reports"],
        },
      ],
    });
    assert.deepEqual(inboxOf(project, "lee"), { items: [] });
  });

  test("carries the handles of the issue's identity assignees, and none for an issue no identity holds", async () => {
    const project = new Project();
    await project.create(41);
    await project.mention(41, { person: "sam" });
    await project.create(42);
    await project.assign(42, { identity: "@sam/campaigns" });
    await project.assign(42, { person: "sam" });
    await project.assign(42, { identity: "@jun/reports" });

    const inbox = inboxOf(project, "sam");
    // Issue 42 also raises a start_session item, as no @sam/campaigns session runs.
    assert.deepEqual(
      inbox.items.map((item) => [item.issueId, item.reason, item.assigneeHandles]).sort(),
      [
        ["41", "mentioned", []],
        ["42", "assigned", ["@sam/campaigns", "@jun/reports"]],
        ["42", "start_session", ["@sam/campaigns", "@jun/reports"]],
      ],
    );
    assert.deepEqual(checkInbox(inbox), []);
  });

  test("passes markup in an issue title through as text, unchanged", async () => {
    const project = new Project();
    const title = '<img src=x onerror="alert(1)"> & </script>';
    await project.submit(priya, 43, "create", { title });
    await project.mention(43, { person: "sam" });
    const inbox = inboxOf(project, "sam");
    assert.equal(inbox.items[0]?.title, title);
    assert.deepEqual(checkInbox(inbox), []);
  });

  test("shows a read item as read among the person's own items only", async () => {
    const project = new Project();
    await workedIssue(project);
    project.markRead("jun", 40, "assigned");
    assert.deepEqual(
      inboxOf(project, "jun").items.map((item) => [item.reason, item.read]),
      [["assigned", true]],
    );
    assert.deepEqual(
      inboxOf(project, "sam").items.map((item) => [item.reason, item.read]),
      [["mentioned", false]],
    );
  });

  test("leaves out an item whose issue the index does not hold", () => {
    const item = { personId: "jun", issueId: "99", reason: "assigned" as const, read: false, raisedAt: "2026-10-10T12:00:00.000Z" };
    assert.deepEqual(buildInbox({ items: () => [item], issue: () => undefined }, "jun"), { items: [] });
  });
});

describe("inbox: telling only the person's dashboards", () => {
  test("sends to each connection of the person and to no one else's", () => {
    const sent: string[] = [];
    const connection = (name: string, state: { owner?: unknown } | null) => ({
      state,
      send: (message: string) => sent.push(`${name} ${message}`),
    });
    const closed = {
      state: { owner: "jun" },
      send: () => {
        throw new Error("closed");
      },
    };
    sendToOwner(
      [connection("jun-a", { owner: "jun" }), closed, connection("priya", { owner: "priya" }), connection("none", null), connection("jun-b", { owner: "jun" })],
      "jun",
      "hello",
    );
    assert.deepEqual(sent, ["jun-a hello", "jun-b hello"]);
  });
});
