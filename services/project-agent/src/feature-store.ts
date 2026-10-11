// The project's features (PRD 0.4 sections 4.1 and 9): one fork of main per feature, named
// `feature-<id>`, the area the feature declares, the agent sessions that work on it and the signed
// record of each change to it.
//
// A feature's area is the scopes, paths and contracts it expects to touch. The agent writes it and the
// person may edit it; each checkpoint adds what the feature actually touched (feature-open.ts). Scope
// and contract names come from the base repo's `penguin/scopes.json`, never from this module.
//
// Every caller-supplied value is checked for charset, length and count before it is stored, and
// reaches SQL as a bound parameter. A value that fails is refused, never cleaned up and kept.

import { canonicalBytes, toBase64Url } from "@penguin/issues";
import { formatOpId, SEGMENT_PATTERN, WEB_WRITER_TAG, authorSegment, type Author } from "@penguin/protocol";
import { InvalidPathError, normalizeRepoPath, parseContract, type ScopeMap } from "@penguin/scope-map";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const FEATURE_LIMITS = {
  idLength: 63,
  scopeIdLength: 128,
  scopes: 64,
  /** Paths a declaration names; a checkpoint may add more, up to `recordedPaths`. */
  paths: 256,
  recordedPaths: 2_000,
  pathLength: 512,
  contracts: 256,
} as const;

/** Lowercase letters and digits joined by single dots or hyphens: no leading dash, no "..", no "/". */
const FEATURE_ID = new RegExp(`^${SEGMENT_PATTERN}$`, "u");
/** A scope id as an area names it; it must also be a scope in the scope map. */
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/**
 * One segment of an area path: letters, digits, '_', '.' and '-', not starting with '-'. Spaces,
 * shell metacharacters and markup cannot appear, so a path is inert wherever it is shown or passed.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/u;

/** `building` once the fork exists; `opening` while the record exists and the fork does not yet. */
export type FeatureState = "opening" | "building";

export interface FeatureArea {
  readonly scopes: readonly string[];
  readonly paths: readonly string[];
  readonly contracts: readonly string[];
}

export interface Feature {
  readonly id: string;
  /** The person who owns the feature. */
  readonly personId: string;
  /** The fork's Artifacts repo name, with the deployment's repo prefix, or null before it is made. */
  readonly repo: string | null;
  readonly area: FeatureArea;
  readonly state: FeatureState;
  readonly openedAt: string;
  /** The latest checkpoint that updated the area, or null. */
  readonly latestCheckpointSha: string | null;
  readonly updatedAt: string;
}

/** The record types this module writes: the opening, a declaration and a checkpoint's update. */
export type FeatureRecordType = "open_feature" | "declare_area" | "checkpoint_area";

export interface FeatureRecord {
  readonly schema_version: 1;
  readonly record_id: string;
  readonly feature: string;
  readonly type: FeatureRecordType;
  readonly author: Author;
  readonly created_at: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Ed25519 over the canonical JSON of every other field, base64url, as issue operations are signed. */
  readonly signature: string;
}

export type UnsignedFeatureRecord = Omit<FeatureRecord, "signature">;

/** One stored record: its future path in the record repo and its signed JSON. */
export interface StoredFeatureRecord {
  readonly recordId: string;
  readonly featureId: string;
  readonly path: string;
  readonly file: string;
}

export const FEATURE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS Feature (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, repo TEXT, area_scopes TEXT NOT NULL,
    area_paths TEXT NOT NULL, area_contracts TEXT NOT NULL, state TEXT NOT NULL,
    opened_at INTEGER NOT NULL, latest_checkpoint_sha TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS Feature_person ON Feature (person_id, opened_at)`,
  // The agent sessions of a feature. A session works on one feature (PRD section 1, Session).
  `CREATE TABLE IF NOT EXISTS FeatureSession (
    session_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, joined_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS FeatureSession_feature ON FeatureSession (feature_id)`,
  // Signed records, kept here until the record repo takes them (PRD section 9).
  `CREATE TABLE IF NOT EXISTS FeatureRecord (
    record_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, author_segment TEXT NOT NULL,
    seq INTEGER NOT NULL, path TEXT NOT NULL, file TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS FeatureRecord_feature ON FeatureRecord (feature_id, created_at)`,
];

export const EMPTY_AREA: FeatureArea = { scopes: [], paths: [], contracts: [] };

/** The feature id, or undefined when it fails the charset or length rule. */
export function parseFeatureId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= FEATURE_LIMITS.idLength && FEATURE_ID.test(value)
    ? value
    : undefined;
}

/** A path normalized and checked segment by segment, or undefined. */
export function parseAreaPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > FEATURE_LIMITS.pathLength) return undefined;
  let path: string;
  try {
    path = normalizeRepoPath(value);
  } catch (error) {
    if (error instanceof InvalidPathError) return undefined;
    throw error;
  }
  return path.split("/").every((segment) => PATH_SEGMENT.test(segment)) ? path : undefined;
}

export type AreaParse = { readonly ok: true; readonly area: FeatureArea } | { readonly ok: false; readonly message: string };

/**
 * Validates an area declaration `{ scopes, paths, contracts }`, each an optional array. Scopes must
 * be scopes of `scopeMap`, contracts must be contracts one of its scopes declares, and paths must
 * pass `parseAreaPath`. Messages name the field, never echo the value.
 */
export function parseArea(value: unknown, scopeMap: ScopeMap): AreaParse {
  if (value === undefined) return { ok: true, area: EMPTY_AREA };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "area must be an object with scopes, paths and contracts" };
  }
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !["scopes", "paths", "contracts"].includes(key));
  if (unknown !== undefined) return { ok: false, message: "area takes only scopes, paths and contracts" };

  const list = (key: string, max: number): unknown[] | string => {
    const items = fields[key] ?? [];
    if (!Array.isArray(items)) return `area.${key} must be an array`;
    if (items.length > max) return `area.${key} holds more than ${max} entries`;
    return items;
  };
  const scopes = list("scopes", FEATURE_LIMITS.scopes);
  const paths = list("paths", FEATURE_LIMITS.paths);
  const contracts = list("contracts", FEATURE_LIMITS.contracts);
  for (const problem of [scopes, paths, contracts]) if (typeof problem === "string") return { ok: false, message: problem };

  const area = { scopes: new Set<string>(), paths: new Set<string>(), contracts: new Set<string>() };
  for (const [index, scope] of (scopes as unknown[]).entries()) {
    const valid = typeof scope === "string" && scope.length <= FEATURE_LIMITS.scopeIdLength && SCOPE_ID.test(scope);
    if (!valid || !scopeMap.scopes.has(scope)) {
      return { ok: false, message: `area.scopes[${index}] is not a scope in penguin/scopes.json` };
    }
    area.scopes.add(scope);
  }
  for (const [index, raw] of (paths as unknown[]).entries()) {
    const path = parseAreaPath(raw);
    if (path === undefined) {
      return {
        ok: false,
        message: `area.paths[${index}] must be a relative path of letters, digits, '_', '.', '-' and '/' with no '..' and no segment starting with '-'`,
      };
    }
    area.paths.add(path);
  }
  for (const [index, raw] of (contracts as unknown[]).entries()) {
    const parsed = parseContract(raw);
    const known = parsed.ok && parseAreaPath(parsed.path) !== undefined && scopeMap.contracts.has(parsed.contract);
    if (!known || !parsed.ok) {
      return { ok: false, message: `area.contracts[${index}] is not a contract in penguin/scopes.json` };
    }
    area.contracts.add(parsed.contract);
  }
  return { ok: true, area: sortedArea(area.scopes, area.paths, area.contracts) };
}

function sortedArea(scopes: Iterable<string>, paths: Iterable<string>, contracts: Iterable<string>): FeatureArea {
  return { scopes: [...scopes].sort(), paths: [...paths].sort(), contracts: [...contracts].sort() };
}

/** Signs a record with the service key, over the same canonical JSON issue operations use. */
export async function signFeatureRecord(record: UnsignedFeatureRecord, privateKey: CryptoKey): Promise<FeatureRecord> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, canonicalBytes(record));
  return { ...record, signature: toBase64Url(new Uint8Array(signature)) };
}

/** The record's path in the record repo: `records/<feature>/<author>-<writer>-<seq>.json` (PRD section 9). */
export function featureRecordPath(record: Pick<FeatureRecord, "feature" | "record_id">): string {
  return `records/${record.feature}/${record.record_id}.json`;
}

export class FeatureStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of FEATURE_SCHEMA) db.exec(statement);
  }

  get(id: string): Feature | undefined {
    const [row] = this.#db.exec(`SELECT * FROM Feature WHERE id = ?`, id);
    return row === undefined ? undefined : feature(row);
  }

  /** Every feature, newest first. */
  list(): Feature[] {
    return this.#db.exec(`SELECT * FROM Feature ORDER BY opened_at DESC, id`).map(feature);
  }

  /**
   * The unsigned record for the next change by `author` to feature `featureId`. Its sequence number
   * counts that author's records across every feature, so record ids never repeat.
   */
  draftRecord(featureId: string, type: FeatureRecordType, author: Author, payload: Record<string, unknown>): UnsignedFeatureRecord {
    const segment = authorSegment(author);
    const [row] = this.#db.exec(`SELECT COALESCE(MAX(seq), 0) AS seq FROM FeatureRecord WHERE author_segment = ?`, segment);
    const seq = Number(row?.["seq"] ?? 0) + 1;
    return {
      schema_version: 1,
      record_id: formatOpId(author, WEB_WRITER_TAG, seq),
      feature: featureId,
      type,
      author,
      created_at: new Date(this.#now()).toISOString(),
      payload,
    };
  }

  /**
   * Inserts a new feature with its opening record. Returns false, writing nothing, when a feature
   * with this id already exists.
   */
  insert(id: string, personId: string, area: FeatureArea, record: FeatureRecord): boolean {
    return this.#db.transaction(() => {
      if (this.get(id) !== undefined) return false;
      const now = this.#now();
      this.#db.exec(
        `INSERT INTO Feature (id, person_id, repo, area_scopes, area_paths, area_contracts, state, opened_at,
           latest_checkpoint_sha, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'opening', ?, NULL, ?)`,
        id,
        personId,
        JSON.stringify(area.scopes),
        JSON.stringify(area.paths),
        JSON.stringify(area.contracts),
        now,
        now,
      );
      this.#appendRecord(record);
      return true;
    });
  }

  /** Records the fork made for the feature; the feature is then `building`. */
  setRepo(id: string, repo: string): Feature | undefined {
    this.#db.exec(
      `UPDATE Feature SET repo = ?, state = 'building', updated_at = ? WHERE id = ?`,
      repo,
      this.#now(),
      id,
    );
    return this.get(id);
  }

  /** Replaces the feature's area with its record; `checkpoint` is the checkpoint that changed it, if any. */
  setArea(id: string, area: FeatureArea, record: FeatureRecord, checkpoint: string | null): Feature | undefined {
    return this.#db.transaction(() => {
      this.#db.exec(
        `UPDATE Feature SET area_scopes = ?, area_paths = ?, area_contracts = ?,
           latest_checkpoint_sha = COALESCE(?, latest_checkpoint_sha), updated_at = ? WHERE id = ?`,
        JSON.stringify(area.scopes),
        JSON.stringify(area.paths),
        JSON.stringify(area.contracts),
        checkpoint,
        this.#now(),
        id,
      );
      this.#appendRecord(record);
      return this.get(id);
    });
  }

  /**
   * Makes `sessionId` an agent of feature `featureId`. Returns the feature the session already works
   * on when that is another one, and writes nothing then.
   */
  join(featureId: string, sessionId: string): { readonly joined: true } | { readonly joined: false; readonly featureId: string } {
    return this.#db.transaction(() => {
      const current = this.featureOfSession(sessionId);
      if (current !== undefined && current !== featureId) return { joined: false, featureId: current };
      this.#db.exec(
        `INSERT OR IGNORE INTO FeatureSession (session_id, feature_id, joined_at) VALUES (?, ?, ?)`,
        sessionId,
        featureId,
        this.#now(),
      );
      return { joined: true };
    });
  }

  /** The feature a session works on, or undefined. */
  featureOfSession(sessionId: string): string | undefined {
    const [row] = this.#db.exec(`SELECT feature_id FROM FeatureSession WHERE session_id = ?`, sessionId);
    return row === undefined ? undefined : (row["feature_id"] as string);
  }

  /** The ids of a feature's agent sessions, in the order they joined. */
  sessions(featureId: string): string[] {
    return this.#db
      .exec(`SELECT session_id FROM FeatureSession WHERE feature_id = ? ORDER BY joined_at, rowid`, featureId)
      .map((row) => row["session_id"] as string);
  }

  /** A feature's signed records, oldest first. */
  records(featureId: string): StoredFeatureRecord[] {
    return this.#db
      .exec(`SELECT record_id, feature_id, path, file FROM FeatureRecord WHERE feature_id = ? ORDER BY created_at, rowid`, featureId)
      .map((row) => ({
        recordId: row["record_id"] as string,
        featureId: row["feature_id"] as string,
        path: row["path"] as string,
        file: row["file"] as string,
      }));
  }

  #appendRecord(record: FeatureRecord): void {
    this.#db.exec(
      `INSERT INTO FeatureRecord (record_id, feature_id, author_segment, seq, path, file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.record_id,
      record.feature,
      authorSegment(record.author),
      Number(record.record_id.slice(record.record_id.lastIndexOf("-") + 1)),
      featureRecordPath(record),
      JSON.stringify(record),
      this.#now(),
    );
  }
}

/** The union of `area` and the paths a checkpoint changed, with the scopes those paths fall in. */
export function extendArea(
  area: FeatureArea,
  addedScopes: Iterable<string>,
  addedPaths: Iterable<string>,
): { readonly area: FeatureArea; readonly omittedPaths: number } {
  const declared = new Set(area.paths);
  // A changed file under a declared directory is already covered by it.
  const covered = (path: string) => {
    const segments = path.split("/");
    return segments.some((_, index) => declared.has(segments.slice(0, index + 1).join("/")));
  };
  const paths = new Set(area.paths);
  let omittedPaths = 0;
  for (const path of [...addedPaths].sort()) {
    if (covered(path) || paths.has(path)) continue;
    if (paths.size >= FEATURE_LIMITS.recordedPaths) omittedPaths += 1;
    else paths.add(path);
  }
  return { area: sortedArea(new Set([...area.scopes, ...addedScopes]), paths, area.contracts), omittedPaths };
}

function feature(row: Row): Feature {
  const list = (key: string) => JSON.parse(row[key] as string) as string[];
  const checkpoint = row["latest_checkpoint_sha"];
  return {
    id: row["id"] as string,
    personId: row["person_id"] as string,
    repo: (row["repo"] as string | null) ?? null,
    area: { scopes: list("area_scopes"), paths: list("area_paths"), contracts: list("area_contracts") },
    state: row["state"] as FeatureState,
    openedAt: new Date(Number(row["opened_at"])).toISOString(),
    latestCheckpointSha: typeof checkpoint === "string" ? checkpoint : null,
    updatedAt: new Date(Number(row["updated_at"])).toISOString(),
  };
}
