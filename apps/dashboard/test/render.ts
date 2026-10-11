// Renders dashboard components in Node without a browser: `load` bundles a module that imports them
// from src/ and returns its exports, which call react-dom/server.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

const root = join(import.meta.dirname, "..");

/** Bundles `entry` for Node and returns its exports, so a page renders on the server without a browser. */
export async function load<T>(entry: string): Promise<T> {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const dir = await mkdtemp(join(tmpdir(), "penguin-render-"));
  try {
    const file = join(dir, "entry.cjs");
    await writeFile(file, bundle.outputFiles[0]!.text);
    return createRequire(import.meta.url)(file) as T;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
