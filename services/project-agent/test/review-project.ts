// A ProjectAgent's stores for review tasks (#138), wired as the agent wires them, on the helpful-fix
// fixture: Priya's feature utc-day has a checkpoint, and part utc-day/v1#1 waits on Jun for a review
// form for scope analytics. The fork's files come from the fixture's base directory.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlanPart } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { AgentToolStore } from "../src/agent-tools.ts";
import { EditRoster } from "../src/edit-roster.ts";
import { EditTaskStore } from "../src/edit-tasks.ts";
import type { EditWorkDeps } from "../src/edit-work.ts";
import { EMPTY_AREA, FeatureStore } from "../src/feature-store.ts";
import { FixGrantStore, type FixWriteDeps } from "../src/fix-write.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { McpTokenStore } from "../src/mcp-tokens.ts";
import { PlanRouteStore } from "../src/plan-approval.ts";
import { ReviewStore, submitReview } from "../src/review-submit.ts";
import type { ReviewTaskCallDeps } from "../src/review-task.ts";
import { sqlite } from "./issues-repo.ts";

const FIXTURE = join(import.meta.dirname, "../../../examples/helpful-fix");

export const FEATURE = "utc-day";
export const PART = "utc-day/v1#1";
export const CHECKPOINT = "c".repeat(40);

export class ReviewProject {
  readonly sql = sqlite().sql;
  now = Date.parse("2026-10-12T09:00:00Z");
  readonly identities = new IdentityStore(this.sql);
  readonly features = new FeatureStore(this.sql, () => this.now);
  readonly roster = new EditRoster(this.sql, this.identities);
  readonly tasks = new EditTaskStore(this.sql, { now: () => this.now });
  readonly routes = new PlanRouteStore(this.sql, () => this.now);
  readonly grants = new FixGrantStore(this.sql, () => this.now);
  readonly reviews = new ReviewStore(this.sql, () => this.now);
  readonly tokens = new McpTokenStore(this.sql, () => this.now);
  readonly runs = new AgentToolStore(this.sql, () => this.now);
  readonly scopeMap: ScopeMap;
  readonly #invariants: Uint8Array;

  private constructor(scopeMap: ScopeMap, invariants: Uint8Array) {
    this.scopeMap = scopeMap;
    this.#invariants = invariants;
    const record = { ...this.features.draftRecord(FEATURE, "open_feature", { person: "priya" }, {}), signature: "test" };
    this.features.insert(FEATURE, "priya", { ...EMPTY_AREA, scopes: ["ingestion"] }, record);
    this.features.setRepo(FEATURE, `feature-${FEATURE}`);
    const declared = { ...this.features.draftRecord(FEATURE, "declare_area", { person: "priya" }, {}), signature: "test" };
    this.features.setArea(FEATURE, { ...EMPTY_AREA, scopes: ["ingestion"] }, declared, CHECKPOINT);
    this.part(1, "pending");
  }

  static async load(): Promise<ReviewProject> {
    const scopes = JSON.parse(await readFile(join(FIXTURE, "base", "penguin", "scopes.json"), "utf8"));
    return new ReviewProject(parseScopeMap(scopes), await readFile(join(FIXTURE, "base", "penguin", "invariants.json")));
  }

  /** Sets where part utc-day/v1#1, on Jun's analytics, stands. */
  part(revision: number, state: PlanPart["approvalState"]): void {
    const part = { partId: PART, revision, place: { kind: "scope", scope: "analytics" }, owner: "jun", scopes: ["analytics"], approvalState: state } as unknown as PlanPart;
    this.routes.set(FEATURE, part);
  }

  editDeps(withTokens = true): EditWorkDeps {
    return {
      tasks: this.tasks,
      roster: this.roster,
      features: this.features,
      routes: this.routes,
      grants: this.grants,
      reviews: (featureId) => this.reviews.list(featureId),
      scopeMap: async () => this.scopeMap,
      running: () => [],
      fix: {} as FixWriteDeps,
      cap: 2,
      leaseMs: 20 * 60_000,
      notify: () => undefined,
      ...(withTokens ? { taskTokens: this.tokens } : {}),
    };
  }

  callDeps(): ReviewTaskCallDeps {
    const baseline = async () => "b".repeat(40);
    return {
      tasks: this.tasks,
      routes: this.routes,
      identityId: (handle) => this.identities.byHandle(handle)?.id,
      now: () => this.now,
      submit: (owner, sessionId, input, heartbeat) =>
        submitReview(
          {
            features: this.features,
            reviews: this.reviews,
            scopeMap: async () => this.scopeMap,
            invariantsFile: async () => this.#invariants,
            // The fork at the checkpoint holds the fixture's base files.
            readForkFile: async (_repo, _sha, path) => readFile(join(FIXTURE, "base", path)).then((bytes) => new Blob([bytes])).catch(() => null),
            baseline,
            heartbeat,
          },
          owner,
          sessionId,
          input,
        ),
      agentTools: {
        features: this.features,
        runs: this.runs,
        scopeMap: async () => this.scopeMap,
        heartbeat: () => ({ status: "rejected", reason: "not_found", message: "no session" }),
        session: () => undefined,
        identity: () => undefined,
        baseline,
      },
    };
  }
}
