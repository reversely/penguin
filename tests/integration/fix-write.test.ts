// Phase B's exit check without the network (#91, PRD 0.4 section 12): an approved plan part results in
// one commit on the affected feature's existing fork, with no new branch or fork. The bridge's writer
// (services/local-bridge/src/fix-write.ts) builds and pushes the commit from the write Penguin grants;
// the ProjectAgent's fix-write.ts reads it back and keeps it. The fork is a bare repository reached by
// path, standing in for the Artifacts fork the token reaches.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

import { fixWritePass, localRemote, writeFix } from "@penguin/local-bridge";

import { agentFixGrant, agentFixReport, claimRunnerWrites, runnerFixReport } from "../../services/project-agent/src/fix-write.ts";
import { FixProject, git, SESSIONS, TAX, TAX_FIXED, TAX_FORK, TAX_RENAMED } from "../../services/project-agent/test/fix-project.ts";

describe("an approved part's fix becomes one commit on the affected fork", () => {
  let fx: FixProject;
  let writerRepo: string;

  beforeEach(async () => {
    fx = await FixProject.create();
    writerRepo = `${fx.root}/writer.git`;
    git(fx.root, "init", "--quiet", "--bare", writerRepo);
  });
  afterEach(() => fx.remove());

  const forkState = () => ({
    refs: git(fx.forkDir, "for-each-ref", "--format=%(refname)"),
    repos: readdirSync(fx.root).sort(),
  });

  test("the originating agent writes a behavioural part with its grant, and Penguin keeps the commit", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const before = forkState();
    const grant = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 });
    assert.equal(grant.status, "ok", JSON.stringify(grant));
    if (grant.status !== "ok") return;

    const written = await writeFix({ repoPath: writerRepo, remote: localRemote(fx.forkDir) }, grant.spec);
    assert.equal(written.status, "written", JSON.stringify(written));
    if (written.status !== "written") return;
    const kept = await agentFixReport(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1, commit: written.commit });
    assert.equal(kept.status, "ok", JSON.stringify(kept));
    process.stdout.write(`# fix write on ${TAX_FORK}: ${written.durationMs} ms to build and push\n`);

    // The fork's main moved by exactly the fix commit; its branches and the repos are as they were.
    assert.equal(git(fx.forkDir, "rev-parse", "main"), written.commit);
    assert.equal(git(fx.forkDir, "rev-parse", "main^"), fx.main);
    assert.equal(git(fx.forkDir, "show", "main:tax/rounding.py") + "\n", TAX_FIXED);
    assert.equal(git(fx.forkDir, "diff-tree", "-r", "--name-only", "--no-commit-id", "main"), "tax/rounding.py");
    assert.deepEqual(forkState(), before);
  });

  test("the check runner writes a mechanical part it claimed, with the token minted for that part", async () => {
    await fx.proposeWith(TAX_RENAMED);
    await fx.approve();
    const runner = { bridgeId: "b-runner", role: "runner" as const };
    const pass = await fixWritePass({
      claim: async () => {
        const claim = await claimRunnerWrites(fx.fixDeps(), runner);
        assert.equal(claim.status, "ok");
        return claim.status === "ok" ? claim.writes.map(({ spec }) => ({ spec, token: { token: "unused", remote: fx.forkDir, expiresAt: "" } })) : [];
      },
      write: ({ spec }) => writeFix({ repoPath: writerRepo, remote: localRemote(fx.forkDir) }, spec),
      report: async (writeId, commit) => {
        const kept = await runnerFixReport(fx.fixDeps(), runner, writeId, { commit });
        assert.equal(kept.status, "ok", JSON.stringify(kept));
        return { status: "written", commit, recordId: kept.status === "ok" ? kept.write.recordId : "", durationMs: 0 };
      },
    });
    assert.deepEqual(pass.writes.map(({ partId, error }) => [partId, error]), [[TAX, null]]);
    assert.equal(git(fx.forkDir, "show", "main:tax/rounding.py") + "\n", TAX_RENAMED);
    assert.deepEqual(fx.records("fix_write").map((record) => record.payload["written_by"]), ["penguin"]);
  });

  test("the writer pushes nothing when the fork head is not the granted parent", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const grant = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 });
    assert.equal(grant.status, "ok");
    if (grant.status !== "ok") return;
    // Rahul's agent pushes between the grant and the write.
    const moved = fx.pushToFork(fx.main, { "tax/notes.py": "notes = []\n" }, "Rahul's own work");
    const written = await writeFix({ repoPath: writerRepo, remote: localRemote(fx.forkDir) }, grant.spec);
    assert.deepEqual([written.status, written.status === "moved" ? written.head : ""], ["moved", moved]);
    assert.equal(git(fx.forkDir, "rev-parse", "main"), moved);

    // Asking again rebases the write onto Rahul's head. That write reaches the fork.
    const again = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 });
    assert.equal(again.status === "ok" && again.spec.parent, moved);
    if (again.status !== "ok") return;
    const rebased = await writeFix({ repoPath: writerRepo, remote: localRemote(fx.forkDir) }, again.spec);
    assert.equal(rebased.status, "written");
  });

  test("the writer refuses a spec whose paths are not the patch's files", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const grant = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1 });
    if (grant.status !== "ok") return assert.fail(JSON.stringify(grant));
    const written = await writeFix({ repoPath: writerRepo, remote: localRemote(fx.forkDir) }, { ...grant.spec, paths: ["tax/rounding.py", "tax/other.py"] });
    assert.equal(written.status, "refused");
    assert.equal(git(fx.forkDir, "rev-parse", "main"), fx.main);
  });
});
