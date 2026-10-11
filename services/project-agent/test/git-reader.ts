// The Artifacts binding's object reads (readCommit, readTree, readBlob), answered from a local Git
// repository, so the Worker's tree diff can be checked against Git on real commits.

import { execFileSync } from "node:child_process";

import type { GitObjectReader } from "../src/repo-diff.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A reader over `cwd`'s objects; `calls` records each method called, in order. */
export function gitReader(cwd: string): GitObjectReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readCommit(hash) {
      calls.push("readCommit");
      let shown: string;
      try {
        shown = git(cwd, "show", "-s", "--format=%T%n%P%n%B", hash);
      } catch {
        return null;
      }
      const [tree, parents, ...message] = shown.split("\n");
      return { hash, treeHash: tree as string, parents: (parents as string).split(" ").filter(Boolean), message: message.join("\n") };
    },
    async readTree(hash) {
      calls.push("readTree");
      return git(cwd, "ls-tree", hash)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t") as [string, string];
          const [, type, object] = meta.split(" ") as [string, string, string];
          return { name, hash: object, type };
        });
    },
    async readBlob(hash) {
      calls.push("readBlob");
      return new Blob([execFileSync("git", ["cat-file", "blob", hash], { cwd })]);
    },
  };
}
