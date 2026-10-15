// wait_for_work (#210): an idle agent's call that holds until its session has new work.
//
// An MCP server cannot start an agent's turn, so an agent with nothing to do calls wait_for_work
// instead of ending its turn. The Worker holds the call as a streamed MCP response. Each round asks
// the ProjectAgent to wait (awaitSessionWork), which returns when the work get_work reads may have
// changed or when the call's time is up; the ProjectAgent wakes it from the same events that update
// the dashboards, so no round reads storage while it waits. When a round reports a change, the call
// builds the session's get_work summary again and answers with the entries the agent has not read.
// With nothing new it answers `waiting` within 50 seconds (#215): in live run film-1015-r5, Claude
// Code 2.1.300 aborted every call left idle for about two minutes although progress notifications
// went out every minute, so a call answers before that and the agent calls again.
//
// An entry is read when get_work or wait_for_work last answered with it. Each list element of the
// summary is one entry, and each object's own scalar fields are one more; an entry's key is its path
// and a hash of its fields, so an entry whose state moved counts as new.

/**
 * The longest one call waits, and its default: below the 60 seconds Codex allows a tool call by
 * default (`tool_timeout_sec`) and the two minutes after which Claude Code aborted an idle call.
 */
export const WAIT_MAX_SECONDS = 50;

/**
 * The most times one call builds the summary again. Each build makes about a dozen Durable Object
 * calls, and a Worker invocation may make 1,000 on the Free plan; a busy project whose changes are
 * all for other sessions ends the call with `waiting` here, and the agent calls again.
 */
export const WAIT_MAX_REBUILDS = 50;

/** Where the ProjectAgent's change count stood when the call last read the session's work. */
export interface WorkMarkView {
  readonly epoch: string;
  readonly version: number;
}

export interface WaitRejection {
  readonly status: "rejected";
  readonly reason: string;
  readonly message: string;
}

export type WorkRound = { readonly status: "ok"; readonly mark: WorkMarkView; readonly changed: boolean } | WaitRejection;

export interface WorkWait {
  /** One round of the ProjectAgent's wait for the session (ProjectAgent.awaitSessionWork). */
  round(since: WorkMarkView | null, ms: number): Promise<WorkRound>;
  /** The session's get_work summary, or the rejection get_work would answer. */
  summary(): Promise<{ readonly status: "ok"; readonly summary: Record<string, unknown> } | WaitRejection>;
  /** The keys of the entries the agent last read. */
  read(): Promise<readonly string[]>;
  markRead(keys: readonly string[]): Promise<void>;
  /** Sends one progress notification; `progress` counts the rounds so far. */
  progress(progress: number, message: string): Promise<void>;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

export type WaitOutcome = { readonly status: "new_work"; readonly work: Record<string, unknown> } | { readonly status: "waiting" } | WaitRejection;

/** Holds until the session has entries the agent has not read, or `timeoutSeconds` pass. */
export async function waitForWork(wait: WorkWait, timeoutSeconds: number): Promise<WaitOutcome> {
  const deadline = wait.now() + timeoutSeconds * 1000;
  const read = new Set(await wait.read());
  // The first notification goes out at once: a client may time out a request that sends no byte.
  await wait.progress(0, "waiting for new work");
  // A first round from no mark returns at once, after delivering what waits at this checkpoint.
  let mark: WorkMarkView | null = null;
  let changed = false;
  let rebuilds = 0;
  for (let rounds = 0; ; rounds += 1) {
    if (rounds > 0) {
      const remaining = deadline - wait.now();
      if (remaining <= 0 || wait.signal.aborted) return { status: "waiting" };
    }
    let round: WorkRound;
    try {
      // One round holds the rest of the call, so the call keeps one wake subscription at a time.
      round = await wait.round(mark, rounds === 0 ? 0 : deadline - wait.now());
    } catch (error) {
      // The ProjectAgent restarted mid-round (a deploy or an eviction): read the work again.
      console.warn(JSON.stringify({ event: "wait_round_failed", error: String(error).slice(0, 200) }));
      round = { status: "ok", mark: { epoch: "", version: 0 }, changed: true };
    }
    if (round.status === "rejected") return round;
    ({ mark, changed } = round);
    if (rounds > 0) await wait.progress(rounds, changed ? "checking new work" : "waiting for new work");
    if (!changed) continue;
    if (rebuilds === WAIT_MAX_REBUILDS) return { status: "waiting" };
    rebuilds += 1;
    const built = await wait.summary();
    if (built.status === "rejected") return built;
    const keys: string[] = [];
    const fresh = newEntries(built.summary, read, keys);
    if (fresh !== undefined) {
      await wait.markRead(keys);
      return { status: "new_work", work: fresh };
    }
  }
}

/** The keys of every entry of a get_work summary, for get_work to record as read. */
export function workKeys(summary: Record<string, unknown>): string[] {
  const keys: string[] = [];
  newEntries(summary, new Set(), keys);
  return keys;
}

/**
 * The part of `value` the agent has not read: each list's unread elements, and an object's own
 * scalar fields beside any unread part, so a new plan part comes with its plan's id. Undefined when
 * nothing is unread. Every key it reads is pushed onto `keys`.
 */
function newEntries(value: Record<string, unknown>, read: ReadonlySet<string>, keys: string[], path = ""): Record<string, unknown> | undefined {
  const head: Record<string, unknown> = {};
  const fresh: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    const at = `${path}/${name}`;
    if (Array.isArray(field)) {
      const unread = field.filter((element) => {
        const key = entryKey(at, element);
        keys.push(key);
        return !read.has(key);
      });
      if (unread.length > 0) fresh[name] = unread;
    } else if (typeof field === "object" && field !== null) {
      const nested = newEntries(field as Record<string, unknown>, read, keys, at);
      if (nested !== undefined) fresh[name] = nested;
    } else {
      head[name] = field;
    }
  }
  const headKey = entryKey(path, head);
  keys.push(headKey);
  if (read.has(headKey) && Object.keys(fresh).length === 0) return undefined;
  return { ...head, ...fresh };
}

function entryKey(path: string, value: unknown): string {
  return `${path}:${hash(JSON.stringify(value) ?? "")}`;
}

/** cyrb53: a 53-bit string hash, enough to tell a few hundred entries apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
