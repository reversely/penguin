// Phase 4's verification loop end to end, without the network (#41): owners publish fixed
// checkpoints of the identity-unification fixture to local bare forks, the ProjectAgent schedules a
// verification run, the bridge's VerificationRunner fetches the forks, pushes the merge to the Huddle
// repo's `integration` branch and runs every affected scope's tests there, and the report becomes
// checks on the Huddle issue and its state.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  combinedRunEvent,
  CombinedRunner,
  localRemote,
  penguinRepoOf,
  TestRunner,
  verificationPass,
  VerificationRunner,
  type RemoteResolver,
  type VerificationReply,
  ownerForkTargets,
} from "@penguin/local-bridge";

import { HuddleProject } from "../../services/project-agent/test/huddle-project.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const TEST_ENV = { ...process.env, PATH: [VENV_BIN, process.env.PATH].join(delimiter) };
const OWNERS = ["priya", "jun", "sam"] as const;

let root: string;
let fixture: string;
let pins: { branches: Record<string, string>; tags: Record<string, string> };
/** The combined-run event of the owners' unfixed checkpoints, as the runner reported it. */
let opening: unknown;

const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]).then(({ stdout }) => stdout.trim());

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-huddle-verify-")));
  fixture = join(root, "fixture");
  await mkdir(join(root, "scratch"));
  await run(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  pins = JSON.parse(await readFile(join(FIXTURE, "pins.json"), "utf8"));
  const report = await new CombinedRunner({ repoPath: fixture, runner: testRunner(fixture) }).run({
    checkpointSha: pins.tags["owner-priya-checkpoint"] as string,
    baselineSha: pins.branches.main as string,
    targets: ownerForkTargets({ jun: pins.tags["owner-jun-checkpoint"] as string, sam: pins.tags["owner-sam-checkpoint"] as string }),
  });
  opening = JSON.parse(JSON.stringify(combinedRunEvent(report, "priya")));
});

after(() => rm(root, { recursive: true, force: true }));

function testRunner(repoPath: string): TestRunner {
  return new TestRunner({ repoPath, env: TEST_ENV, scratchDir: join(root, "scratch"), consent: () => true });
}

/**
 * One project: bare forks holding each owner's unfixed checkpoint, a Huddle repo forked from main, a
 * runner repository that starts empty, and the Huddle opened from the unfixed run.
 */
async function setUp(name: string) {
  const dir = join(root, name);
  const repos = join(dir, "repos");
  const bare = (repo: string) => join(repos, `${repo}.git`);
  for (const owner of OWNERS) await run("git", ["init", "--quiet", "--bare", bare(`owner-${owner}`)]);
  await run("git", ["init", "--quiet", "--bare", bare("huddle-001")]);
  await git(fixture, "push", "--quiet", bare("huddle-001"), `${pins.branches.main}:refs/heads/main`);
  const runnerRepo = join(dir, "runner");
  await run("git", ["init", "--quiet", runnerRepo]);
  // Every repo resolves to its bare repository, as `penguin:<repo>` resolves to Artifacts.
  const remotes: RemoteResolver = (remote) => localRemote(bare(penguinRepoOf(remote) as string));

  const project = new HuddleProject();
  const publish = async (owner: string, sha: string) => {
    await git(fixture, "push", "--quiet", bare(`owner-${owner}`), `${sha}:refs/heads/main`);
    return project.checkpoint(owner, sha);
  };
  for (const owner of OWNERS) await publish(owner, pins.tags[`owner-${owner}-checkpoint`] as string);
  const opened = await project.open(opening);
  assert.equal(opened.status, "opened", JSON.stringify(opened));
  project.huddles.setRepo(opened.status === "opened" ? opened.huddle.triggerCommit : "", "huddle-001");

  const runner = new VerificationRunner({
    repoPath: runnerRepo,
    runner: testRunner(runnerRepo),
    readRemotes: remotes,
    writeRemotes: remotes,
  });
  const pending = () => project.verificationSpecs();
  // Penguin answers the runner the way the Worker route does; a refused report fails the test.
  const report = async (runId: string, body: unknown): Promise<VerificationReply> => {
    const outcome = await project.reportVerification(runId, body);
    assert.notEqual(outcome.status, "rejected", JSON.stringify(outcome));
    return outcome as VerificationReply;
  };
  const verify = () => verificationPass({ list: async () => pending(), run: (spec) => runner.run(spec), report });
  const integration = () => git(bare("huddle-001"), "rev-parse", "refs/heads/integration");
  return { project, publish, pending, verify, integration };
}

function current(project: HuddleProject) {
  return [...(project.index.issue("1")?.checks.values() ?? [])].filter((check) => check.supersededBy === null);
}

test("the owners' fixed branches pass on the integration branch and the issue moves to review", async () => {
  const { project, publish, pending, verify, integration } = await setUp("fixed");
  for (const owner of OWNERS) await publish(owner, pins.branches[`owner-${owner}`] as string);
  // Each fix superseded the run before it, so one run is left.
  assert.equal(pending().length, 1);
  assert.equal(project.index.issue("1")?.state, "verifying");

  const pass = await verify();
  assert.deepEqual(pass.failed, []);
  assert.equal(pass.reported[0]?.reply.status, "recorded");
  const revision = await integration();
  const checks = current(project);
  assert.deepEqual(
    checks.map((check) => `${check.commandId} ${check.result} ${check.repo}@${check.sha}`),
    ["test:analytics", "test:identity-map", "test:messaging"].map((command) => `${command} pass huddle-001@${revision}`),
  );
  assert.ok(checks.every((check) => check.fingerprint !== null));
  assert.equal(project.index.issue("1")?.state, "in_review");
});

test("Priya's limit of five fails a test on a clean merge; her newer checkpoint supersedes the checks and passes", async () => {
  const { project, publish, pending, verify, integration } = await setUp("limit-five");
  await publish("jun", pins.branches["owner-jun"] as string);
  await publish("sam", pins.branches["owner-sam"] as string);
  await publish("priya", pins.tags["owner-priya-limit-five"] as string);
  await verify();

  const failing = current(project).filter((check) => check.result !== "pass");
  assert.deepEqual(failing.map((check) => `${check.commandId} ${check.test} ${check.result}`), [
    "test:analytics test_identity::shared_device_split fail",
  ]);
  const firstRevision = await integration();
  assert.ok(current(project).every((check) => check.sha === firstRevision));
  assert.equal(project.index.issue("1")?.state, "fixing");

  // The newer checkpoint marks every earlier check superseded and schedules exactly one run.
  const earlier = current(project).map((check) => check.opId);
  await publish("priya", pins.branches["owner-priya"] as string);
  assert.deepEqual(current(project), []);
  assert.ok(earlier.every((opId) => project.index.issue("1")?.checks.get(opId)?.supersededBy !== null));
  assert.equal(pending().length, 1);
  assert.equal(project.index.issue("1")?.state, "verifying");

  await verify();
  const revision = await integration();
  assert.notEqual(revision, firstRevision);
  // The integration branch moved forward from the earlier result; nothing was force-pushed.
  assert.equal(await git(join(root, "limit-five", "repos", "huddle-001.git"), "rev-parse", `${revision}^1`), firstRevision);
  assert.ok(current(project).every((check) => check.result === "pass" && check.sha === revision));
  assert.equal(project.index.issue("1")?.state, "in_review");
});
