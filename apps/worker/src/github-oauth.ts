/**
 * GitHub OAuth sign-in for the dashboard (open decision 7: GitHub OAuth; keys K6 and K8), following
 * GitHub's web application flow with `state` and PKCE (S256). Penguin asks for no scope: it reads
 * the signed-in account's public login once and discards the access token.
 *
 * A GitHub login reaches the dashboard only when PENGUIN_DASHBOARD_OWNERS maps it to a Penguin
 * owner id, so a GitHub account alone grants nothing.
 */

import { isValidRepoName } from "./repos.ts";
import { base64url } from "./session.ts";

export interface GitHubEndpoints {
  readonly authorize: string;
  readonly accessToken: string;
  readonly user: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  authorize: "https://github.com/login/oauth/authorize",
  accessToken: "https://github.com/login/oauth/access_token",
  user: "https://api.github.com/user",
};

/** The same three endpoints under one base URL, as served by a local test double. */
export function endpointsAt(base: string): GitHubEndpoints {
  const root = base.replace(/\/+$/, "");
  return {
    authorize: `${root}/login/oauth/authorize`,
    accessToken: `${root}/login/oauth/access_token`,
    user: `${root}/user`,
  };
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** A random value for `state` and the PKCE verifier: 32 bytes, base64url. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function authorizeUrl(
  endpoints: GitHubEndpoints,
  clientId: string,
  redirectUri: string,
  state: string,
  verifier: string,
  login: string | undefined,
): Promise<string> {
  const url = new URL(endpoints.authorize);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  if (login !== undefined) url.searchParams.set("login", login);
  return url.toString();
}

/** Exchanges the callback's code for the account's login, or returns undefined when GitHub refuses. */
export async function signedInLogin(
  fetcher: Fetch,
  endpoints: GitHubEndpoints,
  client: OAuthClient,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<string | undefined> {
  const tokenResponse = await fetcher(endpoints.accessToken, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) return undefined;
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof accessToken !== "string") return undefined;

  const userResponse = await fetcher(endpoints.user, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      // api.github.com rejects requests without a User-Agent.
      "User-Agent": "penguin-dashboard",
    },
  });
  if (!userResponse.ok) return undefined;
  const { login } = (await userResponse.json()) as { login?: unknown };
  return typeof login === "string" && login !== "" ? login : undefined;
}

/**
 * Parses PENGUIN_DASHBOARD_OWNERS, a comma-separated list of `<github login>:<owner id>` pairs,
 * into a map keyed by lowercase login (GitHub logins are case-insensitive). A pair whose owner id
 * is not a valid owner id (the /setup rule) is skipped.
 */
export function parseOwnerMap(value: string | undefined): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const match = /^\s*([A-Za-z0-9-]+)\s*:\s*(\S+)\s*$/.exec(pair);
    const [, login, owner] = match ?? [];
    if (login !== undefined && owner !== undefined && isValidRepoName(owner)) owners.set(login.toLowerCase(), owner);
  }
  return owners;
}
