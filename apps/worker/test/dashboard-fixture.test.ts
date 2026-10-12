// The Phase F exit check (PRD 0.4 section 12): during a scripted run, each person sees only their own
// approvals and exceptions. The money-minor-units fixture is seeded through the ProjectAgent's modules
// and the check runner's programs (scripts/preview/seed.ts): the one-block plan returned over the
// break limit, then the waves of the parallel change with their overlapping starts, a tax review on
// the runner, each stored plan's parts approved and main moved, and the contract wave's plan as
// Penguin answers it. Every person then signs in to the Worker's own dashboard routes. A plan part's
// changed lines reach only its owner, the members of its scope's team and the feature's person, on the
// feature page and in the plan; no answer carries a session transcript. The team view's read time is printed for the record.

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { ROLE_TOP, type FeaturePage, type OverlapRequests, type PlanInbox, type TeamView, type ViewerPlan } from "@penguin/protocol";

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
  // Every part that waits on an author reached that author and nobody else.
  const plans = [preview.blockOutcome, ...preview.waveOutcomes.map((each) => each.outcome)];
  const stored = await Promise.all(preview.waveOutcomes.map(({ feature }) => preview.plan(feature)));
  const waiting = stored.flatMap((plan) => (plan?.parts ?? []).filter((part) => part.approvalState === "pending").map((part) => part.partId));
  assert.deepEqual([...seen.keys()].sort(), [...waiting].sort());
  // The run's own exceptions reached their people: Rahul the broken tax invariant, Ines each returned plan.
  const returned = plans.filter((outcome) => outcome?.status === "returned").map((outcome) => (outcome?.status === "returned" ? outcome.featureId : ""));
  assert.ok(returned.includes("money-minor-units"), "the one-block attempt is returned");
  const inesInbox = (await read<PlanInbox>("ines", "/api/plan-parts")).body;
  assert.deepEqual(inesInbox.returnedPlans.map((item) => item.feature).sort(), [...returned].sort());
  assert.equal((await read<PlanInbox>("rahul", "/api/plan-parts")).body.reviewExceptions.length, 1);
  assert.equal((await read<PlanInbox>("sun", "/api/plan-parts")).body.reviewExceptions.length, 0);
});

// The checkout wave's stored plan: its part for promotions on main belongs to Lena, in Shopping.
const WAVE = "money-checkout";

test("a part's changed lines reach only its owner, its scope's team and the feature's person, and no answer carries a transcript", async () => {
  const page = async (person: string) => (await read<FeaturePage>(person, `/api/features/${WAVE}/page`)).body;
  const ines = await page("ines");
  const lena = await page("lena");
  const tomas = await page("tomas");
  const rahul = await page("rahul");
  // A team member reads the changed lines of a part in the team's scopes (#135).
  const teammate = (person: string, scopes: readonly string[]) =>
    scopes.some((scope) => preview.scopeMap.teams.get(preview.scopeMap.scopes.get(scope)?.teamId ?? "")?.memberIds.includes(person) === true);
  assert.ok(ines.plan !== null && ines.plan.parts.length > 0 && ines.plan.parts.every((part) => part.files !== null), "the feature's person reads every part");
  for (const part of lena.plan?.parts ?? []) assert.equal(part.files !== null, part.owner === "lena", part.partId);
  // Tomas is Lena's teammate in Shopping, so Tomas reads the lines of Lena's promotions part.
  for (const part of tomas.plan?.parts ?? []) assert.equal(part.files !== null, teammate("tomas", part.scopes), part.partId);
  assert.ok(tomas.plan?.parts.some((part) => part.files !== null), "a teammate reads the part's lines");
  assert.ok(rahul.plan?.parts.every((part) => part.files === null), "a person outside the part's team reads no changed lines");
  // The same facts, states and checks reach everyone.
  assert.deepEqual(rahul.plan?.parts.map((part) => [part.partId, part.state]), ines.plan?.parts.map((part) => [part.partId, part.state]));
  // The plan route applies the same rule to each part's patch and changed lines.
  const plan = async (person: string) => (await read<ViewerPlan>(person, `/api/features/${WAVE}/plan`)).body;
  const readable = (seen: ViewerPlan) => seen.parts.filter((part) => part.diff.files !== null).map((part) => part.partId);
  const pageReadable = (seen: FeaturePage) => (seen.plan?.parts ?? []).filter((part) => part.files !== null).map((part) => part.partId);
  for (const [person, seen] of [["ines", ines], ["lena", lena], ["tomas", tomas], ["rahul", rahul]] as const) {
    const answered = await plan(person);
    assert.deepEqual(readable(answered), pageReadable(seen), `the plan route and the page agree for ${person}`);
    for (const part of answered.parts.filter((each) => each.diff.files === null)) assert.equal(part.diff.patch, null, `${part.partId} as ${person}`);
  }
  assert.ok((await plan("rahul")).parts.some((part) => part.diff.files === null), "rahul reads another team's part without its lines");
  for (const person of ["ines", "rahul", "tomas"]) {
    for (const path of ["/api/team", `/api/features/${WAVE}/page`, `/api/features/${WAVE}/plan`, "/api/plan-parts", "/api/overlaps", "/api/identities"]) {
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
  // A plan Penguin returned is the only exception the run leaves standing, on the feature that proposed it.
  const returned = [preview.blockOutcome, ...preview.waveOutcomes.map((each) => each.outcome)].flatMap((outcome) => (outcome?.status === "returned" ? [outcome.featureId] : []));
  for (const feature of features) {
    assert.deepEqual(feature.exceptions.map((each) => each.kind), returned.includes(feature.id) ? ["plan_returned"] : [], feature.id);
  }
  // Each wave whose plan was stored and approved has moved main.
  for (const { feature, outcome } of preview.waveOutcomes) {
    if (outcome.status === "stored" && feature !== preview.waveOutcomes.at(-1)?.feature) assert.equal(features.find((each) => each.id === feature)?.state, "promoted", feature);
  }
  const tomas = team.people.find((person) => person.id === "tomas");
  assert.deepEqual(tomas?.role.scopes.map((scope) => scope.id).sort(), ["fulfilment", "orders"]);
  // The team view carries the top scopes of each row and every row's full count (#134).
  assert.ok((tomas?.role.counts?.readBy ?? 0) > 3);
  assert.equal(tomas?.role.dependents.length, ROLE_TOP);
});
