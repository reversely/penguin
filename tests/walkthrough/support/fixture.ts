/**
 * One use case's fixture, read from its files at runtime: `pins.json` and the base commit's
 * `penguin/owners.json`, `penguin/scopes.json` and `penguin/identities.json`. Everything the
 * walkthrough types and asserts is derived here from those files, so renaming an owner in a fixture
 * changes the walkthrough without an edit to its source.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseFailingTests } from "@penguin/local-bridge";

const run = promisify(execFile);

export interface FixtureOwner {
  readonly id: string;
  readonly display_name: string;
  readonly delegate_owner_id: string | null;
  readonly role: string;
}

export interface FixtureScope {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly paths: readonly string[];
  readonly depends_on: readonly { readonly scope: string; readonly kind: string }[];
}

export interface FixtureIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
}

export interface FixturePins {
  readonly branches: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly fixes: Readonly<Record<string, string>>;
}

/** One test that fails on the owners' merged checkpoints, and the commit that makes it pass. */
export interface ExpectedFix {
  /** The pytest node ID, as `pins.json` names it. */
  readonly nodeId: string;
  /** The test ID a check carries, as the runner derives it from the node ID. */
  readonly testId: string;
  readonly scope: FixtureScope;
  /** The identity the failing test's scope owner works as on that scope; the first assignee. */
  readonly firstAssignee: FixtureIdentity;
  /** The owner whose branch holds the fix commit. */
  readonly fixOwner: FixtureOwner;
  readonly fixSha: string;
  /** The identity that makes the fix: the first assignee, or the fix owner's identity after an upstream send. */
  readonly finalAssignee: FixtureIdentity;
  /** True when the fix lies in another owner's scope, so the first assignee sends it upstream. */
  readonly upstream: boolean;
}

/** The pins file's names for an owner's branch and checkpoint tag (see the `$comment` in pins.json). */
export const ownerBranch = (ownerId: string): string => `owner-${ownerId}`;
export const checkpointTag = (ownerId: string): string => `${ownerBranch(ownerId)}-checkpoint`;
/** The base commit's branch in pins.json. */
export const BASE_BRANCH = "main";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export class UseCaseFixture {
  readonly name: string;
  readonly dir: string;
  readonly pins: FixturePins;
  readonly owners: readonly FixtureOwner[];
  readonly scopes: readonly FixtureScope[];
  readonly identities: readonly FixtureIdentity[];

  constructor(repoRoot: string, name: string) {
    this.name = name;
    this.dir = join(repoRoot, "examples", name);
    this.pins = readJson<FixturePins>(join(this.dir, "pins.json"));
    const penguin = join(this.dir, "base", "penguin");
    this.owners = readJson<{ owners: FixtureOwner[] }>(join(penguin, "owners.json")).owners;
    this.scopes = readJson<{ scopes: FixtureScope[] }>(join(penguin, "scopes.json")).scopes;
    this.identities = readJson<{ identities: FixtureIdentity[] }>(join(penguin, "identities.json")).identities;
  }

  /** Builds the fixture repository at `target` with its own build.py. */
  async build(python: string, target: string): Promise<void> {
    await run(python, [join(this.dir, "build.py"), target]);
  }

  get baseSha(): string {
    return this.pins.branches[BASE_BRANCH] as string;
  }

  owner(id: string): FixtureOwner {
    const owner = this.owners.find((candidate) => candidate.id === id);
    if (owner === undefined) throw new Error(`${this.name}: no owner ${id} in owners.json`);
    return owner;
  }

  /** The GitHub login the sign-in test double signs `ownerId` in as. */
  static login(ownerId: string): string {
    return `${ownerId}-gh`;
  }

  /** Owners whose scopes another scope depends on: the owners whose checkpoint can trigger a Huddle. */
  get providerOwners(): FixtureOwner[] {
    const provided = new Set(this.scopes.flatMap((scope) => scope.depends_on.map((dependency) => dependency.scope)));
    const ids = new Set(this.scopes.filter((scope) => provided.has(scope.id)).map((scope) => scope.owner));
    return this.owners.filter((owner) => ids.has(owner.id));
  }

  /**
   * Owners in publishing order: owners of dependent scopes first, providers last, so a provider's
   * checkpoint meets every dependent owner's latest checkpoint in the combined run.
   */
  get publishOrder(): FixtureOwner[] {
    const providers = new Set(this.providerOwners.map((owner) => owner.id));
    return [...this.owners.filter((owner) => !providers.has(owner.id)), ...this.providerOwners];
  }

  /** The owner's unfixed checkpoint and the head of the owner's branch (the fix, or the checkpoint itself). */
  checkpointOf(ownerId: string): string | undefined {
    return this.pins.tags[checkpointTag(ownerId)];
  }

  headOf(ownerId: string): string | undefined {
    return this.pins.branches[ownerBranch(ownerId)];
  }

  /** The owner whose checkpoint changes a depended-on scope: the one provider with a checkpoint tag. */
  get triggerOwner(): FixtureOwner {
    const [owner, ...rest] = this.providerOwners.filter((candidate) => this.checkpointOf(candidate.id) !== undefined);
    if (owner === undefined || rest.length > 0) throw new Error(`${this.name}: expected exactly one triggering owner`);
    return owner;
  }

  /** The scope whose paths hold `path`. */
  scopeOfPath(path: string): FixtureScope {
    const scope = this.scopes.find((candidate) => candidate.paths.some((prefix) => path.startsWith(prefix)));
    if (scope === undefined) throw new Error(`${this.name}: no scope maps ${path}`);
    return scope;
  }

  /** `ownerId`'s identity whose charter holds `scopeId`. */
  identityFor(ownerId: string, scopeIds: readonly string[]): FixtureIdentity {
    const identity = this.identities.find(
      (candidate) => candidate.owner === ownerId && candidate.charter_scopes.some((scope) => scopeIds.includes(scope)),
    );
    if (identity === undefined) throw new Error(`${this.name}: ${ownerId} has no identity chartered for ${scopeIds.join(", ")}`);
    return identity;
  }

  /** The scopes the trigger owner's checkpoint changes that others depend on. */
  get changedProviderScopes(): string[] {
    const provided = new Set(this.scopes.flatMap((scope) => scope.depends_on.map((dependency) => dependency.scope)));
    return this.scopes.filter((scope) => scope.owner === this.triggerOwner.id && provided.has(scope.id)).map((scope) => scope.id);
  }

  /** One expected fix per test in `pins.fixes`, sorted by node ID. */
  get expectedFixes(): ExpectedFix[] {
    return Object.entries(this.pins.fixes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([nodeId, fixSha]) => {
        const [failing] = parseFailingTests(`FAILED ${nodeId}\n`);
        if (failing === undefined) throw new Error(`${this.name}: ${nodeId} is not a pytest node ID`);
        const scope = this.scopeOfPath(nodeId);
        const firstAssignee = this.identityFor(scope.owner, [scope.id]);
        const fixOwner = this.owners.find((owner) => this.headOf(owner.id) === fixSha);
        if (fixOwner === undefined) throw new Error(`${this.name}: no owner branch holds the fix for ${nodeId}`);
        const upstream = fixOwner.id !== scope.owner;
        const finalAssignee = upstream ? this.identityFor(fixOwner.id, this.changedProviderScopes) : firstAssignee;
        return { nodeId, testId: failing.testId, scope, firstAssignee, fixOwner, fixSha, finalAssignee, upstream };
      });
  }

  /** Every literal the walkthrough source must not contain: names, handles, scopes, SHAs and test IDs. */
  forbiddenLiterals(): string[] {
    const fixes = this.expectedFixes;
    return [
      ...this.owners.flatMap((owner) => [owner.id, owner.display_name, UseCaseFixture.login(owner.id)]),
      ...this.identities.map((identity) => identity.handle),
      ...this.scopes.map((scope) => scope.id),
      ...Object.values(this.pins.branches),
      ...Object.values(this.pins.tags),
      ...Object.keys(this.pins.fixes),
      ...fixes.map((fix) => fix.testId),
      ...fixes.map((fix) => fix.nodeId.split("::")[1] as string),
    ];
  }
}
