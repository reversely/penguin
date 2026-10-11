// Bundles the dashboard into dist/ for the Worker to serve as static assets: index.html, app.js and
// app.css. The page loads the script and the stylesheet by URL and has no inline script or style,
// so the Worker's Content Security Policy can allow scripts from its own origin only.

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { build } from "esbuild";

const root = import.meta.dirname;
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: { app: join(root, "src/main.tsx") },
  outdir: dist,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  minify: true,
  target: "es2022",
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
await copyFile(join(root, "src/index.html"), join(dist, "index.html"));
await copyFile(join(root, "src/app.css"), join(dist, "app.css"));

for (const file of ["app.js", "app.css", "index.html"]) {
  console.log(`${file}\t${(await stat(join(dist, file))).size} bytes`);
}
