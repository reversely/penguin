// Standing publishing consent: the owner's yes for a worktree (or a project), kept until revoked.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * One standing yes. The owner gave it for checkpoints of one worktree (`worktree_id` set) or of
 * every worktree (`worktree_id` null, the `project` consent scope), published to one fork.
 */
export interface ConsentGrant {
  owner_id: string;
  project_id: string;
  /** The fork the yes publishes to, as `OwnerFork.repo` names it. */
  fork: string;
  worktree_id: string | null;
  /** The path of the worktree the owner said yes in, for `consent list`. Not part of the match. */
  worktree_path: string;
  granted_at: string;
}

/** What a publish asks consent for: one worktree's checkpoints to one fork. */
export type ConsentTarget = Pick<ConsentGrant, "owner_id" | "project_id" | "fork" | "worktree_id">;

/** Which grants a revoke removes. An empty filter removes every grant. */
export interface ConsentFilter {
  worktree_id?: string;
}

export interface ConsentStore {
  /** Whether a grant covers this worktree publishing to this fork. */
  covers(grant: ConsentTarget): Promise<boolean>;
  add(grant: ConsentGrant): Promise<void>;
  list(): Promise<ConsentGrant[]>;
  /** Removes the matching grants and resolves with how many it removed. */
  revoke(filter?: ConsentFilter): Promise<number>;
}

function sameFork(a: ConsentTarget, b: ConsentTarget): boolean {
  return a.owner_id === b.owner_id && a.project_id === b.project_id && a.fork === b.fork;
}

function covers(stored: ConsentGrant, wanted: ConsentTarget): boolean {
  return sameFork(wanted, stored) && (stored.worktree_id === null || stored.worktree_id === wanted.worktree_id);
}

function matches(grant: ConsentGrant, filter: ConsentFilter): boolean {
  return filter.worktree_id === undefined || grant.worktree_id === filter.worktree_id;
}

function sameGrant(a: ConsentTarget, b: ConsentTarget): boolean {
  return sameFork(a, b) && a.worktree_id === b.worktree_id;
}

/** Grants held in memory, for a long-running publisher or a test. */
export class MemoryConsentStore implements ConsentStore {
  #grants: ConsentGrant[] = [];

  async covers(wanted: ConsentTarget): Promise<boolean> {
    return this.#grants.some((stored) => covers(stored, wanted));
  }

  async add(grant: ConsentGrant): Promise<void> {
    this.#grants = [...this.#grants.filter((stored) => !sameGrant(stored, grant)), grant];
  }

  async list(): Promise<ConsentGrant[]> {
    return [...this.#grants];
  }

  async revoke(filter: ConsentFilter = {}): Promise<number> {
    const before = this.#grants.length;
    this.#grants = this.#grants.filter((grant) => !matches(grant, filter));
    return before - this.#grants.length;
  }
}

/**
 * Grants in a JSON file in the bridge's state folder, so a yes outlives the one-shot
 * `penguin-bridge checkpoint` process. The file holds no secret; it is written mode 0600 anyway,
 * like the registration record, and replaced by rename so a reader never sees half a file.
 */
export class FileConsentStore implements ConsentStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async covers(wanted: ConsentTarget): Promise<boolean> {
    return (await this.list()).some((stored) => covers(stored, wanted));
  }

  async add(grant: ConsentGrant): Promise<void> {
    const grants = await this.list();
    await this.#save([...grants.filter((stored) => !sameGrant(stored, grant)), grant]);
  }

  async list(): Promise<ConsentGrant[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = JSON.parse(text) as { grants?: unknown };
    if (!Array.isArray(parsed.grants)) throw new Error(`${this.path} holds no grants list`);
    return parsed.grants as ConsentGrant[];
  }

  async revoke(filter: ConsentFilter = {}): Promise<number> {
    const grants = await this.list();
    const kept = grants.filter((grant) => !matches(grant, filter));
    if (kept.length !== grants.length) await this.#save(kept);
    return grants.length - kept.length;
  }

  async #save(grants: ConsentGrant[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ grants }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** The bridge's consent file in its state folder. */
export function bridgeConsent(stateDir: string): FileConsentStore {
  return new FileConsentStore(join(resolve(stateDir), "consent.json"));
}
