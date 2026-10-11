// The message the ProjectAgent sends over its WebSocket to connected dashboards when the issue index
// changes. It names the changed issues only; a dashboard reads what it shows again over the
// dashboard API, which checks the session, so the socket never carries issue data.

export const INDEX_CHANGED = "penguin.index-changed";

export interface IndexChangedMessage {
  readonly type: typeof INDEX_CHANGED;
  /** The issues whose state changed, each once. */
  readonly issues: readonly string[];
}

export function indexChangedMessage(issues: Iterable<string>): string {
  const message: IndexChangedMessage = { type: INDEX_CHANGED, issues: [...new Set(issues)] };
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
  const { type, issues } = parsed as { type?: unknown; issues?: unknown };
  if (type !== INDEX_CHANGED || !Array.isArray(issues)) return undefined;
  if (!issues.every((issue) => typeof issue === "string")) return undefined;
  return { type, issues };
}
