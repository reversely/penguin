import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ArtifactsNamespace,
  artifactsErrorCode,
  type CreatedRepo,
  forkFeatureRepo,
  forkHuddleRepo,
  InvalidRepoNameError,
  parseFeatureForkOptions,
  isValidRepoName,
  parseSetupRequest,
  type RepoHandle,
  RepoNames,
  setUpProject,
} from "../src/repos.ts";
import { parseFeatureTokenTtl } from "../src/tokens.ts";

// The fixture's base commit SHA from examples/identity-unification/build.py.
const BASE_COMMIT = { hash: "6a3601267ba92c70f137ce401ee53dedf1cbec05" }; // pragma: allowlist secret

class ArtifactsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface FakeRepo {
  commits: { hash: string }[];
  forkedFrom?: string;
  imported?: string;
}

/** An in-memory Artifacts namespace that records every call. */
class FakeArtifacts implements ArtifactsNamespace {
  readonly repos = new Map<string, FakeRepo>();
  readonly calls: string[] = [];
  readonly notReady = new Map<string, string>();
  disposed = 0;

  private made(name: string, repo: FakeRepo): CreatedRepo {
    if (this.repos.has(name)) throw new ArtifactsError("ALREADY_EXISTS", `repo already exists: ${name}`);
    this.repos.set(name, repo);
    return { name, remote: `https://acct.artifacts.cloudflare.net/git/penguin/${name}.git` };
  }

  async create(name: string): Promise<CreatedRepo> {
    this.calls.push(`create ${name}`);
    return this.made(name, { commits: [] });
  }

  async import(params: { source: { url: string }; target: { name: string } }): Promise<CreatedRepo> {
    this.calls.push(`import ${params.target.name}`);
    return this.made(params.target.name, { commits: [BASE_COMMIT], imported: params.source.url });
  }

  async list(opts?: { limit?: number; cursor?: string }) {
    this.calls.push("list");
    // Two-item pages exercise the cursor loop.
    const names = [...this.repos.keys()];
    const start = Number(opts?.cursor ?? 0);
    const end = start + 2;
    return {
      repos: names.slice(start, end).map((name) => ({ name })),
      ...(end < names.length ? { cursor: String(end) } : {}),
    };
  }

  async get(name: string): Promise<RepoHandle> {
    this.calls.push(`get ${name}`);
    const notReady = this.notReady.get(name);
    if (notReady) throw new ArtifactsError(notReady, `repo is not ready: ${name}`);
    const repo = this.repos.get(name);
    if (!repo) throw new ArtifactsError("NOT_FOUND", `Repository not found: ${name}.`);
    return {
      log: async () => {
        this.calls.push(`log ${name}`);
        return repo.commits.slice(0, 1);
      },
      fork: async (forkName) => {
        this.calls.push(`fork ${name} ${forkName}`);
        return this.made(forkName, { commits: [...repo.commits], forkedFrom: name });
      },
      [Symbol.dispose]: () => {
        this.disposed += 1;
      },
    };
  }
}

const OWNERS = { owners: ["priya", "jun", "sam"] };
const names = new RepoNames();

function statuses(report: Awaited<ReturnType<typeof setUpProject>>): Record<string, string> {
  return Object.fromEntries(report.repos.map((repo) => [repo.name, repo.status]));
}

test("the repo-name rule follows the Artifacts limits page", () => {
  for (const name of ["priya", "Jun2", "0sam", "a.b_c-d"]) assert.ok(isValidRepoName(name), name);
  for (const name of ["", "-jun", ".sam", "_x", "pri ya", "s/am", "jün", "a:b"]) {
    assert.ok(!isValidRepoName(name), name);
  }
});

test("parseSetupRequest rejects owner ids that fail the repo-name rule", () => {
  const parsed = parseSetupRequest({ owners: ["priya", "-jun", "s/am", 7, "priya"] });
  assert.equal(parsed.ok, false);
  assert.deepEqual(
    !parsed.ok && parsed.issues.map((issue) => issue.field),
    ["owners[1]", "owners[2]", "owners[3]", "owners[4]"],
  );
});

test("parseSetupRequest requires a non-empty owner list and an HTTPS source", () => {
  assert.equal(parseSetupRequest({ owners: [] }).ok, false);
  assert.equal(parseSetupRequest([]).ok, false);
  assert.equal(parseSetupRequest({ ...OWNERS, source: { url: "http://example.com/r.git" } }).ok, false);
  assert.equal(parseSetupRequest({ ...OWNERS, source: { url: "file:///tmp/r" } }).ok, false);
  assert.equal(parseSetupRequest({ ...OWNERS, source: { url: "https://x/r.git", branch: "" } }).ok, false);
  assert.deepEqual(parseSetupRequest({ ...OWNERS, source: { url: "https://github.com/o/r", branch: "main" } }), {
    ok: true,
    request: { ...OWNERS, source: { url: "https://github.com/o/r", branch: "main" } },
  });
});

test("RepoNames applies the prefix and rejects an invalid one", () => {
  const prefixed = new RepoNames("test-14-");
  assert.deepEqual(
    [prefixed.base, prefixed.issues, prefixed.owner("jun"), prefixed.huddle("031")],
    ["test-14-base", "test-14-issues", "test-14-owner-jun", "test-14-huddle-031"],
  );
  assert.throws(() => new RepoNames("-bad"), InvalidRepoNameError);
});

test("setup with an import source makes N + 2 repos for N owners", async () => {
  const artifacts = new FakeArtifacts();
  const request = { ...OWNERS, source: { url: "https://github.com/o/fixture" } };
  const report = await setUpProject(artifacts, request, names);

  assert.equal(report.complete, true);
  assert.equal(report.created, 5);
  assert.deepEqual(statuses(report), {
    base: "imported",
    issues: "created",
    "owner-priya": "created",
    "owner-jun": "created",
    "owner-sam": "created",
  });
  assert.equal(artifacts.repos.get("base")?.imported, "https://github.com/o/fixture");
  assert.equal(artifacts.repos.get("owner-jun")?.forkedFrom, "base");
  assert.deepEqual(artifacts.calls.filter((call) => call.startsWith("get")), ["get base"]);
  assert.equal(artifacts.disposed, 1);
  assert.deepEqual(report.artifactsOperations, {
    total: 8,
    byMethod: { list: 1, import: 1, create: 1, get: 1, log: 1, fork: 3 },
  });
  assert.ok(report.repos.every((repo) => !("token" in repo)));
});

test("running setup a second time creates no repo and reports the existing ones", async () => {
  const artifacts = new FakeArtifacts();
  const request = { ...OWNERS, source: { url: "https://github.com/o/fixture" } };
  await setUpProject(artifacts, request, names);
  artifacts.calls.length = 0;

  const report = await setUpProject(artifacts, request, names);
  assert.equal(report.created, 0);
  assert.equal(report.complete, true);
  assert.ok(report.repos.every((repo) => repo.status === "existing"));
  // Five repos over two-item pages: three list calls and nothing else.
  assert.deepEqual(artifacts.calls, ["list", "list", "list"]);
});

test("without a source, owner forks wait for the base commit and a later run makes them", async () => {
  const artifacts = new FakeArtifacts();
  const first = await setUpProject(artifacts, OWNERS, names);
  assert.equal(first.complete, false);
  assert.deepEqual(statuses(first), {
    base: "created",
    issues: "created",
    "owner-priya": "pending",
    "owner-jun": "pending",
    "owner-sam": "pending",
  });
  assert.match(first.repos[2]?.reason ?? "", /no commits/);
  assert.ok(!artifacts.calls.some((call) => call.startsWith("get")));

  // Still empty on the second run: the base is opened, found empty and left alone.
  const second = await setUpProject(artifacts, OWNERS, names);
  assert.equal(second.created, 0);
  assert.equal(second.repos[2]?.status, "pending");

  artifacts.repos.get("base")?.commits.push(BASE_COMMIT); // the deployer pushes the fixture
  const third = await setUpProject(artifacts, OWNERS, names);
  assert.equal(third.complete, true);
  assert.equal(third.created, 3);
  assert.equal(statuses(third).base, "existing");
});

test("owner forks stay pending while the base repo is importing", async () => {
  const artifacts = new FakeArtifacts();
  artifacts.notReady.set("base", "IMPORT_IN_PROGRESS");
  const report = await setUpProject(
    artifacts,
    { ...OWNERS, source: { url: "https://github.com/o/fixture" } },
    names,
  );
  assert.equal(report.complete, false);
  assert.match(report.repos[2]?.reason ?? "", /IMPORT_IN_PROGRESS/);
});

test("setup keeps the request order and adds only the missing owner forks", async () => {
  const artifacts = new FakeArtifacts();
  await setUpProject(artifacts, { owners: ["jun"], source: { url: "https://x/r" } }, names);
  const report = await setUpProject(artifacts, { owners: ["priya", "jun", "sam"] }, names);
  assert.deepEqual(
    report.repos.slice(2).map((repo) => [repo.name, repo.status]),
    [
      ["owner-priya", "created"],
      ["owner-jun", "existing"],
      ["owner-sam", "created"],
    ],
  );
});

test("a repo made by a concurrent run is reported as existing", async () => {
  const artifacts = new FakeArtifacts();
  const list = artifacts.list.bind(artifacts);
  // list() sees an empty namespace, but `issues` appears before setup creates it.
  artifacts.list = async (opts) => {
    const page = await list(opts);
    artifacts.repos.set("issues", { commits: [] });
    return page;
  };
  const report = await setUpProject(artifacts, OWNERS, names);
  assert.equal(statuses(report).issues, "existing");
});

test("an unexpected Artifacts error propagates", async () => {
  const artifacts = new FakeArtifacts();
  artifacts.create = async () => {
    throw new ArtifactsError("INTERNAL_ERROR", "boom");
  };
  await assert.rejects(setUpProject(artifacts, OWNERS, names), /boom/);
});

test("forkHuddleRepo forks huddle-<id> from the base repo with the base commit", async () => {
  const artifacts = new FakeArtifacts();
  await setUpProject(artifacts, { ...OWNERS, source: { url: "https://x/r" } }, names);

  const report = await forkHuddleRepo(artifacts, "031", names);
  assert.equal(report.name, "huddle-031");
  assert.equal(report.status, "created");
  const huddle = artifacts.repos.get("huddle-031");
  assert.equal(huddle?.forkedFrom, "base");
  assert.deepEqual(huddle?.commits, [BASE_COMMIT]);

  assert.equal((await forkHuddleRepo(artifacts, "031", names)).status, "existing");
});

test("forkHuddleRepo rejects an invalid id before any Artifacts call", async () => {
  const artifacts = new FakeArtifacts();
  await assert.rejects(forkHuddleRepo(artifacts, "../031", names), InvalidRepoNameError);
  assert.deepEqual(artifacts.calls, []);
});

test("forkFeatureRepo forks feature-<id> from main once; a second call finds it existing", async () => {
  const artifacts = new FakeArtifacts();
  await setUpProject(artifacts, { ...OWNERS, source: { url: "https://x/r" } }, names);
  const prefixed = new RepoNames("t-");
  await setUpProject(artifacts, { ...OWNERS, source: { url: "https://x/r" } }, prefixed);

  const report = await forkFeatureRepo(artifacts, "tax-rounding", prefixed, { defaultBranchOnly: true });
  assert.deepEqual([report.name, report.role, report.status], ["t-feature-tax-rounding", "feature", "created"]);
  assert.equal(artifacts.repos.get("t-feature-tax-rounding")?.forkedFrom, "t-base");
  assert.equal((await forkFeatureRepo(artifacts, "tax-rounding", prefixed, { defaultBranchOnly: true })).status, "existing");
  await assert.rejects(forkFeatureRepo(artifacts, "-rf", prefixed, { defaultBranchOnly: true }), InvalidRepoNameError);
});

test("the fork options and the feature token lifetime come only from configuration", () => {
  assert.deepEqual(parseFeatureForkOptions("true"), { defaultBranchOnly: true });
  assert.deepEqual(parseFeatureForkOptions("false"), { defaultBranchOnly: false });
  for (const value of [undefined, "", "yes", "TRUE"]) assert.equal(parseFeatureForkOptions(value), undefined, String(value));
  assert.equal(parseFeatureTokenTtl("30"), 1800);
  for (const value of [undefined, "", "0", "-5", "1.5", "30m", "9999999"]) assert.equal(parseFeatureTokenTtl(value), undefined, String(value));
});

test("artifactsErrorCode reads the code, or the message when the code is lost over RPC", () => {
  assert.equal(artifactsErrorCode(new ArtifactsError("FORK_IN_PROGRESS", "x")), "FORK_IN_PROGRESS");
  assert.equal(
    artifactsErrorCode(new Error("ArtifactsError: repo already exists: test-14-huddle-031")),
    "ALREADY_EXISTS",
  );
  assert.equal(
    artifactsErrorCode(new Error("ArtifactsError: Repository not found: test-14-x.")),
    "NOT_FOUND",
  );
  assert.equal(artifactsErrorCode(new Error("something else")), undefined);
  assert.equal(artifactsErrorCode("text"), undefined);
});
