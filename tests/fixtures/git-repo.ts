import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";

// Pin identity and switch off signing and hooks, so the owner's global Git config cannot
// change what the fixture commits.
const ISOLATED = [
  "-c",
  "user.name=Penguin Fixture",
  "-c",
  "user.email=fixture@penguin.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

export interface FixtureRepo {
  /** Temporary directory holding the main checkout and the two added worktrees. */
  root: string;
  main: string;
  worktreeA: string;
  worktreeB: string;
  git(cwd: string, ...args: string[]): Promise<string>;
  commitAll(cwd: string, message: string): Promise<string>;
  write(cwd: string, file: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Builds a throwaway repository with three tracked files on `main` and two added worktrees,
 * `feature-a` and `feature-b`, both branched from the first commit.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  // realpath: on macOS the temp dir is a symlink, and Git reports resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "penguin-git-fixture-")));
  const main = join(root, "main");
  const worktreeA = join(root, "wt-a");
  const worktreeB = join(root, "wt-b");
  const git = (cwd: string, ...args: string[]) => runGit(cwd, [...ISOLATED, ...args]);
  const write = (cwd: string, file: string, content: string) => writeFile(join(cwd, file), content);
  const commitAll = async (cwd: string, message: string) => {
    await git(cwd, "add", "--all");
    await git(cwd, "commit", "--quiet", "-m", message);
    return (await git(cwd, "rev-parse", "HEAD")).trim();
  };

  await runGit(root, ["init", "--quiet", "-b", "main", main]);
  for (const file of ["a.txt", "b.txt", "c.txt"]) await write(main, file, `${file}\n`);
  await commitAll(main, "initial");
  await git(main, "worktree", "add", "--quiet", "-b", "feature-a", worktreeA);
  await git(main, "worktree", "add", "--quiet", "-b", "feature-b", worktreeB);

  return {
    root,
    main,
    worktreeA,
    worktreeB,
    git,
    commitAll,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
