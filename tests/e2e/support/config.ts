/**
 * The exit-check run's configuration, read from the environment. Secrets are read from files named by
 * the environment, never from a variable's value, so they stay out of shell history and process
 * listings. Nothing here prints a secret.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How the run signs in to the dashboard as a person. */
export type SignIn =
  /** Through the GitHub OAuth test double (tests/walkthrough/support/github-double.ts); a loopback Worker only. */
  | { readonly kind: "github-double"; readonly logins: Readonly<Record<"priya" | "jun", string>> }
  /** With session cookie values copied from a browser signed in to the deployed Worker. */
  | { readonly kind: "cookies"; readonly cookies: Readonly<Record<"priya" | "jun", string>> };

export interface ExitCheckConfig {
  /** The Worker's origin, such as https://penguin.example.workers.dev. */
  readonly url: string;
  readonly deployerToken: string;
  readonly signIn: SignIn;
  /** The owner id the integration runner's bridge registers as. */
  readonly runnerOwner: string;
  /** How long to wait for a live message or for operations to reach the issues repo. */
  readonly timeoutMs: number;
}

export type ConfigResult = { readonly ok: true; readonly config: ExitCheckConfig } | { readonly ok: false; readonly reason: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function readSecret(path: string, what: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (value === "") throw new Error(`${what} file ${path} is empty`);
  return value;
}

function signInFrom(env: NodeJS.ProcessEnv, url: URL): SignIn | string {
  const mode = env.PENGUIN_E2E_SIGN_IN ?? (LOOPBACK.has(url.hostname) ? "github-double" : "cookies");
  if (mode === "github-double") {
    if (!LOOPBACK.has(url.hostname)) return "the GitHub test double signs in to a loopback Worker only";
    return {
      kind: "github-double",
      logins: { priya: env.PENGUIN_E2E_PRIYA_LOGIN ?? "priya-gh", jun: env.PENGUIN_E2E_JUN_LOGIN ?? "jun-gh" },
    };
  }
  if (mode !== "cookies") return `PENGUIN_E2E_SIGN_IN must be github-double or cookies, not ${JSON.stringify(mode)}`;
  const priya = env.PENGUIN_E2E_PRIYA_COOKIE_FILE;
  const jun = env.PENGUIN_E2E_JUN_COOKIE_FILE;
  if (!priya || !jun) {
    return "set PENGUIN_E2E_PRIYA_COOKIE_FILE and PENGUIN_E2E_JUN_COOKIE_FILE to files holding each person's session cookie";
  }
  return { kind: "cookies", cookies: { priya: readSecret(priya, "priya's session cookie"), jun: readSecret(jun, "jun's session cookie") } };
}

/** The run's configuration, or why the run is skipped. */
export function exitCheckConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  if (!env.PENGUIN_E2E_URL) return { ok: false, reason: "set PENGUIN_E2E_URL to run the Phase 3 exit check (docs/mcp-setup.md)" };
  const url = new URL(env.PENGUIN_E2E_URL);
  const signIn = signInFrom(env, url);
  if (typeof signIn === "string") return { ok: false, reason: signIn };
  const tokenFile = env.PENGUIN_E2E_DEPLOYER_TOKEN_FILE ?? join(homedir(), ".config", "penguin", "deployer-token");
  return {
    ok: true,
    config: {
      url: url.origin,
      deployerToken: readSecret(tokenFile, "the deployer token"),
      signIn,
      runnerOwner: env.PENGUIN_E2E_RUNNER_OWNER ?? "runner",
      timeoutMs: Number(env.PENGUIN_E2E_TIMEOUT_MS ?? 60_000),
    },
  };
}
