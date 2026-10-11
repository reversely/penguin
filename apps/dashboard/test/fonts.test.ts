import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const src = join(import.meta.dirname, "../src");
const css = await readFile(join(src, "app.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = ""]) => ({
  family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
  style: /font-style:\s*(\w+)/.exec(body)?.[1],
  weight: /font-weight:\s*([^;]+);/.exec(body)?.[1],
  display: /font-display:\s*(\w+)/.exec(body)?.[1],
  url: /url\("([^"]+)"\)/.exec(body)?.[1],
}));

test("the stylesheet loads Inter 400 and 500 and Piazzolla 400 roman and italic only", () => {
  assert.deepEqual(
    faces.map(({ family, style, weight }) => `${family} ${style} ${weight}`),
    ["Inter normal 400", "Inter normal 500", "Piazzolla normal 400", "Piazzolla italic 400"],
  );
  for (const face of faces) assert.equal(face.display, "swap", face.family);
  assert.match(css, /font-synthesis: none/);
});

test("each face is a self-hosted woff2 file with its family's OFL text beside it", async () => {
  const files = new Set(await readdir(join(src, "fonts")));
  for (const { family, url } of faces) {
    assert.match(url ?? "", /^\/fonts\/[a-z0-9-]+\.woff2$/, family);
    const name = (url ?? "").slice("/fonts/".length);
    assert.ok(files.has(name), name);
    const bytes = await readFile(join(src, "fonts", name));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", name);
    const licence = await readFile(join(src, "fonts", `${family?.toLowerCase()}-ofl.txt`), "utf8");
    assert.match(licence, new RegExp(`^Copyright \\d{4} The ${family} Project Authors`), family);
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});

test("each type stack falls back to system faces when a font file fails", () => {
  assert.match(css, /--font-sans: "Inter", system-ui, [^;]*sans-serif;/);
  assert.match(css, /--font-serif: "Piazzolla", [^;]*serif;/);
});
