// A running feature's places in a merge plan come from its own changes (#110): callers in files it
// changed since its merge base with main. A caller in a file it carries unchanged from main is main's,
// and the feature takes main's fix with main. Its breaks follow the same rule (#111): a failing test in
// a file it carries unchanged is main's break, unless its traceback passes through the feature's own
// callers. The repository is built here; the check runner's facts run uses the real impact analysis
// and pytest, and propose_plan reads every part through the binding's reads.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PlanFactsRunner, pythonImpactAnalyzer, TestRunner } from "@penguin/local-bridge";
import { checkPlanFactsReport, type PlanFactsReport } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { GitRepo } from "../../services/project-agent/test/issues-repo.ts";
import { PlanProject } from "../../services/project-agent/test/plan-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";

const SCOPES = {
  scopes: [
    { id: "money", name: "Money", owner: "ines", paths: ["shared/money/"], test_command: "true", contracts: ["shared/money/api.py::price"], depends_on: [] },
    { id: "orders", name: "Orders", owner: "omar", paths: ["orders/"], test_command: "true", depends_on: [{ scope: "money", kind: "imports" }] },
  ],
};
const CALLER = "from shared.money.api import price\n\nrow = price(order)\n";
const FIXED = "from shared.money.api import price\n\nrow = price(order) / 100\n";

const scratch: string[] = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

/**
 * Main with one caller of `price` in orders, the money checkpoint that changes `price`, and three
 * running orders features started from main: one that changes no caller, one that adds a caller and
 * one that edits the file holding main's caller. Each feature's later commit is its proposed fix.
 */
function buildRepo() {
  const repo = new GitRepo();
  const main = repo.commit(
    {
      "penguin/scopes.json": JSON.stringify(SCOPES),
      "shared/__init__.py": "",
      "shared/money/__init__.py": "",
      "shared/money/api.py": "def price(item):\n    return item.amount\n",
      "orders/__init__.py": "",
      "orders/export.py": CALLER,
    },
    "Base",
  );
  const branch = (name: string, files: Record<string, string>, fix: Record<string, string>) => {
    repo.git("checkout", "--quiet", "-b", name, main);
    const head = repo.commit(files, name);
    const fixed = repo.commit(fix, `${name} fix`);
    return { head, patch: `${repo.git("diff", head, fixed, "--", "orders/")}\n` };
  };
  const forks = {
    "carried-only": branch("carried-only", { "orders/notes.py": "NOTE = 1\n" }, { "orders/export.py": FIXED }),
    "adds-a-caller": branch("adds-a-caller", { "orders/report.py": CALLER }, { "orders/report.py": FIXED }),
    "edits-a-caller-file": branch("edits-a-caller-file", { "orders/export.py": `${CALLER}DONE = True\n` }, { "orders/export.py": `${FIXED}DONE = True\n` }),
  };
  repo.git("checkout", "--quiet", "-b", "money", main);
  const checkpoint = repo.commit({ "shared/money/api.py": "def price(item):\n    return item.amount_minor\n" }, "Store money in minor units");
  const fixOrders = repo.commit({ "orders/export.py": FIXED }, "Fix orders on main");
  return { repo, main, checkpoint, fixOrders, forks };
}

test("a running feature is a place only for callers in files it changed since its merge base with main", async () => {
  const { repo, main, checkpoint, fixOrders, forks } = buildRepo();
  const project = new PlanProject(parseScopeMap(SCOPES), repo.dir);
  await project.open("money", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
  await project.checkpoint("money", checkpoint, main, "@ines/money");
  for (const [id, fork] of Object.entries(forks)) {
    await project.open(id, "omar", { scopes: ["orders"] });
    await project.checkpoint(id, fork.head, main, `@omar/${id}`);
  }
  const featurePart = (id: keyof typeof forks) => ({ place: { feature: id }, patch: { base: forks[id].head, diff: forks[id].patch } });
  const parts = [{ place: { scope: "orders" }, diff: { commit: fixOrders } }, featurePart("carried-only"), featurePart("adds-a-caller"), featurePart("edits-a-caller-file")];

  assert.equal((await project.propose("ines", "s-ines", "money", parts)).status, "missing");
  const [request] = project.facts.pending();
  assert.ok(request);
  const scratchDir = await realpath(await mkdtemp(join(tmpdir(), "penguin-plan-own-")));
  scratch.push(scratchDir);
  const runner = new PlanFactsRunner({
    repoPath: repo.dir,
    runner: new TestRunner({ repoPath: repo.dir, env: { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) }, scratchDir, consent: () => true }),
    impact: pythonImpactAnalyzer({ repoPath: repo.dir, python: PYTHON }),
  });
  const report = JSON.parse(JSON.stringify(await runner.run(request))) as PlanFactsReport;
  assert.deepEqual(checkPlanFactsReport(report), []);
  // Each fork's uses lie in its own changes; main's caller it carries is counted, not listed.
  assert.deepEqual(
    report.impact?.forks.map((fork) => [fork.id, fork.mergeBase, [...new Set(fork.uses.map((use) => use.path))], fork.carried]),
    [
      ["adds-a-caller", main, ["orders/report.py"], 2],
      ["carried-only", main, [], 2],
      ["edits-a-caller-file", main, ["orders/export.py"], 0],
    ],
  );
  assert.deepEqual(
    report.results.filter((result) => result.status === "not-affected").map((result) => result.target),
    ["carried-only"],
  );
  assert.equal(project.facts.record(request.runId, "runner-1", report).status, "recorded");

  // A part for the feature with only carried callers is refused with the reason.
  const refused = await project.propose("ines", "s-ines", "money", parts);
  assert.equal(refused.status, "missing");
  if (refused.status !== "missing") return;
  assert.deepEqual(
    refused.missing.map((item) => [item.code, item.part]),
    [["not_affected", 1]],
  );
  assert.match(refused.missing[0]?.message ?? "", /carried-only is not affected: its own changes .* call nothing in the contract diff; its 2 callers sit in files it carries unchanged from main/u);

  const stored = await project.propose("ines", "s-ines", "money", parts.filter((_, index) => index !== 1));
  assert.equal(stored.status, "stored", JSON.stringify(stored).slice(0, 2_000));
  if (stored.status !== "stored") return;
  assert.deepEqual(
    stored.plan.parts.map((part) => [part.place, [...new Set(part.callers.map((use) => use.path))]]),
    [
      [{ kind: "scope", scope: "orders" }, ["orders/export.py"]],
      [{ kind: "feature", feature: "adds-a-caller" }, ["orders/report.py"]],
      [{ kind: "feature", feature: "edits-a-caller-file" }, ["orders/export.py"]],
    ],
  );
  const affected = stored.plan.facts.sources.find((source) => source.fact === "affected_features");
  assert.match(affected?.detail ?? "", /^3 running features checked, 2 affected\. carried-only is not affected: /u);
});

const PYTEST_SCOPES = {
  scopes: [
    { id: "money", name: "Money", owner: "ines", paths: ["shared/money/"], test_command: "true", contracts: ["shared/money/api.py::price"], depends_on: [] },
    { id: "orders", name: "Orders", owner: "omar", paths: ["orders/"], test_command: "python -m pytest -p no:cacheprovider orders", depends_on: [{ scope: "money", kind: "imports" }] },
  ],
};
const caller = (fn: string) => `from shared.money.api import price\n\n\ndef ${fn}(order):\n    return price(order)\n`;
const callerTest = (module: string, fn: string, field: string) =>
  `from types import SimpleNamespace\n\nfrom orders.${module} import ${fn}\n\n\ndef test_${fn}_is_the_price():\n    """It holds the order's price."""\n    assert ${fn}(SimpleNamespace(${field}=5)) == 5\n`;

/**
 * Main with a caller of `price` in orders and its test, the money checkpoint that breaks both, and two
 * running orders features started from main: one that adds its own caller and test and carries main's
 * caller and test unchanged, and one that edits main's caller, so main's test fails through its code.
 */
function buildPytestRepo() {
  const repo = new GitRepo();
  const main = repo.commit(
    {
      "penguin/scopes.json": JSON.stringify(PYTEST_SCOPES),
      "shared/__init__.py": "",
      "shared/money/__init__.py": "",
      "shared/money/api.py": "def price(item):\n    return item.amount\n",
      "orders/__init__.py": "",
      "orders/export.py": caller("row"),
      "orders/tests/__init__.py": "",
      "orders/tests/test_export.py": callerTest("export", "row", "amount"),
    },
    "Base",
  );
  const branch = (name: string, files: Record<string, string>, fix: Record<string, string>) => {
    repo.git("checkout", "--quiet", "-b", name, main);
    const head = repo.commit(files, name);
    const fixed = repo.commit(fix, `${name} fix`);
    return { head, patch: `${repo.git("diff", head, fixed, "--", "orders/")}\n` };
  };
  const forks = {
    "adds-a-caller": branch(
      "adds-a-caller",
      { "orders/report.py": caller("line"), "orders/tests/test_report.py": callerTest("report", "line", "amount") },
      { "orders/tests/test_report.py": callerTest("report", "line", "amount_minor") },
    ),
    "edits-main-caller": branch(
      "edits-main-caller",
      { "orders/export.py": `${caller("row")}\n\nDONE = True\n` },
      { "orders/export.py": `${caller("row")}\n\nDONE = False\n` },
    ),
  };
  repo.git("checkout", "--quiet", "-b", "money", main);
  const checkpoint = repo.commit({ "shared/money/api.py": "def price(item):\n    return item.amount_minor\n" }, "Store money in minor units");
  const fixOrders = repo.commit({ "orders/tests/test_export.py": callerTest("export", "row", "amount_minor") }, "Fix orders on main");
  return { repo, main, checkpoint, fixOrders, forks };
}

test("a running feature's breaks are its own failing tests; a failing test it carries from main is main's", async () => {
  const { repo, main, checkpoint, fixOrders, forks } = buildPytestRepo();
  const project = new PlanProject(parseScopeMap(PYTEST_SCOPES), repo.dir);
  await project.open("money", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
  await project.checkpoint("money", checkpoint, main, "@ines/money");
  for (const [id, fork] of Object.entries(forks)) {
    await project.open(id, "omar", { scopes: ["orders"] });
    await project.checkpoint(id, fork.head, main, `@omar/${id}`);
  }
  const featurePart = (id: keyof typeof forks) => ({ place: { feature: id }, patch: { base: forks[id].head, diff: forks[id].patch } });
  const parts = [{ place: { scope: "orders" }, diff: { commit: fixOrders } }, featurePart("adds-a-caller"), featurePart("edits-main-caller")];

  assert.equal((await project.propose("ines", "s-ines", "money", parts)).status, "missing");
  const [request] = project.facts.pending();
  assert.ok(request);
  const scratchDir = await realpath(await mkdtemp(join(tmpdir(), "penguin-plan-breaks-")));
  scratch.push(scratchDir);
  const runner = new PlanFactsRunner({
    repoPath: repo.dir,
    runner: new TestRunner({ repoPath: repo.dir, env: { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) }, scratchDir, consent: () => true }),
    impact: pythonImpactAnalyzer({ repoPath: repo.dir, python: PYTHON }),
  });
  const report = JSON.parse(JSON.stringify(await runner.run(request))) as PlanFactsReport;
  assert.deepEqual(checkPlanFactsReport(report), []);
  // Main's test fails on every merged tree. The feature that carries main's caller unchanged leaves
  // it to main; on the feature that edits main's caller its traceback passes through the feature's code.
  const name = (file: string, fn: string) => `orders/tests/${file}::test_${fn}_is_the_price`;
  assert.deepEqual(
    report.results.filter((result) => result.commandId === "test:orders").map((result) => [result.target, result.breaks.map((each) => each.nodeId), result.carried]),
    [
      ["main", [name("test_export.py", "row")], undefined],
      ["adds-a-caller", [name("test_report.py", "line")], 1],
      ["edits-main-caller", [name("test_export.py", "row")], 0],
    ],
  );
  assert.equal(project.facts.record(request.runId, "runner-1", report).status, "recorded");

  const stored = await project.propose("ines", "s-ines", "money", parts);
  assert.equal(stored.status, "stored", JSON.stringify(stored).slice(0, 2_000));
  if (stored.status !== "stored") return;
  assert.deepEqual(
    stored.plan.parts.map((part) => [part.place, part.breaks.map((each) => each.nodeId)]),
    [
      [{ kind: "scope", scope: "orders" }, [name("test_export.py", "row")]],
      [{ kind: "feature", feature: "adds-a-caller" }, [name("test_report.py", "line")]],
      [{ kind: "feature", feature: "edits-main-caller" }, [name("test_export.py", "row")]],
    ],
  );
  const breaks = stored.plan.facts.sources.find((source) => source.fact === "breaks");
  assert.match(breaks?.detail ?? "", /^3 failing tests on 3 merged trees; 1 more fail on running features in files they carry unchanged from main/u);
});
