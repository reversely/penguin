/**
 * One case's fixture, read from its files at runtime. Cases 1 to 3 keep their data in
 * `features.json`, `pins.json`, `base/penguin/*.json` and `reviews/`; case 4 keeps it in
 * `larder.json`, `pins.json` and `reviews/`, and its build generates the penguin files from it.
 * Everything the walkthrough opens, pushes, proposes, reviews and asserts comes from here or from the
 * system's answers, so renaming a person in a fixture changes the walkthrough without an edit to its
 * source.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface FixturePerson {
  readonly id: string;
  readonly display_name: string;
}

export interface FixtureScope {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly paths: readonly string[];
  readonly contracts: readonly string[];
}

export interface FixtureIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: readonly string[];
}

export interface FixtureInvariant {
  readonly id: string;
  readonly scope: string;
  readonly statement: string;
}

/** A plan part's scope that a commit fixes or revises; `kind` is the fixture's own word for it. */
export interface CommitFix {
  readonly scope: string;
  readonly kind?: string;
}

export interface CaseCommit {
  readonly sha: string;
  /** The fixture's tag: a checkpoint the feature's own agent publishes. Untagged is the feature's fix. */
  readonly tag: string | null;
  /** A commit of the originating feature that fixes code on main in another scope. */
  readonly fix: CommitFix | null;
  /** A commit of the originating feature that answers a requested change to the part for a scope. */
  readonly revises: CommitFix | null;
  /**
   * The tag a side commit is built on, for a running feature's second fix in the larder data: the
   * fix the waves write, beside the one-block fix on the branch. Null for a commit on the branch.
   */
  readonly after: string | null;
}

/**
 * The fixture's roles, normalised: `originating` changes what others depend on, `running` and
 * `reader` are under way and read it, `same-area` works in the originating area, `midway` starts
 * touching it later, `late-starter` opens after the plan and `unaffected` does neither.
 */
export type FeatureRole = "originating" | "running" | "reader" | "same-area" | "midway" | "late-starter" | "unaffected" | "wave";

export interface CaseFeature {
  readonly id: string;
  readonly owner: string;
  readonly role: FeatureRole;
  /** Whether the feature starts from the base commit or from main after the fixture's promotions. */
  readonly start: "base" | "main";
  readonly area: { readonly scopes: readonly string[]; readonly paths: readonly string[]; readonly contracts: readonly string[] };
  readonly handle: string;
  readonly commits: readonly CaseCommit[];
}

export interface ReviewFormFile {
  /** The file's name without `.json`. */
  readonly name: string;
  readonly form: { readonly rows: readonly { readonly invariant: string }[] } & Record<string, unknown>;
}

interface FeaturesFile {
  readonly base: { readonly branch: string; readonly date: string };
  readonly features: readonly {
    readonly id: string;
    readonly owner: string;
    readonly role: FeatureRole;
    readonly fork: string;
    readonly area: CaseFeature["area"];
    readonly commits: readonly { readonly tag?: string; readonly fix?: CommitFix; readonly revises?: CommitFix }[];
  }[];
}

interface LarderFile {
  readonly base: { readonly date: string };
  readonly people: readonly FixturePerson[];
  readonly scopes: readonly (Omit<FixtureScope, "contracts"> & { readonly contracts: readonly string[] })[];
  readonly invariants: readonly FixtureInvariant[];
  readonly features: readonly {
    readonly id: string;
    readonly owner: string;
    readonly role: FeatureRole;
    readonly agent: string;
    readonly vendor: string;
    readonly title: string;
    readonly start: "base" | "main";
    readonly area?: readonly string[];
    readonly commits: readonly { readonly tag?: string; readonly after?: string; readonly fix?: CommitFix }[];
  }[];
  readonly promotions: readonly { readonly feature: string }[];
}

interface Pins {
  readonly branches: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly fixes: Readonly<Record<string, string>>;
  /** In the larder data: the test each fix commit of the waves makes pass, to that commit. */
  readonly wave_fixes?: Readonly<Record<string, string>>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The fixture's word for a revision of an originating commit in the larder data. */
const REVISION = "revision";

interface CaseData {
  readonly name: string;
  readonly dir: string;
  readonly pins: Pins;
  readonly people: readonly FixturePerson[];
  readonly scopes: readonly FixtureScope[];
  readonly identities: readonly FixtureIdentity[];
  readonly invariants: readonly FixtureInvariant[];
  readonly features: readonly CaseFeature[];
  readonly promotions: readonly string[];
  readonly reviewForms: readonly ReviewFormFile[];
  readonly baseSha: string;
  readonly baseDate: string;
}

/**
 * A commit's SHA: its tag's, or for the feature's one untagged commit, the branch head's. A commit
 * built `after` an earlier tag sits beside the branch, so it carries a tag of its own.
 */
function commitSha(tagged: string | undefined, head: string | undefined, untagged: number, where: string): string {
  const sha = tagged ?? (untagged === 1 ? head : undefined);
  if (sha === undefined) throw new Error(`${where}: an untagged commit has no pinned SHA unless it is the feature's only one, the branch head`);
  return sha;
}

export class CaseFixture implements CaseData {
  readonly name: string;
  readonly dir: string;
  readonly pins: Pins;
  readonly people: readonly FixturePerson[];
  readonly scopes: readonly FixtureScope[];
  readonly identities: readonly FixtureIdentity[];
  readonly invariants: readonly FixtureInvariant[];
  readonly features: readonly CaseFeature[];
  /** Features that reach main before the originating feature opens, in order. */
  readonly promotions: readonly string[];
  readonly reviewForms: readonly ReviewFormFile[];
  /** The commit main holds when the project is set up. */
  readonly baseSha: string;
  /** The base commit's date, which orders the cases as PRD section 1 numbers them. */
  readonly baseDate: string;

  private constructor(data: CaseData) {
    this.baseDate = data.baseDate;
    this.name = data.name;
    this.dir = data.dir;
    this.pins = data.pins;
    this.people = data.people;
    this.scopes = data.scopes;
    this.identities = data.identities;
    this.invariants = data.invariants;
    this.features = data.features;
    this.promotions = data.promotions;
    this.reviewForms = data.reviewForms;
    this.baseSha = data.baseSha;
  }

  /**
   * Every case under `examples/`: each folder with a features file or a larder data file, in the
   * order PRD section 1 numbers them, by base commit date and then by size.
   */
  static all(repoRoot: string): CaseFixture[] {
    return readdirSync(join(repoRoot, "examples"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ["features.json", "larder.json"].some((file) => existsSync(join(repoRoot, "examples", entry.name, file))))
      .map((entry) => CaseFixture.load(repoRoot, entry.name))
      .sort((a, b) => a.baseDate.localeCompare(b.baseDate) || a.features.length - b.features.length);
  }

  /** Reads the case under `examples/<name>` without building it. */
  static load(repoRoot: string, name: string): CaseFixture {
    const dir = join(repoRoot, "examples", name);
    const pins = readJson<Pins>(join(dir, "pins.json"));
    const reviewsDir = join(dir, "reviews");
    const reviewForms = existsSync(reviewsDir)
      ? readdirSync(reviewsDir)
          .filter((file) => file.endsWith(".json"))
          .sort()
          .map((file) => ({ name: file.slice(0, -".json".length), form: readJson<ReviewFormFile["form"]>(join(reviewsDir, file)) }))
      : [];
    return existsSync(join(dir, "larder.json"))
      ? CaseFixture.#fromLarder(name, dir, pins, reviewForms)
      : CaseFixture.#fromFeatures(name, dir, pins, reviewForms);
  }

  static #fromFeatures(name: string, dir: string, pins: Pins, reviewForms: ReviewFormFile[]): CaseFixture {
    const penguin = join(dir, "base", "penguin");
    const file = readJson<FeaturesFile>(join(dir, "features.json"));
    const identities = readJson<{ identities: FixtureIdentity[] }>(join(penguin, "identities.json")).identities;
    const features = file.features.map((feature): CaseFeature => {
      const identity = identities.find((candidate) => candidate.owner === feature.owner && feature.area.scopes.some((scope) => candidate.charter_scopes.includes(scope)));
      if (identity === undefined) throw new Error(`${name}: no identity of ${feature.owner} is chartered for ${feature.id}'s area`);
      return {
        id: feature.id,
        owner: feature.owner,
        role: feature.role,
        start: "base",
        area: feature.area,
        handle: identity.handle,
        commits: feature.commits.map((commit) => ({
          sha: commitSha(
            commit.tag === undefined ? undefined : pins.tags[commit.tag],
            pins.branches[feature.fork],
            feature.commits.filter((each) => each.tag === undefined).length,
            `${name}/${feature.id}`,
          ),
          tag: commit.tag ?? null,
          after: null,
          fix: commit.fix ?? null,
          revises: commit.revises ?? null,
        })),
      };
    });
    return new CaseFixture({
      name,
      dir,
      pins,
      people: readJson<{ owners: FixturePerson[] }>(join(penguin, "owners.json")).owners,
      scopes: readJson<{ scopes: FixtureScope[] }>(join(penguin, "scopes.json")).scopes,
      identities,
      invariants: readJson<{ invariants: FixtureInvariant[] }>(join(penguin, "invariants.json")).invariants,
      features,
      promotions: [],
      reviewForms,
      baseSha: pins.branches[file.base.branch] as string,
      baseDate: file.base.date,
    });
  }

  static #fromLarder(name: string, dir: string, pins: Pins, reviewForms: ReviewFormFile[]): CaseFixture {
    const larder = readJson<LarderFile>(join(dir, "larder.json"));
    const owned = (person: string) => larder.scopes.filter((scope) => scope.owner === person).map((scope) => scope.id);
    // The build makes one identity per feature, `@<owner>/<agent>`, chartered on its owner's scopes.
    const identities = larder.features.map((feature) => ({
      handle: `@${feature.owner}/${feature.agent}`,
      owner: feature.owner,
      vendor: feature.vendor,
      job: feature.title,
      charter_scopes: owned(feature.owner),
    }));
    const features = larder.features.map((feature): CaseFeature => ({
      id: feature.id,
      owner: feature.owner,
      role: feature.role,
      start: feature.start,
      area: { scopes: feature.area ?? owned(feature.owner), paths: [], contracts: [] },
      handle: `@${feature.owner}/${feature.agent}`,
      commits: feature.commits.map((commit) => ({
        sha: commitSha(
          commit.tag === undefined ? undefined : pins.tags[`feature-${feature.id}-${commit.tag}`],
          pins.branches[`feature-${feature.id}`],
          feature.commits.filter((each) => each.tag === undefined).length,
          `${name}/${feature.id}`,
        ),
        tag: commit.tag ?? null,
        after: commit.after ?? null,
        fix: commit.fix !== undefined && commit.fix.kind !== REVISION ? commit.fix : null,
        revises: commit.fix?.kind === REVISION ? commit.fix : null,
      })),
    }));
    return new CaseFixture({
      name,
      dir,
      pins,
      people: larder.people,
      scopes: larder.scopes,
      identities,
      invariants: larder.invariants,
      features,
      promotions: larder.promotions.map((promotion) => promotion.feature),
      reviewForms,
      baseSha: pins.tags["base"] as string,
      baseDate: larder.base.date,
    });
  }

  /** Builds the fixture repository at `target` with its own build.py. */
  async build(python: string, target: string): Promise<void> {
    await run(python, [join(this.dir, "build.py"), target], { maxBuffer: 16 * 1024 * 1024 });
  }

  get origin(): CaseFeature {
    const [origin, ...rest] = this.features.filter((feature) => feature.role === "originating");
    if (origin === undefined || rest.length > 0) throw new Error(`${this.name}: expected exactly one originating feature`);
    return origin;
  }

  feature(id: string): CaseFeature {
    const feature = this.features.find((candidate) => candidate.id === id);
    if (feature === undefined) throw new Error(`${this.name}: no feature ${id}`);
    return feature;
  }

  scope(id: string): FixtureScope {
    const scope = this.scopes.find((candidate) => candidate.id === id);
    if (scope === undefined) throw new Error(`${this.name}: no scope ${id}`);
    return scope;
  }

  identity(handle: string): FixtureIdentity {
    const identity = this.identities.find((candidate) => candidate.handle === handle);
    if (identity === undefined) throw new Error(`${this.name}: no identity ${handle}`);
    return identity;
  }

  personOf(featureId: string): string {
    return this.feature(featureId).owner;
  }

  /** The scopes a feature's fix may change: its declared scopes. */
  scopesOf(feature: CaseFeature): readonly string[] {
    return feature.area.scopes;
  }

  /** The path prefixes of a feature's declared scopes. */
  pathsOf(feature: CaseFeature): string[] {
    return feature.area.scopes.flatMap((scope) => this.scope(scope).paths);
  }

  /** A running feature's checkpoints, which its own agent publishes: its tagged commits on the branch. */
  checkpointsOf(feature: CaseFeature): CaseCommit[] {
    return feature.commits.filter((commit) => commit.tag !== null && commit.after === null);
  }

  /** A running feature's fix in the one-block plan: its untagged commit, the branch head, which the originating agent writes. */
  fixOf(feature: CaseFeature): CaseCommit | undefined {
    return feature.role === "originating" ? undefined : feature.commits.find((commit) => commit.tag === null);
  }

  /**
   * The review forms an agent of `scope` submits, in round order: the scope's first form, then one
   * per revision of the scope's part when a form is named after the revision's tag. A scope with
   * one form submits it in every round.
   */
  formsFor(scope: string): ReviewFormFile[] {
    const ofScope = this.reviewForms.filter((file) => file.form.rows.every((row) => this.invariants.find((invariant) => invariant.id === row.invariant)?.scope === scope));
    const revisionTags = new Set(this.origin.commits.filter((commit) => commit.revises?.scope === scope).map((commit) => commit.tag));
    return [...ofScope.filter((file) => !revisionTags.has(file.name)), ...ofScope.filter((file) => revisionTags.has(file.name))];
  }

  /** Every literal the walkthrough source must not contain: names, handles, scopes, features, SHAs and test IDs. */
  forbiddenLiterals(): string[] {
    return [
      ...this.people.flatMap((person) => [person.id, person.display_name, `${person.id}-gh`]),
      ...this.identities.map((identity) => identity.handle),
      ...this.scopes.map((scope) => scope.id),
      ...this.features.map((feature) => feature.id),
      ...this.invariants.map((invariant) => invariant.id),
      ...Object.values(this.pins.branches),
      ...Object.values(this.pins.tags),
      ...Object.values(this.pins.wave_fixes ?? {}),
      ...[...Object.keys(this.pins.fixes), ...Object.keys(this.pins.wave_fixes ?? {})].flatMap((nodeId) => [nodeId, nodeId.split("::").at(-1) as string]),
    ];
  }
}

/** The GitHub login the sign-in test double signs `person` in as. */
export const loginOf = (person: string): string => `${person}-gh`;
