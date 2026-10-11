import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import {
  approvalPass,
  ApprovedBranchWriter,
  fetchApprovals,
  localRemote,
  penguinRepoOf,
  RemoteRefusedError,
  reportApproval,
  type Fetch,
  type RemoteResolver,
} from "@penguin/local-bridge";

const run = promisify(execFile);
const SERVER = "https://penguin.example";
const IDENTITY = { GIT_AUTHOR_NAME: "Runner", GIT_AUTHOR_EMAIL: "runner@example.com" };
const ENV = { ...process.env, ...IDENTITY, GIT_COMMITTER_NAME: "Runner", GIT_COMMITTER_EMAIL: "runner@example.com" };

let root: string;
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args], { env: ENV }).then(({ stdout }) => stdout.trim());

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-approval-run-")));
});

after(() => rm(root, { recursive: true, force: true }));

/** A Huddle repo whose `integration` branch holds two commits, and an empty runner repository. */
async function huddleRepo(name: string) {
  const dir = join(root, name);
  const bare = join(dir, "huddle-001.git");
  const work = join(dir, "work");
  const runner = join(dir, "runner");
  await run("git", ["init", "--quiet", "--bare", bare]);
  await run("git", ["init", "--quiet", work]);
  await run("git", ["init", "--quiet", runner]);
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "Integration result");
  const first = await git(work, "rev-parse", "HEAD");
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "Newer integration result");
  const second = await git(work, "rev-parse", "HEAD");
  await git(work, "push", "--quiet", bare, `${second}:refs/heads/integration`);
  const remotes: RemoteResolver = (remote) => {
    assert.equal(penguinRepoOf(remote), "huddle-001");
    return localRemote(bare);
  };
  return { bare, first, second, writer: new ApprovedBranchWriter({ repoPath: runner, writeRemotes: remotes }) };
}

test("the runner points the approved branch at the verified commit and moves it only forward", async () => {
  const { bare, first, second, writer } = await huddleRepo("forward");
  assert.deepEqual(await writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: first }), { sha: first });
  assert.equal(await git(bare, "rev-parse", "refs/heads/approved"), first);
  // A repeated write leaves the branch where it is.
  assert.deepEqual(await writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: first }), { sha: first });
  assert.deepEqual(await writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: second }), { sha: second });
  assert.equal(await git(bare, "rev-parse", "refs/heads/approved"), second);
  // Back to the older commit would rewrite the branch, and the runner never forces a push.
  await assert.rejects(writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: first }));
  assert.equal(await git(bare, "rev-parse", "refs/heads/approved"), second);
});

test("the runner refuses a listing outside a Huddle repo or naming a commit the repo lacks", async () => {
  const { bare, writer } = await huddleRepo("refusals");
  await assert.rejects(writer.write({ issueId: "1", huddleRepo: "owner-jun", sha: "a".repeat(40) }), /not a Huddle repo/u);
  await assert.rejects(writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: "main" }), /not a full object ID/u);
  await assert.rejects(writer.write({ issueId: "1", huddleRepo: "huddle-001", sha: "a".repeat(40) }), /is not in huddle-001/u);
  await assert.rejects(git(bare, "rev-parse", "--verify", "refs/heads/approved"));
});

test("a runner lists approved branches and reports one with its bridge token", async () => {
  const sha = "c".repeat(40);
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/approvals")) return Response.json({ approvals: [{ issueId: "1", huddleRepo: "huddle-001", sha }] });
    if (String(url).endsWith("/1")) return Response.json({ status: "recorded", issueId: "1", state: "closed", commit: `huddle-001@${sha}` });
    return Response.json({ error: "stale", message: "requested at another commit" }, { status: 409 });
  }) as Fetch;
  assert.deepEqual(await fetchApprovals(SERVER, "bridge-token", fetchStub), [{ issueId: "1", huddleRepo: "huddle-001", sha }]);
  assert.deepEqual(await reportApproval(SERVER, "bridge-token", "1", { sha }, fetchStub), {
    status: "recorded",
    issueId: "1",
    state: "closed",
    commit: `huddle-001@${sha}`,
  });
  await assert.rejects(reportApproval(SERVER, "bridge-token", "2", { sha }, fetchStub), RemoteRefusedError);
  assert.deepEqual(
    requests.map(({ url, init }) => [url, init?.method ?? "GET", new Headers(init?.headers).get("Authorization")]),
    [
      [`${SERVER}/approvals`, "GET", "Bearer bridge-token"],
      [`${SERVER}/approvals/1`, "POST", "Bearer bridge-token"],
      [`${SERVER}/approvals/2`, "POST", "Bearer bridge-token"],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { sha });
});

test("one approved branch that fails stays listed and never stops the next", async () => {
  const sha = "c".repeat(40);
  const result = await approvalPass({
    list: async () => [
      { issueId: "1", huddleRepo: "huddle-001", sha },
      { issueId: "2", huddleRepo: "huddle-002", sha },
    ],
    write: async (spec) => {
      if (spec.issueId === "1") throw new Error("huddle-001 is unreachable");
      return { sha: spec.sha };
    },
    report: async (issueId) => ({ status: "recorded", issueId, state: "closed", commit: `huddle-002@${sha}` }),
  });
  assert.equal(result.listed, 2);
  assert.deepEqual(result.failed, [{ issueId: "1", reason: "huddle-001 is unreachable" }]);
  assert.deepEqual(result.reported.map((entry) => entry.issueId), ["2"]);
});
