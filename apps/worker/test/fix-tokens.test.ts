// The Worker's half of writing approved fixes (#91, PRD 0.4 section 8): a write token on another
// person's feature fork is minted only on a grant from the ProjectAgent, on the grant's one fork, for
// PENGUIN_FIX_TOKEN_TTL_MINUTES. The ProjectAgent's grant rules are tested in
// services/project-agent/test/fix-write.test.ts; here its answers are fixed and the minting is counted.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fixCommitMessage, type FixWriteSpec } from "@penguin/protocol";

import type { BridgeDirectory, BridgeHandlers } from "../src/bridges.ts";
import { handleBridgeRoute } from "../src/bridges.ts";
import { mcpFeatures, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import type { MintedToken, TokenScope } from "../src/tokens.ts";
import { DEFAULT_FIX_TOKEN_TTL_MINUTES, parseFixTokenTtl } from "../src/tokens.ts";

const SPEC: FixWriteSpec = {
  writeId: 4,
  feature: "money-minor",
  planId: "money-minor/v1",
  partId: "money-minor/v1#2",
  revision: 1,
  kind: "behavioural",
  writer: "agent",
  target: "tax-rounding",
  fork: "feature-tax-rounding",
  branch: "main",
  parent: "a".repeat(40),
  rebased: false,
  paths: ["tax/rounding.py"],
  patch: "--- a/tax/rounding.py\n+++ b/tax/rounding.py\n@@ -1 +1 @@\n-a\n+b\n",
  message: fixCommitMessage({ partId: "money-minor/v1#2", revision: 1, target: "tax-rounding", approvedBy: "rahul", writtenBy: "@ines/money", ref: "r" }),
};

function minter() {
  const mints: { repo: string; scope: TokenScope; ttl: number }[] = [];
  const mint = async (repo: string, scope: TokenScope, ttl: number): Promise<MintedToken> => {
    mints.push({ repo, scope, ttl });
    return { token: `art_${mints.length}`, remote: `https://artifacts.test/${repo}.git`, scope, expiresAt: "2026-10-11T09:10:00Z" };
  };
  return { mints, mint };
}

describe("PENGUIN_FIX_TOKEN_TTL_MINUTES", () => {
  test("is minutes from 1 to 60, 10 when unset, and refuses anything else", () => {
    assert.equal(parseFixTokenTtl(undefined), DEFAULT_FIX_TOKEN_TTL_MINUTES * 60);
    assert.equal(parseFixTokenTtl("1"), 60);
    assert.equal(parseFixTokenTtl("60"), 3_600);
    for (const bad of ["0", "61", "1440", "5m", "-5", " 5", "05"]) assert.equal(parseFixTokenTtl(bad), undefined, bad);
  });
});

describe("fix_token", () => {
  // A null lifetime stands for an invalid PENGUIN_FIX_TOKEN_TTL_MINUTES.
  const ports = (grant: Awaited<ReturnType<FeatureDirectory["fixWriteGrant"]>>, ttl: number | null = 600) => {
    const { mints, mint } = minter();
    const calls: unknown[] = [];
    const directory = {
      fixWriteGrant: async (owner: string, sessionId: string, input: unknown) => {
        calls.push({ owner, sessionId, input });
        return grant;
      },
    } as unknown as FeatureDirectory;
    const featurePorts: FeaturePorts = {
      directory: () => directory,
      fork: async () => assert.fail("no fork is made"),
      mintWrite: (repo, seconds) => mint(repo, "write", seconds),
      repos: { issues: "t-issues", base: "t-base" },
      config: { forkOptions: { defaultBranchOnly: true }, tokenTtlSeconds: 1_800, fixTokenTtlSeconds: ttl ?? undefined },
    };
    return { mints, calls, features: mcpFeatures(featurePorts, "ines") };
  };

  test("mints write on the grant's one fork, for the fix token's minutes, and returns the write to make", async () => {
    const { mints, calls, features } = ports({ status: "ok", spec: SPEC, repo: "t-feature-tax-rounding" });
    const answer = await features.fixToken("s-ines", { feature: "money-minor", part: SPEC.partId, revision: 1 });
    assert.equal(answer.status, "ok", JSON.stringify(answer));
    assert.deepEqual(mints, [{ repo: "t-feature-tax-rounding", scope: "write", ttl: 600 }]);
    assert.deepEqual(calls, [{ owner: "ines", sessionId: "s-ines", input: { feature: "money-minor", part: SPEC.partId, revision: 1 } }]);
    const value = (answer as { value: { token: Record<string, unknown>; write: Record<string, unknown> } }).value;
    assert.deepEqual([value.token["fork"], value.token["scope"], value.token["token"]], ["feature-tax-rounding", "write", "art_1"]);
    assert.deepEqual([value.write["parent"], value.write["message"], value.write["paths"]], [SPEC.parent, SPEC.message, SPEC.paths]);
    // The patch the agent wrote comes back only as data.
    assert.equal(value.write["patch"], undefined);
    assert.deepEqual(value.write["personWritten"], { patch: SPEC.patch });
  });

  test("a refused grant mints nothing, and an invalid lifetime refuses before asking", async () => {
    const refused = ports({ status: "rejected", reason: "not_approved", message: "not approved" });
    assert.deepEqual(await refused.features.fixToken("s-ines", { feature: "money-minor", part: SPEC.partId, revision: 1 }), {
      status: "rejected",
      reason: "not_approved",
      message: "not approved",
    });
    assert.deepEqual(refused.mints, []);

    const misconfigured = ports({ status: "ok", spec: SPEC, repo: "t-feature-tax-rounding" }, null);
    const answer = await misconfigured.features.fixToken("s-ines", { feature: "money-minor", part: SPEC.partId, revision: 1 });
    assert.equal((answer as { reason?: string }).reason, "misconfigured");
    assert.deepEqual([misconfigured.mints, misconfigured.calls], [[], []]);
  });
});

describe("POST /fix-writes/claim", () => {
  const handlers = (role: "owner" | "runner") => {
    const { mints, mint } = minter();
    const directory = {
      authenticateBridge: async (token: string) => (token === "bridge-token" ? { bridgeId: "b1", ownerId: "runner", role } : undefined),
      claimFixWrites: async () => ({ status: "ok", writes: [{ spec: { ...SPEC, writer: "runner" } }] }),
    } as unknown as BridgeDirectory;
    const bridgeHandlers = {
      bridges: () => directory,
      mintToken: mint,
      ownerForkRepo: (owner: string) => `t-owner-${owner}`,
      huddles: () => assert.fail("no Huddle"),
      projectRepos: { issues: "t-issues", base: "t-base" },
    } as unknown as BridgeHandlers;
    return { mints, bridgeHandlers };
  };
  const claim = (bridgeHandlers: BridgeHandlers, ttl: number | null = 300) => {
    const request = new Request("https://penguin.test/fix-writes/claim", { method: "POST", headers: { Authorization: "Bearer bridge-token" }, body: "{}" });
    return handleBridgeRoute(request, new URL(request.url), { tokenTtlSeconds: 3_600, fixTokenTtlSeconds: ttl ?? undefined }, bridgeHandlers);
  };

  test("hands the runner each write with a token minted for that part on its fork alone", async () => {
    const { mints, bridgeHandlers } = handlers("runner");
    const response = await claim(bridgeHandlers);
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("Cache-Control"), "no-store");
    const body = (await response?.json()) as { writes: Record<string, unknown>[] };
    assert.deepEqual(mints, [{ repo: "feature-tax-rounding", scope: "write", ttl: 300 }]);
    assert.deepEqual([body.writes[0]?.["fork"], (body.writes[0]?.["token"] as { token: string }).token], ["feature-tax-rounding", "art_1"]);
  });

  test("an owner's bridge gets nothing, and a misconfigured lifetime mints nothing", async () => {
    const owner = handlers("owner");
    assert.equal((await claim(owner.bridgeHandlers))?.status, 403);
    assert.deepEqual(owner.mints, []);
    const runner = handlers("runner");
    assert.equal((await claim(runner.bridgeHandlers, null))?.status, 500);
    assert.deepEqual(runner.mints, []);
  });
});
