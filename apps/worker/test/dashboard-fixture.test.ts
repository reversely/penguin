// The Phase F exit check (PRD 0.4 section 12): during a scripted run, each person sees only their own
// approvals and exceptions. The money-minor-units fixture is seeded through the ProjectAgent's modules
// and the check runner's programs (scripts/preview/seed.ts): forty features, an overlapping start, a
// nine-scope plan returned over the break limit and proposed again, a tax review on the runner and
// the codemodded scopes approved. Every person then signs in to the Worker's own dashboard routes.
// A plan part's changed lines reach only its owner and the feature's person; no answer carries a
// session transcript. The team view's read time at forty features is printed for the record.

import assert from "node:assert/strict";
import { before, test } from "node:test";

import type { FeaturePage, OverlapRequests, PlanInbox, TeamView } from "@penguin/protocol";

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
  people = [...new Set([...preview.scopeMap.scopes.values()].map((scope) => scope.ownerId))];
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
  const ownerOfScope = (scope: string) => preview.scopeMap.scopes.get(scope)?.ownerId;
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
  // Every part that waits on an author reached that author and nobody else.
  const plan = await preview.plan("money-minor-units");
  const waiting = (plan?.parts ?? []).filter((part) => part.approvalState === "pending").map((part) => part.partId);
  assert.ok(waiting.length > 20, `${waiting.length} parts wait`);
  assert.deepEqual([...seen.keys()].sort(), [...waiting].sort());
  // The run's own exceptions reached their people: Rahul the broken tax invariant, Ines the returned plan.
  assert.equal((await read<PlanInbox>("rahul", "/api/plan-parts")).body.reviewExceptions.length, 1);
  assert.equal((await read<PlanInbox>("ines", "/api/plan-parts")).body.returnedPlans.length, 1);
  assert.equal((await read<PlanInbox>("sun", "/api/plan-parts")).body.reviewExceptions.length, 0);
});

test("a part's changed lines reach only its owner and the feature's person, and no answer carries a transcript", async () => {
  const page = async (person: string) => (await read<FeaturePage>(person, "/api/features/money-minor-units/page")).body;
  const ines = await page("ines");
  const rahul = await page("rahul");
  const sun = await page("sun");
  assert.ok(ines.plan !== null && ines.plan.parts.every((part) => part.files !== null), "the feature's person reads every part");
  for (const part of rahul.plan?.parts ?? []) assert.equal(part.files !== null, part.owner === "rahul", part.partId);
  assert.ok(sun.plan?.parts.every((part) => part.files === null), "a person with no part reads no changed lines");
  // The same facts, states and checks reach everyone.
  assert.deepEqual(sun.plan?.parts.map((part) => [part.partId, part.state]), ines.plan?.parts.map((part) => [part.partId, part.state]));
  for (const person of ["ines", "rahul", "sun"]) {
    for (const path of ["/api/team", "/api/features/money-minor-units/page", "/api/plan-parts", "/api/overlaps", "/api/identities"]) {
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
  const origin = features.find((feature) => feature.id === "money-minor-units");
  assert.equal(origin?.state, "waiting on approvals");
  assert.deepEqual(origin?.exceptions, [{ kind: "broken_invariant", scope: "tax", invariant: "tax-per-line" }]);
  // Features with no exception carry none; a feature whose start waits reads waiting on approvals.
  assert.ok(features.filter((feature) => feature.id !== "money-minor-units").every((feature) => feature.exceptions.length === 0));
  const tomas = team.people.find((person) => person.id === "tomas");
  assert.deepEqual(tomas?.role.scopes.map((scope) => scope.id), ["orders"]);
  assert.ok((tomas?.role.dependents.length ?? 0) > 3);
});
