// The live connection to the ProjectAgent, through the Agents SDK's React client. The Worker serves
// the socket at /api/live for a signed-in person only and picks the project's agent itself, so the
// client names no instance.

import { useAgent } from "agents/react";
import { parseIndexChanged } from "@penguin/protocol";
import { useState } from "react";

export type LiveStatus = "connecting" | "live" | "offline";

export interface Live {
  readonly status: LiveStatus;
  /** Counts index changes since the page loaded; a page reads its data again when it changes. */
  readonly revision: number;
}

export function useLive(): Live {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [revision, setRevision] = useState(0);
  useAgent({
    agent: "project-agent",
    basePath: "api/live",
    onOpen: () => setStatus("live"),
    onClose: () => setStatus("offline"),
    onMessage: (event: MessageEvent) => {
      if (parseIndexChanged(event.data) !== undefined) setRevision((value: number) => value + 1);
    },
  });
  return { status, revision };
}
