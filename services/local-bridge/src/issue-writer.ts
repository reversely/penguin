// The bridge's issue writer: builds one issue operation, signs it with the bridge key, writes it at
// issues/<id>/ops/<op_id>.json in the bridge's own clone of the issues repo, commits and pushes.
// Phase 1 pushes to a local bare repository; #16 points the remote at Artifacts.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { signOperation, verifyOperation } from "@penguin/issues";
import {
  authorSegment,
  formatOpId,
  OPERATION_SCHEMA_VERSION,
  operationPath,
  OP_ID_PATTERN,
  validateOperation,
  type Author,
  type IssueId,
  type Operation,
  type OperationType,
} from "@penguin/protocol";

import type { BridgeSigningKey } from "./key-store.ts";

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
  /** The issues repository the bridge pushes to. Phase 1: an absolute path to a local bare repo. */
  remote: string;
  /** The bridge's own clone of the issues repo. Created on first use. */
  clonePath: string;
  /** The issues branch. */
  branch?: string;
  /** The human owner this bridge belongs to. */
  ownerId: string;
  key: BridgeSigningKey;
  /** How many times a rejected push is rebased and retried before the write fails. */
  maxPushAttempts?: number;
}

export interface WriteOptions {
  /** Who the operation is written as: the owner (default) or one of the owner's identities. */
  author?: Author;
  /**
   * The issue version the author saw. Phase 1 has no index, so by default it is the number of
   * operation files in the issue's folder after fetching; a create always carries 0.
   */
  baseVersion?: number;
}

export interface WriteResult {
  readonly operation: Operation;
  /** The operation file's repo path. */
  readonly path: string;
  readonly commit: string;
  /** Push attempts made; above 1 means another writer pushed first and the commit was rebased. */
  readonly pushAttempts: number;
}

// Hooks off and signing off: the bridge's clone runs no code from the repo or the owner's Git setup.
const GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

const OP_FILE = new RegExp(`^issues/[^/]+/ops/(${OP_ID_PATTERN.slice(1, -1)})\\.json$`, "u");
const SEQUENCE_FILE = "penguin-sequence.json";

/**
 * Writes signed issue operations from the bridge. Each `write` produces exactly one file and one
 * commit, then pushes. Text fields reach Git only inside the JSON file, never as an argument.
 */
export class IssueWriter {
  readonly #options: Required<IssueWriterOptions>;

  constructor(options: IssueWriterOptions) {
    if (!isAbsolute(options.clonePath)) throw new Error("the issues clone path must be absolute");
    this.#options = { branch: "main", maxPushAttempts: 5, ...options };
  }

  async write(change: IssueChange, options: WriteOptions = {}): Promise<WriteResult> {
    const { ownerId, key } = this.#options;
    const author: Author = options.author ?? { person: ownerId };
    if (authorOwner(author) !== ownerId) {
      throw new Error(`this bridge belongs to ${ownerId} and cannot write as ${authorName(author)}`);
    }

    await this.#sync();
    const segment = authorSegment(author);
    const seq = (await this.#lastSequence(segment)) + 1;
    const opId = formatOpId(author, seq);
    const issue = change.type === "create" ? opId : change.issue;
    const baseVersion =
      change.type === "create" ? 0 : (options.baseVersion ?? (await this.#operationCount(issue)));

    const operation = await signOperation(
      {
        schema_version: OPERATION_SCHEMA_VERSION,
        op_id: opId,
        issue,
        type: change.type,
        author,
        base_version: baseVersion,
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
    const file = join(this.#options.clonePath, path);
    if (await this.#tracked(path)) throw new Error(`${path} already exists in the issues repo`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(operation, null, 2)}\n`, { flag: "wx" });
    await this.#git("add", "--", path);
    // The message holds only validated identifiers, never a title, body or reason.
    await this.#git("commit", "--quiet", "-m", `issue ${String(issue)}: ${change.type} ${opId}`, "--", path);
    await this.#saveSequence(segment, seq);

    const pushAttempts = await this.#push();
    // Read after the push: a rebase during a retry gives the commit a new ID.
    return { operation, path, commit: (await this.#git("rev-parse", "HEAD")).trim(), pushAttempts };
  }

  /** Clones on first use, fetches, and replays any local commits onto the remote branch. */
  async #sync(): Promise<void> {
    const { remote, clonePath, branch } = this.#options;
    if (!existsSync(join(clonePath, ".git"))) {
      await mkdir(dirname(clonePath), { recursive: true });
      await runGit(dirname(clonePath), [...GIT_CONFIG, "clone", "--quiet", "--no-checkout", "--", remote, clonePath]);
    }
    await this.#git("fetch", "--quiet", "origin");
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteExists = await succeeds(clonePath, ["rev-parse", "--verify", "--quiet", remoteRef]);
    if (await succeeds(clonePath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
      await this.#git("checkout", "--quiet", branch);
      if (remoteExists) await this.#rebase(remoteRef);
    } else if (remoteExists) {
      await this.#git("checkout", "--quiet", "-B", branch, remoteRef);
    } else {
      // An empty issues repo: the first operation starts the branch.
      await this.#git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
    }
  }

  /**
   * Pushes HEAD. Another writer's push makes this one non-fast-forward; the commit is then rebased
   * onto the fetched branch, which cannot conflict because every operation is a new file.
   */
  async #push(): Promise<number> {
    const { branch, maxPushAttempts } = this.#options;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
        return attempt;
      } catch (error) {
        if (attempt >= maxPushAttempts) throw error;
      }
      await this.#git("fetch", "--quiet", "origin");
      await this.#rebase(`refs/remotes/origin/${branch}`);
    }
  }

  async #rebase(onto: string): Promise<void> {
    try {
      await this.#git("rebase", "--quiet", onto);
    } catch (error) {
      // Only the same op_id written from two clones can conflict; leave the clone as it was.
      await this.#git("rebase", "--abort").catch(() => undefined);
      throw new Error(`could not rebase the issues clone onto ${onto}: ${(error as Error).message}`);
    }
  }

  /**
   * The highest sequence number this author has used: the larger of the bridge's counter and the
   * highest number among the author's files in the repo, so a lost counter never reuses an op_id.
   */
  async #lastSequence(segment: string): Promise<number> {
    let highest = (await this.#readSequences())[segment] ?? 0;
    for (const path of await this.#trackedFiles("issues")) {
      const opId = OP_FILE.exec(path)?.[1];
      if (opId === undefined || !opId.startsWith(`${segment}-`)) continue;
      const rest = opId.slice(segment.length + 1);
      // A longer segment such as "jun-two" also starts with "jun-"; only digits follow our own.
      if (/^[0-9]+$/u.test(rest)) highest = Math.max(highest, Number(rest));
    }
    return highest;
  }

  async #operationCount(issue: IssueId): Promise<number> {
    const folder = `issues/${String(issue)}/ops`;
    const files = await this.#trackedFiles(folder);
    if (files.length === 0) throw new Error(`issue ${String(issue)} has no operations in the issues repo`);
    return files.filter((path) => OP_FILE.test(path)).length;
  }

  async #trackedFiles(folder: string): Promise<string[]> {
    if (!(await succeeds(this.#options.clonePath, ["rev-parse", "--verify", "--quiet", "HEAD"]))) return [];
    const output = await this.#git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `${folder}/`);
    return output.split("\0").filter((path) => path !== "");
  }

  async #tracked(path: string): Promise<boolean> {
    return (await this.#trackedFiles(dirname(path))).includes(path);
  }

  // The per-author counter lives in the clone's Git directory, outside the tracked tree.
  async #sequenceFile(): Promise<string> {
    const path = (await this.#git("rev-parse", "--git-path", SEQUENCE_FILE)).trim();
    return isAbsolute(path) ? path : join(this.#options.clonePath, path);
  }

  async #readSequences(): Promise<Record<string, number>> {
    try {
      const value: unknown = JSON.parse(await readFile(await this.#sequenceFile(), "utf8"));
      return typeof value === "object" && value !== null ? (value as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  async #saveSequence(segment: string, seq: number): Promise<void> {
    const sequences = await this.#readSequences();
    sequences[segment] = Math.max(sequences[segment] ?? 0, seq);
    await writeFile(await this.#sequenceFile(), `${JSON.stringify(sequences, null, 2)}\n`);
  }

  #git(...args: string[]): Promise<string> {
    return runGit(this.#options.clonePath, [...GIT_CONFIG, ...this.#identity(), ...args]);
  }

  #identity(): string[] {
    const owner = this.#options.ownerId;
    return ["-c", `user.name=Penguin bridge (${owner})`, "-c", `user.email=${owner}@bridge.penguin.invalid`];
  }
}

function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return runGit(cwd, args).then(
    () => true,
    () => false,
  );
}

function authorOwner(author: Author): string | undefined {
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity.slice(1, author.identity.indexOf("/"));
  return undefined;
}

function authorName(author: Author): string {
  return "person" in author ? author.person : "identity" in author ? author.identity : "Penguin";
}

/** Drops optional fields left undefined, which canonical JSON and the schema both refuse. */
function withoutUndefined(payload: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
