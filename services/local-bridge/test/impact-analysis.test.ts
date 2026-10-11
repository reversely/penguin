import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkImpactReport, IMPACT_COMMAND_ID, selectAffectedForks } from "@penguin/protocol";
import {
  CombinedRunner,
  formatImpactReport,
  ImpactAnalysisError,
  pythonImpactAnalyzer,
  resolveAnalysisCommand,
  TestRunner,
  UnknownCommandError,
} from "@penguin/local-bridge";

import { runCli } from "../src/cli.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "helpful-fix");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

test("the impact command ID resolves to the bridge's own script and nothing else resolves", () => {
  const { script } = resolveAnalysisCommand(IMPACT_COMMAND_ID);
  assert.ok(script.startsWith(join(REPO_ROOT, "services", "local-bridge", "analysis")));
  assert.ok(existsSync(script));
  for (const id of ["analysis:other", "test:analytics", "analysis:../python-impact", "toString", "__proto__"]) {
    assert.throws(() => resolveAnalysisCommand(id), UnknownCommandError, id);
  }
});

describe("on the helpful-fix fixture", () => {
  let root: string;
  let repo: string;
  let pins: { branches: Record<string, string>; tags: Record<string, string> };
  let scopesOf: (owner: string) => string[];

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-impact-")));
    repo = join(root, "repo");
    await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
    pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8"));
    const scopeMap = JSON.parse(await readFile(join(repo, "penguin", "scopes.json"), "utf8"));
    scopesOf = (owner) =>
      scopeMap.scopes.filter((scope: { owner: string }) => scope.owner === owner).map((scope: { id: string }) => scope.id);
  });

  after(() => rm(root, { recursive: true, force: true }));

  const checkpoint = (owner: string) => pins.tags[`owner-${owner}-checkpoint`] as string;
  const analyzer = () => pythonImpactAnalyzer({ repoPath: repo, python: PYTHON });

  test("the report passes its schema and selects both forks that call the changed helper", async () => {
    const report = await analyzer()({
      base: pins.branches.main as string,
      head: checkpoint("priya"),
      forks: ["jun", "sam"].map((owner) => ({ id: owner, sha: checkpoint(owner), scopes: scopesOf(owner) })),
    });
    assert.deepEqual(checkImpactReport(report), []);
    assert.deepEqual(selectAffectedForks(report), ["jun", "sam"]);
    const [changed] = report.changes.filter((change) => change.change === "modified");
    assert.ok(changed !== undefined);
    const text = formatImpactReport(report, selectAffectedForks(report));
    assert.match(text, new RegExp(`modified function ${changed.symbol} \\(${changed.path}:${changed.line}\\)`));
    for (const fork of report.forks) {
      assert.ok(fork.uses.length > 0);
      for (const use of fork.uses) assert.ok(text.includes(`${use.path}:${use.line} ${use.kind} ${use.symbol}`));
    }
  });

  test("a combined run tests only the dependent owners the impact graph selects", async () => {
    const scratch = join(root, "bridge");
    await mkdir(scratch, { recursive: true });
    const report = await new CombinedRunner({
      repoPath: repo,
      runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: scratch, consent: () => true }),
      impact: analyzer(),
    }).run({
      checkpointSha: checkpoint("priya"),
      baselineSha: pins.branches.main as string,
      // One owner is still on main, where nothing in the owner's scope calls the changed helper.
      latestCheckpoints: { jun: checkpoint("jun"), sam: pins.branches.main as string },
    });
    assert.equal(report.impactError, null);
    assert.deepEqual(report.notAffected, scopesOf("sam"));
    assert.deepEqual(
      report.results.map((result) => [result.ownerId, result.status]),
      [["jun", "failed"]],
    );
    assert.deepEqual(report.impact?.forks.map((fork) => fork.id), ["jun", "sam"]);
  });

  test("a failed analysis runs every dependent scope's tests and says why", async () => {
    const report = await new CombinedRunner({
      repoPath: repo,
      runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "bridge"), consent: () => true }),
      impact: pythonImpactAnalyzer({ repoPath: repo, python: join(root, "no-such-python") }),
    }).run({
      checkpointSha: checkpoint("priya"),
      baselineSha: pins.branches.main as string,
      latestCheckpoints: { jun: checkpoint("jun"), sam: checkpoint("sam") },
    });
    assert.match(report.impactError ?? "", /could not start/);
    assert.deepEqual(report.notAffected, []);
    assert.equal(report.results.length, 2);
  });

  test("a commit missing from the repository is an analysis error", async () => {
    await assert.rejects(
      analyzer()({ base: "0".repeat(40), head: checkpoint("priya"), forks: [] }),
      (error: Error) => error instanceof ImpactAnalysisError && /git ls-tree failed/.test(error.message),
    );
  });

  test("penguin-bridge impact prints the findings and which forks run tests", async () => {
    let output = "";
    const io = { write: (text: string) => void (output += text), ask: async () => "" };
    const code = await runCli(
      [
        "impact",
        "--repo",
        repo,
        "--python",
        PYTHON,
        "--base",
        "main",
        "--head",
        "owner-priya-checkpoint",
        "--fork",
        `jun=owner-jun-checkpoint:${scopesOf("jun").join(",")}`,
        "--fork",
        `sam-on-main=main:${scopesOf("sam").join(",")}`,
      ],
      io,
    );
    assert.equal(code, 0);
    assert.match(output, /^python-impact \(analysis:python-impact\)/);
    assert.match(output, /fork jun@\w+ \([^)]+\): tests run/);
    assert.match(output, /fork sam-on-main@\w+ \([^)]+\): not affected/);
  });
});
