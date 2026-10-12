// Opening a feature and keeping its declared area (PRD 0.4 section 4.1, steps 1 and 2).
//
// A person on the dashboard, or one of their agent sessions over MCP, opens a feature by id. The
// ProjectAgent records it with its declared area and a signed `open_feature` record; the Worker then
// forks main into `feature-<id>` and records the fork here (apps/worker/src/features.ts). Opening an
// id that is already open opens nothing: a session of the same person joins the feature instead, and
// anyone else is refused.
//
// A write token on the fork is granted only to a running session that has joined the feature, only
// on that feature's own fork, and only once no overlap lock holds the feature's start
// (overlap-lock.ts). The Worker mints the token; it never reaches this module.
//
// Each opening and each declaration checks the area against every running feature (PRD 4.1 step 3).
//
// The area is written by the agent, may be edited by the person, and grows at each checkpoint with
// the paths the checkpoint changed and the scopes they fall in. Contracts come only from a
// declaration: telling which contract a change touches needs the contract diff (PRD section 13,
// decision 4).

import { SEGMENT_PATTERN, type Author } from "@penguin/protocol";
import { scopeForPath, type ScopeMap } from "@penguin/scope-map";

import {
  extendArea,
  parseArea,
  parseAreaPath,
  parseFeatureId,
  type Feature,
  type FeatureArea,
  type FeatureRecord,
  type FeatureStore,
  type UnsignedFeatureRecord,
} from "./feature-store.ts";
import type { OverlapStatus } from "./overlap-lock.ts";
import { CHECKPOINT_SHA_PATTERN } from "./owner-forks.ts";
import type { HandedPlan, JoinedPlan } from "./plan-coverage.ts";
import type { Delivery, OverlapRef, SessionOutcome } from "./session-store.ts";

export type FeatureRejectReason = "invalid" | "forbidden" | "not_found" | "offline" | "conflict" | "locked";

export type FeatureRejection = {
  readonly status: "rejected";
  readonly reason: FeatureRejectReason;
  readonly message: string;
};

export type FeatureOpenOutcome =
  | {
      readonly status: "opened" | "existing";
      readonly feature: Feature;
      readonly joined: string | null;
      /** The locks the feature's start waits on, and its dependents. */
      readonly overlap: OverlapStatus;
      /** The merge plans announced before the feature opened that its area meets (PRD 4.6); empty for `existing`. */
      readonly announcedPlans: readonly HandedPlan[];
    }
  | FeatureRejection;

export type FeatureOutcome = { readonly status: "ok"; readonly feature: Feature; readonly overlap: OverlapStatus } | FeatureRejection;

export type CheckpointAreaOutcome =
  | {
      readonly status: "ok";
      readonly feature: Feature;
      readonly baselineSha: string;
      readonly changedPaths: number;
      /** Changed paths left out of the area: over the path cap, or not safe to record as text. */
      readonly omittedPaths: number;
    }
  | FeatureRejection;

/** A grant to mint a write token on one feature's fork. */
export type TokenGrant = { readonly status: "ok"; readonly featureId: string; readonly repo: string } | FeatureRejection;

export interface FeatureDeps {
  readonly features: FeatureStore;
  /** The base repo's scope map, read fresh. */
  readonly scopeMap: () => Promise<ScopeMap>;
  /** A heartbeat of `caller`'s session: refuses another person's session or an offline one. */
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  /** Signs a record with the service key, which never leaves the ProjectAgent. */
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** Checks the feature's stored area against every running feature (overlap-lock.ts `checkOverlap`). */
  readonly checkOverlap: (feature: Feature) => Promise<OverlapStatus>;
  /** The feature's stored locks and dependents. */
  readonly overlapStatus: (featureId: string) => OverlapStatus;
  /**
   * The announced merge plans a newly opened feature's area meets, which it receives at open
   * (plan-coverage.ts handOver). Absent, none are handed over.
   */
  readonly handOver?: (feature: Feature) => Promise<readonly HandedPlan[]>;
}

export interface FeatureOpenInput {
  readonly feature: unknown;
  readonly area?: unknown;
}

const rejected = (reason: FeatureRejectReason, message: string): FeatureRejection => ({ status: "rejected", reason, message });

const INVALID_ID = "the feature id must be lowercase letters and digits joined by single '.' or '-', at most 63 characters";

/** The author of a change: the session's identity, or the person when no session acts. */
function authorOf(deps: FeatureDeps, caller: string, sessionId: string | null): Author | FeatureRejection {
  if (sessionId === null) return { person: caller };
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  return { identity: live.session.handle };
}

const isRejection = (value: unknown): value is FeatureRejection =>
  typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";

/**
 * Opens feature `input.feature` for `caller`, the person the gateway authenticated. With `sessionId`
 * the session opens it as its identity and joins it. A second open of the same id opens nothing and
 * answers `existing`, joining the session when the caller owns the feature.
 */
export async function openFeature(
  deps: FeatureDeps,
  caller: string,
  input: FeatureOpenInput,
  sessionId: string | null,
): Promise<FeatureOpenOutcome> {
  const id = parseFeatureId(input.feature);
  if (id === undefined) return rejected("invalid", INVALID_ID);
  const author = authorOf(deps, caller, sessionId);
  if (isRejection(author)) return author;

  const existing = deps.features.get(id);
  if (existing !== undefined) return joinExisting(deps, caller, existing, sessionId, "existing");

  const parsed = parseArea(input.area, await deps.scopeMap());
  if (!parsed.ok) return rejected("invalid", parsed.message);
  if (sessionId !== null) {
    const current = deps.features.featureOfSession(sessionId);
    if (current !== undefined) return rejected("conflict", `session ${sessionId} already works on feature ${current}`);
  }
  const record = await deps.sign(
    deps.features.draftRecord(id, "open_feature", author, { person: caller, area: { ...parsed.area } }),
  );
  if (!deps.features.insert(id, caller, parsed.area, record)) {
    // Another open of the same id won between the read above and this write.
    return joinExisting(deps, caller, deps.features.get(id) as Feature, sessionId, "existing");
  }
  const opened = deps.features.get(id) as Feature;
  const joined = joinExisting(deps, caller, opened, sessionId, "opened");
  if (joined.status === "rejected") return joined;
  const overlap = await deps.checkOverlap(opened);
  return { ...joined, overlap, announcedPlans: (await deps.handOver?.(opened)) ?? [] };
}

function joinExisting(
  deps: FeatureDeps,
  caller: string,
  feature: Feature,
  sessionId: string | null,
  status: "opened" | "existing",
): FeatureOpenOutcome {
  if (feature.personId !== caller) return rejected("forbidden", `feature ${feature.id} belongs to another person`);
  const overlap = deps.overlapStatus(feature.id);
  if (sessionId === null) return { status, feature, joined: null, overlap, announcedPlans: [] };
  const joined = deps.features.join(feature.id, sessionId);
  if (!joined.joined) return rejected("conflict", `session ${sessionId} already works on feature ${joined.featureId}`);
  return { status, feature, joined: sessionId, overlap, announcedPlans: [] };
}

/** Records the fork the Worker made for a feature. */
export function recordFeatureRepo(features: FeatureStore, featureId: string, repo: string): Feature | undefined {
  return features.get(featureId) === undefined ? undefined : features.setRepo(featureId, repo);
}

/**
 * Grants `caller`'s session `sessionId` a write token on feature `featureId`'s fork: the session must
 * be running and an agent of that feature, the fork must exist and no open overlap lock may hold the
 * feature's start. Any other feature's fork, main and the record repo can never be named here: the
 * grant carries only the feature's own repo.
 */
export function featureTokenGrant(deps: FeatureDeps, caller: string, sessionId: string, featureId: unknown): TokenGrant {
  const id = parseFeatureId(featureId);
  if (id === undefined) return rejected("invalid", INVALID_ID);
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return live;
  const feature = deps.features.get(id);
  if (feature === undefined) return rejected("not_found", `no feature has id ${id}`);
  if (deps.features.featureOfSession(sessionId) !== id) {
    return rejected("forbidden", `session ${sessionId} is not an agent of feature ${id}`);
  }
  if (feature.repo === null) return rejected("not_found", `feature ${id} has no fork yet; open it again to make one`);
  if (feature.state === "landed") return rejected("forbidden", `feature ${id} has landed; its fork is read-only`);
  const { waitingOn } = deps.overlapStatus(id);
  if (waitingOn.length > 0) return rejected("locked", lockedMessage(id, waitingOn));
  return { status: "ok", featureId: id, repo: feature.repo };
}

/**
 * Replaces feature `featureId`'s declared area. An agent session of the feature declares it as its
 * identity; the person who owns the feature edits it with no session.
 */
export async function declareArea(
  deps: FeatureDeps,
  caller: string,
  featureId: unknown,
  area: unknown,
  sessionId: string | null,
): Promise<FeatureOutcome> {
  const id = parseFeatureId(featureId);
  if (id === undefined) return rejected("invalid", INVALID_ID);
  const author = authorOf(deps, caller, sessionId);
  if (isRejection(author)) return author;
  const feature = deps.features.get(id);
  if (feature === undefined) return rejected("not_found", `no feature has id ${id}`);
  if (feature.personId !== caller) return rejected("forbidden", `feature ${id} belongs to another person`);
  if (sessionId !== null && deps.features.featureOfSession(sessionId) !== id) {
    return rejected("forbidden", `session ${sessionId} is not an agent of feature ${id}`);
  }
  const parsed = parseArea(area, await deps.scopeMap());
  if (!parsed.ok) return rejected("invalid", parsed.message);
  const record = await deps.sign(deps.features.draftRecord(id, "declare_area", author, { area: { ...parsed.area } }));
  const declared = deps.features.setArea(id, parsed.area, record, null) as Feature;
  return { status: "ok", feature: declared, overlap: await deps.checkOverlap(declared) };
}

/** Why a feature may not start yet: each covering feature and the person who approves its start. */
export function lockedMessage(featureId: string, waitingOn: OverlapStatus["waitingOn"]): string {
  const holders = waitingOn.map((lock) => `${lock.featureId} (${lock.personId})`).join(", ");
  return `feature ${featureId} overlaps running features ${holders}; it starts once each of their people approves`;
}

/** Reads what a checkpoint changed: its baseline on main and the changed file paths. */
export type CheckpointReader = (repo: string, sha: string) => Promise<{ readonly baselineSha: string; readonly paths: readonly string[] }>;

/**
 * Adds to feature `feature`'s area what checkpoint `sha` actually touched: each changed path not
 * already under a declared path, and the scope each changed path falls in. The checkpoint must be in
 * the feature's fork; `readChange` raises when it is not.
 */
export async function recordCheckpointArea(
  deps: FeatureDeps,
  feature: Feature,
  sha: string,
  author: Author,
  readChange: CheckpointReader,
): Promise<CheckpointAreaOutcome> {
  if (feature.repo === null) return rejected("not_found", `feature ${feature.id} has no fork yet`);
  const change = await readChange(feature.repo, sha);
  const scopeMap = await deps.scopeMap();
  const scopes = new Set<string>();
  const paths: string[] = [];
  let unsafe = 0;
  for (const changed of change.paths) {
    const path = parseAreaPath(changed);
    if (path === undefined) {
      unsafe += 1;
      continue;
    }
    paths.push(path);
    const scope = scopeForPath(scopeMap, path);
    if (scope !== undefined) scopes.add(scope);
  }
  const extended = extendArea(feature.area, scopes, paths);
  const added = addedTo(feature.area, extended.area);
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "checkpoint_area", author, {
      checkpoint: sha,
      baseline: change.baselineSha,
      added_scopes: added.scopes,
      added_paths: added.paths,
    }),
  );
  return {
    status: "ok",
    feature: deps.features.setArea(feature.id, extended.area, record, sha) as Feature,
    baselineSha: change.baselineSha,
    changedPaths: change.paths.length,
    omittedPaths: extended.omittedPaths + unsafe,
  };
}

/** A feature checkpoint: the area update, the session's deliveries and how long the update took. */
export type FeatureCheckpointOutcome =
  | (Extract<CheckpointAreaOutcome, { status: "ok" }> & {
      readonly delivered: readonly string[];
      readonly threads: readonly { readonly issueId: string; readonly threadId: string }[];
      readonly overlaps: readonly OverlapRef[];
      readonly settled: Delivery["settled"];
      readonly toolResults: Delivery["toolResults"];
      readonly planNotices: Delivery["planNotices"];
      /** The announced plans that gained a part for this feature at this checkpoint (PRD 4.4 step 3). */
      readonly plansJoined: readonly JoinedPlan[];
      readonly durationMs: number;
    })
  | FeatureRejection;

export interface FeatureCheckpointDeps extends FeatureDeps {
  /** True when the commit is in the Artifacts repo (the binding's `readCommit` finds it). */
  readonly commitExists: (repo: string, sha: string) => Promise<boolean>;
  readonly readChange: CheckpointReader;
  /** The session's safe checkpoint: the fix tasks, threads, overlapping starts, tool results and advance notice it delivers (SessionStore.checkpoint). */
  readonly deliver: (caller: string, sessionId: string) => Pick<Delivery, "delivered" | "threads" | "overlaps" | "settled" | "toolResults" | "planNotices"> | undefined;
  /**
   * Adds a part for the feature to each announced plan its grown area now meets (plan-coverage.ts
   * coverMidway). Absent, no plan gains a part.
   */
  readonly joinPlans?: (feature: Feature) => Promise<readonly JoinedPlan[]>;
  readonly now?: () => number;
}

/**
 * Records checkpoint `sha` of feature `featureId`: from one of its agent sessions, which then gets
 * its safe-checkpoint deliveries, or, with no session, from the feature person's bridge. The commit
 * must be in the feature's fork. The area grows by what the checkpoint changed against its baseline
 * on main; `durationMs` is how long the whole update took.
 */
export async function reportFeatureCheckpoint(
  deps: FeatureCheckpointDeps,
  caller: string,
  sessionId: string | null,
  featureId: unknown,
  sha: string,
): Promise<FeatureCheckpointOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const id = parseFeatureId(featureId);
  if (id === undefined) return rejected("invalid", INVALID_ID);
  const feature = deps.features.get(id);
  if (feature === undefined) return rejected("not_found", `no feature has id ${id}`);
  const author = authorOf(deps, caller, sessionId);
  if (isRejection(author)) return author;
  if (feature.personId !== caller) return rejected("forbidden", `feature ${id} belongs to another person`);
  if (sessionId !== null && deps.features.featureOfSession(sessionId) !== id) {
    return rejected("forbidden", `session ${sessionId} is not an agent of feature ${id}`);
  }
  if (!CHECKPOINT_SHA_PATTERN.test(sha)) {
    return rejected("invalid", "the checkpoint must be a full 40-character lowercase SHA");
  }
  if (feature.state === "landed") return rejected("conflict", `feature ${id} has landed; its fork is read-only`);
  if (feature.repo === null || !(await deps.commitExists(feature.repo, sha))) {
    return rejected("not_found", `commit ${sha} is not in feature ${id}'s fork`);
  }
  const outcome = await recordCheckpointArea(deps, feature, sha, author, deps.readChange);
  if (outcome.status === "rejected") return outcome;
  // Joining plans runs before the delivery, so the originating sessions' notices already name the new part.
  const plansJoined = (await deps.joinPlans?.(outcome.feature)) ?? [];
  const delivery = sessionId === null ? undefined : deps.deliver(caller, sessionId);
  return {
    ...outcome,
    delivered: delivery?.delivered ?? [],
    threads: delivery?.threads ?? [],
    overlaps: delivery?.overlaps ?? [],
    settled: delivery?.settled ?? [],
    toolResults: delivery?.toolResults ?? [],
    planNotices: delivery?.planNotices ?? NO_PLAN_NOTICES,
    plansJoined,
    durationMs: now() - started,
  };
}

const NO_PLAN_NOTICES: Delivery["planNotices"] = { parts: [], decisions: [], reviews: [] };

function addedTo(before: FeatureArea, after: FeatureArea): { scopes: string[]; paths: string[] } {
  const scopes = new Set(before.scopes);
  const paths = new Set(before.paths);
  return { scopes: after.scopes.filter((s) => !scopes.has(s)), paths: after.paths.filter((p) => !paths.has(p)) };
}

/**
 * A fork as a checkpoint report names it, `feature-<id>` or `penguin:feature-<id>`, without the
 * deployment's repo prefix; the first group is the feature id.
 */
export const FEATURE_REPO_PATTERN = new RegExp(`^(?:penguin:)?feature-(${SEGMENT_PATTERN})$`, "u");
