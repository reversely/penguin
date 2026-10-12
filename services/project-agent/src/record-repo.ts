// The record repo (PRD 0.5 sections 1, 8 and 9): one repo per project in the Artifacts namespace,
// `record`, made by project setup. It holds every signed feature record as one file at
// `records/<feature>/<author>-<writer>-<seq>.json`, the path the record carries from the moment it is
// signed (feature-store.ts).
//
// The ProjectAgent's FeatureRecord table stays the working copy: every read of a feature's records
// reads it. The repo is the durable history a person clones with a read token. Only Penguin writes it.
// After a record is stored, an alarm commits every record not yet in the repo, oldest first, up to
// RECORD_BATCH_LIMIT, as one commit on `main` in one push, with a write token minted for that push and
// revoked after it.
//
// The binding has no write method, so Penguin builds the commit itself: the blobs, the trees above
// them and the commit, packed in memory and sent to `git-receive-pack` over smart HTTP as main-push.ts
// sends a promotion. A feature with no new record keeps its tree, named by the ID this store kept when
// it was committed, so a push carries only the new objects.
//
// A batch is fixed before its push: its records and its commit ID are stored first. When the answer to
// a push is lost, the next try finds main already naming that commit and keeps it. Otherwise it pushes
// the same batch again, rebuilt object for object, so no record is committed twice. The push names the
// commit main must stand at, so a push that raced another changes nothing.

import { FEATURE_SCHEMA } from "./feature-store.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { advertisement, concat, FLUSH, pktLine, readPktStream, repoUrl, request, type GitEndpoint } from "./main-push.ts";

type Row = Record<string, SqlValue>;

/** The most records one commit carries; the rest wait for the next push. */
export const RECORD_BATCH_LIMIT = 200;
/** The branch the record repo keeps its history on. */
export const RECORD_BRANCH = "main";

const ZERO_ID = "0".repeat(40);
/** A record's file name in its feature's folder: its record id and `.json`. */
const FILE_NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.json$/u;
const AUTHOR = "Penguin <penguin@penguin.invalid>";

export const RECORD_REPO_SCHEMA: readonly string[] = [
  // Main's head as Penguin last pushed it, and the batch being pushed: its commit and its record ids.
  `CREATE TABLE IF NOT EXISTS RecordRepoHead (
    id INTEGER PRIMARY KEY CHECK (id = 1), head TEXT, batch_commit TEXT, batch_records TEXT)`,
  // Each record in the repo: its blob and the commit that added it.
  `CREATE TABLE IF NOT EXISTS RecordRepoEntry (
    record_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, blob TEXT NOT NULL, commit_sha TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS RecordRepoEntry_feature ON RecordRepoEntry (feature_id)`,
  // Each feature folder's tree at main's head.
  `CREATE TABLE IF NOT EXISTS RecordRepoTree (feature_id TEXT PRIMARY KEY, tree TEXT NOT NULL)`,
];

/** A stored record as a commit takes it. */
interface QueuedRecord {
  readonly recordId: string;
  readonly featureId: string;
  readonly path: string;
  readonly file: string;
  readonly createdAt: number;
}

export interface RecordRepoState {
  /** Main's head as Penguin last pushed it, or null before the first push. */
  readonly head: string | null;
  /** The batch fixed for its push and not yet known to be on main. */
  readonly batch: { readonly commit: string; readonly recordIds: readonly string[] } | null;
}

/** The record repo's side of the ProjectAgent's SQLite: what is committed, and the batch in flight. */
export class RecordRepoStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of [...FEATURE_SCHEMA, ...RECORD_REPO_SCHEMA]) db.exec(statement);
    db.exec(`INSERT OR IGNORE INTO RecordRepoHead (id, head, batch_commit, batch_records) VALUES (1, NULL, NULL, NULL)`);
  }

  state(): RecordRepoState {
    const [row] = this.#db.exec(`SELECT head, batch_commit, batch_records FROM RecordRepoHead WHERE id = 1`);
    const commit = row?.["batch_commit"];
    return {
      head: typeof row?.["head"] === "string" ? row["head"] : null,
      batch: typeof commit === "string" ? { commit, recordIds: JSON.parse(row?.["batch_records"] as string) as string[] } : null,
    };
  }

  /** The oldest records not yet in the repo, in the order they were stored, at most `limit`. */
  queued(limit: number): QueuedRecord[] {
    return this.#db
      .exec(
        `SELECT r.record_id, r.feature_id, r.path, r.file, r.created_at FROM FeatureRecord r
         LEFT JOIN RecordRepoEntry e ON e.record_id = r.record_id
         WHERE e.record_id IS NULL ORDER BY r.rowid LIMIT ?`,
        limit,
      )
      .map(queuedRecord);
  }

  /** How many stored records are not yet in the repo. */
  queuedCount(): number {
    const [row] = this.#db.exec(
      `SELECT COUNT(*) AS n FROM FeatureRecord r LEFT JOIN RecordRepoEntry e ON e.record_id = r.record_id WHERE e.record_id IS NULL`,
    );
    return Number(row?.["n"] ?? 0);
  }

  /** The stored records with these ids, in the order they were stored. */
  records(recordIds: readonly string[]): QueuedRecord[] {
    if (recordIds.length === 0) return [];
    const placeholders = recordIds.map(() => "?").join(", ");
    return this.#db
      .exec(`SELECT record_id, feature_id, path, file, created_at FROM FeatureRecord WHERE record_id IN (${placeholders}) ORDER BY rowid`, ...recordIds)
      .map(queuedRecord);
  }

  /** The committed files of each of `featureIds`' folders: file name to blob. */
  committedFiles(featureIds: readonly string[]): Map<string, Map<string, string>> {
    const files = new Map(featureIds.map((id) => [id, new Map<string, string>()]));
    if (featureIds.length === 0) return files;
    const placeholders = featureIds.map(() => "?").join(", ");
    for (const row of this.#db.exec(`SELECT record_id, feature_id, blob FROM RecordRepoEntry WHERE feature_id IN (${placeholders})`, ...featureIds)) {
      files.get(row["feature_id"] as string)?.set(`${row["record_id"] as string}.json`, row["blob"] as string);
    }
    return files;
  }

  /** Every feature folder's tree at main's head. */
  featureTrees(): Map<string, string> {
    return new Map(this.#db.exec(`SELECT feature_id, tree FROM RecordRepoTree`).map((row) => [row["feature_id"] as string, row["tree"] as string]));
  }

  /** Each of a feature's committed records: record id to the commit that added it. */
  commits(featureId: string): Map<string, string> {
    return new Map(
      this.#db.exec(`SELECT record_id, commit_sha FROM RecordRepoEntry WHERE feature_id = ?`, featureId).map((row) => [row["record_id"] as string, row["commit_sha"] as string]),
    );
  }

  /** The commit that added a record, or undefined while it waits. */
  commitOf(recordId: string): string | undefined {
    const [row] = this.#db.exec(`SELECT commit_sha FROM RecordRepoEntry WHERE record_id = ?`, recordId);
    return row === undefined ? undefined : (row["commit_sha"] as string);
  }

  /** Fixes the batch before its push. */
  begin(commit: string, recordIds: readonly string[]): void {
    this.#db.exec(`UPDATE RecordRepoHead SET batch_commit = ?, batch_records = ? WHERE id = 1`, commit, JSON.stringify(recordIds));
  }

  /** Drops the batch without committing it, so the next flush builds a new one. */
  abandon(): void {
    this.#db.exec(`UPDATE RecordRepoHead SET batch_commit = NULL, batch_records = NULL WHERE id = 1`);
  }

  /** Keeps a batch main now names: its records, its folders' trees and main's new head. */
  committed(built: BuiltBatch): void {
    this.#db.transaction(() => {
      for (const entry of built.entries) {
        this.#db.exec(
          `INSERT OR IGNORE INTO RecordRepoEntry (record_id, feature_id, blob, commit_sha) VALUES (?, ?, ?, ?)`,
          entry.recordId,
          entry.featureId,
          entry.blob,
          built.commit,
        );
      }
      for (const [featureId, tree] of built.trees) {
        this.#db.exec(`INSERT INTO RecordRepoTree (feature_id, tree) VALUES (?, ?) ON CONFLICT (feature_id) DO UPDATE SET tree = excluded.tree`, featureId, tree);
      }
      this.#db.exec(`UPDATE RecordRepoHead SET head = ?, batch_commit = NULL, batch_records = NULL WHERE id = 1`, built.commit);
    });
  }
}

function queuedRecord(row: Row): QueuedRecord {
  return {
    recordId: row["record_id"] as string,
    featureId: row["feature_id"] as string,
    path: row["path"] as string,
    file: row["file"] as string,
    createdAt: Number(row["created_at"]),
  };
}

// Git objects and packs.

const encoder = new TextEncoder();

export type GitObjectType = "commit" | "tree" | "blob";
const PACK_TYPE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3 };

export interface GitObject {
  readonly type: GitObjectType;
  /** The object's SHA-1 ID, over its header and body as Git hashes it. */
  readonly id: string;
  readonly body: Uint8Array;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function idBytes(id: string): Uint8Array {
  return Uint8Array.from(id.match(/../gu) as string[], (pair) => Number.parseInt(pair, 16));
}

export async function gitObject(type: GitObjectType, body: Uint8Array): Promise<GitObject> {
  const digest = await crypto.subtle.digest("SHA-1", concat([encoder.encode(`${type} ${body.length}\0`), body]));
  return { type, id: hex(digest), body };
}

export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "folder";
  readonly id: string;
}

/** A tree's body: Git orders entries by name, a folder's name compared as if it ended in "/". */
export function treeBody(entries: readonly TreeEntry[]): Uint8Array {
  const key = (entry: TreeEntry) => (entry.kind === "folder" ? `${entry.name}/` : entry.name);
  const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return concat(sorted.flatMap((entry) => [encoder.encode(`${entry.kind === "folder" ? "40000" : "100644"} ${entry.name}\0`), idBytes(entry.id)]));
}

/** A commit's body by Penguin at `seconds`, with no parent for the first commit. */
export function commitBody(tree: string, parent: string | null, seconds: number, message: string): Uint8Array {
  const signature = `${AUTHOR} ${seconds} +0000`;
  const lines = [`tree ${tree}`, ...(parent === null ? [] : [`parent ${parent}`]), `author ${signature}`, `committer ${signature}`, "", message];
  return encoder.encode(`${lines.join("\n")}\n`);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An object's pack entry header: its type and size, seven bits a byte after the first four. */
function entryHeader(type: GitObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (PACK_TYPE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
}

/** A version 2 pack of `objects`, each whole and zlib-deflated, ending in the SHA-1 of what precedes it. */
export async function packObjects(objects: readonly GitObject[]): Promise<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) parts.push(entryHeader(object.type, object.body.length), await deflate(object.body));
  const body = concat(parts);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return concat([body, digest]);
}

// A batch as one commit.

/** One batch built as Git objects: the commit, every new object, and what the store keeps once main names it. */
export interface BuiltBatch {
  readonly commit: string;
  readonly objects: readonly GitObject[];
  readonly entries: readonly { readonly recordId: string; readonly featureId: string; readonly blob: string }[];
  readonly trees: ReadonlyMap<string, string>;
}

/** A record's file name in `records/<feature>/`, or undefined when its stored path is not one. */
function fileName(record: QueuedRecord): string | undefined {
  const folder = `records/${record.featureId}/`;
  if (!record.path.startsWith(folder)) return undefined;
  const name = record.path.slice(folder.length);
  return FILE_NAME.test(name) && name === `${record.recordId}.json` ? name : undefined;
}

/**
 * Builds the commit that adds `records` on top of `head`. Each object follows from the records, the
 * committed folders and `head` alone, the time included: the newest record's, so a batch built again
 * is the same commit.
 */
export async function buildBatch(store: RecordRepoStore, records: readonly QueuedRecord[], head: string | null): Promise<BuiltBatch> {
  const featureIds = [...new Set(records.map((record) => record.featureId))];
  const folders = store.committedFiles(featureIds);
  const objects = new Map<string, GitObject>();
  const keep = (object: GitObject) => objects.set(object.id, object);
  const entries: BuiltBatch["entries"][number][] = [];
  for (const record of records) {
    const name = fileName(record);
    if (name === undefined) throw new Error(`record ${record.recordId} has a path outside records/<feature>/`);
    const blob = await gitObject("blob", encoder.encode(record.file));
    keep(blob);
    folders.get(record.featureId)?.set(name, blob.id);
    entries.push({ recordId: record.recordId, featureId: record.featureId, blob: blob.id });
  }
  const trees = new Map<string, string>();
  for (const [featureId, files] of folders) {
    const tree = await gitObject("tree", treeBody([...files].map(([name, id]) => ({ name, kind: "file" as const, id }))));
    keep(tree);
    trees.set(featureId, tree.id);
  }
  const allFolders = new Map([...store.featureTrees(), ...trees]);
  const recordsTree = await gitObject("tree", treeBody([...allFolders].map(([name, id]) => ({ name, kind: "folder" as const, id }))));
  const root = await gitObject("tree", treeBody([{ name: "records", kind: "folder", id: recordsTree.id }]));
  keep(recordsTree);
  keep(root);
  const newest = Math.max(...records.map((record) => record.createdAt));
  const subject = records.length === 1 ? "Add 1 signed record" : `Add ${records.length} signed records`;
  const message = `${subject}\n\n${records.map((record) => record.path).join("\n")}`;
  const commit = await gitObject("commit", commitBody(root.id, head, Math.floor(newest / 1000), message));
  keep(commit);
  return { commit: commit.id, objects: [...objects.values()], entries, trees };
}

// The repo itself.

/** The binding calls that open the record repo, making it first when the project has none. */
export interface RecordRepoBinding<Repo> {
  get(name: string): Promise<Repo>;
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<unknown>;
}

/**
 * The Artifacts error code: the documented `code`, or the message prefix `wrangler dev` passes on
 * when the code is lost over RPC, as apps/worker/src/repos.ts reads it.
 */
function artifactsCode(error: unknown): string | undefined {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  if (typeof message !== "string") return undefined;
  if (/^ArtifactsError: repository not found\b/iu.test(message)) return "NOT_FOUND";
  if (/^ArtifactsError: repo already exists\b/iu.test(message)) return "ALREADY_EXISTS";
  return undefined;
}

/**
 * Opens the record repo. A project set up before the record repo existed has none: the first push
 * makes it with the same create call project setup uses (apps/worker/src/repos.ts), then opens it.
 * A repo another call made in between counts as made.
 */
export async function openRecordRepo<Repo>(artifacts: RecordRepoBinding<Repo>, name: string): Promise<Repo> {
  try {
    return await artifacts.get(name);
  } catch (error) {
    if (artifactsCode(error) !== "NOT_FOUND") throw error;
  }
  try {
    await artifacts.create(name, { description: "Penguin signed feature records", setDefaultBranch: RECORD_BRANCH });
  } catch (error) {
    if (artifactsCode(error) !== "ALREADY_EXISTS") throw error;
  }
  return artifacts.get(name);
}

// The push.

export interface RecordRepoAccess {
  /** The repo's remote and a write token on it for this push alone. */
  readonly endpoint: GitEndpoint;
  /** Revokes the token and releases the repo handle. */
  readonly close: () => Promise<void>;
}

export interface RecordFlushDeps {
  readonly store: RecordRepoStore;
  /** Opens the record repo for one push. Throws when it cannot, such as when the repo does not exist. */
  readonly open: () => Promise<RecordRepoAccess>;
  readonly fetch?: typeof fetch;
  readonly batchLimit?: number;
  readonly timeoutMs?: number;
}

export type RecordFlushOutcome =
  | { readonly status: "idle" }
  /** The batch is on main; `recovered` when an earlier push had already put it there. */
  | { readonly status: "pushed"; readonly commit: string; readonly records: number; readonly recovered: boolean }
  /** Nothing changed on main this time; the batch stays fixed for the next try. */
  | { readonly status: "failed"; readonly reason: string; readonly records: number };

/**
 * Commits the oldest records not yet in the record repo, or the batch already fixed, in one push.
 * The token travels in the Authorization header only and appears in no outcome.
 */
export async function flushRecords(deps: RecordFlushDeps): Promise<RecordFlushOutcome> {
  const { store } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const state = store.state();
  let built: BuiltBatch;
  if (state.batch === null) {
    const records = store.queued(deps.batchLimit ?? RECORD_BATCH_LIMIT);
    if (records.length === 0) return { status: "idle" };
    built = await buildBatch(store, records, state.head);
    store.begin(built.commit, records.map((record) => record.recordId));
  } else {
    const records = store.records(state.batch.recordIds);
    built = await buildBatch(store, records, state.head);
    if (built.commit !== state.batch.commit || records.length !== state.batch.recordIds.length) {
      // The records under the batch changed, which no write here does; a new batch is built next time.
      store.abandon();
      return { status: "failed", reason: "the batch in flight no longer builds the same commit", records: records.length };
    }
  }
  const records = built.entries.length;
  const ref = `refs/heads/${RECORD_BRANCH}`;
  let access: RecordRepoAccess;
  try {
    access = await deps.open();
  } catch (error) {
    return { status: "failed", reason: `the record repo could not be opened: ${(error as Error).message.slice(0, 160)}`, records };
  }
  try {
    const target = await advertisement(fetchImpl, access.endpoint, "git-receive-pack", timeoutMs);
    const before = target.refs.get(ref) ?? null;
    if (before === built.commit) {
      store.committed(built);
      return { status: "pushed", commit: built.commit, records, recovered: true };
    }
    if (before !== state.head) {
      return { status: "failed", reason: `the record repo's ${RECORD_BRANCH} is at ${before ?? "nothing"}, not Penguin's last commit`, records };
    }
    const capabilities = target.capabilities.has("report-status") ? "report-status" : "";
    const command = pktLine(`${before ?? ZERO_ID} ${built.commit} ${ref}\0${capabilities}\n`);
    const answer = readPktStream(
      await request(fetchImpl, repoUrl(access.endpoint.remote, "git-receive-pack"), access.endpoint.token, timeoutMs, {
        service: "git-receive-pack",
        bytes: concat([command, FLUSH, await packObjects(built.objects)]),
      }),
    );
    const after = (await advertisement(fetchImpl, access.endpoint, "git-receive-pack", timeoutMs)).refs.get(ref) ?? null;
    if (after === built.commit) {
      store.committed(built);
      return { status: "pushed", commit: built.commit, records, recovered: false };
    }
    const lines = answer.lines.filter((line): line is string => line !== null);
    const refused = lines.find((line) => line.startsWith(`ng ${ref}`)) ?? lines.find((line) => line.startsWith("unpack ") && line !== "unpack ok");
    return { status: "failed", reason: (refused ?? `the record repo did not move ${RECORD_BRANCH}`).slice(0, 200), records };
  } catch (error) {
    return { status: "failed", reason: (error as Error).message.slice(0, 200), records };
  } finally {
    await access.close();
  }
}
