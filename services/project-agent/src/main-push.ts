// Moving main to a feature's checkpoint in one push, from inside Penguin (PRD 0.4 section 4.5 step 4).
//
// Only Penguin holds write on main, so the push cannot run on a bridge or the check runner. The
// FeatureAgent mints a write token on the base repo for minutes and a read token on the feature's
// fork, and this module speaks Git's smart HTTP protocol (v0, the one Artifacts takes for pushes)
// with plain `fetch`:
//
// 1. It reads the base repo's refs (`info/refs?service=git-receive-pack`). Main must still stand at
//    `before`, the commit the block was checked against; otherwise the push is refused as `moved`.
// 2. It asks the fork's `git-upload-pack` for the checkpoint, telling it main's commit is already
//    there, and receives a self-contained pack of the commits main lacks. A checkpoint the fork does
//    not advertise as a branch tip is fetched through the fork's tips that hold it.
// 3. It sends `git-receive-pack` one command, `<before> <after> refs/heads/<branch>`, with that pack.
//    Git applies the command only while the ref still names `before`, so a push that raced another
//    is refused by the server too. It then reads the refs again and reports `pushed` only when main
//    names `after`.
//
// Object IDs and the branch are checked before any request; nothing here is a shell string. Tokens
// travel in the Authorization header only and appear in no result, error or log line.

import { BRANCH_PATTERN, OBJECT_ID } from "@penguin/protocol";

/** A repo's smart HTTP remote and the token for it, held only for the push. */
export interface GitEndpoint {
  readonly remote: string;
  readonly token: string;
}

export interface FastForward {
  /** The feature's fork, read with a read token. */
  readonly source: GitEndpoint;
  /** The base repo, written with Penguin's write token. */
  readonly target: GitEndpoint;
  readonly branch: string;
  readonly before: string;
  readonly after: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export type FastForwardOutcome =
  | { readonly status: "pushed"; readonly packBytes: number; readonly durationMs: number }
  /** Main no longer names `before`: another push came first. */
  | { readonly status: "moved"; readonly head: string | null; readonly durationMs: number }
  /** The push did not happen for another reason; main is unchanged unless `head` says otherwise. */
  | { readonly status: "failed"; readonly reason: string; readonly head: string | null; readonly durationMs: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const FLUSH = encoder.encode("0000");
const PACK = [0x50, 0x41, 0x43, 0x4b];
const USER_AGENT = "git/2 penguin-promotion";

/** One pkt-line holding `text`. */
export function pktLine(text: string): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(body.length + 4);
  out.set(encoder.encode((body.length + 4).toString(16).padStart(4, "0")));
  out.set(body, 4);
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What a pkt-line stream holds: its lines, and the raw pack that follows them, if any. */
export interface PktStream {
  /** Each data line's text, without its trailing newline; a flush is `null`. */
  readonly lines: readonly (string | null)[];
  readonly pack: Uint8Array | null;
}

/** Reads pkt-lines until the bytes end or a raw `PACK` begins. */
export function readPktStream(bytes: Uint8Array): PktStream {
  const lines: (string | null)[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    if (PACK.every((byte, index) => bytes[offset + index] === byte)) return { lines, pack: bytes.subarray(offset) };
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isInteger(length) || (length > 0 && length < 4) || offset + Math.max(length, 4) > bytes.length) {
      throw new Error("the server answered with a malformed pkt-line");
    }
    if (length === 0 || length === 1 || length === 2) {
      lines.push(null);
      offset += 4;
      continue;
    }
    lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/u, ""));
    offset += length;
  }
  return { lines, pack: null };
}

/** A ref advertisement: each ref's object and the capabilities the first line names. */
export interface Advertisement {
  readonly refs: ReadonlyMap<string, string>;
  readonly capabilities: ReadonlySet<string>;
}

/** Parses `info/refs?service=...`, with or without the `# service=` header and a `version 1` line. */
export function parseAdvertisement(bytes: Uint8Array): Advertisement {
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let first = true;
  for (const line of readPktStream(bytes).lines) {
    if (line === null || line.startsWith("# service=") || line === "version 1") continue;
    if (line.startsWith("ERR ")) throw new Error(`the server refused: ${line.slice(4, 200)}`);
    const [head, caps] = line.split("\0", 2) as [string, string | undefined];
    if (first && caps !== undefined) for (const cap of caps.trim().split(" ")) if (cap !== "") capabilities.add(cap);
    first = false;
    const [sha, name] = head.split(" ", 2);
    if (sha !== undefined && name !== undefined && OBJECT_ID.test(sha) && name !== "capabilities^{}") refs.set(name, sha);
  }
  return { refs, capabilities };
}

/** One smart HTTP request with the token in the Authorization header; a non-2xx answer throws with its status alone. */
export async function request(fetchImpl: typeof fetch, url: string, token: string, timeoutMs: number, body?: { readonly service: string; readonly bytes: Uint8Array<ArrayBuffer> }): Promise<Uint8Array> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT };
  if (body !== undefined) {
    headers["Content-Type"] = `application/x-${body.service}-request`;
    headers["Accept"] = `application/x-${body.service}-result`;
  }
  const response = await fetchImpl(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: body.bytes }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  // The status alone: a body could echo a credential back.
  if (!response.ok) throw new Error(`${new URL(url).pathname.split("/").at(-1)} answered HTTP ${response.status}`);
  return bytes;
}

export function repoUrl(remote: string, path: string): string {
  return `${remote.replace(/\/+$/u, "")}/${path}`;
}

export async function advertisement(fetchImpl: typeof fetch, endpoint: GitEndpoint, service: string, timeoutMs: number): Promise<Advertisement> {
  return parseAdvertisement(await request(fetchImpl, repoUrl(endpoint.remote, `info/refs?service=${service}`), endpoint.token, timeoutMs));
}

/**
 * The pack of the commits `after` has and `before` lacks, from the fork. Wants `after` itself when
 * the fork advertises it as a tip, otherwise every tip; Git sends only what is reachable from them.
 */
async function packFrom(fetchImpl: typeof fetch, source: GitEndpoint, before: string, after: string, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
  const tips = await advertisement(fetchImpl, source, "git-upload-pack", timeoutMs);
  const advertised = new Set(tips.refs.values());
  const wants = advertised.has(after) ? [after] : [...advertised].sort();
  if (wants.length === 0) throw new Error("the fork advertises no branch");
  const body = concat([
    ...wants.map((sha) => pktLine(`want ${sha}\n`)),
    FLUSH,
    pktLine(`have ${before}\n`),
    pktLine("done\n"),
  ]);
  const answer = readPktStream(await request(fetchImpl, repoUrl(source.remote, "git-upload-pack"), source.token, timeoutMs, { service: "git-upload-pack", bytes: body }));
  const refused = answer.lines.find((line) => line?.startsWith("ERR "));
  if (refused != null) throw new Error(`the fork refused the fetch: ${refused.slice(4, 200)}`);
  if (answer.pack === null) throw new Error("the fork sent no pack");
  return packEnd(answer.pack);
}

/**
 * The pack alone: its bytes up to the SHA-1 trailer that checksums them. Artifacts' upload-pack sends
 * a flush pkt-line after the pack (measured through `wrangler dev`, 2026-10-11), and its receive-pack
 * answers HTTP 500 to a pack with those bytes still on it.
 */
export async function packEnd(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  for (const end of [bytes.length, bytes.length - 4]) {
    if (end < 32) continue;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes.slice(0, end - 20)));
    if (digest.every((byte, index) => byte === bytes[end - 20 + index])) return bytes.slice(0, end);
  }
  throw new Error("the fork sent a pack whose checksum does not match");
}

/** Main's head in an advertisement, or null when the branch does not exist. */
function headOf(ad: Advertisement, branch: string): string | null {
  return ad.refs.get(`refs/heads/${branch}`) ?? null;
}

/**
 * Moves `branch` of the target repo from `before` to `after` in one push of a pack read from the
 * source repo. Never forces: the server applies the update only while the branch names `before`.
 */
export async function fastForwardMain(input: FastForward): Promise<FastForwardOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const { branch, before, after } = input;
  if (!OBJECT_ID.test(before) || !OBJECT_ID.test(after)) return { status: "failed", reason: "before and after must be full object IDs", head: null, durationMs: elapsed() };
  if (!BRANCH_PATTERN.test(branch)) return { status: "failed", reason: "the branch name is not one Penguin pushes", head: null, durationMs: elapsed() };
  if (before === after) return { status: "failed", reason: "main already names the checkpoint", head: before, durationMs: elapsed() };

  let head: string | null = null;
  try {
    const target = await advertisement(fetchImpl, input.target, "git-receive-pack", timeoutMs);
    head = headOf(target, branch);
    if (head !== before) return { status: "moved", head, durationMs: elapsed() };
    const pack = await packFrom(fetchImpl, input.source, before, after, timeoutMs);
    const capabilities = target.capabilities.has("report-status") ? "report-status" : "";
    const command = pktLine(`${before} ${after} refs/heads/${branch}\0${capabilities}\n`);
    const answer = readPktStream(
      await request(fetchImpl, repoUrl(input.target.remote, "git-receive-pack"), input.target.token, timeoutMs, {
        service: "git-receive-pack",
        bytes: concat([command, FLUSH, pack]),
      }),
    );
    const lines = answer.lines.filter((line): line is string => line !== null);
    const unpack = lines.find((line) => line.startsWith("unpack "));
    const ng = lines.find((line) => line.startsWith(`ng refs/heads/${branch}`));
    const after_ = headOf(await advertisement(fetchImpl, input.target, "git-receive-pack", timeoutMs), branch);
    if (after_ === after) return { status: "pushed", packBytes: pack.length, durationMs: elapsed() };
    if (after_ !== before) return { status: "moved", head: after_, durationMs: elapsed() };
    const reason = ng?.slice(`ng refs/heads/${branch} `.length) ?? (unpack !== undefined && unpack !== "unpack ok" ? unpack : "the server did not move main");
    return { status: "failed", reason: reason.slice(0, 200), head: after_, durationMs: elapsed() };
  } catch (error) {
    return { status: "failed", reason: (error as Error).message.slice(0, 200), head, durationMs: elapsed() };
  }
}
