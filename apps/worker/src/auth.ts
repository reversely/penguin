/** Bearer credentials on gateway requests. */

/** The token in an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(request: Request): string | undefined {
  return /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Compares the request's Bearer token with the deployer token. Both sides are hashed first, so the
 * comparison takes the same time whatever the token lengths and contents.
 */
export async function isDeployer(request: Request, deployerToken: string | undefined): Promise<boolean> {
  if (!deployerToken) return false;
  const given = bearerToken(request);
  if (given === undefined) return false;
  const [givenHash, expected] = await Promise.all([sha256(given), sha256(deployerToken)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (givenHash[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}
