import assert from "node:assert/strict";
import { test } from "node:test";

import { type AgentRouter, handleRequest } from "../src/gateway.ts";

const agentReply: AgentRouter = async () => Response.json({ routed: true });
const noAgent: AgentRouter = async () => null;
const LOCAL_DEV = { localDevUnauthenticated: "true" };

test("GET /health returns 200 without credentials", async () => {
  const response = await handleRequest(new Request("https://penguin.example/health"), {}, agentReply);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("a non-GET request to /health returns 405", async () => {
  const request = new Request("https://penguin.example/health", { method: "POST" });
  const response = await handleRequest(request, {}, agentReply);
  assert.equal(response.status, 405);
});

test("an agent route returns 401 without credentials", async () => {
  const request = new Request("https://penguin.example/agents/project-agent/demo", { method: "POST" });
  const response = await handleRequest(request, {}, agentReply);
  assert.equal(response.status, 401);
});

test("an unknown route returns 401 without credentials", async () => {
  const response = await handleRequest(new Request("https://penguin.example/anything"), {}, agentReply);
  assert.equal(response.status, 401);
});

test("the local-dev variable does not open a non-loopback hostname", async () => {
  const request = new Request("https://penguin.example/agents/project-agent/demo");
  const response = await handleRequest(request, LOCAL_DEV, agentReply);
  assert.equal(response.status, 401);
});

test("a loopback hostname without the local-dev variable stays closed", async () => {
  const request = new Request("http://localhost:8787/agents/project-agent/demo");
  const response = await handleRequest(request, {}, agentReply);
  assert.equal(response.status, 401);
});

test("local development on a loopback hostname reaches the agent router", async () => {
  for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
    const request = new Request(`http://${host}/agents/project-agent/demo`);
    const response = await handleRequest(request, LOCAL_DEV, agentReply);
    assert.equal(response.status, 200, host);
    assert.deepEqual(await response.json(), { routed: true });
  }
});

test("local development returns 404 when no agent matches", async () => {
  const request = new Request("http://localhost:8787/nowhere");
  const response = await handleRequest(request, LOCAL_DEV, noAgent);
  assert.equal(response.status, 404);
});
