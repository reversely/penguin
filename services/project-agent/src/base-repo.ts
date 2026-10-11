// Reads of the project base repo through the Artifacts binding name its branch, never "HEAD".
//
// The binding resolves a `readFile` or `log` ref that is a branch name, a tag or a commit ID. On real
// Artifacts, "HEAD" and "refs/heads/main" resolve to nothing (`readFile` gives null, `log` gives an
// empty list), while "main" resolves (#72, measured through local wrangler dev).

/**
 * The base repo's branch. Project setup creates the base repo with this default branch
 * (apps/worker/src/repos.ts, `setDefaultBranch`), and owner and Huddle forks copy only it.
 */
export const BASE_BRANCH = "main";

/** The binding method this module calls on the base repo. */
export interface BaseRepoFileReader {
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}

/** A file on the base repo's branch, or null when there is none. */
export async function readBaseFile(repo: BaseRepoFileReader, path: string): Promise<Uint8Array | null> {
  const blob = await repo.readFile({ ref: BASE_BRANCH, path });
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}
