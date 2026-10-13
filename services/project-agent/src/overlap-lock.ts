// The overlap lock (PRD 0.4 section 4.1 step 3, section 9 OverlapLock): when a feature declares its
// area, Penguin compares it with the area of every other running feature.
//
// - Same area: another running feature covers part of the declared area. Each such pair is one
//   OverlapLock, keyed by the covering feature and the blocked one, which records where the two
//   meet. Overlapping starts are what Penguin is for, so no start waits on a person at any stage of
//   the review policy (#177): Penguin approves each new lock at once with a signed `approve_overlap`
//   record that names the owner. It tells the person who owns the covering feature. A lock opened
//   before #177 and still open waits for that person's approval, as it did. When a lock is approved
//   or withdrawn, an OverlapSettled row tells the blocked feature's sessions at their next safe
//   checkpoint (session-store.ts).
// - Same person: a covering feature of the declaring feature's own person makes no lock, since that
//   person already knows both pieces of work. The overlap is kept as an OwnOverlap and recorded.
// - Depends on it: a running feature works in a scope that declares a dependency (`depends_on` in
//   `penguin/scopes.json`) on a scope the declared area falls in. It is stored on the declaring
//   feature as a dependent. Dependents block nothing; they go into the merge plan (PRD 4.2).
// - An owner's scope: an expand checkpoint that adds to a scope another person owns waits on that
//   person before it reaches main on its own (expand-promotion.ts, PRD 4.2 step 2). Its lock is keyed
//   by `owner:<person>` in place of a covering feature, so the person is asked once per feature. It
//   holds only the expand promotion: the feature's write tokens and its start never wait on it.
//
// Two areas overlap where a scope one declares holds a path, contract or scope of the other; where
// a declared path is, contains or lies inside a path the other declares; and where both name the
// same contract, or one names a contract inside a path the other declares. Two paths in one scope
// overlap only when one contains the other: a scope is covered as a whole only when it is declared.
//
// Every area, scope and dependency comes from the stored declarations and the base repo's scope
// map; this module names none. Each check and each approval is a signed record on the declaring
// feature (feature-store.ts).

import { ownerLockId, PENGUIN_APPROVER, type Author } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import type { Feature, FeatureArea, FeatureRecord, FeatureStore, UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

/** `open` while the start waits for the covering person; `approved` once they approved it. */
export type OverlapLockState = "open" | "approved";

/** Where two areas meet, named from the declaring feature's area where the two differ. */
export interface Overlap {
  readonly scopes: readonly string[];
  readonly paths: readonly string[];
  readonly contracts: readonly string[];
  /** Overlapping paths left out of `paths` past OVERLAP_LIMITS.paths. */
  readonly omittedPaths: number;
}

export interface OverlapLock {
  /** The running feature that covers the area. */
  readonly featureId: string;
  /** The feature whose start waits. */
  readonly blockedFeatureId: string;
  /** The person who owns the covering feature, the only one who may approve. */
  readonly personId: string;
  readonly state: OverlapLockState;
  readonly approvedBy: string | null;
  readonly overlap: Overlap;
  readonly openedAt: string;
  readonly decidedAt: string | null;
}

/** A running feature that reads what the declaring feature changes, through one scope dependency. */
export interface FeatureDependent {
  readonly featureId: string;
  readonly dependentFeatureId: string;
  /** The scope the dependent feature works in, which declares the dependency. */
  readonly consumerScopeId: string;
  /** The scope the declaring feature's area falls in. */
  readonly providerScopeId: string;
  readonly kind: string;
}

/** A running feature of the same person that covers the area: recorded, with no lock. */
export interface OwnOverlap {
  readonly featureId: string;
  readonly overlap: Overlap;
}

/** A lock that stopped holding a start: approved by its person, or withdrawn by a declaration. */
export interface SettledLock {
  /** Orders settlements; a session hears of each id once. */
  readonly id: number;
  readonly featureId: string;
  readonly blockedFeatureId: string;
  readonly outcome: "approved" | "withdrawn";
  readonly settledAt: number;
}

/** What a check found for one feature: the locks its start waits on, its own overlaps and dependents. */
export interface OverlapStatus {
  readonly waitingOn: readonly OverlapLock[];
  readonly approved: readonly OverlapLock[];
  readonly ownOverlaps: readonly OwnOverlap[];
  readonly dependents: readonly FeatureDependent[];
}

export const OVERLAP_LIMITS = {
  /** Overlapping paths kept on a lock; the rest are counted. */
  paths: 100,
} as const;

/** A feature runs until it lands (PRD 4.5): a landed feature covers no area and is no target. */
export const RUNNING_STATES: ReadonlySet<Feature["state"]> = new Set(["opening", "building", "landing"]);

export const OVERLAP_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS OverlapLock (
    feature_id TEXT NOT NULL, blocked_feature_id TEXT NOT NULL, person_id TEXT NOT NULL, state TEXT NOT NULL,
    approved_by TEXT, overlap TEXT NOT NULL, opened_at INTEGER NOT NULL, decided_at INTEGER,
    PRIMARY KEY (feature_id, blocked_feature_id))`,
  `CREATE INDEX IF NOT EXISTS OverlapLock_blocked ON OverlapLock (blocked_feature_id, state)`,
  `CREATE INDEX IF NOT EXISTS OverlapLock_person ON OverlapLock (person_id, state)`,
  `CREATE TABLE IF NOT EXISTS FeatureDependent (
    feature_id TEXT NOT NULL, dependent_feature_id TEXT NOT NULL, consumer_scope_id TEXT NOT NULL,
    provider_scope_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (feature_id, dependent_feature_id, consumer_scope_id, provider_scope_id))`,
  `CREATE TABLE IF NOT EXISTS OwnOverlap (
    feature_id TEXT NOT NULL, other_feature_id TEXT NOT NULL, overlap TEXT NOT NULL,
    PRIMARY KEY (feature_id, other_feature_id))`,
  `CREATE TABLE IF NOT EXISTS OverlapSettled (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, blocked_feature_id TEXT NOT NULL,
    outcome TEXT NOT NULL, settled_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS OverlapSettled_blocked ON OverlapSettled (blocked_feature_id, id)`,
];

/** An area prepared for comparison: its sets, and the scopes it falls in. */
export interface Footprint {
  readonly scopes: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
  /** Every proper ancestor directory of a declared path, so containment is one lookup. */
  readonly ancestors: ReadonlySet<string>;
  readonly contracts: ReadonlySet<string>;
  /** Declared scopes, the scope of each path and contract, and each scope under a declared path. */
  readonly touched: ReadonlySet<string>;
  /** Each declared path's scopes: the one it falls in, and those whose paths lie under it. */
  readonly pathScopes: ReadonlyMap<string, readonly string[]>;
}

/** `a/b/c` gives `a` and `a/b`. */
function properAncestors(path: string): string[] {
  const ancestors: string[] = [];
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) ancestors.push(path.slice(0, slash));
  return ancestors;
}

function contractPath(contract: string): string {
  return contract.slice(0, contract.indexOf("::"));
}

export function footprint(area: FeatureArea, scopeMap: ScopeMap): Footprint {
  const paths = new Set(area.paths);
  const ancestors = new Set(area.paths.flatMap(properAncestors));
  const touched = new Set(area.scopes);
  const pathScopes = new Map<string, string[]>(area.paths.map((path) => [path, []]));
  for (const path of [...area.paths, ...area.contracts.map(contractPath)]) {
    const scope = scopeOf(scopeMap, path);
    if (scope === undefined) continue;
    touched.add(scope);
    pathScopes.get(path)?.push(scope);
  }
  // A declared directory above a scope's own path covers that scope's files.
  for (const [scopePath, scope] of scopeMap.pathIndex) {
    for (const ancestor of properAncestors(scopePath)) {
      if (!paths.has(ancestor)) continue;
      touched.add(scope);
      pathScopes.get(ancestor)?.push(scope);
    }
  }
  return { scopes: new Set(area.scopes), paths, ancestors, contracts: new Set(area.contracts), touched, pathScopes };
}

/**
 * The scope a stored path falls in: `scopeForPath` without its normalization, since stored paths are
 * normalized already, which keeps a check of many recorded paths cheap.
 */
function scopeOf(scopeMap: ScopeMap, path: string): string | undefined {
  for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
    const scope = scopeMap.pathIndex.get(path.slice(0, end));
    if (scope !== undefined) return scope;
  }
  return undefined;
}

/** True when `path` is, contains or lies inside a path of `other`. */
function nests(path: string, other: Footprint): boolean {
  return other.paths.has(path) || other.ancestors.has(path) || properAncestors(path).some((ancestor) => other.paths.has(ancestor));
}

/** Where `mine` meets `theirs`, or undefined when the two areas are apart. */
export function overlapOf(mine: Footprint, theirs: Footprint): Overlap | undefined {
  const scopes = new Set<string>();
  for (const scope of mine.scopes) if (theirs.touched.has(scope)) scopes.add(scope);
  for (const scope of theirs.scopes) if (mine.touched.has(scope)) scopes.add(scope);
  // A path overlaps a path of theirs it nests with, or a scope they declare that it falls in or holds.
  const paths = [...mine.paths].filter(
    (path) => nests(path, theirs) || (mine.pathScopes.get(path) ?? []).some((scope) => theirs.scopes.has(scope)),
  );
  const contracts = new Set<string>();
  for (const contract of mine.contracts) {
    if (theirs.contracts.has(contract) || nests(contractPath(contract), theirs)) contracts.add(contract);
  }
  for (const contract of theirs.contracts) if (nests(contractPath(contract), mine)) contracts.add(contract);
  if (scopes.size === 0 && paths.length === 0 && contracts.size === 0) return undefined;
  paths.sort();
  return {
    scopes: [...scopes].sort(),
    paths: paths.slice(0, OVERLAP_LIMITS.paths),
    contracts: [...contracts].sort(),
    omittedPaths: Math.max(0, paths.length - OVERLAP_LIMITS.paths),
  };
}

/** The covering features and the dependents of `feature` among `others`. */
export interface OverlapFindings {
  readonly covering: readonly { readonly feature: Feature; readonly overlap: Overlap }[];
  readonly dependents: readonly Omit<FeatureDependent, "featureId">[];
}

/**
 * Compares `feature`'s area with each running feature in `others` (the feature itself is skipped).
 * A running feature covers it when the areas overlap; it depends on it when it works in a scope
 * whose `depends_on` names a scope the feature's area falls in.
 */
export function findOverlaps(feature: Feature, others: readonly Feature[], scopeMap: ScopeMap): OverlapFindings {
  const mine = footprint(feature.area, scopeMap);
  // The consumers of each provider scope the area falls in, with the dependency's kind.
  const readers: { consumer: string; provider: string; kind: string }[] = [];
  for (const provider of mine.touched) {
    for (const consumer of scopeMap.dependents.get(provider) ?? []) {
      const kind = scopeMap.scopes.get(consumer)?.dependsOn.find((dependency) => dependency.providerScopeId === provider)?.kind;
      if (kind !== undefined) readers.push({ consumer, provider, kind });
    }
  }
  const covering: { feature: Feature; overlap: Overlap }[] = [];
  const dependents: Omit<FeatureDependent, "featureId">[] = [];
  for (const other of others) {
    if (other.id === feature.id || !RUNNING_STATES.has(other.state)) continue;
    const theirs = footprint(other.area, scopeMap);
    const overlap = overlapOf(mine, theirs);
    if (overlap !== undefined) covering.push({ feature: other, overlap });
    for (const { consumer, provider, kind } of readers) {
      if (theirs.touched.has(consumer)) {
        dependents.push({ dependentFeatureId: other.id, consumerScopeId: consumer, providerScopeId: provider, kind });
      }
    }
  }
  return { covering, dependents };
}

export class OverlapStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of OVERLAP_SCHEMA) db.exec(statement);
  }

  get(featureId: string, blockedFeatureId: string): OverlapLock | undefined {
    const [row] = this.#db.exec(
      `SELECT * FROM OverlapLock WHERE feature_id = ? AND blocked_feature_id = ?`,
      featureId,
      blockedFeatureId,
    );
    return row === undefined ? undefined : lock(row);
  }

  /** The locks on `blockedFeatureId`'s start, oldest first; owner's-scope locks hold no start. */
  locksOn(blockedFeatureId: string): OverlapLock[] {
    return this.#db
      .exec(`SELECT * FROM OverlapLock WHERE blocked_feature_id = ? AND feature_id NOT LIKE 'owner:%' ORDER BY opened_at, rowid`, blockedFeatureId)
      .map(lock);
  }

  /** The owner's-scope locks on `blockedFeatureId`'s expand promotions, oldest first. */
  ownerLocksOn(blockedFeatureId: string): OverlapLock[] {
    return this.#db
      .exec(`SELECT * FROM OverlapLock WHERE blocked_feature_id = ? AND feature_id LIKE 'owner:%' ORDER BY opened_at, rowid`, blockedFeatureId)
      .map(lock);
  }

  /** Opens `personId`'s owner's-scope lock on `blockedFeatureId`; false when one exists, open or approved. */
  openOwnerLock(personId: string, blockedFeatureId: string, overlap: Overlap): boolean {
    const opened = this.#db.exec(
      `INSERT OR IGNORE INTO OverlapLock (feature_id, blocked_feature_id, person_id, state, approved_by, overlap, opened_at, decided_at)
       VALUES (?, ?, ?, 'open', NULL, ?, ?, NULL) RETURNING feature_id`,
      ownerLockId(personId),
      blockedFeatureId,
      personId,
      JSON.stringify(overlap),
      this.#now(),
    );
    return opened.length > 0;
  }

  /** The features whose start an open lock of `featureId` holds, oldest lock first. */
  heldBy(featureId: string): string[] {
    return this.#db
      .exec(`SELECT blocked_feature_id FROM OverlapLock WHERE feature_id = ? AND state = 'open' ORDER BY opened_at, rowid`, featureId)
      .map((row) => row["blocked_feature_id"] as string);
  }

  /** The open locks `personId` is asked to approve, oldest first. */
  openFor(personId: string): OverlapLock[] {
    return this.#db
      .exec(`SELECT * FROM OverlapLock WHERE person_id = ? AND state = 'open' ORDER BY opened_at, rowid`, personId)
      .map(lock);
  }

  dependents(featureId: string): FeatureDependent[] {
    return this.#db
      .exec(
        `SELECT * FROM FeatureDependent WHERE feature_id = ?
         ORDER BY dependent_feature_id, consumer_scope_id, provider_scope_id`,
        featureId,
      )
      .map(dependent);
  }

  ownOverlaps(featureId: string): OwnOverlap[] {
    return this.#db
      .exec(`SELECT * FROM OwnOverlap WHERE feature_id = ? ORDER BY other_feature_id`, featureId)
      .map((row) => ({ featureId: row["other_feature_id"] as string, overlap: JSON.parse(row["overlap"] as string) as Overlap }));
  }

  /** The locks on `blockedFeatureId` settled at or after `since` (epoch milliseconds), oldest first. */
  settledSince(blockedFeatureId: string, since: number): SettledLock[] {
    return this.#db
      .exec(`SELECT * FROM OverlapSettled WHERE blocked_feature_id = ? AND settled_at >= ? ORDER BY id`, blockedFeatureId, since)
      .map((row) => ({
        id: Number(row["id"]),
        featureId: row["feature_id"] as string,
        blockedFeatureId: row["blocked_feature_id"] as string,
        outcome: row["outcome"] as SettledLock["outcome"],
        settledAt: Number(row["settled_at"]),
      }));
  }

  status(featureId: string): OverlapStatus {
    const locks = this.locksOn(featureId);
    return {
      waitingOn: locks.filter((each) => each.state === "open"),
      approved: locks.filter((each) => each.state === "approved"),
      ownOverlaps: this.ownOverlaps(featureId),
      dependents: this.dependents(featureId),
    };
  }

  /**
   * Stores a check of `blockedFeatureId`: opens a lock per covering feature that has none, withdraws
   * each open lock whose feature no longer covers the area, and replaces the own overlaps and the
   * dependents. An approved lock stays approved. Runs inside the caller's transaction.
   */
  apply(blockedFeatureId: string, plan: OverlapPlan): void {
    const now = this.#now();
    for (const { featureId, personId, overlap } of plan.open) {
      this.#db.exec(
        `INSERT OR IGNORE INTO OverlapLock (feature_id, blocked_feature_id, person_id, state, approved_by, overlap,
           opened_at, decided_at)
         VALUES (?, ?, ?, 'open', NULL, ?, ?, NULL)`,
        featureId,
        blockedFeatureId,
        personId,
        JSON.stringify(overlap),
        now,
      );
    }
    for (const featureId of plan.withdraw) {
      const removed = this.#db.exec(
        `DELETE FROM OverlapLock WHERE feature_id = ? AND blocked_feature_id = ? AND state = 'open' RETURNING feature_id`,
        featureId,
        blockedFeatureId,
      );
      if (removed.length > 0) this.#settle(featureId, blockedFeatureId, "withdrawn", now);
    }
    this.#db.exec(`DELETE FROM OwnOverlap WHERE feature_id = ?`, blockedFeatureId);
    for (const { featureId, overlap } of plan.ownOverlaps) {
      this.#db.exec(
        `INSERT OR REPLACE INTO OwnOverlap (feature_id, other_feature_id, overlap) VALUES (?, ?, ?)`,
        blockedFeatureId,
        featureId,
        JSON.stringify(overlap),
      );
    }
    this.#db.exec(`DELETE FROM FeatureDependent WHERE feature_id = ?`, blockedFeatureId);
    for (const each of plan.dependents) {
      this.#db.exec(
        `INSERT OR IGNORE INTO FeatureDependent (feature_id, dependent_feature_id, consumer_scope_id, provider_scope_id, kind)
         VALUES (?, ?, ?, ?, ?)`,
        blockedFeatureId,
        each.dependentFeatureId,
        each.consumerScopeId,
        each.providerScopeId,
        each.kind,
      );
    }
  }

  /** Approves an open lock as `approvedBy`. Undefined, writing nothing, when it is not open. */
  approve(featureId: string, blockedFeatureId: string, approvedBy: string): OverlapLock | undefined {
    const now = this.#now();
    const [row] = this.#db.exec(
      `UPDATE OverlapLock SET state = 'approved', approved_by = ?, decided_at = ?
       WHERE feature_id = ? AND blocked_feature_id = ? AND state = 'open' RETURNING *`,
      approvedBy,
      now,
      featureId,
      blockedFeatureId,
    );
    if (row === undefined) return undefined;
    this.#settle(featureId, blockedFeatureId, "approved", now);
    return lock(row);
  }

  /**
   * Withdraws every open lock on `blockedFeatureId`, a feature that will not start (a block Penguin
   * closed with nothing to carry), so no person is asked to approve it. Answers the features whose
   * locks were withdrawn.
   */
  withdrawAll(blockedFeatureId: string): string[] {
    const now = this.#now();
    const removed = this.#db
      .exec(`DELETE FROM OverlapLock WHERE blocked_feature_id = ? AND state = 'open' RETURNING feature_id`, blockedFeatureId)
      .map((row) => row["feature_id"] as string);
    for (const featureId of removed) this.#settle(featureId, blockedFeatureId, "withdrawn", now);
    return removed;
  }

  #settle(featureId: string, blockedFeatureId: string, outcome: SettledLock["outcome"], at: number): void {
    this.#db.exec(
      `INSERT INTO OverlapSettled (feature_id, blocked_feature_id, outcome, settled_at) VALUES (?, ?, ?, ?)`,
      featureId,
      blockedFeatureId,
      outcome,
      at,
    );
  }
}

/**
 * What a check changes: the locks to open and withdraw, and the own overlaps and dependents that
 * replace the old.
 */
export interface OverlapPlan {
  readonly open: readonly { readonly featureId: string; readonly personId: string; readonly overlap: Overlap }[];
  /** Covering features of open locks that no longer overlap, or that now belong to the same person. */
  readonly withdraw: readonly string[];
  readonly ownOverlaps: readonly OwnOverlap[];
  readonly dependents: readonly Omit<FeatureDependent, "featureId">[];
}

/**
 * The plan for `findings` on a feature of `personId`, given its stored locks. A covering feature of
 * the same person opens no lock: its overlap is kept as an own overlap.
 */
export function planCheck(findings: OverlapFindings, personId: string, locks: readonly OverlapLock[]): OverlapPlan {
  const held = new Map(locks.map((each) => [each.featureId, each] as const));
  const others = findings.covering.filter(({ feature }) => feature.personId !== personId);
  const locking = new Set(others.map(({ feature }) => feature.id));
  return {
    open: others
      .filter(({ feature }) => !held.has(feature.id))
      .map(({ feature, overlap }) => ({ featureId: feature.id, personId: feature.personId, overlap })),
    withdraw: locks.filter((each) => each.state === "open" && !locking.has(each.featureId)).map((each) => each.featureId),
    ownOverlaps: findings.covering
      .filter(({ feature }) => feature.personId === personId)
      .map(({ feature, overlap }) => ({ featureId: feature.id, overlap })),
    dependents: findings.dependents,
  };
}

/**
 * The locks on a session's feature settled since the session joined it, for the session's safe
 * checkpoint (SessionStoreOptions.settledFor). A session that joined after a settlement never hears of it.
 */
export function settledForSession(features: FeatureStore, overlaps: OverlapStore): (sessionId: string) => SettledLock[] {
  return (sessionId) => {
    const join = features.joinOfSession(sessionId);
    return join === undefined ? [] : overlaps.settledSince(join.featureId, join.joinedAt);
  };
}

/** Hears each lock a check opens or settles, after the write, for the inbox and the live feed. */
export interface OverlapListener {
  lockOpened(lock: Pick<OverlapLock, "featureId" | "blockedFeatureId" | "personId">): void;
  /** The lock was approved or withdrawn: it no longer asks its person anything. */
  lockSettled(lock: Pick<OverlapLock, "featureId" | "blockedFeatureId" | "personId">): void;
  /** Penguin let a start open beside the person's running feature: the person is told, not asked. */
  startTold?(lock: Pick<OverlapLock, "featureId" | "blockedFeatureId" | "personId">): void;
}

export interface OverlapDeps {
  readonly db: SqlDatabase;
  readonly features: FeatureStore;
  readonly overlaps: OverlapStore;
  /** The base repo's scope map, read fresh. */
  readonly scopeMap: () => Promise<ScopeMap>;
  /** Signs a record with the service key, which never leaves the ProjectAgent. */
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  readonly listener?: OverlapListener;
}

const PENGUIN: Author = { penguin: true };

/**
 * Checks `feature`'s stored area against every running feature, stores the locks and dependents
 * and writes one signed `overlap_check` record with what changed. The caller runs checks and
 * approvals one at a time, so a record never races another for its sequence number.
 */
export async function checkOverlap(deps: OverlapDeps, feature: Feature): Promise<OverlapStatus> {
  const findings = findOverlaps(feature, deps.features.list(), await deps.scopeMap());
  const plan = planCheck(findings, feature.personId, deps.overlaps.locksOn(feature.id));
  const record = await deps.sign(
    deps.features.draftRecord(feature.id, "overlap_check", PENGUIN, {
      area: { ...feature.area },
      locks_opened: plan.open.map(({ featureId, personId, overlap }) => ({ feature: featureId, person: personId, overlap })),
      locks_withdrawn: [...plan.withdraw],
      // Overlaps with the same person's running features: recorded, with no lock.
      own_overlaps: plan.ownOverlaps.map(({ featureId, overlap }) => ({ feature: featureId, overlap })),
      dependents: plan.dependents.map((each) => ({
        feature: each.dependentFeatureId,
        consumer_scope: each.consumerScopeId,
        provider_scope: each.providerScopeId,
        kind: each.kind,
      })),
    }),
  );
  const withdrawn = plan.withdraw.flatMap((id) => deps.overlaps.get(id, feature.id) ?? []);
  deps.db.transaction(() => {
    deps.overlaps.apply(feature.id, plan);
    deps.features.addRecord(record);
  });
  for (const { featureId, personId } of plan.open) await approveByPenguin(deps, featureId, feature.id, personId);
  for (const each of withdrawn) deps.listener?.lockSettled(each);
  return deps.overlaps.status(feature.id);
}

/**
 * Penguin approves the start of `blockedFeatureId` beside `featureId`: a signed `approve_overlap`
 * record authored by Penguin that names the owner it tells, then tells them.
 */
async function approveByPenguin(deps: OverlapDeps, featureId: string, blockedFeatureId: string, owner: string): Promise<void> {
  const held = deps.overlaps.get(featureId, blockedFeatureId);
  if (held === undefined || held.state !== "open") return;
  const record = await deps.sign(
    deps.features.draftRecord(blockedFeatureId, "approve_overlap", PENGUIN, {
      feature: featureId,
      blocked_feature: blockedFeatureId,
      approved_by: PENGUIN_APPROVER,
      owner,
      overlap: { ...held.overlap },
    }),
  );
  const approved = deps.db.transaction(() => {
    const done = deps.overlaps.approve(featureId, blockedFeatureId, PENGUIN_APPROVER);
    if (done !== undefined) deps.features.addRecord(record);
    return done;
  });
  if (approved === undefined) return;
  deps.listener?.lockSettled(approved);
  deps.listener?.startTold?.(approved);
}

export type ApproveOutcome =
  | { readonly status: "ok"; readonly lock: OverlapLock; readonly overlap: OverlapStatus }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "conflict"; readonly message: string };

/**
 * `caller`, the person the gateway authenticated, approves the start of `blockedFeatureId` beside
 * their feature `featureId`. Only the person who owns the covering feature may, and only while the
 * lock is open: a second approval is refused. The approval is a signed `approve_overlap` record on
 * the blocked feature, authored by the caller.
 */
export async function approveOverlap(
  deps: OverlapDeps,
  caller: string,
  featureId: string,
  blockedFeatureId: string,
): Promise<ApproveOutcome> {
  const held = deps.overlaps.get(featureId, blockedFeatureId);
  if (held === undefined) {
    return { status: "rejected", reason: "not_found", message: `feature ${blockedFeatureId} waits on no lock of feature ${featureId}` };
  }
  const covering = deps.features.get(featureId);
  // The covering feature's person now, so the lock follows the feature, not who owned it at the check.
  const owner = covering?.personId ?? held.personId;
  if (owner !== caller) {
    return { status: "rejected", reason: "forbidden", message: `only the person who owns feature ${featureId} can approve this start` };
  }
  if (held.state !== "open") {
    return { status: "rejected", reason: "conflict", message: `the start of ${blockedFeatureId} beside ${featureId} is already approved` };
  }
  const record = await deps.sign(
    deps.features.draftRecord(blockedFeatureId, "approve_overlap", { person: caller }, {
      feature: featureId,
      blocked_feature: blockedFeatureId,
      approved_by: caller,
      overlap: { ...held.overlap },
    }),
  );
  const approved = deps.db.transaction(() => {
    const done = deps.overlaps.approve(featureId, blockedFeatureId, caller);
    if (done !== undefined) deps.features.addRecord(record);
    return done;
  });
  if (approved === undefined) {
    return { status: "rejected", reason: "conflict", message: `the start of ${blockedFeatureId} beside ${featureId} is already approved` };
  }
  deps.listener?.lockSettled(approved);
  return { status: "ok", lock: approved, overlap: deps.overlaps.status(blockedFeatureId) };
}

function lock(row: Row): OverlapLock {
  const decided = row["decided_at"];
  return {
    featureId: row["feature_id"] as string,
    blockedFeatureId: row["blocked_feature_id"] as string,
    personId: row["person_id"] as string,
    state: row["state"] as OverlapLockState,
    approvedBy: (row["approved_by"] as string | null) ?? null,
    overlap: JSON.parse(row["overlap"] as string) as Overlap,
    openedAt: new Date(Number(row["opened_at"])).toISOString(),
    decidedAt: decided === null || decided === undefined ? null : new Date(Number(decided)).toISOString(),
  };
}

function dependent(row: Row): FeatureDependent {
  return {
    featureId: row["feature_id"] as string,
    dependentFeatureId: row["dependent_feature_id"] as string,
    consumerScopeId: row["consumer_scope_id"] as string,
    providerScopeId: row["provider_scope_id"] as string,
    kind: row["kind"] as string,
  };
}
