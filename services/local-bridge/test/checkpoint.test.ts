import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  CheckpointPublisher,
  type CheckpointPreview,
  type ConsentScope,
  formatPreview,
  type OwnerFork,
  runCli,
  WorktreeRegistry,
} from "@penguin/local-bridge";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

const OWNER = "priya";
const LONG_PATH = `${"deeply-nested-directory/".repeat(4)}a-file-name-long-enough-to-pass-eighty-columns.txt`;

let repo: FixtureRepo;
let forkPath: string;

beforeEach(async () => {
  repo = await createFixtureRepo();
  // The bridge's own Git calls read repository config, so pin identity, signing and hooks there.
  for (const [key, value] of [
    ["user.name", "Penguin Fixture"],
    ["user.email", "fixture@penguin.invalid"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ]) {
    await repo.git(repo.main, "config", key!, value!);
  }
  // Phase 1 fork: a local bare repository forked from the base repo's main branch.
  forkPath = join(repo.root, `owner-${OWNER}.git`);
  await repo.git(repo.root, "init", "--quiet", "--bare", forkPath);
  await repo.git(repo.main, "push", "--quiet", forkPath, "main");
});

afterEach(() => repo.cleanup());

interface Harness {
  publisher: CheckpointPublisher;
  registry: WorktreeRegistry;
  fork: OwnerFork;
  output: string[];
  asked: string[];
  idOf(branch: string): string;
}

async function harness(answers: boolean[], consent: ConsentScope = "worktree", owner = OWNER): Promise<Harness> {
  const registry = new WorktreeRegistry({ repoPath: repo.main, bridgeId: "bridge-1", ownerId: owner });
  const records = await registry.refresh();
  const output: string[] = [];
  const asked: string[] = [];
  const fork: OwnerFork = {
    owner_id: OWNER,
    project_id: "identity-unification",
    repo: forkPath,
    latest_checkpoint_sha: null,
    publishing_consent: consent,
  };
  const publisher = new CheckpointPublisher({
    registry,
    fork,
    write: (text) => output.push(text),
    confirm: async (_preview: CheckpointPreview) => {
      // Record what the owner had seen when asked.
      asked.push(output.join(""));
      const answer = answers.shift();
      assert.notEqual(answer, undefined, "asked for consent more often than expected");
      return answer!;
    },
  });
  const idOf = (branch: string) => {
    const record = records.find((r) => r.branch === branch);
    assert.ok(record, `no worktree on ${branch}`);
    return record.id;
  };
  return { publisher, registry, fork, output, asked, idOf };
}

const forkRefs = () => repo.git(forkPath, "for-each-ref", "--format=%(refname) %(objectname)");

/** Committed, uncommitted, deleted, staged-new and untracked changes in worktree A. */
async function editWorktreeA() {
  await repo.write(repo.worktreeA, "a.txt", "a.txt\ncommitted line\n");
  await repo.commitAll(repo.worktreeA, "routine local commit");
  await repo.write(repo.worktreeA, "b.txt", "uncommitted\nlines\n");
  await unlink(join(repo.worktreeA, "c.txt"));
  await mkdir(join(repo.worktreeA, "deeply-nested-directory/".repeat(4)), { recursive: true });
  await repo.write(repo.worktreeA, LONG_PATH, "staged new file\n");
  await repo.git(repo.worktreeA, "add", "--", LONG_PATH);
  await repo.write(repo.worktreeA, "untracked.txt", "never published\n");
}

test("prints every tracked changed file with its diff stat before asking, and a refusal leaves the fork unchanged", async () => {
  await editWorktreeA();
  const h = await harness([false]);
  const before = await forkRefs();

  const result = await h.publisher.publish(h.idOf("feature-a"));

  assert.equal(result.status, "refused");
  assert.equal(h.asked.length, 1);
  const preview = h.asked[0]!;
  assert.match(preview, /^ {2}M {10}\+1 -0 {2}a\.txt$/m);
  assert.match(preview, /^ {2}M {10}\+2 -1 {2}b\.txt$/m);
  assert.match(preview, /^ {2}D {10}\+0 -1 {2}c\.txt$/m);
  assert.ok(preview.includes(`  A          +1 -0  ${LONG_PATH}\n`), "long path is printed whole");
  assert.match(preview, /4 tracked files will be published/);
  assert.ok(!preview.includes("untracked.txt"));
  assert.equal(await forkRefs(), before);
  assert.equal(h.fork.latest_checkpoint_sha, null);
});

test("on consent the fork branch points at the checkpoint, which holds tracked files only", async (t) => {
  await editWorktreeA();
  const h = await harness([true]);
  const headBefore = (await repo.git(repo.worktreeA, "rev-parse", "HEAD")).trim();
  const statusBefore = await repo.git(repo.worktreeA, "status", "--porcelain=v1", "-z");

  const started = performance.now();
  const result = await h.publisher.publish(h.idOf("feature-a"));
  t.diagnostic(`preview, consent and push took ${(performance.now() - started).toFixed(1)} ms`);

  assert.equal(result.status, "published");
  assert.ok(result.status === "published");
  const checkpoint = result.preview.checkpoint_sha;
  assert.equal((await repo.git(forkPath, "rev-parse", "refs/heads/feature-a")).trim(), checkpoint);
  assert.equal(h.fork.latest_checkpoint_sha, checkpoint);

  const tree = (await repo.git(forkPath, "ls-tree", "-r", "--name-only", "-z", checkpoint)).split("\0").filter(Boolean);
  assert.deepEqual(tree.sort(), [LONG_PATH, "a.txt", "b.txt"].sort());
  assert.equal(await repo.git(forkPath, "show", `${checkpoint}:b.txt`), "uncommitted\nlines\n");
  // The checkpoint sits on top of the routine commit, which reaches the fork as its parent.
  assert.equal((await repo.git(forkPath, "rev-parse", `${checkpoint}^`)).trim(), headBefore);

  // Publishing leaves the worktree's HEAD, index and files as they were.
  assert.equal((await repo.git(repo.worktreeA, "rev-parse", "HEAD")).trim(), headBefore);
  assert.equal(await repo.git(repo.worktreeA, "status", "--porcelain=v1", "-z"), statusBefore);
});

test("routine local commits are not pushed until the owner publishes a checkpoint", async () => {
  await repo.write(repo.worktreeB, "c.txt", "routine\n");
  const routine = await repo.commitAll(repo.worktreeB, "routine");
  const h = await harness([true]);
  await h.registry.refresh();
  assert.ok(!(await forkRefs()).includes("feature-b"));
  await assert.rejects(repo.git(forkPath, "cat-file", "-e", routine));

  const result = await h.publisher.publish(h.idOf("feature-b"));
  assert.equal(result.status, "published");
  // A clean worktree's checkpoint is its HEAD; nothing is committed on top.
  assert.equal((await repo.git(forkPath, "rev-parse", "refs/heads/feature-b")).trim(), routine);
  assert.match(h.asked[0]!, /^ {2}M {10}\+1 -1 {2}c\.txt$/m);
});

test("refuses any remote other than the owner's fork, and a fork of another owner", async () => {
  await repo.write(repo.worktreeA, "a.txt", "change\n");
  const other = join(repo.root, "owner-jun.git");
  await repo.git(repo.root, "init", "--quiet", "--bare", other);

  const h = await harness([]);
  for (const remote of [other, "origin", "https://example.invalid/fork.git", "--upload-pack=touch /tmp/x"]) {
    await assert.rejects(h.publisher.publish(h.idOf("feature-a"), { remote }), /refusing to push/);
  }
  assert.equal(await repo.git(other, "for-each-ref"), "");

  const stranger = await harness([], "worktree", "jun");
  await assert.rejects(stranger.publisher.publish(stranger.idOf("feature-a")), /not the fork owner/);

  const notBare = await harness([]);
  notBare.fork.repo = repo.main;
  await assert.rejects(notBare.publisher.publish(notBare.idOf("feature-a")), /not a bare repository/);
  assert.equal(h.asked.length + stranger.asked.length + notBare.asked.length, 0);
});

test("a file name with shell syntax is passed to Git as data", async () => {
  const name = "$(touch pwned).txt";
  await repo.write(repo.worktreeA, name, "x\n");
  await repo.git(repo.worktreeA, "add", "--", name);
  const h = await harness([true]);
  await h.publisher.publish(h.idOf("feature-a"));
  assert.ok(h.asked[0]!.includes(`  ${name}\n`));
  await assert.rejects(access(join(repo.worktreeA, "pwned")));
});

test("worktree consent stands for that worktree only; each-publish asks every time", async () => {
  const h = await harness([true, true]);
  await repo.write(repo.worktreeA, "a.txt", "one\n");
  const first = await h.publisher.publish(h.idOf("feature-a"));
  assert.equal(first.status, "published");
  await repo.write(repo.worktreeA, "a.txt", "two\n");
  const second = await h.publisher.publish(h.idOf("feature-a"));
  assert.ok(first.status === "published" && second.status === "published");
  // The second checkpoint fast-forwards from the first and previews only the change since it.
  assert.equal(second.preview.base_sha, first.preview.checkpoint_sha);
  assert.deepEqual(second.preview.files, [{ status: "M", path: "a.txt", added: 1, deleted: 1 }]);
  assert.equal(
    (await repo.git(forkPath, "rev-parse", `${second.preview.checkpoint_sha}^2`)).trim(),
    first.preview.checkpoint_sha,
  );
  assert.equal(h.asked.length, 1, "second publish from the same worktree ran on standing consent");
  assert.match(h.output.join(""), /Standing consent \(worktree\) covers this publish/);
  // The preview is still printed before the second push.
  assert.equal(h.output.join("").match(/will be published/g)?.length, 2);

  await repo.write(repo.worktreeB, "b.txt", "other worktree\n");
  await h.publisher.publish(h.idOf("feature-b"));
  assert.equal(h.asked.length, 2, "another worktree asks again");

  const strict = await harness([true, true], "each-publish");
  await repo.write(repo.worktreeA, "a.txt", "three\n");
  await strict.publisher.publish(strict.idOf("feature-a"));
  await repo.write(repo.worktreeA, "a.txt", "four\n");
  await strict.publisher.publish(strict.idOf("feature-a"));
  assert.equal(strict.asked.length, 2);
});

test("project consent covers every worktree until revoked", async () => {
  const h = await harness([true, false], "project");
  await repo.write(repo.worktreeA, "a.txt", "one\n");
  await h.publisher.publish(h.idOf("feature-a"));
  await repo.write(repo.worktreeB, "b.txt", "two\n");
  assert.equal((await h.publisher.publish(h.idOf("feature-b"))).status, "published");
  assert.equal(h.asked.length, 1);

  await h.publisher.revokeConsent();
  await repo.write(repo.worktreeB, "b.txt", "three\n");
  assert.equal((await h.publisher.publish(h.idOf("feature-b"))).status, "refused");
});

test("publishing an unchanged checkpoint again does not ask", async () => {
  const h = await harness([true]);
  await repo.write(repo.worktreeA, "a.txt", "once\n");
  await repo.commitAll(repo.worktreeA, "once");
  await h.publisher.publish(h.idOf("feature-a"));
  assert.equal((await h.publisher.publish(h.idOf("feature-a"))).status, "up-to-date");
  assert.equal(h.asked.length, 1);
});

const IDENTITIES = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/identities.json");

/** Commits the fixture's identity registry to worktree A, then leaves an uncommitted change. */
async function identitiesInWorktreeA(change: string) {
  await mkdir(join(repo.worktreeA, "penguin"));
  await repo.write(repo.worktreeA, "penguin/identities.json", await readFile(IDENTITIES, "utf8"));
  await repo.commitAll(repo.worktreeA, "seed identities");
  await repo.write(repo.worktreeA, "a.txt", `${change}\n`);
}

/** The trailers of a commit's message, as `git interpret-trailers --parse` reads them. */
async function trailersOf(sha: string): Promise<string> {
  const message = await repo.git(forkPath, "log", "-1", "--format=%B", sha);
  const dir = await mkdtemp(join(repo.root, "message-"));
  await writeFile(join(dir, "MSG"), message);
  return repo.git(repo.main, "interpret-trailers", "--parse", join(dir, "MSG"));
}

test("a checkpoint built for an agent session ends with one Penguin-Agent trailer naming the identity and vendor", async () => {
  await identitiesInWorktreeA("by merge-rules");
  const h = await harness([true]);
  const result = await h.publisher.publish(h.idOf("feature-a"), { identity: "@priya/merge-rules" });
  assert.ok(result.status === "published");
  assert.equal(await trailersOf(result.preview.checkpoint_sha), "Penguin-Agent: @priya/merge-rules (claude-code)\n");
  assert.ok(!h.output.join("").includes("Warning"));
});

test("an identity of another owner is refused before the fork is read, naming the identity's owner and the fork owner", async () => {
  await identitiesInWorktreeA("by reports");
  const before = await forkRefs();
  const h = await harness([]);
  // @jun/not-registered is refused too: a handle's owner half is enough to refuse it.
  for (const identity of ["@jun/reports", "@jun/not-registered"]) {
    await assert.rejects(
      h.publisher.publish(h.idOf("feature-a"), { identity }),
      new RegExp(`^Error: refusing to publish as ${identity}: the identity belongs to @jun, not to priya, the fork owner$`),
    );
  }
  assert.equal(await forkRefs(), before);
  assert.deepEqual(h.output, []);
  assert.equal(h.asked.length, 0);

  // A fork path that does not exist would fail the first Git command on the fork; the refusal comes first.
  h.fork.repo = join(repo.root, "no-such-fork.git");
  await assert.rejects(h.publisher.publish(h.idOf("feature-a"), { identity: "@jun/reports" }), /belongs to @jun, not to priya/);
});

/** Commits a registry holding `@jun/pair` (Jun and Priya) and `@jun/duo` (Jun and Sam) to worktree A. */
async function teamIdentitiesInWorktreeA() {
  const team = (handle: string, owners: string[]) => ({ handle, owners, vendor: "codex", job: "pair work", charter_scopes: [] });
  const registry = { identities: [team("@jun/pair", ["jun", "priya"]), team("@jun/duo", ["jun", "sam"])] };
  await mkdir(join(repo.worktreeA, "penguin"));
  await repo.write(repo.worktreeA, "penguin/identities.json", JSON.stringify(registry));
  await repo.commitAll(repo.worktreeA, "seed team identities");
  // An uncommitted edit that adds Priya to @jun/duo does not count: the committed registry does.
  registry.identities[1]!.owners.push("priya");
  await repo.write(repo.worktreeA, "penguin/identities.json", JSON.stringify(registry));
}

test("a team identity is accepted when its committed owners include the fork owner and refused otherwise", async () => {
  await teamIdentitiesInWorktreeA();
  const h = await harness([true]);
  await assert.rejects(
    h.publisher.publish(h.idOf("feature-a"), { identity: "@jun/duo" }),
    /^Error: refusing to publish as @jun\/duo: its owners in penguin\/identities\.json at [0-9a-f]{12} do not include priya, the fork owner$/,
  );
  assert.equal(h.asked.length, 0);

  const result = await h.publisher.publish(h.idOf("feature-a"), { identity: "@jun/pair" });
  assert.ok(result.status === "published");
  assert.equal(await trailersOf(result.preview.checkpoint_sha), "Penguin-Agent: @jun/pair (codex)\n");
});

test("with the project's agent trailer off, the checkpoint carries no trailer and an identity of another owner is still refused", async () => {
  await identitiesInWorktreeA("trailer off");
  const h = await harness([true]);
  h.fork.agent_trailer = false;
  const result = await h.publisher.publish(h.idOf("feature-a"), { identity: "@priya/merge-rules" });
  assert.ok(result.status === "published");
  assert.equal(await trailersOf(result.preview.checkpoint_sha), "");

  // The owner check runs on every publish that names an identity, whether or not a trailer is stamped.
  await repo.write(repo.worktreeA, "a.txt", "trailer off, other owner\n");
  const before = await forkRefs();
  const printed = h.output.length;
  await assert.rejects(
    h.publisher.publish(h.idOf("feature-a"), { identity: "@jun/reports" }),
    /^Error: refusing to publish as @jun\/reports: the identity belongs to @jun, not to priya, the fork owner$/,
  );
  assert.equal(await forkRefs(), before);
  assert.equal(h.output.length, printed);
  assert.equal(h.asked.length, 1);
});

test("an identity absent from the registry publishes without a trailer and logs a warning", async () => {
  await identitiesInWorktreeA("unknown identity");
  const h = await harness([true, true]);
  const result = await h.publisher.publish(h.idOf("feature-a"), { identity: "@priya/not-registered" });
  assert.ok(result.status === "published");
  assert.equal(await trailersOf(result.preview.checkpoint_sha), "");
  assert.match(
    h.output.join(""),
    /^Warning: identity @priya\/not-registered is not in penguin\/identities\.json at [0-9a-f]{12}; the checkpoint carries no Penguin-Agent trailer\.$/m,
  );

  // Worktree B has no registry at all; a handle that is not one is refused before Git reads it.
  await repo.write(repo.worktreeB, "b.txt", "no registry\n");
  const bare = await h.publisher.publish(h.idOf("feature-b"), { identity: "@priya/merge-rules" });
  assert.ok(bare.status === "published");
  assert.equal(await trailersOf(bare.preview.checkpoint_sha), "");
  assert.match(h.output.join(""), /^Warning: penguin\/identities\.json at [0-9a-f]{12} could not be read; /m);
  await repo.write(repo.worktreeA, "a.txt", "bad handle\n");
  await h.publisher.publish(h.idOf("feature-a"), { identity: "@priya/x\nCo-authored-by: someone" });
  assert.match(h.output.join(""), /^Warning: "@priya\/x\\nCo-authored-by: someone" is not an identity handle; /m);
});

test("the preview keeps fixed columns within 80 and escapes control characters in paths", () => {
  const text = formatPreview(
    {
      worktree_id: "wt_1",
      branch: "feature-a",
      checkpoint_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      files: [
        { status: "M", path: LONG_PATH, added: 12345, deleted: 6789 },
        { status: "A", path: "bin/logo.png", added: null, deleted: null },
        { status: "A", path: "evil\u001b[2Jname", added: 1, deleted: 0 },
      ],
    },
    OWNER,
  );
  const lines = text.trimEnd().split("\n");
  for (const line of lines.filter((l) => !l.includes(LONG_PATH))) assert.ok(line.length <= 80, line);
  assert.ok(lines.includes(`  M   +12345 -6789  ${LONG_PATH}`));
  assert.ok(lines.includes("  A         binary  bin/logo.png"));
  assert.ok(lines.includes('  A          +1 -0  "evil\\u001b[2Jname"'));
});

test("the checkpoint command publishes on yes and exits 1 on no", async () => {
  await repo.write(repo.worktreeA, "a.txt", "from the cli\n");
  const run = async (answer: string) => {
    const out: string[] = [];
    const code = await runCli(
      ["checkpoint", "--owner", OWNER, "--project", "p", "--fork", forkPath, "--worktree", repo.worktreeA],
      { write: (text) => out.push(text), ask: async () => answer },
      { stateDir: join(repo.root, "bridge-state") },
    );
    return { code, out: out.join("") };
  };
  const refused = await run("n");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /a\.txt/);
  assert.ok(!(await forkRefs()).includes("feature-a"));

  const published = await run("yes");
  assert.equal(published.code, 0);
  assert.ok((await forkRefs()).includes("refs/heads/feature-a"));
  assert.equal(await repo.git(forkPath, "show", "refs/heads/feature-a:a.txt"), "from the cli\n");
});

test("the checkpoint command keeps a worktree's yes in the state folder until consent revoke", async () => {
  const stateDir = join(repo.root, "bridge-state");
  const asked: string[] = [];
  const cli = async (args: string[], answer = "n") => {
    const out: string[] = [];
    const io = { write: (text: string) => out.push(text), ask: async (q: string) => (asked.push(q), answer) };
    return { code: await runCli(args, io, { stateDir }), out: out.join("") };
  };
  const publish = (worktree: string, answer?: string, ...flags: string[]) =>
    cli(["checkpoint", "--owner", OWNER, "--project", "p", "--fork", forkPath, "--worktree", worktree, ...flags], answer);

  await repo.write(repo.worktreeA, "a.txt", "one\n");
  assert.equal((await publish(repo.worktreeA, "y")).code, 0);
  assert.equal(asked.length, 1);
  const file = join(stateDir, "consent.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // A later process publishing the same worktree runs on the stored yes; the preview still prints.
  await repo.write(repo.worktreeA, "a.txt", "two\n");
  const again = await publish(repo.worktreeA);
  assert.equal(again.code, 0);
  assert.equal(asked.length, 1);
  assert.match(again.out, /a\.txt/);
  assert.match(again.out, /Standing consent \(worktree\) covers this publish/);
  assert.match((await cli(["consent", "list"])).out, /^\/.+ \(.+\) -> \/.+\/owner-priya\.git for priya in p, since /);

  // Another worktree, the same worktree to another fork and --consent each-publish all still ask.
  await repo.write(repo.worktreeB, "b.txt", "other\n");
  assert.equal((await publish(repo.worktreeB)).code, 1);
  await repo.write(repo.worktreeA, "a.txt", "three\n");
  assert.equal((await publish(repo.worktreeA, "n", "--consent", "each-publish")).code, 1);
  const otherFork = join(repo.root, "other.git");
  await repo.git(repo.root, "init", "--quiet", "--bare", otherFork);
  const toOtherFork = ["checkpoint", "--owner", OWNER, "--project", "p", "--fork", otherFork, "--worktree", repo.worktreeA];
  assert.equal((await cli(toOtherFork)).code, 1);
  assert.equal(asked.length, 4);

  const revoked = await cli(["consent", "revoke", "--worktree", repo.worktreeA]);
  assert.match(revoked.out, /Revoked 1 standing consent\./);
  assert.equal((await publish(repo.worktreeA)).code, 1);
  assert.equal(asked.length, 5);
  assert.match((await cli(["consent", "list"])).out, /No standing consent/);
  assert.equal((await cli(["consent", "revoke", "--all", "--worktree", repo.worktreeA])).code, 2);
});

test("the checkpoint command passes --identity and --agent-trailer to the publisher", async () => {
  await identitiesInWorktreeA("agent session");
  const run = async (...flags: string[]) => {
    const out: string[] = [];
    const code = await runCli(
      ["checkpoint", "--owner", OWNER, "--project", "p", "--fork", forkPath, "--worktree", repo.worktreeA, ...flags],
      { write: (text) => out.push(text), ask: async () => "y" },
      { stateDir: join(repo.root, "bridge-state") },
    );
    return { code, out: out.join("") };
  };
  assert.equal((await run("--identity", "@priya/merge-rules", "--agent-trailer", "maybe")).code, 2);
  assert.equal((await run("--identity", "@priya/merge-rules", "--agent-trailer", "off")).code, 0);
  assert.equal(await trailersOf("refs/heads/feature-a"), "");

  await repo.write(repo.worktreeA, "a.txt", "agent session again\n");
  assert.equal((await run("--identity", "@priya/merge-rules")).code, 0);
  assert.equal(await trailersOf("refs/heads/feature-a"), "Penguin-Agent: @priya/merge-rules (claude-code)\n");
});

test("the checkpoint command exits non-zero when the identity belongs to another owner", async () => {
  await identitiesInWorktreeA("agent session of another owner");
  const before = await forkRefs();
  const cli = join(import.meta.dirname, "../src/cli.ts");
  const args = ["checkpoint", "--owner", OWNER, "--project", "p", "--fork", forkPath, "--worktree", repo.worktreeA];
  const outcome = await new Promise<{ code: number | null; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [cli, ...args, "--identity", "@jun/reports", "--state-dir", join(repo.root, "bridge-state")],
      (error, _stdout, stderr) => done({ code: error ? (error.code as number | null) : 0, stderr }),
    );
  });
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /refusing to publish as @jun\/reports: the identity belongs to @jun, not to priya, the fork owner/);
  assert.equal(await forkRefs(), before);
});
