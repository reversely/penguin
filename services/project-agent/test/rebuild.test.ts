import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import { generateSigningKeyPair, signOperation } from "@penguin/issues";
import { formatOpId, operationPath, type Author, type IssueId, type Operation } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { ISSUE_INDEX_SCHEMA, IssueIndex, type OperationKeys, type SqlDatabase } from "../src/issue-index.ts";
import { IngestLedger, ingestPush } from "../src/push-ingest.ts";
import { COMPARED_TABLES, LIVE_ONLY_TABLES, rebuildIndex, SHADOW_PREFIX } from "../src/rebuild.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

const penguin: Author = { penguin: true };
const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };
const sam: Author = { person: "sam" };

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
    identities: { byHandle: () => undefined },
    bridges: [
      { bridgeId: "bridge-jun", ownerId: "jun", publicKey: junBridge.publicKey },
      { bridgeId: "bridge-priya", ownerId: "priya", publicKey: priyaBridge.publicKey },
    ],
    serviceKey: service.publicKey,
    scopeMap,
  };
});

/** Signs operation files the way each author's bridge would; tracks each author's sequence numbers. */
class Ops {
  readonly #seqs = new Map<string, number>();

  async file(
    author: Author,
    type: Operation["type"],
    payload: Record<string, unknown>,
    issue: IssueId,
    base: number,
    signWith?: CryptoKey,
  ): Promise<[string, string]> {
    const seqKey = JSON.stringify(author);
    const seq = (this.#seqs.get(seqKey) ?? 0) + 1;
    this.#seqs.set(seqKey, seq);
    const operation = await signOperation(
      { schema_version: 1, op_id: formatOpId(author, seq), issue, type, author, base_version: base, payload },
      signWith ?? signingKey(author),
    );
    return [operationPath(operation), JSON.stringify(operation)];
  }
}

function signingKey(author: Author): CryptoKey {
  if ("penguin" in author) return service.privateKey;
  if ("person" in author && author.person === "priya") return priyaBridge.privateKey;
  return junBridge.privateKey;
}

/** The live side of the ProjectAgent over node:sqlite, with a push step standing in for the Queue. */
class Project {
  readonly repo = new GitRepo();
  readonly ops = new Ops();
  readonly sqlite = sqlite();
  readonly sql: SqlDatabase = this.sqlite.sql;
  readonly index = new IssueIndex(this.sql);
  readonly ledger = new IngestLedger(this.sql);

  /** Commits the files and, unless `deliver` is false, ingests the push event for the commit. */
  async push(files: [string, string][], deliver = true): Promise<string> {
    const head = this.repo.commit(Object.fromEntries(files));
    if (deliver) await this.ingest(head);
    return head;
  }

  async ingest(head: string): Promise<void> {
    await ingestPush(this.repo.reader(), head, this.ledger, (file, commit) =>
      this.index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
    );
  }

  /** Applies an operation from the dashboard at once and leaves it pending. */
  async submit(author: Author, operation: Record<string, unknown>): Promise<void> {
    const signingKey = service.privateKey;
    const outcome = await this.index.submit({ operation, author, source: "dashboard", signingKey, keys });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  }

  /** The runner's pass: commits every pending operation file in one commit and delivers the push. */
  async runnerPass(): Promise<string> {
    const listing = this.index.pendingFiles({ bridgeId: "bridge-runner", role: "runner" });
    assert.equal(listing.status, "ok");
    if (listing.status !== "ok") throw new Error("unreachable");
    return this.push(listing.files.map((file) => [file.path, file.file]));
  }

  rebuild(): ReturnType<typeof rebuildIndex> {
    return rebuildIndex({ repo: this.repo.reader(), db: this.sql, live: { index: this.index, ledger: this.ledger }, keys });
  }

  /** Every live table's rows; shadow tables left out. */
  liveDump(): Record<string, unknown[]> {
    const tables = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
    return Object.fromEntries(
      tables
        .map((row) => String(row["name"]))
        .filter((name) => !name.startsWith(SHADOW_PREFIX))
        .map((name) => [name, this.sql.exec(`SELECT * FROM "${name}" ORDER BY rowid`)]),
    );
  }
}

/**
 * The exit-check history: three issues, operations from two bridges, Penguin and the dashboard over
 * six pushes (the dashboard's through a runner pass), with rejections for a bad signature, a
 * superseded version, an unknown version, a review without the right, a file that is not JSON, and
 * an edit of an unknown comment.
 */
async function scriptedHistory(project: Project): Promise<void> {
  const { ops } = project;
  await project.push([
    await ops.file(penguin, "create", { title: "Identity map change breaks analytics" }, 31, 0),
    await ops.file(jun, "create", { title: "Shared-device merge" }, 33, 0),
    await ops.file(priya, "create", { title: "Messaging sync drops merged users" }, 32, 0),
  ]);
  const comment = await ops.file(jun, "comment", { body: "A limit of five" }, 33, 1);
  const commentId = (JSON.parse(comment[1]) as Operation).op_id;
  await project.push([
    comment,
    await ops.file(jun, "comment", { body: "forged" }, 33, 1, stranger.privateKey),
    await ops.file(priya, "add_label", { label: "scope:identity-map" }, 32, 1),
  ]);
  await project.push([
    await ops.file(jun, "edit_comment", { comment: commentId, body: "A limit of two" }, 33, 2),
    await ops.file(jun, "comment", { body: "stale" }, 33, 1),
    await ops.file(jun, "comment", { body: "from the future" }, 33, 9),
    await ops.file(jun, "review", { verdict: "approve", commit: "owner-priya@9b2f10" }, 33, 3),
    await ops.file(jun, "edit_comment", { comment: "jun-9999", body: "x" }, 33, 3),
    ["issues/32/ops/jun-0099.json", "not json"],
  ]);
  // Sam writes only from the dashboard: a bridge and the dashboard writing for one author share
  // one op_id sequence, and this history keeps clear of that open protocol gap.
  const assignee = { identity: "@priya/merge-rules" };
  await project.submit(sam, { issue: 33, type: "assign", base_version: 3, payload: { assignee } });
  await project.submit(sam, { issue: 31, type: "comment", base_version: 1, payload: { body: "Seen on the dashboard" } });
  await project.runnerPass();
  // One commit holding a chain on issue 33: the label gives priya the right to review.
  await project.push([
    await ops.file(priya, "review", { verdict: "approve", commit: "owner-priya@9b2f10" }, 33, 5),
    await ops.file(penguin, "add_label", { label: "scope:identity-map" }, 33, 4),
    await ops.file(penguin, "open_sub_issue", { sub_issue: 33 }, 31, 2),
  ]);
  await project.push([await ops.file(penguin, "change_state", { state: "closed", reason: "approved" }, 33, 6)]);
}

describe("rebuildIndex", () => {
  test("after a mix of applied and rejected operations across issues, the rebuild equals the live index", async (t) => {
    const project = new Project();
    await scriptedHistory(project);

    const report = await project.rebuild();

    assert.equal(report.comparison.equal, true, JSON.stringify(report.comparison.differences, null, 2));
    assert.deepEqual(report.pendingOps, []);
    assert.equal(report.caughtUp?.files, 0);
    assert.equal(report.rebuilt?.commits, 6);
    assert.deepEqual(report.rebuilt?.outcomes, { applied: 12, rejected: 6 });
    const tables = report.comparison.tables;
    assert.equal(tables["Issue"]?.live, 3);
    assert.equal(tables["AppliedOp"]?.live, 18);
    assert.equal(tables["Review"]?.live, 1);
    assert.deepEqual(
      Object.values(tables).map((table) => table.live === table.shadow && table.differing === 0),
      Object.keys(COMPARED_TABLES).map(() => true),
    );
    // The PRD sets no time budget for a rebuild; the ticket asks for the time and binding calls.
    const calls = JSON.stringify(report.bindingCalls);
    t.diagnostic(`rebuild of 6 commits, 18 files: ${report.durationMs} ms, binding calls ${calls}`);
  });

  test("a live row corrupted by hand is reported with both versions", async () => {
    const project = new Project();
    await scriptedHistory(project);
    project.sql.exec(`UPDATE Issue SET title = ? WHERE id = ?`, "Corrupted", "32");

    const { comparison } = await project.rebuild();

    assert.equal(comparison.equal, false);
    assert.equal(comparison.differences.length, 1);
    const [difference] = comparison.differences;
    assert.equal(difference?.table, "Issue");
    assert.deepEqual(difference?.key, { id: "32" });
    assert.equal(difference?.live?.["title"], "Corrupted");
    assert.equal(difference?.shadow?.["title"], "Messaging sync drops merged users");
    assert.equal(comparison.tables["Issue"]?.differing, 1);
  });

  test("a live row deleted or added by hand is reported against the side that lacks it", async () => {
    const project = new Project();
    await scriptedHistory(project);
    project.sql.exec(`DELETE FROM Comment WHERE issue_id = ?`, "33");
    const insert = `INSERT INTO Assignment (issue_id, assignee_kind, assignee_id) VALUES (?, ?, ?)`;
    project.sql.exec(insert, "32", "person", "sam");

    const { comparison } = await project.rebuild();

    assert.deepEqual(
      comparison.differences.map((d) => [d.table, d.key, d.live === null, d.shadow === null]),
      [
        ["Assignment", { issue_id: "32", assignee_kind: "person", assignee_id: "sam" }, false, true],
        ["Comment", { id: "jun-0002" }, true, false],
      ],
    );
  });

  test("a second rebuild with no new operations gives the same result", async () => {
    const project = new Project();
    await scriptedHistory(project);
    project.sql.exec(`UPDATE AppliedOp SET reject_reason = ? WHERE op_id = ?`, "bad_signature", "jun-0005");

    const first = await project.rebuild();
    const second = await project.rebuild();

    assert.equal(first.head, second.head);
    assert.deepEqual(second.comparison, first.comparison);
    assert.deepEqual(second.rebuilt, first.rebuilt);
    assert.deepEqual(second.comparison.differences.map((d) => [d.table, d.key]), [["AppliedOp", { op_id: "jun-0005" }]]);
  });

  test("the rebuild leaves the live tables as they were", async () => {
    const project = new Project();
    await scriptedHistory(project);
    const before = project.liveDump();

    await project.rebuild();

    assert.deepEqual(project.liveDump(), before);
  });

  test("a push whose event never arrived is applied to the live index before the comparison", async () => {
    const project = new Project();
    await scriptedHistory(project);
    const missed = await project.push([await project.ops.file(jun, "comment", { body: "Event lost" }, 32, 2)], false);

    const report = await project.rebuild();

    assert.equal(report.head, missed);
    assert.deepEqual(report.caughtUp?.outcomes, { applied: 1 });
    assert.equal(report.comparison.equal, true);
    assert.equal(project.index.issue("32")?.version, 3);
  });

  test("an operation still waiting for the runner is listed and shows as a difference", async () => {
    const project = new Project();
    await scriptedHistory(project);
    await project.submit(sam, { issue: 32, type: "comment", base_version: 2, payload: { body: "Not pushed yet" } });

    const report = await project.rebuild();

    assert.deepEqual(report.pendingOps, ["sam-0003"]);
    assert.equal(report.comparison.equal, false);
    assert.deepEqual(
      report.comparison.differences.map((d) => [d.table, d.key, d.shadow === null]),
      [
        ["Issue", { id: "32" }, false],
        ["Comment", { id: "sam-0003" }, true],
        ["CommentRevision", { comment_id: "sam-0003", rev: 1 }, true],
        ["AppliedOp", { op_id: "sam-0003" }, true],
      ],
    );
  });

  test("an operation applied live before an earlier Git commit is judged in Git order by the rebuild", async () => {
    // The known gap between live order and Git order: the dashboard comment is applied live first,
    // but the runner's commit lands after jun's push, and both are based on version 1.
    const project = new Project();
    await project.push([await project.ops.file(jun, "create", { title: "Race" }, 40, 0)]);
    await project.submit(priya, { issue: 40, type: "comment", base_version: 1, payload: { body: "From the dashboard" } });
    await project.push([await project.ops.file(jun, "comment", { body: "From the bridge" }, 40, 1)]);
    await project.runnerPass();

    const report = await project.rebuild();

    const appliedOp = report.comparison.differences.filter((d) => d.table === "AppliedOp");
    assert.deepEqual(
      appliedOp.map((d) => [d.key["op_id"], d.live?.["status"], d.shadow?.["status"]]),
      [
        ["priya-0001", "applied", "rejected"],
        ["jun-0002", "rejected", "applied"],
      ],
    );
    assert.equal(report.comparison.equal, false);
  });

  test("an issues repo with no commits rebuilds to an empty index equal to an empty live one", async () => {
    const project = new Project();

    const report = await project.rebuild();

    assert.equal(report.head, null);
    assert.equal(report.comparison.equal, true);
    assert.deepEqual(report.bindingCalls, { log: 1 });
  });

  test("every table of the index is either compared or known to exist only live", () => {
    const tableName = /^CREATE TABLE IF NOT EXISTS (\w+)/u;
    const tables = ISSUE_INDEX_SCHEMA.flatMap((statement) => tableName.exec(statement)?.[1] ?? []);
    assert.deepEqual(new Set(tables), new Set([...Object.keys(COMPARED_TABLES), ...LIVE_ONLY_TABLES]));
  });
});
