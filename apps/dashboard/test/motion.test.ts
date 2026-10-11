// Checks app.css as written against the motion rules of identity plan section 2.7. Also checks the
// rule that decides which rows arrive with motion (src/arrivals.ts).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { arrivalsAfter, LAST_STAGGER } from "../src/arrivals.ts";
import { load } from "./render.ts";

const css = (await readFile(join(import.meta.dirname, "../src/app.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
  /** The at-rules the rule sits in, outermost first. */
  readonly within: readonly string[];
}

/** Splits at top-level commas, so `:not(a, b)` stays whole. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(part.trim());
      part = "";
    } else part += character;
  }
  if (part.trim() !== "") parts.push(part.trim());
  return parts;
}

/** The style rules of a stylesheet without nesting, with the at-rules around each. */
function styleRules(text: string): { rules: Rule[]; keyframes: Map<string, string> } {
  const rules: Rule[] = [];
  const keyframes = new Map<string, string>();
  const open: string[] = [];
  let buffer = "";
  for (const character of text) {
    if (character === "{") {
      open.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (character === "}") {
      const prelude = open.pop() ?? "";
      const frames = open.find((at) => at.startsWith("@keyframes"));
      if (frames !== undefined) keyframes.set(frames, `${keyframes.get(frames) ?? ""}${buffer}`);
      else if (!prelude.startsWith("@") && buffer.trim() !== "") {
        const declarations = new Map(
          buffer
            .split(";")
            .map((line) => line.trim())
            .filter((line) => line.includes(":"))
            .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim().replace(/\s+/g, " ")] as const),
        );
        rules.push({ selectors: splitTop(prelude), declarations, within: [...open] });
      }
      buffer = "";
    } else buffer += character;
  }
  return { rules, keyframes };
}

const { rules, keyframes } = styleRules(css);
const REDUCED = "@media (prefers-reduced-motion: reduce)";
const HOVER = "(hover: hover) and (pointer: fine)";
const outsideTokens = rules.filter((rule) => !rule.selectors.includes(":root"));
const reduced = rules.filter((rule) => rule.within.includes(REDUCED));
// A rule under (prefers-reduced-motion: no-preference) never applies with reduced motion.
const moving = outsideTokens.filter(
  (rule) => !rule.within.includes(REDUCED) && !rule.within.some((at) => at.includes("(prefers-reduced-motion: no-preference)")),
);

test("the stylesheet parses into rules", () => {
  assert.ok(rules.length > 300);
  assert.ok(keyframes.size > 0);
});

test("no transition names all its properties", () => {
  assert.doesNotMatch(css, /transition(-property)?\s*:[^;]*\ball\b/);
});

test("every hover rule sits behind the hover and fine-pointer query", () => {
  for (const rule of rules) {
    if (rule.selectors.some((selector) => selector.includes(":hover"))) {
      assert.ok(
        rule.within.some((at) => at.startsWith(`@media ${HOVER}`)),
        rule.selectors.join(", "),
      );
    }
  }
});

test("a base rule transitions no colour or shadow, so selection, keys and theme switches repaint at once", () => {
  const PAINT = /\b(background-color|color|box-shadow|border-color)\b/;
  for (const rule of outsideTokens) {
    const value = rule.declarations.get("transition");
    if (value === undefined || rule.selectors.every((selector) => selector.includes(":hover"))) continue;
    // The drawer's scrim shades in with the drawer it belongs to.
    if (rule.selectors.every((selector) => selector.startsWith(".details-scrim"))) continue;
    assert.doesNotMatch(value, PAINT, `${rule.selectors.join(", ")} { transition: ${value} }`);
  }
});

test("every transition, animation and press scale has a reduced-motion path with none", () => {
  const stilled = (property: string, selector: string) =>
    reduced.some((rule) => rule.selectors.includes(selector) && rule.declarations.get(property) === "none");
  for (const rule of moving) {
    for (const property of ["transition", "animation"]) {
      const value = rule.declarations.get(property);
      if (value === undefined || value.startsWith("none")) continue;
      for (const selector of rule.selectors) assert.ok(stilled(property, selector), `${selector} { ${property} } has no reduced-motion path`);
    }
    if (rule.declarations.has("scale") && rule.selectors.some((selector) => selector.includes(":active"))) {
      for (const selector of rule.selectors) assert.ok(stilled("scale", selector), `${selector} { scale } has no reduced-motion path`);
    }
  }
});

test("durations, delays and easings come from the motion tokens", () => {
  const timed = /^(transition|animation)(-duration|-delay|-timing-function)?$/;
  for (const rule of outsideTokens) {
    for (const [property, value] of rule.declarations) {
      if (!timed.test(property)) continue;
      const literal = value.replace(/var\(--[\w-]+\)/g, "");
      assert.doesNotMatch(literal, /(^|[\s(*])(?!0s\b)\d*\.?\d+m?s\b/, `${rule.selectors.join(", ")} { ${property}: ${value} }`);
      assert.doesNotMatch(literal, /\bease(-in|-out|-in-out)?\b|cubic-bezier|steps\(/, `${rule.selectors.join(", ")} { ${property}: ${value} }`);
    }
  }
});

test("motion moves transform and opacity alone; colour and shadow change only on hover", () => {
  const MOTION = new Set(["translate", "scale", "rotate", "transform", "opacity"]);
  const PAINT = new Set(["background-color", "color", "box-shadow", "border-color", "visibility"]);
  for (const rule of outsideTokens) {
    const value = rule.declarations.get("transition");
    if (value === undefined || value.startsWith("none")) continue;
    for (const part of splitTop(value)) {
      const property = part.split(" ")[0]!;
      assert.ok(MOTION.has(property) || PAINT.has(property), `${rule.selectors.join(", ")} transitions ${property}`);
    }
  }
  for (const [name, frames] of keyframes) {
    for (const line of frames.split(";").filter((text) => text.includes(":"))) {
      const property = line.slice(0, line.indexOf(":")).replace(/^[\s\S]*\{/, "").trim();
      assert.ok(MOTION.has(property), `${name} animates ${property}`);
    }
  }
});

test("arrivals stagger by --stagger up to the last index app.css defines", () => {
  for (let index = 1; index <= LAST_STAGGER; index += 1) {
    const rule = rules.find((candidate) => candidate.selectors.includes(`[data-arrival="${index}"]`));
    assert.equal(rule?.declarations.get("animation-delay"), index === 1 ? "var(--stagger)" : `calc(${index} * var(--stagger))`);
  }
});

test("a list's first keys arrive with no motion; keys a later change adds arrive in list order", () => {
  const first = arrivalsAfter(undefined, ["a", "b"], "");
  assert.equal(first.arrived.size, 0);
  assert.equal(arrivalsAfter(first, ["a", "b"], ""), first, "unchanged keys keep the arrivals");
  const next = arrivalsAfter(first, ["c", "a", "d", "b"], "");
  assert.deepEqual([...next.arrived], [
    ["c", 0],
    ["d", 1],
  ]);
  const settled = { ...next, arrived: new Map() };
  const moved = arrivalsAfter(settled, ["b", "a", "c", "d"], "");
  assert.equal(moved.arrived.size, 0, "a reorder adds nothing");
});

test("rows still rising when the next change comes keep their index", () => {
  const first = arrivalsAfter(undefined, ["a"], "");
  const one = arrivalsAfter(first, ["a", "b", "c"], "");
  const two = arrivalsAfter(one, ["a", "c", "d"], "");
  assert.deepEqual([...two.arrived], [
    ["c", 1],
    ["d", 0],
  ]);
});

test("a scope change is a new baseline; a large arrival holds the last stagger index", () => {
  const first = arrivalsAfter(undefined, ["a"], "newest");
  assert.equal(arrivalsAfter(first, ["a", "b", "c"], "all").arrived.size, 0);
  const many = arrivalsAfter(first, ["a", ...Array.from({ length: 9 }, (_, index) => `n${index}`)], "newest");
  assert.deepEqual([...many.arrived.values()], [0, 1, 2, 3, 4, 5, 5, 5, 5]);
});

test("the first paint of a list carries no arrival", async () => {
  const { render } = await load<{ render: () => string }>(`
    import { renderToStaticMarkup } from "react-dom/server";
    import { createElement } from "react";
    import { InboxList } from "./src/inbox-page.tsx";
    export function render() {
      const items = [{ issueId: "40", reason: "assigned", read: false, raisedAt: "2026-10-11T09:00:00.000Z", title: "Cohorts", state: "open", assigneeHandles: [] }];
      const inbox = { load: { kind: "ready", items }, marking: new Set(), markFailed: false, markRead() {} };
      return renderToStaticMarkup(createElement(InboxList, { inbox, facts: undefined, viewer: "jun", now: new Date(), showAll: false, openIssue: undefined, navigate() {} }));
    }`);
  const html = render();
  assert.match(html, /inbox-row/);
  assert.doesNotMatch(html, /data-arrival/);
});
