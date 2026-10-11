import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { characterFor, fnv1a, HUES, PERSON_HUES, POSES, SHAPES } from "../src/character.ts";

const css = (await readFile(join(import.meta.dirname, "../src/app.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
const lightBlock = /^:root \{([\s\S]*?)^\}/m.exec(css)?.[1] ?? "";
const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)^ {2}\}/m.exec(css)?.[1] ?? "";

function token(block: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light! + 0.05) / (dark! + 0.05);
}

const handles = Array.from({ length: 2000 }, (_, i) => `@owner${i % 7}/agent-${i}`);

test("FNV-1a matches the published 32-bit test vectors", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
});

test("the same handle always gives the same character, taken from the hash's bit fields", () => {
  for (const handle of ["@jun/reports", "@mia/<b>ops</b>", "@ana/café"]) {
    assert.deepEqual(characterFor(handle), characterFor(handle));
    const hash = fnv1a(handle);
    assert.deepEqual(characterFor(handle), {
      hue: HUES[hash % 8],
      shape: SHAPES[(hash >>> 8) % 8],
      pose: POSES[(hash >>> 16) % 3],
    });
  }
});

test("every shape, hue and pose is reachable from some handle", () => {
  const seen = { shape: new Set<string>(), hue: new Set<string>(), pose: new Set<string>() };
  for (const handle of handles) {
    const character = characterFor(handle);
    seen.shape.add(character.shape);
    seen.hue.add(character.hue);
    seen.pose.add(character.pose);
  }
  assert.deepEqual([...seen.shape].sort(), [...SHAPES].sort());
  assert.deepEqual([...seen.hue].sort(), [...HUES].sort());
  assert.deepEqual([...seen.pose].sort(), [...POSES].sort());
});

test("a duplicated identity's new handle derives its own character from that handle alone", () => {
  // Nothing is stored per identity: the source name and the copy are each read from their own handle.
  const source = characterFor("@jun/reports");
  const copy = characterFor("@jun/reports-copy");
  assert.deepEqual(copy, characterFor("@jun/reports-copy"));
  assert.notDeepEqual(copy, source);
});

test("every character hue has a token and a class, and reaches 3:1 on every field in both themes", () => {
  for (const hue of HUES) {
    const value = token(lightBlock, `--char-${hue}`);
    assert.match(value ?? "", /^#[0-9a-f]{6}$/, hue);
    assert.match(css, new RegExp(`\\.char-${hue} \\{\\s*fill: var\\(--char-${hue}\\);`), hue);
    for (const [theme, block] of [
      ["light", lightBlock],
      ["dark", darkBlock],
    ] as const) {
      for (const field of ["--field", "--surface"]) {
        const ratio = contrast(value!, token(block, field)!);
        assert.ok(ratio >= 3, `${hue} on ${theme} ${field}: ${ratio.toFixed(2)}`);
      }
    }
    const eye = token(lightBlock, "--char-eye")!;
    assert.ok(contrast(eye, value!) >= 4.5, `eye on ${hue}`);
  }
});

/** A #rrggbb colour in OKLab (Björn Ottosson's matrices), where distance tracks how different two colours look. */
function oklab(hex: string): readonly number[] {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(...x.map((value, at) => value - y[at]!));
}

test("every person hue has a token and a class, keeps 3:1 on every field and 4.5:1 under the initial", () => {
  for (const hue of PERSON_HUES) {
    const value = token(lightBlock, `--person-${hue}`);
    assert.match(value ?? "", /^#[0-9a-f]{6}$/, hue);
    assert.match(css, new RegExp(`\\.person-${hue} \\{\\s*--person: var\\(--person-${hue}\\);`), hue);
    for (const [theme, block] of [
      ["light", lightBlock],
      ["dark", darkBlock],
    ] as const) {
      for (const field of ["--field", "--surface"]) {
        const ratio = contrast(value!, token(block, field)!);
        assert.ok(ratio >= 3, `${hue} on ${theme} ${field}: ${ratio.toFixed(2)}`);
      }
    }
    assert.ok(contrast(token(lightBlock, "--char-eye")!, value!) >= 4.5, `initial on ${hue}`);
  }
});

test("person hues stay apart from each other and from the failure, warning and attention colours", () => {
  // #71's green and teal, which two squares side by side could not tell apart, were 0.061 apart.
  const values = PERSON_HUES.map((hue) => token(lightBlock, `--person-${hue}`)!);
  for (const [at, a] of values.entries()) {
    for (const b of values.slice(at + 1)) assert.ok(distance(a, b) >= 0.095, `${a} and ${b}: ${distance(a, b).toFixed(3)}`);
  }
  for (const block of [lightBlock, darkBlock]) {
    for (const status of ["--failure", "--warning", "--attention", "--attention-dot"]) {
      const value = token(block, status)!;
      for (const hue of values) assert.ok(distance(hue, value) >= 0.13, `${hue} and ${status} ${value}: ${distance(hue, value).toFixed(3)}`);
    }
  }
});
