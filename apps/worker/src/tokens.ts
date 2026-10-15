/**
 * Short-lived per-repo Artifacts tokens for registered bridges.
 *
 * A bridge may hold `write` on its owner's fork and on the issues repo, and `read` on every other
 * project repo, a feature's fork included. A runner bridge also holds `write` on Huddle repos. A
 * feature's write token comes only from its own agent sessions (features.ts). Artifacts tokens only separate
 * read from write per repo, so the repo boundary is the push permission boundary. A write token on
 * another person's feature fork is minted only for one approved plan part (fix-write.ts in the
 * ProjectAgent): to the check runner's claim of any approved part, or to the originating agent through
 * `fix_token` for a write opened for it before #207, for PENGUIN_FIX_TOKEN_TTL_MINUTES.
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
  | { readonly role: "base" | "issues" | "record" }
  | { readonly role: "owner"; readonly ownerId: string }
  | { readonly role: "huddle"; readonly huddleId: string }
  | { readonly role: "feature"; readonly featureId: string };

/** Parses `base`, `issues`, `record`, `owner-<id>`, `huddle-<id>` or `feature-<id>`; anything else is undefined. */
export function parseProjectRepo(name: string): ProjectRepo | undefined {
  if (name === "base" || name === "issues" || name === "record") return { role: name };
  const owner = /^owner-(.+)$/.exec(name)?.[1];
  if (owner !== undefined && isValidRepoName(owner)) return { role: "owner", ownerId: owner };
  const huddle = /^huddle-(.+)$/.exec(name)?.[1];
  if (huddle !== undefined && isValidRepoName(huddle)) return { role: "huddle", huddleId: huddle };
  const feature = /^feature-(.+)$/.exec(name)?.[1];
  if (feature !== undefined && isValidRepoName(feature)) return { role: "feature", featureId: feature };
  return undefined;
}

/** The widest scope `bridge` may hold on `repo`. Penguin alone writes the record repo, so every bridge reads it. */
export function allowedScope(bridge: BridgeIdentity, repo: ProjectRepo): TokenScope {
  switch (repo.role) {
    case "issues":
      return "write";
    case "owner":
      return repo.ownerId === bridge.ownerId ? "write" : "read";
    case "huddle":
      return bridge.role === "runner" ? "write" : "read";
    case "base":
    case "record":
    case "feature":
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
    case "record":
      return names.record;
    case "owner":
      return names.owner(repo.ownerId);
    case "huddle":
      return names.huddle(repo.huddleId);
    case "feature":
      return names.feature(repo.featureId);
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

/**
 * Parses PENGUIN_FEATURE_TOKEN_TTL_MINUTES, the lifetime of a feature agent's write token, into
 * seconds. Unset or outside the range Artifacts accepts is undefined, so no feature token is minted.
 */
export function parseFeatureTokenTtl(minutes: string | undefined): number | undefined {
  if (minutes === undefined || !/^\d{1,6}$/.test(minutes)) return undefined;
  const ttl = Number(minutes) * 60;
  return ttl >= MIN_TOKEN_TTL_SECONDS && ttl <= MAX_TOKEN_TTL_SECONDS ? ttl : undefined;
}

/** A fix writer's token lasts this many minutes unless PENGUIN_FIX_TOKEN_TTL_MINUTES says otherwise. */
export const DEFAULT_FIX_TOKEN_TTL_MINUTES = 10;
/** PRD 0.4 section 8: a token on another person's fork lasts minutes, so at most an hour. */
export const MAX_FIX_TOKEN_TTL_MINUTES = 60;

/**
 * Parses PENGUIN_FIX_TOKEN_TTL_MINUTES, the lifetime of a write token on an affected feature's fork for
 * one approved plan part, into seconds. Unset is DEFAULT_FIX_TOKEN_TTL_MINUTES; a whole number of
 * minutes from 1 to MAX_FIX_TOKEN_TTL_MINUTES is taken; anything else is undefined, so no fix token is
 * minted.
 */
export function parseFixTokenTtl(minutes: string | undefined): number | undefined {
  if (minutes === undefined || minutes === "") return DEFAULT_FIX_TOKEN_TTL_MINUTES * 60;
  if (!/^[1-9][0-9]?$/u.test(minutes)) return undefined;
  const value = Number(minutes);
  return value <= MAX_FIX_TOKEN_TTL_MINUTES ? value * 60 : undefined;
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

/** A kept token is handed out again only while more than this is left of its life. */
export const TOKEN_REUSE_MARGIN_MS = 60_000;

/**
 * The tokens `/tokens` minted, one per Artifacts repo and scope, kept for the isolate's life so a
 * bridge's repeated requests make no Artifacts call (#218). Only settled tokens are kept, as plain
 * data: a promise or a repo handle belongs to the request that made it. The caller checks that the
 * bridge may hold the scope on the repo before asking; the key holds no bridge, so any bridge allowed
 * the same repo and scope gets the same token.
 */
export class TokenCache {
  readonly #tokens = new Map<string, MintedToken>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The kept token on `repoName` with `scope` while more than a minute of it is left, or a new one from `mint`. */
  async token(repoName: string, scope: TokenScope, mint: () => Promise<MintedToken>): Promise<MintedToken> {
    const key = `${scope} ${repoName}`;
    const kept = this.#tokens.get(key);
    // An unparseable expiry compares false, so the token is minted again.
    if (kept !== undefined && Date.parse(kept.expiresAt) - this.#now() > TOKEN_REUSE_MARGIN_MS) return kept;
    this.#tokens.delete(key);
    const minted = await mint();
    if (minted.scope === scope) this.#tokens.set(key, minted);
    return minted;
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
