// Combined runs and block checks key merged trees by feature, not by person (#104). PRD 0.4 section 1:
// a person owns n features, each its own fork, so each running feature is a target of its own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAIN_TARGET } from "@penguin/protocol";
import { CombinedRunner, type BlockChecker, type ForkTarget, type TestedResult, type TestRunner } from "@penguin/local-bridge";

import { createFixtureRepo, type FixtureRepo } from "../../../tests/fixtures/git-repo.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MONEY = join(REPO_ROOT, "examples", "money-minor-units");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

/** A test runner that passes every command and records what it ran on, so no test process starts. */
function recordingRunner(): { runner: TestRunner; ran: { commandId: string; sha: string }[] } {
  const ran: { commandId: string; sha: string }[] = [];
  const runner = {
    run: async ({ commandId, sha }: { commandId: string; sha: string }) => {
      ran.push({ commandId, sha });
      return { commandId, sha, command: "true", exitCode: 0, signal: null, log: "", timings: { createMs: 0, runMs: 0, removeMs: 0 } };
    },
  } as unknown as TestRunner;
  return { runner, ran };
}

/** A block checker that records the merged trees it was asked to check and finds nothing. */
function recordingChecker(): { checker: BlockChecker; targets: { id: string; commit: string; merged: string | null }[] } {
  const targets: { id: string; commit: string; merged: string | null }[] = [];
  const checker = {
    check: async (request: Parameters<BlockChecker["check"]>[0]) => {
      for (const target of request.targets) {
        targets.push({ id: target.id, commit: target.commit, merged: target.merge.kind === "clean" ? target.merge.commit : null });
      }
      return { checks: [], logs: new Map(), dependencies: null, dependencyError: null, durationMs: 0 };
    },
  } as unknown as BlockChecker;
  return { checker, targets };
}

describe("one person with two running features", () => {
  let repo: FixtureRepo;
  let base: string;
  let provider: string;
  const features: Record<string, string> = {};

  before(async () => {
    repo = await createFixtureRepo();
    const scopes = {
      scopes: [
        { id: "core", name: "core", owner: "ana", paths: ["core/"], test_command: "exit 0", depends_on: [] },
        { id: "app", name: "app", owner: "ben", paths: ["app/"], test_command: "exit 0", depends_on: [{ scope: "core", kind: "imports" }] },
      ],
    };
    for (const dir of ["penguin", "core", "app"]) await mkdir(join(repo.main, dir));
    await repo.write(repo.main, "penguin/scopes.json", JSON.stringify(scopes));
    await repo.write(repo.main, "core/lib.txt", "v1\n");
    await repo.write(repo.main, "app/readme.txt", "app\n");
    base = await repo.commitAll(repo.main, "scopes");
    await repo.git(repo.worktreeA, "reset", "--quiet", "--hard", base);
    await repo.write(repo.worktreeA, "core/lib.txt", "v2 from ana\n");
    provider = await repo.commitAll(repo.worktreeA, "ana changes core");
    // Ben's two features both read core; each is its own fork with its own checkpoint.
    for (const feature of ["app-search", "app-cart"]) {
      await repo.git(repo.worktreeB, "reset", "--quiet", "--hard", base);
      await repo.write(repo.worktreeB, `app/${feature}.txt`, `${feature}\n`);
      features[feature] = await repo.commitAll(repo.worktreeB, `ben starts ${feature}`);
    }
  });

  after(() => repo.cleanup());

  test("gets two checked targets, each with its own merged tree and result", async () => {
    const { runner, ran } = recordingRunner();
    const { checker, targets: checked } = recordingChecker();
    const targets: ForkTarget[] = Object.entries(features).map(([id, checkpoint]) => ({ id, person: "ben", checkpoint }));
    const report = await new CombinedRunner({ repoPath: repo.main, runner, checks: checker }).run({
      checkpointSha: provider,
      baselineSha: base,
      targets,
    });

    assert.deepEqual(
      report.results.map((result) => [result.target, result.ownerId, result.scopeId, result.status]),
      [
        ["app-search", "ben", "app", "passed"],
        ["app-cart", "ben", "app", "passed"],
      ],
    );
    const merged = report.results.map((result) => (result.status === "passed" ? result.mergedCommit : null));
    assert.equal(new Set(merged).size, 2, "each feature is merged on its own");
    assert.deepEqual(ran.map((run) => run.sha), merged);
    assert.deepEqual(
      checked.map(({ id, commit }) => [id, commit]),
      [
        [MAIN_TARGET, base],
        ["app-search", features["app-search"]],
        ["app-cart", features["app-cart"]],
      ],
    );
    const tests = (report.checks ?? []).filter((check) => check.check === "tests");
    assert.deepEqual(
      tests.map((check) => [check.target, check.input.target]),
      [
        ["app-search", features["app-search"]],
        ["app-cart", features["app-cart"]],
      ],
    );
  });

  test("a target listed twice is refused before anything runs", async () => {
    const { runner, ran } = recordingRunner();
    const twice = [features["app-search"], features["app-cart"]].map((checkpoint) => ({ id: "app-search", person: "ben", checkpoint: checkpoint as string }));
    await assert.rejects(
      new CombinedRunner({ repoPath: repo.main, runner }).run({ checkpointSha: provider, baselineSha: base, targets: twice }),
      /target app-search is listed twice/,
    );
    assert.deepEqual(ran, []);
  });
});

describe("the money-minor-units fixture", () => {
  let root: string;
  let repo: string;
  let pins: { branches: Record<string, string>; tags: Record<string, string> };
  let owners: Map<string, string>;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "penguin-money-")));
    repo = join(root, "larder");
    execFileSync(PYTHON, [join(MONEY, "build.py"), repo]);
    pins = JSON.parse(readFileSync(join(MONEY, "pins.json"), "utf8"));
    const data = JSON.parse(readFileSync(join(MONEY, "larder.json"), "utf8")) as { features: { id: string; owner: string }[] };
    owners = new Map(data.features.map((feature) => [feature.id, feature.owner]));
  });

  after(() => rm(root, { recursive: true, force: true }));

  test("its 40 features run as 40 targets: main and each feature Ines's change is merged onto", async () => {
    assert.equal(owners.size, 40);
    const origin = "money-minor-units";
    const targets: ForkTarget[] = [...owners]
      .filter(([id]) => id !== origin)
      .map(([id, person]) => ({ id, person, checkpoint: pins.tags[`feature-${id}-checkpoint`] as string }));
    const { runner, ran } = recordingRunner();
    const { checker, targets: checked } = recordingChecker();
    const report = await new CombinedRunner({ repoPath: repo, runner, checks: checker }).run({
      checkpointSha: pins.tags[`feature-${origin}-checkpoint`] as string,
      baselineSha: pins.branches["main"] as string,
      targets,
    });

    // Every running feature is a merged tree of its own, keyed by its id; none is folded into its
    // person's, though fourteen people run the forty features.
    assert.equal(checked.length, 40);
    assert.equal(checked[0]?.id, MAIN_TARGET);
    assert.deepEqual(checked.map(({ id }) => id).sort(), [MAIN_TARGET, ...targets.map((target) => target.id)].sort());
    assert.ok(checked.every(({ merged }) => merged !== null), "every feature merges cleanly with Ines's checkpoint");

    // The 24 features in the nine scopes that read money run their tests, each on its own tree.
    const tested = report.results.filter((result): result is TestedResult => result.status === "passed");
    assert.equal(tested.length, 24);
    assert.equal(new Set(tested.map((result) => result.target)).size, 24);
    assert.equal(new Set(ran.map((run) => run.sha)).size, 24);
    const byPerson = new Map<string, string[]>();
    for (const result of tested) byPerson.set(result.ownerId, [...(byPerson.get(result.ownerId) ?? []), result.target]);
    assert.equal(byPerson.size, 9);
    assert.deepEqual(byPerson.get("priya")?.sort(), ["japan-launch", "saved-carts", "tip-jar"]);
    assert.deepEqual(byPerson.get("noor")?.sort(), ["cart-sync", "order-history", "pagination"]);
    for (const result of tested) {
      assert.equal(result.ownerId, owners.get(result.target));
      assert.equal(result.ownerCheckpoint, pins.tags[`feature-${result.target}-checkpoint`]);
    }
  });
});
