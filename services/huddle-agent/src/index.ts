import { Agent } from "agents";
import {
  durableObjectSql,
  pendingVerifications,
  recordVerification,
  runIdBaseOf,
  scheduleVerification,
  VerificationStore,
  type Huddle,
  type HuddleProjectPort,
  type HuddleVerifier,
  type HuddleVerifyDeps,
  type PendingVerification,
  type VerificationOutcome,
  type VerificationScheduleOutcome,
} from "@penguin/project-agent";

/**
 * Runs the verification loop of one Huddle issue (PRD section 5): it schedules, coalesces and
 * supersedes the Huddle's verification runs and records their results, keeping the runs in its own
 * SQLite. The ProjectAgent names one instance per Huddle issue and passes the Huddle record with each
 * call, with a port back to itself: the HuddleAgent reads the issue and owner forks there and writes
 * its operations there, where the service key signs them and the index validates them. A CryptoKey
 * cannot cross Durable Object RPC, so the signing stays on the ProjectAgent's side.
 */
export class HuddleAgent extends Agent implements HuddleVerifier {
  #runs: VerificationStore | undefined;
  /** Verification steps run one at a time, so no two interleave their writes. */
  #steps: Promise<unknown> = Promise.resolve();

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)`;
  }

  /** POST increments the counter; any other method reads it. */
  override onRequest(request: Request): Response {
    if (request.method === "POST") {
      this.sql`UPDATE counter SET value = value + 1 WHERE id = 1`;
    }
    const [row] = this.sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
    return Response.json({ agent: "HuddleAgent", name: this.name, counter: row?.value ?? 0 });
  }

  /** Schedules a run when an owner in the Huddle has a newer checkpoint; see huddle-verify.ts. */
  scheduleVerification(huddle: Huddle, project: HuddleProjectPort): Promise<VerificationScheduleOutcome | undefined> {
    return this.#step(async () => {
      if (huddle.issueId === null) return undefined;
      return scheduleVerification(this.#deps(huddle.issueId, project), huddle);
    });
  }

  /** The Huddle's runs waiting for the runner, oldest first. */
  pendingVerifications(huddle: Huddle): PendingVerification[] {
    if (huddle.issueId === null) return [];
    return pendingVerifications(this.#runStore(huddle.issueId), huddle);
  }

  /** Records a runner's report of the Huddle's run `runId`; see huddle-verify.ts. */
  reportVerification(
    huddle: Huddle,
    runId: string,
    runnerId: string,
    report: unknown,
    project: HuddleProjectPort,
  ): Promise<VerificationOutcome> {
    return this.#step(async () => {
      if (huddle.issueId === null) {
        return { status: "rejected", reason: "not_found", message: `no verification run ${runId}` };
      }
      return recordVerification(this.#deps(huddle.issueId, project), huddle, runId, runnerId, report);
    });
  }

  #step<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#steps.then(step);
    this.#steps = run.catch(() => undefined);
    return run;
  }

  #deps(issueId: string, project: HuddleProjectPort): HuddleVerifyDeps {
    return {
      runs: this.#runStore(issueId),
      issue: (id) => project.issue(id),
      submit: (operation) => project.submit(operation),
      ownerFork: (ownerId) => project.ownerFork(ownerId),
    };
  }

  /** The Huddle's runs, numbered in the Huddle issue's own range so run IDs stay unique in the project. */
  #runStore(issueId: string): VerificationStore {
    this.#runs ??= new VerificationStore(durableObjectSql(this.ctx.storage), { runIdBase: runIdBaseOf(issueId) });
    return this.#runs;
  }
}
