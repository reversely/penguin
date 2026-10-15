// What an idle agent's wait_for_work call waits on (#210).
//
// WorkSignal counts the agent's own changes to the work get_work reads: the ProjectAgent calls
// `changed` from the live feed's flush, the same event that tells dashboards an issue, a session or a
// feature changed, and when the check runner records a tool result. A waiting call holds a promise
// that `changed` or its round's timer settles; nothing reads storage while it waits. The count lives
// in memory under an epoch drawn when the object starts, so a mark from before an eviction never
// matches and the waiter reads its work again at once.
//
// WorkReadStore keeps, per session, the keys of the get_work entries the agent last read, so a wait
// answers only with the entries that are new since then (services/mcp/src/wait-for-work.ts makes
// the keys).

import type { SqlDatabase } from "./issue-index.ts";

/** The longest one round of a wait holds: wait_for_work's whole wait (services/mcp/src/wait-for-work.ts). */
export const WORK_ROUND_MAX_MS = 50_000;

/** Where the signal stood when a waiter last read its work. */
export interface WorkMark {
  readonly epoch: string;
  readonly version: number;
}

export class WorkSignal {
  readonly #epoch = crypto.randomUUID();
  #version = 0;
  #waiters = new Set<() => void>();

  get mark(): WorkMark {
    return { epoch: this.#epoch, version: this.#version };
  }

  /** Something get_work reads may have changed: every open wait wakes. */
  changed(): void {
    this.#version += 1;
    const waiters = this.#waiters;
    this.#waiters = new Set();
    for (const wake of waiters) wake();
  }

  /**
   * Resolves with the current mark once it has moved past `since`, at once when it already has (or
   * `since` is null or from another epoch), or after `ms` with the mark unchanged.
   */
  wait(since: WorkMark | null, ms: number): Promise<{ readonly mark: WorkMark; readonly changed: boolean }> {
    if (!this.#same(since)) return Promise.resolve({ mark: this.mark, changed: true });
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve({ mark: this.mark, changed: true });
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(wake);
        resolve({ mark: this.mark, changed: false });
      }, ms);
      this.#waiters.add(wake);
    });
  }

  /** How many calls wait now. */
  get waiting(): number {
    return this.#waiters.size;
  }

  #same(since: WorkMark | null): boolean {
    return since !== null && since.epoch === this.#epoch && since.version === this.#version;
  }
}

export const WORK_READ_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS SessionWorkRead (session_id TEXT PRIMARY KEY, entry_keys TEXT NOT NULL)`,
];

/** The keys of the get_work entries each session last read. */
export class WorkReadStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of WORK_READ_SCHEMA) db.exec(statement);
  }

  get(sessionId: string): string[] {
    const [row] = this.#db.exec(`SELECT entry_keys FROM SessionWorkRead WHERE session_id = ?`, sessionId);
    return row === undefined ? [] : (JSON.parse(row["entry_keys"] as string) as string[]);
  }

  set(sessionId: string, keys: readonly string[]): void {
    this.#db.exec(`INSERT OR REPLACE INTO SessionWorkRead (session_id, entry_keys) VALUES (?, ?)`, sessionId, JSON.stringify(keys));
  }
}
