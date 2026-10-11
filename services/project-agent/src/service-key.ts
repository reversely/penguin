// Penguin's service key, K5 `PENGUIN_OP_SIGNING_KEY`: an Ed25519 private key as a JSON Web Key,
// stored as a Worker secret (`wrangler secret put`, or `.dev.vars` for local development). It signs
// operations from MCP, the dashboard and Penguin itself. The private half is imported as
// non-extractable, so no code path can export it from the Worker.

export interface ServiceKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

const ED25519 = "Ed25519";

/** Imports K5. Throws when the secret is missing or is not an Ed25519 private JWK; the message never quotes it. */
export async function importServiceKey(secret: string | undefined): Promise<ServiceKey> {
  if (secret === undefined || secret === "") throw new Error("PENGUIN_OP_SIGNING_KEY is not set");
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(secret) as JsonWebKey;
  } catch {
    throw new Error("PENGUIN_OP_SIGNING_KEY is not a JSON Web Key");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("PENGUIN_OP_SIGNING_KEY is not an Ed25519 private JSON Web Key");
  }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, ED25519, false, ["sign"]),
    crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, ED25519, true, ["verify"]),
  ]);
  return { privateKey, publicKey };
}
