// The ProjectAgent's MCP tokens (setup inventory K3): one or more per owner, held in each agent's MCP
// config. A token authenticates its owner on /mcp; the session tools then act only for that owner's
// identities. Tokens are stored only as SHA-256 hashes; the plaintext leaves this module once, in the
// call that issued it.
//
// A task token is narrower (#138): Penguin issues one when a person's bridge claims a review task, for
// that task alone, and it expires when the claim does. It authenticates the task, not a session: /mcp
// then serves only the review tools, for that task's part revision and scope (review-task.ts). Reporting
// the task revokes it.

import { toBase64Url } from "@penguin/issues";

import type { SqlDatabase, SqlValue } from "./issue-index.ts";

export interface IssuedMcpToken {
  readonly tokenId: string;
  readonly ownerId: string;
  /** The token, returned only here. */
  readonly token: string;
  readonly issuedAt: string;
}

/** The owner an MCP token authenticated, and which of the owner's tokens it was. */
export interface McpCaller {
  readonly tokenId: string;
  readonly ownerId: string;
  /** Present for a task token: the one edit task it acts for. */
  readonly task?: { readonly taskId: number };
}

/** A task token, returned only by the claim that issued it. */
export interface IssuedTaskToken {
  readonly token: string;
  readonly expiresAt: string;
}

const TOKEN_PREFIX = "pgm_";
const TASK_TOKEN_PREFIX = "pgt_";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS McpToken (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, issued_at INTEGER NOT NULL,
    revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS McpTaskToken (
    id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS McpTaskToken_task ON McpTaskToken (task_id)`,
];

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class McpTokenStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of SCHEMA) db.exec(statement);
  }

  /** Issues a new token for `ownerId`. The owner's other tokens stay valid until revoked. */
  async issue(ownerId: string): Promise<IssuedMcpToken> {
    const token = TOKEN_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenId = `mt_${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
    const issuedAt = this.#now();
    this.#db.exec(
      `INSERT INTO McpToken (id, owner_id, token_hash, issued_at) VALUES (?, ?, ?, ?)`,
      tokenId,
      ownerId,
      await sha256Hex(token),
      issuedAt,
    );
    return { tokenId, ownerId, token, issuedAt: new Date(issuedAt).toISOString() };
  }

  /**
   * Issues a token for edit task `taskId` of `ownerId`, valid until `expiresAt` (milliseconds) or
   * until the task's tokens are revoked. Earlier tokens of the task are revoked first: a task has one.
   */
  async issueTask(ownerId: string, taskId: number, expiresAt: number): Promise<IssuedTaskToken> {
    const token = TASK_TOKEN_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenId = `mtt_${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
    const hash = await sha256Hex(token);
    this.#db.transaction(() => {
      this.revokeTask(taskId);
      this.#db.exec(
        `INSERT INTO McpTaskToken (id, task_id, owner_id, token_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
        tokenId,
        taskId,
        ownerId,
        hash,
        this.#now(),
        expiresAt,
      );
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The owner holding this unrevoked token, or undefined. A task token also names its task, until it expires. */
  async authenticate(token: string): Promise<McpCaller | undefined> {
    if (typeof token !== "string") return undefined;
    if (token.startsWith(TASK_TOKEN_PREFIX)) {
      const [row] = this.#db.exec(
        `SELECT id, owner_id, task_id FROM McpTaskToken WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        await sha256Hex(token),
        this.#now(),
      );
      return row === undefined ? undefined : { ...callerOf(row), task: { taskId: Number(row["task_id"]) } };
    }
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const [row] = this.#db.exec(
      `SELECT id, owner_id FROM McpToken WHERE token_hash = ? AND revoked_at IS NULL`,
      await sha256Hex(token),
    );
    return row === undefined ? undefined : callerOf(row);
  }

  /** Revokes every token of edit task `taskId`. Returns how many were still valid. */
  revokeTask(taskId: number): number {
    return this.#db.exec(`UPDATE McpTaskToken SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL RETURNING id`, this.#now(), taskId).length;
  }

  /** Revokes a token. Returns false when no unrevoked token has that id. */
  revoke(tokenId: string): boolean {
    const rows = this.#db.exec(
      `UPDATE McpToken SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id`,
      this.#now(),
      tokenId,
    );
    return rows.length > 0;
  }
}

function callerOf(row: Record<string, SqlValue>): McpCaller {
  return { tokenId: String(row["id"]), ownerId: String(row["owner_id"]) };
}
