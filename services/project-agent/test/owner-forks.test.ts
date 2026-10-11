import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OwnerForkStore, reportCheckpoint, type CheckpointDeps } from "../src/owner-forks.ts";
import type { SessionOutcome } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const START = Date.parse("2026-10-10T12:00:00Z");
const FIRST = "4c1d9e0a7b3f2e8d6c5b4a3928170f6e5d4c3b2a"; // pragma: allowlist secret
const SECOND = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"; // pragma: allowlist secret

/** A session store that knows one running session of Jun's. */
const sessions: CheckpointDeps["sessions"] = {
  heartbeat: (caller, sessionId): SessionOutcome =>
    caller === "jun" && sessionId === "ses_1"
      ? {
          status: "ok",
          session: {
            id: "ses_1",
            identityId: "identity-1",
            handle: "@jun/reports",
            vendor: "codex",
            worktreeId: "wt_1",
            branch: "main",
            status: "running",
            currentIssueId: null,
            lastSeen: new Date(START).toISOString(),
          },
        }
      : { status: "rejected", reason: "forbidden", message: `${caller} does not own ${sessionId}` },
};

function setup(commits: string[]) {
  let now = START;
  const forks = new OwnerForkStore(sqlite().sql, () => now);
  const reads: string[] = [];
  const deps: CheckpointDeps = {
    sessions,
    forks,
    commitExists: async (repo, sha) => {
      reads.push(`${repo}@${sha}`);
      return repo === "owner-jun" && commits.includes(sha);
    },
  };
  return { forks, reads, deps, tick: (ms: number) => (now += ms) };
}

describe("OwnerFork checkpoints", () => {
  test("a later report replaces the latest checkpoint", async () => {
    const { forks, deps, tick } = setup([FIRST, SECOND]);
    assert.equal(forks.get("jun"), undefined);
    assert.equal((await reportCheckpoint(deps, "jun", "ses_1", FIRST, "owner-jun")).status, "ok");
    tick(5_000);
    const second = await reportCheckpoint(deps, "jun", "ses_1", SECOND, "owner-jun");
    assert.deepEqual(second, {
      status: "ok",
      fork: {
        ownerId: "jun",
        artifactsRepo: "owner-jun",
        latestCheckpointSha: SECOND,
        reportedBySession: "ses_1",
        reportedAt: new Date(START + 5_000).toISOString(),
      },
    });
  });

  test("a malformed SHA or another owner's session is refused without reading the fork", async () => {
    const { forks, reads, deps } = setup([FIRST]);
    const short = await reportCheckpoint(deps, "jun", "ses_1", FIRST.slice(0, 7), "owner-jun");
    assert.equal(short.status === "rejected" && short.reason, "invalid");
    const priya = await reportCheckpoint(deps, "priya", "ses_1", FIRST, "owner-jun");
    assert.equal(priya.status === "rejected" && priya.reason, "forbidden");
    assert.deepEqual(reads, []);
    assert.equal(forks.get("jun"), undefined);
  });
});
