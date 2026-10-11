// The bridge's issue writer: builds one issue operation, signs it with the bridge key, appends it
// to the outbound spool and drains the spool, which writes issues/<id>/ops/<op_id>.json in the
// bridge's own clone of the issues repo, commits and pushes. With the remote unreachable the
// operation stays queued and a later drain pushes it.

import { signOperation, verifyOperation } from "@penguin/issues";
import {
  authorSegment,
  formatOpId,
  OPERATION_SCHEMA_VERSION,
  operationPath,
  validateOperation,
  type Author,
  type IssueId,
  type Operation,
  type OperationType,
} from "@penguin/protocol";

import { authorOwner, IssuesClone, isOperationPath, opIdOfPath } from "./issues-clone.ts";
import type { RemoteResolver } from "./git-remote.ts";
import type { BridgeSigningKey } from "./key-store.ts";
import { pendingOf, type OperationEntry, type Spool, type SpoolEntry } from "./spool.ts";
import { drainLocked } from "./spool-drain.ts";

/** The six operation types the bridge command line writes. */
export type BridgeOperationType = Extract<
  OperationType,
  "create" | "comment" | "add_label" | "assign" | "review" | "change_state"
>;

export type IssueChange =
  | { readonly type: "create"; readonly payload: { readonly title: string; readonly body?: string } }
  | { readonly type: "comment"; readonly issue: IssueId; readonly payload: { readonly body: string } }
  | { readonly type: "add_label"; readonly issue: IssueId; readonly payload: { readonly label: string } }
  | {
      readonly type: "assign";
      readonly issue: IssueId;
      readonly payload: { readonly assignee: { readonly person: string } | { readonly identity: string } };
    }
  | {
      readonly type: "review";
      readonly issue: IssueId;
      readonly payload: {
        readonly verdict: "approve" | "request_changes";
        readonly commit: string;
        readonly reason?: string;
      };
    }
  | {
      readonly type: "change_state";
      readonly issue: IssueId;
      readonly payload: { readonly state: string; readonly reason: string };
    };

export interface IssueWriterOptions {
  /** The issues repository the bridge pushes to: a local bare repo's absolute path, or `penguin:issues`. */
  remote: string;
  /** Turns spooled remote names into remotes. Defaults to local paths only. */
  remotes?: RemoteResolver;
  /** The bridge's own clone of the issues repo. Created on first use. */
  clonePath: string;
  /** The issues branch. */
  branch?: string;
  /** The human owner this bridge belongs to. */
  ownerId: string;
  /**
   * The bridge's writer tag in every op_id it numbers, `<author>-<writer>-<seq>`: `bridgeWriterTag`
   * of the bridge ID. Its own tag keeps the bridge's sequence apart from the Worker's (`web`).
   */
  writer: string;
  key: BridgeSigningKey;
  /** The bridge's outbound spool. Every operation is appended here before any push. */
  spool: Spool;
  /** How many times a rejected push is rebased and retried before the operation stays queued. */
  maxPushAttempts?: number;
}

export interface WriteOptions {
  /** Who the operation is written as: the owner (default) or one of the owner's identities. */
  author?: Author;
  /**
   * The issue version the author saw. Phase 1 has no index, so by default it is the number of the
   * issue's operation files after fetching plus its operations still queued in the spool; a
   * create always carries 0.
   */
  baseVersion?: number;
}

export interface WriteResult {
  readonly operation: Operation;
  /** The operation file's repo path. */
  readonly path: string;
  /**
   * `pushed`: the remote holds the operation. `queued`: it waits in the spool for the remote.
   * `failed`: the remote holds a different file at its path, so it is never pushed.
   */
  readonly status: "pushed" | "queued" | "failed";
  /** The commit that carries the operation on the remote; null unless pushed. */
  readonly commit: string | null;
  /** Why the operation is queued or failed; null when pushed. */
  readonly reason: string | null;
}

/**
 * Writes signed issue operations from the bridge. Each `write` spools exactly one operation, which
 * becomes one file and one commit on the remote. Text fields reach Git only inside the JSON file,
 * never as an argument.
 */
export class IssueWriter {
  readonly #options: Required<Omit<IssueWriterOptions, "remotes">> & Pick<IssueWriterOptions, "remotes">;
  readonly #clone: IssuesClone;

  constructor(options: IssueWriterOptions) {
    this.#options = { branch: "main", maxPushAttempts: 5, ...options };
    this.#clone = new IssuesClone(this.#options);
  }

  async write(change: IssueChange, options: WriteOptions = {}): Promise<WriteResult> {
    const { ownerId, spool } = this.#options;
    const author: Author = options.author ?? { person: ownerId };
    if (authorOwner(author) !== ownerId) {
      throw new Error(`this bridge belongs to ${ownerId} and cannot write as ${authorName(author)}`);
    }

    return spool.withLock(async () => {
      const sync = await this.#clone.sync();
      const spooled = await spool.read();
      const entry = await this.#enqueue(change, author, options.baseVersion, spooled);
      if (!sync.online) {
        // The fetch just failed, so a push would too; the retry loop takes it from here.
        return { operation: entry.operation, path: entry.path, status: "queued", commit: null, reason: sync.reason };
      }
      const drained = await drainLocked(spool, this.#options.remotes, this.#clone);
      const pushed = drained.pushed.find((item) => item.id === entry.id);
      const failed = drained.failed.find((item) => item.id === entry.id);
      const waiting = drained.waiting.find((item) => item.id === entry.id);
      return {
        operation: entry.operation,
        path: entry.path,
        status: pushed ? "pushed" : failed ? "failed" : "queued",
        commit: pushed?.commit ?? null,
        reason: failed?.reason ?? waiting?.reason ?? null,
      };
    });
  }

  /** Builds, signs and spools the operation. Runs under the spool lock. */
  async #enqueue(
    change: IssueChange,
    author: Author,
    baseVersion: number | undefined,
    spooled: readonly SpoolEntry[],
  ): Promise<OperationEntry> {
    const { remote, clonePath, branch, key, spool, writer } = this.#options;
    const prefix = `${authorSegment(author)}-${writer}-`;
    const ops = spooled.filter((entry): entry is OperationEntry => entry.kind === "operation");
    const seq = (await this.#lastSequence(prefix, ops)) + 1;
    const opId = formatOpId(author, writer, seq);
    const issue = change.type === "create" ? opId : change.issue;
    const version = change.type === "create" ? 0 : (baseVersion ?? (await this.#operationCount(issue, spooled)));

    const operation = await signOperation(
      {
        schema_version: OPERATION_SCHEMA_VERSION,
        op_id: opId,
        issue,
        type: change.type,
        author,
        base_version: version,
        payload: withoutUndefined(change.payload),
      },
      key.privateKey,
    );
    const checked = validateOperation(operation);
    if (!checked.ok) {
      const detail = checked.errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ");
      throw new Error(`the ${change.type} operation is invalid: ${detail}`);
    }
    if (!(await verifyOperation(operation, key.publicKey))) throw new Error("the signature does not verify");

    const path = operationPath(operation);
    if ((await this.#clone.trackedFiles("issues")).includes(path) || ops.some((entry) => entry.id === opId)) {
      throw new Error(`${path} already exists in the issues repo or the spool`);
    }
    const entry = await spool.enqueue({ kind: "operation", id: opId, remote, clone: clonePath, branch, path, operation });
    await this.#clone.saveSequence(prefix, seq);
    return entry as OperationEntry;
  }

  /**
   * The highest sequence number this bridge has numbered for the author, whose op_ids begin with
   * `prefix` (`<author>-<writer>-`): the largest of the bridge's counter, those files in the repo
   * and those entries in the spool, so neither a lost counter nor a queued operation lets an op_id
   * be reused.
   */
  async #lastSequence(prefix: string, spooled: readonly OperationEntry[]): Promise<number> {
    let highest = await this.#clone.savedSequence(prefix);
    const opIds = [
      ...(await this.#clone.trackedFiles("issues")).map(opIdOfPath),
      ...spooled.map((entry) => entry.operation.op_id),
    ];
    for (const opId of opIds) {
      if (opId === undefined || !opId.startsWith(prefix)) continue;
      const rest = opId.slice(prefix.length);
      // Another author's op_id can start with the prefix too ("jun-b3f2-x-0001" for author
      // "jun-b3f2"); only digits follow our own.
      if (/^[0-9]+$/u.test(rest)) highest = Math.max(highest, Number(rest));
    }
    return highest;
  }

  /** The issue's operations on the branch plus those of its operations still queued for this clone. */
  async #operationCount(issue: IssueId, spooled: readonly SpoolEntry[]): Promise<number> {
    const files = (await this.#clone.trackedFiles(`issues/${String(issue)}/ops`)).filter(isOperationPath);
    const onBranch = new Set(files);
    const queued = pendingOf(spooled).filter(
      (entry) =>
        entry.kind === "operation" &&
        entry.clone === this.#options.clonePath &&
        String(entry.operation.issue) === String(issue) &&
        !onBranch.has(entry.path),
    );
    const count = files.length + queued.length;
    if (count === 0) throw new Error(`issue ${String(issue)} has no operations in the issues repo or the spool`);
    return count;
  }
}

function authorName(author: Author): string {
  return "person" in author ? author.person : "identity" in author ? author.identity : "Penguin";
}

/** Drops optional fields left undefined, which canonical JSON and the schema both refuse. */
function withoutUndefined(payload: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
