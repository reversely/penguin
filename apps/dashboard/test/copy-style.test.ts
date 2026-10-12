// Every string the dashboard's source prints follows the house style (#127): no banned word or
// pattern from the house-style skill in a string literal, a template literal or JSX text under
// apps/dashboard/src. Comments are left out; they are not shown to anyone using the dashboard.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "../src");

/** The house style's banned words and patterns, each with the rule it breaks. */
const BANNED: readonly { readonly pattern: RegExp; readonly rule: string }[] = [
  { pattern: /\b(genuinely|honestly|quietly)\b/iu, rule: "no genuinely, honestly or quietly" },
  { pattern: /\b(deeply|profoundly|incredibly|remarkably|strangely|oddly|surprisingly)\b/iu, rule: "no abstract intensifier" },
  { pattern: /\b(leverage|unlock|optimi[sz]e|streamline|empower|transform|seamless(ly)?|at scale|drive impact)\b/iu, rule: "no corporate filler" },
  { pattern: /\b(stale|substrate|spine)\b/iu, rule: "name the condition or the referent" },
  { pattern: /\blands?\b/iu, rule: "state the event, not lands" },
  { pattern: /\b(the|that) thing\b/iu, rule: "no the thing" },
  { pattern: /\b(she|her|hers|he|him|his)\b/iu, rule: "no gendered pronoun" },
  { pattern: /[–—·]|--/u, rule: "no dash or interpunct as a separator" },
  { pattern: /, and\b/u, rule: "no comma before and" },
  { pattern: /\bright now\b/iu, rule: "no assistant voice" },
];

/** The source with its comments blanked, so only code and strings remain. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1");
}

/** String literals, template literal text and JSX text of one file. */
export function shownStrings(source: string, jsx: boolean): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gu)) found.push(match[1] ?? match[2] ?? match[3] ?? "");
  if (jsx) for (const match of code.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</gu)) found.push((match[1] ?? "").trim());
  return found.filter((text) => /[A-Za-z]/u.test(text));
}

test("no dashboard string carries a banned word or pattern from the house style", () => {
  const breaks: string[] = [];
  for (const name of readdirSync(SRC).filter((file) => /\.tsx?$/u.test(file))) {
    for (const text of shownStrings(readFileSync(join(SRC, name), "utf8"), name.endsWith(".tsx"))) {
      for (const { pattern, rule } of BANNED) if (pattern.test(text)) breaks.push(`${name}: "${text}": ${rule}`);
    }
  }
  assert.deepEqual(breaks, []);
});

test("the scan finds banned words in literals and JSX text and leaves comments alone", () => {
  const sample = [
    "// a comment that lands nowhere",
    "/* stale in a block comment */",
    'const a = "Nothing needs you right now";',
    "const b = `It lands once ${x} confirms`;",
    "const c = <p>A seamless view</p>;",
  ].join("\n");
  const shown = shownStrings(sample, true);
  assert.ok(shown.includes("Nothing needs you right now"));
  assert.ok(shown.some((text) => text.startsWith("It lands once")));
  assert.ok(shown.includes("A seamless view"));
  assert.ok(!shown.some((text) => /stale|nowhere/u.test(text)));
});
