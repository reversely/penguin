// The ProjectAgent's agent identities (PRD sections 1, 5 and 7). An owner creates, edits and
// duplicates identities; a team identity serves several owners. Each identity carries a charter: the
// scopes and paths it may change, its durable rules and whether it accepts assignments automatically.
// The avatar is a small image kept in the identity's row, with a size cap (decided in #23).
//
// Every caller-supplied value is checked against a length cap before it is stored, and reaches SQL as
// a bound parameter.

import { fromBase64Url, toBase64Url, type CharterIdentity } from "@penguin/issues";
import {
  IDENTITY_HANDLE_MAX_LENGTH,
  IDENTITY_HANDLE_PATTERN,
  PENGUIN_AUTHOR_SEGMENT,
  PERSON_ID_MAX_LENGTH,
  PERSON_ID_PATTERN,
} from "@penguin/protocol";
import { InvalidPathError, normalizeRepoPath, type ScopeMap } from "@penguin/scope-map";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

export const IDENTITY_LIMITS = {
  nameLength: 80,
  jobLength: 1_000,
  rules: 32,
  ruleLength: 1_000,
  scopes: 32,
  paths: 64,
  pathLength: 512,
  teamOwners: 16,
  /** Bytes of the decoded avatar image. */
  avatarBytes: 65_536,
} as const;

/**
 * The image types an avatar may have, each with the leading bytes its file must start with. SVG is
 * excluded: it can carry script.
 */
const AVATAR_SIGNATURES: Readonly<Record<AvatarMediaType, readonly (readonly (number | null)[])[]>> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  // "RIFF", four length bytes, "WEBP".
  "image/webp": [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
};

export type AvatarMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface Avatar {
  readonly mediaType: AvatarMediaType;
  readonly data: Uint8Array;
}

export interface Identity extends CharterIdentity {
  readonly id: string;
  readonly name: string;
  readonly avatar: Avatar | null;
  readonly job: string;
  readonly charterRules: readonly string[];
  readonly autoAccept: boolean;
  /** The id of the identity this one was duplicated from, or null. */
  readonly duplicatedFrom: string | null;
}

/** A new identity. The handle's owner half must be the caller. */
export interface IdentityInput {
  readonly handle: string;
  readonly name: string;
  readonly avatar?: Avatar | null;
  readonly job: string;
  readonly charterScopes: readonly string[];
  readonly charterPaths?: readonly string[];
  readonly charterRules?: readonly string[];
  readonly autoAccept?: boolean;
}

/** A new team identity and the owners it serves, the caller among them. */
export interface TeamIdentityInput extends IdentityInput {
  readonly owners: readonly string[];
}

/** The fields an edit may change. The handle, the owners and `duplicatedFrom` stay fixed. */
export type IdentityChanges = Partial<Omit<IdentityInput, "handle">>;

export type IdentityRejectReason = "invalid" | "forbidden" | "not_found" | "handle_taken";

export type IdentityOutcome =
  | { readonly status: "ok"; readonly identity: Identity }
  | { readonly status: "rejected"; readonly reason: IdentityRejectReason; readonly message: string };

const SCHEMA = [
  // A personal identity has owner_id; a team identity has team = 1, a null owner_id and its owners in
  // IdentityOwner (PRD section 7: "owner_id or team").
  `CREATE TABLE IF NOT EXISTS Identity (
    id TEXT PRIMARY KEY, owner_id TEXT, team INTEGER NOT NULL, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    avatar_type TEXT, avatar TEXT, job TEXT NOT NULL, charter_scopes TEXT NOT NULL, charter_paths TEXT NOT NULL,
    charter_rules TEXT NOT NULL, auto_accept INTEGER NOT NULL, duplicated_from TEXT,
    CHECK ((team = 0) = (owner_id IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS IdentityOwner (
    identity_id TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY (identity_id, owner_id))`,
];

const PERSON_ID = new RegExp(PERSON_ID_PATTERN, "u");
const HANDLE = new RegExp(IDENTITY_HANDLE_PATTERN, "u");
// Control characters, except a line feed where multi-line text is allowed.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/u;

class Invalid extends Error {}

export class IdentityStore {
  readonly #db: SqlDatabase;
  readonly #newId: () => string;

  constructor(db: SqlDatabase, newId: () => string = () => crypto.randomUUID()) {
    this.#db = db;
    this.#newId = newId;
    for (const statement of SCHEMA) db.exec(statement);
  }

  /** Creates a personal identity owned by `caller`, the person the gateway authenticated. */
  create(caller: string, input: IdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    return this.#create(caller, input, null, scopeMap);
  }

  /** Creates a team identity that serves `input.owners`. The caller must be one of them. */
  createTeam(caller: string, input: TeamIdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    // RPC callers are untyped: a null input reaches #create, which rejects it.
    return this.#create(caller, input, input?.owners ?? [], scopeMap);
  }

  /** Changes an identity's fields. Only its owner, or one of a team identity's owners, may. */
  edit(caller: string, id: string, changes: IdentityChanges, scopeMap: ScopeMap): IdentityOutcome {
    return guarded(() => {
      const current = this.get(id);
      if (current === undefined) return notFound(id);
      const denied = this.#editDenied(caller, current, "edit");
      if (denied !== undefined) return denied;
      const next: Identity = {
        ...current,
        ...fields(changes, current, scopeMap),
      };
      this.#db.exec(
        `UPDATE Identity SET name = ?, avatar_type = ?, avatar = ?, job = ?, charter_scopes = ?, charter_paths = ?,
           charter_rules = ?, auto_accept = ? WHERE id = ?`,
        next.name,
        next.avatar?.mediaType ?? null,
        next.avatar === null ? null : toBase64Url(next.avatar.data),
        next.job,
        JSON.stringify(next.charterScopes),
        JSON.stringify(next.charterPaths),
        JSON.stringify(next.charterRules),
        next.autoAccept ? 1 : 0,
        id,
      );
      return { status: "ok", identity: next };
    });
  }

  /**
   * Copies an identity under a new handle and id, for a new scope. The charter, job and avatar carry
   * over and `duplicatedFrom` names the original. The copy starts with no history: issue assignments
   * and operations name the original's handle, so they stay with the original.
   */
  duplicate(caller: string, id: string, copy: { readonly handle: string; readonly name?: string }): IdentityOutcome {
    return guarded(() => {
      const original = this.get(id);
      if (original === undefined) return notFound(id);
      const denied = this.#editDenied(caller, original, "duplicate");
      if (denied !== undefined) return denied;
      const handle = callerHandle(caller, copy.handle);
      const name =
        copy.name === undefined ? original.name : text("name", copy.name, IDENTITY_LIMITS.nameLength, CONTROL);
      return this.#insert({ ...original, id: this.#newId(), handle, name, duplicatedFrom: original.id });
    });
  }

  /** The identity with this id, or undefined. */
  get(id: string): Identity | undefined {
    const [row] = this.#db.exec(`SELECT * FROM Identity WHERE id = ?`, id);
    return row === undefined ? undefined : this.#identity(row);
  }

  /** The identity with this handle, or undefined. */
  byHandle(handle: string): Identity | undefined {
    const [row] = this.#db.exec(`SELECT * FROM Identity WHERE handle = ?`, handle);
    return row === undefined ? undefined : this.#identity(row);
  }

  #create(caller: string, input: IdentityInput, owners: readonly string[] | null, scopeMap: ScopeMap): IdentityOutcome {
    return guarded(() => {
      if (typeof input !== "object" || input === null) throw new Invalid("the identity must be an object");
      for (const field of ["name", "job", "charterScopes"] as const) {
        if (input[field] === undefined) throw new Invalid(`${field} is required`);
      }
      const handle = callerHandle(caller, input.handle);
      const teamOwners = owners === null ? [] : teamOwnerList(caller, owners);
      const base: Identity = {
        id: this.#newId(),
        handle,
        ownerId: owners === null ? caller : null,
        teamOwners,
        name: "",
        avatar: null,
        job: "",
        charterScopes: [],
        charterPaths: [],
        charterRules: [],
        autoAccept: false,
        duplicatedFrom: null,
      };
      return this.#insert({ ...base, ...fields(input, base, scopeMap) });
    });
  }

  #insert(identity: Identity): IdentityOutcome {
    if (this.#db.exec(`SELECT 1 FROM Identity WHERE handle = ?`, identity.handle).length > 0) {
      return { status: "rejected", reason: "handle_taken", message: `${identity.handle} already exists` };
    }
    this.#db.transaction(() => {
      this.#db.exec(
        `INSERT INTO Identity (id, owner_id, team, handle, name, avatar_type, avatar, job, charter_scopes,
           charter_paths, charter_rules, auto_accept, duplicated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        identity.id,
        identity.ownerId,
        identity.ownerId === null ? 1 : 0,
        identity.handle,
        identity.name,
        identity.avatar?.mediaType ?? null,
        identity.avatar === null ? null : toBase64Url(identity.avatar.data),
        identity.job,
        JSON.stringify(identity.charterScopes),
        JSON.stringify(identity.charterPaths),
        JSON.stringify(identity.charterRules),
        identity.autoAccept ? 1 : 0,
        identity.duplicatedFrom,
      );
      for (const owner of identity.teamOwners) {
        this.#db.exec(`INSERT INTO IdentityOwner (identity_id, owner_id) VALUES (?, ?)`, identity.id, owner);
      }
    });
    return { status: "ok", identity };
  }

  #editDenied(caller: string, identity: Identity, action: string): IdentityOutcome | undefined {
    const owners = identity.ownerId === null ? identity.teamOwners : [identity.ownerId];
    if (owners.includes(caller)) return undefined;
    return {
      status: "rejected",
      reason: "forbidden",
      message: `only ${identity.handle}'s owner (${owners.join(", ")}) can ${action} it; ${String(caller)} cannot`,
    };
  }

  #identity(row: Row): Identity {
    const id = row["id"] as string;
    const ownerId = (row["owner_id"] as string | null) ?? null;
    const avatarType = (row["avatar_type"] as AvatarMediaType | null) ?? null;
    const avatarData = avatarType === null ? null : fromBase64Url(row["avatar"] as string);
    const teamOwners =
      ownerId === null
        ? this.#db
            .exec(`SELECT owner_id FROM IdentityOwner WHERE identity_id = ? ORDER BY rowid`, id)
            .map((owner) => owner["owner_id"] as string)
        : [];
    return {
      id,
      handle: row["handle"] as string,
      ownerId,
      teamOwners,
      name: row["name"] as string,
      avatar: avatarType === null || avatarData === null ? null : { mediaType: avatarType, data: avatarData },
      job: row["job"] as string,
      charterScopes: JSON.parse(row["charter_scopes"] as string) as string[],
      charterPaths: JSON.parse(row["charter_paths"] as string) as string[],
      charterRules: JSON.parse(row["charter_rules"] as string) as string[],
      autoAccept: Number(row["auto_accept"]) === 1,
      duplicatedFrom: (row["duplicated_from"] as string | null) ?? null,
    };
  }
}

/** Runs `body`, turning a failed field check into an "invalid" rejection. */
function guarded(body: () => IdentityOutcome): IdentityOutcome {
  try {
    return body();
  } catch (error) {
    if (error instanceof Invalid) return { status: "rejected", reason: "invalid", message: error.message };
    throw error;
  }
}

function notFound(id: string): IdentityOutcome {
  return { status: "rejected", reason: "not_found", message: `no identity has id ${String(id)}` };
}

/** Checks the changed fields of `changes` and returns them, checked and normalized. */
function fields(changes: IdentityChanges, current: Identity, scopeMap: ScopeMap): Partial<Identity> {
  if (typeof changes !== "object" || changes === null) throw new Invalid("the changes must be an object");
  const out: { -readonly [K in keyof Identity]?: Identity[K] } = {};
  if (changes.name !== undefined) out.name = text("name", changes.name, IDENTITY_LIMITS.nameLength, CONTROL);
  if (changes.job !== undefined) out.job = text("job", changes.job, IDENTITY_LIMITS.jobLength, CONTROL_BUT_NEWLINE);
  if (changes.avatar !== undefined) out.avatar = avatar(changes.avatar);
  if (changes.autoAccept !== undefined) {
    if (typeof changes.autoAccept !== "boolean") throw new Invalid("autoAccept must be true or false");
    out.autoAccept = changes.autoAccept;
  }
  if (changes.charterRules !== undefined) {
    out.charterRules = list("charterRules", changes.charterRules, IDENTITY_LIMITS.rules).map((rule, index) =>
      text(`charterRules[${index}]`, rule, IDENTITY_LIMITS.ruleLength, CONTROL_BUT_NEWLINE),
    );
  }
  if (changes.charterPaths !== undefined) {
    out.charterPaths = unique(
      list("charterPaths", changes.charterPaths, IDENTITY_LIMITS.paths).map((path, index) => repoPath(index, path)),
    );
  }
  if (changes.charterScopes !== undefined) {
    const owners = current.ownerId === null ? current.teamOwners : [current.ownerId];
    out.charterScopes = unique(list("charterScopes", changes.charterScopes, IDENTITY_LIMITS.scopes)).map((scope) =>
      ownedScope(scope, owners, scopeMap),
    );
  }
  return out;
}

/**
 * A charter scope must exist and belong to the identity's owner, or for a team identity to one of
 * its owners: an owner cannot grant an identity the right to change another owner's scope.
 */
function ownedScope(scope: unknown, owners: readonly string[], scopeMap: ScopeMap): string {
  if (typeof scope !== "string") throw new Invalid("each charter scope must be a scope id");
  const found = scopeMap.scopes.get(scope);
  if (found === undefined) {
    throw new Invalid(`charter scope ${JSON.stringify(scope.slice(0, 64))} is not in the scope map`);
  }
  if (!owners.includes(found.ownerId)) {
    throw new Invalid(`charter scope ${scope} belongs to ${found.ownerId}, not to ${owners.join(" or ")}`);
  }
  return scope;
}

/** The handle, when it is well formed and its owner half is the caller. */
function callerHandle(caller: string, handle: unknown): string {
  personId("the caller", caller);
  if (typeof handle !== "string" || handle.length > IDENTITY_HANDLE_MAX_LENGTH || !HANDLE.test(handle)) {
    throw new Invalid(`handle must match @<owner>/<name> in lowercase letters, digits and hyphens`);
  }
  const owner = handle.slice(1, handle.indexOf("/"));
  if (owner !== caller) throw new Invalid(`handle ${handle} must begin with the caller, @${caller}/`);
  return handle;
}

function teamOwnerList(caller: string, owners: unknown): string[] {
  const list = unique(listOf("owners", owners, IDENTITY_LIMITS.teamOwners));
  list.forEach((owner, index) => personId(`owners[${index}]`, owner));
  if (list.length < 2) throw new Invalid("a team identity serves at least two owners");
  if (!list.includes(caller)) throw new Invalid(`the caller, ${caller}, must be one of the team identity's owners`);
  return list as string[];
}

function personId(field: string, value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > PERSON_ID_MAX_LENGTH ||
    !PERSON_ID.test(value) ||
    value === PENGUIN_AUTHOR_SEGMENT
  ) {
    throw new Invalid(`${field} must be a person id`);
  }
}

function text(field: string, value: unknown, max: number, forbidden: RegExp): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Invalid(`${field} must be non-empty text`);
  if (value.length > max) throw new Invalid(`${field} is longer than ${max} characters`);
  if (forbidden.test(value)) throw new Invalid(`${field} contains a control character`);
  return value;
}

function list(field: string, value: unknown, max: number): string[] {
  return listOf(field, value, max) as string[];
}

function listOf(field: string, value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Invalid(`${field} must be a list`);
  if (value.length > max) throw new Invalid(`${field} holds more than ${max} entries`);
  return value;
}

function repoPath(index: number, value: unknown): string {
  const field = `charterPaths[${index}]`;
  if (typeof value !== "string" || value.length > IDENTITY_LIMITS.pathLength) {
    throw new Invalid(`${field} must be a path of at most ${IDENTITY_LIMITS.pathLength} characters`);
  }
  if (CONTROL.test(value)) throw new Invalid(`${field} contains a control character`);
  try {
    return normalizeRepoPath(value);
  } catch (error) {
    if (error instanceof InvalidPathError) throw new Invalid(`${field}: ${error.message}`);
    throw error;
  }
}

function avatar(value: unknown): Avatar | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new Invalid("avatar must be an image or null");
  const { mediaType, data } = value as Partial<Avatar>;
  if (typeof mediaType !== "string" || !Object.hasOwn(AVATAR_SIGNATURES, mediaType)) {
    throw new Invalid(`avatar must be one of ${Object.keys(AVATAR_SIGNATURES).join(", ")}`);
  }
  const signatures = AVATAR_SIGNATURES[mediaType];
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Invalid("avatar data must be bytes");
  if (data.byteLength > IDENTITY_LIMITS.avatarBytes) {
    throw new Invalid(`avatar is larger than ${IDENTITY_LIMITS.avatarBytes} bytes`);
  }
  const matches = signatures.some((signature) => signature.every((byte, i) => byte === null || data[i] === byte));
  if (!matches) throw new Invalid(`avatar data is not a ${mediaType} image`);
  return { mediaType: mediaType as AvatarMediaType, data: Uint8Array.from(data) };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
