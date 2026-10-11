import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair, signOperation } from "@penguin/issues";
import {
  formatOpId,
  operationPath,
  WEB_WRITER_TAG,
  type Author,
  type IssueId,
  type Operation,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type OperationKeys,
  type SqlDatabase,
} from "../src/issue-index.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

const penguin: Author = { penguin: true };
const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };
const mergeRules: Author = { identity: "@priya/merge-rules" };

let service: CryptoKeyPair;
let junBridge: CryptoKeyPair;
let priyaBridge: CryptoKeyPair;
let stranger: CryptoKeyPair;
let keys: OperationKeys;

before(async () => {
  [service, junBridge, priyaBridge, stranger] = await Promise.all([
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
  ]);
  keys = {
    bridges: [
      { bridgeId: "bridge-jun", ownerId: "jun", publicKey: junBridge.publicKey },
      { bridgeId: "bridge-priya", ownerId: "priya", publicKey: priyaBridge.publicKey },
    ],
    serviceKey: service.publicKey,
    scopeMap,
    identities: { byHandle: () => undefined },
  };
});

/** An in-memory node:sqlite database behind the index's SQL interface. */
function sqlite(): { db: DatabaseSync; sql: SqlDatabase } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as Record<string, string | number | null>[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sql };
}

function dump(db: DatabaseSync): Record<string, unknown[]> {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all();
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()]),
  );
}

function rows(db: DatabaseSync, query: string, ...params: (string | number)[]): Record<string, unknown>[] {
  return db
    .prepare(query)
    .all(...params)
    .map((row) => ({ ...row }));
}

/** Writes signed operation files the way each author's client would. */
class Writer {
  readonly #seqs = new Map<string, number>();
  readonly #versions = new Map<string, number>();
  /** Every input written, in the order it was applied, for replay. */
  readonly inputs: ApplyInput[] = [];

  readonly index: IssueIndex;

  constructor(index: IssueIndex) {
    this.index = index;
  }

  /** Signs and applies the author's next operation at the issue's current version unless `base` is given. */
  async apply(
    author: Author,
    type: Operation["type"],
    payload: Record<string, unknown>,
    issue: IssueId,
    options: { base?: number; key?: CryptoKey } = {},
  ): Promise<ApplyOutcome & { operation: Operation }> {
    const seqKey = JSON.stringify(author);
    const seq = (this.#seqs.get(seqKey) ?? 0) + 1;
    this.#seqs.set(seqKey, seq);
    const base = options.base ?? this.#versions.get(String(issue)) ?? 0;
    const key = options.key ?? signingKey(author);
    const writer = key === service.privateKey ? WEB_WRITER_TAG : BRIDGE_TAG;
    const operation = await signOperation(
      { schema_version: 1, op_id: formatOpId(author, writer, seq), issue, type, author, base_version: base, payload },
      key,
    );
    const outcome = await this.applyFile(new TextEncoder().encode(JSON.stringify(operation)), operationPath(operation));
    if (outcome.status === "applied") this.#versions.set(outcome.issueId, outcome.version);
    return { ...outcome, operation };
  }

  applyFile(file: Uint8Array, path: string, gitCommit = "c0ffee"): Promise<ApplyOutcome> {
    const input: ApplyInput = { file, gitCommit, path, keys };
    this.inputs.push(input);
    return this.index.apply(input);
  }
}

/** The writer tag the test bridges number their operations under. */
const BRIDGE_TAG = "b3f2";

function signingKey(author: Author): CryptoKey {
  if ("penguin" in author) return service.privateKey;
  const owner = "person" in author ? author.person : author.identity.slice(1, author.identity.indexOf("/"));
  return owner === "jun" ? junBridge.privateKey : priyaBridge.privateKey;
}

function applied(outcome: ApplyOutcome): void {
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

function rejectedFor(outcome: ApplyOutcome, reason: string): void {
  assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
  assert.equal(outcome.status === "rejected" && outcome.reason, reason, JSON.stringify(outcome));
}

/** Applies one operation of every type and returns the writer and the comment and thread ids. */
async function script(writer: Writer): Promise<{ comment: string; thread: string }> {
  applied(await writer.apply(penguin, "create", { title: "Identity map change breaks analytics" }, 31));
  applied(await writer.apply(jun, "create", { title: "Shared-device merge", body: "Tablet users merge." }, 33));
  applied(await writer.apply(jun, "edit", { title: "Shared-device merge joins strangers" }, 33));
  const comment = await writer.apply(jun, "comment", { body: "A limit of five" }, 33);
  applied(comment);
  applied(await writer.apply(jun, "edit_comment", { comment: comment.operation.op_id, body: "A limit of two" }, 33));
  applied(await writer.apply(penguin, "add_label", { label: "scope:identity-map" }, 33));
  applied(await writer.apply(penguin, "add_label", { label: "huddle" }, 33));
  applied(await writer.apply(penguin, "remove_label", { label: "huddle" }, 33));
  applied(await writer.apply(penguin, "assign", { assignee: { identity: "@priya/merge-rules" } }, 33));
  applied(await writer.apply(penguin, "assign", { assignee: { person: "jun" } }, 33));
  applied(await writer.apply(penguin, "unassign", { assignee: { person: "jun" } }, 33));
  applied(await writer.apply(jun, "mention", { mentioned: { person: "priya" }, comment: comment.operation.op_id }, 33));
  applied(await writer.apply(mergeRules, "link_commit", { commit: "owner-priya@9b2f10", kind: "fix" }, 33));
  applied(
    await writer.apply(
      penguin,
      "attach_check",
      {
        command_id: "analytics",
        commit: "huddle-031@7c41e2",
        test: "test_identity::shared_device_split",
        result: "pass",
      },
      33,
    ),
  );
  applied(await writer.apply(priya, "review", { verdict: "approve", commit: "owner-priya@9b2f10" }, 33));
  const thread = await writer.apply(
    jun,
    "open_thread",
    { body: "Two still joins?", anchor: "ingestion/merge.py:40", needs: ["priya"] },
    33,
  );
  applied(thread);
  applied(await writer.apply(priya, "reply_thread", { thread: thread.operation.op_id, body: "Two is the cap." }, 33));
  applied(await writer.apply(jun, "resolve_thread", { thread: thread.operation.op_id, reason: "Agreed" }, 33));
  applied(await writer.apply(penguin, "change_state", { state: "closed", reason: "approved" }, 33));
  applied(await writer.apply(penguin, "open_sub_issue", { sub_issue: 33 }, 31));
  return { comment: comment.operation.op_id, thread: thread.operation.op_id };
}

describe("IssueIndex", () => {
  test("a scripted sequence of every operation type produces the expected rows", async () => {
    const { db, sql } = sqlite();
    const { comment, thread } = await script(new Writer(new IssueIndex(sql)));

    assert.deepEqual(rows(db, `SELECT * FROM Issue ORDER BY id`), [
      {
        id: "31",
        kind: "issue",
        title: "Identity map change breaks analytics",
        body: "",
        state: "open",
        state_reason: null,
        labels: "[]",
        parent_id: null,
        huddle_id: null,
        version: 2,
      },
      {
        id: "33",
        kind: "issue",
        title: "Shared-device merge joins strangers",
        body: "Tablet users merge.",
        state: "closed",
        state_reason: "approved",
        labels: '["scope:identity-map"]',
        parent_id: "31",
        huddle_id: null,
        version: 18,
      },
    ]);
    assert.deepEqual(rows(db, `SELECT * FROM Assignment`), [
      { issue_id: "33", assignee_kind: "identity", assignee_id: "@priya/merge-rules", session_id: null },
    ]);
    assert.deepEqual(rows(db, `SELECT * FROM Comment`), [
      { id: comment, issue_id: "33", author: "jun", body: "A limit of two" },
    ]);
    assert.deepEqual(rows(db, `SELECT comment_id, rev, body FROM CommentRevision ORDER BY rev`), [
      { comment_id: comment, rev: 1, body: "A limit of five" },
      { comment_id: comment, rev: 2, body: "A limit of two" },
    ]);
    assert.deepEqual(rows(db, `SELECT issue_id, mentioned_kind, mentioned_id, comment_id FROM Mention`), [
      { issue_id: "33", mentioned_kind: "person", mentioned_id: "priya", comment_id: comment },
    ]);
    assert.deepEqual(rows(db, `SELECT issue_id, repo, sha, kind FROM LinkedCommit`), [
      { issue_id: "33", repo: "owner-priya", sha: "9b2f10", kind: "fix" },
    ]);
    assert.deepEqual(rows(db, `SELECT issue_id, command_id, repo, sha, test, result, log_ref FROM IssueCheck`), [
      {
        issue_id: "33",
        command_id: "analytics",
        repo: "huddle-031",
        sha: "7c41e2",
        test: "test_identity::shared_device_split",
        result: "pass",
        log_ref: null,
      },
    ]);
    const reviewColumns = "issue_id, reviewer_owner_id, verdict, reason, repo, commit_sha, counts, uncounted_reason";
    assert.deepEqual(rows(db, `SELECT ${reviewColumns} FROM Review`), [
      {
        issue_id: "33",
        reviewer_owner_id: "priya",
        verdict: "approve",
        reason: null,
        repo: "owner-priya",
        commit_sha: "9b2f10",
        counts: 1,
        uncounted_reason: null,
      },
    ]);
    assert.deepEqual(rows(db, `SELECT * FROM Thread`), [
      {
        id: thread,
        issue_id: "33",
        body: "Two still joins?",
        anchor: "ingestion/merge.py:40",
        opened_by: "jun",
        participants: '["jun","priya"]',
        needs_person_ids: '["priya"]',
        status: "resolved",
        resolved_by: "jun",
        resolve_reason: "Agreed",
        op_id: thread,
      },
    ]);
    assert.deepEqual(rows(db, `SELECT child_id, parent_id FROM SubIssue`), [{ child_id: "33", parent_id: "31" }]);
    const appliedOps = rows(db, `SELECT status, COUNT(*) AS n FROM AppliedOp GROUP BY status`);
    assert.deepEqual(appliedOps, [{ status: "applied", n: 20 }]);
  });

  test("each rejection writes one AppliedOp row, leaves the issue rows alone and shows in the timeline", async () => {
    const { db, sql } = sqlite();
    const index = new IssueIndex(sql);
    const writer = new Writer(index);
    await script(writer);
    const before = dump(db);
    const appliedBefore = rows(db, `SELECT COUNT(*) AS n FROM AppliedOp`)[0]?.["n"] as number;

    rejectedFor(
      await writer.apply(jun, "comment", { body: "forged" }, 33, { key: stranger.privateKey }),
      "bad_signature",
    );
    rejectedFor(await writer.apply(jun, "comment", { body: "stale" }, 33, { base: 3 }), "superseded_version");
    rejectedFor(await writer.apply(jun, "edit_comment", { comment: "jun-b3f2-9999", body: "x" }, 33), "unknown_comment");
    rejectedFor(await writer.apply(jun, "comment", { body: "nowhere" }, 77), "no_issue");
    rejectedFor(
      await writer.applyFile(new TextEncoder().encode("{not json"), "issues/33/ops/jun-b3f2-0500.json"),
      "malformed",
    );

    const after = dump(db);
    for (const table of Object.keys(before).filter((name) => name !== "AppliedOp")) {
      assert.deepEqual(after[table], before[table], `${table} changed`);
    }
    assert.equal(rows(db, `SELECT COUNT(*) AS n FROM AppliedOp`)[0]?.["n"], appliedBefore + 5);

    const rejections = index
      .read("33")
      .timeline.filter((entry) => entry.status === "rejected")
      .map((entry) => [entry.rejectReason, entry.type]);
    assert.deepEqual(rejections, [
      ["bad_signature", "comment"],
      ["superseded_version", "comment"],
      ["unknown_comment", "edit_comment"],
      ["malformed", null],
    ]);
    assert.equal(index.read("33").timeline.length, 18 + 4);
  });

  test("a redelivered operation, applied or rejected, is a duplicate and writes nothing", async () => {
    const { db, sql } = sqlite();
    const writer = new Writer(new IssueIndex(sql));
    await writer.apply(jun, "create", { title: "One" }, 5);
    await writer.apply(jun, "comment", { body: "forged" }, 5, { key: stranger.privateKey });
    const count = (): unknown => rows(db, `SELECT COUNT(*) AS n FROM AppliedOp`)[0]?.["n"];
    assert.equal(count(), 2);
    for (const input of [...writer.inputs]) {
      assert.equal((await writer.applyFile(input.file as Uint8Array, input.path ?? "")).status, "duplicate");
    }
    assert.equal(count(), 2);
  });

  test("a forged file naming someone's op_id does not block the real operation", async () => {
    const { sql } = sqlite();
    const writer = new Writer(new IssueIndex(sql));
    applied(await writer.apply(jun, "create", { title: "One" }, 5));
    const real = await signOperation(
      {
        schema_version: 1,
        op_id: "priya-b3f2-0042",
        issue: 5,
        type: "comment",
        author: priya,
        base_version: 1,
        payload: { body: "real" },
      },
      priyaBridge.privateKey,
    );
    const forged = await signOperation({ ...real, payload: { body: "forged" } }, stranger.privateKey);
    const encode = (op: Operation): Uint8Array => new TextEncoder().encode(JSON.stringify(op));
    rejectedFor(await writer.applyFile(encode(forged), operationPath(forged)), "bad_signature");
    applied(await writer.applyFile(encode(real), operationPath(real)));
  });

  test("replaying the same inputs into an empty index yields identical tables", async () => {
    const first = sqlite();
    const writer = new Writer(new IssueIndex(first.sql));
    await script(writer);
    await writer.apply(jun, "comment", { body: "stale" }, 33, { base: 1 });
    await writer.apply(jun, "comment", { body: "forged" }, 33, { key: stranger.privateKey });

    const second = sqlite();
    const replay = new IssueIndex(second.sql);
    for (const input of writer.inputs) await replay.apply(input);
    assert.deepEqual(dump(second.db), dump(first.db));
  });

  test("the index reloads an issue from SQL into the same state it cached", async () => {
    const { sql } = sqlite();
    const index = new IssueIndex(sql);
    await script(new Writer(index));
    assert.deepEqual(new IssueIndex(sql).issue("33"), index.issue("33"));
    assert.deepEqual(new IssueIndex(sql).issue("31"), index.issue("31"));
  });

  test("a review from someone without review rights is kept and does not approve the fix sub-issue", async () => {
    const { db, sql } = sqlite();
    const index = new IssueIndex(sql);
    const writer = new Writer(index);
    applied(await writer.apply(penguin, "create", { title: "Identity map change breaks analytics" }, 31));
    applied(await writer.apply(penguin, "create", { title: "Fix the shared-device merge" }, 33));
    applied(await writer.apply(penguin, "add_label", { label: "scope:identity-map" }, 33));
    applied(await writer.apply(penguin, "open_sub_issue", { sub_issue: 33 }, 31));

    // jun owns analytics, not identity-map, so the review is kept as a comment that does not count.
    const review = await writer.apply(jun, "review", { verdict: "approve", commit: "owner-priya@9b2f10" }, 33);
    applied(review);
    const fix = index.issue("33");
    assert.equal(fix?.parentId, "31");
    const stored = fix?.reviews.get(review.operation.op_id);
    assert.equal(stored?.counts, false);
    assert.match(stored?.uncountedReason ?? "", /jun owns no scope labelled on this issue/u);
    // Approval, as #42 will decide it, needs an approving review that counts; this is the only review.
    const approved = [...(fix?.reviews.values() ?? [])].some((r) => r.counts && r.verdict === "approve");
    assert.equal(approved, false);
    assert.deepEqual(rows(db, `SELECT reviewer_owner_id, verdict, counts FROM Review`), [
      { reviewer_owner_id: "jun", verdict: "approve", counts: 0 },
    ]);
    const [entry] = index.read("33").timeline.filter((e) => e.type === "review");
    assert.equal(entry?.status, "applied");

    // An identity holds no review right either; its review is kept the same way.
    const changes = { verdict: "request_changes", commit: "owner-priya@9b2f10", reason: "Keep devices split." };
    const identityReview = await writer.apply(mergeRules, "review", changes, 33);
    applied(identityReview);
    assert.equal(index.issue("33")?.reviews.get(identityReview.operation.op_id)?.counts, false);
    // The owner of the labelled scope still counts.
    const ownerReview = await writer.apply(priya, "review", { verdict: "approve", commit: "owner-priya@9b2f10" }, 33);
    assert.equal(new IssueIndex(sql).issue("33")?.reviews.get(ownerReview.operation.op_id)?.counts, true);
  });

  test("a Review table from before #49 gains the counts columns, and its reviews count", () => {
    const { db, sql } = sqlite();
    sql.exec(`CREATE TABLE Review (
      op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, reviewer_owner_id TEXT NOT NULL, verdict TEXT NOT NULL,
      reason TEXT, repo TEXT NOT NULL, commit_sha TEXT NOT NULL)`);
    sql.exec(
      `INSERT INTO Review VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "priya-b3f2-0001",
      "33",
      "priya",
      "approve",
      null,
      "owner-priya",
      "9b2f10",
    );
    new IssueIndex(sql);
    new IssueIndex(sql);
    const columns = rows(db, `PRAGMA table_info(Review)`).map((column) => column["name"]);
    assert.deepEqual(columns.slice(-2), ["counts", "uncounted_reason"]);
    assert.deepEqual(rows(db, `SELECT counts, uncounted_reason FROM Review`), [{ counts: 1, uncounted_reason: null }]);
    // A fresh table has the same columns in the same order, so a rebuild compares them row for row.
    const fresh = sqlite();
    new IssueIndex(fresh.sql);
    assert.deepEqual(rows(fresh.db, `PRAGMA table_info(Review)`), rows(db, `PRAGMA table_info(Review)`));
  });

  test("text that looks like SQL is stored as text", async () => {
    const { db, sql } = sqlite();
    const title = "x'; DROP TABLE Issue; --";
    applied(await new Writer(new IssueIndex(sql)).apply(jun, "create", { title }, 9));
    assert.deepEqual(rows(db, `SELECT title FROM Issue`), [{ title }]);
  });

  test("applies one thousand operations", async (t) => {
    const { sql } = sqlite();
    const index = new IssueIndex(sql);
    const files: Uint8Array[] = [];
    const paths: string[] = [];
    for (let seq = 1; seq <= 1000; seq += 1) {
      const operation = await signOperation(
        {
          schema_version: 1,
          op_id: formatOpId(jun, BRIDGE_TAG, seq),
          issue: 1,
          type: seq === 1 ? "create" : "comment",
          author: jun,
          base_version: seq - 1,
          payload: seq === 1 ? { title: "Load" } : { body: `Comment ${seq}` },
        },
        junBridge.privateKey,
      );
      files.push(new TextEncoder().encode(JSON.stringify(operation)));
      paths.push(operationPath(operation));
    }
    const start = performance.now();
    const outcomes = await Promise.all(
      files.map((file, i) => index.apply({ file, gitCommit: "c1", path: paths[i], keys })),
    );
    const elapsed = performance.now() - start;
    assert.ok(outcomes.every((outcome) => outcome.status === "applied"));
    assert.equal(index.issue("1")?.version, 1000);
    t.diagnostic(`applied 1000 operations in ${elapsed.toFixed(0)} ms`);
  });
});
