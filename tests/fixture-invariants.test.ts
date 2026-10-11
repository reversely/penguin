// The three use-case fixtures declare invariants, contracts and recorded examples (#98). Each test
// builds a fixture and reads the penguin files at every branch and tag, as the review harness reads
// them from a base commit: `penguin/scopes.json` through the scope map's loader and
// `penguin/invariants.json` through `parseInvariantsFile`. Every examples file the invariants file
// names must exist at that commit, parse as an examples file and run one of its scope's contracts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseExampleFile } from "@penguin/protocol";
import { InvariantsFileError, parseInvariantsFile, parseScopeMap } from "@penguin/scope-map";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
const ROOT = mkdtempSync(join(tmpdir(), "penguin-fixture-invariants-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** The invariants each case's fixture must declare, as `scope: statement`, protected ones marked. */
const CASES: Record<string, string[]> = {
  "identity-unification": [
    "analytics: Patrons who log in on one library tablet stay separate people (protected)",
    "analytics: A published day's daily active users stay the same when later days' events arrive",
    "messaging: An unsubscribe on any linked identity holds after a later signup subscribes the address by default",
  ],
  "helpful-fix": [
    "analytics: Evening activity west of UTC stays on its local day",
    "messaging: A reminder fires at the contact's local hour",
  ],
  "dependency-bump": ["payments: A payment is charged at most once (protected)"],
};

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function build(name: string): string {
  const repo = join(ROOT, name);
  execFileSync(PYTHON, [join(REPO_ROOT, "examples", name, "build.py"), repo]);
  return repo;
}

function filesAt(repo: string, ref: string) {
  const scopes = parseScopeMap(JSON.parse(git(repo, "show", `${ref}:penguin/scopes.json`)));
  const raw = JSON.parse(git(repo, "show", `${ref}:penguin/invariants.json`)) as unknown;
  return { scopes, raw, invariants: parseInvariantsFile(raw, scopes) };
}

for (const [name, expected] of Object.entries(CASES)) {
  describe(`the ${name} fixture`, () => {
    const repo = build(name);
    const refs = git(repo, "for-each-ref", "--format=%(refname:short)").trim().split("\n");

    test("declares the case's invariants on main", () => {
      const { invariants } = filesAt(repo, "main");
      assert.deepEqual(
        invariants.invariants.map((entry) => `${entry.scopeId}: ${entry.statement}${entry.protected ? " (protected)" : ""}`),
        expected,
      );
    });

    test("every branch and tag loads, and each examples file runs a contract of its scope", () => {
      for (const ref of refs) {
        const { scopes, invariants } = filesAt(repo, ref);
        for (const source of invariants.examples) {
          const file = parseExampleFile(JSON.parse(git(repo, "show", `${ref}:${source.file}`)));
          assert.equal(scopes.contracts.get(file.contract), source.scopeId, `${ref}: ${source.file} runs ${file.contract}`);
          assert.ok(file.cases.length > 0, `${ref}: ${source.file} has cases`);
        }
      }
    });

    test("each running feature's fork declares the contracts of its area", () => {
      const features = JSON.parse(readFileSync(join(REPO_ROOT, "examples", name, "features.json"), "utf8")) as {
        features: { fork: string; area: { scopes: string[]; contracts: string[] } }[];
      };
      for (const feature of features.features) {
        const { scopes } = filesAt(repo, feature.fork);
        for (const contract of feature.area.contracts) {
          assert.ok(feature.area.scopes.includes(scopes.contracts.get(contract) ?? ""), `${feature.fork}: ${contract}`);
        }
      }
    });

    test("a malformed copy of its invariants file is refused with every problem", () => {
      const { scopes, raw } = filesAt(repo, "main");
      const file = structuredClone(raw) as { invariants: Record<string, unknown>[]; examples: Record<string, unknown>[]; run?: string };
      file.run = "rm -rf /";
      file.invariants.push({ ...file.invariants[0], statement: "repeats an id\nacross two lines" });
      file.examples.push({ scope: file.invariants[0]?.scope, file: "../outside.json", invariants: [] });
      assert.throws(
        () => parseInvariantsFile(file, scopes),
        (error: unknown) =>
          error instanceof InvariantsFileError &&
          JSON.stringify(error.issues.map((issue) => issue.field)) ===
            JSON.stringify(["run", `invariants[${file.invariants.length - 1}].id`, `invariants[${file.invariants.length - 1}].statement`, `examples[${file.examples.length - 1}].file`]),
      );
    });
  });
}
