// The bridge's outbound spool: an append-only JSON Lines file. Every issue operation and every
// checkpoint push is first appended as an entry with an idempotent ID; a drain pushes the entries
// that have no acknowledgement yet and appends one. No byte already written is ever rewritten, so
// a crash at any point leaves at most one torn final line, which `read` skips.

import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Operation } from "@penguin/protocol";

export const SPOOL_VERSION = 1;

/** An issue operation for the issues repo. Its ID is the operation's op_id. */
export interface OperationEntry {
  readonly v: typeof SPOOL_VERSION;
  readonly kind: "operation";
  readonly id: string;
  readonly queued_at: string;
  /** The issues repository and the bridge's clone of it that the operation is pushed through. */
  readonly remote: string;
  readonly clone: string;
  readonly branch: string;
  /** The operation file's repo path. */
  readonly path: string;
  /** The signed operation, exactly as it is written to the file. */
  readonly operation: Operation;
}

/** A consented checkpoint push to the owner's fork. Its ID names the commit and the fork branch. */
export interface CheckpointEntry {
  readonly v: typeof SPOOL_VERSION;
  readonly kind: "checkpoint";
  readonly id: string;
  readonly queued_at: string;
  /** The worktree whose object store holds the checkpoint commit. */
  readonly worktree: string;
  readonly fork: string;
  readonly ref: string;
  readonly sha: string;
}

export type QueuedEntry = OperationEntry | CheckpointEntry;

/** The remote holds the entry. `commit` is the commit that carries it there. */
export interface PushedEntry {
  readonly v: typeof SPOOL_VERSION;
  readonly kind: "pushed";
  readonly id: string;
  readonly at: string;
  readonly commit: string;
}

/** The remote refused the entry for good; the drain stops retrying it. */
export interface FailedEntry {
  readonly v: typeof SPOOL_VERSION;
  readonly kind: "failed";
  readonly id: string;
  readonly at: string;
  readonly reason: string;
}

export type SpoolEntry = QueuedEntry | PushedEntry | FailedEntry;

/** Distributes `Omit` over a union, so each queued kind keeps its own fields. */
type Unstamped<T> = T extends unknown ? Omit<T, "v" | "queued_at"> : never;

const ENTRY_KINDS = new Set(["operation", "checkpoint", "pushed", "failed"]);

// A lock older than this whose holder wrote no process ID is taken to be left by a crash.
const UNNAMED_LOCK_GRACE_MS = 2_000;

export interface SpoolOptions {
  /** How long `withLock` waits for another live process before giving up. */
  lockTimeoutMs?: number;
}

export class Spool {
  readonly path: string;
  readonly #lockTimeoutMs: number;

  constructor(path: string, options: SpoolOptions = {}) {
    this.path = path;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  }

  /** Appends a queued entry and resolves once it is on disk. */
  async enqueue(entry: Unstamped<QueuedEntry>): Promise<QueuedEntry> {
    const stamped = { v: SPOOL_VERSION, ...entry, queued_at: new Date().toISOString() } as QueuedEntry;
    await this.#append([stamped]);
    return stamped;
  }

  /** Appends one acknowledgement per entry, in a single write. */
  async acknowledge(acks: readonly (Omit<PushedEntry, "v" | "at"> | Omit<FailedEntry, "v" | "at">)[]): Promise<void> {
    if (acks.length === 0) return;
    const at = new Date().toISOString();
    await this.#append(acks.map((ack) => ({ v: SPOOL_VERSION, ...ack, at }) as SpoolEntry));
  }

  /** Every readable entry in file order. A torn or foreign line is skipped. */
  async read(): Promise<SpoolEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: SpoolEntry[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const value = JSON.parse(line) as Partial<SpoolEntry>;
        if (value.v === SPOOL_VERSION && ENTRY_KINDS.has(value.kind ?? "") && typeof value.id === "string") {
          entries.push(value as SpoolEntry);
        }
      } catch {
        // A line cut short by a crash during an append.
      }
    }
    return entries;
  }

  /** Queued entries with no acknowledgement, in the order they were queued. */
  async pending(): Promise<QueuedEntry[]> {
    return pendingOf(await this.read());
  }

  /**
   * Runs `fn` while holding the spool's lock file, so one bridge process at a time allocates
   * sequence numbers, drains, and touches the clones the entries name. A lock left by a process
   * that no longer runs is taken over.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await lockHolder(lock);
      if (holder === "stale") {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the spool ${this.path} is locked by process ${holder}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  async #append(entries: readonly SpoolEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, "a+", 0o600);
    try {
      // The mode argument applies only when the file is created; an existing file is narrowed too.
      await handle.chmod(0o600);
      const { size } = await handle.stat();
      let prefix = "";
      if (size > 0) {
        // Start a fresh line after a torn one, so the new entry stays readable.
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
      await handle.appendFile(prefix + entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/** The queued entries of `entries` that no later acknowledgement answers. */
export function pendingOf(entries: readonly SpoolEntry[]): QueuedEntry[] {
  const answered = new Set<string>();
  for (const entry of entries) if (entry.kind === "pushed" || entry.kind === "failed") answered.add(entry.id);
  const seen = new Set<string>();
  const pending: QueuedEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "operation" && entry.kind !== "checkpoint") continue;
    // A second entry with the same ID is the same push; the first one stands.
    if (answered.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    pending.push(entry);
  }
  return pending;
}

/** The live process holding the lock, or "stale" when the holder is gone. */
async function lockHolder(lock: string): Promise<number | "stale"> {
  const text = await readFile(lock, "utf8").catch(() => null);
  if (text === null) return "stale";
  const pid = Number(text);
  if (Number.isInteger(pid) && pid > 0) return processRuns(pid) ? pid : "stale";
  // Created but not yet written: a live holder fills it within moments.
  const age = await stat(lock).then(
    (info) => Date.now() - info.mtimeMs,
    () => Infinity,
  );
  return age > UNNAMED_LOCK_GRACE_MS ? "stale" : 0;
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
