// The message the ProjectAgent sends over its WebSocket to connected dashboards when the issue index
// or a session changes. It names the changed issues and the identities whose sessions went online or
// offline only; a dashboard reads what it shows again over the dashboard API, which checks the
// session, so the socket never carries issue data.

export const INDEX_CHANGED = "penguin.index-changed";

export interface IndexChangedMessage {
  readonly type: typeof INDEX_CHANGED;
  /** The issues whose state or routing changed, each once. */
  readonly issues: readonly string[];
  /** The identity handles with a session that went online or offline, each once. */
  readonly sessions: readonly string[];
}

export function indexChangedMessage(issues: Iterable<string>, sessions: Iterable<string> = []): string {
  const message: IndexChangedMessage = { type: INDEX_CHANGED, issues: [...new Set(issues)], sessions: [...new Set(sessions)] };
  return JSON.stringify(message);
}

/** The message in a WebSocket text frame, or undefined for any other frame, such as the SDK's own. */
export function parseIndexChanged(data: unknown): IndexChangedMessage | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { type, issues, sessions = [] } = parsed as { type?: unknown; issues?: unknown; sessions?: unknown };
  if (type !== INDEX_CHANGED || !Array.isArray(issues) || !Array.isArray(sessions)) return undefined;
  if (![...issues, ...sessions].every((value) => typeof value === "string")) return undefined;
  return { type, issues, sessions };
}

/**
 * The message the ProjectAgent sends to one person's dashboards when that person's inbox changed
 * without an issue changing, as when they mark an item read in another browser. It names nothing; the
 * dashboard reads the inbox again.
 */
export const INBOX_CHANGED = "penguin.inbox-changed";

export function inboxChangedMessage(): string {
  return JSON.stringify({ type: INBOX_CHANGED });
}

/** Whether a WebSocket text frame is an inbox-changed message. */
export function isInboxChanged(data: unknown): boolean {
  return messageType(data) === INBOX_CHANGED;
}

/**
 * The message the ProjectAgent sends to every connected dashboard when an identity is created, edited
 * or duplicated. It names nothing; the dashboard reads the identities again.
 */
export const IDENTITIES_CHANGED = "penguin.identities-changed";

export function identitiesChangedMessage(): string {
  return JSON.stringify({ type: IDENTITIES_CHANGED });
}

/** Whether a WebSocket text frame is an identities-changed message. */
export function isIdentitiesChanged(data: unknown): boolean {
  return messageType(data) === IDENTITIES_CHANGED;
}

/**
 * The message the ProjectAgent sends to every connected dashboard when a feature, its merge plan, a
 * part's approval or a review changes. It names nothing: the team view, the feature page and the
 * approvals read their answers again, so another person's open team view shows a new state at once.
 */
export const FEATURES_CHANGED = "penguin.features-changed";

export function featuresChangedMessage(): string {
  return JSON.stringify({ type: FEATURES_CHANGED });
}

/** Whether a WebSocket text frame is a features-changed message. */
export function isFeaturesChanged(data: unknown): boolean {
  return messageType(data) === FEATURES_CHANGED;
}

/** The `type` of a JSON object in a text frame, or undefined. */
function messageType(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
  } catch {
    return undefined;
  }
}
