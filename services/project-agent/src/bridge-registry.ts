// The ProjectAgent's bridge registry: one-time registration codes, registered bridges with their
// owner, role and public signing key, and bridge tokens. Codes and bridge tokens are stored only as
// SHA-256 hashes; their plaintext leaves this module once, in the call that made it.

import { importPublicKey, toBase64Url, verifyBridgeRequest, type BridgeKey } from "@penguin/issues";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

/** An owner bridge publishes to its owner's fork; a runner bridge also writes to Huddle repos. */
export type BridgeRole = "owner" | "runner";

export const BRIDGE_ROLES: readonly BridgeRole[] = ["owner", "runner"];

export interface RegistrationCode {
  /** The one-time code, returned only here. */
  readonly code: string;
  readonly ownerId: string;
  readonly role: BridgeRole;
  readonly expiresAt: string;
}

/** A bridge that authenticated with its bridge token. */
export interface BridgeIdentity {
  readonly bridgeId: string;
  readonly ownerId: string;
  readonly role: BridgeRole;
}

export interface RegisteredBridge extends BridgeIdentity {
  /** The bridge token, returned only here. */
  readonly bridgeToken: string;
}

export type RegisterOutcome =
  | { readonly status: "registered"; readonly bridge: RegisteredBridge }
  | { readonly status: "invalid_code" }
  | { readonly status: "invalid_key"; readonly message: string };

const CODE_PREFIX = "pgr_";
const TOKEN_PREFIX = "pgb_";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS BridgeRegistrationCode (
    code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL,
    used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS Bridge (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, role TEXT NOT NULL, public_key TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, registered_at INTEGER NOT NULL, revoked_at INTEGER)`,
];

function randomSecret(prefix: string): string {
  return prefix + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduces a submitted key to its public Ed25519 members. A key carrying the private member `d` is
 * refused rather than stripped, so a bridge that sent its private key learns that it did.
 */
async function publicSigningJwk(value: unknown): Promise<JsonWebKey | string> {
  if (!isRecord(value) || value.kty !== "OKP" || value.crv !== "Ed25519" || typeof value.x !== "string") {
    return "publicKey must be an Ed25519 public JWK with kty OKP, crv Ed25519 and x";
  }
  if ("d" in value) return "publicKey holds a private key member; send the public key only";
  const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: value.x };
  try {
    await importPublicKey(jwk);
  } catch {
    return "publicKey is not a valid Ed25519 public key";
  }
  return jwk;
}

export class BridgeRegistry {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of SCHEMA) db.exec(statement);
  }

  /** Issues a one-time code that registers one bridge for `ownerId` with `role`. */
  async issueCode(ownerId: string, role: BridgeRole, ttlSeconds: number): Promise<RegistrationCode> {
    const code = randomSecret(CODE_PREFIX);
    const expiresAt = this.#now() + ttlSeconds * 1000;
    this.#db.exec(
      `INSERT INTO BridgeRegistrationCode (code_hash, owner_id, role, expires_at) VALUES (?, ?, ?, ?)`,
      await sha256Hex(code),
      ownerId,
      role,
      expiresAt,
    );
    return { code, ownerId, role, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Spends a registration code and records a bridge with its public signing key. A code works once
   * and only before it expires; a refused key leaves the code unspent.
   */
  async register(code: string, publicKey: unknown): Promise<RegisterOutcome> {
    const jwk = await publicSigningJwk(publicKey);
    if (typeof jwk === "string") return { status: "invalid_key", message: jwk };
    const [codeHash, bridgeToken] = [await sha256Hex(code), randomSecret(TOKEN_PREFIX)];
    const tokenHash = await sha256Hex(bridgeToken);
    const bridgeId = `br_${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
    const now = this.#now();

    const identity = this.#db.transaction((): BridgeIdentity | undefined => {
      const [spent] = this.#db.exec(
        `UPDATE BridgeRegistrationCode SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING owner_id, role`,
        now,
        codeHash,
        now,
      );
      if (spent === undefined) return undefined;
      const ownerId = String(spent["owner_id"]);
      const role = spent["role"] as BridgeRole;
      this.#db.exec(
        `INSERT INTO Bridge (id, owner_id, role, public_key, token_hash, registered_at) VALUES (?, ?, ?, ?, ?, ?)`,
        bridgeId,
        ownerId,
        role,
        JSON.stringify(jwk),
        tokenHash,
        now,
      );
      return { bridgeId, ownerId, role };
    });
    if (identity === undefined) return { status: "invalid_code" };
    return { status: "registered", bridge: { ...identity, bridgeToken } };
  }

  /** The registered, unrevoked bridge holding `bridgeToken`, or undefined. */
  async authenticate(bridgeToken: string): Promise<BridgeIdentity | undefined> {
    if (!bridgeToken.startsWith(TOKEN_PREFIX)) return undefined;
    const [row] = this.#db.exec(
      `SELECT id, owner_id, role FROM Bridge WHERE token_hash = ? AND revoked_at IS NULL`,
      await sha256Hex(bridgeToken),
    );
    return row === undefined ? undefined : identityOf(row);
  }

  /** Revokes a bridge. Returns false when no unrevoked bridge has that id. */
  revoke(bridgeId: string): boolean {
    const rows = this.#db.exec(
      `UPDATE Bridge SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id`,
      this.#now(),
      bridgeId,
    );
    return rows.length > 0;
  }

  /**
   * True only when `body` carries a signature over `route` and the rest of the body by the registered
   * key of unrevoked bridge `bridgeId` (`verifyBridgeRequest` in @penguin/issues).
   */
  async verifyRequest(bridgeId: string, route: string, body: Record<string, unknown>): Promise<boolean> {
    const [row] = this.#db.exec(`SELECT public_key FROM Bridge WHERE id = ? AND revoked_at IS NULL`, bridgeId);
    if (row === undefined) return false;
    const publicKey = await importPublicKey(JSON.parse(String(row["public_key"])) as JsonWebKey);
    return verifyBridgeRequest(route, body, publicKey);
  }

  /** The signing keys of every unrevoked bridge, for operation validation. */
  async bridgeKeys(): Promise<BridgeKey[]> {
    const rows = this.#db.exec(`SELECT id, owner_id, public_key FROM Bridge WHERE revoked_at IS NULL ORDER BY id`);
    return Promise.all(
      rows.map(async (row) => ({
        bridgeId: String(row["id"]),
        ownerId: String(row["owner_id"]),
        publicKey: await importPublicKey(JSON.parse(String(row["public_key"])) as JsonWebKey),
      })),
    );
  }
}

function identityOf(row: Record<string, SqlValue>): BridgeIdentity {
  return { bridgeId: String(row["id"]), ownerId: String(row["owner_id"]), role: row["role"] as BridgeRole };
}
