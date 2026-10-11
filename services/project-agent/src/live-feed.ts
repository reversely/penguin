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
// announce its issue; the message carries no data, and the dashboard reads the issue again.

import { indexChangedMessage } from "@penguin/protocol";

export const LIVE_OWNER_HEADER = "X-Penguin-Owner";

/** The signed-in person the Worker named on a forwarded dashboard connection, or undefined. */
export function liveOwner(request: Request): string | undefined {
  const owner = request.headers.get(LIVE_OWNER_HEADER);
  return owner === null || owner === "" ? undefined : owner;
}

export class LiveFeed {
  readonly #send: (message: string) => void;
  readonly #defer: (task: () => void) => void;
  #pending = new Set<string>();

  // The default wraps queueMicrotask: workerd throws "Illegal invocation" when it is called unbound.
  constructor(send: (message: string) => void, defer: (task: () => void) => void = (task) => queueMicrotask(task)) {
    this.#send = send;
    this.#defer = defer;
  }

  issueChanged(issueId: string): void {
    if (this.#pending.size === 0) this.#defer(() => this.#flush());
    this.#pending.add(issueId);
  }

  #flush(): void {
    const issues = this.#pending;
    this.#pending = new Set();
    if (issues.size > 0) this.#send(indexChangedMessage(issues));
  }
}
