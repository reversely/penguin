// The Phase F exit check (PRD 0.4 section 12): during a scripted run, each person sees only their own
// approvals and exceptions. The money-minor-units fixture is seeded through the ProjectAgent's modules
// and the check runner's programs (scripts/preview/seed.ts): Ines's split with its overlapping start,
// the expand reaching main, a migration plan per owner group, a block per owner for code on main with
// Rahul's tax review on the runner, and the contract. Every person then signs in to the Worker's own
// dashboard routes. No answer carries a session transcript. The team view's read time is printed for
// the record.

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { ROLE_TOP, type OverlapRequests, type PlanInbox, type TeamView } from "@penguin/protocol";

import { handleDashboardRoute } from "../src/dashboard.ts";
import { parseOwnerMap } from "../src/github-oauth.ts";
import { encodeSession, SESSION_COOKIE, sessionKey } from "../src/session.ts";
import { seed, type PreviewProject } from "../../../scripts/preview/seed.ts";

const SECRET = "fixture-secret"; // pragma: allowlist secret
let preview: PreviewProject;
let people: string[];
let key: CryptoKey;

before(async () => {
  preview = await seed("money-minor-units", { runnerTools: false });
  people = [...new Set([...preview.scopeMap.scopes.values()].map((scope) => scope.driId))];
  key = await sessionKey(SECRET);
});


/** GET `path` on the Worker's dashboard routes, signed in as `owner`. */
async function read<T>(owner: string, path: string): Promise<{ status: number; body: T; text: string }> {
  const cookie = await encodeSession(key, { owner, login: owner, expiresAt: Date.now() + 60_000 });
  const request = new Request(`https://penguin.test${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
  const options = { githubClientId: "client", githubClientSecret: SECRET, owners: parseOwnerMap(people.map((person) => `${person}:${person}`).join(",")) };
  const response = (await handleDashboardRoute(request, new URL(request.url), options, { serveAsset: async () => new Response(""), dashboard: () => preview.backend() })) as Response;
  const text = await response.text();
  return { status: response.status, body: (response.status === 200 ? JSON.parse(text) : undefined) as T, text };
}

test("each person sees only the approvals and exceptions that wait on them", async () => {
  const ownerOfScope = (scope: string) => preview.scopeMap.scopes.get(scope)?.driId;
  const personOf = (feature: string) => preview.features.get(feature)?.personId;
  const seen = new Map<string, string>();
  for (const person of people) {
    const { status, body: inbox } = await read<PlanInbox>(person, "/api/plan-parts");
    assert.equal(status, 200);
    for (const part of inbox.parts) {
      if (part.ask === "approve") {
        assert.equal(part.owner, person, `${part.partId} is listed to ${person}`);
        assert.equal(seen.get(part.partId), undefined, `${part.partId} is listed to one person`);
        seen.set(part.partId, person);
      }
      if (part.ask === "round_limit") assert.equal(part.person, person);
      if (part.ask === "protected_path") assert.ok(part.routing.reasons.some((reason) => reason.kind === "protected_path" && reason.owner === person));
    }
    for (const item of inbox.reviewExceptions) assert.equal(ownerOfScope(item.scope), person, `review of ${item.scope} reaches its owner`);
    for (const item of inbox.returnedPlans) assert.equal(personOf(item.feature), person);
    const overlaps = (await read<OverlapRequests>(person, "/api/overlaps")).body;
    for (const request of overlaps.requests) assert.equal(personOf(request.feature), person, `${request.blockedFeature} waits on ${person}`);
  }
  // A split asks no author to approve a part: the expand's plan has no place, and migration parts are
  // decided by their trials. The run's one exception is Rahul's broken tax invariant on the tax block.
  assert.deepEqual([...seen.keys()], []);
  assert.deepEqual((await read<PlanInbox>("ines", "/api/plan-parts")).body.returnedPlans, []);
  assert.equal((await read<PlanInbox>("rahul", "/api/plan-parts")).body.reviewExceptions.length, 1);
  assert.equal((await read<PlanInbox>("sun", "/api/plan-parts")).body.reviewExceptions.length, 0);
});

test("no answer carries a transcript", async () => {
  for (const person of ["ines", "rahul", "tomas"]) {
    for (const path of ["/api/team", "/api/features/money-minor-units/page", "/api/features/money-minor-units/plan", "/api/plan-parts", "/api/overlaps", "/api/identities"]) {
      assert.doesNotMatch((await read(person, path)).text, /transcript/i, `${path} as ${person}`);
    }
  }
});

test("the team view states each feature's one word and highlights only exceptions", async (t) => {
  const started = performance.now();
  const { body: team } = await read<TeamView>("ines", "/api/team");
  const readMs = performance.now() - started;
  t.diagnostic(`GET /api/team at ${team.people.flatMap((person) => person.features).length} features: ${readMs.toFixed(1)} ms`);
  assert.equal(team.people[0]?.id, "ines", "the signed-in person comes first");
  const features = team.people.flatMap((person) => person.features);
  assert.equal(features.length, preview.features.list().length);
  // No plan was returned over the break limit: a split has no plan with places to return.
  for (const feature of features) assert.deepEqual(feature.exceptions.map((each) => each.kind).filter((kind) => kind === "plan_returned"), [], feature.id);
  // Each block for code on main and Ines's split have reached main.
  for (const id of ["money-minor-units", ...preview.migrations.plans("money-minor-units").filter((plan) => plan.state === "landed").map((plan) => plan.block)]) {
    assert.equal(features.find((each) => each.id === id)?.state, "promoted", id);
  }
  const tomas = team.people.find((person) => person.id === "tomas");
  assert.deepEqual(tomas?.role.scopes.map((scope) => scope.id).sort(), ["fulfilment", "orders"]);
  // The team view carries the top scopes of each row and every row's full count (#134).
  assert.ok((tomas?.role.counts?.readBy ?? 0) > 3);
  assert.equal(tomas?.role.dependents.length, ROLE_TOP);
});
