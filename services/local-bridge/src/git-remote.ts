// The remotes the bridge pushes to: a local bare repository (Phase 1) or an Artifacts repo named
// `penguin:<repo>` (Phase 2). An Artifacts repo is reached with a short-lived token that the
// bridge fetches from Penguin at push time and keeps in memory only (K2). The token reaches Git
// through the environment of the one command that needs it, never through an argument, a Git
// config file, a remote URL or the spool.

import { runGit } from "@penguin/git-analysis";

/** The remote cannot be reached right now. Entries waiting for it stay queued. */
export class RemoteUnavailableError extends Error {}

/** The remote refused the bridge for good, such as Penguin denying a token for the repo. */
export class RemoteRefusedError extends Error {}

/** A remote the bridge runs network Git commands against. */
export interface GitRemote {
  /** The name kept in the spool: a local path or `penguin:<repo>`. It never holds a credential. */
  readonly name: string;
  /** True for an Artifacts repo, false for a local path. */
  readonly artifacts: boolean;
  /**
   * Runs one Git command in `cwd` that talks to the remote. `args` receives the URL to put in
   * place of the remote. Global options (`-c`) may lead the returned array.
   */
  git(cwd: string, args: (url: string) => readonly string[]): Promise<string>;
}

/** Maps a spooled remote name to the remote it stands for. */
export type RemoteResolver = (name: string) => GitRemote;

const PENGUIN_SCHEME = "penguin:";

/** The project repo a `penguin:<repo>` name refers to, such as `issues` or `owner-jun`. */
export function penguinRepoOf(name: string): string | undefined {
  if (!name.startsWith(PENGUIN_SCHEME)) return undefined;
  const repo = name.slice(PENGUIN_SCHEME.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repo) ? repo : undefined;
}

export function penguinRemote(repo: string): string {
  return `${PENGUIN_SCHEME}${repo}`;
}

export function isPenguinRemote(name: string): boolean {
  return name.startsWith(PENGUIN_SCHEME);
}

/** A local bare repository, pushed to by path. */
export function localRemote(path: string): GitRemote {
  return { name: path, artifacts: false, git: (cwd, args) => runGit(cwd, args(path)) };
}

/** A resolver for a bridge with no registration: Artifacts names stay queued with a reason. */
export const unregisteredRemotes: RemoteResolver = (name) => {
  if (!isPenguinRemote(name)) return localRemote(name);
  return {
    name,
    artifacts: true,
    git: () => Promise.reject(new RemoteUnavailableError("this bridge is not registered; run `penguin-bridge register`")),
  };
};

/** A token on one Artifacts repo, as the Penguin token route returns it. */
export interface RepoToken {
  readonly repo: string;
  readonly scope: "read" | "write";
  readonly token: string;
  /** The repo's Git remote without credentials. */
  readonly remote: string;
  readonly expiresAt: string;
}

/** Fetches Artifacts tokens. `refresh` skips any cached token; `scope` defaults to write. */
export interface TokenSource {
  token(repo: string, options?: { refresh?: boolean; scope?: "read" | "write" }): Promise<RepoToken>;
}

/**
 * Artifacts accepts pushes over protocol v1 only. Clearing `credential.helper` and `core.askPass`
 * keeps an owner's stored credentials out of a request that already carries the token, and stops
 * a refused request from asking a helper, an editor's askpass program or a terminal for a password.
 */
export const ARTIFACTS_GIT_OPTIONS: readonly string[] = [
  "-c",
  "protocol.version=1",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
];

/**
 * The environment that hands Git the token as `http.extraHeader` for one command. Git reads
 * GIT_CONFIG_COUNT/KEY/VALUE as command-line configuration, so the header never appears in the
 * process arguments. Entries the owner's environment already holds are kept.
 */
export function tokenEnvironment(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const count = Number(base.GIT_CONFIG_COUNT ?? "0");
  const index = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Bearer ${token}`,
    // An editor's terminal sets GIT_ASKPASS, which Git asks even with terminal prompts off.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

// What Git prints when the server answers 401 or 403, with prompts and helpers turned off.
const AUTH_FAILURE =
  /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|returned error: 40[13]|\b40[13]\b (?:Unauthorized|Forbidden)/iu;

export function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && AUTH_FAILURE.test(error.message);
}

/**
 * An Artifacts repo. Each command takes a token of `scope` from `tokens`; a command the server
 * refuses for authentication runs once more with a freshly fetched token, so a token that expired or
 * was revoked between fetch and use is replaced without the owner doing anything.
 */
export function artifactsRemote(
  name: string,
  repo: string,
  tokens: () => Promise<TokenSource>,
  scope: "read" | "write" = "write",
): GitRemote {
  const attempt = async (cwd: string, args: (url: string) => readonly string[], refresh: boolean) => {
    const token = await (await tokens()).token(repo, { refresh, scope });
    return runGit(cwd, [...ARTIFACTS_GIT_OPTIONS, ...args(token.remote)], { env: tokenEnvironment(token.token) });
  };
  return {
    name,
    artifacts: true,
    async git(cwd, args) {
      try {
        return await attempt(cwd, args, false);
      } catch (error) {
        if (!isAuthFailure(error)) throw error;
        return attempt(cwd, args, true);
      }
    },
  };
}
