import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { build } from "esbuild";

import { ICON_GRID, ICON_STROKE, ICONS } from "../src/icons.ts";

const root = join(import.meta.dirname, "..");

/** Each point a path moves or draws to, in absolute grid units, for the commands the set uses. */
function points(d: string): [number, number][] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? [];
  const found: [number, number][] = [];
  let x = 0;
  let y = 0;
  let start: [number, number] = [0, 0];
  let command = "";
  for (let i = 0; i < tokens.length; ) {
    if (/[a-zA-Z]/.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase();
    const next = () => Number(tokens[i++]);
    switch (command.toUpperCase()) {
      case "M":
      case "L": {
        const [nx, ny] = [next(), next()];
        [x, y] = relative ? [x + nx, y + ny] : [nx, ny];
        if (command.toUpperCase() === "M") start = [x, y];
        break;
      }
      case "H":
        x = relative ? x + next() : next();
        break;
      case "V":
        y = relative ? y + next() : next();
        break;
      case "A": {
        const radii = [next(), next()];
        assert.ok(radii.every(Number.isInteger), `arc radii ${radii} in ${d}`);
        i += 3;
        const [nx, ny] = [next(), next()];
        [x, y] = relative ? [x + nx, y + ny] : [nx, ny];
        break;
      }
      case "Z":
        [x, y] = start;
        continue;
      default:
        assert.fail(`unexpected command ${command} in ${d}`);
    }
    found.push([x, y]);
  }
  return found;
}

test("the set holds the ten icons the identity plan names", () => {
  assert.deepEqual(Object.keys(ICONS).sort(), [
    "back",
    "check",
    "chevron",
    "clock",
    "close",
    "collapse-panel",
    "copy",
    "external",
    "more",
    "send",
  ]);
});

test("every icon's points sit on whole grid units inside the 2 to 14 live area", () => {
  assert.equal(ICON_GRID, 16);
  for (const [name, { d }] of Object.entries(ICONS)) {
    const all = points(d);
    assert.ok(all.length > 1, name);
    for (const [x, y] of all) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `${name} point ${x},${y} is off the grid`);
      assert.ok(x >= 2 && x <= 14 && y >= 2 && y <= 14, `${name} point ${x},${y} leaves the live area`);
    }
  }
});

test("each icon renders as one path at the set's one stroke weight, hidden beside a label or named alone", async () => {
  const entry = `
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { Icon } from "./src/icon.tsx";
    export function render(name, label) {
      return renderToStaticMarkup(createElement(Icon, label === undefined ? { name } : { name, label }));
    }`;
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
  const dir = await mkdtemp(join(tmpdir(), "penguin-icons-"));
  try {
    const file = join(dir, "icon.cjs");
    await writeFile(file, bundle.outputFiles[0]!.text);
    const { render } = createRequire(import.meta.url)(file) as { render: (name: string, label?: string) => string };
    for (const name of Object.keys(ICONS)) {
      const html = render(name);
      assert.equal(html.match(/<path /g)?.length, 1, name);
      assert.equal(html.match(/stroke-width="([^"]+)"/g)?.join(), `stroke-width="${ICON_STROKE}"`, name);
      assert.match(html, /viewBox="0 0 16 16"/, name);
      assert.match(html, /stroke="currentColor"/, name);
      assert.match(html, /aria-hidden="true"/, name);
      assert.doesNotMatch(html, /role=|aria-label/, name);
    }
    const alone = render("close", '<img src=x onerror="globalThis.pwned = 1">');
    assert.match(alone, /role="img"/);
    assert.match(alone, /aria-label="&lt;img src=x onerror=&quot;globalThis\.pwned = 1&quot;&gt;"/);
    assert.doesNotMatch(alone, /aria-hidden|<img/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no dashboard source draws an icon with a Unicode arrow, cross, check or shape glyph", async () => {
  // Arrows, maths operators, technical and geometric shapes, symbols, dingbats and the multiply sign.
  const GLYPHS = /[×←-⇿−-⋿⌀-⏿■-➿⬀-⯿]/u;
  for (const file of (await readdir(join(root, "src"))).filter((name) => /\.(tsx?|css)$/.test(name))) {
    const source = (await readFile(join(root, "src", file), "utf8")).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(source, GLYPHS, file);
  }
});
