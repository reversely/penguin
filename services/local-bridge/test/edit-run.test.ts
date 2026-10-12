// The person's bridge runs queued edit tasks headless (#129, PRD 0.5 section 4.4a), with a fake CLI
// for each vendor: success, failure, timeout and the bridge going offline. The fork is a local bare
// repository; Penguin's answers are fixed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixCommitMessage, type EditTaskReport, type EditTaskSpec } from "@penguin/protocol";

import { MemoryConsentStore } from "../src/consent-store.ts";
import { editPass, editPrompt, formatEditPass, runEditTask, vendorArgs, type ClaimedEditTask, type EditRunnerOptions, type EditVendor } from "../src/edit-run.ts";
import { localRemote, penguinRepoOf } from "../src/git-remote.ts";
import { claimEditTasks } from "../src/penguin-client.ts";

const FAKE = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A bare fork with one commit, the bridge's own repository and a fake CLI on disk. */
function setUp(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "penguin-edit-run-"));
  roots.push(root);
  const seed = join(root, "seed");
  git(root, "init", "--quiet", "--initial-branch=main", seed);
  execFileSync("mkdir", ["-p", join(seed, "analytics")]);
  writeFileSync(join(seed, "analytics", "weekly.py"), "def weekly():\n    return []\n");
  writeFileSync(join(seed, "README.md"), "readme\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  const fork = join(root, "fork.git");
  git(root, "clone", "--quiet", "--bare", seed, fork);
  const repo = join(root, "repo");
  git(root, "init", "--quiet", repo);
  const program = join(root, "agent");
  writeFileSync(program, `#!/bin/sh\nFAKE_AGENT_MODE=${mode} exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(program, 0o755);
  return { root, fork, repo, program, record: join(root, "record.json"), head: git(fork, "rev-parse", "main") };
}

const SPEC: EditTaskSpec = {
  taskId: 11,
  kind: "next_step",
  handle: "@jun/weekly-report",
  person: "jun",
  feature: "utc-day",
  fork: "feature-weekly-report",
  branch: "main",
  paths: ["analytics/weekly.py"],
  scopes: ["analytics"],
  allowed: ["analytics", "analytics/weekly.py"],
  instructions: "The tests check failed on feature utc-day's checkpoint merged onto feature weekly-report's fork.",
  verifier: "Penguin's block checks run again on the merged trees.",
  evidence: ["analytics/tests/test_weekly.py:9 assert 2 == 1"],
  leaseUntil: "2026-10-12T10:20:00.000Z",
  fixWrite: null,
  review: null,
};
const claimed = (spec: Partial<EditTaskSpec> = {}): ClaimedEditTask => ({ spec: { ...SPEC, ...spec }, token: { token: "art_secret", remote: "https://artifacts.test/x.git", expiresAt: "2026-10-12T10:20:00Z" } });

function runner(setup: ReturnType<typeof setUp>, vendor: EditVendor, timeoutMs = 30_000) {
  const asked: string[] = [];
  const written: string[] = [];
  const options: EditRunnerOptions = {
    repoPath: setup.repo,
    worktreeRoot: join(setup.root, "worktrees"),
    vendor: { vendor, program: setup.program, timeoutMs },
    consent: new MemoryConsentStore(),
    confirm: async (preview) => {
      asked.push(preview);
      return true;
    },
    write: (text) => written.push(text),
    projectId: "p",
    remote: () => localRemote(setup.fork),
  };
  return { options, asked, written };
}

process.env["FAKE_AGENT_RECORD"] = "";

describe("a headless run with a fake CLI", () => {
  for (const vendor of ["claude", "codex"] as const) {
    test(`${vendor}: the change becomes one commit on the fork, inside the task's paths, and the worktree goes`, async () => {
      const setup = setUp("success");
      process.env["FAKE_AGENT_RECORD"] = setup.record;
      const { options, asked } = runner(setup, vendor);
      const result = await runEditTask(options, claimed());
      assert.equal(result.report.status, "done", JSON.stringify(result.report));
      const commit = result.report.commit as string;
      assert.equal(git(setup.fork, "rev-parse", "main"), commit);
      assert.equal(git(setup.fork, "rev-parse", `${commit}^`), setup.head);
      assert.equal(git(setup.fork, "diff", "--name-only", setup.head, commit), "analytics/weekly.py");
      assert.match(git(setup.fork, "log", "-1", "--format=%B", commit), /Penguin-Agent: @jun\/weekly-report \((claude-code|codex)\)/u);
      // The outcome is built from facts; nothing the agent printed is in it.
      assert.match(result.report.outcome, new RegExp(`^${vendor === "claude" ? "claude -p" : "codex exec"} changed 1 file in \\d+ s; pushed ${commit.slice(0, 12)}$`, "u"));
      assert.doesNotMatch(result.report.outcome, /transcript/u);
      assert.equal(existsSync(result.worktree as string), false);
      assert.deepEqual(readdirSync(join(setup.root, "worktrees")), []);
      const seen = JSON.parse(readFileSync(setup.record, "utf8")) as { args: string[]; cwd: string; gitConfig: string[] };
      assert.deepEqual(seen.gitConfig, [], "the CLI's environment carries no Git credential configuration");
      assert.deepEqual(seen.args, vendorArgs(vendor, editPrompt(claimed().spec), result.worktree as string));
      if (vendor === "claude") {
        for (const flag of ["-p", "--restricted"]) assert.ok(seen.args.includes(flag), flag);
        assert.deepEqual(seen.args.slice(seen.args.indexOf("--allowedTools"), seen.args.indexOf("--allowedTools") + 2), ["--allowedTools", "Read,Edit,Write,Glob,Grep"]);
        assert.deepEqual(seen.args.slice(seen.args.indexOf("--output-format"), seen.args.indexOf("--output-format") + 2), ["--output-format", "json"]);
      } else {
        assert.deepEqual(seen.args.slice(0, 5), ["exec", "--sandbox", "workspace-write", "--cd", result.worktree]);
      }
      // The yes stands for the next result of the same identity on the same fork.
      assert.equal(asked.length, 1);
      const again = await runEditTask(options, claimed({ taskId: 12 }));
      assert.equal(again.report.status, "done");
      assert.equal(asked.length, 1);
    });

    test(`${vendor}: a failed run, an error result and a run that changed nothing push nothing`, async () => {
      for (const mode of ["fail", "error", "idle", "outside"]) {
        const setup = setUp(mode);
        const { options } = runner(setup, vendor);
        const result = await runEditTask(options, claimed());
        assert.equal(result.report.status, "failed", mode);
        assert.equal(git(setup.fork, "rev-parse", "main"), setup.head, mode);
        assert.equal(existsSync(result.worktree as string), false, mode);
        if (mode === "outside") assert.match(result.report.outcome, /changed README\.md, outside the task's files and scopes/u);
      }
    });

    test(`${vendor}: a run past its time limit is stopped and reported as a timeout`, async () => {
      const setup = setUp("hang");
      const { options } = runner(setup, vendor, 300);
      const result = await runEditTask(options, claimed());
      assert.deepEqual([result.report.status, existsSync(result.worktree as string)], ["timeout", false]);
      assert.equal(git(setup.fork, "rev-parse", "main"), setup.head);
    });
  }

  test("a person who does not consent publishes nothing", async () => {
    const setup = setUp("success");
    const { options } = runner(setup, "claude");
    const result = await runEditTask({ ...options, confirm: async () => false }, claimed());
    assert.deepEqual([result.report.status, result.report.outcome], ["failed", "the person did not consent to publish the result"]);
    assert.equal(git(setup.fork, "rev-parse", "main"), setup.head);
  });

  test("an approved fix is written by fix-write, with no agent", async () => {
    const setup = setUp("fail");
    const { options } = runner(setup, "claude");
    const writes: unknown[] = [];
    const fixWrite: NonNullable<EditTaskSpec["fixWrite"]> = {
      writeId: 3,
      feature: "utc-day",
      planId: "utc-day/v1",
      partId: "utc-day/v1#1",
      revision: 1,
      kind: "behavioural",
      writer: "agent",
      target: "weekly-report",
      fork: "feature-weekly-report",
      branch: "main",
      parent: setup.head,
      rebased: false,
      paths: ["analytics/weekly.py"],
      patch: "--- a/analytics/weekly.py\n+++ b/analytics/weekly.py\n@@ -1 +1 @@\n-a\n+b\n",
      message: fixCommitMessage({ partId: "utc-day/v1#1", revision: 1, target: "weekly-report", approvedBy: "jun", writtenBy: "@jun/weekly-report", ref: "r" }),
    };
    const result = await runEditTask(
      {
        ...options,
        writeFix: async (_remote, spec) => {
          writes.push(spec);
          return { status: "written", commit: "f".repeat(40), parent: setup.head, durationMs: 1 };
        },
      },
      { ...claimed(), spec: { ...SPEC, kind: "fix", fixWrite } },
    );
    // The fake CLI fails when it runs; the fix is written all the same, because no CLI starts.
    assert.deepEqual(result.report, { status: "done", outcome: `fix-write wrote the approved patch as ${"f".repeat(12)}`, commit: "f".repeat(40) });
    assert.deepEqual(writes, [fixWrite]);
    assert.equal(existsSync(join(setup.root, "worktrees")), false);
  });
});

describe("a pass of the person's queue", () => {
  test("the bridge going offline stops the CLI, reports the task stopped and removes the worktree", async () => {
    const setup = setUp("hang");
    const { options } = runner(setup, "claude");
    const stop = new AbortController();
    const reports: { taskId: number; report: EditTaskReport }[] = [];
    const pass = editPass({
      claim: async () => ({ tasks: [claimed()], queue: { running: 1, queued: 0, asked: 0, cap: 2 } }),
      run: (task, signal) => runEditTask(options, task, signal),
      report: async (taskId, report) => reports.push({ taskId, report }),
      signal: stop.signal,
    });
    setTimeout(() => stop.abort(), 300);
    const result = await pass;
    assert.deepEqual(reports, [{ taskId: 11, report: { status: "failed", outcome: "the bridge stopped during claude -p" } }]);
    assert.deepEqual(readdirSync(join(setup.root, "worktrees")), []);
    assert.equal(result.runs[0]?.error, null);
  });

  test("a report Penguin cannot take is kept on the line; the claim then runs out and Penguin asks the person", async () => {
    const setup = setUp("success");
    const { options } = runner(setup, "codex");
    const checkpoints: string[] = [];
    const result = await editPass({
      claim: async () => ({ tasks: [claimed()], queue: { running: 1, queued: 3, asked: 1, cap: 2 } }),
      run: (task) => runEditTask(options, task),
      report: async () => {
        throw new Error("Penguin at https://penguin.test is unreachable");
      },
      checkpoint: async (fork, sha) => checkpoints.push(`${fork}@${sha}`),
    });
    assert.equal(result.runs[0]?.error, "Penguin at https://penguin.test is unreachable");
    assert.deepEqual(checkpoints, []);
    const text = formatEditPass(result, "jun");
    assert.match(text, /Edit task 11 \(@jun\/weekly-report on feature-weekly-report\): done, but Penguin did not take the report/u);
    assert.match(text, /Edit tasks for jun: 1 running, 3 queued, 1 asked \(cap 2\)\.\n$/u);
  });

  test("a done run is reported, then recorded as a checkpoint of its fork", async () => {
    const setup = setUp("success");
    const { options } = runner(setup, "claude");
    const order: string[] = [];
    await editPass({
      claim: async () => ({ tasks: [claimed()], queue: { running: 1, queued: 0, asked: 0, cap: 2 } }),
      run: (task) => runEditTask(options, task),
      report: async (taskId, report) => order.push(`report ${taskId} ${report.status}`),
      checkpoint: async (fork) => order.push(`checkpoint ${fork}`),
    });
    assert.deepEqual(order, ["report 11 done", "checkpoint feature-weekly-report"]);
  });
});

describe("claiming from Penguin", () => {
  const answer = (task: Record<string, unknown>) => async () => Response.json({ tasks: [task], queue: { running: 1, queued: 0, asked: 0, cap: 2 } });
  const token = { token: "art_1", remote: "https://artifacts.test/x.git", scope: "write", expiresAt: "2026-10-12T10:20:00Z" };

  test("each task is checked against the spec before it is run", async () => {
    const claim = await claimEditTasks("https://penguin.test", "bridge", answer({ ...SPEC, token }) as typeof fetch);
    assert.deepEqual([claim.tasks[0]?.spec.taskId, claim.tasks[0]?.token.token, claim.queue.cap], [11, "art_1", 2]);
    await assert.rejects(claimEditTasks("https://penguin.test", "bridge", answer({ ...SPEC, fork: "base", token }) as typeof fetch), /without its spec and token/u);
    await assert.rejects(claimEditTasks("https://penguin.test", "bridge", answer({ ...SPEC }) as typeof fetch), /without its spec and token/u);
  });

  test("a review carries its task token for /mcp; without one it reports at once and runs nothing", async () => {
    const review = { ...SPEC, kind: "review", review: { feature: "utc-day", scope: "analytics", part: "utc-day/v1#1", revision: 1, trial: null } };
    const mcp = { token: "pgt_1", expiresAt: "2026-10-12T10:20:00Z" };
    const claim = await claimEditTasks("https://penguin.test", "bridge", answer({ ...review, token, mcp }) as typeof fetch);
    assert.deepEqual(claim.tasks[0]?.mcp, mcp);
    const setup = setUp("review");
    const { options } = runner(setup, "claude");
    const result = await runEditTask({ ...options, mcpUrl: "https://penguin.test/mcp" }, { ...claim.tasks[0]!, mcp: null });
    assert.deepEqual(result.report, { status: "failed", outcome: "the claim carried no task token for Penguin's MCP server" });
    assert.equal(existsSync(join(setup.root, "worktrees")), false);
  });
});

describe("a review run reads the part's trial tree (#140)", () => {
  /**
   * The helpful fix in small: main holds the weekly report; Jun's fork changed the README; Priya's fork
   * adds the local-day helper, then a fix to the report on top, which is her checkpoint. Each repo is
   * a local bare repository the read resolver hands out by name.
   */
  function project() {
    const setup = setUp("review-read");
    const seed = join(setup.root, "seed");
    const bare = (name: string) => {
      const path = join(setup.root, `${name}.git`);
      git(setup.root, "clone", "--quiet", "--bare", seed, path);
      return path;
    };
    const commit = (file: string, text: string, message: string) => {
      execFileSync("mkdir", ["-p", join(seed, file, "..")]);
      writeFileSync(join(seed, file), text);
      git(seed, "add", ".");
      git(seed, "commit", "--quiet", "-m", message);
      return git(seed, "rev-parse", "HEAD");
    };
    const base = bare("base");
    const baseline = git(seed, "rev-parse", "HEAD");
    commit("README.md", "jun's readme\n", "jun");
    const jun = bare("feature-weekly-report");
    git(seed, "reset", "--quiet", "--hard", baseline);
    const fixBase = commit("ingestion/day.py", "def start_of_local_day(ts, tz):\n    return ts\n", "priya: helper");
    const fix = commit("analytics/weekly.py", "from ingestion.day import start_of_local_day\n\ndef weekly():\n    return []\n", "priya: fix");
    const utc = bare("feature-utc-day");
    const repos: Record<string, string> = { base, "feature-weekly-report": jun, "feature-utc-day": utc };
    const fetched: string[] = [];
    const readRemote = (name: string) => {
      const repo = penguinRepoOf(name) as string;
      fetched.push(repo);
      return localRemote(repos[repo] as string);
    };
    const { options } = runner(setup, "claude");
    const reviewOptions: EditRunnerOptions = { ...options, remote: () => localRemote(utc), readRemote, mcpUrl: "http://127.0.0.1:9/mcp" };
    return { setup, reviewOptions, fetched, baseline, checkpoint: fix, fixBase, fix, jun, utc, junHead: git(jun, "rev-parse", "main") };
  }

  const PATCH = "--- a/analytics/weekly.py\n+++ b/analytics/weekly.py\n@@ -1,2 +1,3 @@\n def weekly():\n-    return []\n+    # bucketed by start_of_local_day\n+    return []\n";

  const reviewTask = (trial: NonNullable<EditTaskSpec["review"]>["trial"]): ClaimedEditTask => ({
    ...claimed({ kind: "review", fork: "feature-utc-day", feature: "utc-day", review: { feature: "utc-day", scope: "analytics", part: "utc-day/v1#1", revision: 1, trial } }),
    mcp: { token: "pgt_task", expiresAt: "2026-10-12T10:20:00Z" },
  });

  interface Seen {
    readonly prompt: string;
    readonly files: string[];
    readonly read: Record<string, string>;
    readonly args: string[];
  }

  test("a part on a running feature: Jun's fork head, Priya's checkpoint merged in and the part's patch applied", async () => {
    const run = project();
    process.env["FAKE_AGENT_RECORD"] = run.setup.record;
    const task = reviewTask({ checkpoint: run.checkpoint, target: { id: "weekly-report", repo: "feature-weekly-report", sha: run.junHead }, fix: { kind: "patch", patch: PATCH } });
    const result = await runEditTask(run.reviewOptions, task);
    assert.equal(result.report.status, "done", JSON.stringify(result.report));
    assert.match(result.report.outcome, /^claude -p finished the review of part utc-day\/v1#1 on its trial tree [0-9a-f]{12} in \d+ s$/u);
    const seen = JSON.parse(readFileSync(run.setup.record, "utf8")) as Seen;
    // The patch is in the worktree, on Jun's fork head with Priya's checkpoint merged in.
    assert.equal(seen.read["analytics/weekly.py"], "from ingestion.day import start_of_local_day\n\ndef weekly():\n    # bucketed by start_of_local_day\n    return []\n");
    assert.ok(seen.files.includes("ingestion/day.py"), "the checkpoint is merged in");
    // The prompt names the trial tree, the patch and the files it changes.
    assert.match(seen.prompt, /read-only checkout of the trial tree of part utc-day\/v1#1 revision 1/u);
    assert.ok(
      seen.prompt.includes(
        `feature weekly-report's fork head ${run.junHead.slice(0, 12)} (feature-weekly-report), with feature utc-day's checkpoint ${run.checkpoint.slice(0, 12)} merged in and the part's patch, applied to feature-weekly-report at ${run.junHead.slice(0, 12)}.`,
      ),
      seen.prompt,
    );
    assert.match(seen.prompt, /The fix changes: analytics\/weekly\.py\. Read those files here: the fix is in place\./u);
    // Read-only as before: the review tools and no write tool; no fork moved.
    assert.equal(seen.args[seen.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep,mcp__penguin__submit_review,mcp__penguin__whats_near,mcp__penguin__impact");
    assert.deepEqual([git(run.jun, "rev-parse", "main"), git(run.utc, "rev-parse", "main")], [run.junHead, run.checkpoint]);
    // Jun's fork is read with a read token; Priya's fork came with the task's own.
    assert.deepEqual(run.fetched, ["feature-weekly-report"]);
    assert.deepEqual(readdirSync(join(run.setup.root, "worktrees")), []);
  });

  test("a part on main: main at the baseline, the checkpoint merged in and the fix commit applied", async () => {
    const run = project();
    process.env["FAKE_AGENT_RECORD"] = run.setup.record;
    const task = reviewTask({ checkpoint: run.checkpoint, target: { id: "main", repo: "base", sha: run.baseline }, fix: { kind: "commit", repo: "feature-utc-day", commit: run.fix, base: run.fixBase } });
    const result = await runEditTask(run.reviewOptions, task);
    assert.equal(result.report.status, "done", JSON.stringify(result.report));
    const seen = JSON.parse(readFileSync(run.setup.record, "utf8")) as Seen;
    assert.match(seen.read["analytics/weekly.py"] ?? "", /^from ingestion\.day import start_of_local_day\n/u);
    assert.ok(seen.prompt.includes(`main at ${run.baseline.slice(0, 12)}, with feature utc-day's checkpoint`), seen.prompt);
    assert.ok(seen.prompt.includes(`the part's fix commit ${run.fix.slice(0, 12)} from feature-utc-day, applied as its change against ${run.fixBase.slice(0, 12)}.`), seen.prompt);
    assert.deepEqual(run.fetched, ["base"]);
  });

  test("a trial tree that does not build fails the run before the CLI starts", async () => {
    const run = project();
    process.env["FAKE_AGENT_RECORD"] = run.setup.record;
    rmSync(run.setup.record, { force: true });
    const task = reviewTask({ checkpoint: run.checkpoint, target: { id: "weekly-report", repo: "feature-weekly-report", sha: run.junHead }, fix: { kind: "patch", patch: PATCH.replace("-    return []", "-    return None") } });
    const result = await runEditTask(run.reviewOptions, task);
    assert.equal(result.report.status, "failed");
    assert.match(result.report.outcome, /^the part's trial tree does not build: the patch does not apply/u);
    assert.equal(existsSync(run.setup.record), false, "no CLI ran");
  });

  test("a review with no trial reads the reviewed fork, as before", async () => {
    const run = project();
    process.env["FAKE_AGENT_RECORD"] = run.setup.record;
    const result = await runEditTask(run.reviewOptions, reviewTask(null));
    assert.equal(result.report.status, "done", JSON.stringify(result.report));
    const seen = JSON.parse(readFileSync(run.setup.record, "utf8")) as Seen;
    assert.match(seen.prompt, /read-only checkout of feature-utc-day, the fork of feature utc-day\./u);
    assert.deepEqual([seen.read, run.fetched], [{}, []]);
  });
});
