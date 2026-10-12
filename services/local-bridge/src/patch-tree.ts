// A plan part's patch applied to a commit without a checkout: each file the patch writes is read at the
// commit, patched with `applyPatchFile` (the function Penguin checks the patch with) and written as a
// blob into a scratch index over the commit's tree. The fix write (fix-write.ts) commits the tree into
// the affected fork; a part trial (trial-tree.ts) tests it.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runGit } from "@penguin/git-analysis";
import { applyPatchFile, type PlanFileDiff } from "@penguin/protocol";

const REGULAR_MODES = new Set(["100644", "100755"]);

export type PatchedTree = { readonly ok: true; readonly tree: string } | { readonly ok: false; readonly message: string };

/** The tree of `parent` with `files` applied, written to the object store only. `scratch` is an empty folder. */
export async function patchedTree(repoPath: string, parent: string, files: readonly PlanFileDiff[], scratch: string): Promise<PatchedTree> {
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  await runGit(repoPath, ["read-tree", parent], { env });
  for (const [index, file] of files.entries()) {
    const entry = (await runGit(repoPath, ["ls-tree", "-z", "--end-of-options", parent, "--", file.path])).split("\0")[0] ?? "";
    const [meta = "", listed] = entry.split("\t");
    const [mode, , blob] = meta.split(" ");
    if (entry !== "" && (listed !== file.path || !REGULAR_MODES.has(mode ?? ""))) return { ok: false, message: `${file.path} is not a regular file at the parent` };
    const before = entry === "" ? null : await runGit(repoPath, ["cat-file", "blob", blob as string]);
    const applied = applyPatchFile(file, before);
    if (!applied.ok) return { ok: false, message: applied.message };
    if (applied.text === null) {
      await runGit(repoPath, ["update-index", "--force-remove", "--", file.path], { env });
      continue;
    }
    const content = join(scratch, `file-${index}`);
    await writeFile(content, applied.text, { mode: 0o600 });
    const written = (await runGit(repoPath, ["hash-object", "-w", "--", content])).trim();
    await runGit(repoPath, ["update-index", "--add", "--cacheinfo", `${entry === "" ? "100644" : mode},${written},${file.path}`], { env });
  }
  return { ok: true, tree: (await runGit(repoPath, ["write-tree"], { env })).trim() };
}
