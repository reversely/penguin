// A feature's own change to a path another person protects (#112, PRD 0.4 sections 4.3 step 4 and 7)
// on a real Git repository: Ines's analytics wave edits `analytics/revenue_report.py`, which Jun
// protects, Jun's own feature edits it too, and Priya's feature merges main after Jun's change
// reached it. The ProjectAgent's stores run on node:sqlite; every read goes through the binding's
// object reads (git-reader.ts) and main's log.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { checkPlanInbox, type ProtectedChangeRequest } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { FeatureStore, signFeatureRecord, type FeatureRecord } from "../src/feature-store.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { InboxStore } from "../src/inbox-store.ts";
import { announcePlan, buildPlanInbox, PlanRouteStore } from "../src/plan-approval.ts";
import {
  checkProtectedChanges,
  confirmProtectedChange,
  ownChange,
  protectedChangeRequests,
  ProtectedChangeStore,
  unconfirmedProtected,
  type CheckpointProtectionDeps,
  type ConfirmDeps,
} from "../src/protected-change.ts";
import { fileDiffs } from "../src/repo-diff.ts";
import { gitReader } from "./git-reader.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";

const REPORT = "analytics/revenue_report.py";
const SCOPE_MAP = parseScopeMap({
  scopes: [
    { id: "money", name: "money", owner: "ines", paths: ["shared/money/"], test_command: "true", depends_on: [] },
    { id: "analytics", name: "analytics", owner: "jun", paths: ["analytics/"], test_command: "true", depends_on: [], protected_paths: [REPORT] },
    { id: "checkout", name: "checkout", owner: "priya", paths: ["checkout/"], test_command: "true", depends_on: [] },
  ],
});
const key = generateSigningKeyPair();

let repo: GitRepo;
let main: string;
let features: FeatureStore;
let inbox: InboxStore;
let store: ProtectedChangeStore;
let notified: string[];
let delegates: Map<string, string>;

beforeEach(() => {
  repo = new GitRepo();
  main = repo.commit({ [REPORT]: "def revenue(orders):\n    return sum(orders)\n", "analytics/notes.py": "x = 1\n", "shared/money/api.py": "def price(x):\n    return x\n" }, "Base");
  repo.git("branch", "base", main);
  const { sql } = sqlite();
  features = new FeatureStore(sql);
  inbox = new InboxStore(sql, new IdentityStore(sql));
  store = new ProtectedChangeStore(sql);
  notified = [];
  delegates = new Map();
});

const sign = async (draft: Parameters<typeof signFeatureRecord>[0]): Promise<FeatureRecord> => signFeatureRecord(draft, (await key).privateKey);

async function open(id: string, person: string): Promise<void> {
  features.insert(id, person, { scopes: [], paths: [], contracts: [] }, await sign(features.draftRecord(id, "open_feature", { person }, {})));
  features.setRepo(id, `feature-${id}`);
}

/** Commits `files` on a branch of feature `id` that starts at `from`; returns the commit. */
function work(id: string, from: string, files: Record<string, string>, message = "work"): string {
  repo.git("checkout", "--quiet", "-B", `feature-${id}`, from);
  return repo.commit(files, message);
}

const checkpointDeps = (): CheckpointProtectionDeps => ({
  store,
  inbox,
  notify: (person) => notified.push(person),
  readOwnChange: (_repo, sha) => ownChange(gitReader(repo.dir), repo.reader(), sha),
  readDiffs: async (_repo, files) => (await fileDiffs(gitReader(repo.dir), files, () => null)).files,
});

const confirmDeps = (): ConfirmDeps => ({
  store,
  inbox,
  notify: (person) => notified.push(person),
  features,
  delegates: async () => delegates,
  sign,
});

async function checkpoint(id: string, sha: string): Promise<string[]> {
  const feature = features.get(id);
  assert.ok(feature);
  return checkProtectedChanges(checkpointDeps(), feature, sha, SCOPE_MAP);
}

const items = (person: string) => inbox.items(person).filter((item) => item.reason === "protected_path");

test("own change to another person's protected path asks that person once, with the lines, and the land waits until they confirm", async () => {
  await open("money-analytics", "ines");
  const sha = work("money-analytics", main, { [REPORT]: "def revenue(orders):\n    return {o.currency: o for o in orders}\n", "shared/money/api.py": "def price(x):\n    return x * 100\n" });
  assert.deepEqual(await checkpoint("money-analytics", sha), ["jun"]);
  assert.deepEqual(items("jun").map((item) => [item.issueId, item.read]), [["change:money-analytics", false]]);
  assert.deepEqual(items("ines"), [], "the feature's own person protects nothing it touches");
  assert.deepEqual(notified, ["jun"]);

  const [row] = store.ofFeature("money-analytics");
  assert.equal(row?.mergeBase, main);
  assert.equal(row?.state, "pending");
  assert.deepEqual(row?.files.map((file) => [file.path, file.protectedPath, file.scope]), [[REPORT, REPORT, "analytics"]], "only the protected file, not the money change");
  assert.ok(row?.files[0]?.hunks.flatMap((hunk) => hunk.lines).includes("+    return {o.currency: o for o in orders}"));
  assert.deepEqual(unconfirmedProtected(store, "money-analytics").map((each) => each.ownerId), ["jun"]);

  // The item lists for Jun with its lines, as the dashboard reads it.
  const [request] = protectedChangeRequests(store, features, inbox.items("jun"), ["jun"], "jun", delegates);
  assert.equal(request?.person, "ines");
  assert.equal(request?.state, "pending");
  assert.equal(request?.read, false);
  assert.ok(request?.files[0]?.lines?.includes("-    return sum(orders)"));

  // Only Jun, or Jun's delegate, confirms, and only the checkpoint the feature stands at.
  const input = { feature: "money-analytics", owner: "jun", checkpoint: sha };
  assert.equal((await confirmProtectedChange(confirmDeps(), "priya", input)).status, "rejected");
  const stale = await confirmProtectedChange(confirmDeps(), "jun", { ...input, checkpoint: main });
  assert.equal(stale.status === "rejected" && stale.reason, "conflict");
  const confirmed = await confirmProtectedChange(confirmDeps(), "jun", input);
  assert.equal(confirmed.status, "ok", JSON.stringify(confirmed));
  assert.deepEqual(unconfirmedProtected(store, "money-analytics"), []);
  const records = features.records("money-analytics").map((kept) => JSON.parse(kept.file) as FeatureRecord).filter((record) => record.type === "confirm_protected_change");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.author, { person: "jun" });
  assert.deepEqual(records[0]?.payload, { owner: "jun", confirmed_by: "jun", checkpoint: sha, merge_base: main, files: [{ path: REPORT, protected_path: REPORT }] });
  assert.equal((await confirmProtectedChange(confirmDeps(), "jun", input)).status, "rejected", "a second confirmation of the same lines is refused");
  // The item stays as a record of the confirmation, read.
  assert.deepEqual(items("jun").map((item) => item.read), [true]);
});

test("own change to the person's own protected path raises nothing", async () => {
  await open("jun-report", "jun");
  const sha = work("jun-report", main, { [REPORT]: "def revenue(orders):\n    return round(sum(orders), 2)\n" });
  assert.deepEqual(await checkpoint("jun-report", sha), []);
  assert.deepEqual(store.ofFeature("jun-report"), []);
  assert.deepEqual(items("jun"), []);
  assert.deepEqual(notified, []);
});

test("a change main brought in by a merge is not the feature's own", async () => {
  await open("checkout-cart", "priya");
  const own = work("checkout-cart", main, { "checkout/cart.py": "total = 0\n" });
  // Jun's change to the report reaches main; Priya's agent takes main into its fork.
  repo.git("checkout", "--quiet", "main");
  const moved = repo.commit({ [REPORT]: "def revenue(orders):\n    return sum(orders) or 0\n" }, "Jun's report");
  repo.git("checkout", "--quiet", "feature-checkout-cart");
  repo.git("merge", "--quiet", "--no-ff", "-m", "Take main", moved);
  const merged = repo.git("rev-parse", "HEAD");
  assert.notEqual(merged, own);
  const change = await ownChange(gitReader(repo.dir), repo.reader(), merged);
  assert.equal(change.mergeBase, moved, "the merge base is main's newest commit the checkpoint reaches");
  assert.deepEqual(change.files.map((file) => file.path), ["checkout/cart.py"]);
  assert.deepEqual(await checkpoint("checkout-cart", merged), []);
  assert.deepEqual(items("jun"), []);
});

test("the same lines stay confirmed, changed lines ask again, and a change that leaves the path withdraws the item", async () => {
  await open("money-analytics", "ines");
  const first = work("money-analytics", main, { [REPORT]: "def revenue(orders):\n    return 1\n" });
  await checkpoint("money-analytics", first);
  assert.equal((await confirmProtectedChange(confirmDeps(), "jun", { feature: "money-analytics", owner: "jun", checkpoint: first })).status, "ok");

  // A later checkpoint that leaves the report as Jun confirmed it keeps the confirmation.
  const same = repo.commit({ "shared/money/api.py": "def price(x):\n    return 2 * x\n" });
  notified.length = 0;
  assert.deepEqual(await checkpoint("money-analytics", same), []);
  assert.equal(store.get("money-analytics", "jun")?.state, "confirmed");
  assert.equal(store.get("money-analytics", "jun")?.checkpoint, same);
  assert.deepEqual(notified, []);

  // New lines in the report ask Jun again, unread.
  const changed = repo.commit({ [REPORT]: "def revenue(orders):\n    return 2\n" });
  assert.deepEqual(await checkpoint("money-analytics", changed), ["jun"]);
  assert.equal(store.get("money-analytics", "jun")?.state, "pending");
  assert.equal(store.get("money-analytics", "jun")?.confirmedBy, null);
  assert.deepEqual(items("jun").map((item) => item.read), [false]);

  // Reverting the report to main's content leaves Jun's path: the row and the item go.
  const reverted = repo.commit({ [REPORT]: "def revenue(orders):\n    return sum(orders)\n" });
  assert.deepEqual(await checkpoint("money-analytics", reverted), []);
  assert.deepEqual(store.ofFeature("money-analytics"), []);
  assert.deepEqual(items("jun"), []);
});

test("the protecting person's delegate confirms; the lines show only to the feature's person, the protector and the delegate", async () => {
  delegates.set("jun", "kofi");
  await open("money-analytics", "ines");
  const sha = work("money-analytics", main, { [REPORT]: "def revenue(orders):\n    return 3\n" });
  await checkpoint("money-analytics", sha);
  const row = store.get("money-analytics", "jun");
  assert.ok(row);
  const listed = (viewer: string): ProtectedChangeRequest | undefined => protectedChangeRequests(store, features, [], ["jun"], viewer, delegates)[0];
  assert.ok(listed("kofi")?.files[0]?.lines);
  assert.ok(listed("ines")?.files[0]?.lines);
  assert.equal(listed("priya")?.files[0]?.lines, null);
  assert.equal((await confirmProtectedChange(confirmDeps(), "kofi", { feature: "money-analytics", owner: "jun", checkpoint: sha })).status, "ok");
  assert.equal(store.get("money-analytics", "jun")?.confirmedBy, "kofi");
});

test("a plan part that writes a protected path still asks its protector through the part, and the inbox lists both kinds", async () => {
  const { sql } = sqlite();
  const routes = new PlanRouteStore(sql);
  await open("money-analytics", "ines");
  const sha = work("money-analytics", main, { [REPORT]: "def revenue(orders):\n    return 4\n" });
  await checkpoint("money-analytics", sha);
  const diff = { ref: "x", base: main, commit: null, patch: null, truncated: false, files: [{ path: REPORT, scopeId: "analytics", status: "modified" as const, hunks: [], omitted: null }] };
  const part = {
    partId: "money-minor/v1#1",
    revision: 1,
    place: { kind: "scope" as const, scope: "analytics" },
    owner: "jun",
    scopes: ["analytics"],
    kind: "behavioural" as const,
    kindReason: "",
    diff,
    callers: [],
    breaks: [],
    invariants: [],
    note: null,
    approvalState: "pending" as const,
    approvedBy: null,
    changeRequests: 0,
    changeRequest: null,
  };
  const plan = { planId: "money-minor/v1", featureId: "money-minor", version: 1, person: "ines", parts: [part] } as never;
  announcePlan({ routes, inbox, notify: () => undefined }, plan, SCOPE_MAP);
  assert.deepEqual(
    items("jun").map((item) => item.issueId).sort(),
    ["change:money-analytics", "part:money-minor/v1#1"],
    "the part's protected path is asked through the part, the feature's own change through the feature",
  );
  const answer = await buildPlanInbox(
    {
      routes,
      reviews: { list: () => [] } as never,
      keeper: () => ({ latestPlan: async () => undefined }) as never,
      items: (person) => inbox.items(person),
      scopeMap: async () => SCOPE_MAP,
      delegates: async () => delegates,
      roundLimit: 3,
      records: () => [],
      protectedChanges: (owners, listed, known) => protectedChangeRequests(store, features, listed, owners, "jun", known),
    },
    "jun",
  );
  assert.deepEqual(answer.protectedChanges.map((change) => [change.feature, change.owner, change.state]), [["money-analytics", "jun", "pending"]]);
  assert.deepEqual(checkPlanInbox(answer), []);
});
