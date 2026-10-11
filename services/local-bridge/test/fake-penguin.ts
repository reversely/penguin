// A stand-in for the Penguin Worker and Artifacts on a loopback port, for bridge tests. It serves
// bridge registration, the token route and Git smart HTTP through `git http-backend`, and it
// accepts a Git request only with an unexpired Bearer token minted for that repo, as Artifacts does.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";

export interface GitRequest {
  readonly repo: string;
  readonly service: string;
  /** GET for a ref advertisement, POST for an upload or a push. */
  readonly method: string;
  /** The Git-Protocol header, or "" when the client sent none. */
  readonly protocol: string;
  /** The scheme of the Authorization header ("Bearer", "Basic") or "" when absent. */
  readonly scheme: string;
  /** True when the server let the request through. */
  readonly accepted: boolean;
}

export class FakePenguin {
  readonly root: string;
  readonly owner: string;
  readonly code = `code-${randomBytes(8).toString("hex")}`;
  readonly bridgeToken = `pbt_${randomBytes(16).toString("hex")}`;
  /** Every Artifacts token minted, in order. */
  readonly minted: { repo: string; token: string }[] = [];
  readonly gitRequests: GitRequest[] = [];
  ttlSeconds = 3600;
  /** The role the registration answers with. */
  role: "owner" | "runner" = "owner";
  /** Answers GET /operations/pending for the registered bridge; unset answers 404. */
  pendingOperations: ((caller: { bridgeId: string; role: string }) => unknown) | undefined;
  #codeUsed = false;
  readonly #valid = new Map<string, { repo: string; expires: number }>();
  #server: Server | undefined;
  origin = "";

  constructor(root: string, owner: string) {
    this.root = root;
    this.owner = owner;
  }

  async start(repos: readonly string[]): Promise<void> {
    for (const repo of repos) await runGit(this.root, ["init", "--quiet", "--bare", "-b", "main", join(this.root, `${repo}.git`)]);
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    await new Promise<void>((done) => this.#server!.listen(0, "127.0.0.1", done));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise((done) => this.#server?.close(done));
  }

  /** Makes every token minted so far unusable, as if each had reached its expiry. */
  expireAll(): void {
    this.#valid.clear();
  }

  repoPath(repo: string): string {
    return join(this.root, `${repo}.git`);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    if (request.method === "POST" && url.pathname === "/bridges") return this.#register(request, response);
    if (request.method === "POST" && url.pathname === "/tokens") return this.#token(request, response);
    if (request.method === "GET" && url.pathname === "/operations/pending") return this.#pending(request, response);
    const git = /^\/git\/penguin\/([A-Za-z0-9._-]+)\.git(\/.*)$/.exec(url.pathname);
    if (git) return this.#git(request, response, git[1]!, git[2]!, url);
    response.writeHead(404).end();
  }

  async #register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(request)) as { code?: string; publicKey?: { kty?: string } };
    if (body.code !== this.code || this.#codeUsed || body.publicKey?.kty !== "OKP") {
      return json(response, 401, { error: "the registration code is unknown, used or expired" });
    }
    this.#codeUsed = true;
    json(response, 201, { bridgeId: "bridge-1", owner: this.owner, role: this.role, bridgeToken: this.bridgeToken });
  }

  async #token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.bridgeToken}`) return json(response, 401, { error: "unauthorized" });
    const { repo, scope } = JSON.parse(await readBody(request)) as { repo: string; scope: string };
    const ownFork = repo === `owner-${this.owner}`;
    if (scope === "write" && repo !== "issues" && !ownFork) return json(response, 403, { error: "forbidden" });
    if (!existsSync(this.repoPath(repo))) return json(response, 404, { error: "not found", repo });
    const expires = Date.now() + this.ttlSeconds * 1000;
    const token = `art_v1_${randomBytes(20).toString("hex")}?expires=${Math.floor(expires / 1000)}`;
    this.#valid.set(token, { repo, expires });
    this.minted.push({ repo, token });
    const remote = `${this.origin}/git/penguin/${repo}.git`;
    json(response, 200, { repo, scope, token, remote, expiresAt: new Date(expires).toISOString() });
  }

  /** Mirrors the Worker's route: the caller's role comes from its registration, not the request. */
  async #pending(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.bridgeToken}`) return json(response, 401, { error: "unauthorized" });
    if (this.pendingOperations === undefined) return json(response, 404, { error: "not found" });
    const listing = this.pendingOperations({ bridgeId: "bridge-1", role: this.role }) as {
      status: string;
      files?: unknown;
      message?: string;
    };
    if (listing.status === "forbidden") return json(response, 403, { error: "forbidden", message: listing.message });
    json(response, 200, { files: listing.files });
  }

  async #git(request: IncomingMessage, response: ServerResponse, repo: string, rest: string, url: URL): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const grant = this.#valid.get(authorization.replace(/^Bearer /, ""));
    const accepted = authorization.startsWith("Bearer ") && grant?.repo === repo && grant.expires > Date.now();
    this.gitRequests.push({
      repo,
      service: url.searchParams.get("service") ?? rest.slice(1),
      method: request.method ?? "GET",
      protocol: String(request.headers["git-protocol"] ?? ""),
      scheme: authorization.split(" ")[0] ?? "",
      accepted,
    });
    if (!accepted) {
      request.resume();
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="artifacts"' }).end();
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${repo}.git${rest}`,
        REQUEST_METHOD: request.method ?? "GET",
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        REMOTE_USER: "bridge",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise((done) => child.on("close", done));
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    const headerEnd = split >= 0 ? split : output.indexOf("\n\n");
    const gap = split >= 0 ? 4 : 2;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of output.subarray(0, headerEnd).toString("latin1").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else if (name !== "") headers[name] = value;
    }
    response.writeHead(status, headers).end(output.subarray(headerEnd + gap));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    request.on("error", fail);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
