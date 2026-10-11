// Test support shared by the push-ingest and rebuild tests: an in-memory node:sqlite database behind
// the index's SQL interface, and a real Git repo on disk read through the binding's methods.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { SqlDatabase } from "../src/issue-index.ts";
import type { IssuesRepoReader, RepoTreeEntry } from "../src/push-ingest.ts";
import { artifactsResolvesRef } from "./artifacts-refs.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function sqlite(): { db: DatabaseSync; sql: SqlDatabase } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as Record<string, string | number | null>[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sql };
}

/** A real Git repo on disk standing in for the issues repo, read through the binding's methods. */
export class GitRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "penguin-issues-"));

  constructor() {
    tempDirs.push(this.dir);
    this.git("init", "--quiet", "--initial-branch=main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", this.dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  /** Writes the files and commits them on the current branch; returns the commit SHA. */
  commit(files: Record<string, string | Uint8Array>, message = "ops"): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), content);
    }
    this.git("add", "--all");
    this.git("commit", "--quiet", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /**
   * Counts each method call, like the ProjectAgent's binding report. Refs resolve as on real
   * Artifacts (artifacts-refs.ts).
   */
  readonly calls: Record<string, number> = {};

  reader(): IssuesRepoReader {
    const count = (method: string): void => {
      this.calls[method] = (this.calls[method] ?? 0) + 1;
    };
    return {
      log: async ({ ref, limit, offset }) => {
        count("log");
        if (!artifactsResolvesRef(ref)) return [];
        let out: string;
        try {
          out = this.git("log", "--first-parent", "--format=%H %T", `--skip=${offset}`, `-n${limit}`, ref, "--");
        } catch {
          return [];
        }
        return out === ""
          ? []
          : out.split("\n").map((line) => {
              const [hash, treeHash] = line.split(" ") as [string, string];
              return { hash, treeHash };
            });
      },
      readTree: async (hash) => {
        count("readTree");
        const out = this.git("ls-tree", hash);
        return out === "" ? [] : out.split("\n").map(treeEntry);
      },
      readBlob: async (hash) => {
        count("readBlob");
        return new Blob([execFileSync("git", ["-C", this.dir, "cat-file", "blob", hash])]);
      },
    };
  }
}

function treeEntry(line: string): RepoTreeEntry {
  const [meta, name] = line.split("\t") as [string, string];
  const [mode, , hash] = meta.split(" ") as [string, string, string];
  const type = mode === "040000" ? "tree" : mode === "100755" ? "exec" : mode === "120000" ? "symlink" : "blob";
  return { name, hash, type };
}
