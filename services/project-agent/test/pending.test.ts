import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair, signOperation, validate, verifyOperation } from "@penguin/issues";
import { operationPath, parseOperationFile, type Author, type Operation } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import {
  IssueIndex,
  type OperationKeys,
  type PendingFile,
  type PendingSource,
  type SqlDatabase,
  type SubmitOutcome,
} from "../src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

const jun: Author = { person: "jun" };
const priya: Author = { person: "priya" };
const reports: Author = { identity: "@jun/reports" };
const penguin: Author = { penguin: true };
const runner = { bridgeId: "bridge-runner", role: "runner" } as const;

let service: ServiceKey;
let junBridge: CryptoKeyPair;
let stranger: CryptoKeyPair;
let keys: OperationKeys;

before(async () => {
  const pair = await generateSigningKeyPair();
  // K5 as the deployer stores it: the private key's JWK as a JSON string.
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  [junBridge, stranger] = await Promise.all([generateSigningKeyPair(), generateSigningKeyPair()]);
  keys = {
    bridges: [{ bridgeId: "bridge-jun", ownerId: "jun", publicKey: junBridge.publicKey }],
    serviceKey: service.publicKey,
    scopeMap,
    identities: { byHandle: () => undefined },
  };
});

function sqlite(): { db: DatabaseSync; index: IssueIndex } {
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
  return { db, index: new IssueIndex(sql) };
}

function rows(db: DatabaseSync, query: string, ...params: string[]): Record<string, unknown>[] {
  return db
    .prepare(query)
    .all(...params)
    .map((row) => ({ ...row }));
}

function submit(
  index: IssueIndex,
  operation: unknown,
  author: Author = jun,
  source: PendingSource = "dashboard",
): Promise<SubmitOutcome> {
  return index.submit({ operation, author, source, signingKey: service.privateKey, keys, now: 1_700_000_000_000 });
}

function create(title: string, issue: number | string = 40): Record<string, unknown> {
  return { issue, type: "create", base_version: 0, payload: { title } };
}

function pending(index: IssueIndex): PendingFile[] {
  const listing = index.pendingFiles(runner);
  assert.equal(listing.status, "ok");
  return listing.status === "ok" ? listing.files : [];
}

/** Delivers a pending file the way the push event consumer does once the runner has pushed it. */
function push(index: IssueIndex, file: PendingFile | { file: string; path: string }, gitCommit = "abc123") {
  return index.apply({ file: new TextEncoder().encode(file.file), gitCommit, path: file.path, keys });
}

describe("submitted operations", () => {
  test("apply at once, hold a PendingOp row and show as waiting for the Git log", async () => {
    const { db, index } = sqlite();
    const outcome = await submit(index, create("Board filter drops identities"));

    assert.deepEqual(outcome, {
      status: "applied",
      opId: "jun-web-0001",
      issueId: "40",
      version: 1,
      path: "issues/40/ops/jun-web-0001.json",
    });
    assert.equal(index.issue("40")?.title, "Board filter drops identities");
    assert.deepEqual(rows(db, `SELECT op_id, source, created_at FROM PendingOp`), [
      { op_id: "jun-web-0001", source: "dashboard", created_at: 1_700_000_000_000 },
    ]);
    const [entry] = index.read("40").timeline;
    assert.equal(entry?.status, "applied");
    assert.equal(entry?.author, "jun");
    assert.equal(entry?.gitCommit, null);
    assert.equal(entry?.waitingForGitLog, true);
  });

  test("the runner listing returns each as a file that verifies under K5 and passes the schema", async () => {
    const { index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    await submit(index, { issue: 40, type: "comment", base_version: 1, payload: { body: "Seen on mobile" } }, reports, "mcp");

    const files = pending(index);
    assert.deepEqual(
      files.map((file) => [file.opId, file.path, file.source]),
      [
        ["jun-web-0001", "issues/40/ops/jun-web-0001.json", "dashboard"],
        ["jun.reports-web-0001", "issues/40/ops/jun.reports-web-0001.json", "mcp"],
      ],
    );
    for (const file of files) {
      const parsed = parseOperationFile(new TextEncoder().encode(file.file));
      assert.ok(parsed.ok, JSON.stringify(parsed));
      assert.equal(operationPath(parsed.operation), file.path);
      assert.equal(await verifyOperation(parsed.operation, service.publicKey), true);
      assert.ok(file.file.endsWith("}\n"));
    }
    const [first] = files;
    const verdict = await validate(first?.file, {
      ...keys,
      issue: undefined,
      appliedOpIds: new Set(),
      identities: { identity: () => undefined, assigningOwner: () => undefined },
      path: first?.path ?? "",
    });
    assert.equal(verdict.status, "accepted");
  });

  test("the push event clears the PendingOp row and sets git_commit without a second AppliedOp row", async () => {
    const { db, index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    const [file] = pending(index);
    assert.ok(file);

    assert.deepEqual(await push(index, file, "abc123"), { status: "duplicate", opId: "jun-web-0001" });
    assert.deepEqual(rows(db, `SELECT * FROM PendingOp`), []);
    assert.deepEqual(rows(db, `SELECT op_id, status, git_commit FROM AppliedOp`), [
      { op_id: "jun-web-0001", status: "applied", git_commit: "abc123" },
    ]);
    assert.equal(index.read("40").timeline[0]?.waitingForGitLog, false);
    assert.equal(index.issue("40")?.version, 1);

    // A second delivery of the same event changes nothing.
    assert.deepEqual(await push(index, file, "def456"), { status: "duplicate", opId: "jun-web-0001" });
    assert.deepEqual(rows(db, `SELECT op_id, git_commit FROM AppliedOp`), [{ op_id: "jun-web-0001", git_commit: "abc123" }]);
  });

  test("a different file that names a pending op_id leaves the operation pending", async () => {
    const { db, index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    const [file] = pending(index);
    assert.ok(file);
    const original = JSON.parse(file.file) as Operation;

    const forged = await signOperation({ ...original, payload: { title: "Forged" } }, stranger.privateKey);
    await push(index, { file: JSON.stringify(forged), path: file.path });
    // The genuine file stored at another path does not count either.
    await push(index, { file: file.file, path: "issues/41/ops/jun-web-0001.json" });

    assert.deepEqual(rows(db, `SELECT op_id FROM PendingOp`), [{ op_id: "jun-web-0001" }]);
    assert.deepEqual(rows(db, `SELECT op_id, git_commit FROM AppliedOp WHERE op_id = 'jun-web-0001'`), [
      { op_id: "jun-web-0001", git_commit: null },
    ]);
    assert.equal(index.issue("40")?.title, "Board filter drops identities");
  });

  test("with the runner offline the operations stay applied and waiting", async () => {
    const { index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    for (let version = 1; version <= 4; version += 1) {
      const outcome = await submit(index, { issue: 40, type: "comment", base_version: version, payload: { body: `Note ${version}` } });
      assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    }
    const { issue, timeline } = index.read("40");
    assert.equal(issue?.comments.size, 4);
    assert.deepEqual(
      timeline.map((entry) => entry.waitingForGitLog),
      [true, true, true, true, true],
    );
    assert.deepEqual(
      pending(index).map((file) => file.opId),
      ["jun-web-0001", "jun-web-0002", "jun-web-0003", "jun-web-0004", "jun-web-0005"],
    );
  });

  test("concurrent submissions take distinct op_ids", async () => {
    const { index } = sqlite();
    const outcomes = await Promise.all([
      submit(index, create("One", 50)),
      submit(index, create("Two", 51)),
      submit(index, create("Three", 52)),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status === "applied" && outcome.opId),
      ["jun-web-0001", "jun-web-0002", "jun-web-0003"],
    );
  });

  test("op_ids continue the Worker's own sequence and ignore bridge and forged sequence numbers", async () => {
    const { index } = sqlite();
    const fromBridge = await signOperation(
      { schema_version: 1, op_id: "jun-b3f2-0003", issue: 40, type: "create", author: jun, base_version: 0, payload: { title: "From the bridge" } },
      junBridge.privateKey,
    );
    const forged = await signOperation(
      { schema_version: 1, op_id: "jun-web-0500", issue: 40, type: "comment", author: jun, base_version: 1, payload: { body: "Forged" } },
      stranger.privateKey,
    );
    for (const operation of [fromBridge, forged]) {
      await index.apply({
        file: new TextEncoder().encode(JSON.stringify(operation)),
        gitCommit: "c0ffee",
        path: operationPath(operation),
        keys,
      });
    }

    // The bridge numbers its own sequence under its own tag, so the Worker's starts at 1.
    const first = await submit(index, { issue: 40, type: "comment", base_version: 1, payload: { body: "From the dashboard" } });
    assert.equal(first.status === "applied" && first.opId, "jun-web-0001");

    // A Worker operation read back from the issues repo, as after a rebuild, moves the Worker's counter.
    const fromRepo = await signOperation(
      { schema_version: 1, op_id: "jun-web-0007", issue: 40, type: "comment", author: jun, base_version: 2, payload: { body: "Earlier" } },
      service.privateKey,
    );
    await index.apply({
      file: new TextEncoder().encode(JSON.stringify(fromRepo)),
      gitCommit: "c0ffee",
      path: operationPath(fromRepo),
      keys,
    });
    const next = await submit(index, { issue: 40, type: "comment", base_version: 3, payload: { body: "Later" } });
    assert.equal(next.status === "applied" && next.opId, "jun-web-0008");
  });

  test("a submission to an issue created offline is written under its temporary ID, named either way", async () => {
    const { index } = sqlite();
    const offline = await signOperation(
      { schema_version: 1, op_id: "jun-b3f2-0001", issue: "jun-b3f2-0001", type: "create", author: jun, base_version: 0, payload: { title: "Offline" } },
      junBridge.privateKey,
    );
    const created = await index.apply({
      file: new TextEncoder().encode(JSON.stringify(offline)),
      gitCommit: "c0ffee",
      path: operationPath(offline),
      keys,
    });
    assert.equal(created.status === "applied" && created.issueId, "1");

    const byNumber = await submit(index, { issue: 1, type: "comment", base_version: 1, payload: { body: "By number" } });
    const byAlias = await submit(index, { issue: "jun-b3f2-0001", type: "comment", base_version: 2, payload: { body: "By alias" } });
    for (const [outcome, opId] of [[byNumber, "jun-web-0001"], [byAlias, "jun-web-0002"]] as const) {
      assert.equal(outcome.status, "applied", JSON.stringify(outcome));
      assert.equal(outcome.status === "applied" && outcome.issueId, "1");
      assert.equal(outcome.status === "applied" && outcome.path, `issues/jun-b3f2-0001/ops/${opId}.json`);
    }
    assert.equal(index.issue("1")?.version, 3);
  });

  test("a rejected submission is returned to the caller and recorded nowhere", async () => {
    const { db, index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    const stale = await submit(index, { issue: 40, type: "comment", base_version: 0, payload: { body: "Late" } });
    assert.deepEqual(stale, {
      status: "rejected",
      reason: "superseded_version",
      message: "based on version 0; the issue is at version 1",
    });
    const bad = await submit(index, { issue: 40, type: "comment", base_version: 1, payload: {} });
    assert.equal(bad.status === "rejected" && bad.reason, "malformed");
    const missing = await submit(index, { issue: 40, type: "comment", base_version: 1 });
    assert.equal(missing.status === "rejected" && missing.reason, "malformed");

    assert.equal(rows(db, `SELECT * FROM AppliedOp`).length, 1);
    assert.equal(rows(db, `SELECT * FROM PendingOp`).length, 1);
    const next = await submit(index, { issue: 40, type: "comment", base_version: 1, payload: { body: "On time" } });
    assert.equal(next.status === "applied" && next.opId, "jun-web-0002");
  });
});

describe("submission security", () => {
  test("a caller cannot set the author to anyone but itself", async () => {
    const { db, index } = sqlite();
    const asPriya = await submit(index, { ...create("Spoofed"), author: priya });
    assert.equal(asPriya.status === "rejected" && asPriya.reason, "author_not_bound");
    const asPenguin = await submit(index, { ...create("Spoofed"), author: penguin });
    assert.equal(asPenguin.status === "rejected" && asPenguin.reason, "author_not_bound");

    // Repeating the caller's own author is allowed.
    const asSelf = await submit(index, { ...create("Own"), author: jun });
    assert.equal(asSelf.status, "applied");
    assert.deepEqual(JSON.parse(pending(index)[0]?.file ?? "{}").author, jun);
    assert.equal(rows(db, `SELECT * FROM AppliedOp`).length, 1);
  });

  test("Penguin sets op_id, signature and schema_version", async () => {
    const { index } = sqlite();
    for (const field of [{ op_id: "jun-web-0009" }, { signature: "AAAA" }, { schema_version: 1 }]) {
      const outcome = await submit(index, { ...create("Own"), ...field });
      assert.equal(outcome.status === "rejected" && outcome.reason, "malformed", JSON.stringify(field));
    }
    for (const operation of [null, [], "text"]) {
      const outcome = await submit(index, operation);
      assert.equal(outcome.status === "rejected" && outcome.reason, "malformed");
    }
  });

  test("each source writes only as its own kind of author", async () => {
    const { index } = sqlite();
    const cases: [Author, PendingSource, string][] = [
      [reports, "dashboard", "rejected"],
      [penguin, "dashboard", "rejected"],
      [penguin, "mcp", "rejected"],
      [jun, "penguin", "rejected"],
      [reports, "mcp", "applied"],
    ];
    for (const [index_, [author, source, status]] of cases.entries()) {
      const outcome = await submit(index, create("Case", 60 + index_), author, source);
      assert.equal(outcome.status, status, `${JSON.stringify(author)} through ${source}`);
    }
    const asPenguin = await submit(index, create("Huddle", 70), penguin, "penguin");
    assert.equal(asPenguin.status === "applied" && asPenguin.opId, "penguin-web-0001");
  });

  test("the pending listing rejects a bridge without the runner role", async () => {
    const { index } = sqlite();
    await submit(index, create("Board filter drops identities"));
    const listing = index.pendingFiles({ bridgeId: "bridge-jun", role: "owner" });
    assert.equal(listing.status, "forbidden");
    assert.ok(!("files" in listing));
  });

  test("K5 imports as a non-extractable signing key and its errors never quote the secret", async () => {
    await assert.rejects(crypto.subtle.exportKey("jwk", service.privateKey));
    await assert.rejects(importServiceKey(undefined), /PENGUIN_OP_SIGNING_KEY is not set/u);
    const notJson = "k5-value-that-is-not-json";
    await assert.rejects(importServiceKey(notJson), (error: Error) => !error.message.includes(notJson));
    const publicOnly = { kty: "OKP", crv: "Ed25519", x: "AAAA" };
    await assert.rejects(importServiceKey(JSON.stringify(publicOnly)), /not an Ed25519 private/u);
  });
});
