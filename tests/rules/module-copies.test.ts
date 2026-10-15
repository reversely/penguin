// Penguin's copies of the originating change's modules in each affected fork (#179): every write
// refreshes them to the change's current revision, every part on a running feature gets them,
// a land waits until each affected fork holds them, and a fork that changed a copied module itself
// goes back to the originating agent with its lines.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { recordRoute, type Plan, type PlanPart } from "@penguin/protocol";
import { parseScopeMap, parseTeams } from "@penguin/scope-map";

import { partWrites } from "../../apps/dashboard/src/page-view.ts";
import { requestLand, type LandDeps } from "../../services/project-agent/src/block-land.ts";
import type { Feature, FeatureStore } from "../../services/project-agent/src/feature-store.ts";
import {
  claimRunnerWrites,
  copiesBehind,
  copyWriteKey,
  FixGrantStore,
  openCopyWrites,
  openFixWrite,
  runnerFixReport,
  type FixWriteDeps,
  type ForkReader,
} from "../../services/project-agent/src/fix-write.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { forkLinesKept, readCopy } from "../../services/project-agent/src/module-copy.ts";
import type { PlanKeeper } from "../../services/project-agent/src/plan-store.ts";
import { readFileText } from "../../services/project-agent/src/repo-diff.ts";

/** A Git repository in memory, read as the Artifacts binding reads one. Equal text has an equal hash in every repo. */
class MemoryRepo implements ForkReader {
  readonly #objects = new Map<string, { kind: "blob"; text: string } | { kind: "tree"; entries: { name: string; hash: string; type: string }[] } | { kind: "commit"; tree: string; parents: string[]; message: string }>();
  head: string | null = null;

  #put(kind: string, body: string, object: Parameters<Map<string, never>["set"]>[1]): string {
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

  /** A commit of `files` on `parents`; `main` moves to it unless `detached`. */
  commit(files: Readonly<Record<string, string>>, parents: string[] = this.head === null ? [] : [this.head], message = "change", detached = false): string {
    const tree = this.#tree(new Map(Object.entries(files)));
    const hash = this.#put("commit", `${tree}${parents.join(",")}${message}`, { kind: "commit", tree, parents, message } as never);
    if (!detached) this.head = hash;
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

const BASE_MONEY = "def cents(amount):\n    return amount\n";
const MONEY_1 = "def cents(amount):\n    return int(amount * 100)\n";
const MONEY_2 = "def cents(amount):\n    return round(amount * 100)\n";
const WEEKLY = "from shared.money import cents\n\n\ndef total(rows):\n    return sum(cents(row) for row in rows)\n";
/** The approved behavioural fix of Jun's caller, and the file it leaves. */
const WEEKLY_FIXED = "from shared.money import cents\n\n\ndef total(rows):\n    return sum(cents(row) for row in rows if row)\n";
const WEEKLY_PATCH = [
  "--- a/analytics/weekly.py",
  "+++ b/analytics/weekly.py",
  "@@ -5 +5 @@",
  "-    return sum(cents(row) for row in rows)",
  "+    return sum(cents(row) for row in rows if row)",
  "",
].join("\n");
/** The fork's own change to the module: a line the originating change does not have. */
const FORK_MONEY = "def cents(amount):\n    return amount\n\n\ndef dollars(value):\n    return value / 100\n";

const teams = parseTeams({ teams: [{ id: "data", name: "Data", lead: "priya", members: ["priya", "jun"] }] });
const scopeMap = parseScopeMap(
  {
    scopes: [
      { id: "analytics", name: "Analytics", team: "data", dri: "jun", fallback: ["priya"], paths: ["analytics/"], contracts: [], test_command: "true", depends_on: [] },
      { id: "shared", name: "Shared", team: "data", dri: "priya", fallback: ["jun"], paths: ["shared/"], contracts: [], test_command: "true", depends_on: [] },
    ],
  },
  { teams },
);

function memorySql(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[],
    transaction: (body) => body(),
  };
}

function part(fields: Partial<PlanPart> & Pick<PlanPart, "partId" | "kind" | "place" | "scopes">): PlanPart {
  return {
    revision: 1,
    owner: "jun",
    kindReason: "",
    diff: { source: "none", repo: "feature-weekly", ref: "feature-weekly@x+verify", commit: null, base: null, patch: null, files: [], truncated: false },
    callers: [],
    breaks: [],
    invariants: [],
    note: null,
    approvalState: "approved",
    approvedBy: "jun",
    changeRequests: 0,
    changeRequest: null,
    ...fields,
  } as PlanPart;
}

/**
 * Priya's feature `money` changes shared/money.py; Jun's running feature `weekly` imports it. The plan
 * has one approved part on Jun's fork of `kind`.
 */
function world(kind: PlanPart["kind"], forkMoney = BASE_MONEY) {
  const origin = new MemoryRepo();
  const baseline = origin.commit({ "shared/money.py": BASE_MONEY, "analytics/weekly.py": WEEKLY });
  const checkpoint = origin.commit({ "shared/money.py": MONEY_1, "analytics/weekly.py": WEEKLY });
  const fork = new MemoryRepo();
  fork.commit({ "shared/money.py": forkMoney, "analytics/weekly.py": WEEKLY });
  const repos: Record<string, MemoryRepo> = { "feature-money": origin, "feature-weekly": fork };
  const onFork = part({
    partId: "money/v1#weekly",
    kind,
    place: { kind: "feature", feature: "weekly" },
    scopes: ["analytics"],
    ...(kind === "behavioural"
      ? {
          diff: {
            source: "patch",
            repo: "feature-weekly",
            ref: "feature-weekly@x+patch:sha256:0",
            commit: null,
            base: fork.head,
            patch: WEEKLY_PATCH,
            files: [{ path: "analytics/weekly.py" }] as never,
            truncated: false,
          },
        }
      : {}),
  });
  let plan = {
    planId: "money/v1",
    featureId: "money",
    person: "priya",
    proposedBy: "priya-agent",
    facts: { change: { baseline, checkpoint } },
    parts: [onFork],
  } as unknown as Plan;
  const features = new Map<string, Feature>([
    ["money", { id: "money", personId: "priya", repo: "feature-money", state: "building", latestCheckpointSha: checkpoint } as Feature],
    ["weekly", { id: "weekly", personId: "jun", repo: "feature-weekly", state: "building", latestCheckpointSha: fork.head } as Feature],
  ]);
  // Main is still at the baseline the change was built on.
  const main = new MemoryRepo();
  main.commit({ "shared/money.py": BASE_MONEY, "analytics/weekly.py": WEEKLY });
  repos["base"] = main;
  const keeper = {
    latestPlan: async () => plan,
    replacePart: async (_feature: string, next: PlanPart) => {
      plan = { ...plan, parts: plan.parts.map((each) => (each.partId === next.partId ? next : each)) };
      return true;
    },
    keepFixWrite: async () => true,
  } as unknown as PlanKeeper;
  const grants = new FixGrantStore(memorySql());
  const deps: FixWriteDeps = {
    features: { get: (id: string) => features.get(id), draftRecord: (feature: string, type: string, author: unknown, payload: unknown) => ({ feature, type, author, payload }), addRecord: () => {} } as unknown as FeatureStore,
    routes: { set: () => {} } as unknown as FixWriteDeps["routes"],
    grants,
    keeper: () => keeper,
    scopeMap: async () => scopeMap,
    readFork: async (repo, use) => use(repos[repo] as MemoryRepo),
    sign: async (record) => ({ ...record, record_id: "rec-1", signature: "" }) as never,
    notify: () => {},
  };
  const land: LandDeps = {
    features: { get: (id: string) => features.get(id), featureOfSession: () => "money", list: () => [...features.values()] } as unknown as FeatureStore,
    heartbeat: () => ({ status: "ok", session: { handle: "priya-agent" } }) as never,
    charter: () => ({ handle: "priya-agent", person: "priya", scopes: [], paths: [] }),
    agent: () => ({ latestPlan: async () => plan, fixWrites: async () => [] }) as never,
    readRepo: async (repo, use) => use(repos[repo] as MemoryRepo),
    baseRepo: "base",
    branch: "main",
    queue: {} as never,
    copiesBehind: (current, targets) => copiesBehind(deps, current, targets),
    sign: async () => ({}) as never,
    notify: () => {},
  };
  return {
    origin,
    fork,
    grants,
    deps,
    land,
    plan: () => plan,
    /** The originating agent revises its change: a new commit for code on main, as part revision 2. */
    revise(text: string) {
      const commit = origin.commit({ "shared/money.py": text, "analytics/weekly.py": WEEKLY });
      const onMain = part({
        partId: "money/v1#shared",
        kind: "behavioural",
        revision: 2,
        owner: "priya",
        place: { kind: "scope", scope: "shared" },
        scopes: ["shared"],
        diff: { source: "commit", repo: "feature-money", ref: `feature-money@${commit}`, commit, base: checkpoint, patch: null, files: [], truncated: false },
      });
      plan = { ...plan, parts: [...plan.parts.filter((each) => each.partId !== onMain.partId), onMain] };
      return commit;
    },
  };
}

const RUNNER = { bridgeId: "runner-1", role: "runner" } as const;

/** The check runner writes a claimed spec into the memory fork and reports it, as runner-cli.ts does. */
async function runWrite(w: ReturnType<typeof world>, spec: Awaited<ReturnType<typeof claimRunnerWrites>> & { status: "ok" }) {
  const [write] = spec.writes;
  assert.ok(write !== undefined, "the runner claims a write");
  // Every write here copies shared/money.py, the one module the fork imports.
  assert.deepEqual(write.spec.copy?.paths, ["shared/money.py"]);
  const source = (await w.origin.readCommit(write.spec.copy!.source))!;
  const files = { "analytics/weekly.py": WEEKLY, "shared/money.py": (await readFileText(w.origin, source.treeHash, "shared/money.py"))! };
  const commit = w.fork.commit(files, [write.spec.parent], write.spec.message);
  return runnerFixReport(w.deps, RUNNER, write.spec.writeId, { commit });
}

test("the check runner writes an approved behavioural part with its copies; land_feature then answers no copy_not_written", async () => {
  const w = world("behavioural");
  const behavioural = w.plan().parts[0] as PlanPart;
  const kept: unknown[] = [];
  const keeper = w.deps.keeper("money") as unknown as { keepFixWrite: (write: unknown) => Promise<boolean> };
  keeper.keepFixWrite = async (write) => (kept.push(write), true);
  // Every check before the block run passes, so the land reaches it; the test stops there.
  const openBlockRun = async () => {
    throw new Error("block run opened");
  };
  const land: LandDeps = { ...w.land, agent: () => ({ latestPlan: async () => w.plan(), fixWrites: async () => kept, openBlockRun }) as never };
  // The approval opens one runner write that carries the copies, and no copy write beside it.
  openFixWrite(w.grants, "money", w.plan(), behavioural);
  openCopyWrites(w.grants, "money", w.plan(), behavioural);
  assert.equal(w.grants.get(behavioural.partId, 1)?.writer, "runner", "Penguin writes the fix, not an agent");
  assert.equal(w.grants.get(copyWriteKey(behavioural.partId, w.plan().facts.change.checkpoint), 1), undefined);

  const claimed = await claimRunnerWrites(w.deps, RUNNER);
  const [write] = claimed.status === "ok" ? claimed.writes : [];
  assert.ok(write !== undefined, "the runner claims the behavioural part's write");
  assert.equal(write.repo, "feature-weekly", "the token is minted on the named fork alone");
  assert.deepEqual(write.spec.paths, ["analytics/weekly.py"], "it writes only the approved part's paths");
  assert.equal(write.spec.writer, "runner");
  assert.deepEqual(write.spec.copy?.paths, ["shared/money.py"], "the module copy goes in the same write");
  const commit = w.fork.commit({ "analytics/weekly.py": WEEKLY_FIXED, "shared/money.py": MONEY_1 }, [write.spec.parent], write.spec.message);
  const other = await runnerFixReport(w.deps, { bridgeId: "runner-2", role: "runner" }, write.spec.writeId, { commit });
  assert.equal(other.status === "rejected" ? other.reason : other.status, "forbidden", "only the claiming runner reports");
  const reported = await runnerFixReport(w.deps, RUNNER, write.spec.writeId, { commit });
  assert.equal(reported.status, "ok", JSON.stringify(reported));
  assert.equal(w.grants.get(behavioural.partId, 1)?.state, "written", "report_fix_write is recorded");

  await assert.rejects(requestLand(land, "priya", "session-1", { feature: "money" }), /block run opened/u, "no copy_not_written: the land opens its block run");
});

test("every copy write refreshes a module Penguin copied at an earlier revision to the current one, byte for byte", async () => {
  const w = world("behavioural");
  const plan = w.plan();
  openCopyWrites(w.grants, "money", plan);
  const first = await claimRunnerWrites(w.deps, RUNNER);
  assert.equal(first.status, "ok");
  assert.deepEqual(first.status === "ok" ? first.writes[0]?.spec.copy?.paths : undefined, ["shared/money.py"]);
  assert.match(first.status === "ok" ? (first.writes[0]?.spec.message ?? "") : "", /copy the originating modules of merge plan part money\/v1#weekly/u);
  const reported = await runWrite(w, first as never);
  assert.equal(reported.status, "ok", JSON.stringify(reported));

  // The originating agent revises its change: the fork's copy is now an earlier revision's bytes.
  const revision = w.revise(MONEY_2);
  openCopyWrites(w.grants, "money", w.plan());
  const second = await claimRunnerWrites(w.deps, RUNNER);
  const spec = second.status === "ok" ? second.writes[0]?.spec : undefined;
  assert.equal(spec?.copy?.source, revision, "the copy comes from the newest revision");
  assert.deepEqual(spec?.copy?.paths, ["shared/money.py"]);
  assert.equal((await runWrite(w, second as never)).status, "ok");
  const tip = (await w.fork.readCommit(w.fork.head!))!;
  assert.equal(await readFileText(w.fork, tip.treeHash, "shared/money.py"), MONEY_2, "the fork holds the revision byte for byte");
});

test("a copy write of a revision the originating change has moved past is withdrawn", async () => {
  const w = world("behavioural");
  openCopyWrites(w.grants, "money", w.plan());
  const stale = w.grants.get(copyWriteKey("money/v1#weekly", w.plan().facts.change.checkpoint), 1)!;
  w.revise(MONEY_2);
  await claimRunnerWrites(w.deps, RUNNER);
  assert.equal(w.grants.byId(stale.id)?.state, "withdrawn");
});

test("a land waits until each affected fork holds the plan's current revision of the copied modules", async () => {
  const w = world("verify");
  const refused = await requestLand(w.land, "priya", "session-1", { feature: "money" });
  assert.equal(refused.status === "rejected" ? refused.reason : refused.status, "copy_not_written");
  const targets = [{ feature: "weekly", person: "jun", fork: "feature-weekly", sha: w.fork.head! }];
  const behind = await copiesBehind(w.deps, w.plan(), targets);
  assert.match(behind.join(";"), /feature weekly's fork does not yet hold shared\/money\.py/u);
  const opened = w.grants.get(copyWriteKey("money/v1#weekly", w.plan().facts.change.checkpoint), 1);
  assert.equal(opened?.state, "queued", "the land asks the copy write it waits for");
  w.fork.commit({ "shared/money.py": MONEY_1, "analytics/weekly.py": WEEKLY });
  assert.deepEqual(await copiesBehind(w.deps, w.plan(), [{ ...targets[0]!, sha: w.fork.head! }]), [], "the copy in place lets the land go on");
});

test("a fork that changed a copied module goes back to the originating agent with its lines, never left queued", async () => {
  const w = world("verify", FORK_MONEY);
  openFixWrite(w.grants, "money", w.plan(), w.plan().parts[0] as PlanPart);
  const claimed = await claimRunnerWrites(w.deps, RUNNER);
  assert.deepEqual(claimed.status === "ok" ? claimed.writes : undefined, [], "nothing is written over the fork's own change");
  assert.equal(w.grants.get("money/v1#weekly", 1)?.state, "withdrawn", "the write is not left queued");
  const returned = w.plan().parts[0] as PlanPart;
  assert.equal(returned.approvalState, "change_requested", "the part waits on the originating agent, which reads it in get_work");
  assert.equal(returned.changeRequest?.by, "penguin");
  assert.match(returned.changeRequest?.text ?? "", /changed shared\/money\.py itself/u);
  assert.match(returned.changeRequest?.text ?? "", /\+def dollars\(value\):/u, "the request quotes the fork's own lines");
});

test("a revision that holds the fork's own lines is copied over them", async () => {
  assert.equal(forkLinesKept(BASE_MONEY, FORK_MONEY, MONEY_1), false);
  const folded = `${MONEY_1}\n\ndef dollars(value):\n    return value / 100\n`;
  assert.equal(forkLinesKept(BASE_MONEY, FORK_MONEY, folded), true);
  const w = world("verify", FORK_MONEY);
  const revision = w.revise(folded);
  const read = await readCopy({
    origin: w.origin,
    checkpoint: revision,
    baseline: w.plan().facts.change.baseline,
    fork: w.fork,
    head: w.fork.head!,
    scopePaths: ["analytics/"],
    patch: [],
  });
  assert.equal(read.status, "ok");
  assert.deepEqual(read.status === "ok" ? read.copy?.paths : undefined, ["shared/money.py"]);
});

test("the feature page names the agent as a behavioural part's writer and Penguin's copy write beside it", () => {
  const source = "a".repeat(40);
  const record = (recordId: string, author: unknown, copiedFrom?: string) => ({
    recordId,
    type: "fix_write",
    author: "",
    createdAt: "",
    path: "",
    route: recordRoute({ type: "fix_write", author }),
    partId: "money/v1#weekly",
    ...(copiedFrom === undefined ? {} : { copiedFrom }),
  });
  // The agent writes its patch, then the check runner copies the originating modules into the same fork.
  const { writes, copies } = partWrites([record("r1", { identity: "@priya/money" }), record("r2", { penguin: true }, source)]);
  assert.deepEqual(writes.get("money/v1#weekly"), { route: "agent", actor: "@priya/money", tool: "report_fix_write" });
  assert.deepEqual(copies.get("money/v1#weekly"), [{ route: { route: "penguin", actor: "penguin", tool: null }, from: source }]);
});
