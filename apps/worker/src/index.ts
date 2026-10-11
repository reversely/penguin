import { getAgentByName, routeAgentRequest } from "agents";

import { handleRequest } from "./gateway.ts";
import { RepoNames, setUpProject } from "./repos.ts";
import { artifactsRepoName, mintRepoToken, parseProjectRepo, parseTokenTtl } from "./tokens.ts";

export { HuddleAgent } from "@penguin/huddle-agent";
export { ProjectAgent } from "@penguin/project-agent";

type WorkerEnv = Env & {
  /** Set only through `wrangler dev --var`; never in the Wrangler config. */
  PENGUIN_LOCAL_DEV_UNAUTHENTICATED?: string;
  /** The deployer credential for /setup and bridge registration codes; set with `wrangler secret put`. */
  PENGUIN_DEPLOYER_TOKEN?: string;
  /** Prefix for every repo name, for test runs; empty in production. */
  PENGUIN_REPO_PREFIX?: string;
  /** Lifetime in seconds of the Artifacts tokens the Worker mints; 3600 when unset. */
  PENGUIN_TOKEN_TTL_SECONDS?: string;
};

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const names = new RepoNames(env.PENGUIN_REPO_PREFIX);
    return handleRequest(
      request,
      {
        localDevUnauthenticated: env.PENGUIN_LOCAL_DEV_UNAUTHENTICATED,
        deployerToken: env.PENGUIN_DEPLOYER_TOKEN,
        tokenTtlSeconds: parseTokenTtl(env.PENGUIN_TOKEN_TTL_SECONDS),
      },
      {
        routeAgents: (agentRequest) => routeAgentRequest(agentRequest, env),
        setUpProject: (setupRequest) => setUpProject(env.ARTIFACTS, setupRequest, names),
        // One ProjectAgent per repo prefix, so a test run's bridges stay apart from production's.
        bridges: () => getAgentByName(env.ProjectAgent, `${names.prefix}project`),
        mintToken: (repo, scope, ttl) => {
          const parsed = parseProjectRepo(repo);
          if (parsed === undefined) throw new Error(`not a project repo: ${repo}`);
          return mintRepoToken(env.ARTIFACTS, artifactsRepoName(parsed, names), scope, ttl);
        },
      },
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
