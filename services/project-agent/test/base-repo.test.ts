import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

import { BASE_BRANCH, readBaseFile, type BaseRepoFileReader } from "../src/base-repo.ts";
import { artifactsResolvesRef } from "./artifacts-refs.ts";
import { GitRepo } from "./issues-repo.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");

/** A Git repo on disk read through the binding's `readFile`, resolving refs as real Artifacts does. */
function fileReader(repo: GitRepo): BaseRepoFileReader & { readonly refs: string[] } {
  const refs: string[] = [];
  return {
    refs,
    readFile: async ({ ref, path }) => {
      refs.push(ref);
      if (!artifactsResolvesRef(ref)) return null;
      try {
        return new Blob([execFileSync("git", ["-C", repo.dir, "show", `${ref}:${path}`])]);
      } catch {
        return null;
      }
    },
  };
}

function baseRepo(): GitRepo {
  const repo = new GitRepo();
  repo.commit({ "penguin/scopes.json": '{"scopes":[]}\n' });
  return repo;
}

describe("the base repo through the Artifacts binding", () => {
  test("a file is read from the base branch by name", async () => {
    const reader = fileReader(baseRepo());
    const bytes = await readBaseFile(reader, "penguin/scopes.json");
    assert.equal(new TextDecoder().decode(bytes ?? new Uint8Array()), '{"scopes":[]}\n');
    assert.deepEqual(reader.refs, [BASE_BRANCH]);
  });

  test("a missing file reads as null", async () => {
    assert.equal(await readBaseFile(fileReader(baseRepo()), "penguin/owners.json"), null);
  });

  test("the fakes resolve refs as real Artifacts does: HEAD and refs/heads/<x> resolve to nothing", async () => {
    const repo = baseRepo();
    const reader = fileReader(repo);
    const log = repo.reader().log;
    for (const ref of ["HEAD", `refs/heads/${BASE_BRANCH}`]) {
      assert.equal(await reader.readFile({ ref, path: "penguin/scopes.json" }), null, ref);
      assert.deepEqual(await log({ ref, limit: 1, offset: 0 }), [], ref);
    }
    assert.notEqual(await reader.readFile({ ref: BASE_BRANCH, path: "penguin/scopes.json" }), null);
    assert.equal((await log({ ref: BASE_BRANCH, limit: 1, offset: 0 })).length, 1);
  });

  test("no Worker or agent source passes HEAD or a refs/heads/ ref to an Artifacts read", () => {
    const sources = ["apps/worker/src", ...["feature-agent", "issues", "mcp", "project-agent"].map((s) => `services/${s}/src`)];
    const literal = /\bref:\s*["'`](HEAD\b|refs\/heads\/)/;
    const hits = sources
      .flatMap((dir) => tsFiles(join(REPO_ROOT, dir)))
      .filter((file) => literal.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file));
    assert.deepEqual(hits, []);
  });
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}
