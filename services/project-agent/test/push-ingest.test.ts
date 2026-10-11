import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair, signOperation } from "@penguin/issues";
import { formatOpId, operationPath, type Author, type IssueId, type Operation } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { BridgeRegistry } from "../src/bridge-registry.ts";
import { IssueIndex, type ApplyOutcome, type OperationKeys, type SqlDatabase } from "../src/issue-index.ts";
import {
  IngestLedger,
  ingestPush,
  type AddedOperationFile,
  type IssuesRepoReader,
  type RepoTreeEntry,
} from "../src/push-ingest.ts";

const penguin: Author = { penguin: true };
const jun: Author = { person: "jun" };

let service: CryptoKeyPair;
let junBridge: CryptoKeyPair;
let stranger: CryptoKeyPair;
let keys: OperationKeys;
const tempDirs: string[] = [];

before(async () => {
  [service, junBridge, stranger] = await Promise.all([
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
  ]);
  keys = {
    bridges: [{ bridgeId: "bridge-jun", ownerId: "jun", publicKey: junBridge.publicKey }],
    serviceKey: service.publicKey,
    scopeMap: parseScopeMap({ scopes: [] }),
    identities: { byHandle: () => undefined },
  };
});

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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

/** A real Git repo on disk standing in for the issues repo, read through the binding's methods. */
class GitRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "penguin-issues-"));

  constructor() {
    tempDirs.push(this.dir);
    this.git("init", "--quiet", "--initial-branch=main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", this.dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  /** Writes the files and commits them on the current branch; returns the commit SHA. */
  commit(files: Record<string, string | Uint8Array>, message = "ops"): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), content);
    }
    this.git("add", "--all");
    this.git("commit", "--quiet", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** Counts each method call, like the ProjectAgent's binding report. */
  readonly calls: Record<string, number> = {};

  reader(): IssuesRepoReader {
    const count = (method: string): void => {
      this.calls[method] = (this.calls[method] ?? 0) + 1;
    };
    return {
      log: async ({ ref, limit, offset }) => {
        count("log");
        let out: string;
        try {
          out = this.git("log", "--first-parent", "--format=%H %T", `--skip=${offset}`, `-n${limit}`, ref, "--");
        } catch {
          return [];
        }
        return out === ""
          ? []
          : out.split("\n").map((line) => {
              const [hash, treeHash] = line.split(" ") as [string, string];
              return { hash, treeHash };
            });
      },
      readTree: async (hash) => {
        count("readTree");
        const out = this.git("ls-tree", hash);
        return out === "" ? [] : out.split("\n").map(treeEntry);
      },
      readBlob: async (hash) => {
        count("readBlob");
        return new Blob([execFileSync("git", ["-C", this.dir, "cat-file", "blob", hash])]);
      },
    };
  }
}

function treeEntry(line: string): RepoTreeEntry {
  const [meta, name] = line.split("\t") as [string, string];
  const [mode, , hash] = meta.split(" ") as [string, string, string];
  const type = mode === "040000" ? "tree" : mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob";
  return { name, hash, type };
}

/** Builds signed operation files; tracks each author's sequence numbers. */
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
    const key = signWith ?? ("penguin" in author ? service.privateKey : junBridge.privateKey);
    const operation = await signOperation(
      { schema_version: 1, op_id: formatOpId(author, seq), issue, type, author, base_version: base, payload },
      key,
    );
    return [operationPath(operation), JSON.stringify(operation)];
  }
}

/**
 * The index, ledger, bridge registry and apply callback the ProjectAgent wires together, over
 * node:sqlite. `keysFor` stands in for the agent loading its keys for each ingest.
 */
function agent(keysFor?: (bridges: BridgeRegistry) => Promise<OperationKeys>): {
  db: DatabaseSync;
  index: IssueIndex;
  ledger: IngestLedger;
  bridges: BridgeRegistry;
  apply: (file: AddedOperationFile, commit: string) => Promise<ApplyOutcome>;
  order: string[];
} {
  const { db, sql } = sqlite();
  const index = new IssueIndex(sql);
  const bridges = new BridgeRegistry(sql);
  const order: string[] = [];
  return {
    db,
    index,
    ledger: new IngestLedger(sql),
    bridges,
    order,
    apply: async (file, commit) => {
      order.push(file.path);
      const fileKeys = keysFor === undefined ? keys : await keysFor(bridges);
      return index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys: fileKeys });
    },
  };
}

function appliedOps(db: DatabaseSync): Record<string, unknown>[] {
  return db
    .prepare(`SELECT op_id, status, reject_reason, git_commit FROM AppliedOp ORDER BY seq`)
    .all()
    .map((row) => ({ ...row }));
}

describe("ingestPush", () => {
  test("an operation pushed from a bridge appears in the index as applied", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const create = await ops.file(jun, "create", { title: "Shared-device merge" }, 33, 0);
    const head = repo.commit(Object.fromEntries([create]));
    const a = agent();

    const report = await ingestPush(repo.reader(), head, a.ledger, a.apply);

    assert.deepEqual(report.outcomes, { applied: 1 });
    assert.equal(report.commits, 1);
    assert.equal(a.index.issue("33")?.title, "Shared-device merge");
    assert.deepEqual(appliedOps(a.db), [
      { op_id: "jun-0001", status: "applied", reject_reason: null, git_commit: head },
    ]);
  });

  test("an operation with a bad signature appears on its issue as rejected, and its file stays", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const create = await ops.file(jun, "create", { title: "Shared-device merge" }, 33, 0);
    const forged = await ops.file(jun, "comment", { body: "forged" }, 33, 1, stranger.privateKey);
    repo.commit(Object.fromEntries([create]));
    const head = repo.commit(Object.fromEntries([forged]));
    const a = agent();

    await ingestPush(repo.reader(), head, a.ledger, a.apply);

    const timeline = a.index.read("33").timeline;
    assert.equal(timeline.length, 2);
    assert.equal(timeline[1]?.status, "rejected");
    assert.equal(timeline[1]?.rejectReason, "bad_signature");
    assert.equal(timeline[1]?.gitCommit, head);
    assert.equal(repo.git("cat-file", "-t", `${head}:${forged[0]}`), "blob");
  });

  test("delivering the same push twice yields one AppliedOp row per operation", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const head = repo.commit(
      Object.fromEntries([
        await ops.file(jun, "create", { title: "One" }, 33, 0),
        await ops.file(jun, "comment", { body: "bad" }, 33, 1, stranger.privateKey),
      ]),
    );
    const a = agent();

    await ingestPush(repo.reader(), head, a.ledger, a.apply);
    const again = await ingestPush(repo.reader(), head, a.ledger, a.apply);

    assert.deepEqual({ commits: again.commits, files: again.files }, { commits: 0, files: 0 });
    assert.equal(appliedOps(a.db).length, 2);
  });

  test("a push processed before an earlier one applies both in commit order", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const first = repo.commit(Object.fromEntries([await ops.file(jun, "create", { title: "One" }, 33, 0)]));
    const second = repo.commit(Object.fromEntries([await ops.file(jun, "comment", { body: "builds on one" }, 33, 1)]));
    const a = agent();

    const late = await ingestPush(repo.reader(), second, a.ledger, a.apply);
    const early = await ingestPush(repo.reader(), first, a.ledger, a.apply);

    assert.deepEqual(late.outcomes, { applied: 2 });
    assert.equal(early.files, 0);
    assert.deepEqual(
      appliedOps(a.db).map((row) => [row["op_id"], row["git_commit"]]),
      [
        ["jun-0001", first],
        ["jun-0002", second],
      ],
    );
  });

  test("files added by one commit apply in base-version order, then path order", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const head = repo.commit(
      Object.fromEntries([
        await ops.file(penguin, "create", { title: "Penguin's issue" }, 31, 0),
        await ops.file(jun, "comment", { body: "on 31" }, 31, 1),
        await ops.file(jun, "create", { title: "Jun's issue" }, 33, 0),
      ]),
    );
    const a = agent();

    const report = await ingestPush(repo.reader(), head, a.ledger, a.apply);

    assert.deepEqual(report.outcomes, { applied: 3 });
    assert.deepEqual(a.order, [
      "issues/31/ops/penguin-0001.json",
      "issues/33/ops/jun-0002.json",
      "issues/31/ops/jun-0001.json",
    ]);
  });

  test("only new files under issues/<id>/ops/ count; other files and unchanged issues are not read", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const issue31 = await ops.file(penguin, "create", { title: "Thirty-one" }, 31, 0);
    repo.commit({ ...Object.fromEntries([issue31]), "README.md": "issues\n", "issues/31/notes.txt": "x" });
    const a = agent();
    await ingestPush(repo.reader(), repo.git("rev-parse", "HEAD"), a.ledger, a.apply);

    const head = repo.commit({
      "README.md": "changed\n",
      "issues/31/notes.txt": "changed",
      [issue31[0]]: issue31[1].replace("Thirty-one", "Edited in place"),
      ...Object.fromEntries([await ops.file(jun, "create", { title: "Thirty-three" }, 33, 0)]),
    });
    for (const key of Object.keys(repo.calls)) delete repo.calls[key];
    const report = await ingestPush(repo.reader(), head, a.ledger, a.apply);

    assert.equal(report.files, 1);
    assert.deepEqual(a.order.at(-1), "issues/33/ops/jun-0001.json");
    assert.equal(a.index.issue("31")?.title, "Thirty-one");
    assert.equal(repo.calls["readBlob"], 1);
    assert.deepEqual(report.bindingCalls, repo.calls);
  });

  test("a merge commit contributes the files it adds relative to its first parent", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    repo.commit(Object.fromEntries([await ops.file(penguin, "create", { title: "Base" }, 31, 0)]));
    repo.git("checkout", "--quiet", "-b", "side");
    const sideOp = await ops.file(jun, "create", { title: "From the side branch" }, 33, 0);
    repo.commit(Object.fromEntries([sideOp]));
    repo.git("checkout", "--quiet", "main");
    repo.commit({ "README.md": "main moved\n" });
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge side", "side");
    const merge = repo.git("rev-parse", "HEAD");
    const a = agent();

    await ingestPush(repo.reader(), merge, a.ledger, a.apply);

    const row = appliedOps(a.db).find((r) => r["op_id"] === "jun-0001");
    assert.equal(row?.["git_commit"], merge);
  });

  test("a failure part way through a commit leaves it unledgered, and the retry applies each file once", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const head = repo.commit(
      Object.fromEntries([
        await ops.file(jun, "create", { title: "One" }, 33, 0),
        await ops.file(jun, "comment", { body: "two" }, 33, 1),
      ]),
    );
    const a = agent();
    let calls = 0;
    const crashOnSecond = (file: AddedOperationFile, commit: string): Promise<ApplyOutcome> => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("storage unavailable"));
      return a.apply(file, commit);
    };

    await assert.rejects(ingestPush(repo.reader(), head, a.ledger, crashOnSecond), /storage unavailable/);
    assert.equal(a.ledger.has(head), false);
    const retry = await ingestPush(repo.reader(), head, a.ledger, a.apply);

    assert.deepEqual(retry.outcomes, { duplicate: 1, applied: 1 });
    assert.deepEqual(
      appliedOps(a.db).map((row) => row["op_id"]),
      ["jun-0001", "jun-0002"],
    );
    assert.equal(a.ledger.has(head), true);
  });

  test("an operation from a revoked bridge no longer verifies", async () => {
    const repo = new GitRepo();
    const ops = new Ops();
    const a = agent(async (bridges) => ({ ...keys, bridges: await bridges.bridgeKeys() }));
    const code = await a.bridges.issueCode("jun", "owner", 900);
    const registered = await a.bridges.register(code.code, await crypto.subtle.exportKey("jwk", junBridge.publicKey));
    assert.equal(registered.status, "registered");
    if (registered.status !== "registered") return;

    const first = repo.commit(Object.fromEntries([await ops.file(jun, "create", { title: "One" }, 33, 0)]));
    await ingestPush(repo.reader(), first, a.ledger, a.apply);
    assert.equal(a.bridges.revoke(registered.bridge.bridgeId), true);
    const second = repo.commit(Object.fromEntries([await ops.file(jun, "comment", { body: "after revoke" }, 33, 1)]));
    await ingestPush(repo.reader(), second, a.ledger, a.apply);

    const timeline = a.index.read("33").timeline;
    assert.deepEqual(
      timeline.map((entry) => [entry.statedOpId, entry.status, entry.rejectReason]),
      [
        ["jun-0001", "applied", null],
        ["jun-0002", "rejected", "bad_signature"],
      ],
    );
  });

  test("a head the repo cannot resolve throws so the event is retried", async () => {
    const repo = new GitRepo();
    repo.commit({ "README.md": "x\n" });
    const a = agent();

    await assert.rejects(ingestPush(repo.reader(), "f".repeat(40), a.ledger, a.apply), /not found/);
  });
});
