/**
 * A local stand-in for GitHub's three OAuth endpoints, for tests and for `wrangler dev` without a
 * GitHub OAuth app. It approves every sign-in at once as the account named by the `login` query
 * parameter (the hint /auth/github passes on), or as the default login.
 *
 * It checks what GitHub checks: the client ID and secret, the redirect URI and the PKCE verifier of
 * each code, and that a code is used once.
 *
 * Local development, in two terminals:
 *   node tests/walkthrough/support/github-double.ts --port 8788 --login <github-login>
 *   npx wrangler dev -c apps/worker/wrangler.jsonc --ip 127.0.0.1 \
 *     --var PENGUIN_GITHUB_BASE_URL:http://127.0.0.1:8788 \
 *     --var GITHUB_OAUTH_CLIENT_ID:double-client --var GITHUB_OAUTH_CLIENT_SECRET:double-secret \
 *     --var PENGUIN_DASHBOARD_OWNERS:<github-login>:<owner-id>,...
 * then open http://127.0.0.1:8787/auth/github?login=<another-login> to sign in as another person.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The test double's own fixed client; no real GitHub OAuth app has these values.
export const DOUBLE_CLIENT = { clientId: "double-client", clientSecret: "double-secret" }; // pragma: allowlist secret

interface PendingCode {
  readonly login: string;
  readonly redirectUri: string;
  readonly challenge: string;
}

export interface GitHubDouble {
  readonly url: string;
  /** Every request the double received, as method and path. */
  readonly requests: string[];
  close(): Promise<void>;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export async function startGitHubDouble(defaultLogin: string, port = 0): Promise<GitHubDouble> {
  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, string>();
  const requests: string[] = [];

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://double");
    requests.push(`${request.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method === "GET" && url.pathname === "/login/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (url.searchParams.get("client_id") !== DOUBLE_CLIENT.clientId || !redirectUri || !state || !challenge) {
        return send(400, { error: "invalid authorize request" });
      }
      const code = base64url(randomBytes(16));
      codes.set(code, { login: url.searchParams.get("login") ?? defaultLogin, redirectUri, challenge });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      response.writeHead(302, { Location: back.toString() });
      return response.end();
    }

    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        const valid =
          pending !== undefined &&
          form.get("client_id") === DOUBLE_CLIENT.clientId &&
          form.get("client_secret") === DOUBLE_CLIENT.clientSecret &&
          form.get("redirect_uri") === pending.redirectUri &&
          base64url(createHash("sha256").update(verifier).digest()) === pending.challenge;
        if (!valid) return send(200, { error: "bad_verification_code" });
        const token = `gho_${base64url(randomBytes(16))}`;
        tokens.set(token, pending.login);
        send(200, { access_token: token, token_type: "bearer", scope: "" });
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/user") {
      const login = tokens.get(/^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
      if (login === undefined || !request.headers["user-agent"]) return send(401, { message: "Bad credentials" });
      return send(200, { login, id: 1 });
    }

    send(404, { message: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8788" }, login: { type: "string", default: "dev" } } });
  const double = await startGitHubDouble(values.login, Number(values.port));
  console.log(`GitHub double on ${double.url}, signing in as ${values.login} unless ?login= names another`);
}
