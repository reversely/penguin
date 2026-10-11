import { createHash } from "node:crypto";

import { isObjectId, runGit, splitNul } from "@penguin/git-analysis";

/**
 * File names that pin a dependency graph. A change to any of them in the tested commit changes
 * the lockfile hash, so a check result never carries over to a different environment.
 */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "pdm.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

/**
 * What a check result applies to (PRD section 7): the tested commit, the lockfiles in it and the
 * command ID. `id` hashes all three, so two results compare equal exactly when they ran against
 * the same inputs.
 */
export interface ResultFingerprint {
  readonly commit: string;
  readonly lockfileHash: string;
  readonly commandId: string;
  readonly id: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Hashes every lockfile committed at `sha`, at any depth, by path and blob ID. Reads Git objects
 * only. A commit without lockfiles hashes the empty list, which is still a fixed value.
 */
export async function lockfileHash(repoPath: string, sha: string): Promise<string> {
  if (!isObjectId(sha)) throw new Error(`commit must be a full object ID, got ${JSON.stringify(sha)}`);
  const output = await runGit(repoPath, ["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", sha]);
  const entries: string[] = [];
  // Each record is `<mode> <type> <object ID>\t<path>`; ls-tree lists paths in sorted order.
  for (const record of splitNul(output)) {
    const tab = record.indexOf("\t");
    const path = record.slice(tab + 1);
    const objectId = record.slice(0, tab).split(" ")[2];
    if (LOCKFILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1))) entries.push(`${path}\0${objectId}\0`);
  }
  return sha256(entries.join(""));
}

/** Builds the fingerprint of a check that ran `commandId` on `commit`. */
export async function fingerprint(
  repoPath: string,
  commit: string,
  commandId: string,
): Promise<ResultFingerprint> {
  const lockHash = await lockfileHash(repoPath, commit);
  return {
    commit,
    lockfileHash: lockHash,
    commandId,
    id: sha256(JSON.stringify([commit, lockHash, commandId])),
  };
}
