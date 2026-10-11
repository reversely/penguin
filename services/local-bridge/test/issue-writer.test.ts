import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { runGit } from "@penguin/git-analysis";
import { verifyOperation } from "@penguin/issues";
import {
  IssueWriter,
  loadSigningKey,
  MemoryKeyStore,
  runCli,
  signingKeyAccount,
  type BridgeSigningKey,
} from "@penguin/local-bridge";
import { operationPath, parseOperationFile, type Operation } from "@penguin/protocol";

const OWNER = "jun";

let root: string;
let bare: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-issues-")));
  bare = join(root, "issues.git");
  await runGit(root, ["init", "--quiet", "--bare", "-b", "main", bare]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const commitCount = async () =>
  Number((await runGit(bare, ["rev-list", "--count", "main"]).catch(() => "0")).trim());

/** Reads an operation file from the bare repo's main branch and checks it against the schema. */
async function readOp(path: string): Promise<Operation> {
  const text = await runGit(bare, ["cat-file", "blob", `main:${path}`]);
  const result = parseOperationFile(new TextEncoder().encode(text));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  return result.operation;
}

/** Runs the CLI as one owner's bridge with its own clone and in-memory key store. */
function bridge(owner: string, store = new MemoryKeyStore()) {
  const clone = join(root, `clone-${owner}`);
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const code = await runCli(
      ["issue", ...args.slice(0, 1), "--owner", owner, "--repo", bare, "--clone", clone, ...args.slice(1)],
      { write: (text) => out.push(text), ask: async () => "" },
      { keyStore: store },
    );
    return { code, out: out.join("") };
  };
  return { store, clone, run };
}

function pushedPath(out: string): string {
  return /^Pushed (\S+) in commit/m.exec(out)?.[1] ?? assert.fail(`no pushed path in ${out}`);
}

describe("the bridge signing key", () => {
  test("is generated once, stored in the key store and reused", async () => {
    const store = new MemoryKeyStore();
    const first = await loadSigningKey(store, OWNER);
    const second = await loadSigningKey(store, OWNER);
    assert.deepEqual(second.publicJwk, first.publicJwk);
    assert.deepEqual(Object.keys(first.publicJwk).sort(), ["crv", "kty", "x"]);
    const stored = JSON.parse((await store.get(signingKeyAccount(OWNER))) ?? "null");
    assert.equal(stored.kty, "OKP");
    assert.equal(typeof stored.d, "string");
  });

  test("a corrupt entry is refused without echoing the stored value", async () => {
    const store = new MemoryKeyStore();
    await store.set(signingKeyAccount(OWNER), "not-a-key-SECRETVALUE");
    await assert.rejects(loadSigningKey(store, OWNER), (error: Error) => !error.message.includes("SECRETVALUE"));
  });

  test("the key command prints only the public half", async () => {
    const store = new MemoryKeyStore();
    const out: string[] = [];
    const code = await runCli(["key", "--owner", OWNER], { write: (t) => out.push(t), ask: async () => "" }, {
      keyStore: store,
    });
    assert.equal(code, 0);
    const printed = JSON.parse(out.join(""));
    assert.equal(printed.d, undefined);
    assert.equal(printed.x, (await loadSigningKey(store, OWNER)).publicJwk.x);
  });
});

describe("the issue commands", () => {
  test("each of the six commands pushes one commit holding one valid, verifiable operation file", async () => {
    const { store, run } = bridge(OWNER);
    const publicKey = (await loadSigningKey(store, OWNER)).publicKey;
    const timings: number[] = [];

    const steps: [string, string[], Operation["type"]][] = [
      ["create", ["--title", "Retention drops after merge", "--body", "Seen on the tablet fixture."], "create"],
      ["comment", ["--body", "Reproduced on main."], "comment"],
      ["label", ["--label", "scope:analytics"], "add_label"],
      ["assign", ["--to", "@jun/reports"], "assign"],
      ["review", ["--verdict", "request_changes", "--commit", "owner-priya@9b2f10", "--reason", "Still joins."], "review"],
      ["state", ["--state", "fixing", "--reason", "Fix sub-issue opened."], "change_state"],
    ];
    let issue = "";
    for (const [index, [command, flags, type]] of steps.entries()) {
      const before = await commitCount();
      const { code, out } = await run(command, ...(command === "create" ? [] : ["--issue", issue]), ...flags);
      assert.equal(code, 0, out);
      timings.push(Number(/\((\d+) ms\)/.exec(out)?.[1]));
      const path = pushedPath(out);
      const operation = await readOp(path);
      if (command === "create") issue = String(operation.issue);

      assert.equal(operation.type, type);
      assert.equal(operation.op_id, `jun-${String(index + 1).padStart(4, "0")}`);
      assert.equal(path, operationPath(operation));
      assert.equal(path, `issues/${issue}/ops/${operation.op_id}.json`);
      assert.equal(operation.base_version, index, "base_version counts the issue's earlier operations");
      assert.equal(await verifyOperation(operation, publicKey), true);
      assert.equal(await commitCount(), before + 1);
      const changed = await runGit(bare, ["show", "--name-only", "--format=", "main"]);
      assert.deepEqual(changed.trim().split("\n"), [path]);
    }
    assert.equal(issue, "jun-0001", "a new issue's folder is its create operation's op_id");
    // Recorded for the ticket's time check: command start to completed push, local bare repo.
    process.stdout.write(`# issue command timings (ms): ${timings.join(", ")}\n`);
  });

  test("two bridges writing to the same issue at once both land", async () => {
    const jun = bridge("jun");
    const priya = bridge("priya");
    const created = await jun.run("create", "--title", "Shared device split");
    const issue = /issues\/([^/]+)\//.exec(pushedPath(created.out))?.[1] ?? assert.fail(created.out);

    // Each bridge writes its comments in turn; the two bridges run at the same time.
    const comments = async (writer: ReturnType<typeof bridge>, name: string) => {
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await writer.run("comment", "--issue", issue, "--body", `${name} ${i}`));
      return results;
    };
    const results = (await Promise.all([comments(jun, "jun"), comments(priya, "priya")])).flat();
    for (const result of results) assert.equal(result.code, 0, result.out);

    const files = (await runGit(bare, ["ls-tree", "-r", "--name-only", "main", `issues/${issue}/ops/`]))
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(files, [
      ...["0001", "0002", "0003", "0004"].map((seq) => `issues/${issue}/ops/jun-${seq}.json`),
      ...["0001", "0002", "0003"].map((seq) => `issues/${issue}/ops/priya-${seq}.json`),
    ]);
    assert.equal(await commitCount(), 7);
  });

  test("text with shell syntax is stored verbatim and the private key appears nowhere", async () => {
    const { store, run } = bridge(OWNER);
    const hostile = `$(touch ${join(root, "pwned")}) \`id\`; echo "x" | sh && rm -rf / \n'quoted'`;
    const created = await run("create", "--title", "Title $(whoami)", "--body", hostile);
    assert.equal(created.code, 0, created.out);
    const path = pushedPath(created.out);
    const operation = await readOp(path);
    assert.deepEqual(operation.payload, { title: "Title $(whoami)", body: hostile });
    assert.equal(existsSync(join(root, "pwned")), false);

    const secret: string = JSON.parse((await store.get(signingKeyAccount(OWNER))) ?? "{}").d;
    assert.ok(secret.length > 20);
    const history = await runGit(bare, ["log", "-p", "--all", "--format=%H%n%an%n%ae%n%B"]);
    assert.ok(!history.includes(secret), "the private key is in the issues repo history");
    assert.ok(!created.out.includes(secret), "the private key is in the command output");
    assert.ok(!(await runGit(bare, ["cat-file", "blob", `main:${path}`])).includes(secret));
    const messages = await runGit(bare, ["log", "--all", "--format=%B"]);
    assert.ok(!messages.includes("Title"), "titles stay out of commit messages");
  });

  test("the sequence continues from the repo when the bridge's clone and counter are lost", async () => {
    const first = bridge(OWNER);
    const created = await first.run("create", "--title", "First");
    await first.run("create", "--title", "Second");
    await rm(first.clone, { recursive: true, force: true });
    const again = await bridge(OWNER, first.store).run("create", "--title", "Third");
    assert.equal(again.code, 0, again.out);
    assert.equal(pushedPath(again.out), "issues/jun-0003/ops/jun-0003.json");
    assert.equal(pushedPath(created.out), "issues/jun-0001/ops/jun-0001.json");
  });

  test("an identity of the owner can be the author; another owner cannot", async () => {
    const { run } = bridge(OWNER);
    const asIdentity = await run("create", "--title", "From an identity", "--as", "@jun/reports");
    assert.equal(asIdentity.code, 0, asIdentity.out);
    assert.equal(pushedPath(asIdentity.out), "issues/jun.reports-0001/ops/jun.reports-0001.json");
    await assert.rejects(run("create", "--title", "Forged", "--as", "priya"), /cannot write as priya/);
  });

  test("--base-version overrides the counted version, and an unknown issue is refused", async () => {
    const { run } = bridge(OWNER);
    const issue = /issues\/([^/]+)\//.exec(pushedPath((await run("create", "--title", "T")).out))?.[1] ?? "";
    const comment = await run("comment", "--issue", issue, "--body", "b", "--base-version", "7");
    assert.equal((await readOp(pushedPath(comment.out))).base_version, 7);
    await assert.rejects(run("comment", "--issue", "99", "--body", "b"), /issue 99 has no operations/);
  });

  test("bad arguments print usage and push nothing", async () => {
    const { run } = bridge(OWNER);
    assert.equal((await run("review", "--issue", "3", "--verdict", "maybe", "--commit", "a@abcdef")).code, 2);
    assert.equal((await run("comment", "--issue", "3")).code, 2);
    assert.equal((await run("delete", "--issue", "3")).code, 2);
    assert.equal(await commitCount(), 0);
  });

  test("an invalid payload is refused before anything is committed", async () => {
    const key: BridgeSigningKey = await loadSigningKey(new MemoryKeyStore(), OWNER);
    const writer = new IssueWriter({ remote: bare, clonePath: join(root, "clone"), ownerId: OWNER, key });
    await assert.rejects(writer.write({ type: "create", payload: { title: "" } }), /invalid/);
    assert.equal(await commitCount(), 0);
  });
});
