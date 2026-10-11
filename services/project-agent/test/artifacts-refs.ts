// How the Artifacts binding resolves the `ref` of `readFile` and `log`, for the test fakes that
// stand in for it. On real Artifacts (#72, measured through local wrangler dev), "HEAD" and
// "refs/heads/main" resolve to nothing: `readFile` gives null and `log` an empty list. Only the
// branch name, a tag or a commit ID resolves. A fake that resolved "HEAD" hid that bug.

/** Whether the binding resolves `ref` to a commit; when false, `readFile` is null and `log` empty. */
export function artifactsResolvesRef(ref: string): boolean {
  return ref !== "HEAD" && !ref.startsWith("refs/heads/");
}
