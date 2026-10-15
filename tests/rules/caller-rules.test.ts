// Rule fixes for broken callers (#209): the originating agent states a rewrite
// rule without reading the receiving fork, the receiving agent approves it, and Penguin's check runner
// rewrites the matching call sites with the copied modules in one write on that fork alone. A rule that
// rewrites nothing comes back to the originating agent. Under caller sudo (#222) Penguin approves the
// rule at once and the receiving agent's review is recorded after the write.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CALLER_REPLAY_COMMAND_ID, CALLER_REPLAY_SCHEMA_VERSION, CALLER_REPLAY_TOOL, callerApprovalLabel, callerItemView, checkFixWriteSpec, type CallerReplaySection, type CallerVerdict, type Plan, type PlanPart } from "@penguin/protocol";
import { parseScopeMap, parseTeams } from "@penguin/scope-map";

import {
  callerAction,
  callerForkGrant,
  CallerIndexStore,
  CallerItemStore,
  callerWork,
  landPending,
  ownerCallerItems,
  replayReported,
  ruleItems,
  rulesUnmatched,
  rulesWritten,
  writeWaits,
  type CallerActionDeps,
  type CallerCall,
} from "../../services/project-agent/src/caller-items.ts";
import { FeatureStore, signFeatureRecord } from "../../services/project-agent/src/feature-store.ts";
import { claimRunnerWrites, copiesBehind, FixGrantStore, openFixWrite, openRuleWrite, runnerFixReport, type FixWriteDeps, type ForkReader } from "../../services/project-agent/src/fix-write.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import type { PlanKeeper } from "../../services/project-agent/src/plan-store.ts";
import { readFileText } from "../../services/project-agent/src/repo-diff.ts";

/** A Git repository in memory, read as the Artifacts binding reads one. */
class MemoryRepo implements ForkReader {
  readonly #objects = new Map<string, { kind: "blob"; text: string } | { kind: "tree"; entries: { name: string; hash: string; type: string }[] } | { kind: "commit"; tree: string; parents: string[]; message: string }>();
  head: string | null = null;

  #put(kind: string, body: string, object: never): string {
    const hash = createHash("sha1").update(`${kind}\0${body}`).digest("hex");
    this.#objects.set(hash, object);
    return hash;
  }

  #tree(files: ReadonlyMap<string, string>): string {
    const here = new Map<string, Map<string, string>>();
    const entries: { name: string; hash: string; type: string }[] = [];
    for (const [path, text] of files) {
      const [name, ...rest] = path.split("/") as [string, ...string[]];
      if (rest.length === 0) {
        entries.push({ name, hash: this.#put("blob", text, { kind: "blob", text } as never), type: "blob" });
        continue;
      }
      if (!here.has(name)) here.set(name, new Map());
      here.get(name)?.set(rest.join("/"), text);
    }
    for (const [name, inner] of here) entries.push({ name, hash: this.#tree(inner), type: "tree" });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return this.#put("tree", JSON.stringify(entries), { kind: "tree", entries } as never);
  }

  commit(files: Readonly<Record<string, string>>, parents: string[] = this.head === null ? [] : [this.head], message = "change"): string {
    const tree = this.#tree(new Map(Object.entries(files)));
    const hash = this.#put("commit", `${tree}${parents.join(",")}${message}`, { kind: "commit", tree, parents, message } as never);
    this.head = hash;
    return hash;
  }

  async readCommit(hash: string) {
    const found = this.#objects.get(hash);
    return found?.kind === "commit" ? { hash, treeHash: found.tree, message: found.message, parents: found.parents } : null;
  }

  async readTree(hash: string) {
    const found = this.#objects.get(hash);
    return found?.kind === "tree" ? found.entries : null;
  }

  async readBlob(hash: string) {
    const found = this.#objects.get(hash);
    return found?.kind === "blob" ? new Blob([found.text]) : null;
  }

  async log() {
    return this.head === null ? [] : [{ hash: this.head }];
  }
}

function memorySql(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return { exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[], transaction: (body) => body() };
}

const SHOPPERS_0 = "class ShopperMap:\n    def resolve(self, event):\n        return event.shopper\n";
const SHOPPERS_1 = "class ShopperMap:\n    def counted_as(self, event):\n        return event.account\n";
const RETENTION = [
  "from accounts.shoppers import ShopperMap",
  "",
  "",
  "def active(events, shopper_map: ShopperMap):",
  "    days = {}",
  "    for event in events:",
  "        days[shopper_map.resolve(event)] = event.day",
  "    return days",
  "",
].join("\n");
/** What the rule writes at line 7, the one broken call site. */
const RETENTION_FIXED = RETENTION.replace("shopper_map.resolve(event)", "shopper_map.counted_as(event)");
const RULE = { pattern: "$counts[ShopperMap.resolve($map, $event)]", replacement: "$counts[$map.counted_as($event)]" };
const CONTRACT = "accounts/shoppers.py::ShopperMap";
const CALL = `call-${"1".repeat(20)}`;
const RUN = `replay-${"2".repeat(20)}`;
const SHA = (digit: string) => digit.repeat(40);
const RUNNER = { bridgeId: "runner-1", role: "runner" } as const;

const scopeMap = parseScopeMap(
  {
    scopes: [
      { id: "analytics", name: "Analytics", team: "data", dri: "jun", fallback: ["priya"], paths: ["analytics/"], contracts: [], test_command: "true", depends_on: [] },
      { id: "accounts", name: "Accounts", team: "data", dri: "priya", fallback: ["jun"], paths: ["accounts/"], contracts: [], test_command: "true", depends_on: [] },
    ],
  },
  { teams: parseTeams({ teams: [{ id: "data", name: "Data", lead: "priya", members: ["priya", "jun"] }] }) },
);

/** The one broken call site in Jun's cohort-ltv, as Priya's check replayed it. */
function brokenCaller(): CallerVerdict {
  return {
    feature: "cohort-ltv",
    contract: CONTRACT,
    path: "analytics/retention.py",
    line: 7,
    verdict: "broken",
    reason: "raised",
    runId: RUN,
    calls: 1,
    matched: 0,
    differing: [
      {
        callId: CALL,
        test: "analytics/tests/test_retention.py::test_dau_stable",
        symbol: "accounts.shoppers.ShopperMap.resolve",
        ordinal: 0,
        differs: ["outcome"],
        old: { status: "returned", args: null, value: "s1", error: null, effects: [], effectCount: 0, approximate: false },
        new: { status: "raised", args: null, value: null, error: { type: "AttributeError", message: "no resolve" }, effects: [], effectCount: 0, approximate: false },
      },
    ],
    differingCount: 1,
    tests: ["analytics/tests/test_retention.py::test_dau_stable"],
  };
}

/**
 * Priya's `accounts-merge` replaces ShopperMap.resolve with counted_as; Jun's running `cohort-ltv` calls
 * resolve in analytics/retention.py, which Priya's agent cannot read. The plan has one approved verify
 * part on cohort-ltv, whose copy write waits on the broken item.
 */
async function world(sudo = false) {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const sql = memorySql();
  const features = new FeatureStore(sql, () => Date.parse("2026-10-14T09:00:00Z"));
  const sign = (draft: Parameters<typeof signFeatureRecord>[0]) => signFeatureRecord(draft, keys.privateKey);
  const people: Record<string, string> = { "accounts-merge": "priya", "cohort-ltv": "jun" };
  for (const [id, person] of Object.entries(people)) {
    features.insert(id, person, { scopes: [], paths: [], contracts: [] }, await sign(features.draftRecord(id, "open_feature", { person }, {})));
    features.setRepo(id, `feature-${id}`);
    features.join(id, `session-${id}`);
  }
  const origin = new MemoryRepo();
  const baseline = origin.commit({ "accounts/shoppers.py": SHOPPERS_0, "analytics/retention.py": RETENTION });
  const checkpoint = origin.commit({ "accounts/shoppers.py": SHOPPERS_1, "analytics/retention.py": RETENTION });
  const fork = new MemoryRepo();
  fork.commit({ "accounts/shoppers.py": SHOPPERS_0, "analytics/retention.py": RETENTION, "analytics/other.py": "x = 1\n" });
  const repos: Record<string, MemoryRepo> = { "feature-accounts-merge": origin, "feature-cohort-ltv": fork };
  const verify = {
    partId: "accounts-merge/v1#cohort-ltv",
    revision: 1,
    kind: "verify",
    owner: "jun",
    place: { kind: "feature", feature: "cohort-ltv" },
    scopes: ["analytics"],
    diff: { source: "none", repo: "feature-cohort-ltv", ref: "verify", commit: null, base: null, patch: null, files: [], truncated: false },
    approvalState: "approved",
    approvedBy: "jun",
  } as unknown as PlanPart;
  const plan = { planId: "accounts-merge/v1", featureId: "accounts-merge", person: "priya", proposedBy: "@priya/accounts-merge", facts: { change: { baseline, checkpoint } }, parts: [verify] } as unknown as Plan;
  const items = new CallerItemStore(sql);
  const grants = new FixGrantStore(memorySql());
  const callerDeps: CallerActionDeps = {
    features,
    keeper: () => items,
    index: new CallerIndexStore(sql),
    sign,
    stage: async () => "central_development",
    notify: () => {},
    heartbeat: (caller, sessionId) =>
      people[sessionId.slice("session-".length)] === caller ? ({ status: "ok", session: { id: sessionId, handle: `@${caller}/${sessionId.slice(8)}` } } as never) : { status: "rejected", reason: "forbidden", message: "not yours" },
    plan: async () => plan,
    testStanding: async (_item, tests) => new Map(tests.map((each) => [each, "main" as const])),
    ruleApproved: async (item) => void openRuleWrite(grants, plan, item.feature),
    callerSudo: () => sudo,
  };
  const deps: FixWriteDeps = {
    features,
    routes: { set: () => {} } as unknown as FixWriteDeps["routes"],
    grants,
    keeper: () => ({ latestPlan: async () => plan, keepFixWrite: async () => assert.fail("a rule write keeps no plan part's write") }) as unknown as PlanKeeper,
    scopeMap: async () => scopeMap,
    readFork: async (repo, use) => use(repos[repo] as MemoryRepo),
    sign,
    notify: () => {},
    callerWaits: (originId, targetId) => writeWaits(callerDeps, originId, targetId),
    ruleItems: (originId, targetId) => ruleItems(callerDeps, originId, targetId),
    rulesWritten: async (originId, ids, rewritten, commit) => void (await rulesWritten(callerDeps, originId, ids, rewritten, commit)),
    rulesUnmatched: async (originId, ids) => void (await rulesUnmatched(callerDeps, originId, ids)),
  };
  const section: CallerReplaySection = {
    schemaVersion: CALLER_REPLAY_SCHEMA_VERSION,
    tool: CALLER_REPLAY_TOOL,
    commandId: CALLER_REPLAY_COMMAND_ID,
    runs: [
      {
        runId: RUN,
        feature: "cohort-ltv",
        origin: checkpoint,
        forkCommit: fork.head as string,
        mergedCommit: SHA("c"),
        scopes: ["test:analytics"],
        symbols: ["accounts.shoppers.ShopperMap.resolve"],
        unresolved: [],
        tests: { old: { passed: 1, failed: 0, errors: 0 }, new: { passed: 0, failed: 1, errors: 0 } },
        recorded: { old: 1, new: 1 },
        error: null,
        durationMs: 5,
      },
    ],
    callers: [brokenCaller()],
    trimmed: false,
  };
  await replayReported(callerDeps, "accounts-merge", section, { kind: "check", id: "1", checkpoint });
  const as = (feature: string) => (call: CallerCall) => callerAction(callerDeps, people[feature] as string, `session-${feature}`, call);
  return { origin, fork, grants, deps, callerDeps, plan, features, priya: as("accounts-merge"), jun: as("cohort-ltv"), item: () => items.callerItems("accounts-merge")[0]!, items: () => items.callerItems("accounts-merge") };
}

/** Priya states the rule and Jun approves it, citing the replayed call. */
async function approveRule(w: Awaited<ReturnType<typeof world>>) {
  const item = w.item().itemId;
  const proposed = await w.priya({ action: "propose_fix", item, rule: RULE, note: "count by the cutover" });
  assert.equal(proposed.status, "ok", JSON.stringify(proposed));
  const approved = await w.jun({ action: "review", item, verdict: "approve", calls: [{ call: CALL, verdict: "approve", evidence: CALL }] });
  assert.equal(approved.status, "ok", JSON.stringify(approved));
}

const claimed = (outcome: Awaited<ReturnType<typeof claimRunnerWrites>>) => (outcome.status === "ok" ? outcome.writes : []);
const statusOf = (outcome: { status: string; reason?: string }) => (outcome.status === "rejected" ? outcome.reason : outcome.status);

test("a broken caller is settled by the originating agent's rule: one runner write rewrites the call site with the copy, and the land waits no more", async () => {
  const w = await world();
  assert.equal(w.item().state, "broken");
  // The verify part's write, which only copies, was opened at its approval and waits on the broken item.
  openFixWrite(w.grants, "accounts-merge", w.plan, w.plan.parts[0]!);
  const copy = w.grants.get(w.plan.parts[0]!.partId, 1)!;
  assert.equal(copy.state, "queued");
  assert.deepEqual(claimed(await claimRunnerWrites(w.deps, RUNNER)), [], "no write goes into the fork while its caller is broken");
  const item = w.item().itemId;
  const mixed = await w.priya({ action: "propose_fix", item, part: "accounts-merge/v1#cohort-ltv", revision: 1, rule: RULE });
  assert.equal(statusOf(mixed), "invalid", "a part or a rule, not both");
  const unbound = await w.priya({ action: "propose_fix", item, rule: { pattern: RULE.pattern, replacement: "$total" } });
  assert.equal(statusOf(unbound), "invalid", "a rule is checked as a plan's rewrite rule");
  const outside = await w.priya({ action: "propose_fix", item, rule: { pattern: "daily_active_users($events, $map)", replacement: "daily_active_users($events)" } });
  assert.equal(statusOf(outside), "invalid", "a rule outside the item's contract is refused at once");
  assert.match(JSON.stringify(outside), /propose a plan part with a patch for cohort-ltv/u, "the refusal names the next step");
  const byReceiver = await w.jun({ action: "propose_fix", item, rule: RULE });
  assert.equal(statusOf(byReceiver), "forbidden", "only the originating agent states the rule");

  await approveRule(w);
  assert.equal(w.item().state, "fix_approved");
  assert.equal(w.grants.byId(copy.id)?.state, "withdrawn", "the rule write carries the copy, so the fork gets one write");

  const writes = claimed(await claimRunnerWrites(w.deps, RUNNER));
  assert.equal(writes.length, 1, "one runner write into the fork");
  const [write] = writes;
  assert.equal(write!.repo, "feature-cohort-ltv", "the token is minted on the named fork alone");
  assert.deepEqual(checkFixWriteSpec(write!.spec), [], "the runner reads the spec as a fix write");
  assert.equal(write!.spec.patch, "", "the originating agent wrote no patch");
  assert.deepEqual(write!.spec.rewrite?.paths, ["analytics/retention.py"], "the rule may change only the broken call site's file");
  assert.deepEqual(
    write!.spec.rewrite?.rules.map((rule) => [rule.contract, rule.pattern, rule.replacement]),
    [[CONTRACT, RULE.pattern, RULE.replacement]],
  );
  assert.equal(write!.spec.rewrite?.source, w.plan.facts.change.checkpoint);
  assert.deepEqual(write!.spec.copy?.paths, ["accounts/shoppers.py"], "the module copy goes in the same write");

  // The runner's commit may change only the call sites' files and the copies.
  const copied = (await readFileText(w.origin, (await w.origin.readCommit(write!.spec.copy!.source))!.treeHash, "accounts/shoppers.py"))!;
  const stray = w.fork.commit({ "accounts/shoppers.py": copied, "analytics/retention.py": RETENTION_FIXED, "analytics/other.py": "x = 2\n" }, [write!.spec.parent], write!.spec.message);
  const refused = await runnerFixReport(w.deps, RUNNER, write!.spec.writeId, { commit: stray });
  assert.equal(statusOf(refused as never), "invalid");
  assert.match(refused.status === "rejected" ? refused.message : "", /analytics\/other\.py, outside the approved part/u);

  const commit = w.fork.commit({ "accounts/shoppers.py": copied, "analytics/retention.py": RETENTION_FIXED, "analytics/other.py": "x = 1\n" }, [write!.spec.parent], write!.spec.message);
  const kept = await runnerFixReport(w.deps, RUNNER, write!.spec.writeId, { commit });
  assert.equal(kept.status, "ok", JSON.stringify(kept));
  const settled = w.item();
  assert.equal(settled.state, "written");
  assert.deepEqual(settled.fix?.rewritten, [{ path: "analytics/retention.py", lines: [7] }], "the item shows the site the rule rewrote");
  assert.deepEqual(await landPending(w.callerDeps, "accounts-merge"), [], "the originating feature may land");
  assert.deepEqual(await copiesBehind(w.deps, w.plan, [{ feature: "cohort-ltv", sha: commit }]), [], "the land goes past copy_not_written");
});

test("a rule that rewrites nothing is refused: no write, and the item goes back to the originating agent", async () => {
  const w = await world();
  await approveRule(w);
  const [write] = claimed(await claimRunnerWrites(w.deps, RUNNER));
  const head = w.fork.head;
  const other = await runnerFixReport(w.deps, { bridgeId: "runner-2", role: "runner" }, write!.spec.writeId, { unmatched: "no call matched" });
  assert.equal(statusOf(other as never), "forbidden", "only the claiming runner reports");
  const unmatched = await runnerFixReport(w.deps, RUNNER, write!.spec.writeId, { unmatched: "no call matched" });
  assert.equal(unmatched.status, "unmatched", JSON.stringify(unmatched));
  assert.equal(w.fork.head, head, "nothing was written");
  assert.equal(w.grants.byId(write!.spec.writeId)?.state, "withdrawn");
  const back = w.item();
  assert.equal(back.state, "broken");
  assert.deepEqual(back.refusals?.map((refusal) => refusal.code), ["rule_matches_nothing"]);
  // The agent states another rule, its next revision.
  const again = await w.priya({ action: "propose_fix", item: back.itemId, rule: { ...RULE, replacement: "$counts[$map.resolve($event)]" } });
  assert.equal(again.status === "ok" ? again.item.fix?.revision : again.status, 2);
});


/** The runner writes the one claimed rule write into Jun's fork with the copy, as the first test does. */
async function runnerWrites(w: Awaited<ReturnType<typeof world>>) {
  const [write] = claimed(await claimRunnerWrites(w.deps, RUNNER));
  assert.ok(write !== undefined, "the runner claims the rule write");
  const copied = (await readFileText(w.origin, (await w.origin.readCommit(write.spec.copy!.source))!.treeHash, "accounts/shoppers.py"))!;
  const commit = w.fork.commit({ "accounts/shoppers.py": copied, "analytics/retention.py": RETENTION_FIXED, "analytics/other.py": "x = 1\n" }, [write.spec.parent], write.spec.message);
  const kept = await runnerFixReport(w.deps, RUNNER, write.spec.writeId, { commit });
  assert.equal(kept.status, "ok", JSON.stringify(kept));
}

const view = (item: Parameters<typeof callerItemView>[0]) => callerItemView(item, { origin: "priya", feature: "jun" });
const JUN_REVIEW = { calls: [{ call: CALL, verdict: "approve", evidence: CALL }] } as const;

test("caller sudo: Penguin approves the rule at once, the runner writes it before Jun reviews, then Jun's approval shows on the card", async () => {
  const w = await world(true);
  const item = w.item().itemId;
  const proposed = await w.priya({ action: "propose_fix", item, rule: RULE });
  assert.equal(proposed.status, "ok", JSON.stringify(proposed));
  assert.equal(proposed.status === "ok" ? proposed.recordIds.length : 0, 2, "the proposal and Penguin's approval");
  assert.equal(w.item().state, "fix_approved");
  const [approval] = w.features.records("accounts-merge").slice(-1).map((stored) => JSON.parse(stored.file));
  assert.deepEqual([approval.type, approval.author, approval.payload.action, approval.payload.reason], ["caller_item", { penguin: true }, "sudo_approve", "caller_sudo"], "signed as Penguin with reason caller_sudo");

  // Jun is told and Jun's agent gets review_caller as its turn; nothing waits on either.
  const told = await ownerCallerItems(w.callerDeps, "jun", new Map());
  assert.deepEqual(told.map((each) => [each.itemId, each.ask]), [[item, "told"]]);
  const juns = await callerWork(w.callerDeps, "jun", "session-cohort-ltv");
  assert.deepEqual(juns?.receiving.map((each) => each.yourTurn), [{ tools: ["review_caller"] }]);
  assert.equal(juns?.receiving[0]?.waitingOn, "nobody");

  await runnerWrites(w);
  assert.equal(w.item().state, "written");
  assert.deepEqual(await landPending(w.callerDeps, "accounts-merge"), [], "the land waits on no review");
  assert.equal(callerApprovalLabel(view(w.item())), "Approved by Penguin (caller sudo)");

  const reviewed = await w.jun({ action: "review", item, verdict: "approve", ...JUN_REVIEW });
  assert.equal(reviewed.status, "ok", JSON.stringify(reviewed));
  assert.equal(w.item().state, "written", "the review leaves the written fix where it stands");
  assert.equal(callerApprovalLabel(view(w.item())), "Approved by @jun/cohort-ltv");
  const again = await w.jun({ action: "review", item, verdict: "approve", ...JUN_REVIEW });
  assert.equal(statusOf(again), "conflict", "one review per approval");
});

test("caller sudo: Jun's request for changes opens a follow-up item for Priya and keeps the written fix", async () => {
  const w = await world(true);
  const item = w.item().itemId;
  await w.priya({ action: "propose_fix", item, rule: RULE });
  await runnerWrites(w);
  const asked = await w.jun({ action: "review", item, verdict: "request_changes", text: "count by account id", calls: [{ call: CALL, verdict: "request_changes", evidence: CALL }] });
  assert.equal(asked.status, "ok", JSON.stringify(asked));
  const [original, followUp] = [w.items().find((each) => each.itemId === item)!, w.items().find((each) => each.itemId !== item)!];
  assert.equal(original.state, "written", "the written fix stands");
  assert.equal(original.review?.verdict, "request_changes");
  assert.equal(callerApprovalLabel(view(original)), "Approved by Penguin (caller sudo)");
  assert.deepEqual([followUp.state, followUp.followUp, followUp.feature, followUp.contract, followUp.review?.text], ["fix_rejected", item, "cohort-ltv", CONTRACT, "count by account id"]);
  const priyas = await callerWork(w.callerDeps, "priya", "session-accounts-merge");
  assert.deepEqual(priyas?.originating.find((each) => each.item === followUp.itemId)?.yourTurn, { tools: ["propose_caller_fix"] });
});

test("caller sudo: the originating agent gets a read grant on that item's fork alone; Jun's agent and sudo off get none", async () => {
  const on = await world(true);
  const item = on.item().itemId;
  const grant = await callerForkGrant(on.callerDeps, "priya", "session-accounts-merge", item);
  assert.deepEqual(grant, { status: "ok", featureId: "cohort-ltv", repo: "feature-cohort-ltv" });
  assert.equal(statusOf(await callerForkGrant(on.callerDeps, "jun", "session-cohort-ltv", item)), "forbidden", "only the originating feature's agent");
  assert.equal(statusOf(await callerForkGrant(on.callerDeps, "priya", "session-accounts-merge", `caller-${"0".repeat(16)}`)), "not_found");
  assert.equal(statusOf(await callerForkGrant(on.callerDeps, "priya", "session-accounts-merge", "../feature-main")), "invalid");

  const off = await world(false);
  assert.equal(statusOf(await callerForkGrant(off.callerDeps, "priya", "session-accounts-merge", off.item().itemId)), "forbidden");
  const proposed = await off.priya({ action: "propose_fix", item: off.item().itemId, rule: RULE });
  assert.equal(proposed.status === "ok" ? proposed.item.state : proposed.status, "fix_proposed", "with sudo off the fix waits on Jun's agent");
  assert.equal(callerApprovalLabel(view(off.item())), null);
});
