// Promotion's push (main-push.ts) against real Git: each smart HTTP request is answered by
// `git upload-pack` or `git receive-pack` in stateless RPC mode, as `git http-backend` answers it, on
// bare repositories standing for the base repo and a feature's fork.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { fastForwardMain, packEnd, pktLine } from "../src/main-push.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const READ = "art_v1_read-token-for-the-test";
const WRITE = "art_v1_write-token-for-the-test";

interface Served {
  readonly fetch: typeof fetch;
  readonly requests: { readonly url: string; readonly method: string; readonly auth: string | null }[];
}

/** A fetch that serves `repos` by name, as https://artifacts.test/git/<name>.git, checking each token's scope. */
function gitServer(repos: Record<string, string>, tokens: Record<string, "read" | "write">): Served {
  const requests: Served["requests"] = [];
  const served = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    requests.push({ url: url.pathname + url.search, method: init?.method ?? "GET", auth });
    const match = /^\/git\/([a-z-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
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

describe("moving main in one push", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-main-push-"));
  const base = join(root, "base.git");
  const fork = join(root, "feature-money.git");
  const work = join(root, "work");
  let main = "";
  let checkpoint = "";
  let elsewhere = "";

  const commit = (file: string, text: string, message: string): string => {
    writeFileSync(join(work, file), text);
    git(work, "add", file);
    git(work, "commit", "--quiet", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };

  before(() => {
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", base);
    git(root, "init", "--quiet", "--initial-branch=main", work);
    main = commit("a.py", "x = 1\n", "Base");
    git(work, "push", "--quiet", base, "main");
    git(root, "clone", "--quiet", "--bare", base, fork);
    git(work, "checkout", "--quiet", "-b", "feature");
    commit("a.py", "x = 2\n", "Change x");
    checkpoint = commit("b.py", "y = 3\n", "Add y");
    // The checkpoint sits on a branch of the fork; the fork's main is still the base.
    git(work, "push", "--quiet", fork, "feature");
    git(work, "checkout", "--quiet", "main");
    elsewhere = commit("c.py", "z = 4\n", "Another push to main");
    git(work, "checkout", "--quiet", "feature");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const endpoints = (served: Served) => ({
    source: { remote: "https://artifacts.test/git/feature-money.git", token: READ },
    target: { remote: "https://artifacts.test/git/base.git", token: WRITE },
    branch: "main",
    fetch: served.fetch,
  });

  test("a push from another main is refused as moved and changes nothing", async () => {
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    // Penguin checked the block against another main than the one the base repo names.
    const outcome = await fastForwardMain({ ...endpoints(served), before: elsewhere, after: checkpoint });
    assert.equal(outcome.status, "moved", JSON.stringify(outcome));
    assert.equal(git(base, "rev-parse", "main"), main);
  });

  test("main moves to the checkpoint with a pack read from the fork, the read token on the fork and the write token on main", async () => {
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    const outcome = await fastForwardMain({ ...endpoints(served), before: main, after: checkpoint });
    assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
    assert.equal(git(base, "rev-parse", "main"), checkpoint);
    assert.equal(git(base, "cat-file", "-p", `${checkpoint}:b.py`), "y = 3");
    for (const request of served.requests) {
      const wanted = request.url.startsWith("/git/base.git") ? `Bearer ${WRITE}` : `Bearer ${READ}`;
      assert.equal(request.auth, wanted, request.url);
    }
    assert.equal(served.requests.filter((request) => request.url.endsWith("git-receive-pack") && request.method === "POST").length, 1, "one push");
  });

  test("a push that raced another push to main is refused, and main keeps the other push", async () => {
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    git(work, "push", "--quiet", "--force", base, `${elsewhere}:refs/heads/main`);
    const outcome = await fastForwardMain({ ...endpoints(served), before: checkpoint, after: checkpoint });
    assert.equal(outcome.status, "failed", "main already at the checkpoint is no push");
    const raced = await fastForwardMain({ ...endpoints(served), before: main, after: checkpoint });
    assert.equal(raced.status, "moved");
    assert.equal(git(base, "rev-parse", "main"), elsewhere);
  });

  test("a push that lands between Penguin's read of main and its push is refused by Git itself", async () => {
    git(work, "push", "--quiet", "--force", base, `${main}:refs/heads/main`);
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    const racing: typeof fetch = async (input, init) => {
      if (String(input).endsWith("git-receive-pack") && init?.method === "POST") git(work, "push", "--quiet", "--force", base, `${elsewhere}:refs/heads/main`);
      return served.fetch(input, init);
    };
    const outcome = await fastForwardMain({ ...endpoints(served), fetch: racing, before: main, after: checkpoint });
    assert.equal(outcome.status, "moved", JSON.stringify(outcome));
    assert.equal(git(base, "rev-parse", "main"), elsewhere);
  });

  test("a checkpoint behind its branch tip is fetched through the tip and main moves to the checkpoint, not the tip", async () => {
    git(work, "push", "--quiet", "--force", base, `${main}:refs/heads/main`);
    const later = commit("d.py", "w = 5\n", "Work after the checkpoint");
    git(work, "push", "--quiet", fork, "feature");
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    const outcome = await fastForwardMain({ ...endpoints(served), before: main, after: checkpoint });
    assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
    assert.equal(git(base, "rev-parse", "main"), checkpoint);
    assert.notEqual(checkpoint, later);
  });

  test("a pack followed by a flush, as Artifacts' upload-pack sends it, is pushed without the flush", async () => {
    git(work, "push", "--quiet", "--force", base, `${main}:refs/heads/main`);
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    const flushed: typeof fetch = async (input, init) => {
      const response = await served.fetch(input, init);
      if (!String(input).endsWith("git-upload-pack") || init?.method !== "POST") return response;
      return new Response(Buffer.concat([Buffer.from(await response.arrayBuffer()), Buffer.from("0000")]));
    };
    const outcome = await fastForwardMain({ ...endpoints(served), fetch: flushed, before: main, after: checkpoint });
    assert.equal(outcome.status, "pushed", JSON.stringify(outcome));
    assert.equal(git(base, "rev-parse", "main"), checkpoint);
    await assert.rejects(packEnd(new Uint8Array(64)), /checksum/u);
  });

  test("a read token cannot write main, and an unknown branch name or object ID is refused before any request", async () => {
    git(work, "push", "--quiet", "--force", base, `${main}:refs/heads/main`);
    const served = gitServer({ base, "feature-money": fork }, { [READ]: "read", [WRITE]: "write" });
    const readOnly = await fastForwardMain({ ...endpoints(served), target: { remote: "https://artifacts.test/git/base.git", token: READ }, before: main, after: checkpoint });
    assert.equal(readOnly.status, "failed");
    assert.equal(git(base, "rev-parse", "main"), main);
    assert.doesNotMatch(JSON.stringify(readOnly), /art_v1_/u, "no token in the outcome");
    const before = served.requests.length;
    assert.equal((await fastForwardMain({ ...endpoints(served), branch: "main;rm -rf /", before: main, after: checkpoint })).status, "failed");
    assert.equal((await fastForwardMain({ ...endpoints(served), branch: "../main", before: main, after: checkpoint })).status, "failed");
    assert.equal((await fastForwardMain({ ...endpoints(served), before: "HEAD", after: checkpoint })).status, "failed");
    assert.equal(served.requests.length, before);
  });
});
