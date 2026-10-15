// Ed25519 signatures over issue operations through WebCrypto, which Node 22 and the Workers runtime
// both provide. The signature covers the canonical bytes of every field except `signature`.

import type { Operation, UnsignedOperation } from "@penguin/protocol";

import { canonicalBytes } from "./canonical.ts";

const ED25519 = "Ed25519";

/** The exact bytes a signature covers: the canonical JSON of the operation without `signature`. */
export function signingBytes(operation: UnsignedOperation | Operation): Uint8Array<ArrayBuffer> {
  const { signature: _ignored, ...unsigned } = operation as Operation;
  return canonicalBytes(unsigned);
}

export async function signOperation(operation: UnsignedOperation, privateKey: CryptoKey): Promise<Operation> {
  const signature = await crypto.subtle.sign(ED25519, privateKey, signingBytes(operation));
  return { ...operation, signature: toBase64Url(new Uint8Array(signature)) };
}

/** True only when `signature` is a valid Ed25519 signature by `publicKey` over the other fields. */
export async function verifyOperation(operation: Operation, publicKey: CryptoKey): Promise<boolean> {
  const signature = fromBase64Url(operation.signature);
  if (signature === null || signature.byteLength !== 64) return false;
  try {
    return await crypto.subtle.verify(ED25519, publicKey, signature, signingBytes(operation));
  } catch {
    return false;
  }
}

/**
 * The bytes a bridge signs for a request it sends for its own owner: the canonical JSON of the route
 * and the body without `signature`. Naming the route keeps a signature from being reused on another.
 */
export function bridgeRequestBytes(route: string, body: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const { signature: _ignored, ...unsigned } = body;
  return canonicalBytes({ route, body: unsigned });
}

export async function signBridgeRequest(
  route: string,
  body: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<Record<string, unknown>> {
  const signature = await crypto.subtle.sign(ED25519, privateKey, bridgeRequestBytes(route, body));
  return { ...body, signature: toBase64Url(new Uint8Array(signature)) };
}

/** True only when the body's `signature` is a valid Ed25519 signature by `publicKey` over the route and the rest of the body. */
export async function verifyBridgeRequest(route: string, body: Record<string, unknown>, publicKey: CryptoKey): Promise<boolean> {
  const signature = typeof body["signature"] === "string" ? fromBase64Url(body["signature"]) : null;
  if (signature === null || signature.byteLength !== 64) return false;
  try {
    return await crypto.subtle.verify(ED25519, publicKey, signature, bridgeRequestBytes(route, body));
  } catch {
    return false;
  }
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ED25519, true, ["verify"]);
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ED25519, true, ["sign"]);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Reject spellings with stray trailing bits, so one signature has exactly one text form.
  return toBase64Url(bytes) === text ? bytes : null;
}
