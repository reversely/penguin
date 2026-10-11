import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const css = await readFile(join(import.meta.dirname, "../src/app.css"), "utf8");
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const lightBlock = /^:root \{([\s\S]*?)^\}/m.exec(withoutComments)?.[1] ?? "";
const darkMedia = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)^ {2}\}\s*^\}/m.exec(withoutComments);
const darkBlock = darkMedia?.[1] ?? "";

function tokens(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name = "", value = ""]) => [name, value.trim()]));
}

const LIGHT = {
  "--field": "#fbfcfc",
  "--surface": "#f2f3f3",
  "--surface-raised": "#ffffff",
  "--selected": "#e6e8e8",
  "--line": "#d6d8d8",
  "--ink": "#151515",
  "--ink-name": "#444444",
  "--ink-muted": "#666666",
  "--link": "#1567c4",
  "--unread": "#1084fe",
  "--attention": "#975a0f",
  "--attention-dot": "#c97a1a",
  "--online": "#159f5b",
  "--focus": "#151515",
};
const DARK = {
  "--field": "#0d1626",
  "--surface": "#162034",
  "--surface-raised": "#1e283f",
  "--selected": "#27314a",
  "--line": "#323c56",
  "--ink": "#e9edf3",
  "--ink-name": "#c9cdd4",
  "--ink-muted": "#a4adbb",
  "--link": "#559af4",
  "--unread": "#1084fe",
  "--attention": "#ffb138",
  "--attention-dot": "#ff9800",
  "--online": "#03c972",
  "--focus": "#e9edf3",
};
const SIGNALS = ["--verified", "--failure", "--failure-ink", "--warning", "--alert", "--review"];

test("the light and dark blocks define every colour token with the identity plan's values", () => {
  const light = tokens(lightBlock);
  const dark = tokens(darkBlock);
  assert.ok(dark.size > 0, "the dark block parses");
  for (const [name, value] of Object.entries(LIGHT)) assert.equal(light.get(name), value, name);
  for (const [name, value] of Object.entries(DARK)) assert.equal(dark.get(name), value, `dark ${name}`);
  for (const name of SIGNALS) {
    assert.match(light.get(name) ?? "", /^#[0-9a-f]{6}$/, name);
    assert.match(dark.get(name) ?? "", /^#[0-9a-f]{6}$/, `dark ${name}`);
  }
  for (const signal of ["verified", "failure", "warning", "alert", "review"]) {
    assert.equal(light.get(`--${signal}-tint`), `color-mix(in oklab, var(--${signal}) 14%, var(--surface))`);
  }
  for (const name of ["--elevation-raised", "--elevation-raised-hover", "--elevation-float"]) {
    assert.ok(light.has(name), name);
    assert.ok(dark.has(name), `dark ${name}`);
  }
});

test("radius, spacing, motion and type tokens are defined", () => {
  const light = tokens(lightBlock);
  assert.equal(light.get("--radius-card"), "20px");
  assert.equal(light.get("--radius-full"), "999px");
  assert.deepEqual(
    [...light].filter(([name]) => name.startsWith("--space-")).map(([, value]) => value),
    ["4px", "8px", "12px", "16px", "20px", "24px", "32px", "48px", "72px"],
  );
  assert.equal(light.get("--ease-out"), "cubic-bezier(0.32, 0.72, 0, 1)");
  assert.equal(light.get("--dur-exit"), "180ms");
  assert.equal(light.get("--text-display"), "400 clamp(24px, 1.2vw + 12px, 30px) / 1.15 var(--font-serif)");
  assert.equal(light.get("--text-quote"), "italic 400 16px / 1.55 var(--font-serif)");
});

test("no rule outside the token blocks writes a colour literal or fades a disabled button", () => {
  const rules = withoutComments.replace(/^:root \{[\s\S]*?^\}/m, "").replace(darkMedia?.[0] ?? "", "");
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/);
  assert.doesNotMatch(rules, /opacity/);
});
