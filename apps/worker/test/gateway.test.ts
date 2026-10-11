import assert from "node:assert/strict";
import { test } from "node:test";

import { type AgentRouter, type GatewayHandlers, handleRequest } from "../src/gateway.ts";
import type { ProjectSetupReport, ProjectSetupRequest } from "../src/repos.ts";

const agentReply: AgentRouter = async () => Response.json({ routed: true });
const noAgent: AgentRouter = async () => null;
const LOCAL_DEV = { localDevUnauthenticated: "true" };
const DEPLOYER_TOKEN = "deployer-secret-for-tests";

const setupCalls: ProjectSetupRequest[] = [];
const AGENTS: GatewayHandlers = {
  routeAgents: agentReply,
  setUpProject: async (request) => {
    setupCalls.push(request);
    return { complete: true, created: 0, repos: [] } as unknown as ProjectSetupReport;
  },
};

function setupRequest(body: unknown, token?: string, method = "POST"): Request {
  return new Request("https://penguin.example/setup", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const OWNERS = { owners: ["priya", "jun", "sam"] };

test("/setup rejects a caller without the deployer credential", async () => {
  setupCalls.length = 0;
  const options = { deployerToken: DEPLOYER_TOKEN };
  for (const token of [undefined, "wrong", `${DEPLOYER_TOKEN}x`, DEPLOYER_TOKEN.slice(0, -1)]) {
    const response = await handleRequest(setupRequest(OWNERS, token), options, AGENTS);
    assert.equal(response.status, 401, String(token));
  }
  // Local development does not open /setup either.
  const local = new Request("http://localhost:8787/setup", { method: "POST", body: JSON.stringify(OWNERS) });
  assert.equal((await handleRequest(local, { ...LOCAL_DEV, ...options }, AGENTS)).status, 401);
  assert.equal(setupCalls.length, 0);
});

test("/setup rejects every caller when no deployer token is configured", async () => {
  for (const token of ["", "anything"]) {
    const response = await handleRequest(setupRequest(OWNERS, token), {}, AGENTS);
    assert.equal(response.status, 401);
  }
  const response = await handleRequest(setupRequest(OWNERS, ""), { deployerToken: "" }, AGENTS);
  assert.equal(response.status, 401);
});

test("/setup with the deployer credential runs project setup", async () => {
  setupCalls.length = 0;
  const response = await handleRequest(setupRequest(OWNERS, DEPLOYER_TOKEN), { deployerToken: DEPLOYER_TOKEN }, AGENTS);
  assert.equal(response.status, 200);
  assert.deepEqual(setupCalls, [OWNERS]);
});

test("/setup rejects an invalid owner name before project setup runs", async () => {
  setupCalls.length = 0;
  const options = { deployerToken: DEPLOYER_TOKEN };
  const response = await handleRequest(setupRequest({ owners: ["priya", "../jun"] }, DEPLOYER_TOKEN), options, AGENTS);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { issues: { field: string }[] };
  assert.deepEqual(body.issues.map((issue) => issue.field), ["owners[1]"]);
  assert.equal((await handleRequest(setupRequest("{", DEPLOYER_TOKEN), options, AGENTS)).status, 400);
  assert.equal(setupCalls.length, 0);
});

test("/setup answers 405 to an authorized non-POST request", async () => {
  const request = setupRequest(undefined, DEPLOYER_TOKEN, "GET");
  const response = await handleRequest(request, { deployerToken: DEPLOYER_TOKEN }, AGENTS);
  assert.equal(response.status, 405);
});

test("/setup answers 502 with the Artifacts error code when setup fails", async () => {
  const failing: GatewayHandlers = {
    ...AGENTS,
    setUpProject: async () => {
      throw new Error("ArtifactsError: repo already exists: base");
    },
  };
  const options = { deployerToken: DEPLOYER_TOKEN };
  const response = await handleRequest(setupRequest(OWNERS, DEPLOYER_TOKEN), options, failing);
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { code: string }).code, "ALREADY_EXISTS");
});

test("GET /health returns 200 without credentials", async () => {
  const response = await handleRequest(new Request("https://penguin.example/health"), {}, AGENTS);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("a non-GET request to /health returns 405", async () => {
  const request = new Request("https://penguin.example/health", { method: "POST" });
  const response = await handleRequest(request, {}, AGENTS);
  assert.equal(response.status, 405);
});

test("an agent route returns 401 without credentials", async () => {
  const request = new Request("https://penguin.example/agents/project-agent/demo", { method: "POST" });
  const response = await handleRequest(request, {}, AGENTS);
  assert.equal(response.status, 401);
});

test("an unknown route returns 401 without credentials", async () => {
  const response = await handleRequest(new Request("https://penguin.example/anything"), {}, AGENTS);
  assert.equal(response.status, 401);
});

test("the local-dev variable does not open a non-loopback hostname", async () => {
  const request = new Request("https://penguin.example/agents/project-agent/demo");
  const response = await handleRequest(request, LOCAL_DEV, AGENTS);
  assert.equal(response.status, 401);
});

test("a loopback hostname without the local-dev variable stays closed", async () => {
  const request = new Request("http://localhost:8787/agents/project-agent/demo");
  const response = await handleRequest(request, {}, AGENTS);
  assert.equal(response.status, 401);
});

test("local development on a loopback hostname reaches the agent router", async () => {
  for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
    const request = new Request(`http://${host}/agents/project-agent/demo`);
    const response = await handleRequest(request, LOCAL_DEV, AGENTS);
    assert.equal(response.status, 200, host);
    assert.deepEqual(await response.json(), { routed: true });
  }
});

test("local development returns 404 when no agent matches", async () => {
  const request = new Request("http://localhost:8787/nowhere");
  const response = await handleRequest(request, LOCAL_DEV, { ...AGENTS, routeAgents: noAgent });
  assert.equal(response.status, 404);
});
