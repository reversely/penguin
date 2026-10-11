// The bridge's side of Penguin: registering the bridge (K4) and fetching Artifacts tokens (K2).
// The bridge token lives in the key store; the registration record beside the spool holds only
// what is not secret. Artifacts tokens are cached in process memory and never written anywhere.

import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  ApprovalReport,
  ApprovalSpec,
  CombinedRunEvent,
  ReviewException,
  ReviewRecord,
  VerificationReport,
  VerificationRunSpec,
} from "@penguin/protocol";

import {
  artifactsRemote,
  localRemote,
  penguinRepoOf,
  RemoteRefusedError,
  RemoteUnavailableError,
  type RemoteResolver,
  type RepoToken,
  type TokenSource,
} from "./git-remote.ts";
import { loadSigningKey, type KeyStore } from "./key-store.ts";

/** What the bridge keeps about its registration. Nothing here is secret. */
export interface BridgeRegistration {
  /** The Penguin Worker's origin, such as https://penguin.example.workers.dev. */
  readonly server: string;
  readonly bridgeId: string;
  readonly owner: string;
  readonly role: "owner" | "runner";
}

export type Fetch = typeof globalThis.fetch;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The key store account that holds an owner's bridge token. */
export function bridgeTokenAccount(ownerId: string): string {
  return `bridge-token:${ownerId}`;
}

export function registrationFile(stateDir: string): string {
  return join(resolve(stateDir), "bridge.json");
}

/**
 * The origin of a Penguin or Artifacts URL. Credentials travel only over HTTPS; plain HTTP is
 * accepted for a loopback host, which is `wrangler dev`.
 */
export function checkedOrigin(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${what} ${JSON.stringify(text)} is not a URL`);
  }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error(`${what} must be an https:// URL`);
  if (url.username !== "" || url.password !== "") throw new Error(`${what} must not carry credentials`);
  return url;
}

export interface RegisterOptions {
  server: string;
  code: string;
  owner: string;
  keyStore: KeyStore;
  stateDir: string;
  fetch?: Fetch;
}

/**
 * Spends a registration code: sends the owner's public signing key to Penguin, stores the
 * returned bridge token in the key store and the registration record in the state folder.
 */
export async function registerBridge(options: RegisterOptions): Promise<BridgeRegistration> {
  const { code, owner, keyStore, stateDir } = options;
  const server = checkedOrigin(options.server, "the Penguin server").origin;
  const key = await loadSigningKey(keyStore, owner);
  const response = await (options.fetch ?? fetch)(`${server}/bridges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, publicKey: key.publicJwk }),
  });
  if (response.status !== 201) {
    // The error body names the problem and never holds a token.
    const detail = await response.text().catch(() => "");
    throw new Error(`Penguin refused the registration (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const { bridgeId, owner: registeredOwner, role, bridgeToken } = body;
  if (
    typeof bridgeId !== "string" ||
    typeof bridgeToken !== "string" ||
    (role !== "owner" && role !== "runner") ||
    typeof registeredOwner !== "string"
  ) {
    throw new Error("Penguin answered the registration with an unexpected body");
  }
  if (registeredOwner !== owner) {
    // The code was issued for someone else; this bridge's key now sits under their name.
    throw new Error(`the registration code belongs to ${registeredOwner}, not ${owner}; ask for a code for ${owner}`);
  }
  const registration: BridgeRegistration = { server, bridgeId, owner, role };
  await keyStore.set(bridgeTokenAccount(owner), bridgeToken);
  await saveRegistration(stateDir, registration);
  return registration;
}

async function saveRegistration(stateDir: string, registration: BridgeRegistration): Promise<void> {
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const handle = await open(registrationFile(stateDir), "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registration, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

/** The registration in `stateDir`, or null when the bridge has not registered there. */
export async function readRegistration(stateDir: string): Promise<BridgeRegistration | null> {
  let text: string;
  try {
    text = await readFile(registrationFile(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as Partial<BridgeRegistration>;
  if (typeof value.server !== "string" || typeof value.owner !== "string" || typeof value.bridgeId !== "string") {
    throw new Error(`${registrationFile(stateDir)} is not a bridge registration`);
  }
  return value as BridgeRegistration;
}

export interface TokenClientOptions {
  server: string;
  bridgeToken: string;
  fetch?: Fetch;
  now?: () => number;
  /** A cached token with less than this left is replaced before use. */
  refreshMarginMs?: number;
}

/**
 * Fetches tokens from Penguin's token route, write unless a read token is asked for, and caches
 * each until shortly before it expires. The cache is this object's memory; nothing is persisted.
 */
export class TokenClient implements TokenSource {
  readonly #server: string;
  readonly #bridgeToken: string;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #margin: number;
  readonly #cache = new Map<string, Promise<RepoToken>>();
  /** How many tokens this client has fetched, for tests and latency notes. */
  fetched = 0;

  constructor(options: TokenClientOptions) {
    this.#server = checkedOrigin(options.server, "the Penguin server").origin;
    this.#bridgeToken = options.bridgeToken;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#margin = options.refreshMarginMs ?? 30_000;
  }

  async token(repo: string, options: { refresh?: boolean; scope?: "read" | "write" } = {}): Promise<RepoToken> {
    const scope = options.scope ?? "write";
    const key = `${scope} ${repo}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && !options.refresh) {
      const token = await cached.catch(() => null);
      if (token !== null && Date.parse(token.expiresAt) - this.#now() > this.#margin) return token;
    }
    const pending = this.#mint(repo, scope);
    this.#cache.set(key, pending);
    pending.catch(() => {
      if (this.#cache.get(key) === pending) this.#cache.delete(key);
    });
    return pending;
  }

  async #mint(repo: string, scope: "read" | "write"): Promise<RepoToken> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#server}/tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#bridgeToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo, scope }),
      });
    } catch (error) {
      throw new RemoteUnavailableError(`Penguin at ${this.#server} is unreachable: ${(error as Error).message}`);
    }
    this.fetched += 1;
    if (response.status === 403) {
      throw new RemoteRefusedError(`Penguin does not let this bridge ${scope === "write" ? "write to" : "read"} ${repo}`);
    }
    if (response.status === 401) {
      throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
    }
    if (response.status === 404) throw new RemoteUnavailableError(`the repo ${repo} does not exist in Artifacts yet`);
    if (response.status !== 200) {
      throw new RemoteUnavailableError(`Penguin could not issue a token for ${repo} (HTTP ${response.status})`);
    }
    const body = (await response.json()) as Partial<RepoToken>;
    if (typeof body.token !== "string" || typeof body.remote !== "string" || Number.isNaN(Date.parse(body.expiresAt ?? ""))) {
      throw new RemoteUnavailableError(`Penguin answered the token request for ${repo} without a token and remote`);
    }
    checkedOrigin(body.remote, "the Artifacts remote");
    return { repo, scope, token: body.token, remote: body.remote, expiresAt: body.expiresAt! };
  }
}

/**
 * The resolver a bridge command uses: local paths as they are, `penguin:<repo>` names through one
 * token client built from the registration in `stateDir` and the bridge token in `keyStore`, with
 * tokens of `scope`.
 */
export function bridgeRemotes(
  stateDir: string,
  keyStore: KeyStore,
  fetchImpl?: Fetch,
  scope: "read" | "write" = "write",
): RemoteResolver {
  let client: Promise<TokenClient> | undefined;
  const tokens = () => {
    client ??= openTokenClient(stateDir, keyStore, fetchImpl);
    // A failed open is retried by the next command rather than remembered.
    client.catch(() => {
      client = undefined;
    });
    return client;
  };
  return (name) => {
    const repo = penguinRepoOf(name);
    if (repo !== undefined) return artifactsRemote(name, repo, tokens, scope);
    if (name.startsWith("penguin:")) throw new Error(`${JSON.stringify(name)} does not name a Penguin repo`);
    return localRemote(name);
  };
}

async function openTokenClient(stateDir: string, keyStore: KeyStore, fetchImpl?: Fetch): Promise<TokenClient> {
  const { registration, bridgeToken } = await openBridge(stateDir, keyStore);
  return new TokenClient({ server: registration.server, bridgeToken, fetch: fetchImpl });
}

/** The registration in `stateDir` and its bridge token from `keyStore`. */
export async function openBridge(
  stateDir: string,
  keyStore: KeyStore,
): Promise<{ readonly registration: BridgeRegistration; readonly bridgeToken: string }> {
  const registration = await readRegistration(stateDir);
  if (registration === null) {
    throw new RemoteUnavailableError("this bridge is not registered; run `penguin-bridge register`");
  }
  const bridgeToken = await keyStore.get(bridgeTokenAccount(registration.owner));
  if (bridgeToken === null) {
    throw new RemoteUnavailableError(`the key store holds no bridge token for ${registration.owner}; register again`);
  }
  return { registration, bridgeToken };
}

/** One operation waiting for the runner, as Penguin's pending route lists it. */
export interface PendingOperation {
  readonly opId: string;
  /** Where Penguin says the file goes. The runner checks it before writing. */
  readonly path: string;
  /** The signed operation file's text. */
  readonly file: string;
}

/** The route that lists the operations waiting for the runner. */
export const PENDING_ROUTE = "/operations/pending";

/**
 * Lists the operations waiting for the runner. Penguin answers only a bridge registered with the
 * runner role, which it reads from the bridge token, never from the request.
 */
export async function fetchPendingOperations(
  server: string,
  bridgeToken: string,
  fetchImpl: Fetch = fetch,
): Promise<PendingOperation[]> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${PENDING_ROUTE}`, { headers: { Authorization: `Bearer ${bridgeToken}` } });
  } catch (error) {
    throw new RemoteUnavailableError(`Penguin at ${origin} is unreachable: ${(error as Error).message}`);
  }
  if (response.status === 403) throw new RemoteRefusedError("Penguin lists pending operations only to a runner bridge");
  if (response.status === 401) throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
  if (response.status !== 200) {
    throw new RemoteUnavailableError(`Penguin could not list pending operations (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) throw new RemoteUnavailableError("Penguin answered the pending list without files");
  return body.files.map((entry: unknown): PendingOperation => {
    const { opId, path, file } = (entry ?? {}) as Record<string, unknown>;
    if (typeof opId !== "string" || typeof path !== "string" || typeof file !== "string") {
      throw new RemoteUnavailableError("Penguin listed a pending operation without its op_id, path and file");
    }
    return { opId, path, file };
  });
}

/** The route a runner reports a combined run to. */
export const COMBINED_RUN_ROUTE = "/combined-runs";

/** Penguin's answer to a combined-run report. */
export interface CombinedRunReply {
  /** `opened` for a new Huddle issue, `existing` when one is open for the trigger, else `no_failures`. */
  readonly status: "opened" | "existing" | "no_failures";
  /** The Huddle issue's number; absent when nothing failed. */
  readonly issueId?: string;
  readonly huddleRepo?: string | null;
}

/**
 * Reports a combined run to Penguin, which opens a Huddle issue when its tests failed on a
 * published checkpoint. Penguin answers only a bridge registered with the runner role.
 */
export async function reportCombinedRun(
  server: string,
  bridgeToken: string,
  event: CombinedRunEvent,
  fetchImpl: Fetch = fetch,
): Promise<CombinedRunReply> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${COMBINED_RUN_ROUTE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (error) {
    throw new RemoteUnavailableError(`Penguin at ${origin} is unreachable: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 200 || response.status === 201) return body as unknown as CombinedRunReply;
  if (response.status === 401) throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
  const message = typeof body["message"] === "string" ? `: ${body["message"]}` : "";
  if ([400, 403, 409, 422].includes(response.status)) {
    throw new RemoteRefusedError(`Penguin refused the combined run (HTTP ${response.status})${message}`);
  }
  throw new RemoteUnavailableError(`Penguin could not take the combined run (HTTP ${response.status})${message}`);
}

/** The route a runner claims the scheduled combined runs from. */
export const COMBINED_RUN_CLAIM_ROUTE = "/combined-runs/claim";

/** A combined run Penguin scheduled and this runner claimed. It names commands by ID only. */
export interface ClaimedCombinedRun {
  readonly runId: string;
  /** The published checkpoint that changed a depended-on scope, and the commit it was made from. */
  readonly trigger: { readonly ownerId: string; readonly sha: string; readonly baselineSha: string };
  /** The dependent owner and the latest checkpoint of theirs to merge with the trigger. */
  readonly ownerId: string;
  readonly ownerCheckpoint: string;
  /** Allowlisted command IDs, `test:<scope id>`; the runner resolves each from the repository config. */
  readonly commandIds: readonly string[];
}

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Claims the combined runs Penguin scheduled, which marks them as this runner's until they are
 * reported or their lease runs out. Penguin answers only a bridge registered with the runner role.
 */
export async function claimCombinedRuns(
  server: string,
  bridgeToken: string,
  fetchImpl: Fetch = fetch,
): Promise<ClaimedCombinedRun[]> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${COMBINED_RUN_CLAIM_ROUTE}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}` },
    });
  } catch (error) {
    throw new RemoteUnavailableError(`Penguin at ${origin} is unreachable: ${(error as Error).message}`);
  }
  if (response.status === 403) throw new RemoteRefusedError("Penguin hands out combined runs only to a runner bridge");
  if (response.status === 401) throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
  if (response.status !== 200) {
    throw new RemoteUnavailableError(`Penguin could not hand out combined runs (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { runs?: unknown };
  if (!Array.isArray(body.runs)) throw new RemoteUnavailableError("Penguin answered the claim without runs");
  return body.runs.map(claimedRun);
}

function claimedRun(entry: unknown): ClaimedCombinedRun {
  const { runId, trigger, ownerId, ownerCheckpoint, commandIds } = (entry ?? {}) as Record<string, unknown>;
  const { ownerId: triggerOwner, sha, baselineSha } = (trigger ?? {}) as Record<string, unknown>;
  const owner = (value: unknown) => typeof value === "string" && OWNER_ID.test(value);
  const commit = (value: unknown) => typeof value === "string" && COMMIT.test(value);
  if (
    typeof runId !== "string" ||
    !owner(triggerOwner) ||
    !commit(sha) ||
    !commit(baselineSha) ||
    !owner(ownerId) ||
    !commit(ownerCheckpoint) ||
    !Array.isArray(commandIds) ||
    !commandIds.every((id) => typeof id === "string")
  ) {
    throw new RemoteUnavailableError("Penguin listed a combined run without its checkpoints and command IDs");
  }
  return {
    runId,
    trigger: { ownerId: triggerOwner as string, sha: sha as string, baselineSha: baselineSha as string },
    ownerId: ownerId as string,
    ownerCheckpoint: ownerCheckpoint as string,
    commandIds: commandIds as string[],
  };
}

/** The route a runner lists verification runs from, and reports each one to under `/<run id>`. */
export const VERIFICATION_ROUTE = "/verifications";

/** Penguin's answer to a verification report. */
export type VerificationReply =
  | { readonly status: "recorded"; readonly issueId: string; readonly state: string; readonly commit: string }
  | { readonly status: "existing"; readonly issueId: string }
  /** A newer checkpoint superseded the run; its results do not count and need no retry. */
  | { readonly status: "superseded"; readonly message: string };

/**
 * Lists the verification runs waiting for the runner. Penguin answers only a bridge registered with
 * the runner role. Each listing is checked again by the runner before it fetches or runs anything.
 */
export async function fetchVerificationRuns(
  server: string,
  bridgeToken: string,
  fetchImpl: Fetch = fetch,
): Promise<VerificationRunSpec[]> {
  const { status, body } = await runnerRequest(server, bridgeToken, VERIFICATION_ROUTE, undefined, fetchImpl);
  if (status !== 200 || !Array.isArray(body["runs"])) {
    throw new RemoteUnavailableError(`Penguin could not list verification runs (HTTP ${status})`);
  }
  return body["runs"] as VerificationRunSpec[];
}

/** Reports a verification run to Penguin, which attaches its checks to the Huddle issue. */
export async function reportVerification(
  server: string,
  bridgeToken: string,
  runId: string,
  report: VerificationReport,
  fetchImpl: Fetch = fetch,
): Promise<VerificationReply> {
  const route = `${VERIFICATION_ROUTE}/${encodeURIComponent(runId)}`;
  const { status, body } = await runnerRequest(server, bridgeToken, route, report, fetchImpl);
  if (status === 200) return body as unknown as VerificationReply;
  const message = typeof body["message"] === "string" ? `: ${body["message"]}` : "";
  if (status === 409 && body["error"] === "superseded") return { status: "superseded", message: String(body["message"]) };
  if ([400, 404, 409].includes(status)) {
    throw new RemoteRefusedError(`Penguin refused verification run ${runId} (HTTP ${status})${message}`);
  }
  throw new RemoteUnavailableError(`Penguin could not take verification run ${runId} (HTTP ${status})${message}`);
}

/** The route a runner lists approved branches from, and reports each one to under `/<issue id>`. */
export const APPROVAL_ROUTE = "/approvals";

/** Penguin's answer to an approved-branch report: the Huddle issue's state after it. */
export interface ApprovalReply {
  readonly status: "recorded";
  readonly issueId: string;
  readonly state: string;
  readonly commit: string;
}

/**
 * Lists the approved branches waiting for the runner. Penguin answers only a bridge registered with
 * the runner role. Each listing is checked again by the runner before it fetches or pushes anything.
 */
export async function fetchApprovals(server: string, bridgeToken: string, fetchImpl: Fetch = fetch): Promise<ApprovalSpec[]> {
  const { status, body } = await runnerRequest(server, bridgeToken, APPROVAL_ROUTE, undefined, fetchImpl);
  if (status !== 200 || !Array.isArray(body["approvals"])) {
    throw new RemoteUnavailableError(`Penguin could not list approved branches (HTTP ${status})`);
  }
  return body["approvals"] as ApprovalSpec[];
}

/** Reports the Huddle repo's approved branch to Penguin, which links it and closes the Huddle issue. */
export async function reportApproval(
  server: string,
  bridgeToken: string,
  issueId: string,
  report: ApprovalReport,
  fetchImpl: Fetch = fetch,
): Promise<ApprovalReply> {
  const route = `${APPROVAL_ROUTE}/${encodeURIComponent(issueId)}`;
  const { status, body } = await runnerRequest(server, bridgeToken, route, report, fetchImpl);
  if (status === 200) return body as unknown as ApprovalReply;
  const message = typeof body["message"] === "string" ? `: ${body["message"]}` : "";
  if ([400, 404, 409].includes(status)) {
    throw new RemoteRefusedError(`Penguin refused the approved branch of #${issueId} (HTTP ${status})${message}`);
  }
  throw new RemoteUnavailableError(`Penguin could not take the approved branch of #${issueId} (HTTP ${status})${message}`);
}

/** The route a runner claims pending reviews from, and reports each one's record to under `/<review id>`. */
export const REVIEW_ROUTE = "/reviews";

/** A review Penguin kept pending and this runner claimed. */
export interface ClaimedReview {
  readonly reviewId: number;
  readonly feature: string;
  /** The feature's fork, `feature-<id>`. */
  readonly fork: string;
  readonly scope: string;
  /** The checkpoint's baseline on main. */
  readonly base: string;
  /** The checkpoint under review. */
  readonly forkSha: string;
  /** The form as the agent submitted it; the harness checks it again. */
  readonly form: unknown;
}

/** Penguin's answer to a review record: the review's state and who it goes to in person. */
export interface ReviewReply {
  readonly status: "recorded";
  readonly reviewId: number;
  readonly state: "accepted" | "refused";
  readonly sideBySideRef: string;
  readonly exceptions: readonly ReviewException[];
  readonly routedTo: string | null;
}

const FEATURE_FORK = /^feature-[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

/**
 * Claims the reviews Penguin keeps pending, which marks them as this runner's until they are reported
 * or their lease runs out. Penguin answers only a bridge registered with the runner role.
 */
export async function claimReviews(server: string, bridgeToken: string, fetchImpl: Fetch = fetch): Promise<ClaimedReview[]> {
  const { status, body } = await runnerRequest(server, bridgeToken, `${REVIEW_ROUTE}/claim`, {}, fetchImpl);
  if (status !== 200 || !Array.isArray(body["reviews"])) {
    throw new RemoteUnavailableError(`Penguin could not hand out reviews (HTTP ${status})`);
  }
  return body["reviews"].map((entry: unknown): ClaimedReview => {
    const { reviewId, feature, fork, scope, base, forkSha, form } = (entry ?? {}) as Record<string, unknown>;
    const commit = (value: unknown) => typeof value === "string" && COMMIT.test(value);
    if (
      !Number.isSafeInteger(reviewId) ||
      typeof feature !== "string" ||
      typeof fork !== "string" ||
      fork !== `feature-${feature}` ||
      !FEATURE_FORK.test(fork) ||
      typeof scope !== "string" ||
      !commit(base) ||
      !commit(forkSha)
    ) {
      throw new RemoteUnavailableError("Penguin listed a review without its feature fork, scope and commits");
    }
    return { reviewId: reviewId as number, feature, fork, scope, base: base as string, forkSha: forkSha as string, form };
  });
}

/** Reports a claimed review's record, which makes the review accepted or refused with it attached. */
export async function reportReview(
  server: string,
  bridgeToken: string,
  reviewId: number,
  record: ReviewRecord,
  fetchImpl: Fetch = fetch,
): Promise<ReviewReply> {
  const { status, body } = await runnerRequest(server, bridgeToken, `${REVIEW_ROUTE}/${reviewId}`, record, fetchImpl);
  if (status === 200) return body as unknown as ReviewReply;
  const message = typeof body["message"] === "string" ? `: ${body["message"]}` : "";
  if ([400, 404, 409, 413].includes(status)) {
    throw new RemoteRefusedError(`Penguin refused the record of review ${reviewId} (HTTP ${status})${message}`);
  }
  throw new RemoteUnavailableError(`Penguin could not take the record of review ${reviewId} (HTTP ${status})${message}`);
}

/** One runner request: GET without a body, else POST of `body` as JSON. Answers 401 and 403 throw. */
async function runnerRequest(
  server: string,
  bridgeToken: string,
  route: string,
  body: unknown,
  fetchImpl: Fetch,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const origin = checkedOrigin(server, "the Penguin server").origin;
  const headers: Record<string, string> = { Authorization: `Bearer ${bridgeToken}` };
  let response: Response;
  try {
    response = await fetchImpl(
      `${origin}${route}`,
      body === undefined
        ? { headers }
        : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch (error) {
    throw new RemoteUnavailableError(`Penguin at ${origin} is unreachable: ${(error as Error).message}`);
  }
  if (response.status === 401) throw new RemoteUnavailableError("Penguin refused the bridge token; register the bridge again");
  if (response.status === 403) throw new RemoteRefusedError(`Penguin answers ${route} only to a runner bridge`);
  const parsed = (await response.json().catch(() => ({}))) as unknown;
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  return { status: response.status, body: record as Record<string, unknown> };
}
