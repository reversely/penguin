// A local preview of the dashboard over a project seeded from one fixture (seed.ts), for screenshots,
// layout audits and timing the team view. It serves the built dashboard on the Worker's own routes
// (handleDashboardRoute) with the seeded stores behind them. Nothing leaves the machine.
//
//   npm run build -w @penguin/dashboard
//   node scripts/preview/dashboard.ts [--example identity-unification|money-minor-units] [--port 8792] [--as <owner>]
//
// A request signs in as the owner its X-Preview-Owner header names, or else as the person the
// `preview-owner` cookie names, or else as the --as owner or the fixture's originating person. Opening
// /preview/as/<owner> sets that cookie and opens the team view, so a browser can switch seats.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { inboxChangedMessage } from "@penguin/protocol";

import { handleDashboardRoute } from "../../apps/worker/src/dashboard.ts";
import { parseOwnerMap } from "../../apps/worker/src/github-oauth.ts";
import { encodeSession, SESSION_COOKIE, sessionKey } from "../../apps/worker/src/session.ts";
import { FIXTURES, seed, type FixtureName } from "./seed.ts";

const ROOT = join(import.meta.dirname, "../..");
const { values: args } = parseArgs({
  options: { example: { type: "string", default: "identity-unification" }, port: { type: "string", default: "8792" }, as: { type: "string" } },
});
const fixture = args.example as FixtureName;
if (!FIXTURES.includes(fixture)) throw new Error(`--example must be one of ${FIXTURES.join(", ")}`);
const port = Number(args.port);

const started = performance.now();
const preview = await seed(fixture);
for (const step of preview.steps) console.log(`${String(step.ms).padStart(6)} ms  ${step.step}`);
console.log(`${fixture}: seeded in ${Math.round(performance.now() - started)} ms`);

const people = [...new Set([...preview.scopeMap.scopes.values()].map((scope) => scope.ownerId))];
// The originating person: the one whose agent called the tools, as the demo story's seat.
const defaultOwner = args.as ?? preview.features.list().find((feature) => preview.tools.list(feature.id).length > 0)?.personId ?? people[0] ?? "";

/** Each open live socket. */
const sockets = new Set<Socket>();

/** One unmasked WebSocket text frame. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

const SECRET = "preview-secret"; // pragma: allowlist secret
const key = await sessionKey(SECRET);
const options = {
  githubClientId: "preview-client",
  githubClientSecret: SECRET,
  owners: parseOwnerMap(people.map((person) => `${person}:${person}`).join(",")),
  githubBaseUrl: "http://127.0.0.1:1",
};
const ASSET_TYPES: Record<string, string> = { js: "text/javascript", css: "text/css", woff2: "font/woff2", txt: "text/plain", html: "text/html" };
const handlers = {
  serveAsset: async (request: Request) => {
    const path = new URL(request.url).pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      const body = await readFile(join(ROOT, "apps/dashboard/dist", file));
      return new Response(body, { headers: { "Content-Type": ASSET_TYPES[file.split(".").pop() ?? ""] ?? "text/html" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
  dashboard: () => preview.backend(),
};

const ownerOf = (req: IncomingMessage): string => {
  const header = req.headers["x-preview-owner"];
  if (typeof header === "string" && people.includes(header)) return header;
  const cookie = /(?:^|;\s*)preview-owner=([a-z0-9-]+)/.exec(req.headers.cookie ?? "")?.[1];
  return cookie !== undefined && people.includes(cookie) ? cookie : defaultOwner;
};

/** The Node request as a fetch Request, signed in as the preview's owner. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const owner = ownerOf(req);
  const value = await encodeSession(key, { owner, login: owner, expiresAt: Date.now() + 3_600_000 });
  headers.set("cookie", `${SESSION_COOKIE}=${value}`);
  const body = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

const server = createServer(async (req, res) => {
  try {
    const seat = /^\/preview\/as\/([a-z0-9-]+)$/.exec(req.url ?? "")?.[1];
    if (seat !== undefined && people.includes(seat)) {
      res.writeHead(303, { Location: "/", "Set-Cookie": `preview-owner=${seat}; Path=/; SameSite=Lax` }).end();
      return;
    }
    const request = await toRequest(req);
    const response = (await handleDashboardRoute(request, new URL(request.url), options, handlers as never)) ?? new Response("not found", { status: 404 });
    // A decision or an approval changes someone's inbox: every open dashboard reads its inbox again.
    if (request.method === "POST" && response.ok) for (const socket of sockets) socket.write(frame(inboxChangedMessage()));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers[name] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
});

// The live feed over a bare WebSocket handshake, so the dashboard shows itself connected.
server.on("upgrade", (req, socket: Socket) => {
  if (!(req.url ?? "").startsWith("/api/live")) return socket.destroy();
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on("data", () => undefined);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});

server.listen(port, "127.0.0.1", () => console.log(`preview of ${fixture} on http://127.0.0.1:${port} as ${defaultOwner}`));
