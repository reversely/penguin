// The review harness on the identity-unification fixture (#95, PRD 0.4 section 6). Jun's analytics
// scope declares the invariant "patrons who log in on one library tablet stay separate people" and
// records examples for its public function daily_active_users. The test commits that declaration to
// main itself: the fixture's own invariants file belongs to #98. Each fork is one of Priya's
// commits merged onto that main, so the diff from main to the fork is Priya's change alone.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { formatSideBySide, SIDE_BY_SIDE_COMMAND_ID } from "@penguin/protocol";
import {
  formatReviewResult,
  pythonImpactAnalyzer,
  resolveAnalysisCommand,
  runReview,
  runSideBySide,
  SideBySideError,
  type ReviewOptions,
} from "@penguin/local-bridge";

import { runCli } from "../src/cli.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";

const ANALYTICS = "analytics";
const DAU = "analytics/models.py::daily_active_users";
const IDENTITY_MAP = "ingestion/identity_map.py::IdentityMap";
const TABLET = "tablet-patrons-separate";
const ORDER = "days-in-date-order";
const EXAMPLES_FILE = "analytics/examples/daily_active_users.json";

const login = (ts: number, user: string, device: string) => ({
  source: "mobile",
  type: "login",
  day: "2026-01-05",
  ts,
  user_id: user,
  device_id: device,
});

/** daily_active_users over `events`, with the identity map built from the same events. */
const dauArgs = (events: readonly object[]) => ({
  events,
  identity_map: { $call: `${IDENTITY_MAP}.from_events`, args: { events } },
});

const INVARIANTS = {
  invariants: [
    { id: TABLET, scope: ANALYTICS, statement: "Patrons who log in on one library tablet stay separate people", protected: true },
    { id: ORDER, scope: ANALYTICS, statement: "Daily active users are listed by day in date order", protected: false },
  ],
  examples: [{ scope: ANALYTICS, file: EXAMPLES_FILE, invariants: [TABLET] }],
};

const EXAMPLES = {
  contract: DAU,
  cases: [
    { name: "patrons on their own devices", args: dauArgs([login(1, "u1", "d1"), login(2, "u2", "d2")]) },
    {
      name: "three patrons on one library tablet",
      args: dauArgs([login(1, "u1", "tablet-7"), login(2, "u2", "tablet-7"), login(3, "u3", "tablet-7")]),
    },
  ],
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Penguin Test",
  GIT_AUTHOR_EMAIL: "test@penguin.invalid",
  GIT_COMMITTER_NAME: "Penguin Test",
  GIT_COMMITTER_EMAIL: "test@penguin.invalid",
};

describe("the review harness on identity unification", () => {
  let root: string;
  let repo: string;
  let main: string;
  /** Priya's first checkpoint, her limit of five and her limit of one, each merged onto main. */
  let forks: { checkpoint: string; limitFive: string; limitOne: string };

  const git = (...args: string[]) => runGit(repo, args, { env: GIT_ENV }).then((out) => out.trim());
  const options = (extra: Partial<ReviewOptions> = {}): ReviewOptions => ({
    repoPath: repo,
    python: PYTHON,
    scratchDir: join(root, "scratch"),
    ...extra,
  });

  async function mergedOntoMain(revision: string): Promise<string> {
    const tree = await git("merge-tree", "--write-tree", main, revision);
    return git("commit-tree", tree, "-p", main, "-p", revision, "-m", `review fork from ${revision}`);
  }

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-review-")));
    repo = join(root, "repo");
    await mkdir(join(root, "scratch"));
    await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
    const scopes = JSON.parse(await readFile(join(repo, "penguin", "scopes.json"), "utf8"));
    for (const scope of scopes.scopes) {
      if (scope.id === ANALYTICS) scope.contracts = [DAU];
      if (scope.id === "identity-map") scope.contracts = [IDENTITY_MAP];
    }
    const files: Record<string, unknown> = {
      "penguin/scopes.json": scopes,
      "penguin/invariants.json": INVARIANTS,
      [EXAMPLES_FILE]: EXAMPLES,
    };
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), `${JSON.stringify(value, null, 2)}\n`);
    }
    await git("add", "--", ...Object.keys(files));
    await git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "Declare analytics invariants and examples");
    main = await git("rev-parse", "HEAD");
    forks = {
      checkpoint: await mergedOntoMain("owner-priya-checkpoint"),
      limitFive: await mergedOntoMain("owner-priya-limit-five"),
      limitOne: await mergedOntoMain("owner-priya"),
    };
  });

  after(() => rm(root, { recursive: true, force: true }));

  test("the side-by-side command ID resolves to the bridge's own script", () => {
    const { script } = resolveAnalysisCommand(SIDE_BY_SIDE_COMMAND_ID);
    assert.ok(script.startsWith(join(REPO_ROOT, "services", "local-bridge", "analysis")));
    assert.ok(existsSync(script));
  });

  test("on Priya's checkpoint the side-by-side run shows the strangers on one tablet merged", async (t) => {
    const record = await runSideBySide(options(), { base: main, fork: forks.checkpoint, scope: ANALYTICS });
    const calls = record.sets.map((set) => `${set.contract}: main ${set.mainMs} ms, fork ${set.forkMs} ms of calls`);
    t.diagnostic(`side-by-side wall time: main ${Math.round(record.timings.mainMs)} ms, fork ${Math.round(record.timings.forkMs)} ms; ${calls.join("; ")}`);
    assert.equal(record.sets.length, 1);
    const [set] = record.sets;
    assert.equal(set?.contract, DAU);
    assert.equal(set?.file, EXAMPLES_FILE);
    assert.deepEqual(set?.inputs, EXAMPLES.cases.map((entry) => entry.name));
    assert.deepEqual(set?.differing.map((entry) => entry.name), ["three patrons on one library tablet"]);
    const [difference] = set?.differing ?? [];
    assert.deepEqual(difference?.main, { status: "returned", value: { "2026-01-05": 3 } });
    assert.deepEqual(difference?.fork, { status: "returned", value: { "2026-01-05": 1 } });
    assert.deepEqual(difference?.args, EXAMPLES.cases[1]?.args);
    assert.deepEqual(record.totals, { inputs: 2, differing: 1, invalid: 0 });
    assert.ok(record.timings.mainMs > 0 && record.timings.forkMs > 0);
    assert.match(formatSideBySide(record), /differs on 1 of 2/);
    // The runs leave no worktree behind.
    assert.deepEqual(await readdir(join(root, "scratch")), []);
    assert.equal((await git("worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
  });

  test("a named risky input runs on old and new code: a busy tablet still merges under a limit of five", async () => {
    const busy = [1, 2, 3, 4, 5, 6].map((n) => login(n, `u${n}`, "tablet-7"));
    const riskyInputs = [{ name: "six patrons on one tablet", contract: DAU, invariant: TABLET, args: dauArgs(busy) }];
    const five = await runSideBySide(options(), { base: main, fork: forks.limitFive, scope: ANALYTICS, riskyInputs });
    const risky = five.sets.find((set) => set.source === "risky-inputs");
    assert.deepEqual(risky?.differing.map((entry) => [entry.name, entry.main, entry.fork]), [
      ["six patrons on one tablet", { status: "returned", value: { "2026-01-05": 6 } }, { status: "returned", value: { "2026-01-05": 2 } }],
    ]);
    const one = await runSideBySide(options(), { base: main, fork: forks.limitOne, scope: ANALYTICS, riskyInputs });
    assert.equal(one.totals.differing, 0, formatSideBySide(one));
  });

  test("risky inputs are data checked against the signature before anything runs", async () => {
    const marker = join(root, "pwned");
    const riskyInputs = [
      // A string that looks like code stays a string: it is a device id here.
      { name: "code as text", contract: DAU, args: dauArgs([login(1, "u1", `__import__('os').system('touch ${marker}')`)]) },
      { name: "wrong type", contract: DAU, args: { events: "not a list", identity_map: dauArgs([]).identity_map } },
      { name: "missing parameter", contract: DAU, args: { events: [] } },
      { name: "undeclared call", contract: DAU, args: { events: [], identity_map: { $call: "os.py::system", args: { command: `touch ${marker}` } } } },
      { name: "other scope's function", contract: `${IDENTITY_MAP}.from_events`, args: { events: [] } },
    ];
    const record = await runSideBySide(options(), { base: main, fork: forks.checkpoint, scope: ANALYTICS, riskyInputs });
    assert.equal(existsSync(marker), false);
    const invalid = new Map(record.sets.flatMap((set) => set.invalid.map((entry) => [entry.name, entry])));
    assert.deepEqual([...invalid.keys()].sort(), ["missing parameter", "other scope's function", "undeclared call", "wrong type"]);
    assert.match(invalid.get("wrong type")?.reason ?? "", /events: expected an array/);
    assert.match(invalid.get("missing parameter")?.reason ?? "", /missing a required argument: 'identity_map'/);
    assert.match(invalid.get("undeclared call")?.reason ?? "", /os\.py::system is not a declared contract/);
    assert.equal(invalid.get("other scope's function")?.side, "request");
    const risky = record.sets.find((set) => set.source === "risky-inputs" && set.contract === DAU);
    assert.ok(risky?.inputs.includes("code as text"));
  });

  const holds = (evidence: string[]) => ({ invariant: TABLET, verdict: "holds", evidence, storedData: "Past days keep their counts" });
  const orderRow = { invariant: ORDER, verdict: "holds", evidence: ["analytics/tests/test_dau.py::test_days_are_counted_separately_in_date_order"], storedData: "None" };

  test('a form claiming "holds" without evidence is refused, and the protected difference reaches Jun', async () => {
    const result = await runReview(options(), { base: main, fork: forks.checkpoint, scope: ANALYTICS, form: { rows: [holds([]), orderRow] } });
    assert.equal(result.state, "refused");
    assert.deepEqual(result.refusals.map((refusal) => [refusal.code, refusal.invariant]), [["no_evidence", TABLET]]);
    assert.deepEqual(result.exceptions, [
      { kind: "protected_difference", invariant: TABLET, scope: ANALYTICS, contract: DAU, differing: 1 },
    ]);
    assert.match(formatReviewResult(result), /refused \(no_evidence\) tablet-patrons-separate/);
  });

  test("evidence that does not exist in the fork is refused", async () => {
    // Jun's shared-device test lives in Jun's fork, not in Priya's.
    const form = { rows: [holds(["analytics/tests/test_identity.py::test_shared_device_split", "analytics/models.py:999", "../etc/passwd:1"]), orderRow] };
    const result = await runReview(options(), { base: main, fork: forks.checkpoint, scope: ANALYTICS, form });
    assert.deepEqual(result.refusals.map((refusal) => [refusal.code, refusal.evidence]), [
      ["evidence_not_found", "analytics/tests/test_identity.py::test_shared_device_split"],
      ["evidence_not_found", "analytics/models.py:999"],
      ["invalid_evidence", "../etc/passwd:1"],
    ]);
  });

  test('a missing row and "unknown" without a test are refused', async () => {
    const unknown = { invariant: TABLET, verdict: "unknown", evidence: ["analytics/models.py:9"], storedData: "Not known" };
    const result = await runReview(options(), { base: main, fork: forks.checkpoint, scope: ANALYTICS, form: { rows: [unknown] } });
    assert.deepEqual(result.refusals.map((refusal) => [refusal.code, refusal.invariant]), [
      ["unknown_without_test", TABLET],
      ["missing_row", ORDER],
    ]);
  });

  test("a stored shape change needs a migration, backfill or cutover marker", async () => {
    const analyzer = pythonImpactAnalyzer({ repoPath: repo, python: PYTHON });
    const breaks = { invariant: TABLET, verdict: "breaks", evidence: ["ingestion/identity_map.py::IdentityMap::observe"], storedData: "Past days lose people" };
    const form = { rows: [breaks, orderRow] };
    const without = await runReview(options({ analyzer }), { base: main, fork: forks.checkpoint, scope: ANALYTICS, form });
    assert.ok(without.storedShapes?.some((shape) => shape.symbol.endsWith("Profile")));
    assert.deepEqual(without.refusals.map((refusal) => refusal.code), ["stored_data_without_marker"]);

    const marked = { ...form, storedDataMarker: { kind: "cutover", evidence: "ingestion/identity_map.py::IdentityMap::person_id" } };
    const accepted = await runReview(options({ analyzer }), { base: main, fork: forks.checkpoint, scope: ANALYTICS, form: marked });
    assert.equal(accepted.state, "accepted", formatReviewResult(accepted));
    // A broken invariant goes to the scope's owner, as does the protected difference.
    assert.deepEqual(accepted.exceptions.map((exception) => exception.kind).sort(), ["broken_invariant", "protected_difference"]);
  });

  test("penguin-bridge review prints the verdict and writes the record", async () => {
    const formPath = join(root, "form.json");
    const out = join(root, "review.json");
    await writeFile(formPath, JSON.stringify({ rows: [holds([]), orderRow] }));
    let output = "";
    const io = { write: (text: string) => void (output += text), ask: async () => "" };
    const args = ["review", "--repo", repo, "--python", PYTHON, "--base", main, "--fork", forks.checkpoint];
    const code = await runCli([...args, "--scope", ANALYTICS, "--form", formPath, "--no-diff", "--out", out], io);
    assert.equal(code, 1);
    assert.match(output, /: refused/);
    assert.match(output, /three patrons on one library tablet: main \{"2026-01-05":3\}; fork \{"2026-01-05":1\}/);
    const record = JSON.parse(await readFile(out, "utf8"));
    assert.equal(record.sideBySide.totals.differing, 1);
  });

  test("a scope the base does not declare is an error", async () => {
    await assert.rejects(runSideBySide(options(), { base: main, fork: forks.checkpoint, scope: "nowhere" }), SideBySideError);
  });
});
