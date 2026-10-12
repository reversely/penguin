import { getAgentByName, routeAgentRequest } from "agents";
import { serveMcp } from "@penguin/mcp";
import { LIVE_OWNER_HEADER, type BlockProjectPort, type InboxReason } from "@penguin/project-agent";
import { featureOfBlockRun, parseEditRunMinutes } from "@penguin/protocol";

import type { BlockReportAnswer } from "./bridges.ts";

import { handleRequest } from "./gateway.ts";
import { parseOwnerMap } from "./github-oauth.ts";
import { consumePushEvents } from "./push-events.ts";
import { featureView, mcpFeatures, openFeatureWithFork, type FeaturePorts } from "./features.ts";
import { forkFeatureRepo, forkHuddleRepo, parseFeatureForkOptions, RepoNames, setUpProject } from "./repos.ts";
import { artifactsRepoName, mintRepoToken, parseFeatureTokenTtl, parseFixTokenTtl, parseProjectRepo, parseTokenTtl } from "./tokens.ts";

export { FeatureAgent } from "@penguin/feature-agent";
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
  /** The GitHub OAuth app for dashboard sign-in (K8); set with `wrangler secret put`. */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** `<github login>:<owner id>` pairs, comma-separated: who may sign in to the dashboard, as whom. */
  PENGUIN_DASHBOARD_OWNERS?: string;
  /** A local GitHub test double's base URL; honoured on loopback hostnames only. */
  PENGUIN_GITHUB_BASE_URL?: string;
  /** "true" or "false": whether a feature's fork copies only main (`fork()`'s `defaultBranchOnly`). */
  PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY?: string;
  /** Lifetime in minutes of a feature agent's write token on the feature's fork. */
  PENGUIN_FEATURE_TOKEN_TTL_MINUTES?: string;
  /** Lifetime in minutes of a write token on an affected fork for one approved plan part; 10 when unset. */
  PENGUIN_FIX_TOKEN_TTL_MINUTES?: string;
  /** Minutes an edit task's background run holds its task and its token; 20 when unset. */
  PENGUIN_EDIT_RUN_MINUTES?: string;
};

/** PENGUIN_EDIT_RUN_MINUTES in seconds: the lifetime of an edit task's token, as long as its claim holds. */
function editTokenTtl(minutes: string | undefined): number | undefined {
  const ms = parseEditRunMinutes(minutes);
  return ms === undefined ? undefined : ms / 1000;
}

/** Opening features: the ProjectAgent's records, the fork through the binding and token minting. */
function featurePorts(env: WorkerEnv, names: RepoNames): FeaturePorts {
  return {
    directory: () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
    fork: (featureId, options) => forkFeatureRepo(env.ARTIFACTS, featureId, names, options),
    mintWrite: (repo, ttl) => mintRepoToken(env.ARTIFACTS, repo, "write", ttl),
    repos: { issues: names.issues, base: names.base },
    config: {
      forkOptions: parseFeatureForkOptions(env.PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY),
      tokenTtlSeconds: parseFeatureTokenTtl(env.PENGUIN_FEATURE_TOKEN_TTL_MINUTES),
      fixTokenTtlSeconds: parseFixTokenTtl(env.PENGUIN_FIX_TOKEN_TTL_MINUTES),
    },
  };
}

/** The project's one ProjectAgent instance. The repo prefix keeps test projects apart. */
function projectAgentName(names: RepoNames): string {
  return `${names.prefix}project`;
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const names = new RepoNames(env.PENGUIN_REPO_PREFIX);
    const repos = { issues: names.issues, base: names.base };
    const features = featurePorts(env, names);
    return handleRequest(
      request,
      {
        localDevUnauthenticated: env.PENGUIN_LOCAL_DEV_UNAUTHENTICATED,
        deployerToken: env.PENGUIN_DEPLOYER_TOKEN,
        tokenTtlSeconds: parseTokenTtl(env.PENGUIN_TOKEN_TTL_SECONDS),
        fixTokenTtlSeconds: parseFixTokenTtl(env.PENGUIN_FIX_TOKEN_TTL_MINUTES),
        editTokenTtlSeconds: editTokenTtl(env.PENGUIN_EDIT_RUN_MINUTES),
        dashboard: {
          githubClientId: env.GITHUB_OAUTH_CLIENT_ID,
          githubClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
          owners: parseOwnerMap(env.PENGUIN_DASHBOARD_OWNERS),
          githubBaseUrl: env.PENGUIN_GITHUB_BASE_URL,
        },
      },
      {
        serveAsset: (assetRequest) => env.ASSETS.fetch(assetRequest),
        dashboard: async () => {
          const agent = await getAgentByName(env.ProjectAgent, projectAgentName(names));
          return {
            readIssue: async (issueId) => agent.issuePage(issueId),
            board: async () => agent.board(),
            inbox: async (owner) => agent.inboxPage(owner),
            markInboxRead: async (owner, issueId, reason) =>
              agent.markInboxRead(owner, issueId, reason as InboxReason),
            submit: (owner, operation) => agent.submitFromDashboard(owner, operation, repos),
            identities: async () => agent.identitiesPage(repos),
            createIdentity: async (owner, input) => agent.createIdentityFromDashboard(owner, input, repos),
            editIdentity: async (owner, id, changes) => agent.editIdentityFromDashboard(owner, id, changes, repos),
            duplicateIdentity: async (owner, id, copy) => agent.duplicateIdentityFromDashboard(owner, id, copy),
            features: async () => (await agent.features()).map(featureView),
            // A person opens a feature with no session, so no token is minted.
            openFeature: (owner, input) => openFeatureWithFork(features, owner, input, null),
            declareFeatureArea: async (owner, featureId, area) => {
              const declared = await agent.declareFeatureArea(owner, featureId, area, null, repos);
              return declared.status === "ok" ? { status: "ok", feature: featureView(declared.feature) } : declared;
            },
            featurePlan: async (owner, featureId) => agent.featurePlan(owner, featureId, repos),
            team: async (owner) => agent.teamView(owner, repos),
            featurePage: async (owner, featureId) => agent.featurePage(owner, featureId, repos),
            reviewDifferences: async (reviewId) => agent.reviewDifferences(reviewId),
            overlapRequests: async (owner) => agent.overlapRequests(owner),
            // The approver is the session's person, named by the dashboard route, never by the body.
            approveOverlap: async (owner, featureId, blockedFeatureId) => {
              const approved = await agent.approveOverlap(owner, featureId, blockedFeatureId, repos);
              return approved.status === "ok" ? { status: "ok", lock: approved.lock } : approved;
            },
            planParts: async (owner) => agent.planInbox(owner, repos),
            // The decider is the session's person, named by the dashboard route, never by the body.
            decidePlanPart: async (owner, decision) => {
              const decided =
                decision.kind === "request_change"
                  ? await agent.requestPlanChange(owner, decision, repos)
                  : decision.kind === "reverse"
                    ? await agent.reversePenguinApproval(owner, decision, repos)
                    : await agent.approvePlanPart(owner, decision, repos);
              return decided.status === "ok" ? { status: "ok", part: decided.part, recordId: decided.recordId } : decided;
            },
            // The confirmer is the session's person, named by the dashboard route, never by the body.
            confirmProtectedChange: async (owner, input) => {
              const confirmed = await agent.confirmProtectedChange(owner, input, repos);
              return confirmed.status === "ok" ? { status: "ok", recordId: confirmed.recordId } : confirmed;
            },
            connectLive: (liveRequest, owner) => {
              // The browser cannot name the owner: the header is replaced with the session's.
              const headers = new Headers(liveRequest.headers);
              headers.set(LIVE_OWNER_HEADER, owner);
              return agent.fetch(new Request(liveRequest, { headers }));
            },
          };
        },
        routeAgents: (agentRequest) => routeAgentRequest(agentRequest, env),
        setUpProject: (setupRequest) => setUpProject(env.ARTIFACTS, setupRequest, names),
        rebuildIndex: async () => {
          const agent = await getAgentByName(env.ProjectAgent, projectAgentName(names));
          return agent.rebuildIndex({ issues: names.issues, base: names.base });
        },
        // One ProjectAgent per repo prefix, so a test run's bridges stay apart from production's.
        bridges: () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
        huddles: async () => {
          const agent = await getAgentByName(env.ProjectAgent, projectAgentName(names));
          return {
            open: (event, triggerFork) => agent.openHuddle(event, triggerFork, repos),
            recordRepo: async (triggerCommit, huddleRepo) => agent.recordHuddleRepo(triggerCommit, huddleRepo),
            forkRepo: (huddleId) => forkHuddleRepo(env.ARTIFACTS, huddleId, names),
            pendingVerifications: async () => agent.pendingVerifications(),
            reportVerification: (runId, runnerId, report) => agent.reportVerification(runId, runnerId, report, repos),
            pendingApprovals: async () => agent.pendingApprovals(),
            reportApproval: (issueId, runnerId, report) => agent.reportApprovedBranch(issueId, runnerId, report, repos),
          };
        },
        blocks: async () => {
          const project = await getAgentByName(env.ProjectAgent, projectAgentName(names));
          return {
            claim: (caller) => project.claimBlockRuns(caller),
            // The runner's report reaches the feature's FeatureAgent directly, with a port back to the
            // ProjectAgent for signing, the promotion slot and the feature's state.
            report: async (caller, runId, body) => {
              const featureId = featureOfBlockRun(runId) as string;
              const agent = await getAgentByName(env.FeatureAgent, `${projectAgentName(names)}-feature-${featureId}`);
              const port: BlockProjectPort = {
                signBlockRecord: (feature, type, payload) => project.signBlockRecord(feature, type, payload),
                acquirePromotion: async (feature, run) => project.acquirePromotion(feature, run),
                releasePromotion: async (run) => project.releasePromotion(run),
                featureLanded: (feature, promotion) => project.featureLanded(feature, promotion, repos),
                landFailed: async (feature, run) => project.landFailed(feature, run),
                retryLand: (feature, run, charter) => project.retryLand(feature, run, charter, repos),
                expandPromoted: (feature, promotion) => project.expandPromoted(feature, promotion),
                retryExpand: (feature, run, charter) => project.retryExpand(feature, run, charter, repos),
                blockReported: (feature, run, decisions) => project.blockReported(feature, run, decisions, repos),
              };
              return (await agent.reportBlockRun(caller, runId, body, port, { base: names.base, prefix: names.prefix })) as BlockReportAnswer;
            },
          };
        },
        mcpTokens: () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
        // The owner's fork is named from the authenticated owner, never from the request.
        serveMcp: (mcpRequest, owner) =>
          serveMcp(
            mcpRequest,
            owner,
            () => getAgentByName(env.ProjectAgent, projectAgentName(names)),
            { issues: names.issues, base: names.base, ownerFork: names.owner(owner) },
            mcpFeatures(features, owner),
          ),
        ownerForkRepo: (owner) => names.owner(owner),
        projectRepos: repos,
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
