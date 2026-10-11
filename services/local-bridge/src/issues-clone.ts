// The bridge's own clone of an issues repo: fetching, recovering from a crash, committing spooled
// operation files and pushing them. The remote is a local bare repository (Phase 1) or the
// Artifacts `issues` repo, named `penguin:issues`. The clone keeps no remote in its Git config:
// every fetch and push names the URL, and an Artifacts token travels in that command's
// environment only. Callers hold the spool lock, so one bridge process at a time uses a clone.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { OP_ID_PATTERN, operationPath, validateOperation, type Author, type Operation } from "@penguin/protocol";

import { RemoteUnavailableError, unregisteredRemotes, type GitRemote, type RemoteResolver } from "./git-remote.ts";
import type { OperationEntry } from "./spool.ts";

export { RemoteUnavailableError } from "./git-remote.ts";

export interface IssuesCloneOptions {
  /** The issues repository: an absolute path to a local bare repo, or `penguin:issues`. */
  remote: string;
  /** Turns `remote` into the remote Git talks to. Defaults to local paths only. */
  remotes?: RemoteResolver;
  /** The bridge's clone of the issues repo. Created on first use. */
  clonePath: string;
  branch: string;
  /** The owner the bridge's commits are attributed to. */
  ownerId: string;
  /** How many times a rejected push is rebased and retried before the push counts as failed. */
  maxPushAttempts: number;
}

export type SyncResult = { readonly online: true } | { readonly online: false; readonly reason: string };

export interface PublishOutcome {
  /** op_id to the commit that carries the operation on the remote branch. */
  readonly pushed: ReadonlyMap<string, string>;
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

/** A file the runner writes at `path` in the issues repo. */
export interface BatchFile {
  readonly path: string;
  readonly text: string;
}

export interface BatchOutcome {
  /** The pushed commit that carries every written file, or null when nothing was written. */
  readonly commit: string | null;
  readonly written: readonly string[];
  /** Paths the branch already held with the same bytes. */
  readonly skipped: readonly string[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
}

// Hooks off and signing off: the bridge's clone runs no code from the repo or the owner's Git setup.
// Automatic maintenance stays in the foreground. Git detaches it by default, and a background repack
// that packs or deletes objects while the drain's next commit reads them fails that commit.
const GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "maintenance.autoDetach=false",
  "-c",
  "gc.autoDetach=false",
];

// Fetching every branch into origin's namespace also succeeds on an empty remote.
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

const OP_FILE = new RegExp(`^issues/[^/]+/ops/(${OP_ID_PATTERN.slice(1, -1)})\\.json$`, "u");
const SEQUENCE_FILE = "penguin-sequence.json";

/** The exact bytes of an operation file. A retry writes the same bytes, so a rewrite is a no-op. */
export function operationText(operation: Operation): string {
  return `${JSON.stringify(operation, null, 2)}\n`;
}

/** The op_id of an operation file path, or undefined for any other path. */
export function opIdOfPath(path: string): string | undefined {
  return OP_FILE.exec(path)?.[1];
}

export function isOperationPath(path: string): boolean {
  return OP_FILE.test(path);
}

export class IssuesClone {
  readonly #options: IssuesCloneOptions;
  readonly #remote: GitRemote;
  // The bridge creates the clone itself, so its Git directory is always <clone>/.git.
  readonly #gitDir: string;
  /** The branch has a commit, so HEAD can be read. Set by `sync`. */
  #born = false;
  /** The last `sync` fetched, and nothing has been pushed since. */
  #fresh = false;
  /** Every tracked path under issues/ at HEAD, read once per change of HEAD. */
  #tracked: string[] | null = null;

  constructor(options: IssuesCloneOptions) {
    if (!isAbsolute(options.clonePath)) throw new Error("the issues clone path must be absolute");
    this.#options = options;
    this.#remote = (options.remotes ?? unregisteredRemotes)(options.remote);
    this.#gitDir = join(options.clonePath, ".git");
  }

  get clonePath(): string {
    return this.#options.clonePath;
  }

  /**
   * Creates the clone on first use, undoes whatever a crash left half done, fetches, and replays
   * local commits onto the remote branch. Offline it still leaves the clone on its branch, so the
   * caller can read the last fetched state.
   */
  async sync(): Promise<SyncResult> {
    const { clonePath, branch } = this.#options;
    this.#fresh = false;
    this.#tracked = null;
    if (!existsSync(this.#gitDir)) {
      // init and fetch rather than clone, so an unreachable remote still leaves a usable clone.
      await mkdir(clonePath, { recursive: true });
      await runGit(clonePath, [...GIT_CONFIG, "init", "--quiet"]);
    }
    await this.#recover();
    const fetched = await this.#fetch().then(
      () => null,
      (error: Error) => error.message,
    );
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;
    const refs = new Set((await this.#git("for-each-ref", "--format=%(refname)", localRef, remoteRef)).split("\n"));
    if (refs.has(localRef)) {
      const head = await readFile(join(this.#gitDir, "HEAD"), "utf8").catch(() => "");
      if (head.trim() !== `ref: ${localRef}`) await this.#git("checkout", "--quiet", branch);
      if (fetched === null && refs.has(remoteRef)) await this.#rebase(remoteRef);
    } else if (refs.has(remoteRef)) {
      await this.#git("checkout", "--quiet", "-B", branch, remoteRef);
    } else {
      // An empty issues repo: the first operation starts the branch.
      await this.#git("symbolic-ref", "HEAD", localRef);
    }
    this.#born = refs.has(localRef) || refs.has(remoteRef);
    this.#fresh = fetched === null;
    return fetched === null ? { online: true } : { online: false, reason: lastLine(fetched) };
  }

  /**
   * Commits each spooled operation that the branch does not already hold, one file per commit,
   * and pushes them together. An operation already on the branch with the same bytes, from a push
   * that landed before a crash, counts as pushed and is not committed again. Fetches first unless
   * this clone has just been synced online.
   */
  async publish(entries: readonly OperationEntry[]): Promise<PublishOutcome> {
    if (!this.#fresh) {
      const sync = await this.sync();
      if (!sync.online) throw new RemoteUnavailableError(`the issues remote is unreachable: ${sync.reason}`);
    }
    this.#fresh = false;

    const tracked = new Set(await this.trackedFiles("issues"));
    const failed: { id: string; reason: string }[] = [];
    const held: OperationEntry[] = [];
    const fresh: OperationEntry[] = [];
    for (const entry of entries) {
      const problem = entryProblem(entry);
      if (problem !== null) {
        failed.push({ id: entry.id, reason: problem });
      } else if (!tracked.has(entry.path)) {
        fresh.push(entry);
      } else if ((await this.#git("cat-file", "blob", `HEAD:${entry.path}`)) === operationText(entry.operation)) {
        held.push(entry);
      } else {
        failed.push({ id: entry.id, reason: `${entry.path} already holds a different operation` });
      }
    }

    for (const entry of fresh) {
      const file = join(this.#options.clonePath, entry.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, operationText(entry.operation));
    }
    if (fresh.length > 0) await this.#git("add", "--", ...fresh.map((entry) => entry.path));
    for (const { operation, path } of fresh) {
      // The message holds only validated identifiers, never a title, body or reason.
      const message = `issue ${String(operation.issue)}: ${operation.type} ${operation.op_id}`;
      await this.#git("commit", "--quiet", "-m", message, "--", path);
      this.#born = true;
      this.#tracked = null;
    }

    const landed = [...held, ...fresh];
    if (landed.length === 0) return { pushed: new Map(), failed };
    await this.#push();
    // Read after the push: a rebase during a retry gives the commits new IDs.
    const commits = await this.#commitsOf(landed.map((entry) => entry.path));
    const pushed = new Map(landed.map((entry) => [entry.id, commits.get(entry.path) ?? ""]));
    return { pushed, failed };
  }

  /**
   * Writes `files` and pushes them as one commit, for the integration runner. A file the branch
   * already holds with the same bytes is skipped; one it holds with other bytes is refused and left
   * alone. With nothing new to write, nothing is committed or pushed. Callers check each file first;
   * this method writes only operation file paths. `message` gets the number of files written.
   * Fetches first unless just synced online.
   */
  async publishBatch(files: readonly BatchFile[], message: (written: number) => string): Promise<BatchOutcome> {
    if (!this.#fresh) {
      const sync = await this.sync();
      if (!sync.online) throw new RemoteUnavailableError(`the issues remote is unreachable: ${sync.reason}`);
    }
    this.#fresh = false;

    const tracked = new Set(await this.trackedFiles("issues"));
    const skipped: string[] = [];
    const refused: { path: string; reason: string }[] = [];
    const fresh = new Map<string, string>();
    for (const { path, text } of files) {
      if (!isOperationPath(path)) {
        refused.push({ path, reason: "not an operation file path" });
      } else if (fresh.has(path)) {
        if (fresh.get(path) !== text) refused.push({ path, reason: "listed twice with different contents" });
      } else if (!tracked.has(path)) {
        fresh.set(path, text);
      } else if ((await this.#git("cat-file", "blob", `HEAD:${path}`)) === text) {
        skipped.push(path);
      } else {
        refused.push({ path, reason: `${path} already holds a different operation` });
      }
    }
    if (fresh.size === 0) return { commit: null, written: [], skipped, refused };

    for (const [path, text] of fresh) {
      const file = join(this.#options.clonePath, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const written = [...fresh.keys()];
    await this.#git("add", "--", ...written);
    await this.#git("commit", "--quiet", "-m", message(written.length), "--", ...written);
    this.#born = true;
    this.#tracked = null;
    await this.#push();
    // Read after the push: a rebase during a retry gives the commit a new ID.
    const commit = (await this.#git("rev-parse", "HEAD")).trim();
    return { commit, written, skipped, refused };
  }

  /** Tracked files under `folder` (a folder inside issues/) at HEAD; none on an unborn branch. */
  async trackedFiles(folder: string): Promise<string[]> {
    if (this.#tracked === null) {
      const output = this.#born ? await this.#git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "issues/") : "";
      this.#tracked = output.split("\0").filter((path) => path !== "");
    }
    return this.#tracked.filter((path) => path.startsWith(`${folder}/`));
  }

  /** The highest sequence number in the per-author counter kept in the clone's Git directory. */
  async savedSequence(segment: string): Promise<number> {
    return (await this.#readSequences())[segment] ?? 0;
  }

  async saveSequence(segment: string, seq: number): Promise<void> {
    const sequences = await this.#readSequences();
    sequences[segment] = Math.max(sequences[segment] ?? 0, seq);
    await writeFile(this.#sequenceFile(),`${JSON.stringify(sequences, null, 2)}\n`);
  }

  /**
   * Pushes HEAD. Another writer's push makes this one non-fast-forward; the commits are then
   * rebased onto the fetched branch, which cannot conflict because every operation is a new file.
   */
  async #push(): Promise<void> {
    const { branch, maxPushAttempts } = this.#options;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#remote.git(this.#options.clonePath, (url) => [
          ...GIT_CONFIG,
          "push",
          "--quiet",
          "--end-of-options",
          url,
          `HEAD:refs/heads/${branch}`,
        ]);
        return;
      } catch (error) {
        if (attempt >= maxPushAttempts) {
          throw new RemoteUnavailableError(`the push to the issues remote failed: ${lastLine((error as Error).message)}`);
        }
      }
      try {
        await this.#fetch();
      } catch (error) {
        throw new RemoteUnavailableError(`the issues remote is unreachable: ${lastLine((error as Error).message)}`);
      }
      await this.#rebase(`refs/remotes/origin/${branch}`);
    }
  }

  async #rebase(onto: string): Promise<void> {
    this.#tracked = null;
    try {
      await this.#git("rebase", "--quiet", onto);
    } catch (error) {
      // Only the same op_id written from two clones can conflict; leave the clone as it was.
      await this.#git("rebase", "--abort").catch(() => undefined);
      throw new Error(`could not rebase the issues clone onto ${onto}: ${(error as Error).message}`);
    }
  }

  /**
   * Undoes what a killed bridge can leave behind: a rebase in progress, a stale index lock, and
   * staged or written files that never reached a commit. Every operation file is rewritten from
   * the spool, so nothing here is lost.
   */
  async #recover(): Promise<void> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const path = join(this.#gitDir, name);
      if (existsSync(path)) {
        await this.#git("rebase", "--abort").catch(() => undefined);
        await rm(path, { recursive: true, force: true });
      }
    }
    // The caller holds the spool lock, so no other bridge process is running Git here.
    await rm(join(this.#gitDir, "index.lock"), { force: true });
    if ((await this.#git("status", "--porcelain", "-z", "--untracked-files=all")) === "") return;
    if (await this.#succeeds("rev-parse", "--verify", "--quiet", "HEAD")) {
      await this.#git("reset", "--quiet", "--hard");
    } else {
      await this.#git("read-tree", "--empty");
    }
    await this.#git("clean", "-fdq");
  }

  /** The newest commit on HEAD that touches each path. */
  async #commitsOf(paths: readonly string[]): Promise<Map<string, string>> {
    // Operation paths hold only [a-z0-9./-], so a line-based listing is unambiguous.
    const output = await this.#git("log", "--format=@%H", "--name-only", "HEAD", "--", ...paths);
    const commits = new Map<string, string>();
    let commit = "";
    for (const line of output.split("\n")) {
      if (line.startsWith("@")) commit = line.slice(1);
      else if (line !== "" && !commits.has(line)) commits.set(line, commit);
    }
    return commits;
  }

  // The per-author counter lives in the clone's Git directory, outside the tracked tree.
  #sequenceFile(): string {
    return join(this.#gitDir, SEQUENCE_FILE);
  }

  async #readSequences(): Promise<Record<string, number>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#sequenceFile(), "utf8"));
      return typeof value === "object" && value !== null ? (value as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  #fetch(): Promise<string> {
    return this.#remote.git(this.#options.clonePath, (url) => [
      ...GIT_CONFIG,
      "fetch",
      "--quiet",
      "--end-of-options",
      url,
      FETCH_REFSPEC,
    ]);
  }

  #succeeds(...args: string[]): Promise<boolean> {
    return this.#git(...args).then(
      () => true,
      () => false,
    );
  }

  #git(...args: string[]): Promise<string> {
    return runGit(this.#options.clonePath, [...GIT_CONFIG, ...this.#identity(), ...args]);
  }

  #identity(): string[] {
    const owner = this.#options.ownerId;
    return ["-c", `user.name=Penguin bridge (${owner})`, "-c", `user.email=${owner}@bridge.penguin.invalid`];
  }
}

/** Why a spooled operation cannot be written, or null when it can. */
function entryProblem(entry: OperationEntry): string | null {
  if (entry.id !== entry.operation.op_id) return "the spool entry's ID is not its operation's op_id";
  if (!validateOperation(entry.operation).ok) return "the spooled operation does not match the schema";
  if (operationPath(entry.operation) !== entry.path) return "the spooled path is not the operation's path";
  return null;
}

/** The owner an author belongs to: the person, or the owner named in an identity handle. */
export function authorOwner(author: Author): string | undefined {
  if ("person" in author) return author.person;
  if ("identity" in author) return author.identity.slice(1, author.identity.indexOf("/"));
  return undefined;
}

function lastLine(message: string): string {
  return message.trim().split("\n").at(-1) ?? message;
}
