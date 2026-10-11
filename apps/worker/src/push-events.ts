/**
 * The Queue consumer for `cf.artifacts.repo.pushed` events from the issues repo.
 *
 * The consumer takes only the repo name, the ref and the two SHAs from an event. Operation content is
 * read through the Artifacts binding by the ProjectAgent, never from the event body.
 *
 * This module never imports the Agents SDK, so node:test can run it with a fake ingest.
 */

export const PUSHED_EVENT_TYPE = "cf.artifacts.repo.pushed";

/** The issues repo's coordination branch (packages/protocol/src/order.ts). */
export const ISSUES_BRANCH_REF = "refs/heads/main";

const SHA = /^[0-9a-f]{40}$/u;
const ZERO_SHA = "0".repeat(40);

/** The push the ProjectAgent ingests. */
export interface IssuesPushEvent {
  readonly before: string;
  readonly after: string;
}

/** The repo whose pushes the consumer accepts. */
export interface PushEventTarget {
  readonly namespace: string;
  readonly repoName: string;
}

export type ParsedPushEvent =
  | { readonly ok: true; readonly push: IssuesPushEvent }
  | { readonly ok: false; readonly reason: string };

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Accepts a `pushed` event for the target repo's main branch. Every other message, including events
 * from other repos, other refs and branch deletions, comes back with the reason it was ignored.
 */
export function parsePushEvent(body: unknown, target: PushEventTarget): ParsedPushEvent {
  const type = field(body, "type");
  if (type !== PUSHED_EVENT_TYPE) return { ok: false, reason: `event type ${JSON.stringify(type)}` };
  const source = field(body, "source");
  const namespace = field(source, "namespace");
  const repoName = field(source, "repoName");
  if (field(source, "type") !== "artifacts.repo" || namespace !== target.namespace || repoName !== target.repoName) {
    return { ok: false, reason: `repo ${JSON.stringify(namespace)}/${JSON.stringify(repoName)}` };
  }
  const payload = field(body, "payload");
  const ref = field(payload, "ref");
  if (ref !== ISSUES_BRANCH_REF) return { ok: false, reason: `ref ${JSON.stringify(ref)}` };
  const before = field(payload, "before");
  const after = field(payload, "after");
  if (typeof before !== "string" || !SHA.test(before) || typeof after !== "string" || !SHA.test(after)) {
    return { ok: false, reason: "before or after is not a 40-character SHA" };
  }
  if (after === ZERO_SHA) return { ok: false, reason: "branch deleted" };
  return { ok: true, push: { before, after } };
}

/** The subset of a Queue `Message` the consumer uses. */
export interface QueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

export type IngestPush = (push: IssuesPushEvent) => Promise<unknown>;

export interface ConsumerLog {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

/**
 * Handles one batch in delivery order. A message is acknowledged once its operations are committed
 * to the index, or at once when it is ignored. A failed ingest is retried; the ProjectAgent's
 * ingested-commit ledger and op_id check absorb the repeat.
 */
export async function consumePushEvents(
  messages: readonly QueueMessage[],
  target: PushEventTarget,
  ingest: IngestPush,
  log: ConsumerLog,
  now: () => number = Date.now,
): Promise<void> {
  for (const message of messages) {
    const parsed = parsePushEvent(message.body, target);
    if (!parsed.ok) {
      log.info({ event: "push_ignored", messageId: message.id, reason: parsed.reason });
      message.ack();
      continue;
    }
    try {
      const report = await ingest(parsed.push);
      message.ack();
      log.info({
        event: "push_ingested",
        messageId: message.id,
        after: parsed.push.after,
        report,
        // Time from the event to this acknowledgement; a timestamp read only for this log line.
        sincePushMs: sincePush(message.body, now()),
      });
    } catch (error) {
      message.retry();
      log.error({
        event: "push_ingest_failed",
        messageId: message.id,
        after: parsed.push.after,
        attempts: message.attempts,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
}

function sincePush(body: unknown, now: number): number | null {
  const stamp = field(field(body, "metadata"), "eventTimestamp");
  const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(at) ? null : now - at;
}
