import { routeAgentRequest } from "agents";

import { handleRequest } from "./gateway.ts";

export { HuddleAgent } from "@penguin/huddle-agent";
export { ProjectAgent } from "@penguin/project-agent";

/** Set only through `wrangler dev --var`; never in the Wrangler config. */
type WorkerEnv = Env & { PENGUIN_LOCAL_DEV_UNAUTHENTICATED?: string };

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(
      request,
      { localDevUnauthenticated: env.PENGUIN_LOCAL_DEV_UNAUTHENTICATED },
      (agentRequest) => routeAgentRequest(agentRequest, env),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
