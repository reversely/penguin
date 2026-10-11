import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchVerificationRuns,
  RemoteRefusedError,
  reportVerification,
  TokenClient,
  verificationPass,
  type Fetch,
} from "@penguin/local-bridge";
import type { VerificationReport, VerificationRunSpec } from "@penguin/protocol";

const SERVER = "https://penguin.example";

/** A fetch that records each request and answers with `answer`. */
function recorder(answer: (url: string, init?: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return answer(String(url), init);
  }) as Fetch;
  return { requests, fetchStub };
}

const REPORT: VerificationReport = { status: "conflict", ownerId: "priya", sha: "a".repeat(40), paths: ["x.py"] };

test("a runner lists runs and reports one with its bridge token; a superseded run needs no retry", async () => {
  const spec = { runId: "3", issueId: "1", huddleRepo: "huddle-001" } as unknown as VerificationRunSpec;
  const { requests, fetchStub } = recorder((url) =>
    url.endsWith("/verifications")
      ? Response.json({ runs: [spec] })
      : url.endsWith("/3")
        ? Response.json({ error: "superseded", message: "run 3 was superseded" }, { status: 409 })
        : Response.json({ error: "not_found", message: "no verification run 4" }, { status: 404 }),
  );
  assert.deepEqual(await fetchVerificationRuns(SERVER, "bridge-token", fetchStub), [spec]);
  assert.deepEqual(await reportVerification(SERVER, "bridge-token", "3", REPORT, fetchStub), {
    status: "superseded",
    message: "run 3 was superseded",
  });
  await assert.rejects(reportVerification(SERVER, "bridge-token", "4", REPORT, fetchStub), RemoteRefusedError);
  assert.deepEqual(
    requests.map(({ url, init }) => [url, init?.method ?? "GET", new Headers(init?.headers).get("Authorization")]),
    [
      [`${SERVER}/verifications`, "GET", "Bearer bridge-token"],
      [`${SERVER}/verifications/3`, "POST", "Bearer bridge-token"],
      [`${SERVER}/verifications/4`, "POST", "Bearer bridge-token"],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), REPORT);
});

test("the token client asks for read tokens when told to and caches each scope apart", async () => {
  const { requests, fetchStub } = recorder((_url, init) => {
    const { repo, scope } = JSON.parse(String(init?.body)) as { repo: string; scope: string };
    return Response.json({ repo, scope, token: `${scope}-token`, remote: "https://artifacts.example/r.git", expiresAt: "2099-01-01T00:00:00Z" });
  });
  const client = new TokenClient({ server: SERVER, bridgeToken: "bridge-token", fetch: fetchStub });
  assert.equal((await client.token("owner-jun", { scope: "read" })).token, "read-token");
  assert.equal((await client.token("owner-jun", { scope: "read" })).scope, "read");
  assert.equal((await client.token("owner-jun")).token, "write-token");
  assert.deepEqual(
    requests.map(({ init }) => JSON.parse(String(init?.body))),
    [
      { repo: "owner-jun", scope: "read" },
      { repo: "owner-jun", scope: "write" },
    ],
  );
});

test("one run that fails stays pending and never stops the next", async () => {
  const specs = [{ runId: "1" }, { runId: "2" }] as unknown as VerificationRunSpec[];
  const result = await verificationPass({
    list: async () => specs,
    run: async (spec) => {
      if (spec.runId === "1") throw new Error("the fork owner-jun is unreachable");
      return REPORT;
    },
    report: async () => ({ status: "existing", issueId: "1" }),
  });
  assert.deepEqual(result.failed, [{ runId: "1", reason: "the fork owner-jun is unreachable" }]);
  assert.deepEqual(result.reported, [{ runId: "2", reply: { status: "existing", issueId: "1" } }]);
});
