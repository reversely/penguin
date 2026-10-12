// A Git smart HTTP server for tests and the preview: each request is answered by `git upload-pack`
// or `git receive-pack` in stateless RPC mode, as `git http-backend` answers it, on bare repositories
// on disk standing for Artifacts repos.

import { execFileSync, spawnSync } from "node:child_process";

import { pktLine } from "../../services/project-agent/src/main-push.ts";

export interface Served {
  readonly fetch: typeof fetch;
  readonly requests: { readonly url: string; readonly method: string; readonly auth: string | null }[];
}

/** A fetch that serves `repos` by name, as https://artifacts.test/git/<name>.git, checking each token's scope. */
export function gitServer(repos: Record<string, string>, tokens: Record<string, "read" | "write">): Served {
  const requests: Served["requests"] = [];
  const served = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    requests.push({ url: url.pathname + url.search, method: init?.method ?? "GET", auth });
    const match = /^\/git\/([a-z0-9-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
    const dir = match === null ? undefined : repos[match[1] as string];
    if (match === null || dir === undefined) return new Response("not found", { status: 404 });
    const scope = tokens[(auth ?? "").replace(/^Bearer /u, "")];
    const service = match[2] === "info/refs" ? url.searchParams.get("service") : match[2];
    if (scope === undefined || (service === "git-receive-pack" && scope !== "write")) return new Response("denied", { status: 403 });
    const program = (service as string).replace(/^git-/u, "");
    if (match[2] === "info/refs") {
      const out = execFileSync("git", [program, "--stateless-rpc", "--advertise-refs", dir]);
      return new Response(Buffer.concat([pktLine(`# service=${service}\n`), Buffer.from("0000"), out]));
    }
    const body = Buffer.from(init?.body as Uint8Array);
    const run = spawnSync("git", [program, "--stateless-rpc", dir], { input: body });
    return new Response(run.stdout);
  };
  return { fetch: served as typeof fetch, requests };
}
