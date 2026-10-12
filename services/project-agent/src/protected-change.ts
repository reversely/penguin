// A feature's own change to a path another person protects (PRD 0.4 sections 4.3 step 4 and 7: "A
// plan touches a path its owner protects" goes to "That owner, who confirms the final lines"). The
// plan includes the originating feature's own change, so its protected paths are checked as a plan
// part's fix is (plan-approval.ts).
//
// - At each checkpoint, Penguin reads the feature's own change: the files that differ between the
//   checkpoint and its merge base with main, the newest commit of main's history the checkpoint
//   reaches through any parent. Files main brought in by a merge are not the feature's own. Each
//   changed file is matched once against the scope map's protected paths. A path in a scope the
//   feature's own person is DRI for raises nothing, as the overlap lock makes no lock between one
//   person's features.
// - The person who answers for each touched scope (#135) gets one ProtectedChange row for the feature,
//   with the changed lines of those files, and a `protected_path` inbox item: the scope's DRI, or down
//   its fallback order while the DRI has no bridge online and no session, never the feature's own
//   person. A person already asked keeps the row while they still answer for the scope. A later
//   checkpoint that leaves those files' contents as confirmed keeps the confirmation; one that changes
//   them asks again, and one that no longer touches the person's paths withdraws the row and the item.
// - Only the person asked, or the delegate they name in `penguin/owners.json`, confirms, on the
//   dashboard, naming the checkpoint they saw. A confirmation is a signed `confirm_protected_change`
//   record on the feature. The feature's land is refused while any row waits (block-land.ts).
//
// The row's lines follow the plan patches' rule (dashboard-views.ts mayReadPartLines): the feature's
// person, the person asked and their delegate, and each touched scope's DRI, delegate and team.

import type { PlanFileDiff, ProtectedChangeFile, ProtectedChangeRequest, ProtectedChangeState } from "@penguin/protocol";
import type { Delegates } from "@penguin/issues";
import { answerersOf, routeScope, type ScopeMap } from "@penguin/scope-map";

import { BASE_BRANCH } from "./base-repo.ts";
import { BASELINE_SEARCH_LIMIT } from "./combined-run-schedule.ts";
import { mayReadPartLines } from "./dashboard-views.ts";
import type { FeatureRejection } from "./feature-open.ts";
import { parseFeatureId, type Feature, type FeatureRecord, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import { changeRef, type InboxItem, type InboxStore } from "./inbox-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { protectedLookup } from "./plan-approval.ts";
import type { IssuesRepoReader } from "./push-ingest.ts";
import { changedFiles, fileDiffs, type ChangedFile, type GitObjectReader } from "./repo-diff.ts";

type Row = Record<string, SqlValue>;

/** Commits an ancestry search visits before it gives up. */
const ANCESTRY_LIMIT = 2_000;

export const PROTECTED_CHANGE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ProtectedChange (
    feature_id TEXT NOT NULL, owner_id TEXT NOT NULL, checkpoint TEXT NOT NULL, merge_base TEXT NOT NULL,
    fingerprint TEXT NOT NULL, files TEXT NOT NULL, state TEXT NOT NULL, confirmed_by TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY (feature_id, owner_id))`,
  `CREATE INDEX IF NOT EXISTS ProtectedChange_owner ON ProtectedChange (owner_id)`,
];

/** One changed file under a protected path, as a row keeps it. */
export interface ProtectedFileDiff extends PlanFileDiff {
  readonly scope: string;
  readonly protectedPath: string;
}

/** The lines one feature's own change writes under the paths one person protects. */
export interface ProtectedChange {
  readonly featureId: string;
  readonly ownerId: string;
  readonly checkpoint: string;
  readonly mergeBase: string;
  /** Each file's path and blob, so a later checkpoint with the same contents keeps a confirmation. */
  readonly fingerprint: string;
  readonly files: readonly ProtectedFileDiff[];
  readonly state: ProtectedChangeState;
  readonly confirmedBy: string | null;
  readonly updatedAt: string;
}

function change(row: Row): ProtectedChange {
  return {
    featureId: row["feature_id"] as string,
    ownerId: row["owner_id"] as string,
    checkpoint: row["checkpoint"] as string,
    mergeBase: row["merge_base"] as string,
    fingerprint: row["fingerprint"] as string,
    files: JSON.parse(row["files"] as string) as ProtectedFileDiff[],
    state: row["state"] as ProtectedChangeState,
    confirmedBy: (row["confirmed_by"] as string | null) ?? null,
    updatedAt: new Date(Number(row["updated_at"])).toISOString(),
  };
}

/** The confirmations each feature's own change needs, one row per protecting person. */
export class ProtectedChangeStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of PROTECTED_CHANGE_SCHEMA) db.exec(statement);
  }

  ofFeature(featureId: string): ProtectedChange[] {
    return this.#db.exec(`SELECT * FROM ProtectedChange WHERE feature_id = ? ORDER BY owner_id`, featureId).map(change);
  }

  get(featureId: string, ownerId: string): ProtectedChange | undefined {
    const [row] = this.#db.exec(`SELECT * FROM ProtectedChange WHERE feature_id = ? AND owner_id = ?`, featureId, ownerId);
    return row === undefined ? undefined : change(row);
  }

  /** The rows of features whose own change touches a path one of `owners` protects, oldest change first. */
  forOwners(owners: readonly string[]): ProtectedChange[] {
    if (owners.length === 0) return [];
    // Only placeholders are built into the query; every owner is a bound value.
    return this.#db
      .exec(`SELECT * FROM ProtectedChange WHERE owner_id IN (${owners.map(() => "?").join(", ")}) ORDER BY updated_at, rowid`, ...owners)
      .map(change);
  }

  /** Keeps the row of `next`, replacing the feature's row for that person. */
  put(next: Omit<ProtectedChange, "updatedAt">): void {
    this.#db.exec(
      `INSERT INTO ProtectedChange (feature_id, owner_id, checkpoint, merge_base, fingerprint, files, state, confirmed_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (feature_id, owner_id) DO UPDATE SET checkpoint = excluded.checkpoint, merge_base = excluded.merge_base,
         fingerprint = excluded.fingerprint, files = excluded.files, state = excluded.state,
         confirmed_by = excluded.confirmed_by, updated_at = excluded.updated_at`,
      next.featureId,
      next.ownerId,
      next.checkpoint,
      next.mergeBase,
      next.fingerprint,
      JSON.stringify(next.files),
      next.state,
      next.confirmedBy,
      this.#now(),
    );
  }

  remove(featureId: string, ownerId: string): void {
    this.#db.exec(`DELETE FROM ProtectedChange WHERE feature_id = ? AND owner_id = ?`, featureId, ownerId);
  }

  /** Confirms the row while it still waits at `checkpoint`; false when it moved on or was confirmed. */
  confirm(featureId: string, ownerId: string, checkpoint: string, by: string): boolean {
    return (
      this.#db.exec(
        `UPDATE ProtectedChange SET state = 'confirmed', confirmed_by = ?, updated_at = ?
         WHERE feature_id = ? AND owner_id = ? AND checkpoint = ? AND state = 'pending' RETURNING owner_id`,
        by,
        this.#now(),
        featureId,
        ownerId,
        checkpoint,
      ).length > 0
    );
  }
}

/** The feature's own change: its merge base with main and every file that differs from it. */
export interface OwnChange {
  readonly mergeBase: string;
  readonly files: readonly ChangedFile[];
}

/**
 * The files checkpoint `sha` in `fork` changes since its merge base with main: the newest commit of
 * main's first-parent history that the checkpoint reaches through any parent. The search stops at
 * every commit of main's history, so it reads only the fork's own commits.
 *
 * Raises:
 *   Error: when a commit is missing or no commit of main is within the search's reach.
 */
export async function ownChange(
  fork: Pick<GitObjectReader, "readCommit" | "readTree">,
  base: Pick<IssuesRepoReader, "log">,
  sha: string,
): Promise<OwnChange> {
  const main = new Map((await base.log({ ref: BASE_BRANCH, limit: BASELINE_SEARCH_LIMIT, offset: 0 })).map((commit, index) => [commit.hash, index]));
  const head = await fork.readCommit(sha);
  if (head === null) throw new Error(`checkpoint ${sha} is not in the fork`);
  let best: string | undefined;
  const seen = new Set([sha]);
  const queue = [sha];
  while (queue.length > 0 && seen.size <= ANCESTRY_LIMIT) {
    const hash = queue.shift() as string;
    const position = main.get(hash);
    if (position !== undefined) {
      if (best === undefined || position < (main.get(best) as number)) best = hash;
      continue;
    }
    const commit = hash === sha ? head : await fork.readCommit(hash);
    for (const parent of commit?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  if (best === undefined) throw new Error(`no commit of main's ${BASE_BRANCH} branch is within reach of ${sha}`);
  if (best === sha) return { mergeBase: sha, files: [] };
  const mergeBase = await fork.readCommit(best);
  if (mergeBase === null) throw new Error(`merge base ${best} is not in the fork`);
  return { mergeBase: best, files: await changedFiles(fork, mergeBase.treeHash, head.treeHash) };
}

/** The inbox calls a protected change makes (inbox-store.ts). */
export type ProtectedChangeInbox = Pick<InboxStore, "protectedChangeTouched" | "protectedChangeConfirmed" | "protectedChangeWithdrawn">;

export interface ProtectedChangeDeps {
  readonly store: ProtectedChangeStore;
  readonly inbox: ProtectedChangeInbox;
  readonly notify: (personId: string) => void;
}

export interface CheckpointProtectionDeps extends ProtectedChangeDeps {
  /** The feature's own change at a checkpoint, read from its fork and main (`ownChange`). */
  readonly readOwnChange: (repo: string, sha: string) => Promise<OwnChange>;
  /** Each file's changed lines, read from the fork (repo-diff.ts fileDiffs). */
  readonly readDiffs: (repo: string, files: readonly ChangedFile[]) => Promise<readonly PlanFileDiff[]>;
}

/** Whether a scope whose DRI is not `person` protects a path in `scopeMap`: else no checkpoint reads anything. */
function othersProtect(scopeMap: ScopeMap, person: string): boolean {
  for (const scope of scopeMap.scopes.values()) if (scope.driId !== person && scope.protectedPaths.length > 0) return true;
  return false;
}

/**
 * Who confirms the protected paths of scope `scopeId` that a feature of `featurePerson` touches: a
 * person already asked for the feature who still answers for the scope keeps it, so a checkpoint never
 * moves a waiting confirmation; otherwise the scope's DRI, or down its fallback order while the DRI is
 * away, never the feature's own person (#135).
 */
function confirmer(scopeMap: ScopeMap, scopeId: string, featurePerson: string, asked: ReadonlySet<string>, available: (person: string) => boolean): string | undefined {
  const scope = scopeMap.scopes.get(scopeId);
  if (scope === undefined) return undefined;
  const kept = answerersOf(scope).find((person) => person !== featurePerson && asked.has(person));
  return kept ?? routeScope(scopeMap, scopeId, available, featurePerson);
}

/**
 * Checkpoint `sha` of `feature`: for each scope whose protected paths its own change touches, the
 * person who confirms them (`confirmer`) gets a row and an item, unless the feature's own person is the
 * scope's DRI; a person whose paths it no longer touches loses both. Returns the people asked to
 * confirm. `available` says who can take work now; absent, every DRI is asked.
 */
export async function checkProtectedChanges(
  deps: CheckpointProtectionDeps,
  feature: Feature,
  sha: string,
  scopeMap: ScopeMap,
  available: (person: string) => boolean = () => true,
): Promise<string[]> {
  const before = new Map(deps.store.ofFeature(feature.id).map((row) => [row.ownerId, row]));
  const touched = new Map<string, { file: ChangedFile; scope: string; protectedPath: string }[]>();
  let mergeBase = "";
  if (feature.repo !== null && othersProtect(scopeMap, feature.personId)) {
    const own = await deps.readOwnChange(feature.repo, sha);
    mergeBase = own.mergeBase;
    const lookup = protectedLookup(scopeMap);
    const asked = new Set(before.keys());
    for (const file of own.files) {
      const hit = lookup(file.path);
      if (hit === undefined || hit.owner === feature.personId) continue;
      const owner = confirmer(scopeMap, hit.scope, feature.personId, asked, available);
      if (owner === undefined || owner === feature.personId) continue;
      touched.set(owner, [...(touched.get(owner) ?? []), { file, scope: hit.scope, protectedPath: hit.path }]);
    }
  }
  const told = new Set<string>();
  const asked: string[] = [];
  if (touched.size > 0) {
    const all = [...touched.values()].flat();
    const diffs = new Map((await deps.readDiffs(feature.repo as string, all.map((each) => each.file))).map((diff) => [diff.path, diff]));
    for (const [owner, hits] of [...touched].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const fingerprint = JSON.stringify(hits.map(({ file }) => [file.path, file.newHash]));
      // A file past the diff's file limit is still named, with no lines.
      const files = hits.map(({ file, scope, protectedPath }): ProtectedFileDiff => {
        const status = file.oldHash === null ? "added" : file.newHash === null ? "deleted" : "modified";
        return { ...(diffs.get(file.path) ?? { path: file.path, scopeId: scope, status, hunks: [], omitted: "too_large" }), scope, protectedPath };
      });
      const kept = before.get(owner);
      // The same contents a person confirmed stay confirmed; anything else asks them again.
      const confirmed = kept?.state === "confirmed" && kept.fingerprint === fingerprint;
      deps.store.put({
        featureId: feature.id,
        ownerId: owner,
        checkpoint: sha,
        mergeBase,
        fingerprint,
        files,
        state: confirmed ? "confirmed" : "pending",
        confirmedBy: confirmed ? kept.confirmedBy : null,
      });
      if (!confirmed && kept?.fingerprint !== fingerprint) {
        deps.inbox.protectedChangeTouched(owner, feature.id);
        told.add(owner);
      }
      if (!confirmed) asked.push(owner);
    }
  }
  for (const owner of before.keys()) {
    if (touched.has(owner)) continue;
    deps.store.remove(feature.id, owner);
    deps.inbox.protectedChangeWithdrawn(owner, feature.id);
    told.add(owner);
  }
  for (const person of told) deps.notify(person);
  return asked;
}

/** The confirmation the dashboard posts: the feature, the protecting person and the checkpoint seen. */
export interface ProtectedConfirmInput {
  readonly feature: unknown;
  readonly owner: unknown;
  readonly checkpoint: unknown;
}

export interface ConfirmDeps extends ProtectedChangeDeps {
  readonly features: FeatureStore;
  /** Each owner's delegate, from `penguin/owners.json` on the base repo, read fresh. */
  readonly delegates: () => Promise<Delegates>;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
}

export type ProtectedConfirmOutcome =
  | { readonly status: "ok"; readonly change: ProtectedChange; readonly recordId: string }
  | FeatureRejection;

const rejected = (reason: FeatureRejection["reason"], message: string): FeatureRejection => ({ status: "rejected", reason, message });
const SHA = /^[0-9a-f]{40}$/u;

/**
 * `caller`, the person the dashboard session names, confirms the lines a feature's own change writes
 * under paths `owner` protects, at the checkpoint they saw. Only `owner` or their delegate may, once
 * per checkpoint whose lines changed; the confirmation is a signed record on the feature.
 */
export async function confirmProtectedChange(deps: ConfirmDeps, caller: string, input: ProtectedConfirmInput): Promise<ProtectedConfirmOutcome> {
  const featureId = parseFeatureId(input.feature);
  if (featureId === undefined) return rejected("invalid", "the feature id is not a valid feature id");
  if (typeof input.owner !== "string" || typeof input.checkpoint !== "string" || !SHA.test(input.checkpoint)) {
    return rejected("invalid", "owner must name the person who protects the paths and checkpoint the full SHA you saw");
  }
  const owner = input.owner;
  if (deps.features.get(featureId) === undefined) return rejected("not_found", `no feature ${featureId}`);
  const row = deps.store.get(featureId, owner);
  if (row === undefined) return rejected("not_found", `feature ${featureId}'s own change touches no path ${owner} protects`);
  if (caller !== owner && (await deps.delegates()).get(owner) !== caller) {
    return rejected("forbidden", `only ${owner}, who protects these paths, or their delegate confirms them`);
  }
  if (row.checkpoint !== input.checkpoint) return rejected("conflict", `feature ${featureId} is at checkpoint ${row.checkpoint}, not ${input.checkpoint}; read it again`);
  if (row.state === "confirmed") return rejected("conflict", `the lines at checkpoint ${row.checkpoint} are already confirmed by ${row.confirmedBy}`);
  const record = await deps.sign(
    deps.features.draftRecord(featureId, "confirm_protected_change", { person: caller }, {
      owner,
      confirmed_by: caller,
      checkpoint: row.checkpoint,
      merge_base: row.mergeBase,
      files: row.files.map(({ path, protectedPath }) => ({ path, protected_path: protectedPath })),
    }),
  );
  if (!deps.store.confirm(featureId, owner, row.checkpoint, caller)) {
    return rejected("conflict", `feature ${featureId}'s change moved while it was confirmed; read it again`);
  }
  deps.features.addRecord(record);
  deps.inbox.protectedChangeConfirmed(owner, featureId);
  deps.notify(owner);
  const person = deps.features.get(featureId)?.personId;
  if (person !== undefined && person !== owner) deps.notify(person);
  return { status: "ok", change: deps.store.get(featureId, owner) as ProtectedChange, recordId: record.record_id };
}

/** The rows that still wait on a person: a feature with any of them may not land. */
export function unconfirmedProtected(store: ProtectedChangeStore, featureId: string): ProtectedChange[] {
  return store.ofFeature(featureId).filter((row) => row.state === "pending");
}

/**
 * The protected changes the dashboard lists for `viewer`: every row of a person in `owners`, the
 * viewer and the people whose delegate they are, waiting or confirmed, oldest change first.
 */
export function protectedChangeRequests(
  store: ProtectedChangeStore,
  features: Pick<FeatureStore, "get">,
  items: readonly InboxItem[],
  owners: readonly string[],
  viewer: string,
  delegates: ReadonlyMap<string, string>,
  scopeMap?: ScopeMap,
): ProtectedChangeRequest[] {
  return store.forOwners(owners).flatMap((row) => {
    const person = features.get(row.featureId)?.personId;
    if (person === undefined) return [];
    const item = items.find((each) => each.reason === "protected_path" && each.personId === row.ownerId && each.issueId === changeRef(row.featureId));
    return [protectedChangeRequest(row, person, viewer, delegates, item, scopeMap)];
  });
}

/**
 * One row as the dashboard lists it for `viewer`, with its item's read flag and time. Its lines follow
 * `mayReadPartLines` over the row's scopes; without `scopeMap`, only over its person and owner.
 */
export function protectedChangeRequest(
  row: ProtectedChange,
  person: string,
  viewer: string,
  delegates: ReadonlyMap<string, string>,
  item: InboxItem | undefined,
  scopeMap?: ScopeMap,
): ProtectedChangeRequest {
  const scopes = [...new Set(row.files.map((file) => file.scope))];
  const lines = mayReadPartLines({ person }, { owner: row.ownerId, scopes }, viewer, delegates, scopeMap);
  const files: ProtectedChangeFile[] = row.files.map((file) => ({
    path: file.path,
    status: file.status,
    scope: file.scope,
    protectedPath: file.protectedPath,
    lines: lines ? file.hunks.flatMap((hunk) => hunk.lines) : null,
  }));
  return {
    feature: row.featureId,
    person,
    owner: row.ownerId,
    checkpoint: row.checkpoint,
    mergeBase: row.mergeBase,
    state: row.state,
    confirmedBy: row.confirmedBy,
    files,
    read: item?.read ?? row.state === "confirmed",
    raisedAt: item?.raisedAt ?? row.updatedAt,
  };
}
