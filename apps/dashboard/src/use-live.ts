// The live connection to the ProjectAgent, through the Agents SDK's React client. The Worker serves
// the socket at /api/live for a signed-in person only and picks the project's agent itself, so the
// client names no instance.

import { useAgent } from "agents/react";
import { parseIndexChanged } from "@penguin/protocol";
import { useState } from "react";

import { recordChange, type LiveChanges, type LiveStatus } from "./live-changes.ts";

export type { LiveStatus } from "./live-changes.ts";

export interface Live extends LiveChanges {
  readonly status: LiveStatus;
}

export function useLive(): Live {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [changes, setChanges] = useState<LiveChanges>({ revision: 0, changed: new Map() });
  useAgent({
    agent: "project-agent",
    basePath: "api/live",
    onOpen: () => setStatus("live"),
    onClose: () => setStatus("offline"),
    onMessage: (event: MessageEvent) => {
      const message = parseIndexChanged(event.data);
      // An updater per message, so two messages within one render both keep their issue ids.
      if (message !== undefined) setChanges((previous: LiveChanges) => recordChange(previous, message.issues));
    },
  });
  return { status, ...changes };
}
