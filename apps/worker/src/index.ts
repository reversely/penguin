import { getAgentByName, routeAgentRequest } from "agents";
import { serveMcp } from "@penguin/mcp";

import { handleRequest } from "./gateway.ts";
import { consumePushEvents } from "./push-events.ts";
import { RepoNames, setUpProject } from "./repos.ts";
import { artifactsRepoName, mintRepoToken, parseProjectRepo, parseTokenTtl } from "./tokens.ts";

export { HuddleAgent } from "@penguin/huddle-agent";
export { ProjectAgent } from "@penguin/project-agent";

/** The `namespace` of the `artifacts` binding in wrangler.jsonc, which push events name as their source. */
const ARTIFACTS_NAMESPACE = "penguin";

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

/** The project's one ProjectAgent instance. The repo prefix keeps test projects apart. */
function projectAgentName(names: RepoNames): string {
  return `${names.prefix}project`;
}

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
        rebuildIndex: async () => {
          const agent = await getAgentByName(env.ProjectAgent, projectAgentName(names));
          return agent.rebuildIndex({ issues: names.issues, base: names.base });
        },
        // One ProjectAgent per repo prefix, so a test run's bridges stay apart from production's.
        bridges: () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
        mcpTokens: () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
        serveMcp: (mcpRequest, owner) =>
          serveMcp(mcpRequest, owner, () => getAgentByName(env.ProjectAgent, projectAgentName(names))),
        mintToken: (repo, scope, ttl) => {
          const parsed = parseProjectRepo(repo);
          if (parsed === undefined) throw new Error(`not a project repo: ${repo}`);
          return mintRepoToken(env.ARTIFACTS, artifactsRepoName(parsed, names), scope, ttl);
        },
      },
    );
  },

  async queue(batch: MessageBatch, env: WorkerEnv): Promise<void> {
    const names = new RepoNames(env.PENGUIN_REPO_PREFIX);
    const repos = { issues: names.issues, base: names.base };
    await consumePushEvents(
      batch.messages,
      { namespace: ARTIFACTS_NAMESPACE, repoName: names.issues },
      async (push) => {
        const agent = await getAgentByName(env.ProjectAgent, projectAgentName(names));
        return agent.ingestPush(push, repos);
      },
      {
        info: (entry) => console.log(JSON.stringify(entry)),
        error: (entry) => console.error(JSON.stringify(entry)),
      },
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
