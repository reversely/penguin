/**
 * The project's repos in its Artifacts namespace: the base repo, the issues repo, one fork of the
 * base per owner, one fork of the base per Huddle issue and one fork of the base per feature.
 *
 * This module takes the Artifacts binding as a parameter and never imports the Agents SDK, so
 * node:test can run it against a fake binding.
 */

/**
 * The Artifacts limits page: repo names "Start with a letter or digit. Remaining characters may
 * include letters, digits, ., _, and -."
 */
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_NAME_RULE_MESSAGE =
  "must start with a letter or digit and contain only letters, digits, '.', '_' and '-'";

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_PATTERN.test(name);
}

/** The subset of `ArtifactsCreateRepoResult` this module reads. */
export interface CreatedRepo {
  readonly name: string;
  readonly remote: string;
}

/** The subset of the binding's `ArtifactsRepo` capability this module calls. */
export interface RepoHandle extends Disposable {
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<readonly unknown[]>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<CreatedRepo>;
}

/** The subset of the binding's `Artifacts` namespace this module calls. */
export interface ArtifactsNamespace {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<CreatedRepo>;
  import(params: {
    source: { url: string; branch?: string };
    target: { name: string; opts?: { description?: string } };
  }): Promise<CreatedRepo>;
  get(name: string): Promise<RepoHandle>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    repos: readonly { name: string }[];
    cursor?: string;
  }>;
}

/** Repo names for one project. `prefix` lets test runs and several projects share a namespace. */
export class RepoNames {
  readonly prefix: string;

  constructor(prefix = "") {
    if (prefix !== "" && !isValidRepoName(prefix)) {
      throw new InvalidRepoNameError("repo prefix", prefix);
    }
    this.prefix = prefix;
  }

  get base(): string {
    return `${this.prefix}base`;
  }

  get issues(): string {
    return `${this.prefix}issues`;
  }

  owner(ownerId: string): string {
    return `${this.prefix}owner-${ownerId}`;
  }

  huddle(huddleId: string): string {
    return `${this.prefix}huddle-${huddleId}`;
  }

  feature(featureId: string): string {
    return `${this.prefix}feature-${featureId}`;
  }
}

export class InvalidRepoNameError extends Error {
  constructor(what: string, value: string) {
    super(`${what} ${JSON.stringify(value)} ${REPO_NAME_RULE_MESSAGE}`);
    this.name = "InvalidRepoNameError";
  }
}

/**
 * Message prefixes for codes this module acts on. Through `wrangler dev` with the remote binding
 * (wrangler 4.149.0) the error reaches the Worker as a plain `Error` with no `code`, its message
 * reading, for example, "ArtifactsError: repo already exists: <name>".
 */
const CODE_BY_MESSAGE: readonly (readonly [RegExp, string])[] = [
  [/^ArtifactsError: repo already exists\b/i, "ALREADY_EXISTS"],
  [/^ArtifactsError: repository not found\b/i, "NOT_FOUND"],
];

/**
 * The binding documents `ArtifactsError` with a string `code`, such as `ALREADY_EXISTS`. When the
 * code is missing, the message is matched against the prefixes above.
 */
export function artifactsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  if (typeof message !== "string") return undefined;
  return CODE_BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1];
}

const IN_PROGRESS_CODES = new Set(["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"]);

/** Counts calls made through the binding, by method name. */
export class OperationCounter {
  readonly byMethod: Record<string, number> = {};

  record(method: string): void {
    this.byMethod[method] = (this.byMethod[method] ?? 0) + 1;
  }

  get total(): number {
    return Object.values(this.byMethod).reduce((sum, count) => sum + count, 0);
  }
}

/** Wraps a binding so every call through it, including calls on repo handles, is counted. */
export function countOperations(
  artifacts: ArtifactsNamespace,
  counter: OperationCounter,
): ArtifactsNamespace {
  return {
    create(name, opts) {
      counter.record("create");
      return artifacts.create(name, opts);
    },
    import(params) {
      counter.record("import");
      return artifacts.import(params);
    },
    list(opts) {
      counter.record("list");
      return artifacts.list(opts);
    },
    async get(name) {
      counter.record("get");
      const handle = await artifacts.get(name);
      return {
        log(opts) {
          counter.record("log");
          return handle.log(opts);
        },
        fork(forkName, opts) {
          counter.record("fork");
          return handle.fork(forkName, opts);
        },
        [Symbol.dispose]() {
          handle[Symbol.dispose]();
        },
      };
    },
  };
}

/** Opens a repo handle, runs `use` with it and releases the RPC stub afterwards. */
async function withRepo<T>(
  artifacts: ArtifactsNamespace,
  name: string,
  use: (repo: RepoHandle) => Promise<T>,
): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

async function listRepoNames(artifacts: ArtifactsNamespace): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await artifacts.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const repo of page.repos) names.add(repo.name);
    cursor = page.cursor;
  } while (cursor);
  return names;
}

export type RepoRole = "base" | "issues" | "owner" | "huddle" | "feature";

/**
 * `created` and `imported` repos were made by this call; `existing` ones were there before it.
 * `pending` repos could not be made yet; `reason` says why.
 */
export type RepoStatus = "created" | "imported" | "existing" | "pending";

export interface RepoReport {
  readonly name: string;
  readonly role: RepoRole;
  readonly status: RepoStatus;
  readonly owner?: string;
  /** The Git remote, returned by Artifacts when this call made the repo. */
  readonly remote?: string;
  readonly reason?: string;
}

export interface ProjectSetupRequest {
  /** Owner ids from the project's `penguin/owners.json`. */
  readonly owners: readonly string[];
  /** An HTTPS Git remote to import the base repo from. Without it, the base repo starts empty. */
  readonly source?: { readonly url: string; readonly branch?: string };
}

export interface ProjectSetupReport {
  /** True when every repo exists. False while owner forks wait for the base repo. */
  readonly complete: boolean;
  readonly created: number;
  readonly repos: readonly RepoReport[];
  readonly durationMs: number;
  readonly artifactsOperations: {
    readonly total: number;
    readonly byMethod: Record<string, number>;
  };
}

/** One problem with a setup request body. */
export interface SetupRequestIssue {
  readonly field: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a setup request body. Every owner id passes the repo-name rule here, before any
 * Artifacts call.
 */
export function parseSetupRequest(
  body: unknown,
): { ok: true; request: ProjectSetupRequest } | { ok: false; issues: SetupRequestIssue[] } {
  const issues: SetupRequestIssue[] = [];
  if (!isRecord(body)) {
    return { ok: false, issues: [{ field: "", message: "must be a JSON object" }] };
  }

  const owners: string[] = [];
  if (!Array.isArray(body.owners) || body.owners.length === 0) {
    issues.push({ field: "owners", message: "must be a non-empty array of owner ids" });
  } else {
    const seen = new Set<string>();
    body.owners.forEach((owner: unknown, index) => {
      const field = `owners[${index}]`;
      if (typeof owner !== "string" || !isValidRepoName(owner)) {
        issues.push({ field, message: REPO_NAME_RULE_MESSAGE });
      } else if (seen.has(owner)) {
        issues.push({ field, message: `duplicate owner id ${JSON.stringify(owner)}` });
      } else {
        seen.add(owner);
        owners.push(owner);
      }
    });
  }

  let source: ProjectSetupRequest["source"];
  if (body.source !== undefined) {
    const parsed = parseSource(body.source, issues);
    if (parsed) source = parsed;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, request: source ? { owners, source } : { owners } };
}

function parseSource(
  value: unknown,
  issues: SetupRequestIssue[],
): ProjectSetupRequest["source"] | undefined {
  if (!isRecord(value)) {
    issues.push({ field: "source", message: "must be an object with an HTTPS 'url'" });
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = typeof value.url === "string" ? new URL(value.url) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:") {
    issues.push({ field: "source.url", message: "must be an HTTPS URL of a Git repository" });
  }
  const { branch } = value;
  if (branch !== undefined && (typeof branch !== "string" || branch.trim() === "")) {
    issues.push({ field: "source.branch", message: "must be a non-empty string" });
  }
  if (!url || url.protocol !== "https:") return undefined;
  return typeof branch === "string" ? { url: url.href, branch } : { url: url.href };
}

const NO_COMMITS = "the base repo has no commits; push the base commit, then run setup again";

type OwnerRepo = { readonly name: string; readonly role: "owner"; readonly owner: string };

/**
 * Forks each missing owner repo from the base repo through one base handle. The forks wait, as
 * `pending`, until the base repo is ready and holds a commit: forking an empty base would give
 * owners forks without the team's main branch.
 */
async function forkOwners(
  artifacts: ArtifactsNamespace,
  baseName: string,
  missing: readonly OwnerRepo[],
): Promise<RepoReport[]> {
  const pending = (reason: string) =>
    missing.map((owner) => ({ ...owner, status: "pending" as const, reason }));
  let base: RepoHandle;
  try {
    base = await artifacts.get(baseName);
  } catch (error) {
    const code = artifactsErrorCode(error);
    if (code && IN_PROGRESS_CODES.has(code)) {
      return pending(`the base repo is not ready (${code}); run setup again`);
    }
    throw error;
  }
  try {
    if ((await base.log({ limit: 1 })).length === 0) return pending(NO_COMMITS);
    const reports: RepoReport[] = [];
    for (const owner of missing) {
      reports.push(
        await ensureRepo(new Set(), owner, "created", () =>
          base.fork(owner.name, {
            description: `Penguin checkpoints published by owner ${owner.owner}`,
            defaultBranchOnly: true,
          }),
        ),
      );
    }
    return reports;
  } finally {
    base[Symbol.dispose]();
  }
}

/** Creates `name` unless it already exists; `make` performs the create, import or fork. */
async function ensureRepo(
  existing: ReadonlySet<string>,
  report: Omit<RepoReport, "status">,
  madeStatus: "created" | "imported",
  make: () => Promise<CreatedRepo>,
): Promise<RepoReport> {
  if (existing.has(report.name)) return { ...report, status: "existing" };
  try {
    const made = await make();
    return { ...report, status: madeStatus, remote: made.remote };
  } catch (error) {
    // Another setup run made it between list() and this call.
    if (artifactsErrorCode(error) === "ALREADY_EXISTS") return { ...report, status: "existing" };
    throw error;
  }
}

/**
 * Makes the project's repos: the base repo (imported from `source.url`, or created empty), the
 * issues repo and one fork of the base per owner. Repos that already exist are reported and left
 * alone, so running setup again creates nothing. Owner forks wait until the base repo holds a
 * commit; they are reported as `pending` until then.
 *
 * Never returns a repo token: the tokens Artifacts returns with each new repo are dropped here.
 */
export async function setUpProject(
  binding: ArtifactsNamespace,
  request: ProjectSetupRequest,
  names: RepoNames,
  now: () => number = Date.now,
): Promise<ProjectSetupReport> {
  const started = now();
  const counter = new OperationCounter();
  const artifacts = countOperations(binding, counter);
  const existing = await listRepoNames(artifacts);
  const repos: RepoReport[] = [];

  const { source } = request;
  const base = await ensureRepo(
    existing,
    { name: names.base, role: "base" },
    source ? "imported" : "created",
    () =>
      source
        ? artifacts.import({
            source,
            target: { name: names.base, opts: { description: "Penguin project base repo" } },
          })
        : artifacts.create(names.base, {
            description: "Penguin project base repo",
            setDefaultBranch: "main",
          }),
  );
  repos.push(base);

  repos.push(
    await ensureRepo(existing, { name: names.issues, role: "issues" }, "created", () =>
      artifacts.create(names.issues, {
        description: "Penguin issue operation log",
        setDefaultBranch: "main",
      }),
    ),
  );

  const owners = request.owners.map((owner) => ({
    name: names.owner(owner),
    role: "owner" as const,
    owner,
  }));
  const missing = owners.filter((owner) => !existing.has(owner.name));
  // A base repo created empty by this call has no commit to fork, so it is not opened.
  const made =
    missing.length === 0
      ? []
      : base.status === "created"
        ? missing.map((owner) => ({ ...owner, status: "pending" as const, reason: NO_COMMITS }))
        : await forkOwners(artifacts, names.base, missing);
  const madeByName = new Map(made.map((report) => [report.name, report]));
  for (const owner of owners) {
    repos.push(madeByName.get(owner.name) ?? { ...owner, status: "existing" });
  }

  return {
    complete: repos.every((repo) => repo.status !== "pending"),
    created: repos.filter((repo) => repo.status === "created" || repo.status === "imported").length,
    repos,
    durationMs: now() - started,
    artifactsOperations: { total: counter.total, byMethod: { ...counter.byMethod } },
  };
}

/** The `fork()` options a feature's fork is made with, from the Worker's configuration. */
export interface FeatureForkOptions {
  readonly defaultBranchOnly: boolean;
}

/**
 * Parses PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY, "true" or "false". Anything else, unset included,
 * is undefined, so opening a feature refuses rather than guess how to fork.
 */
export function parseFeatureForkOptions(defaultBranchOnly: string | undefined): FeatureForkOptions | undefined {
  if (defaultBranchOnly !== "true" && defaultBranchOnly !== "false") return undefined;
  return { defaultBranchOnly: defaultBranchOnly === "true" };
}

/**
 * Forks main, the base repo, into `feature-<id>`, as setup forks each owner's repo. Returns
 * `existing` when the fork is already there, so opening a feature again makes no second fork.
 *
 * Throws `InvalidRepoNameError` before any Artifacts call when `featureId` fails the repo-name rule.
 */
export async function forkFeatureRepo(
  artifacts: ArtifactsNamespace,
  featureId: string,
  names: RepoNames,
  options: FeatureForkOptions,
): Promise<RepoReport> {
  if (!isValidRepoName(featureId)) throw new InvalidRepoNameError("feature id", featureId);
  const report = { name: names.feature(featureId), role: "feature" as const };
  return ensureRepo(new Set(), report, "created", () =>
    withRepo(artifacts, names.base, (base) =>
      base.fork(report.name, {
        description: `Penguin feature ${featureId}`,
        defaultBranchOnly: options.defaultBranchOnly,
      }),
    ),
  );
}

/**
 * The id of a Huddle issue's repo: the issue number zero-padded to three digits, as in `huddle-031`
 * for #31. `huddleRepoId` in @penguin/protocol, which names the repo to the runner, is the same rule;
 * the Worker keeps its own copy because importing the protocol package here would add a dependency.
 */
export function huddleRepoId(issueId: string): string {
  return issueId.padStart(3, "0");
}

/**
 * Forks `huddle-<id>` from the base repo. The Huddle repo receives the integration result and the
 * approved candidate. Returns `existing` when the Huddle repo is already there.
 *
 * Throws `InvalidRepoNameError` before any Artifacts call when `huddleId` fails the repo-name rule.
 */
export async function forkHuddleRepo(
  artifacts: ArtifactsNamespace,
  huddleId: string,
  names: RepoNames,
): Promise<RepoReport> {
  if (!isValidRepoName(huddleId)) throw new InvalidRepoNameError("Huddle id", huddleId);
  const report = { name: names.huddle(huddleId), role: "huddle" as const };
  return ensureRepo(new Set(), report, "created", () =>
    withRepo(artifacts, names.base, (base) =>
      base.fork(report.name, {
        description: `Penguin Huddle ${huddleId}: integration result and approved candidate`,
        defaultBranchOnly: true,
      }),
    ),
  );
}
