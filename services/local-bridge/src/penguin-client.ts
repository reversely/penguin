// The bridge's side of Penguin: registering the bridge (K4) and fetching Artifacts tokens (K2).
// The bridge token lives in the key store; the registration record beside the spool holds only
// what is not secret. Artifacts tokens are cached in process memory and never written anywhere.

import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  artifactsRemote,
  localRemote,
  penguinRepoOf,
  RemoteRefusedError,
  RemoteUnavailableError,
  type RemoteResolver,
  type RepoToken,
  type TokenSource,
} from "./git-remote.ts";
import { loadSigningKey, type KeyStore } from "./key-store.ts";

/** What the bridge keeps about its registration. Nothing here is secret. */
export interface BridgeRegistration {
  /** The Penguin Worker's origin, such as https://penguin.example.workers.dev. */
  readonly server: string;
  readonly bridgeId: string;
  readonly owner: string;
  readonly role: "owner" | "runner";
}

export type Fetch = typeof globalThis.fetch;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The key store account that holds an owner's bridge token. */
export function bridgeTokenAccount(ownerId: string): string {
  return `bridge-token:${ownerId}`;
}

export function registrationFile(stateDir: string): string {
  return join(resolve(stateDir), "bridge.json");
}

/**
 * The origin of a Penguin or Artifacts URL. Credentials travel only over HTTPS; plain HTTP is
 * accepted for a loopback host, which is `wrangler dev`.
 */
export function checkedOrigin(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${what} ${JSON.stringify(text)} is not a URL`);
  }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error(`${what} must be an https:// URL`);
  if (url.username !== "" || url.password !== "") throw new Error(`${what} must not carry credentials`);
  return url;
}

export interface RegisterOptions {
  server: string;
  code: string;
  owner: string;
  keyStore: KeyStore;
  stateDir: string;
  fetch?: Fetch;
}

/**
 * Spends a registration code: sends the owner's public signing key to Penguin, stores the
 * returned bridge token in the key store and the registration record in the state folder.
 */
export async function registerBridge(options: RegisterOptions): Promise<BridgeRegistration> {
  const { code, owner, keyStore, stateDir } = options;
  const server = checkedOrigin(options.server, "the Penguin server").origin;
  const key = await loadSigningKey(keyStore, owner);
  const response = await (options.fetch ?? fetch)(`${server}/bridges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, publicKey: key.publicJwk }),
  });
  if (response.status !== 201) {
    // The error body names the problem and never holds a token.
    const detail = await response.text().catch(() => "");
    throw new Error(`Penguin refused the registration (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const { bridgeId, owner: registeredOwner, role, bridgeToken } = body;
  if (
    typeof bridgeId !== "string" ||
    typeof bridgeToken !== "string" ||
    (role !== "owner" && role !== "runner") ||
    typeof registeredOwner !== "string"
  ) {
    throw new Error("Penguin answered the registration with an unexpected body");
  }
  if (registeredOwner !== owner) {
    // The code was issued for someone else; this bridge's key now sits under their name.
    throw new Error(`the registration code belongs to ${registeredOwner}, not ${owner}; ask for a code for ${owner}`);
  }
  const registration: BridgeRegistration = { server, bridgeId, owner, role };
  await keyStore.set(bridgeTokenAccount(owner), bridgeToken);
  await saveRegistration(stateDir, registration);
  return registration;
}

async function saveRegistration(stateDir: string, registration: BridgeRegistration): Promise<void> {
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const handle = await open(registrationFile(stateDir), "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registration, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

/** The registration in `stateDir`, or null when the bridge has not registered there. */
export async function readRegistration(stateDir: string): Promise<BridgeRegistration | null> {
  let text: string;
  try {
    text = await readFile(registrationFile(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as Partial<BridgeRegistration>;
  if (typeof value.server !== "string" || typeof value.owner !== "string" || typeof value.bridgeId !== "string") {
    throw new Error(`${registrationFile(stateDir)} is not a bridge registration`);
  }
  return value as BridgeRegistration;
}

export interface TokenClientOptions {
  server: string;
  bridgeToken: string;
  fetch?: Fetch;
  now?: () => number;
  /** A cached token with less than this left is replaced before use. */
  refreshMarginMs?: number;
}

/**
 * Fetches write tokens from Penguin's token route and caches each until shortly before it
 * expires. The cache is this object's memory; nothing is persisted.
 */
export class TokenClient implements TokenSource {
  readonly #server: string;
  readonly #bridgeToken: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #margin: number;
  readonly #cache = new Map<string, Promise<RepoToken>>();
  /** How many tokens this client has fetched, for tests and latency notes. */
  fetched = 0;

  constructor(options: TokenClientOptions) {
    this.#server = checkedOrigin(options.server, "the Penguin server").origin;
    this.#bridgeToken = options.bridgeToken;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#margin = options.refreshMarginMs ?? 30_000;
  }

  async token(repo: string, options: { refresh?: boolean } = {}): Promise<RepoToken> {
    const cached = this.#cache.get(repo);
    if (cached !== undefined && !options.refresh) {
      const token = await cached.catch(() => null);
      if (token !== null && Date.parse(token.expiresAt) - this.#now() > this.#margin) return token;
    }
    const pending = this.#mint(repo);
    this.#cache.set(repo, pending);
    pending.catch(() => {
      if (this.#cache.get(repo) === pending) this.#cache.delete(repo);
    });
    return pending;
  }

  async #mint(repo: string): Promise<RepoToken> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#server}/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#bridgeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo, scope: "write" }),
      });
    } catch (error) {
      throw new RemoteUnavailableError(`Penguin at ${this.#server} is unreachable: ${(error as Error).message}`);
    }
    this.fetched += 1;
    if (response.status === 403) {
      throw new RemoteRefusedError(`Penguin does not let this bridge write to ${repo}`);
    }
    if (response.status === 401) {
      throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
    }
    if (response.status === 404) throw new RemoteUnavailableError(`the repo ${repo} does not exist in Artifacts yet`);
    if (response.status !== 200) {
      throw new RemoteUnavailableError(`Penguin could not issue a token for ${repo} (HTTP ${response.status})`);
    }
    const body = (await response.json()) as Partial<RepoToken>;
    if (typeof body.token !== "string" || typeof body.remote !== "string" || Number.isNaN(Date.parse(body.expiresAt ?? ""))) {
      throw new RemoteUnavailableError(`Penguin answered the token request for ${repo} without a token and remote`);
    }
    checkedOrigin(body.remote, "the Artifacts remote");
    return { repo, scope: "write", token: body.token, remote: body.remote, expiresAt: body.expiresAt! };
  }
}

/**
 * The resolver a bridge command uses: local paths as they are, `penguin:<repo>` names through one
 * token client built from the registration in `stateDir` and the bridge token in `keyStore`.
 */
export function bridgeRemotes(stateDir: string, keyStore: KeyStore, fetchImpl?: Fetch): RemoteResolver {
  let client: Promise<TokenClient> | undefined;
  const tokens = () => {
    client ??= openTokenClient(stateDir, keyStore, fetchImpl);
    // A failed open is retried by the next command rather than remembered.
    client.catch(() => {
      client = undefined;
    });
    return client;
  };
  return (name) => {
    const repo = penguinRepoOf(name);
    if (repo !== undefined) return artifactsRemote(name, repo, tokens);
    if (name.startsWith("penguin:")) throw new Error(`${JSON.stringify(name)} does not name a Penguin repo`);
    return localRemote(name);
  };
}

async function openTokenClient(stateDir: string, keyStore: KeyStore, fetchImpl?: Fetch): Promise<TokenClient> {
  const registration = await readRegistration(stateDir);
  if (registration === null) {
    throw new RemoteUnavailableError("this bridge is not registered; run `penguin-bridge register`");
  }
  const bridgeToken = await keyStore.get(bridgeTokenAccount(registration.owner));
  if (bridgeToken === null) {
    throw new RemoteUnavailableError(`the key store holds no bridge token for ${registration.owner}; register again`);
  }
  return new TokenClient({ server: registration.server, bridgeToken, fetch: fetchImpl });
}
