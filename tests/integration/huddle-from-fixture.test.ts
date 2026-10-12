// Phase 4's first step end to end, without the network: the bridge's combined run replays the
// identity-unification fixture's owner-*-checkpoint tags, and the ProjectAgent's Huddle opening
// turns the report into one Huddle issue with a fix sub-issue per failing test (#38).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { combinedRunEvent, CombinedRunner, ownerForkTargets, TestRunner } from "@penguin/local-bridge";
import { parseCombinedRunEvent } from "@penguin/protocol";

import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };

let root: string;
let repo: string;
let tags: Record<string, string>;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-huddle-fixture-")));
  repo = join(root, "main");
  await mkdir(join(root, "bridge"));
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), repo]);
  const pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8")) as {
    branches: Record<string, string>;
    tags: Record<string, string>;
  };
  tags = { ...pins.tags, main: pins.branches.main as string };
});

after(() => rm(root, { recursive: true, force: true }));

/** One combined run of Priya's checkpoint with Jun's and Sam's, as the runner reports it to Penguin. */
async function combinedRun() {
  const report = await new CombinedRunner({
    repoPath: repo,
    runner: new TestRunner({ repoPath: repo, env: TEST_ENV, scratchDir: join(root, "bridge"), consent: () => true }),
  }).run({
    checkpointSha: tags["owner-priya-checkpoint"] as string,
    baselineSha: tags.main as string,
    targets: ownerForkTargets({ jun: tags["owner-jun-checkpoint"] as string, sam: tags["owner-sam-checkpoint"] as string }),
  });
  // The event crosses the network as JSON, without the test logs.
  const wire = JSON.parse(JSON.stringify(combinedRunEvent(report, "priya")));
  assert.equal(JSON.stringify(wire).includes("short test summary"), false);
  return { report, wire };
}

test("replaying the owner checkpoints opens exactly one Huddle issue with three assigned fix sub-issues", async () => {
  const project = new HuddleProject();
  project.publish("priya", tags["owner-priya-checkpoint"] as string);

  const first = await combinedRun();
  const parsed = parseCombinedRunEvent(first.wire);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const opened = await project.open(first.wire);
  assert.equal(opened.status, "opened", JSON.stringify(opened));

  assert.deepEqual(project.huddleIssues(), ["1"]);
  const fingerprints = new Map(
    first.report.results.flatMap((result) => (result.status === "failed" ? [[result.scopeId, result.fingerprint.id]] : [])),
  );
  assert.deepEqual(project.fixes("1"), [
    `@jun/reports test_identity::shared_device_split ${fingerprints.get("analytics")}`,
    `@jun/reports test_retention::dau_stable ${fingerprints.get("analytics")}`,
    `@sam/campaigns test_consent::unsubscribe_survives ${fingerprints.get("messaging")}`,
  ]);
  const huddle = project.index.issue("1");
  assert.ok(huddle);
  assert.equal(huddle.state, "fixing");
  assert.deepEqual(
    [...huddle.checks.values()].map((check) => `${check.test} ${check.result} ${check.fingerprint}`),
    [
      `test_identity::shared_device_split fail ${fingerprints.get("analytics")}`,
      `test_retention::dau_stable fail ${fingerprints.get("analytics")}`,
      `test_consent::unsubscribe_survives fail ${fingerprints.get("messaging")}`,
    ],
  );

  // A second combined run on the same trigger revision opens no second Huddle and writes nothing.
  const applied = project.appliedCount();
  const second = await combinedRun();
  const again = await project.open(second.wire);
  assert.equal(again.status, "existing");
  assert.deepEqual(project.huddleIssues(), ["1"]);
  assert.equal(project.appliedCount(), applied);
  assert.deepEqual(project.index.ids(), ["1", "2", "3", "4"]);
});
