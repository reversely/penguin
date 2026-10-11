import assert from "node:assert/strict";
import { test } from "node:test";

// The store module directly: the package entry point loads the Agents SDK, which needs workerd.
import { McpTokenStore } from "../../../services/project-agent/src/mcp-tokens.ts";
import { sqlite } from "../../../services/project-agent/test/issues-repo.ts";
import { serveMcp, type McpProject } from "@penguin/mcp";

import { type GatewayHandlers, handleRequest } from "../src/gateway.ts";

const DEPLOYER_TOKEN = "deployer-secret-for-tests";
const OPTIONS = { deployerToken: DEPLOYER_TOKEN, tokenTtlSeconds: 600 };

/** A ProjectAgent that no tool reaches in these tests. */
const UNUSED_PROJECT = {} as McpProject;

function gateway(serve?: GatewayHandlers["serveMcp"]) {
  const store = new McpTokenStore(sqlite().sql);
  const served: string[] = [];
  const handlers = {
    routeAgents: async () => Response.json({ routed: true }),
    mcpTokens: () => ({
      issueMcpToken: (owner: string) => store.issue(owner),
      authenticateMcpToken: (token: string) => store.authenticate(token),
      revokeMcpToken: (tokenId: string) => store.revoke(tokenId),
    }),
    serveMcp:
      serve ??
      (async (_request: Request, owner: string) => {
        served.push(owner);
        return Response.json({ owner });
      }),
  } as unknown as GatewayHandlers;
  return { store, served, send: (request: Request) => handleRequest(request, OPTIONS, handlers) };
}

function issueRequest(body: unknown, token?: string, method = "POST"): Request {
  return new Request("https://penguin.test/mcp/tokens", {
    method,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function mcpRequest(token?: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }): Request {
  return new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function issue(send: (request: Request) => Promise<Response>, owner: string) {
  const response = await send(issueRequest({ owner }, DEPLOYER_TOKEN));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return (await response.json()) as { tokenId: string; owner: string; token: string; issuedAt: string };
}

test("the deployer issues an MCP token for an owner, and only the deployer can", async () => {
  const { send } = gateway();
  const issued = await issue(send, "jun");
  assert.equal(issued.owner, "jun");
  assert.match(issued.token, /^pgm_/u);

  for (const token of [undefined, "wrong", issued.token]) {
    assert.equal((await send(issueRequest({ owner: "jun" }, token))).status, 401, String(token));
  }
  // Local development does not open token issuing.
  const local = new Request("http://localhost:8787/mcp/tokens", { method: "POST", body: JSON.stringify({ owner: "jun" }) });
  assert.equal((await handleRequest(local, { localDevUnauthenticated: "true" }, {} as GatewayHandlers)).status, 401);
});

test("token issuing validates the owner and the method", async () => {
  const { send } = gateway();
  for (const body of [{}, { owner: "" }, { owner: "../jun" }, { owner: 7 }, "jun"]) {
    assert.equal((await send(issueRequest(body, DEPLOYER_TOKEN))).status, 400, JSON.stringify(body));
  }
  assert.equal((await send(issueRequest(undefined, DEPLOYER_TOKEN, "GET"))).status, 405);
});

test("/mcp answers 401 to a request with no token, a wrong token or a revoked token", async () => {
  const { send, served } = gateway();
  const issued = await issue(send, "jun");
  for (const token of [undefined, "", "wrong", `${issued.token}x`, issued.token.slice(0, -1), DEPLOYER_TOKEN]) {
    const response = await send(mcpRequest(token));
    assert.equal(response.status, 401, String(token));
    assert.equal(response.headers.get("WWW-Authenticate"), 'Bearer realm="penguin"');
  }
  const revoke = (token?: string) =>
    send(new Request(`https://penguin.test/mcp/tokens/${issued.tokenId}`, {
      method: "DELETE",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }));
  assert.equal((await revoke(issued.token)).status, 401);
  assert.equal((await send(mcpRequest(issued.token))).status, 200);
  assert.equal((await revoke(DEPLOYER_TOKEN)).status, 204);
  assert.equal((await revoke(DEPLOYER_TOKEN)).status, 404);
  assert.equal((await send(mcpRequest(issued.token))).status, 401);
  assert.deepEqual(served, ["jun"]);
});

test("/mcp requires a token in local development too", async () => {
  const { served } = gateway();
  const request = new Request("http://localhost:8787/mcp", { method: "POST", body: "{}" });
  const handlers = { mcpTokens: () => ({ authenticateMcpToken: async () => undefined }) } as unknown as GatewayHandlers;
  assert.equal((await handleRequest(request, { localDevUnauthenticated: "true" }, handlers)).status, 401);
  assert.deepEqual(served, []);
});

test("/mcp serves the tools as the owner the token names", async () => {
  const { send, served } = gateway();
  const [jun, priya] = [await issue(send, "jun"), await issue(send, "priya")];
  await send(mcpRequest(priya.token));
  await send(mcpRequest(jun.token));
  assert.deepEqual(served, ["priya", "jun"]);
});

test("tools/list over the gateway with an owner's token returns the five session tools", async () => {
  const { send } = gateway((request, owner) =>
    serveMcp(request, owner, () => UNUSED_PROJECT, { issues: "issues", base: "base", ownerFork: `owner-${owner}` }),
  );
  const { token } = await issue(send, "jun");
  const response = await send(mcpRequest(token));
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: ")) ?? text;
  const { result } = JSON.parse(data.replace(/^data: /u, "")) as { result: { tools: { name: string }[] } };
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    "get_issue",
    "get_work",
    "post_update",
    "register_session",
    "report_checkpoint",
  ]);
});
