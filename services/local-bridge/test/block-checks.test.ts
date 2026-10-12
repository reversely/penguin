import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runGit } from "@penguin/git-analysis";
import { checkBlockCheck, checkDependencyReport, type BlockCheck } from "@penguin/protocol";
import {
  BlockChecker,
  checkTools,
  CombinedRunner,
  combinedRunEvent,
  formatBlockChecks,
  newFindings,
  parseFormatCheck,
  pythonDependencyAnalyzer,
  pythonImpactAnalyzer,
  resolveAnalysisCommand,
  runCli,
  runProgram,
  TestRunner,
  type CombinedRunReport,
  ownerForkTargets,
} from "@penguin/local-bridge";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

const ISOLATED = ["-c", "user.name=Test", "-c", "user.email=test@penguin.invalid", "-c", "commit.gpgsign=false"];
const DEPENDS_ON_CORE = [{ scope: "core", kind: "imports" }];
const SCOPES = {
  scopes: [
    { id: "core", name: "core", owner: "ana", paths: ["core/"], test_command: "exit 0", depends_on: [] },
    { id: "app", name: "app", owner: "bob", paths: ["app/"], test_command: "python -m pytest -q app", depends_on: DEPENDS_ON_CORE },
    { id: "web", name: "web", owner: "cy", paths: ["web/"], test_command: "exit 0", depends_on: DEPENDS_ON_CORE },
    { id: "docs", name: "docs", owner: "dan", paths: ["docs/"], test_command: "exit 0", depends_on: DEPENDS_ON_CORE },
  ],
};

/** A throwaway repository: each commit starts from a named commit and writes files over its tree. */
async function scratchRepo(root: string) {
  const path = join(root, "repo");
  await runGit(root, ["init", "--quiet", "-b", "main", path]);
  const git = (...args: string[]) => runGit(path, [...ISOLATED, ...args]);
  return {
    path,
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

const byCheck = (checks: readonly BlockCheck[], target: string) =>
  Object.fromEntries(checks.filter((check) => check.target === target).map((check) => [check.check, check.result]));

describe("the section 5.1 checks on a block", () => {
  let root: string;
  let scratch: string;
  let repo: string;
  const commits: Record<string, string> = {};

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-block-")));
    scratch = join(root, "bridge");
    await mkdir(scratch);
    const built = await scratchRepo(root);
    repo = built.path;
    commits.main = await built.commit(null, {
      "penguin/scopes.json": JSON.stringify(SCOPES),
      "core/requirements.txt": "wire==1.4.0\n",
      "core/__init__.py": "",
      "core/lib.py": "def total(items: list[int]) -> int:\n    return sum(items)\n",
      "app/__init__.py": "",
      "app/tests/__init__.py": "",
      "web/config.py": 'MODE = "plain"\n',
      "docs/readme.md": "Docs.\n",
    });
    // Ana's change: a new required parameter, a new module with a lint error that ruff also
    // reformats, and an edit to the line Cy's checkpoint edits too.
    commits.ana = await built.commit(commits.main, {
      "core/lib.py": "def total(items: list[int], currency: str) -> int:\n    return sum(items)\n",
      "core/extra.py": "import os\nx=1\n",
      "web/config.py": 'MODE = "ana"\n',
    });
    // Bob calls the changed function and tests the call; he also imports the pinned library.
    commits.bob = await built.commit(commits.main, {
      "app/client.py": "import wire\n\nCLIENT = wire\n",
      "app/report.py": "from core.lib import total\n\n\ndef report() -> int:\n    return total([1, 2])\n",
      "app/tests/test_report.py": "from app.report import report\n\n\ndef test_report():\n    assert report() == 3\n",
    });
    commits.cy = await built.commit(commits.main, { "web/config.py": 'MODE = "cy"\n' });
    commits.dan = await built.commit(commits.main, { "docs/guide.md": "Nothing here imports core.\n" });
    // A second change from main: only the pinned version moves.
    commits.bump = await built.commit(commits.main, { "core/requirements.txt": "wire==2.0.0\n" });
  });

  after(() => rm(root, { recursive: true, force: true }));

  const runner = (checks = true) =>
    new CombinedRunner({
      repoPath: repo,
      runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
      impact: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
      checks: checks
        ? new BlockChecker({
            repoPath: repo,
            scratchDir: scratch,
            tools: checkTools({ ruff: RUFF, env: TEST_ENV, python: PYTHON }),
            dependencies: pythonDependencyAnalyzer({ repoPath: repo, python: PYTHON, env: TEST_ENV }),
          })
        : undefined,
    });

  let report: CombinedRunReport;

  test("each failure gives its own failing check, and only the affected fork runs tests", async (t) => {
    report = await runner().run({
      checkpointSha: commits.ana as string,
      baselineSha: commits.main as string,
      targets: ownerForkTargets({ bob: commits.bob as string, cy: commits.cy as string, dan: commits.dan as string }),
    });
    t.diagnostic(formatBlockChecks(report.checks ?? []));
    const checks = report.checks ?? [];
    for (const check of checks) assert.deepEqual(checkBlockCheck(check), [], `${check.target} ${check.check}`);

    // Bob's checkpoint calls the changed function: a type error and a failing test.
    assert.deepEqual(byCheck(checks, "bob"), {
      overlap: "passed",
      merge: "passed",
      dependencies: "passed",
      lint: "failed",
      format: "failed",
      typecheck: "failed",
      tests: "failed",
    });
    const bobType = checks.find((check) => check.target === "bob" && check.check === "typecheck") as BlockCheck;
    assert.deepEqual(
      bobType.findings.map((item) => [item.path, item.line, item.code]),
      [["app/report.py", 5, "reportCallIssue"]],
    );
    assert.match(bobType.findings[0]?.message ?? "", /currency/);
    assert.equal(bobType.tool.version, "1.1.414");
    const bobTests = checks.find((check) => check.target === "bob" && check.check === "tests") as BlockCheck;
    assert.deepEqual(bobTests.findings, [
      { path: "app/tests/test_report.py", line: null, code: null, message: "fails: test_report" },
    ]);
    assert.equal(bobTests.fingerprint?.commandId, "test:app");
    const lint = checks.find((check) => check.target === "bob" && check.check === "lint") as BlockCheck;
    assert.ok(lint.findings.some((item) => item.path === "core/extra.py" && item.code === "F401"));
    const format = checks.find((check) => check.target === "bob" && check.check === "format") as BlockCheck;
    assert.deepEqual(format.findings.map((item) => item.path), ["core/extra.py"]);
    assert.deepEqual(format.input.paths, ["core/extra.py", "core/lib.py", "web/config.py"]);

    // Cy's checkpoint edits the same line: the overlap and the merge fail and nothing runs on it.
    assert.deepEqual(byCheck(checks, "cy"), {
      overlap: "failed",
      merge: "failed",
      dependencies: "passed",
      lint: "not-run",
      format: "not-run",
      typecheck: "not-run",
      tests: "not-run",
    });
    const overlap = checks.find((check) => check.target === "cy" && check.check === "overlap") as BlockCheck;
    assert.deepEqual(overlap.findings.map((item) => [item.path, item.line]), [["web/config.py", 1]]);

    // Dan's checkpoint uses nothing the change touches: no type check, no tests, run complete.
    assert.equal(byCheck(checks, "dan").typecheck, "not-affected");
    assert.equal(byCheck(checks, "dan").tests, "not-affected");
    assert.deepEqual(
      report.results.map((result) => [result.ownerId, result.status]),
      [
        ["bob", "failed"],
        ["dan", "not-affected"],
        ["cy", "conflict"],
      ],
    );
    assert.deepEqual(report.notAffected, ["docs"]);

    // Main gets the same lint, format and type facts; with no caller on main the type check passes.
    assert.equal(byCheck(checks, "main").typecheck, "passed");
    assert.equal(byCheck(checks, "main").lint, "failed");
    assert.deepEqual(await readdir(scratch), []);
  });

  test("the event carries the checks and the not-affected result, never a log", () => {
    const event = combinedRunEvent(report, "ana");
    assert.equal(event.checks?.length, report.checks?.length);
    assert.deepEqual(
      event.results.find((result) => result.ownerId === "dan"),
      {
        target: "dan",
        ownerId: "dan",
        scopeId: "docs",
        commandId: "test:docs",
        status: "not-affected",
        ownerCheckpoint: commits.dan,
        fingerprint: null,
        failingTests: [],
      },
    );
    const text = JSON.stringify(event);
    assert.equal(text.includes("Found 1 error"), false);
    for (const check of event.checks ?? []) {
      if (check.logRef !== null) assert.ok(report.checkLogs?.has(check.logRef) || check.check === "tests");
    }
  });

  test("a version change of a library the fork imports is a passing fact naming each place it is imported", async () => {
    const bumped = await runner().run({
      checkpointSha: commits.bump as string,
      baselineSha: commits.main as string,
      targets: ownerForkTargets({ bob: commits.bob as string, dan: commits.dan as string }),
    });
    assert.deepEqual(checkDependencyReport(bumped.dependencies), []);
    const checks = bumped.checks ?? [];
    const bob = checks.find((check) => check.target === "bob" && check.check === "dependencies") as BlockCheck;
    assert.equal(bob.result, "passed");
    assert.deepEqual(
      bob.findings.map((item) => [item.path, item.line, item.message]),
      [
        ["core/requirements.txt", null, "wire ==1.4.0 -> ==2.0.0"],
        ["app/client.py", 1, "imports wire (wire)"],
      ],
    );
    assert.equal(byCheck(checks, "dan").dependencies, "passed");
    // A changed requirements file is not a Python module, so the impact graph selects every fork.
    assert.deepEqual(bumped.notAffected, []);
  });

  test("without a block checker the run reports no checks", async () => {
    const plain = await runner(false).run({
      checkpointSha: commits.ana as string,
      baselineSha: commits.main as string,
      targets: ownerForkTargets({ dan: commits.dan as string }),
    });
    assert.equal(plain.checks, undefined);
    assert.deepEqual(
      plain.results.map((result) => [result.ownerId, result.status]),
      [
        ["bob", "no-checkpoint"],
        ["dan", "not-affected"],
        ["cy", "no-checkpoint"],
      ],
    );
    assert.equal(combinedRunEvent(plain, "ana").checks, undefined);
  });
});

describe("penguin-bridge check on the fixtures", () => {
  let root: string;
  const hostPath = process.env.PATH;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-check-cli-")));
    // The fixtures' test commands run `python -m pytest` from PATH, as a team's runner would; the
    // uv environment's Python has pytest on every host, where a host's own `python` may not exist.
    process.env.PATH = TEST_ENV.PATH;
  });

  after(async () => {
    process.env.PATH = hostPath;
    await rm(root, { recursive: true, force: true });
  });

  async function check(fixture: string, head: string, checkpoints: string[]): Promise<string> {
    const repo = join(root, fixture);
    await runProgram(PYTHON, [join(REPO_ROOT, "examples", fixture, "build.py"), repo], root, {});
    let output = "";
    const io = { write: (text: string) => void (output += text), ask: async () => "" };
    const args = ["check", "--repo", repo, "--python", PYTHON, "--ruff", RUFF, "--base", "main", "--head", head, "--yes"];
    await runCli([...args, ...checkpoints.flatMap((entry) => ["--checkpoint", entry])], io);
    return output;
  }

  test("the dependency bump passes the dependency check and names where Ana's payments import the client; Ana's test fails", async () => {
    const output = await check("dependency-bump", "owner-hugo-checkpoint", ["ana=owner-ana-checkpoint"]);
    assert.match(output, /onto ana@\w+ \(merged \w+\)\n(?:.*\n)*? {2}dependencies passed: shared\.http changed version; ana imports it in 4 places/);
    assert.match(output, /shared\/http\.py vendored shared\.http 1\.4\.0 -> 2\.0\.0, from vendor\.wire_v1 to vendor\.wire_v2/);
    assert.match(output, /payments\/webhooks\.py:4 imports shared\.http/);
    // The bump alone fails nothing: the one failure is the affected test the version change breaks.
    assert.deepEqual([...output.matchAll(/^ {2}(\w+) (?:failed|error):/gmu)].map((match) => match[1]), ["tests"]);
    assert.match(output, /test_webhooks\.py fails: test_timed_out_charge_is_charged_once/);
  });

  test("identity unification: pyright's finding already on Sam's checkpoint is not blamed on the merge", async () => {
    const output = await check("identity-unification", "owner-priya-checkpoint", [
      "jun=owner-jun-checkpoint",
      "sam=owner-sam-checkpoint",
    ]);
    assert.match(output, /typecheck passed: no new type errors \(1 already on sam\) \[pyright 1\.1\.414, check:pyright/);
    assert.match(output, /onto sam@\w+ \(merged \w+\)\n {2}overlap passed: no file changed in both/);
  });
});

describe("the check tools", () => {
  let dir: string;

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "penguin-tools-")));
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test("ruff reads hostile file names as paths, never as options or shell text", async () => {
    const names = ["-x.py", "$(touch pwned).py", "a b;touch pwned2.py", "--fix.py"];
    for (const name of names) await writeFile(join(dir, name), "import os\n");
    const run = await checkTools({ ruff: RUFF, env: TEST_ENV }).lint(dir, names);
    assert.equal(run.error, null, run.log);
    assert.deepEqual(run.findings.map((item) => item.path).sort(), [...names].sort());
    assert.ok(run.findings.every((item) => item.code === "F401"));
    assert.equal(existsSync(join(dir, "pwned")), false);
    assert.equal(existsSync(join(dir, "pwned2.py")), false);
    // --fix.py was linted, not read as --fix: the file is unchanged.
    assert.equal((await runProgram("cat", ["--", "--fix.py"], dir, {})).stdout, "import os\n");
  });

  test("a tool runs without Penguin credentials and is stopped at its timeout", async () => {
    const env = { ...process.env, PENGUIN_BRIDGE_TOKEN: "secret", ARTIFACTS_TOKEN: "secret", CLOUDFLARE_API_TOKEN: "secret" };
    const printed = await runProgram(process.execPath, ["-e", "console.log(Object.keys(process.env).join(' '))"], dir, { env });
    for (const name of ["PENGUIN_BRIDGE_TOKEN", "ARTIFACTS_TOKEN", "CLOUDFLARE_API_TOKEN"]) {
      assert.equal(printed.stdout.split(" ").includes(name), false, name);
    }
    const started = performance.now();
    const hung = await runProgram(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], dir, { timeoutMs: 300 });
    assert.equal(hung.stopped, "stopped after 300 ms");
    assert.ok(performance.now() - started < 10_000);
    const missing = await checkTools({ ruff: join(dir, "no-such-ruff") }).lint(dir, ["-x.py"]);
    assert.match(missing.error ?? "", /could not start/);
  });

  test("pyright resolves imports through the configured interpreter, not the host's", async () => {
    const tree = join(dir, "typed");
    await mkdir(tree);
    await writeFile(join(tree, "test_a.py"), "import pytest\n\n\ndef test_a() -> None:\n    pytest.skip()\n");
    // An interpreter with no packages installed: pyright then cannot find pytest.
    const bare = join(dir, "bare");
    await runProgram(PYTHON, ["-m", "venv", "--without-pip", bare], dir, {});
    const barePython = join(bare, "bin", "python");
    const missing = (run: { findings: readonly { code: string | null }[] }) =>
      run.findings.filter((item) => item.code === "reportMissingImports").length;

    const pinned = await checkTools({ env: TEST_ENV, python: PYTHON }).typecheck(tree);
    assert.equal(pinned.error, null, pinned.log);
    assert.equal(pinned.python, PYTHON);
    assert.ok(pinned.log.startsWith(`python: ${PYTHON}\n`));
    assert.equal(missing(pinned), 0, pinned.log);

    const unpinned = await checkTools({ env: TEST_ENV, python: barePython }).typecheck(tree);
    assert.equal(unpinned.python, barePython);
    assert.equal(missing(unpinned), 1, unpinned.log);
  });

  test("only findings the target's tree lacks count, matched without the line", () => {
    const finding = (path: string, line: number, code: string) => ({ path, line, code, message: code });
    const merged = [finding("a.py", 3, "F401"), finding("a.py", 9, "F401"), finding("b.py", 1, "E711")];
    const target = [finding("a.py", 1, "F401")];
    assert.deepEqual(newFindings(merged, target), [finding("a.py", 9, "F401"), finding("b.py", 1, "E711")]);
  });

  test("the dependency command ID resolves to the bridge's own script", () => {
    const { script } = resolveAnalysisCommand("analysis:python-dependencies");
    assert.ok(script.startsWith(join(REPO_ROOT, "services", "local-bridge", "analysis")));
    assert.ok(existsSync(script));
  });
});

test("the format check reads both ruff output styles", () => {
  const older = "Would reformat: core/extra.py\n1 file would be reformatted\n";
  const newer = "unformatted: File would be reformatted\n --> core/extra.py:2:1\n  |\n1 | import os\n  - x=1\n\n1 file would be reformatted\n";
  assert.deepStrictEqual(parseFormatCheck(older), [{ path: "core/extra.py", line: null }]);
  assert.deepStrictEqual(parseFormatCheck(newer), [{ path: "core/extra.py", line: 2 }]);
  assert.deepStrictEqual(parseFormatCheck("1 file already formatted\n"), []);
});
