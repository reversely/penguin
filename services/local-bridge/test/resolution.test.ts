import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runGit } from "@penguin/git-analysis";
import {
  BlockChecker,
  checkTools,
  CombinedRunner,
  FixApplier,
  formatResolution,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  ResolutionLadder,
  runCli,
  runProgram,
  TestRunner,
  type ResolveResult,
  ownerForkTargets,
} from "@penguin/local-bridge";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter), UV_OFFLINE: "1" };
const ISOLATED = ["-c", "user.name=Test", "-c", "user.email=test@penguin.invalid", "-c", "commit.gpgsign=false"];

async function scratchRepo(root: string) {
  const path = join(root, "repo");
  await runGit(root, ["init", "--quiet", "-b", "main", path]);
  const git = (...args: string[]) => runGit(path, [...ISOLATED, ...args]);
  return {
    path,
    git,
    async commit(start: string | null, files: Record<string, string>): Promise<string> {
      if (start !== null) await git("checkout", "--quiet", "--detach", start);
      for (const [file, text] of Object.entries(files)) {
        await mkdir(dirname(join(path, file)), { recursive: true });
        await writeFile(join(path, file), text);
      }
      await git("add", "--all");
      await git("commit", "--quiet", "-m", "commit");
      return (await git("rev-parse", "HEAD")).trim();
    },
  };
}

const HAS_UV = await hasUv();
const show = (repo: string, commit: string, path: string) => runGit(repo, ["cat-file", "blob", `${commit}:${path}`]);

describe("Penguin's deterministic fixes", () => {
  let root: string;
  let repo: Awaited<ReturnType<typeof scratchRepo>>;
  let fixes: FixApplier;
  const commits: Record<string, string> = {};

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-fix-")));
    repo = await scratchRepo(root);
    commits.base = await repo.commit(null, {
      "core/__init__.py": "",
      "core/dates.py": "def start(moment, zone=None):\n    return moment\n",
      "app/__init__.py": "",
      "app/use.py": "import os\nfrom core.dates import start\n\n\ndef run():\n    return start(1,zone=2)\n",
      "other/__init__.py": "",
      "other/keep.py": "x  =  1\n",
    });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret.py"), "y  =  2\n");
    await symlink(join(root, "outside"), join(repo.path, "linked"));
    await symlink(join(root, "outside", "secret.py"), join(repo.path, "app", "link.py"));
    commits.links = await repo.commit(null, {});
    fixes = new FixApplier({ repoPath: repo.path, ruff: RUFF, python: PYTHON, env: TEST_ENV, scratchDir: root });
  });

  after(() => rm(root, { recursive: true, force: true }));

  test("format rewrites the named file and makes one commit on top of the commit it started from", async () => {
    const run = await fixes.apply({ kind: "format", commit: commits.base as string, paths: ["app/use.py"], allowed: ["app"] });
    assert.equal(run.record.result, "changed", run.record.summary);
    assert.equal(run.record.commandId, "fix:ruff-format");
    assert.deepEqual(run.record.changed?.paths, ["app/use.py"]);
    assert.match(await show(repo.path, run.commit as string, "app/use.py"), /start\(1, zone=2\)/);
    assert.equal((await runGit(repo.path, ["rev-parse", `${run.commit}^`])).trim(), commits.base);
    assert.equal(await show(repo.path, run.commit as string, "other/keep.py"), "x  =  1\n");
  });

  test("lint autofix removes the unused import", async () => {
    const run = await fixes.apply({ kind: "lint", commit: commits.base as string, paths: ["app/use.py"], allowed: ["app"] });
    assert.equal(run.record.result, "changed", run.record.summary);
    assert.doesNotMatch(await show(repo.path, run.commit as string, "app/use.py"), /import os/);
  });

  test("the codemod renames the import and the call, and the keyword parameter", async () => {
    const run = await fixes.apply({
      kind: "codemod",
      commit: commits.base as string,
      paths: ["app/use.py"],
      allowed: ["app"],
      edits: [
        { kind: "rename", from: "core.dates.start", to: "core.dates.start_local" },
        { kind: "rename-parameter", function: "core.dates.start_local", from: "zone", to: "offset" },
      ],
    });
    assert.equal(run.record.result, "changed", run.record.summary);
    const text = await show(repo.path, run.commit as string, "app/use.py");
    assert.match(text, /from core\.dates import start_local\n/);
    assert.match(text, /return start_local\(1,offset=2\)/);
  });

  test("an expand codemod writes the old name beside the new one in one commit, and takes no second form", async () => {
    const renamed = await repo.commit(commits.base as string, { "core/dates.py": "def start_local(moment, zone=None):\n    return moment\n" });
    const run = await fixes.apply({
      kind: "codemod",
      commit: renamed,
      paths: ["core/dates.py"],
      allowed: ["core"],
      expand: [{ kind: "rename", from: "core.dates.start", to: "core.dates.start_local" }],
    });
    assert.equal(run.record.result, "changed", run.record.summary);
    assert.deepEqual(run.record.input["expand"], [{ kind: "rename", from: "core.dates.start", to: "core.dates.start_local" }]);
    assert.match(await show(repo.path, run.commit as string, "core/dates.py"), /\n\n\n# Penguin's expand step keeps the old name while callers move\.\nstart = start_local\n$/u);
    const both = await fixes.apply({
      kind: "codemod",
      commit: renamed,
      paths: ["core/dates.py"],
      allowed: ["core"],
      edits: [{ kind: "rename", from: "core.dates.start", to: "core.dates.start_local" }],
      expand: [{ kind: "rename", from: "core.dates.start", to: "core.dates.start_local" }],
    });
    assert.match(both.record.summary, /one of edits, expand or rules/u);
  });

  test("a fix refuses a path outside the allowed paths, a symlink and an unknown kind, and commits nothing", async () => {
    const outside = await fixes.apply({ kind: "format", commit: commits.base as string, paths: ["other/keep.py"], allowed: ["app"] });
    assert.equal(outside.record.result, "refused");
    assert.match(outside.record.summary, /outside the allowed paths/);
    for (const path of ["app/link.py", "linked/secret.py"]) {
      const run = await fixes.apply({ kind: "format", commit: commits.links as string, paths: [path], allowed: ["app", "linked"] });
      assert.equal(run.record.result, "refused", path);
      assert.match(run.record.summary, /symlink/);
      assert.equal(run.commit, null);
    }
    assert.equal(await readFile(join(root, "outside", "secret.py"), "utf8"), "y  =  2\n");
    const kind = await fixes.apply({ kind: "exec" as never, commit: commits.base as string, paths: ["app/use.py"], allowed: ["app"] });
    assert.match(kind.record.summary, /no fix of kind/);
    const traversal = await fixes.apply({ kind: "format", commit: commits.base as string, paths: ["../x.py"], allowed: ["app"] });
    assert.equal(traversal.record.result, "refused");
    const edit = await fixes.apply({
      kind: "codemod",
      commit: commits.base as string,
      paths: ["app/use.py"],
      allowed: ["app"],
      edits: [{ kind: "rename", from: "os; import sys", to: "x" }],
    });
    assert.match(edit.record.summary, /malformed/);
  });

  test("a file already in shape gives an unchanged record and no commit", async () => {
    const run = await fixes.apply({ kind: "format", commit: commits.base as string, paths: ["core/dates.py"], allowed: ["core"] });
    assert.equal(run.record.result, "unchanged");
    assert.equal(run.commit, null);
  });

  test("a lockfile conflict is merged with uv.lock regenerated from the merged pyproject.toml", { skip: !HAS_UV }, async () => {
    const pyproject = (version: string) =>
      `[project]\nname = "demo"\nversion = "${version}"\nrequires-python = ">=3.11"\ndependencies = []\n`;
    const lock = (version: string) =>
      `version = 1\nrevision = 3\nrequires-python = ">=3.11"\n\n[[package]]\nname = "demo"\nversion = "${version}"\nsource = { virtual = "." }\n`;
    const start = await repo.commit(commits.base as string, { "pyproject.toml": pyproject("0.1.0"), "uv.lock": lock("0.1.0") });
    const ours = await repo.commit(start, { "pyproject.toml": pyproject("0.2.0"), "uv.lock": lock("0.2.0") });
    const theirs = await repo.commit(start, { "app/new.py": "z = 3\n", "uv.lock": `${lock("0.1.0").replace('"0.1.0"\nsource', '"0.1.0" # edited\nsource')}` });
    const run = await fixes.apply({ kind: "lockfile", commit: theirs, merge: ours, paths: [], allowed: ["app"] });
    assert.equal(run.record.result, "changed", run.record.summary);
    const merged = run.commit as string;
    assert.equal((await runGit(repo.path, ["rev-list", "--parents", "-n", "1", merged])).trim().split(" ").length, 3);
    const regenerated = await show(repo.path, merged, "uv.lock");
    assert.match(regenerated, /version = "0\.2\.0"/);
    assert.doesNotMatch(regenerated, /edited|<<<<<<</);
    assert.equal(await show(repo.path, merged, "app/new.py"), "z = 3\n");

    const conflict = await repo.commit(start, { "pyproject.toml": pyproject("0.3.0"), "uv.lock": lock("0.3.0") });
    const refused = await fixes.apply({ kind: "lockfile", commit: conflict, merge: ours, paths: [], allowed: ["app"] });
    assert.equal(refused.record.result, "refused");
    assert.match(refused.record.summary, /outside the lockfile: pyproject\.toml/);
  });

  test("penguin-bridge apply-fix prints the fix and the commit it made", async () => {
    let output = "";
    const io = { write: (text: string) => void (output += text), ask: async () => "" };
    const code = await runCli(
      ["apply-fix", "--repo", repo.path, "--kind", "codemod", "--commit", commits.base as string, "--path", "app/use.py", "--allow", "app",
        "--rename", "core.dates.start=core.dates.begin", "--python", PYTHON],
      io,
    );
    assert.equal(code, 0, output);
    assert.match(output, /apply_fix fix:python-codemod: changed, codemod: changed 1 file/);
    assert.match(output, /changed app\/use\.py\ncommit [0-9a-f]{40}\n/);
  });
});

async function hasUv(): Promise<boolean> {
  const outcome = await runProgram("uv", ["--version"], tmpdir(), {});
  return outcome.exitCode === 0;
}

describe("the phase C exit check on the helpful-fix fixture", () => {
  // Priya's feature renames start_of_day to start_of_local_day in shared/dates.py and updates its own
  // callers. Jun's weekly report and Sam's reminders still call start_of_day. Penguin resolves both
  // forks with the codemod generated from the contract diff, with no agent call.
  let root: string;
  let repo: string;
  let result: ResolveResult;
  const commits: Record<string, string> = {};

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-ladder-")));
    repo = join(root, "helpful-fix");
    await runProgram(PYTHON, [join(REPO_ROOT, "examples", "helpful-fix", "build.py"), repo], root, {});
    const git = (...args: string[]) => runGit(repo, [...ISOLATED, ...args]);
    await git("checkout", "--quiet", "-b", "priya-rename", "main");
    for (const path of ["shared/dates.py", "ingestion/batches.py", "shared/tests/test_dates.py"]) {
      const text = await readFile(join(repo, path), "utf8");
      await writeFile(join(repo, path), text.replaceAll("start_of_day", "start_of_local_day"));
    }
    await git("commit", "--quiet", "-am", "Rename start_of_day to start_of_local_day");
    await git("checkout", "--quiet", "main");
    for (const name of ["main", "priya-rename", "owner-jun-checkpoint", "owner-sam-checkpoint"]) {
      commits[name] = (await git("rev-parse", `${name}^{commit}`)).trim();
    }
    const scratch = join(root, "scratch");
    await mkdir(scratch);
    const ladder = new ResolutionLadder({
      repoPath: repo,
      combined: new CombinedRunner({
        repoPath: repo,
        runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
        impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
        checks: new BlockChecker({
          repoPath: repo,
          scratchDir: scratch,
          tools: checkTools({ ruff: RUFF, env: TEST_ENV, python: PYTHON }),
          dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
        }),
      }),
      fixes: new FixApplier({ repoPath: repo, ruff: RUFF, python: PYTHON, env: TEST_ENV, scratchDir: scratch }),
    });
    result = await ladder.resolve({
      checkpointSha: commits["priya-rename"] as string,
      baselineSha: commits.main as string,
      targets: ownerForkTargets({ jun: commits["owner-jun-checkpoint"] as string, sam: commits["owner-sam-checkpoint"] as string }),
      identity: "@priya/utc-day-start",
    });
  });

  after(() => rm(root, { recursive: true, force: true }));

  test("the renamed helper fails Jun's and Sam's merged trees, and each failure goes to step 3", () => {
    const first = result.record.decisions.filter((decision) => decision.round === 0);
    assert.deepEqual(first.map((decision) => `${decision.target} ${decision.check}`).sort(), ["jun tests", "jun typecheck", "sam tests", "sam typecheck"]);
    for (const decision of first) {
      assert.equal(decision.step, 3);
      assert.equal(decision.failure, "rename");
      assert.deepEqual(decision.actor, { kind: "penguin", id: "penguin" });
      assert.equal(decision.outcome, "accepted");
      assert.match(decision.reason, /shared\.dates\.start_of_day renamed to shared\.dates\.start_of_local_day/);
    }
  });

  test("one codemod commit lands in each affected fork, and the next round's checks all pass", async () => {
    const runs = result.record.toolRuns;
    assert.deepEqual(runs.map((run) => [run.tool, run.commandId, run.caller, run.result]), [
      ["apply_fix", "fix:python-codemod", "penguin", "changed"],
      ["apply_fix", "fix:python-codemod", "penguin", "changed"],
    ]);
    assert.deepEqual(runs.map((run) => run.changed?.paths).flat().sort(), ["analytics/weekly.py", "messaging/reminders.py"]);
    assert.equal(result.checkpointSha, commits["priya-rename"], "the originating fork needs no fix");
    for (const [owner, path] of [["jun", "analytics/weekly.py"], ["sam", "messaging/reminders.py"]] as const) {
      const fixed = result.latestCheckpoints[owner] as string;
      const before = owner === "jun" ? commits["owner-jun-checkpoint"] : commits["owner-sam-checkpoint"];
      assert.equal((await runGit(repo, ["rev-parse", `${fixed}^`])).trim(), before, `${owner}'s fix sits on ${owner}'s checkpoint`);
      const text = await show(repo, fixed, path);
      assert.match(text, /from shared\.dates import start_of_local_day\n/);
      assert.doesNotMatch(text, /\bstart_of_day\b/);
    }
    const last = result.reports.at(-1);
    assert.equal(result.record.rounds, 2);
    assert.deepEqual(
      (last?.checks ?? []).filter((check) => check.result === "failed" || check.result === "error"),
      [],
    );
    assert.ok((last?.checks ?? []).some((check) => check.target === "jun" && check.check === "tests" && check.result === "passed"));
  });

  test("no agent was called and every failure was resolved by Penguin", () => {
    assert.equal(result.record.agentCalls, 0);
    assert.equal(result.record.resolvedByPenguin, 4);
    assert.equal(result.record.routedToAgents, 0);
    assert.equal(result.record.routedToPeople, 0);
    const text = formatResolution(result);
    assert.match(text, /jun tests: step 3 rename -> penguin penguin \[fix:python-codemod\], accepted/);
    assert.match(text, /apply_fix-1 apply_fix fix:python-codemod by penguin: changed/);
    assert.match(text, /4 failures resolved by Penguin's fixes, 0 routed to agents, 0 to people; 0 agent calls; 2 rounds/);
  });

  test("on the original trigger with an unused import, lint goes to step 1 and the behaviour change to the owners' agents", async () => {
    // Priya's checkpoint with an unused import added, so lint fails on every merged tree.
    const git = (...args: string[]) => runGit(repo, [...ISOLATED, ...args]);
    await git("checkout", "--quiet", "-b", "priya-lint", "owner-priya-checkpoint");
    const dates = join(repo, "shared", "dates.py");
    await writeFile(dates, (await readFile(dates, "utf8")).replace("\nfrom datetime import", "\nimport os\nfrom datetime import"));
    await git("commit", "--quiet", "-am", "Add an unused import");
    await git("checkout", "--quiet", "main");
    const before = (await git("rev-parse", "priya-lint")).trim();
    let output = "";
    const io = { write: (text: string) => void (output += text), ask: async () => "" };
    const path = process.env.PATH;
    process.env.PATH = TEST_ENV.PATH;
    try {
      const code = await runCli(
        ["resolve", "--repo", repo, "--base", "main", "--head", "priya-lint", "--identity", "@priya/utc-day-start",
          "--checkpoint", "jun=owner-jun-checkpoint", "--checkpoint", "sam=owner-sam-checkpoint",
          "--python", PYTHON, "--ruff", RUFF, "--codemod-python", PYTHON, "--yes", "--write"],
        io,
      );
      assert.equal(code, 1, output);
    } finally {
      process.env.PATH = path;
    }
    for (const target of ["main", "jun", "sam"]) {
      assert.match(output, new RegExp(`${target} lint: step 1 lint -> penguin penguin \\[fix:ruff-autofix\\], accepted`));
    }
    assert.match(output, /apply_fix-1 apply_fix fix:ruff-autofix by penguin: changed, lint: changed 1 file/);
    assert.match(output, /changed shared\/dates\.py/);
    assert.match(output, /jun tests: step 5 behaviour -> owner-agent @jun\/steward, routed/);
    assert.match(output, /sam tests: step 5 behaviour -> owner-agent @sam\/steward, routed/);
    // --write moves Priya's branch to the autofix commit; the owners' checkpoints are tags and stay.
    const after = (await runGit(repo, ["rev-parse", "priya-lint"])).trim();
    assert.notEqual(after, before);
    assert.equal((await runGit(repo, ["rev-parse", `${after}^`])).trim(), before);
    assert.doesNotMatch(await show(repo, after, "shared/dates.py"), /^import os$/m);
    assert.match(output, /^moved refs\/heads\/priya-lint /m);
  });
});
