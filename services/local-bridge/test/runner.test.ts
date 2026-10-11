// Runner mode against a real issue index: Penguin's pending list comes from the ProjectAgent's
// IssueIndex (node:sqlite), the issues repo is a bare repo behind the fake Artifacts Git server,
// and the push is ingested back into the index the way the Queue consumer does.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, before, beforeEach, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runGit } from "@penguin/git-analysis";
import { generateSigningKeyPair } from "@penguin/issues";
import {
  fetchPendingOperations,
  MemoryKeyStore,
  pendingProblem,
  RemoteRefusedError,
  runCli,
  type PendingOperation,
} from "@penguin/local-bridge";
import type { Author } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

// The index modules directly: the package entry point loads the Agents SDK, which needs workerd.
import { IssueIndex, type OperationKeys, type SqlDatabase } from "../../project-agent/src/issue-index.ts";
import { IngestLedger, ingestPush, type IssuesRepoReader } from "../../project-agent/src/push-ingest.ts";
import { importServiceKey, type ServiceKey } from "../../project-agent/src/service-key.ts";
import { FakePenguin } from "./fake-penguin.ts";

const OWNER = "sam";
const jun: Author = { person: "jun" };
const penguinAuthor: Author = { penguin: true };

const scopeMap = parseScopeMap(
  JSON.parse(
    await readFile(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

let service: ServiceKey;
let keys: OperationKeys;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  keys = { bridges: [], serviceKey: service.publicKey, scopeMap, identities: { byHandle: () => undefined } };
});

let root: string;
let stateDir: string;
let store: MemoryKeyStore;
let penguin: FakePenguin;
let output: string[];
let db: DatabaseSync;
let index: IssueIndex;
let ledger: IngestLedger;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-runner-")));
  stateDir = join(root, "state");
  store = new MemoryKeyStore();
  output = [];
  penguin = new FakePenguin(join(root, "artifacts"), OWNER);
  penguin.role = "runner";
  await mkdir(join(root, "artifacts"));
  await penguin.start(["issues"]);
  const sql = sqlite();
  index = new IssueIndex(sql);
  ledger = new IngestLedger(sql);
  penguin.pendingOperations = (caller) => index.pendingFiles(caller as { bridgeId: string; role: "owner" | "runner" });
});

afterEach(async () => {
  await penguin.stop();
  await rm(root, { recursive: true, force: true });
});

function sqlite(): SqlDatabase {
  db = new DatabaseSync(":memory:");
  return {
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
}

function cli(args: string[]) {
  return runCli(args, { write: (text) => output.push(text), ask: async () => "" }, { keyStore: store, stateDir });
}

const register = () => cli(["register", "--server", penguin.origin, "--owner", OWNER, "--code", penguin.code]);
const runOnce = () => cli(["runner", "--once"]);

/** Submits `count` operations the way MCP, the dashboard and Penguin do: one new issue each. */
async function submitCreates(count: number, firstIssue = 40): Promise<void> {
  for (let n = 0; n < count; n++) {
    // Every fifth operation is Penguin's own; the rest come from the dashboard.
    const own = n % 5 === 4;
    const outcome = await index.submit({
      operation: { issue: firstIssue + n, type: "create", base_version: 0, payload: { title: `Issue ${firstIssue + n}` } },
      author: own ? penguinAuthor : jun,
      source: own ? "penguin" : "dashboard",
      signingKey: service.privateKey,
      keys,
    });
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  }
}

function pendingCount(): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM PendingOp`).get()?.["n"]);
}

const bare = () => penguin.repoPath("issues");

async function commits(): Promise<string[]> {
  const out = await runGit(bare(), ["rev-list", "--all"]).catch(() => "");
  return out.split("\n").filter((line) => line !== "");
}

async function filesIn(commit: string): Promise<string[]> {
  const out = await runGit(bare(), ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", commit]);
  return out.split("\n").filter((line) => line !== "").sort();
}

/** Pushes the runner made: accepted receive-pack uploads. */
function pushes(): number {
  return penguin.gitRequests.filter((r) => r.accepted && r.method === "POST" && r.service === "git-receive-pack").length;
}

/** The bare issues repo read through the binding's methods, as the ProjectAgent reads Artifacts. */
function reader(): IssuesRepoReader {
  const git = (...args: string[]) => execFileSync("git", ["-C", bare(), ...args]);
  return {
    log: async ({ ref, limit, offset }) => {
      const out = git("log", "--first-parent", "--format=%H %T", `--skip=${offset}`, `-n${limit}`, ref, "--")
        .toString()
        .trim();
      return out === "" ? [] : out.split("\n").map((line) => ({ hash: line.split(" ")[0]!, treeHash: line.split(" ")[1]! }));
    },
    readTree: async (hash) => {
      const out = git("ls-tree", hash).toString().trim();
      return out === ""
        ? []
        : out.split("\n").map((line) => {
            const [meta, name] = line.split("\t") as [string, string];
            const [mode, , objectHash] = meta.split(" ") as [string, string, string];
            return { name, hash: objectHash, type: mode === "040000" ? "tree" : "blob" };
          });
    },
    readBlob: async (hash) => new Blob([git("cat-file", "blob", hash)]),
  };
}

/** Delivers the push event: the ProjectAgent ingests the issues repo up to its head. */
async function deliverPushEvent(): Promise<void> {
  const head = (await runGit(bare(), ["rev-parse", "refs/heads/main"])).trim();
  await ingestPush(reader(), head, ledger, (file, commit) =>
    index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
  );
}

describe("runner mode", () => {
  test("five pending operations go out in one commit and one push, and the push event clears them", async () => {
    assert.equal(await register(), 0);
    await submitCreates(5);
    assert.equal(pendingCount(), 5);

    assert.equal(await runOnce(), 0, output.join(""));
    const [commit, ...older] = await commits();
    assert.ok(commit);
    assert.deepEqual(older, []);
    assert.equal(pushes(), 1);
    assert.deepEqual(await filesIn(commit), [
      "issues/40/ops/jun-0001.json",
      "issues/41/ops/jun-0002.json",
      "issues/42/ops/jun-0003.json",
      "issues/43/ops/jun-0004.json",
      "issues/44/ops/penguin-0001.json",
    ]);
    assert.match(output.join(""), /5 pending: 5 pushed in commit [0-9a-f]{12}, 0 already in the repo, 0 refused/);

    await deliverPushEvent();
    assert.equal(pendingCount(), 0);
    for (const issue of ["40", "44"]) {
      const [entry] = index.read(issue).timeline;
      assert.equal(entry?.waitingForGitLog, false);
      assert.equal(entry?.gitCommit, commit);
    }
  });

  test("with the runner stopped operations wait for the Git log; on restart they are pushed once", async () => {
    assert.equal(await register(), 0);
    await submitCreates(3);
    // No runner pass yet: the index has them applied and waiting.
    assert.equal(index.issue("41")?.title, "Issue 41");
    assert.equal(index.read("41").timeline[0]?.waitingForGitLog, true);
    assert.deepEqual(await commits(), []);

    assert.equal(await runOnce(), 0);
    const pushed = await commits();
    assert.equal(pushed.length, 1);
    assert.equal(pushes(), 1);

    // A second pass before the push event lands sees the same rows and skips every file.
    assert.equal(await runOnce(), 0);
    assert.deepEqual(await commits(), pushed);
    assert.equal(pushes(), 1);
    assert.match(output.join(""), /3 pending: 0 pushed in no commit, 3 already in the repo, 0 refused/);

    await deliverPushEvent();
    assert.equal(pendingCount(), 0);
    // With nothing pending, a pass talks to no Git remote at all.
    const requests = penguin.gitRequests.length;
    assert.equal(await runOnce(), 0);
    assert.equal(penguin.gitRequests.length, requests);
  });

  test("a file already in the repo with identical content is skipped; the rest share one commit", async () => {
    assert.equal(await register(), 0);
    await submitCreates(3);
    const listing = index.pendingFiles({ bridgeId: "bridge-1", role: "runner" });
    assert.equal(listing.status, "ok");
    const first = listing.status === "ok" ? listing.files[0]! : undefined;

    // Another writer already pushed the first file with the same bytes.
    const work = join(root, "work");
    await runGit(root, ["clone", "--quiet", bare(), work]);
    await mkdir(join(work, dirname(first!.path)), { recursive: true });
    await writeFile(join(work, first!.path), first!.file);
    await runGit(work, ["add", "--all"]);
    await runGit(work, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "other writer"]);
    await runGit(work, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    assert.equal(await runOnce(), 0, output.join(""));
    const [commit, ...older] = await commits();
    assert.equal(older.length, 1);
    assert.deepEqual(await filesIn(commit!), ["issues/41/ops/jun-0002.json", "issues/42/ops/jun-0003.json"]);
    assert.match(output.join(""), /3 pending: 2 pushed in commit \S+, 1 already in the repo, 0 refused/);

    await deliverPushEvent();
    assert.equal(pendingCount(), 0);
  });

  test("the runner refuses any listed path that is not the operation's own path and writes the rest", async () => {
    assert.equal(await register(), 0);
    await submitCreates(1);
    const listing = index.pendingFiles({ bridgeId: "bridge-1", role: "runner" });
    const good = listing.status === "ok" ? listing.files[0]! : undefined;
    const text = good!.file;
    const crafted: PendingOperation[] = [
      { opId: "jun-0001", path: "../../outside.json", file: text },
      { opId: "jun-0001", path: ".git/hooks/post-commit", file: text },
      { opId: "jun-0001", path: "issues/99/ops/jun-0001.json", file: text },
      { opId: "jun-0001", path: "issues/40/ops/jun-0001.json/../../../evil.json", file: text },
      { opId: "jun-0009", path: "issues/40/ops/jun-0009.json", file: text },
      { opId: "jun-0002", path: "issues/40/ops/jun-0002.json", file: "#!/bin/sh\nexit 1\n" },
    ];
    for (const entry of crafted) assert.notEqual(pendingProblem(entry), null, entry.path);
    assert.equal(pendingProblem(good!), null);

    penguin.pendingOperations = () => ({ status: "ok", files: [...crafted, good] });
    assert.equal(await runOnce(), 1);
    const [commit] = await commits();
    assert.deepEqual(await filesIn(commit!), ["issues/40/ops/jun-0001.json"]);
    assert.equal((output.join("").match(/^Refused /gm) ?? []).length, crafted.length);
    // Nothing escaped the clone.
    await assert.rejects(readFile(join(stateDir, "outside.json")));
    await assert.rejects(readFile(join(root, "evil.json")));
  });

  test("Penguin lists pending operations only to a runner bridge", async () => {
    penguin.role = "owner";
    assert.equal(await register(), 0);
    await submitCreates(1);
    assert.equal(await runOnce(), 1);
    assert.match(output.join(""), /registered as owner; runner mode needs a runner registration/);
    // The server refuses on its own too, from the role it registered.
    await assert.rejects(fetchPendingOperations(penguin.origin, penguin.bridgeToken), RemoteRefusedError);
    assert.deepEqual(await commits(), []);
    assert.equal(pendingCount(), 1);
  });

  test("one pass takes this long for five and for one hundred operations", async (t) => {
    assert.equal(await register(), 0);
    for (const count of [5, 100]) {
      const first = count === 5 ? 40 : 100;
      await submitCreates(count, first);
      output = [];
      assert.equal(await runOnce(), 0, output.join(""));
      const ms = Number(/\((\d+) ms\)/.exec(output.join(""))?.[1]);
      t.diagnostic(`runner pass, ${count} operations: ${ms} ms`);
      const [commit] = await commits();
      assert.equal((await filesIn(commit!)).length, count);
      await deliverPushEvent();
      assert.equal(pendingCount(), 0);
    }
  });
});
