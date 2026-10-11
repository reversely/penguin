import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { parseIndexChanged } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { IssueIndex, type OperationKeys } from "../src/issue-index.ts";
import { LIVE_OWNER_HEADER, LiveFeed, liveOwner } from "../src/live-feed.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { sqlite } from "./issues-repo.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

let service: ServiceKey;
let keys: OperationKeys;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  keys = { bridges: [], serviceKey: service.publicKey, scopeMap, identities: { byHandle: () => undefined } };
});

/** A feed whose deferred sends run when the test calls `flush`. */
function manualFeed(): { feed: LiveFeed; sent: string[]; flush: () => void } {
  const sent: string[] = [];
  const tasks: (() => void)[] = [];
  const feed = new LiveFeed(
    (message) => sent.push(message),
    (task) => tasks.push(task),
  );
  return { feed, sent, flush: () => tasks.splice(0).forEach((task) => task()) };
}

test("changes within one task go out as one message naming each issue once", () => {
  const { feed, sent, flush } = manualFeed();
  feed.issueChanged("40");
  feed.issueChanged("41");
  feed.issueChanged("40");
  assert.deepEqual(sent, []);
  flush();
  assert.deepEqual(sent.map((message) => parseIndexChanged(message)?.issues), [["40", "41"]]);
  feed.issueChanged("42");
  flush();
  assert.deepEqual(sent.map((message) => parseIndexChanged(message)?.issues), [["40", "41"], ["42"]]);
});

test("a submitted operation reaches connected dashboards after its transaction", async () => {
  const sent: string[] = [];
  const feed = new LiveFeed((message) => sent.push(message));
  const index = new IssueIndex(sqlite().sql, { issueChanged: (change) => feed.issueChanged(change.issueId) });

  const outcome = await index.submit({
    operation: { issue: 40, type: "create", base_version: 0, payload: { title: "Board filter drops identities" } },
    author: { person: "priya" },
    source: "dashboard",
    signingKey: service.privateKey,
    keys,
  });
  assert.equal(outcome.status, "applied");
  await Promise.resolve();
  assert.deepEqual(sent.map((message) => parseIndexChanged(message)?.issues), [["40"]]);
});

test("a dashboard connection names its person only through the Worker's header", () => {
  const request = (headers: Record<string, string>) => new Request("https://penguin.example/api/live", { headers });
  assert.equal(liveOwner(request({ [LIVE_OWNER_HEADER]: "priya" })), "priya");
  assert.equal(liveOwner(request({ [LIVE_OWNER_HEADER]: "" })), undefined);
  assert.equal(liveOwner(request({})), undefined);
});
