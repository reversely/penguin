// A merge plan's rewrite rules on the check runner (PRD 0.4 section 4.2 step 4): the facts run applies
// them with Penguin's codemod, lint autofix and formatter in each place, on main's files at the
// baseline and on each running feature's own work, and reports each changed file by its blob before
// and after. A rule the codemod refuses is reported and never applied.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runGit } from "@penguin/git-analysis";
import { checkFactsRequest, FixApplier, PlanFactsRunner, TestRunner } from "@penguin/local-bridge";
import { checkPlanFactsReport, type PlanFactsRequest, type RewriteRule } from "@penguin/protocol";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const RUFF = existsSync(join(VENV_BIN, "ruff")) ? join(VENV_BIN, "ruff") : "ruff";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const ISOLATED = ["-c", "user.name=Test", "-c", "user.email=test@penguin.invalid", "-c", "commit.gpgsign=false"];

const MONEY_BEFORE = "def display(amount: float) -> str:\n    return f'${amount:,.2f}'\n";
const MONEY_AFTER = [
  "from dataclasses import dataclass",
  "",
  "",
  "@dataclass(frozen=True)",
  "class Money:",
  "    amount_minor: int",
  "    currency: str",
  "",
  "    def display(self) -> str:",
  "        return str(self.amount_minor)",
  "",
].join("\n");
const CART = "from shared import money\n\n\ndef total_line(total):\n    return f\"Total {money.display(total)}\"\n";
const CART_AFTER = 'def total_line(total):\n    return f"Total {total.display()}"\n';

const DISPLAY: RewriteRule = {
  id: "display",
  contract: "shared/money/__init__.py::display",
  kind: "expression",
  pattern: "money.display($amount)",
  replacement: "$amount.display()",
  imports: [],
};
// `round(x * 100)` names no use of the contract: it would rewrite any such expression.
const CENTS: RewriteRule = { ...DISPLAY, id: "cents", pattern: "round($amount * 100)", replacement: "$amount.amount_minor" };

let root: string;
let repo: string;
const commits: Record<string, string> = {};

async function commit(start: string | null, files: Record<string, string>): Promise<string> {
  const git = (...args: string[]) => runGit(repo, [...ISOLATED, ...args]);
  if (start !== null) await git("checkout", "--quiet", "--detach", start);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), text);
  }
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "commit");
  return (await git("rev-parse", "HEAD")).trim();
}

const blobOf = async (text: string): Promise<string> => {
  const file = join(root, "blob.py");
  await writeFile(file, text);
  return (await runGit(repo, ["hash-object", "--", file])).trim();
};

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-rewrite-")));
  repo = join(root, "repo");
  await runGit(root, ["init", "--quiet", "-b", "main", repo]);
  commits.base = await commit(null, {
    "shared/__init__.py": "",
    "shared/money/__init__.py": MONEY_BEFORE,
    "checkout/__init__.py": "",
    "checkout/cart.py": CART,
    "checkout/plain.py": "def double(x):\n    return round(x * 100)\n",
  });
  commits.checkpoint = await commit(commits.base, { "shared/money/__init__.py": MONEY_AFTER });
  // A running feature's own work: a new module beside main's checkout code.
  commits.feature = await commit(commits.base, { "checkout/receipt.py": CART.replace("total_line", "receipt") });
});

function request(rules: readonly RewriteRule[]): PlanFactsRequest {
  return {
    runId: "1",
    feature: "money",
    fork: "feature-money",
    checkpoint: commits.checkpoint as string,
    baseline: commits.base as string,
    targets: [
      { id: "main", person: null, repo: "feature-money", sha: commits.base as string, scopes: [], commandIds: [] },
      { id: "receipts", person: "sam", repo: "feature-receipts", sha: commits.feature as string, scopes: ["checkout"], commandIds: [] },
    ],
    rewrites: {
      rules,
      places: [
        { target: "main", sha: commits.base as string, paths: ["checkout"], since: null },
        { target: "receipts", sha: commits.feature as string, paths: ["checkout"], since: commits.base as string },
      ],
    },
  };
}

function runner(fixes = true): PlanFactsRunner {
  return new PlanFactsRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: root, consent: () => true }),
    impact: async () => {
      throw new Error("no analysis in this test");
    },
    ...(fixes ? { fixes: new FixApplier({ repoPath: repo, ruff: RUFF, python: PYTHON, env: TEST_ENV, scratchDir: root }) } : {}),
  });
}

test("the facts run applies the plan's rules on main's files and on each feature's own work", async () => {
  const report = await runner().run(request([DISPLAY, CENTS]));
  assert.deepEqual(checkPlanFactsReport(JSON.parse(JSON.stringify(report))), []);
  assert.deepEqual(report.rewrites?.refused.map((each) => each.rule), ["cents"]);
  assert.match(report.rewrites?.refused[0]?.message ?? "", /would rewrite code outside its contract/u);
  const cartBefore = (await runGit(repo, ["rev-parse", `${commits.base}:checkout/cart.py`])).trim();
  const receiptBefore = (await runGit(repo, ["rev-parse", `${commits.feature}:checkout/receipt.py`])).trim();
  assert.deepEqual(report.rewrites?.places, [
    // Formatted after the rewrite: the unused import and the blank lines before the function go.
    { target: "main", files: [{ path: "checkout/cart.py", before: cartBefore, after: await blobOf(CART_AFTER), rules: ["display"] }], error: null },
    // Main's own checkout/cart.py in the feature's fork is the main place's, not the feature's.
    {
      target: "receipts",
      files: [{ path: "checkout/receipt.py", before: receiptBefore, after: await blobOf(CART_AFTER.replace("total_line", "receipt")), rules: ["display"] }],
      error: null,
    },
  ]);
  // checkout/plain.py, which `round(x * 100)` would have matched, is untouched: the rule was refused.
  assert.equal(report.rewrites?.places[0]?.files.some((file) => file.path === "checkout/plain.py"), false);
});

test("a runner without the codemod reports each place as not run, and a request without rules reports nothing", async () => {
  const without = await runner(false).run(request([DISPLAY]));
  assert.deepEqual(without.rewrites?.places.map((place) => place.error), ["this runner applies no rewrite rules", "this runner applies no rewrite rules"]);
  const none = await runner().run({ ...request([]), rewrites: null });
  assert.equal("rewrites" in none, false);
});

test("a rewrite place must be a target at its commit, under repository paths", () => {
  const good = request([DISPLAY]);
  checkFactsRequest(good);
  const places = good.rewrites?.places ?? [];
  const bad: PlanFactsRequest[] = [
    { ...good, rewrites: { rules: [DISPLAY], places: [{ ...(places[0] as (typeof places)[number]), target: "elsewhere" }] } },
    { ...good, rewrites: { rules: [DISPLAY], places: [{ ...(places[0] as (typeof places)[number]), sha: commits.feature as string }] } },
    { ...good, rewrites: { rules: [DISPLAY], places: [{ ...(places[0] as (typeof places)[number]), paths: ["../outside"] }] } },
    { ...good, rewrites: { rules: [DISPLAY], places: [{ ...(places[1] as (typeof places)[number]), since: "HEAD" }] } },
  ];
  for (const each of bad) assert.throws(() => checkFactsRequest(each), JSON.stringify(each.rewrites));
});
