// The live connection to the ProjectAgent, through the Agents SDK's React client. The Worker serves
// the socket at /api/live for a signed-in person only and picks the project's agent itself, so the
// client names no instance. Messages reach the pages once per burst (live-reads.ts), so a task that
// sends many makes each page read its data again once.

import { useAgent } from "agents/react";
import { isFeaturesChanged, isIdentitiesChanged, isInboxChanged, parseIndexChanged } from "@penguin/protocol";
import { useEffect, useMemo, useState } from "react";

import { applyMessages, FIRST_REVISIONS, type LiveMessage, type LiveRevisions, type LiveStatus } from "./live-changes.ts";
import { createBurst, LIVE_BURST_MS } from "./live-reads.ts";

export type { LiveStatus } from "./live-changes.ts";

export interface Live extends LiveRevisions {
  readonly status: LiveStatus;
}

/** The live message `data` carries, or undefined for one the dashboard does not read. */
function liveMessage(data: unknown): LiveMessage | undefined {
  if (isInboxChanged(data)) return { kind: "inbox" };
  if (isIdentitiesChanged(data)) return { kind: "identities" };
  if (isFeaturesChanged(data)) return { kind: "features" };
  const message = parseIndexChanged(data);
  return message === undefined ? undefined : { kind: "index", issues: message.issues };
}

export function useLive(): Live {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [revisions, setRevisions] = useState<LiveRevisions>(FIRST_REVISIONS);
  const burst = useMemo(
    () => createBurst<LiveMessage>(LIVE_BURST_MS, (messages) => setRevisions((previous: LiveRevisions) => applyMessages(previous, messages))),
    [],
  );
  useEffect(() => () => burst.cancel(), [burst]);
  useAgent({
    agent: "project-agent",
    basePath: "api/live",
    onOpen: () => setStatus("live"),
    onClose: () => setStatus("offline"),
    onMessage: (event: MessageEvent) => {
      const message = liveMessage(event.data);
      if (message !== undefined) burst.add(message);
    },
  });
  return { status, ...revisions };
}
