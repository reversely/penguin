import { routeAgentRequest } from "agents";

import { handleRequest } from "./gateway.ts";
import { RepoNames, setUpProject } from "./repos.ts";

export { HuddleAgent } from "@penguin/huddle-agent";
export { ProjectAgent } from "@penguin/project-agent";

type WorkerEnv = Env & {
  /** Set only through `wrangler dev --var`; never in the Wrangler config. */
  PENGUIN_LOCAL_DEV_UNAUTHENTICATED?: string;
  /** The deployer credential for /setup; set with `wrangler secret put`. */
  PENGUIN_DEPLOYER_TOKEN?: string;
  /** Prefix for every repo name, for test runs; empty in production. */
  PENGUIN_REPO_PREFIX?: string;
};

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(
      request,
      {
        localDevUnauthenticated: env.PENGUIN_LOCAL_DEV_UNAUTHENTICATED,
        deployerToken: env.PENGUIN_DEPLOYER_TOKEN,
      },
      {
        routeAgents: (agentRequest) => routeAgentRequest(agentRequest, env),
        setUpProject: (setupRequest) =>
          setUpProject(env.ARTIFACTS, setupRequest, new RepoNames(env.PENGUIN_REPO_PREFIX)),
      },
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
