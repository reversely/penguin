export const packageName: string = "@penguin/git-analysis";

export { changedPaths, changedPathsBetween } from "./changed-paths.ts";
export { isObjectId, runGit, runGitWithStatus, splitNul } from "./git.ts";
export type { GitOutcome, RunGitOptions } from "./git.ts";
export { commitMergedTree, simulateMerge } from "./merge-tree.ts";
export type { CleanMerge, ConflictedMerge, MergeSimulation } from "./merge-tree.ts";
