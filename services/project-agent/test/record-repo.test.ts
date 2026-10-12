// The record repo's writes (record-repo.ts) against real Git: Penguin's own commits, built in memory,
// pushed to a bare repository through `git receive-pack` in stateless RPC mode (git-server.ts), then
// read back and checked with `git fsck`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";

import { EMPTY_AREA, FeatureStore, signFeatureRecord } from "../src/feature-store.ts";
import { flushRecords, openRecordRepo, RecordRepoStore, type RecordFlushDeps } from "../src/record-repo.ts";
import { gitServer } from "./git-server.ts";
import { sqlite } from "./issues-repo.ts";

const WRITE = "art_v1_record-write-token";
const READ = "art_v1_record-read-token";
const REMOTE = "https://artifacts.test/git/record.git";
const { privateKey } = await generateSigningKeyPair();

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root = "";
let repo = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "penguin-record-repo-"));
  repo = join(root, "record.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A project's feature records and record repo state in one database, with a clock that moves a second a record. */
function project() {
  const { sql } = sqlite();
  let clock = Date.parse("2026-10-12T09:00:00Z");
  const features = new FeatureStore(sql, () => (clock += 1000));
  const store = new RecordRepoStore(sql);
  const add = async (featureId: string, person: string): Promise<string> => {
    const record = await signFeatureRecord(features.draftRecord(featureId, "declare_area", { person }, { n: features.records(featureId).length }), privateKey);
    if (features.get(featureId) === undefined) features.insert(featureId, person, EMPTY_AREA, record);
    else features.addRecord(record);
    return record.record_id;
  };
  return { sql, features, store, add };
}

/** What a flush needs, with the write token by default; `served` counts every request. */
function deps(store: RecordRepoStore, options: { token?: string; fetch?: typeof fetch; batchLimit?: number } = {}): RecordFlushDeps & { readonly served: ReturnType<typeof gitServer>; closed: number } {
  const served = gitServer({ record: repo }, { [WRITE]: "write", [READ]: "read" });
  const result = {
    store,
    served,
    closed: 0,
    open: async () => ({ endpoint: { remote: REMOTE, token: options.token ?? WRITE }, close: async () => void (result.closed += 1) }),
    fetch: options.fetch ?? served.fetch,
    ...(options.batchLimit === undefined ? {} : { batchLimit: options.batchLimit }),
  };
  return result;
}

const pushes = (served: ReturnType<typeof gitServer>) => served.requests.filter((request) => request.method === "POST" && request.url.endsWith("git-receive-pack")).length;
const files = (ref = "main") => git(repo, "ls-tree", "-r", "--name-only", ref).split("\n").filter((line) => line !== "");
const commits = () => git(repo, "rev-list", "--reverse", "main").split("\n");
/** The files a commit added, in path order. */
const added = (commit: string) => git(repo, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit).split("\n");

test("each record is committed at records/<feature>/<author>-<writer>-<seq>.json with its signed JSON, in one push", async () => {
  const { features, store, add } = project();
  const ids = [await add("tax-rounding", "ines"), await add("retention", "jun"), await add("tax-rounding", "ines")];
  const flush = deps(store);
  const outcome = await flushRecords(flush);
  assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
  assert.equal(pushes(flush.served), 1, "one push for the batch");
  assert.equal(flush.closed, 1, "the token is given back after the push");
  assert.ok(flush.served.requests.every((request) => request.auth === `Bearer ${WRITE}`));

  assert.deepEqual(files(), ["records/retention/jun-web-0001.json", "records/tax-rounding/ines-web-0001.json", "records/tax-rounding/ines-web-0002.json"]);
  for (const stored of [...features.records("tax-rounding"), ...features.records("retention")]) {
    assert.equal(git(repo, "show", `main:${stored.path}`), stored.file);
    assert.equal(store.commitOf(stored.recordId), outcome.status === "pushed" ? outcome.commit : "");
  }
  assert.deepEqual(ids, ["ines-web-0001", "jun-web-0001", "ines-web-0002"]);
  // Git finds every object well formed and connected.
  git(repo, "fsck", "--strict", "--no-dangling");
  assert.equal(git(repo, "log", "-1", "--format=%an <%ae>%n%s", "main"), "Penguin <penguin@penguin.invalid>\nAdd 3 signed records");
  assert.deepEqual(await flushRecords(deps(store)), { status: "idle" });
});

test("records reach the repo in the order they were stored, across batches, each commit on the last", async () => {
  const { store, add } = project();
  const ids: string[] = [];
  for (const [feature, person] of [["a", "ines"], ["b", "jun"], ["a", "ines"], ["c", "sam"], ["b", "jun"]] as const) ids.push(await add(feature, person));
  const flush = deps(store, { batchLimit: 2 });
  const seen: string[] = [];
  for (let n = 0; n < 3; n++) {
    const outcome = await flushRecords(flush);
    assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
    if (n === 0) ids.push(await add("c", "sam")); // stored after the first batch was fixed: it waits its turn
  }
  assert.equal(pushes(flush.served), 3);
  const history = commits();
  assert.equal(history.length, 3);
  for (const commit of history) {
    seen.push(...added(commit).map((path) => path.split("/")[2]?.replace(/\.json$/u, "") as string));
  }
  const pathOrder = (batch: string[]) => [...batch].sort((x, y) => (x < y ? -1 : 1));
  // Each commit adds the next records in stored order; within a commit Git lists them by path.
  assert.deepEqual(seen, [...pathOrder(ids.slice(0, 2)), ...pathOrder(ids.slice(2, 4)), ...pathOrder(ids.slice(4, 6))]);
  assert.equal(git(repo, "rev-parse", `${history[2]}^`), history[1]);
  assert.equal(git(repo, "rev-parse", `${history[1]}^`), history[0]);
  // The last batch added nothing to feature a, whose folder keeps the tree the batch before made.
  assert.equal(git(repo, "rev-parse", `${history[2]}:records/a`), git(repo, "rev-parse", `${history[1]}:records/a`));
  assert.equal(files().filter((path) => path.startsWith("records/c/")).length, 2);
  git(repo, "fsck", "--strict", "--no-dangling");
});

test("a refused push leaves the repo as it was, and the retry pushes the same batch once", async () => {
  const { store, add } = project();
  await add("a", "ines");
  await add("b", "jun");
  // The receive-pack call fails before Git sees it.
  const refused = deps(store, {
    fetch: async (input, init) => (String(input).endsWith("git-receive-pack") && init?.method === "POST" ? new Response("boom", { status: 500 }) : deps(store).fetch!(input, init)),
  });
  const failed = await flushRecords(refused);
  assert.equal(failed.status, "failed");
  assert.equal(refused.closed, 1);
  assert.match(failed.status === "failed" ? failed.reason : "", /HTTP 500/u);
  assert.equal(git(repo, "for-each-ref").length, 0, "main was not made");
  const fixed = store.state().batch;
  assert.equal(fixed?.recordIds.length, 2);

  // A record stored meanwhile does not join the fixed batch.
  await add("a", "ines");
  const retry = await flushRecords(deps(store));
  assert.equal(retry.status, "pushed");
  assert.equal(retry.status === "pushed" ? retry.commit : "", fixed?.commit, "the retry pushes the commit fixed before the failure");
  assert.equal(files().length, 2);
  const last = await flushRecords(deps(store));
  assert.equal(last.status, "pushed");
  assert.deepEqual(files(), ["records/a/ines-web-0001.json", "records/a/ines-web-0002.json", "records/b/jun-web-0001.json"]);
  assert.equal(commits().length, 2, "no record was committed twice");
});

test("a push whose answer was lost is kept on the next try, not pushed again", async () => {
  const { store, add } = project();
  await add("a", "ines");
  const real = deps(store);
  // Git applies the push, then the connection drops before the answer arrives.
  const lost = deps(store, {
    fetch: async (input, init) => {
      const answer = await real.fetch!(input, init);
      if (String(input).endsWith("git-receive-pack") && init?.method === "POST") throw new Error("the connection closed");
      return answer;
    },
  });
  const failed = await flushRecords(lost);
  assert.equal(failed.status, "failed");
  assert.equal(commits().length, 1, "the push landed");
  const retry = deps(store);
  const kept = await flushRecords(retry);
  assert.deepEqual(kept.status === "pushed" ? kept.recovered : undefined, true);
  assert.equal(pushes(retry.served), 0, "nothing is pushed again");
  assert.equal(commits().length, 1);
  assert.equal(store.state().head, commits()[0]);
  assert.deepEqual(await flushRecords(deps(store)), { status: "idle" });
});

test("a read token cannot write, and a main Penguin did not write is left alone", async () => {
  const { store, add } = project();
  await add("a", "ines");
  const read = await flushRecords(deps(store, { token: READ }));
  assert.equal(read.status, "failed");
  assert.equal(git(repo, "for-each-ref").length, 0);

  // Someone else's commit on main: Penguin refuses to build on a history it did not write.
  const work = join(root, "work");
  git(root, "init", "--quiet", "--initial-branch=main", work);
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "Not Penguin");
  git(work, "push", "--quiet", repo, "main");
  const before = git(repo, "rev-parse", "main");
  const moved = await flushRecords(deps(store));
  assert.equal(moved.status, "failed");
  assert.match(moved.status === "failed" ? moved.reason : "", /not Penguin's last commit/u);
  assert.equal(git(repo, "rev-parse", "main"), before);
});

test("a repo that cannot be opened fails the flush with no token in the reason; the batch stays fixed", async () => {
  const { store, add } = project();
  await add("a", "ines");
  const outcome = await flushRecords({ store, open: async () => Promise.reject(new Error("ArtifactsError: internal error")) });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /could not be opened/u);
  assert.equal(store.state().batch?.recordIds.length, 1);
  assert.equal((await flushRecords(deps(store))).status, "pushed");
  assert.ok(!JSON.stringify(outcome).includes("art_v1"));
});

test("a project set up before the record repo existed gets it on its first push, made once", async () => {
  const { store, add } = project();
  await add("a", "ines");
  rmSync(repo, { recursive: true, force: true });
  const calls: string[] = [];
  const artifacts = {
    get: async (name: string) => {
      calls.push(`get ${name}`);
      if (!existsSync(repo)) throw Object.assign(new Error(`repository not found: ${name}`), { code: "NOT_FOUND" });
      return { name };
    },
    create: async (name: string, opts?: { setDefaultBranch?: string }) => {
      calls.push(`create ${name} ${opts?.setDefaultBranch}`);
      git(root, "init", "--quiet", "--bare", `--initial-branch=${opts?.setDefaultBranch}`, repo);
    },
  };
  const flush = deps(store);
  const outcome = await flushRecords({
    ...flush,
    open: async () => {
      await openRecordRepo(artifacts, "record");
      return flush.open();
    },
  });
  assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
  assert.deepEqual(calls, ["get record", "create record main", "get record"]);
  assert.deepEqual(files(), ["records/a/ines-web-0001.json"]);

  // Once it exists the repo is only opened.
  calls.length = 0;
  await openRecordRepo(artifacts, "record");
  assert.deepEqual(calls, ["get record"]);
  // A create that raced another reads as made, with the codes lost over RPC as `wrangler dev` passes them.
  let missing = true;
  const raced = {
    get: async () => {
      if (!missing) return "opened";
      missing = false;
      throw new Error("ArtifactsError: repository not found: record");
    },
    create: async () => Promise.reject(new Error("ArtifactsError: repo already exists: record")),
  };
  assert.equal(await openRecordRepo(raced, "record"), "opened");
  // Any other error means no missing repo: nothing is made.
  const broken = { get: async () => Promise.reject(Object.assign(new Error("boom"), { code: "INTERNAL_ERROR" })), create: async () => assert.fail("created") };
  await assert.rejects(openRecordRepo(broken, "record"), /boom/u);
});
