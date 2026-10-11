/** A repository path that cannot be looked up: absolute, empty, or escaping the root. */
export class InvalidPathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`invalid repository path ${JSON.stringify(path)}: ${reason}`);
    this.name = "InvalidPathError";
    this.path = path;
  }
}

/**
 * Normalize a path relative to the repository root to slash-separated segments.
 *
 * Backslashes become slashes; empty segments, `.` segments and a trailing slash are dropped,
 * so `./ingestion//ids.py` and `ingestion/ids.py` normalize alike.
 *
 * Raises:
 *   InvalidPathError: when the path is empty, absolute, contains a NUL byte, has a `..`
 *   segment, or names the repository root.
 */
export function normalizeRepoPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidPathError(String(path), "the path is empty");
  }
  if (path.includes("\0")) {
    throw new InvalidPathError(path, "the path contains a NUL byte");
  }
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new InvalidPathError(path, "absolute paths are not allowed");
  }
  const segments = slashed.split("/");
  if (segments.includes("..")) {
    throw new InvalidPathError(path, "paths containing '..' are not allowed");
  }
  const kept = segments.filter((segment) => segment !== "" && segment !== ".");
  if (kept.length === 0) {
    throw new InvalidPathError(path, "the path names the repository root");
  }
  return kept.join("/");
}

/**
 * List a normalized path and each directory enclosing it, from the root down:
 * `a/b/c.py` gives `a`, `a/b`, `a/b/c.py`.
 */
export function enclosingPaths(normalizedPath: string): string[] {
  const segments = normalizedPath.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
