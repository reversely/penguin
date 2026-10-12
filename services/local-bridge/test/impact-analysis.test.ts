import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkImpactReport, IMPACT_COMMAND_ID, parseToolResult, selectAffectedForks, type AgentToolResult } from "@penguin/protocol";
import {
  CombinedRunner,
  formatImpactReport,
  ImpactAnalysisError,
  pythonImpactAnalyzer,
  resolveAnalysisCommand,
  TestRunner,
  toolPass,
  UnknownCommandError,
  ownerForkTargets,
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
      scopeMap.scopes.filter((scope: { dri: string }) => scope.dri === owner).map((scope: { id: string }) => scope.id);
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

  test("Penguin's edges request reads main's scope dependencies through the analysis and reports scope ids and counts", async () => {
    const main = pins.branches.main as string;
    const reported: AgentToolResult[] = [];
    const claim = { runId: 9, tool: "impact", feature: "utc-day", fork: "feature-utc-day", forks: [], base: main, checkpoint: main, input: { search: "edges", promotion: main } };
    const pass = await toolPass({
      claim: async () => [claim] as never,
      report: async (_, result) => {
        reported.push(result);
        return { status: "recorded" } as never;
      },
      fetchFork: async () => {},
      impact: analyzer(),
      combined: {} as never,
      fixes: {} as never,
      repoPath: repo,
    });
    assert.equal(pass.runs[0]?.error, null);
    const [result] = reported;
    const parsed = parseToolResult(result);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("; "));
    const edges = result?.impact?.scopeEdges ?? [];
    // Analytics imports ingestion's events on main; ingestion imports the shared date helpers.
    // Messaging declares ingestion in depends_on, but its code on main uses none of it: the declared
    // edge is absent from the code.
    assert.deepEqual(
      edges.map(({ consumer, provider }) => [consumer, provider]),
      [
        ["analytics", "ingestion"],
        ["ingestion", "shared-dates"],
      ],
    );
    assert.ok((edges[0]?.imports ?? 0) > 0);
    assert.match(result?.summary ?? "", /^\d+ scope dependenc(y|ies) read from main at [0-9a-f]{12}$/u);
    // Main's own uses are no change: the report lists no changed symbol and no use site.
    assert.deepEqual([result?.impact?.changes, result?.impact?.headUses], [[], []]);
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
      // One owner is still on main, where nothing in the owner's scope calls the changed helper. Priya
      // is DRI for ingestion, which reads shared-dates, so her own checkpoint is its target.
      targets: ownerForkTargets({ jun: checkpoint("jun"), priya: checkpoint("priya"), sam: pins.branches.main as string }),
    });
    assert.equal(report.impactError, null);
    assert.deepEqual(report.notAffected, scopesOf("sam"));
    // Sam's run still completes: merged, not tested, reported as not affected.
    assert.deepEqual(
      report.results.map((result) => [result.ownerId, result.status]),
      [
        ["jun", "failed"],
        ["priya", "passed"],
        ["sam", "not-affected"],
      ],
    );
    assert.deepEqual(report.impact?.forks.map((fork) => fork.id), ["jun", "priya", "sam"]);
  });

  test("a failed analysis runs every dependent scope's tests and says why", async () => {
    const report = await new CombinedRunner({
      repoPath: repo,
      runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "bridge"), consent: () => true }),
      impact: pythonImpactAnalyzer({ repoPath: repo, python: join(root, "no-such-python") }),
    }).run({
      checkpointSha: checkpoint("priya"),
      baselineSha: pins.branches.main as string,
      targets: ownerForkTargets({ jun: checkpoint("jun"), priya: checkpoint("priya"), sam: checkpoint("sam") }),
    });
    assert.match(report.impactError ?? "", /could not start/);
    assert.deepEqual(report.notAffected, []);
    assert.equal(report.results.length, 3);
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
