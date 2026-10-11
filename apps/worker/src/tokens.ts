/**
 * Short-lived per-repo Artifacts tokens for registered bridges.
 *
 * A bridge may hold `write` on its owner's fork and on the issues repo, and `read` on every other
 * project repo. A runner bridge also holds `write` on Huddle repos. Artifacts tokens only separate
 * read from write per repo, so the repo boundary is the push permission boundary.
 *
 * Token plaintext passes through this module into the response body only; it is never logged.
 */

import type { BridgeIdentity } from "@penguin/project-agent";

import { artifactsErrorCode, isValidRepoName, type RepoNames } from "./repos.ts";

export type TokenScope = "read" | "write";

/** Artifacts accepts a token TTL from 60 seconds to one year. */
export const MIN_TOKEN_TTL_SECONDS = 60;
export const MAX_TOKEN_TTL_SECONDS = 31_536_000;
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** A repo named as the bridge names it: without the deployment's repo prefix. */
export type ProjectRepo =
  | { readonly role: "base" | "issues" }
  | { readonly role: "owner"; readonly ownerId: string }
  | { readonly role: "huddle"; readonly huddleId: string };

/** Parses `base`, `issues`, `owner-<id>` or `huddle-<id>`; anything else is undefined. */
export function parseProjectRepo(name: string): ProjectRepo | undefined {
  if (name === "base" || name === "issues") return { role: name };
  const owner = /^owner-(.+)$/.exec(name)?.[1];
  if (owner !== undefined && isValidRepoName(owner)) return { role: "owner", ownerId: owner };
  const huddle = /^huddle-(.+)$/.exec(name)?.[1];
  if (huddle !== undefined && isValidRepoName(huddle)) return { role: "huddle", huddleId: huddle };
  return undefined;
}

/** The widest scope `bridge` may hold on `repo`. */
export function allowedScope(bridge: BridgeIdentity, repo: ProjectRepo): TokenScope {
  switch (repo.role) {
    case "issues":
      return "write";
    case "owner":
      return repo.ownerId === bridge.ownerId ? "write" : "read";
    case "huddle":
      return bridge.role === "runner" ? "write" : "read";
    case "base":
      return "read";
  }
}

export function isPermitted(requested: TokenScope, allowed: TokenScope): boolean {
  return requested === "read" || allowed === "write";
}

/** The full Artifacts repo name for `repo` under `names`' prefix. */
export function artifactsRepoName(repo: ProjectRepo, names: RepoNames): string {
  switch (repo.role) {
    case "base":
      return names.base;
    case "issues":
      return names.issues;
    case "owner":
      return names.owner(repo.ownerId);
    case "huddle":
      return names.huddle(repo.huddleId);
  }
}

/**
 * Parses the PENGUIN_TOKEN_TTL_SECONDS value. Unset means the default; a value outside the range
 * Artifacts accepts is undefined, so the token route refuses to mint rather than guess.
 */
export function parseTokenTtl(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return DEFAULT_TOKEN_TTL_SECONDS;
  if (!/^\d+$/.test(value)) return undefined;
  const ttl = Number(value);
  return ttl >= MIN_TOKEN_TTL_SECONDS && ttl <= MAX_TOKEN_TTL_SECONDS ? ttl : undefined;
}

/** The subset of the binding's `ArtifactsRepo` capability that minting calls. */
export interface TokenRepoHandle extends Disposable {
  createToken(scope: TokenScope, ttl: number): Promise<{ plaintext: string; expiresAt: string; scope: TokenScope }>;
  info(): Promise<{ remote: string }>;
}

export interface TokenArtifacts {
  get(name: string): Promise<TokenRepoHandle>;
}

export interface MintedToken {
  readonly token: string;
  /** The repo's HTTPS Git remote, which the bridge pushes to with the token in a header. */
  readonly remote: string;
  readonly scope: TokenScope;
  readonly expiresAt: string;
}

export class RepoNotFoundError extends Error {
  constructor(name: string) {
    super(`repo ${JSON.stringify(name)} does not exist`);
    this.name = "RepoNotFoundError";
  }
}

/**
 * Mints one token on `repoName` and reads the repo's Git remote, so the bridge never has to build
 * the account-specific remote URL itself.
 *
 * @throws RepoNotFoundError when Artifacts has no repo by that name.
 */
export async function mintRepoToken(
  artifacts: TokenArtifacts,
  repoName: string,
  scope: TokenScope,
  ttlSeconds: number,
): Promise<MintedToken> {
  let repo: TokenRepoHandle;
  try {
    repo = await artifacts.get(repoName);
  } catch (error) {
    if (artifactsErrorCode(error) === "NOT_FOUND") throw new RepoNotFoundError(repoName);
    throw error;
  }
  try {
    const [created, info] = await Promise.all([repo.createToken(scope, ttlSeconds), repo.info()]);
    return { token: created.plaintext, remote: info.remote, scope: created.scope, expiresAt: created.expiresAt };
  } finally {
    repo[Symbol.dispose]();
  }
}
