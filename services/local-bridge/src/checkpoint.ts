import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { runGit, splitNul } from "@penguin/git-analysis";
import { IDENTITY_HANDLE_MAX_LENGTH, IDENTITY_HANDLE_PATTERN } from "@penguin/protocol";

import {
  isPenguinRemote,
  penguinRemote,
  unregisteredRemotes,
  type GitRemote,
  type RemoteResolver,
} from "./git-remote.ts";
import { checkpointReportId, type CheckpointReporter } from "./checkpoint-report.ts";
import type { WorktreeRegistry } from "./registry.ts";
import type { Spool } from "./spool.ts";
import { drainSpool } from "./spool-drain.ts";

/**
 * How far one "yes" reaches. PRD open decision 3 (consent per worktree or per project) is still
 * open, so the scope is configurable:
 * - `each-publish`: every publish asks.
 * - `worktree` (default): a yes stands for later publishes from the same worktree.
 * - `project`: a yes stands for every worktree of this bridge's repository.
 * Under every scope the preview is printed before each push.
 */
export type ConsentScope = "each-publish" | "worktree" | "project";

/** The PRD `OwnerFork` record. */
export interface OwnerFork {
  owner_id: string;
  project_id: string;
  /**
   * `penguin:owner-<owner_id>`, the owner's fork in Artifacts, or the absolute path of a local
   * bare repository (Phase 1).
   */
  repo: string;
  latest_checkpoint_sha: string | null;
  publishing_consent: ConsentScope;
  /**
   * Whether a checkpoint commit built for an agent session ends with a `Penguin-Agent` trailer
   * naming the identity and its vendor. The owner sets it per project; absent means on.
   */
  agent_trailer?: boolean;
}

/** The identity registry the trailer's vendor is read from, relative to the repo root. */
export const IDENTITIES_FILE = "penguin/identities.json";

/** The trailer key on checkpoint commits built for an agent session. */
export const AGENT_TRAILER_KEY = "Penguin-Agent";

export interface PublishOptions {
  /** Must name the configured fork; any other destination is refused before Git runs. */
  remote?: string;
  /** The handle (`@<owner>/<name>`) of the agent identity whose session made this checkpoint. */
  identity?: string;
}

/** One tracked file in a checkpoint. Line counts are null for a binary file. */
export interface CheckpointFile {
  status: string;
  path: string;
  added: number | null;
  deleted: number | null;
}

export interface CheckpointPreview {
  worktree_id: string;
  branch: string;
  checkpoint_sha: string;
  /** The newest commit the fork already shares with the checkpoint; null when it shares none. */
  base_sha: string | null;
  files: CheckpointFile[];
  /**
   * False when the fork could not be read: the preview then lists every tracked file and the
   * push waits in the spool. Absent means true.
   */
  fork_reachable?: boolean;
}

export type PublishResult =
  | { status: "published"; preview: CheckpointPreview }
  | { status: "refused"; preview: CheckpointPreview }
  /** Consented and spooled; the fork was unreachable, so a later drain pushes it. */
  | { status: "queued"; preview: CheckpointPreview; reason: string }
  | { status: "up-to-date"; checkpoint_sha: string };

export interface CheckpointPublisherOptions {
  registry: WorktreeRegistry;
  fork: OwnerFork;
  /** Asks the owner after the preview has been written. Resolves true only on an explicit yes. */
  confirm: (preview: CheckpointPreview) => Promise<boolean>;
  write: (text: string) => void;
  /**
   * The bridge's outbound spool. When given, a consented push is spooled before it is attempted,
   * and an unreachable fork queues the push instead of failing the publish.
   */
  spool?: Spool;
  /** Turns the fork's name into the remote Git talks to. Defaults to local paths only. */
  remotes?: RemoteResolver;
  /**
   * Tells Penguin about a checkpoint pushed to an Artifacts fork. Without it the report waits in
   * the spool for a drain that has one.
   */
  reporter?: CheckpointReporter;
}

/**
 * Publishes worktree checkpoints to the owner's fork. A checkpoint is a commit of the worktree's
 * tracked files as they are on disk, parented on HEAD (see `checkpointCommit`), built without
 * touching the worktree, its index or any local ref. Routine local commits reach the fork only as ancestors of a checkpoint.
 */
export class CheckpointPublisher {
  readonly #options: CheckpointPublisherOptions;
  readonly #standingConsent = new Set<string>();

  constructor(options: CheckpointPublisherOptions) {
    this.#options = options;
  }

  /**
   * Builds the checkpoint for one registered worktree, prints the preview, asks for consent and
   * on consent pushes it to the fork branch named after the worktree's branch. With an identity,
   * a commit the bridge builds carries that identity's `Penguin-Agent` trailer unless the project's
   * `agent_trailer` is off (see `agentTrailer`). Whether or not a trailer is stamped, an identity
   * that belongs to another owner than the fork's is refused with an error before the fork is read
   * (see `refuseForeignIdentity`).
   */
  async publish(id: string, { remote, identity }: PublishOptions = {}): Promise<PublishResult> {
    const { registry, fork, confirm, write, spool } = this.#options;
    const record = registry.get(id);
    if (!record) throw new Error(`unknown worktree ${id}`);
    if (record.owner_id !== fork.owner_id) {
      throw new Error(`worktree ${id} belongs to ${record.owner_id}, not the fork owner ${fork.owner_id}`);
    }
    if (record.branch === null) throw new Error(`worktree ${id} has a detached HEAD; check out a branch first`);
    const worktree = registry.pathOf(id);
    const forkRef = `refs/heads/${record.branch}`;

    // The identity's owner is checked before the fork is read or anything is built, on every
    // publish that names an identity, whether or not the project's agent_trailer stamps a trailer.
    const stamping = identity !== undefined && fork.agent_trailer !== false;
    let head: string | undefined;
    let identities: unknown[] | null = null;
    if (identity !== undefined && isHandle(identity)) {
      head = await revParse(worktree, "HEAD^{commit}");
      identities = await committedIdentities(worktree, head);
      refuseForeignIdentity(identity, identities, fork.owner_id, head);
    }

    const { path: forkPath, reachable: located } = await resolveFork(fork, remote, spool !== undefined);
    const forkRemote = (this.#options.remotes ?? unregisteredRemotes)(forkPath);

    let reachable = located;
    let forkTips = new Map<string, string>();
    if (reachable) {
      try {
        forkTips = await listForkBranches(worktree, forkRemote);
      } catch (error) {
        // With a spool the push waits for the fork; without one there is nothing to wait in.
        if (spool === undefined) throw error;
        reachable = false;
      }
    }
    const localTips = await filterAsync([...forkTips.values()], (sha) =>
      gitSucceeds(worktree, ["cat-file", "-e", `${sha}^{commit}`]),
    );
    const tip = forkTips.get(forkRef);
    const previous = tip !== undefined && localTips.includes(tip) ? tip : null;

    head ??= await revParse(worktree, "HEAD^{commit}");
    const tree = await trackedTree(worktree, head);
    if (
      previous !== null &&
      (await revParse(worktree, `${previous}^{tree}`)) === tree &&
      (await isAncestor(worktree, head, previous))
    ) {
      return { status: "up-to-date", checkpoint_sha: previous };
    }
    const message = [`Penguin checkpoint of ${record.branch}`];
    if (stamping) {
      const trailer = agentTrailer(identity, identities, head);
      if (typeof trailer === "string") message.push(trailer);
      else write(`Warning: ${trailer.warning}; the checkpoint carries no ${AGENT_TRAILER_KEY} trailer.\n`);
    }
    const checkpoint = await checkpointCommit(worktree, tree, head, previous, message);
    const base = await sharedBase(worktree, checkpoint, localTips);
    const preview: CheckpointPreview = {
      worktree_id: id,
      branch: record.branch,
      checkpoint_sha: checkpoint,
      base_sha: base,
      files: await checkpointFiles(worktree, base, checkpoint),
      ...(reachable ? {} : { fork_reachable: false }),
    };
    write(formatPreview(preview, fork.owner_id));

    const grant = fork.publishing_consent === "project" ? "project" : `worktree:${id}`;
    if (fork.publishing_consent !== "each-publish" && this.#standingConsent.has(grant)) {
      write(`Standing consent (${fork.publishing_consent}) covers this publish.\n`);
    } else if (await confirm(preview)) {
      if (fork.publishing_consent !== "each-publish") this.#standingConsent.add(grant);
    } else {
      write("Not published. The fork is unchanged.\n");
      return { status: "refused", preview };
    }

    if (spool === undefined) {
      // No force: a fork branch that moved elsewhere rejects the push instead of being overwritten.
      await forkRemote.git(worktree, (url) => ["push", "--porcelain", "--end-of-options", url, `${checkpoint}:${forkRef}`]);
    } else {
      const id = checkpointEntryId(forkPath, forkRef, checkpoint);
      await spool.enqueue({ kind: "checkpoint", id, worktree, fork: forkPath, ref: forkRef, sha: checkpoint });
      const drained = await drainSpool(spool, this.#options.remotes, this.#options.reporter);
      const failed = drained.failed.find((item) => item.id === id);
      if (failed) throw new Error(failed.reason);
      const waiting = drained.waiting.find((item) => item.id === id);
      if (waiting) {
        write(`Queued ${checkpoint} for ${forkRef}: ${waiting.reason}. The bridge pushes it when the fork is reachable.\n`);
        return { status: "queued", preview, reason: waiting.reason };
      }
      const reportId = checkpointReportId(id);
      const report = [...drained.waiting, ...drained.failed].find((item) => item.id === reportId);
      if (report) write(`Penguin has not recorded ${checkpoint} as the fork's latest checkpoint: ${report.reason}\n`);
    }
    fork.latest_checkpoint_sha = checkpoint;
    write(`Published ${checkpoint} to ${forkRef}.\n`);
    return { status: "published", preview };
  }

  /** Withdraws every standing consent, so the next publish asks again. */
  revokeConsent(): void {
    this.#standingConsent.clear();
  }
}

/** The spool ID of one checkpoint push: the commit and a hash of its destination. */
export function checkpointEntryId(fork: string, ref: string, sha: string): string {
  return `checkpoint-${sha}-${createHash("sha256").update(`${fork}\0${ref}`).digest("hex").slice(0, 16)}`;
}

/**
 * Returns the fork's real path after checking that it is an absolute path to a bare repository
 * and that `remote`, if given, names the same repository. With `allowUnreachable`, a fork path
 * that does not resolve is returned as given and marked unreachable; the bare check then runs
 * when the spooled push is drained.
 */
async function resolveFork(
  fork: OwnerFork,
  remote: string | undefined,
  allowUnreachable: boolean,
): Promise<{ path: string; reachable: boolean }> {
  if (isPenguinRemote(fork.repo)) {
    // The Worker grants write on owner-<id> to that owner's bridge only; refuse any other name here too.
    const own = penguinRemote(`owner-${fork.owner_id}`);
    if (fork.repo !== own) throw new Error(`fork ${fork.repo} is not ${fork.owner_id}'s fork ${own}`);
    if (remote !== undefined && remote !== own) {
      throw new Error(`refusing to push to ${JSON.stringify(remote)}: the only allowed remote is the owner's fork ${own}`);
    }
    return { path: own, reachable: true };
  }
  if (!isAbsolute(fork.repo)) throw new Error(`fork path must be absolute, got ${JSON.stringify(fork.repo)}`);
  const resolved = await realpath(fork.repo).catch((error: unknown) => {
    if (allowUnreachable) return null;
    throw error;
  });
  const forkPath = resolved ?? fork.repo;
  if (remote !== undefined) {
    const target = isAbsolute(remote) ? await realpath(remote).catch(() => remote) : remote;
    if (target !== forkPath) {
      throw new Error(`refusing to push to ${JSON.stringify(remote)}: the only allowed remote is the owner's fork ${forkPath}`);
    }
  }
  if (resolved === null) return { path: forkPath, reachable: false };
  if ((await runGit(forkPath, ["rev-parse", "--is-bare-repository"])).trim() !== "true") {
    throw new Error(`fork ${forkPath} is not a bare repository`);
  }
  return { path: forkPath, reachable: true };
}

/**
 * The tree of the worktree's tracked files as they are on disk. `git stash create` writes its
 * objects without updating any ref, the index or the working tree, and skips untracked and
 * ignored files. It prints nothing when the worktree matches HEAD.
 */
async function trackedTree(worktree: string, head: string): Promise<string> {
  const stash = (await runGit(worktree, ["stash", "create"])).trim();
  return revParse(worktree, `${stash || head}^{tree}`);
}

/**
 * The checkpoint commit for `tree`, parented on HEAD. When the fork branch holds an earlier
 * checkpoint that HEAD does not contain, that checkpoint becomes a second parent, so every push
 * fast-forwards and the fork keeps each published checkpoint in its history without a force push.
 * A clean worktree whose HEAD already contains the fork branch publishes HEAD itself.
 */
async function checkpointCommit(
  worktree: string,
  tree: string,
  head: string,
  previous: string | null,
  paragraphs: string[],
): Promise<string> {
  const parents = [head];
  if (previous !== null && previous !== head && !(await isAncestor(worktree, previous, head))) {
    parents.push(previous);
  }
  if (parents.length === 1 && (await revParse(worktree, `${head}^{tree}`)) === tree) return head;
  const parentArgs = parents.flatMap((parent) => ["-p", parent]);
  // Each -m is one paragraph, so a trailer passed last becomes the message's trailer block.
  const messageArgs = paragraphs.flatMap((paragraph) => ["-m", paragraph]);
  return (await runGit(worktree, ["commit-tree", ...parentArgs, ...messageArgs, tree])).trim();
}

const HANDLE = new RegExp(IDENTITY_HANDLE_PATTERN, "u");
const VENDOR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const VENDOR_MAX_LENGTH = 64;

/** Whether `handle` is an identity handle, `@<owner>/<name>`, safe to put in a commit message. */
function isHandle(handle: string): boolean {
  return handle.length <= IDENTITY_HANDLE_MAX_LENGTH && HANDLE.test(handle);
}

/**
 * The `identities` array of `penguin/identities.json` as committed at `head`, so an uncommitted
 * edit cannot change what it says; null when the file cannot be read or parsed.
 */
async function committedIdentities(worktree: string, head: string): Promise<unknown[] | null> {
  try {
    // `cat-file blob` returns the committed bytes as-is; `git show` could apply a textconv filter.
    const text = await runGit(worktree, ["cat-file", "blob", `${head}:${IDENTITIES_FILE}`]);
    const entries = (JSON.parse(text) as { identities?: unknown } | null)?.identities;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return null;
  }
}

function registryEntry(identities: unknown[] | null, handle: string): object | undefined {
  const entry = identities?.find((item: unknown) => (item as { handle?: unknown } | null)?.handle === handle);
  return typeof entry === "object" && entry !== null ? entry : undefined;
}

/**
 * Throws unless `handle` may be stamped on a checkpoint in `forkOwner`'s fork. A team identity, a
 * registry entry with an `owners` array, must list the fork owner. Any other handle's owner half
 * must be the fork owner, whether or not the registry lists it or can be read.
 */
function refuseForeignIdentity(handle: string, identities: unknown[] | null, forkOwner: string, head: string): void {
  const owners: unknown = (registryEntry(identities, handle) as { owners?: unknown } | undefined)?.owners;
  if (Array.isArray(owners)) {
    if (owners.includes(forkOwner)) return;
    throw new Error(
      `refusing to publish as ${handle}: its owners in ${IDENTITIES_FILE} at ${head.slice(0, 12)} do not include ${forkOwner}, the fork owner`,
    );
  }
  const owner = handle.slice(1, handle.indexOf("/"));
  if (owner !== forkOwner) {
    throw new Error(`refusing to publish as ${handle}: the identity belongs to @${owner}, not to ${forkOwner}, the fork owner`);
  }
}

/**
 * The `Penguin-Agent: @<owner>/<name> (<vendor>)` trailer for `handle`, with the vendor read from
 * the registry as committed at `head` (see `committedIdentities`). The trailer carries no email:
 * Penguin strips it before a GitHub export, so no account has to match. Returns a warning instead
 * when the handle is not in the registry or the registry cannot be read; a missing trailer never
 * fails a checkpoint. An identity of another owner is refused earlier by `refuseForeignIdentity`.
 */
function agentTrailer(handle: string, identities: unknown[] | null, head: string): string | { warning: string } {
  // The handle and vendor go into a commit message, so both are checked before use.
  if (!isHandle(handle)) return { warning: `${JSON.stringify(handle)} is not an identity handle` };
  const at = head.slice(0, 12);
  if (identities === null) return { warning: `${IDENTITIES_FILE} at ${at} could not be read` };
  const entry = registryEntry(identities, handle);
  if (entry === undefined) return { warning: `identity ${handle} is not in ${IDENTITIES_FILE} at ${at}` };
  const vendor: unknown = (entry as { vendor?: unknown }).vendor;
  if (typeof vendor !== "string" || vendor.length > VENDOR_MAX_LENGTH || !VENDOR.test(vendor)) {
    return { warning: `identity ${handle} has no valid vendor in ${IDENTITIES_FILE} at ${at}` };
  }
  return `${AGENT_TRAILER_KEY}: ${handle} (${vendor})`;
}

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--verify", "--end-of-options", rev])).trim();
}

function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return runGit(cwd, args).then(
    () => true,
    () => false,
  );
}

function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitSucceeds(cwd, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]);
}

async function filterAsync<T>(items: T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, index) => kept[index]);
}

/** Branch tips of the fork, by full ref name. */
async function listForkBranches(worktree: string, fork: GitRemote): Promise<Map<string, string>> {
  const output = await fork.git(worktree, (url) => ["ls-remote", "--end-of-options", url]);
  const tips = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha && ref?.startsWith("refs/heads/")) tips.set(ref, sha);
  }
  return tips;
}

/** The best common ancestor of the checkpoint and the fork tips present locally, or null. */
async function sharedBase(worktree: string, checkpoint: string, localTips: string[]): Promise<string | null> {
  if (localTips.length === 0) return null;
  // With several tips, merge-base answers for the checkpoint against all of them at once.
  return runGit(worktree, ["merge-base", "--end-of-options", checkpoint, ...localTips]).then(
    (out) => out.trim() || null,
    () => null,
  );
}

/** Tracked files that differ between `base` (the empty tree when null) and the checkpoint. */
async function checkpointFiles(worktree: string, base: string | null, checkpoint: string): Promise<CheckpointFile[]> {
  const from = base ?? (await runGit(worktree, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  const diff = (format: string) =>
    runGit(worktree, ["diff", format, "-z", "--no-renames", "--no-ext-diff", "--end-of-options", from, checkpoint, "--"]);
  const [statusOut, numstatOut] = await Promise.all([diff("--name-status"), diff("--numstat")]);

  const files = new Map<string, CheckpointFile>();
  const statusFields = splitNul(statusOut);
  for (let i = 0; i + 1 < statusFields.length; i += 2) {
    const path = statusFields[i + 1]!;
    files.set(path, { status: statusFields[i]!, path, added: null, deleted: null });
  }
  // With -z and no renames, each numstat record is "added\tdeleted\tpath"; "-" marks binary.
  for (const record of splitNul(numstatOut)) {
    const [added, deleted, ...rest] = record.split("\t");
    const file = files.get(rest.join("\t"));
    if (!file) continue;
    file.added = added === "-" ? null : Number(added);
    file.deleted = deleted === "-" ? null : Number(deleted);
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The consent preview. Each file line starts with a fixed 20-column status and stat prefix and
 * then the full path, never truncated; a path longer than the terminal wraps. Paths holding
 * control characters are printed JSON-quoted so they cannot rewrite the terminal.
 */
export function formatPreview(preview: CheckpointPreview, ownerId: string): string {
  const short = (sha: string) => sha.slice(0, 12);
  const lines = [
    `Checkpoint ${short(preview.checkpoint_sha)} of branch ${preview.branch}`,
    `Destination: ${ownerId}'s fork, refs/heads/${preview.branch}`,
    preview.fork_reachable === false
      ? "The fork is unreachable, so every tracked file is listed and the push is queued."
      : preview.base_sha === null
        ? "The fork shares no commit with it, so every tracked file is listed."
      : `Changes since ${short(preview.base_sha)}, the newest commit the fork already has.`,
    `${preview.files.length} tracked file${preview.files.length === 1 ? "" : "s"} will be published:`,
  ];
  for (const file of preview.files) {
    const stat =
      file.added === null || file.deleted === null ? "binary" : `+${file.added} -${file.deleted}`;
    lines.push(`  ${file.status.padEnd(2)} ${stat.padStart(13)}  ${displayPath(file.path)}`);
  }
  lines.push("Untracked and ignored files are never published.");
  return `${lines.join("\n")}\n`;
}

function displayPath(path: string): string {
  return /[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path;
}
