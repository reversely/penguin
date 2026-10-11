/**
 * The dashboard's browser session (K6): a cookie the Worker sets after GitHub sign-in, naming the
 * Penguin owner and the GitHub login, with an expiry, signed with HMAC-SHA256.
 *
 * The HMAC key is derived with HKDF from the GitHub OAuth client secret (K8), so the session needs
 * no secret beyond the setup inventory. Rotating the client secret signs everyone out.
 *
 * The cookie is `__Host-` prefixed (Secure, Path=/, no Domain), HttpOnly and SameSite=Lax, so no
 * script and no cross-site POST carries it.
 */

export const SESSION_COOKIE = "__Host-penguin_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface DashboardSession {
  /** The Penguin owner id the GitHub login maps to. Every write is authored as this person. */
  readonly owner: string;
  readonly login: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The session signing key, derived from the OAuth client secret. */
export async function sessionKey(clientSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(clientSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("penguin dashboard session v1") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function encodeSession(key: CryptoKey, session: DashboardSession): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ o: session.owner, l: session.login, e: session.expiresAt })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

/** The session in a cookie value, or undefined when it is malformed, forged or expired. */
export async function decodeSession(key: CryptoKey, value: string, now: number): Promise<DashboardSession | undefined> {
  const [payload, signatureText, extra] = value.split(".");
  if (payload === undefined || signatureText === undefined || extra !== undefined) return undefined;
  const signature = fromBase64url(signatureText);
  if (signature === undefined) return undefined;
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payload)))) return undefined;
  const bytes = fromBase64url(payload);
  if (bytes === undefined) return undefined;
  const { o, l, e } = JSON.parse(new TextDecoder().decode(bytes)) as { o?: unknown; l?: unknown; e?: unknown };
  if (typeof o !== "string" || typeof l !== "string" || typeof e !== "number" || e <= now) return undefined;
  return { owner: o, login: l, expiresAt: e };
}

/** One cookie's value from a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}

/** The signed-in session on a request, or undefined. */
export async function requestSession(
  request: Request,
  key: CryptoKey | undefined,
  now: number,
): Promise<DashboardSession | undefined> {
  const value = readCookie(request, SESSION_COOKIE);
  if (key === undefined || value === undefined) return undefined;
  return decodeSession(key, value, now);
}
