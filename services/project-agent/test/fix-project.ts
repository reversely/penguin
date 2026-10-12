// Test support for writing approved fixes (#91): a repository where a money feature renames `price`
// to `price_minor`, billing calls it on main, and a running tax feature calls it in its own fork, a
// bare repository whose `main` is the base as fork() makes it. Sam's running feature works in reports,
// away from the plan's area. The ProjectAgent's plan, approval, fix-write and coverage stores run on
// node:sqlite, wired as the ProjectAgent wires them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  type ImpactReport,
  type ImpactUse,
  type PlanFactsReport,
} from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import type { FeatureRecord } from "../src/feature-store.ts";
import { FixGrantStore, queueRunnerWrite, type FixWriteDeps, type ForkReading } from "../src/fix-write.ts";
import { announcePlan, approvePlanPart, PlanRouteStore, type PartDecisionOutcome, type PlanApprovalDeps } from "../src/plan-approval.ts";
import { PlanCoverageStore } from "../src/plan-coverage.ts";
import { lineHunks, splitLines } from "../src/repo-diff.ts";
import { gitReader } from "./git-reader.ts";
import { GitRepo } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const scope = (id: string, owner: string, paths: string[]) => ({
  id,
  name: id,
  owner,
  paths,
  test_command: "true",
  depends_on: id === "money" ? [] : [{ scope: "money", kind: "imports" }],
});
export const SCOPES = {
  scopes: [
    { ...scope("money", "ines", ["shared/money/"]), contracts: ["shared/money/api.py::price"] },
    scope("tax", "rahul", ["tax/"]),
    scope("billing", "bea", ["billing/"]),
    scope("reports", "sam", ["reports/"]),
  ],
};
export const TAX_BEFORE = "from shared.money.api import price\ntotal = price(line)\n";
/** The codemod's rename: a mechanical fix. */
export const TAX_RENAMED = "from shared.money.api import price_minor\ntotal = price_minor(line)\n";
/** The rename plus rounding: a behavioural fix. */
export const TAX_FIXED = "from shared.money.api import price_minor\ntotal = round(price_minor(line))\n";
export const TAX = "money-minor/v1#2";
export const TAX_FORK = "feature-tax-rounding";
export const SESSIONS = { ines: "s-ines", inesOther: "s-ines-other", rahul: "s-rahul", sam: "s-sam" } as const;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A unified diff of one file, as `git diff` prints it. */
export function patch(path: string, before: string, after: string): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of lineHunks(splitLines(before), splitLines(after))) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
  }
  return `${lines.join("\n")}\n`;
}

const use = (path: string, scopeId: string): ImpactUse => ({ path, line: 2, kind: "call", symbol: "shared.money.api.price", name: "price", scope: scopeId });

function impactReport(base: string, head: string, taxHead: string): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base,
    head,
    changes: [
      {
        symbol: "shared.money.api.price",
        path: "shared/money/api.py",
        line: 1,
        kind: "function",
        change: "renamed",
        scope: "money",
        contract: "shared/money/api.py::price",
        to: { symbol: "shared.money.api.price_minor", path: "shared/money/api.py", line: 1 },
      },
    ],
    signatures: [],
    removedExports: [{ module: "shared.money.api", path: "shared/money/api.py", name: "price" }],
    dataShapes: [],
    contracts: ["shared/money/api.py::price"],
    headUses: [use("billing/old.py", "billing")],
    forks: [{ id: "tax-rounding", sha: taxHead, scopes: ["tax"], uses: [use("tax/rounding.py", "tax")], errors: [] }],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 3, head: 3, parsed: 3 },
  };
}

const PASSED = { status: "passed" as const, fingerprint: null, breaks: [], reason: null, durationMs: 5 };

export class FixProject {
  readonly repo = new GitRepo();
  readonly root = mkdtempSync(join(tmpdir(), "penguin-fix-write-"));
  /** The tax feature's fork. */
  readonly forkDir = join(this.root, "feature-tax-rounding.git");
  /** A working clone of the fork, where the tests make commits by hand. */
  readonly workDir = join(this.root, "work");
  readonly main: string;
  readonly checkpoint: string;
  readonly billingFix: string;
  scopeMap: ScopeMap = parseScopeMap(SCOPES);
  readonly project: PlanProject;
  readonly routes: PlanRouteStore;
  readonly grants: FixGrantStore;
  readonly coverage: PlanCoverageStore;
  now = Date.parse("2026-10-11T09:00:00Z");
  readonly notified: string[] = [];

  private constructor() {
    this.main = this.repo.commit(
      {
        "shared/money/api.py": "def price(item):\n    return item.amount\n",
        "tax/rounding.py": TAX_BEFORE,
        "billing/old.py": "from shared.money.api import price\nfee = price(invoice)\n",
        "reports/weekly.py": "rows = []\n",
      },
      "Base",
    );
    this.checkpoint = this.repo.commit({ "shared/money/api.py": "def price_minor(item):\n    return item.amount_minor\n" }, "Store money in minor units");
    this.billingFix = this.repo.commit({ "billing/old.py": "from shared.money.api import price_minor\nfee = price_minor(invoice)\n" }, "billing fix");
    git(this.root, "clone", "--quiet", "--bare", this.repo.dir, this.forkDir);
    git(this.forkDir, "update-ref", "refs/heads/main", this.main);
    git(this.root, "clone", "--quiet", this.forkDir, this.workDir);
    this.project = new PlanProject(this.scopeMap, this.repo.dir);
    this.routes = new PlanRouteStore(this.project.sql, () => this.now);
    this.grants = new FixGrantStore(this.project.sql, () => this.now);
    this.coverage = new PlanCoverageStore(this.project.sql, () => this.now);
    this.project.announce = (plan, map) => {
      announcePlan(this.approvalDeps(), plan, map);
      this.coverage.announce(plan, this.project.features.list(), map);
    };
  }

  /** The project with Ines's money feature at its checkpoint and the running tax and reports features. */
  static async create(): Promise<FixProject> {
    const fx = new FixProject();
    const { project, main } = fx;
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: SESSIONS.ines, handle: "@ines/money" });
    await project.checkpoint("money-minor", fx.checkpoint, main, "@ines/money");
    // A second agent of Ines on the same feature, which does not propose the plan.
    project.sessions.set(SESSIONS.inesOther, { person: "ines", handle: "@ines/other" });
    project.features.join("money-minor", SESSIONS.inesOther);
    await project.open("tax-rounding", "rahul", { scopes: ["tax"] }, { id: SESSIONS.rahul, handle: "@rahul/work" });
    await project.checkpoint("tax-rounding", main, main, "@rahul/work");
    await project.open("sam-reports", "sam", { scopes: ["reports"] }, { id: SESSIONS.sam, handle: "@sam/reports" });
    await project.checkpoint("sam-reports", main, main, "@sam/reports");
    return fx;
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  approvalDeps(): PlanApprovalDeps {
    return {
      features: this.project.features,
      routes: this.routes,
      inbox: this.project.inbox,
      keeper: () => this.project.plans,
      delegates: async () => new Map(),
      sign: (draft) => this.project.sign(draft),
      roundLimit: 3,
      notify: (person) => this.notified.push(person),
      approved: (featureId, plan, part) => queueRunnerWrite(this.grants, featureId, plan, part),
      now: () => this.now,
    };
  }

  /** The binding's reads: the tax fork is its own bare repository; every other repo reads the shared one. */
  readonly readFork: ForkReading = async (name, read) => {
    const dir = name === TAX_FORK ? this.forkDir : this.repo.dir;
    const reader = gitReader(dir);
    return read({
      ...reader,
      log: async ({ ref, limit }) =>
        git(dir, "log", "--format=%H", `-n${limit}`, ref)
          .split("\n")
          .filter(Boolean)
          .map((hash) => ({ hash })),
    });
  };

  fixDeps(): FixWriteDeps {
    return {
      features: this.project.features,
      routes: this.routes,
      grants: this.grants,
      keeper: () => this.project.plans,
      scopeMap: async () => this.scopeMap,
      readFork: this.readFork,
      sign: (draft) => this.project.sign(draft),
      notify: (person) => this.notified.push(person),
      now: () => this.now,
    };
  }

  readonly heartbeat = (caller: string, session: string) => this.project.heartbeat(caller, session);

  /** The revision deps of plan-approval.ts, reading every repo through `readFork`. */
  reviseDeps() {
    return { ...this.approvalDeps(), facts: this.project.facts, scopeMap: async () => this.scopeMap, readRepo: this.readFork, heartbeat: this.heartbeat };
  }

  async approve(part = TAX, revision = 1, person = "rahul"): Promise<PartDecisionOutcome> {
    const decided = await approvePlanPart(this.approvalDeps(), person, { feature: "money-minor", part, revision });
    assert.equal(decided.status, "ok", JSON.stringify(decided));
    return decided;
  }

  /** Stores the plan with the tax part's patch to `taxAfter`, after the runner's facts run. */
  async proposeWith(taxAfter: string): Promise<void> {
    const parts = [
      { place: { scope: "billing" }, diff: { commit: this.billingFix } },
      { place: { feature: "tax-rounding" }, patch: { base: this.main, diff: patch("tax/rounding.py", TAX_BEFORE, taxAfter) } },
    ];
    assert.equal((await this.project.propose("ines", SESSIONS.ines, "money-minor", parts)).status, "missing");
    const [request] = this.project.facts.pending();
    assert.ok(request);
    const facts: PlanFactsReport = {
      impact: impactReport(this.main, this.checkpoint, this.main),
      impactError: null,
      results: [
        { target: "main", scopeId: "billing", commandId: "test:billing", merged: this.main, ...PASSED },
        { target: "tax-rounding", scopeId: "tax", commandId: "test:tax", merged: this.main, ...PASSED },
      ],
      durationMs: 10,
    };
    assert.equal(this.project.facts.record(request.runId, "runner", JSON.parse(JSON.stringify(facts))).status, "recorded");
    const stored = await this.project.propose("ines", SESSIONS.ines, "money-minor", parts);
    assert.equal(stored.status, "stored", JSON.stringify(stored));
  }

  /** Commits `files` onto the tax fork's `parent` (deleting each null) with `message` and pushes it to the fork's main. */
  pushToFork(parent: string, files: Record<string, string | null>, message: string): string {
    const work = this.workDir;
    git(work, "fetch", "--quiet", this.forkDir, "main");
    git(work, "checkout", "--quiet", "--detach", parent);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git(work, "rm", "--quiet", path);
        continue;
      }
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
      git(work, "add", path);
    }
    git(work, "commit", "--quiet", "-m", message);
    const sha = git(work, "rev-parse", "HEAD");
    git(work, "push", "--quiet", this.forkDir, `${sha}:refs/heads/main`);
    return sha;
  }

  records(type: string): FeatureRecord[] {
    return this.project.records("money-minor", type);
  }
}
