// Live index updates for connected dashboards (PRD section 8: the dashboard "updates it live over
// the ProjectAgent's WebSocket").
//
// The Worker accepts a dashboard's WebSocket only for a signed-in person and forwards it to the
// agent with that person's owner id in LIVE_OWNER_HEADER, which it first strips from the browser's
// request. The agent accepts the socket through the Agents SDK, which uses the Durable Object
// WebSocket hibernation API, so an idle dashboard holds no running agent.
//
// IndexListener.issueChanged runs inside the operation's transaction, so the feed only collects the
// issue ids there and sends one message after the current task. A rolled-back operation can still
// announce its issue; the message carries no data, and the dashboard reads the issue again. The
// session router reports the same way when a session goes online or offline and when an issue's
// route changes (SessionListener in session-store.ts).
//
// Marking an inbox item read changes no issue, so the agent tells that person's own connections only,
// with an inbox-changed message (sendToOwner).
//
// A feature opening or changing, a merge plan, a part's decision, a fix write or a review changes no
// issue either, but every person's team view shows it, so the feed sends one features-changed message
// to every dashboard after the current task, however many such writes the task made.

import { featuresChangedMessage, indexChangedMessage } from "@penguin/protocol";

export const LIVE_OWNER_HEADER = "X-Penguin-Owner";

/** The signed-in person the Worker named on a forwarded dashboard connection, or undefined. */
export function liveOwner(request: Request): string | undefined {
  const owner = request.headers.get(LIVE_OWNER_HEADER);
  return owner === null || owner === "" ? undefined : owner;
}

/** A dashboard connection as the agent keeps it: its person is in its state (ProjectAgent.onConnect). */
export interface OwnedConnection {
  readonly state: { readonly owner?: unknown } | null | undefined;
  send(message: string): void;
}

/**
 * Sends a message to one person's dashboards only, such as an inbox change no other person may hear
 * of. A connection that closed meanwhile is skipped.
 */
export function sendToOwner(connections: Iterable<OwnedConnection>, owner: string, message: string): void {
  for (const connection of connections) {
    if (connection.state?.owner !== owner) continue;
    try {
      connection.send(message);
    } catch (error) {
      console.warn("a dashboard connection closed before the inbox message", error);
    }
  }
}

export class LiveFeed {
  readonly #send: (message: string) => void;
  readonly #defer: (task: () => void) => void;
  #pending = new Set<string>();
  #sessions = new Set<string>();
  #features = false;

  // The default wraps queueMicrotask: workerd throws "Illegal invocation" when it is called unbound.
  constructor(send: (message: string) => void, defer: (task: () => void) => void = (task) => queueMicrotask(task)) {
    this.#send = send;
    this.#defer = defer;
  }

  issueChanged(issueId: string): void {
    this.#schedule();
    this.#pending.add(issueId);
  }

  /** A session of the identity with this handle went online or offline. */
  sessionChanged(handle: string): void {
    this.#schedule();
    this.#sessions.add(handle);
  }

  /** A feature, its merge plan, a part's approval or a review changed: every dashboard hears of it once. */
  featuresChanged(): void {
    this.#schedule();
    this.#features = true;
  }

  #schedule(): void {
    if (this.#pending.size === 0 && this.#sessions.size === 0 && !this.#features) this.#defer(() => this.#flush());
  }

  #flush(): void {
    const issues = this.#pending;
    const sessions = this.#sessions;
    const features = this.#features;
    this.#pending = new Set();
    this.#sessions = new Set();
    this.#features = false;
    if (issues.size > 0 || sessions.size > 0) this.#send(indexChangedMessage(issues, sessions));
    if (features) this.#send(featuresChangedMessage());
  }
}
