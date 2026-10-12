import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { runGit } from "@penguin/git-analysis";
import { bridgeWriterTag } from "@penguin/protocol";
import {
  ARTIFACTS_FETCH_OPTIONS,
  ARTIFACTS_PUSH_OPTIONS,
  artifactsGitOptions,
  bridgeRemotes,
  bridgeSpool,
  bridgeTokenAccount,
  CHECKPOINT_ROUTE,
  fetchedBranch,
  fetchRepoBranches,
  IssueWriter,
  isAuthFailure,
  loadSigningKey,
  MemoryKeyStore,
  readRegistration,
  RemoteRefusedError,
  RemoteUnavailableError,
  runCli,
  tokenEnvironment,
  TokenClient,
  worktreeAt,
  type Fetch,
} from "@penguin/local-bridge";

import { createFixtureRepo } from "../../../tests/fixtures/git-repo.ts";
import { FakePenguin } from "./fake-penguin.ts";

const OWNER = "jun";

let root: string;
let stateDir: string;
let store: MemoryKeyStore;
let penguin: FakePenguin;
let output: string[];
/** Which Penguin routes the bridge cannot reach: the checkpoint route alone, or all of them. */
let offline: "reports" | "all" | null;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-artifacts-")));
  stateDir = join(root, "state");
  store = new MemoryKeyStore();
  output = [];
  offline = null;
  penguin = new FakePenguin(join(root, "artifacts"), OWNER);
  await mkdir(join(root, "artifacts"));
  await penguin.start(["issues", `owner-${OWNER}`, "owner-priya"]);
});

afterEach(async () => {
  await penguin.stop();
  await rm(root, { recursive: true, force: true });
});

const bridgeFetch: Fetch = async (input, init) => {
  if (offline === "all" || (offline === "reports" && String(input).endsWith(CHECKPOINT_ROUTE))) {
    throw new TypeError("fetch failed");
  }
  return fetch(input, init);
};

function cli(args: string[], answer = "") {
  return runCli(
    args,
    { write: (text) => output.push(text), ask: async () => answer },
    { keyStore: store, stateDir, fetch: bridgeFetch },
  );
}

const register = () => cli(["register", "--server", penguin.origin, "--owner", OWNER, "--code", penguin.code]);

/** Every file under `dir`, recursively, with its contents. */
async function filesUnder(dir: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path, text: await readFile(path, "latin1") });
  }
  return files;
}

/** No secret appears in the state folder (spool, clone, Git config) or in anything printed. */
async function assertNoSecretLeaked(): Promise<void> {
  const secrets = [penguin.bridgeToken, ...penguin.minted.map(({ token }) => token)];
  // The hex part alone too, in case a token was written without its ?expires= suffix.
  secrets.push(...penguin.minted.map(({ token }) => token.slice(0, token.indexOf("?"))));
  for (const { path, text } of await filesUnder(stateDir)) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `a token is in ${path}`);
    assert.ok(!/https?:\/\/[^/\s]*@/.test(text), `a URL with credentials is in ${path}`);
  }
  const printed = output.join("");
  for (const secret of secrets) assert.ok(!printed.includes(secret), "a token was printed");
}

/**
 * Every Git request reached the server with a Bearer token, pushes over protocol v1 and fetches over
 * protocol v2.
 */
function assertProtocols(service?: string): void {
  const requests = penguin.gitRequests.filter((request) => request.accepted);
  assert.ok(requests.length > 0, "no Git request was accepted");
  if (service !== undefined) assert.ok(requests.some((request) => request.service === service), `no ${service} request`);
  for (const request of penguin.gitRequests) {
    assert.equal(request.scheme, "Bearer");
    const expected = request.service === "git-receive-pack" ? "version=1" : "version=2";
    assert.equal(request.protocol, expected, `${request.service} on ${request.repo}`);
  }
}

describe("bridge registration", () => {
  test("stores the bridge token in the key store and only the registration record on disk", async () => {
    assert.equal(await register(), 0);
    assert.equal(await store.get(bridgeTokenAccount(OWNER)), penguin.bridgeToken);
    assert.deepEqual(await readRegistration(stateDir), {
      server: penguin.origin,
      bridgeId: "bridge-1",
      owner: OWNER,
      role: "owner",
    });
    assert.match(output.join(""), /^Registered bridge bridge-1 for jun \(owner\)/);
    await assertNoSecretLeaked();
  });

  test("a spent code is refused and the key store keeps the first token", async () => {
    assert.equal(await register(), 0);
    await assert.rejects(register(), /HTTP 401/);
    assert.equal(await store.get(bridgeTokenAccount(OWNER)), penguin.bridgeToken);
  });

  test("a code issued for another owner stores nothing", async () => {
    const code = await cli(["register", "--server", penguin.origin, "--owner", "priya", "--code", penguin.code]).catch(
      (error: Error) => error.message,
    );
    assert.match(String(code), /belongs to jun, not priya/);
    assert.equal(await store.get(bridgeTokenAccount("priya")), null);
    assert.equal(await readRegistration(stateDir), null);
  });

  test("refuses to send a code to a server over plain HTTP that is not loopback", async () => {
    await assert.rejects(
      cli(["register", "--server", "http://penguin.example", "--owner", OWNER, "--code", penguin.code]),
      /https/,
    );
  });
});

describe("pushing to Artifacts", () => {
  test("an issue command pushes its operation file to the issues repo over protocol v1 after a fetch over v2", async () => {
    await register();
    const started = performance.now();
    assert.equal(await cli(["issue", "create", "--owner", OWNER, "--title", "Retention drops on merge"]), 0);
    const elapsed = performance.now() - started;
    const pushed = /^Pushed (\S+) in commit/m.exec(output.join(""))?.[1] ?? assert.fail(output.join(""));
    const text = await runGit(penguin.repoPath("issues"), ["cat-file", "blob", `main:${pushed}`]);
    assert.equal(JSON.parse(text).payload.title, "Retention drops on merge");
    // A registered bridge numbers under the tag derived from its bridge ID.
    assert.equal(JSON.parse(text).op_id, `${OWNER}-${await bridgeWriterTag("bridge-1")}-0001`);
    assertProtocols("git-receive-pack");
    // One token for the issues repo, reused for the fetch and the push.
    assert.deepEqual(
      penguin.minted.map(({ repo }) => repo),
      ["issues"],
    );
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
    await assertNoSecretLeaked();
  });

  test("the checkpoint command pushes to the owner's fork in Artifacts", async () => {
    await register();
    const repo = await createFixtureRepo();
    try {
      for (const [key, value] of [
        ["user.name", "Penguin Fixture"],
        ["user.email", "fixture@penguin.invalid"],
        ["commit.gpgsign", "false"],
      ]) {
        await repo.git(repo.main, "config", key!, value!);
      }
      await repo.write(repo.worktreeA, "a.txt", "checkpointed edit\n");
      const { id } = await worktreeAt(repo.worktreeA);
      penguin.deliveries = (worktreeId) =>
        worktreeId === id ? [{ sessionId: "ses_1", identity: "@jun/reports", delivered: ["2"] }] : [];
      const code = await cli(
        ["checkpoint", "--owner", OWNER, "--project", "p", "--worktree", repo.worktreeA],
        "y",
      );
      assert.equal(code, 0, output.join(""));
      assert.match(output.join(""), /^Published [0-9a-f]{40} to refs\/heads\/feature-a\.$/m);
      // The publish is an explicit safe checkpoint for the sessions in the worktree.
      assert.deepEqual(penguin.sessionCheckpoints, [id]);
      assert.match(output.join(""), /^Penguin delivered fix task #2 to @jun\/reports \(session ses_1\)\.$/m);
      const fork = penguin.repoPath(`owner-${OWNER}`);
      assert.equal(await runGit(fork, ["show", "refs/heads/feature-a:a.txt"]), "checkpointed edit\n");
      // Penguin records the pushed checkpoint as the fork's latest, with no agent session.
      const tip = (await runGit(fork, ["rev-parse", "refs/heads/feature-a"])).trim();
      assert.deepEqual(penguin.checkpoints, [{ fork: `owner-${OWNER}`, sha: tip }]);
      assertProtocols("git-receive-pack");
      assert.deepEqual(new Set(penguin.minted.map(({ repo: name }) => name)), new Set([`owner-${OWNER}`]));
      await assertNoSecretLeaked();
      // The worktree's own Git config gained no remote and no header.
      const config = await readFile(join(repo.main, ".git", "config"), "utf8");
      assert.ok(!config.includes("extraHeader") && !config.includes("artifacts"), config);
    } finally {
      await repo.cleanup();
    }
  });

  for (const scope of ["reports", "all"] as const) {
    test(`a report queued while ${scope === "all" ? "Penguin is" : "the checkpoint route is"} offline is sent once on reconnect`, async () => {
      await register();
      const repo = await createFixtureRepo();
      try {
        for (const [key, value] of [
          ["user.name", "Penguin Fixture"],
          ["user.email", "fixture@penguin.invalid"],
          ["commit.gpgsign", "false"],
        ]) {
          await repo.git(repo.main, "config", key!, value!);
        }
        await repo.write(repo.worktreeA, "a.txt", "offline edit\n");
        offline = scope;
        const code = await cli(["checkpoint", "--owner", OWNER, "--project", "p", "--worktree", repo.worktreeA], "y");
        assert.equal(code, 0, output.join(""));
        if (scope === "reports") {
          // The push went through; only the report waits.
          assert.match(output.join(""), /^Published [0-9a-f]{40}/m);
          assert.match(output.join(""), /^Penguin has not recorded [0-9a-f]{40} .*unreachable/m);
        } else {
          assert.match(output.join(""), /^Queued [0-9a-f]{40} for refs\/heads\/feature-a: /m);
        }
        assert.deepEqual(penguin.checkpoints, []);

        offline = null;
        output = [];
        assert.equal(await cli(["spool", "drain"]), 0, output.join(""));
        assert.match(output.join(""), /^\d pushed, 0 queued, 0 failed\.$/m);
        const tip = (await runGit(penguin.repoPath(`owner-${OWNER}`), ["rev-parse", "refs/heads/feature-a"])).trim();
        assert.deepEqual(penguin.checkpoints, [{ fork: `owner-${OWNER}`, sha: tip }]);

        // A second drain sends nothing again.
        output = [];
        assert.equal(await cli(["spool", "drain"]), 0);
        assert.match(output.join(""), /^0 pushed, 0 queued, 0 failed\.$/m);
        assert.equal(penguin.checkpoints.length, 1);
        await assertNoSecretLeaked();
      } finally {
        await repo.cleanup();
      }
    });
  }

  test("a checkpoint to another owner's fork is refused before Git runs", async () => {
    await register();
    const repo = await createFixtureRepo();
    try {
      await assert.rejects(
        cli(["checkpoint", "--owner", OWNER, "--project", "p", "--worktree", repo.worktreeA, "--fork", "penguin:owner-priya"], "y"),
        /not jun's fork/,
      );
      assert.equal(penguin.gitRequests.length, 0);
    } finally {
      await repo.cleanup();
    }
  });

  test("an expired token is replaced and the push succeeds without owner action", async () => {
    await register();
    const remotes = bridgeRemotes(stateDir, store);
    const writer = new IssueWriter({
      remote: "penguin:issues",
      remotes,
      clonePath: join(stateDir, "issues", "clone"),
      ownerId: OWNER,
      writer: await bridgeWriterTag("bridge-1"),
      key: await loadSigningKey(store, OWNER),
      spool: bridgeSpool(stateDir),
    });
    const created = await writer.write({ type: "create", payload: { title: "First" } });
    assert.equal(created.status, "pushed", created.reason ?? "");
    assert.equal(penguin.minted.length, 1);

    // The cached token still looks valid to the bridge, but the server no longer accepts it.
    penguin.expireAll();
    const comment = await writer.write({ type: "comment", issue: created.operation.op_id, payload: { body: "Second" } });
    assert.equal(comment.status, "pushed", comment.reason ?? "");
    assert.equal(penguin.minted.length, 2);
    assert.ok(penguin.gitRequests.some((request) => !request.accepted), "the stale token was never refused");
    const files = await runGit(penguin.repoPath("issues"), ["ls-tree", "-r", "--name-only", "main"]);
    assert.equal(files.trim().split("\n").length, 2);
    await assertNoSecretLeaked();
  });

  test("an operation written before registration waits in the spool and the drain pushes it", async () => {
    assert.equal(await cli(["issue", "create", "--owner", OWNER, "--title", "Offline"]), 0);
    assert.match(output.join(""), /^Queued .*not registered/m);
    assert.equal(penguin.gitRequests.length, 0);

    await register();
    output = [];
    assert.equal(await cli(["spool", "drain"]), 0);
    assert.match(output.join(""), /^1 pushed, 0 queued, 0 failed\.$/m);
    const files = await runGit(penguin.repoPath("issues"), ["ls-tree", "-r", "--name-only", "main"]);
    assert.equal(files.trim().split("\n").length, 1);
    await assertNoSecretLeaked();
  });
});

describe("the token client", () => {
  async function client(now = Date.now) {
    await register();
    return new TokenClient({ server: penguin.origin, bridgeToken: penguin.bridgeToken, now, refreshMarginMs: 30_000 });
  }

  test("reuses a token until it is about to expire, then fetches a new one", async () => {
    let clock = Date.now();
    const tokens = await client(() => clock);
    penguin.ttlSeconds = 120;
    const first = await tokens.token("issues");
    assert.equal((await tokens.token("issues")).token, first.token);
    clock += 95_000;
    const second = await tokens.token("issues");
    assert.notEqual(second.token, first.token);
    assert.equal(tokens.fetched, 2);
    assert.equal(second.remote, `${penguin.origin}/git/penguin/issues.git`);
  });

  test("a repo the bridge may not write is refused for good; a missing repo or server waits", async () => {
    const tokens = await client();
    await assert.rejects(tokens.token("owner-priya"), RemoteRefusedError);
    await assert.rejects(tokens.token("huddle-031"), RemoteRefusedError);
    await rm(penguin.repoPath("issues"), { recursive: true });
    await assert.rejects(tokens.token("issues"), /does not exist in Artifacts yet/);
    await penguin.stop();
    await assert.rejects(tokens.token(`owner-${OWNER}`), RemoteUnavailableError);
  });

  test("hands Git the token through the environment, after any configuration already there", () => {
    const env = tokenEnvironment("art_v1_abc", { GIT_CONFIG_COUNT: "2" });
    assert.equal(env.GIT_CONFIG_COUNT, "3");
    assert.equal(env.GIT_CONFIG_KEY_2, "http.extraHeader");
    assert.equal(env.GIT_CONFIG_VALUE_2, "Authorization: Bearer art_v1_abc");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    // An editor's askpass program would otherwise be asked for a password after a refusal.
    assert.equal(env.GIT_ASKPASS, "");
    assert.ok(isAuthFailure(new Error("fatal: could not read Username for 'https://x': terminal prompts disabled")));
    assert.ok(!isAuthFailure(new Error("fatal: unable to access 'https://x/': Could not resolve host: x")));
  });
});

describe("Git protocol versions", () => {
  test("a push runs over protocol v1 and every other command over v2, with no credential prompts", () => {
    const quiet = ["-c", "credential.helper=", "-c", "core.askPass="];
    assert.deepEqual(ARTIFACTS_PUSH_OPTIONS, ["-c", "protocol.version=1", ...quiet]);
    assert.deepEqual(ARTIFACTS_FETCH_OPTIONS, ["-c", "protocol.version=2", ...quiet]);
    assert.equal(artifactsGitOptions(["push", "--porcelain", "--end-of-options", "https://x", "a:b"]), ARTIFACTS_PUSH_OPTIONS);
    // Configuration ahead of the subcommand, as the issues clone passes it.
    assert.equal(artifactsGitOptions(["-c", "core.hooksPath=/dev/null", "push", "--quiet", "https://x"]), ARTIFACTS_PUSH_OPTIONS);
    for (const command of ["fetch", "ls-remote", "clone"]) {
      assert.equal(artifactsGitOptions([command, "--end-of-options", "https://x"]), ARTIFACTS_FETCH_OPTIONS);
    }
    // A refspec or URL named "push" is not the subcommand.
    assert.equal(artifactsGitOptions(["fetch", "--end-of-options", "push", "push"]), ARTIFACTS_FETCH_OPTIONS);
  });

  test("the runner fetches several forks into one repository over protocol v2 with read tokens", async () => {
    await register();
    const forks = ["owner-a", "owner-b", "owner-c"];
    for (const fork of forks) await runGit(root, ["init", "--quiet", "--bare", "-b", "main", penguin.repoPath(fork)]);
    const source = join(root, "source");
    await runGit(root, ["init", "--quiet", "-b", "main", source]);
    const commit = ["-c", "user.name=Penguin Fixture", "-c", "user.email=fixture@penguin.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty"];
    await runGit(source, [...commit, "-m", "base"]);
    const tips = new Map<string, string>();
    for (const fork of forks) {
      await runGit(source, ["checkout", "--quiet", "-B", fork, "main"]);
      await runGit(source, [...commit, "-m", fork]);
      tips.set(fork, (await runGit(source, ["rev-parse", "HEAD"])).trim());
      await runGit(source, ["push", "--quiet", penguin.repoPath(fork), `${fork}:refs/heads/feature`]);
    }
    const runnerRepo = join(root, "runner");
    await runGit(root, ["init", "--quiet", runnerRepo]);
    const remotes = bridgeRemotes(stateDir, store, bridgeFetch, "read");
    for (const fork of forks) await fetchRepoBranches(runnerRepo, remotes, fork);
    for (const fork of forks) assert.equal(await fetchedBranch(runnerRepo, fork, "feature"), tips.get(fork));
    assertProtocols("git-upload-pack");
    assert.ok(penguin.gitRequests.every((request) => request.service === "git-upload-pack"), "the runner pushed");
    await assertNoSecretLeaked();
  });
});

describe("safe checkpoints for agent sessions", () => {
  let repo: Awaited<ReturnType<typeof createFixtureRepo>>;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(() => repo.cleanup());

  /** Registers the bridge and forgets what registering printed. */
  async function registered(): Promise<void> {
    assert.equal(await register(), 0);
    output.length = 0;
  }

  test("worktree-id prints the id a session in the worktree registers with", async () => {
    assert.equal(await cli(["worktree-id", "--worktree", repo.worktreeB]), 0);
    const { id } = await worktreeAt(repo.worktreeB);
    assert.match(id, /^wt_[0-9a-f]{16}$/u);
    assert.deepEqual(output, [`${id}\n`]);
  });

  test("as a PreToolUse hook it tells the agent about delivered fix tasks, and nothing otherwise", async () => {
    await registered();
    const { id } = await worktreeAt(repo.worktreeA);
    let delivered: string[] = [];
    penguin.deliveries = () => [{ sessionId: "ses_1", identity: "@jun/reports", delivered }];
    const hook = ["session-checkpoint", "--hook", "--worktree", repo.worktreeA];

    assert.equal(await cli(hook), 0);
    assert.deepEqual(output, []);

    delivered = ["2", "3"];
    assert.equal(await cli(hook), 0);
    assert.deepEqual(penguin.sessionCheckpoints, [id, id]);
    const answer = JSON.parse(output.join(""));
    assert.equal(answer.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(
      answer.hookSpecificOutput.additionalContext,
      /^Penguin delivered fix tasks #2, #3 to @jun\/reports \(session ses_1\)\. .*get_work/u,
    );
    await assertNoSecretLeaked();
  });

  test("as a PreToolUse hook it tells the agent about a thread that now needs its developer", async () => {
    await registered();
    penguin.deliveries = () => [
      { sessionId: "ses_2", identity: "@priya/merge-rules", delivered: [], threads: [{ issueId: "3", threadId: "penguin-web-0021" }] },
    ];
    assert.equal(await cli(["session-checkpoint", "--hook", "--worktree", repo.worktreeA]), 0);
    const context = JSON.parse(output.join("")).hookSpecificOutput.additionalContext;
    assert.match(context, /^Penguin: a thread on #3 now needs the developer of @priya\/merge-rules \(session ses_2\)\. /u);
    assert.match(context, /Tell your developer about each thread in get_work's threadsNeedingYou\.$/u);
  });

  test("as a PreToolUse hook it tells the agent about a start that waits for its developer's approval", async () => {
    await registered();
    penguin.deliveries = () => [
      {
        sessionId: "ses_3",
        identity: "@priya/merge-rules",
        delivered: [],
        overlaps: [{ feature: "identity-rework", blockedFeature: "merge-ids" }],
      },
    ];
    assert.equal(await cli(["session-checkpoint", "--hook", "--worktree", repo.worktreeA]), 0);
    const context = JSON.parse(output.join("")).hookSpecificOutput.additionalContext;
    assert.match(
      context,
      /^Penguin: feature merge-ids waits for the developer of @priya\/merge-rules \(session ses_3\) to approve its start beside feature identity-rework\. /u,
    );
    assert.match(context, /overlapsNeedingYou; they approve it on the dashboard's inbox\.$/u);
  });

  test("as a PreToolUse hook it tells the agent that a lock on its feature's start was approved", async () => {
    await registered();
    penguin.deliveries = () => [
      {
        sessionId: "ses_4",
        identity: "@jun/reports",
        delivered: [],
        locksSettled: [{ feature: "identity-rework", blockedFeature: "merge-ids", outcome: "approved" }],
      },
    ];
    assert.equal(await cli(["session-checkpoint", "--hook", "--worktree", repo.worktreeA]), 0);
    const context = JSON.parse(output.join("")).hookSpecificOutput.additionalContext;
    assert.match(context, /^Penguin: the lock of feature identity-rework on feature merge-ids was approved for @jun\/reports \(session ses_4\)\. /u);
    assert.match(context, /call feature_token for the write token on your feature's fork\.$/u);
  });

  test("as a PreToolUse hook it tells the agent about plan parts, decisions and review verdicts", async () => {
    await registered();
    penguin.deliveries = () => [
      {
        sessionId: "ses_5",
        identity: "@rahul/work",
        delivered: [],
        newPlanParts: [{ feature: "money-minor", part: "money-minor/v1#2", revision: 1, scopes: ["tax"] }],
        planDecisions: [{ feature: "tax-rounding", part: "tax-rounding/v1#1", revision: 2, state: "change_requested" }],
        // Refusal codes and exception kinds only; the words behind them stay in get_work.
        reviewResults: [{ reviewId: 7, feature: "money-minor", scope: "tax", state: "accepted", refusals: [], exceptions: ["protected_difference"] }],
      },
    ];
    assert.equal(await cli(["session-checkpoint", "--hook", "--worktree", repo.worktreeA]), 0);
    const context = JSON.parse(output.join("")).hookSpecificOutput.additionalContext;
    assert.match(context, /^Penguin: revision 1 of part money-minor\/v1#2 of feature money-minor's merge plan touches tax and waits on the developer of @rahul\/work \(session ses_5\)\. /u);
    assert.match(context, /revision 2 of part tax-rounding\/v1#1 of the merge plan of @rahul\/work \(session ses_5\) is change requested\./u);
    assert.match(context, /review 7 of tax on feature money-minor by @rahul\/work \(session ses_5\) was accepted; it raised protected_difference for the scope's owner\./u);
    assert.match(context, /you never approve it\. Answer each change_requested part in get_work's plan with revise_plan_part\. get_work's reviewResults/u);
  });

  test("an unreachable Penguin never stops the agent's tool call, and the command says why", async () => {
    await registered();
    offline = "all";
    assert.equal(await cli(["session-checkpoint", "--hook", "--worktree", repo.worktreeA]), 0);
    assert.deepEqual(output, []);
    assert.equal(await cli(["session-checkpoint", "--worktree", repo.worktreeA]), 1);
    assert.match(output.join(""), /^Penguin did not take the safe checkpoint: Penguin at .* is unreachable/u);
  });

  test("by hand it names the delivered tasks, or says no session runs in the worktree", async () => {
    await registered();
    const { id } = await worktreeAt(repo.worktreeA);
    assert.equal(await cli(["session-checkpoint", "--worktree", repo.worktreeA]), 0);
    assert.deepEqual(output, [`No running session of yours is registered with worktree id ${id}.\n`]);
    output.length = 0;
    penguin.deliveries = () => [{ sessionId: "ses_1", identity: "@jun/reports", delivered: ["4"] }];
    assert.equal(await cli(["session-checkpoint", "--worktree", repo.worktreeA]), 0);
    assert.deepEqual(output, ["Penguin delivered fix task #4 to @jun/reports (session ses_1).\n"]);
  });
});
