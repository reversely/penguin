// Storage for the bridge's secrets (K4). The bridge reads and writes them through `KeyStore`, so
// tests use `MemoryKeyStore` and only `KeychainStore` touches the owner's OS keychain.

import { generateSigningKeyPair, importPrivateKey, importPublicKey } from "@penguin/issues";

/** A small secret store keyed by account name. Values are opaque strings. */
export interface KeyStore {
  /** Resolves null when the account holds no secret. */
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** Resolves true when a secret was deleted, false when there was none. */
  delete(account: string): Promise<boolean>;
}

/** Holds secrets in process memory only. For tests and one-shot runs that must not persist a key. */
export class MemoryKeyStore implements KeyStore {
  readonly #secrets = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    return this.#secrets.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.#secrets.set(account, secret);
  }

  async delete(account: string): Promise<boolean> {
    return this.#secrets.delete(account);
  }
}

/** The keychain service name every bridge secret is filed under. */
export const KEYCHAIN_SERVICE = "penguin-bridge";

/**
 * The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) through
 * `@napi-rs/keyring`. The native module loads on first use, so code that is handed another store
 * never loads it.
 */
export class KeychainStore implements KeyStore {
  readonly #service: string;

  constructor(service: string = KEYCHAIN_SERVICE) {
    this.#service = service;
  }

  async get(account: string): Promise<string | null> {
    return (await this.#entry(account)).getPassword();
  }

  async set(account: string, secret: string): Promise<void> {
    await (await this.#entry(account)).setPassword(secret);
  }

  async delete(account: string): Promise<boolean> {
    return (await this.#entry(account)).deleteCredential();
  }

  async #entry(account: string) {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(this.#service, account);
  }
}

/** The bridge's Ed25519 signing key. Only the public half is ever serialized. */
export interface BridgeSigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** The public key as a JWK (`kty`, `crv`, `x`), the form #15 registers with Penguin. */
  readonly publicJwk: JsonWebKey;
}

/** The key store account that holds an owner's bridge signing key. */
export function signingKeyAccount(ownerId: string): string {
  return `signing-key:${ownerId}`;
}

/**
 * Loads the owner's bridge signing key from `store`, generating and storing a new Ed25519 key pair
 * when none exists. Phase 1: the bridge makes its own key; bridge registration (#15) later sends
 * the public half to Penguin.
 */
export async function loadSigningKey(store: KeyStore, ownerId: string): Promise<BridgeSigningKey> {
  const account = signingKeyAccount(ownerId);
  const stored = await store.get(account);
  if (stored === null) {
    const pair = await generateSigningKeyPair();
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await store.set(account, JSON.stringify(privateJwk));
    return fromPrivateJwk(privateJwk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  if (!isEd25519PrivateJwk(parsed)) {
    // The message names the account only; the stored value is never echoed.
    throw new Error(`the key store entry ${account} does not hold an Ed25519 private key`);
  }
  return fromPrivateJwk(parsed);
}

async function fromPrivateJwk(jwk: JsonWebKey): Promise<BridgeSigningKey> {
  const publicJwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return {
    privateKey: await importPrivateKey(jwk),
    publicKey: await importPublicKey(publicJwk),
    publicJwk,
  };
}

function isEd25519PrivateJwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null) return false;
  const jwk = value as Record<string, unknown>;
  return jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string" && typeof jwk.d === "string";
}
